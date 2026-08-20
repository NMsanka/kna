import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withOrgContext, type DbHandle } from '@kna/db';
import type { AccessContext } from '@kna/retrieval';
import type { Sensitivity } from '@kna/ir';

/**
 * Identity, permissions and revocation.
 *
 * §15.4 BLOCKER — "ACL revocation lag is unbounded and there is no deny path. 'Synced
 * periodically and cached' means offboarding or a permission removal stays effective for the
 * full sync interval, and a long-lived MCP session may never re-evaluate."
 *
 * The design that follows from that finding:
 *  - Positive permissions are cached, because they are read on every query.
 *  - Revocations are a *separate* short-TTL deny list that takes precedence over the cache and
 *    is consulted on every resolution. A permission webhook writes here immediately.
 *  - `confidential` and above re-evaluate against the database every time, bypassing the cache.
 *  - When the Git provider is unreachable, resolution falls back to last-known-good with a hard
 *    expiry, then fails closed.
 */

export interface Principal {
  id: string;
  orgId: string;
  subject: string;
  email: string | null;
  clearance: Sensitivity;
  isServiceAccount: boolean;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

interface CachedPermissions {
  repoIds: string[];
  clearance: Sensitivity;
  cachedAt: number;
  /** Hard expiry. Beyond this, resolution fails closed rather than serving stale grants. */
  hardExpiryAt: number;
}

export interface PermissionResolverOptions {
  db: DbHandle;
  /** §15.6 — "set an explicit revocation SLO (<=5 minutes)". The cache TTL must be under it. */
  cacheTtlMs: number;
  /** How long last-known-good may be served when the provider is unreachable. */
  hardExpiryMs: number;
}

export class PermissionResolver {
  private readonly cache = new Map<string, CachedPermissions>();

  constructor(private readonly options: PermissionResolverOptions) {}

  /**
   * Resolve the caller's access context.
   *
   * `requiredTier` bypasses the cache for anything at `confidential` or above — §15.4:
   * "re-evaluate on every token refresh and on every `confidential`/`restricted` access."
   */
  async resolve(
    principal: Principal,
    options: { corpus: 'internal' | 'external'; requiredTier?: Sensitivity } = {
      corpus: 'internal',
    },
  ): Promise<AccessContext> {
    if (options.corpus === 'external') {
      // The external corpus needs no repo grants at all: it contains published documentation
      // and public modules, and zero code chunks (§10 Layer 4).
      return {
        orgId: principal.orgId,
        principalId: principal.id,
        permittedRepoIds: [],
        clearance: 'public',
        corpus: 'external',
      };
    }

    const bypassCache =
      options.requiredTier === 'confidential' || options.requiredTier === 'restricted';

    const cacheKey = `${principal.orgId}:${principal.id}`;
    const cached = this.cache.get(cacheKey);
    const now = Date.now();

    let permissions: CachedPermissions;
    if (!bypassCache && cached && now - cached.cachedAt < this.options.cacheTtlMs) {
      permissions = cached;
    } else {
      try {
        permissions = await this.load(principal);
        this.cache.set(cacheKey, permissions);
      } catch (error) {
        // Provider unreachable. Serve last-known-good inside the hard expiry, then fail closed.
        if (cached && now < cached.hardExpiryAt) {
          permissions = cached;
        } else {
          throw new AuthError(
            'Permissions could not be resolved and no recent cached grant is available. Access is denied rather than assumed.',
            503,
            'permissions_unavailable',
          );
        }
        void error;
      }
    }

    // Revocations are consulted every time, cache or no cache. This is the deny path.
    const denied = await this.deniedRepoIds(principal);

    return {
      orgId: principal.orgId,
      principalId: principal.id,
      permittedRepoIds: permissions.repoIds.filter((id) => !denied.includes(id)),
      clearance: permissions.clearance,
      corpus: 'internal',
      deniedRepoIds: denied,
    };
  }

  private async load(principal: Principal): Promise<CachedPermissions> {
    const rows = await withOrgContext(this.options.db, principal.orgId, async (tx) =>
      tx.execute<{ repo_id: string }>(sql`
        SELECT repo_id FROM repo_permissions
        WHERE org_id = ${principal.orgId} AND principal_id = ${principal.id}
      `),
    );

    const now = Date.now();
    return {
      repoIds: rows.map((r) => r.repo_id),
      clearance: principal.clearance,
      cachedAt: now,
      hardExpiryAt: now + this.options.hardExpiryMs,
    };
  }

  /**
   * Active revocations. A wildcard row (`repo_id IS NULL`) denies everything, which is what an
   * offboarding writes — it must not depend on enumerating the repos the person could see.
   */
  private async deniedRepoIds(principal: Principal): Promise<string[]> {
    const rows = await withOrgContext(this.options.db, principal.orgId, async (tx) =>
      tx.execute<{ repo_id: string | null }>(sql`
        SELECT repo_id FROM permission_revocations
        WHERE org_id = ${principal.orgId}
          AND principal_id = ${principal.id}
          AND expires_at > now()
      `),
    );

    if (rows.some((r) => r.repo_id === null)) {
      const all = await withOrgContext(this.options.db, principal.orgId, async (tx) =>
        tx.execute<{ id: string }>(sql`SELECT id FROM repos WHERE org_id = ${principal.orgId}`),
      );
      return all.map((r) => r.id);
    }

    return rows.map((r) => r.repo_id).filter((id): id is string => id !== null);
  }

  /** Called by the Git provider permission webhook — immediate invalidation (§15.4). */
  invalidate(orgId: string, principalId: string): void {
    this.cache.delete(`${orgId}:${principalId}`);
  }

  invalidateAll(): void {
    this.cache.clear();
  }
}

/**
 * Short-lived, repo-scoped ingest credentials (§15.2).
 *
 * "Mint the ingest credential via CI OIDC exchange scoped to one `repoId` for ~10 minutes,
 * never a static org secret." The token is a signed, self-contained claim so verification needs
 * no database round-trip on the ingest hot path.
 */
export interface IngestClaims {
  orgId: string;
  repoId: string;
  issuedAt: number;
  expiresAt: number;
  jti: string;
}

export function mintIngestToken(secret: string, claims: Omit<IngestClaims, 'jti'>): string {
  const full: IngestClaims = { ...claims, jti: randomUUID() };
  const payload = Buffer.from(JSON.stringify(full)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyIngestToken(secret: string, token: string): IngestClaims {
  const [payload, signature] = token.split('.');
  if (!payload || !signature) {
    throw new AuthError('Malformed ingest token.', 401, 'malformed_token');
  }

  const expected = createHmac('sha256', secret).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new AuthError('Ingest token signature is invalid.', 401, 'invalid_signature');
  }

  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as IngestClaims;
  if (claims.expiresAt <= Date.now()) {
    throw new AuthError(
      'Ingest token has expired. These are minted per run and last minutes by design.',
      401,
      'expired_token',
    );
  }

  return claims;
}

/**
 * §15.4 — MCP authorisation depth: "the platform as an OAuth resource server with RFC 8707
 * resource indicators and audience-bound tokens (otherwise a token minted for one IDE is
 * replayable against any other MCP server the user has connected — the confused deputy
 * problem)".
 *
 * The audience check is the specific defence. A token whose `aud` does not name this resource
 * is refused even when its signature is perfectly valid.
 */
export interface BearerClaims {
  sub: string;
  orgId: string;
  /** RFC 8707 resource indicator. Must name this server. */
  aud: string | string[];
  scope: string[];
  exp: number;
  /** Set for MCP sessions, so scope can default to the git-remote-inferred project. */
  mcpSessionId?: string;
}

export function assertAudience(claims: BearerClaims, expectedAudience: string): void {
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(expectedAudience)) {
    throw new AuthError(
      `Token audience ${JSON.stringify(claims.aud)} does not include ${expectedAudience}. Audience-bound tokens are what stop a credential minted for one MCP client being replayed against another.`,
      403,
      'audience_mismatch',
    );
  }
}

export function assertScope(claims: BearerClaims, required: string): void {
  if (!claims.scope.includes(required)) {
    throw new AuthError(`Token is missing the '${required}' scope.`, 403, 'insufficient_scope');
  }
}
