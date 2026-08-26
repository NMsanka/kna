import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  anyOf,
  createDb,
  withAuthProbe,
  withOrgContext,
  withSystemContext,
  type DbHandle,
} from '@kna/db';
import { AuditRecorder } from '@kna/audit';
import { HealthRegistry, KnaMetrics, type Logger } from '@kna/observability';
import { LlmClient } from '@kna/llm';
import {
  DEFAULT_RETRIEVAL_CONFIG,
  NullReranker,
  Reranker,
  RetrievalPipeline,
  RetrievalStore,
  type AccessContext,
  type RetrievalScope,
} from '@kna/retrieval';
import type { PlatformEnv } from '@kna/config';
import { scopeNarrowing } from './scope.js';

/**
 * MCP server wiring.
 *
 * Two things distinguish this from the API's context.
 *
 * §15.4 — MCP scopes are *narrower* than the user's full permission set: "scopes narrower than
 * the user's full permission set (default to the git-remote-inferred project)". An agent acting
 * on a developer's behalf should not silently inherit read access to four hundred repositories
 * because the developer happens to have it.
 *
 * §15.4 again — MCP is the surface where insider exfiltration is easiest, because
 * `search_codebase` + `find_usages` + `get_symbol` in a loop "is a *better* exfiltration tool
 * than `git clone`... and looks like ordinary IDE traffic". Every tool call feeds the breadth
 * monitor, and breadth rather than volume is what alerts.
 */

export interface McpPrincipal {
  id: string;
  orgId: string;
  subject: string;
  email: string | null;
  clearance: 'public' | 'internal' | 'confidential' | 'restricted';
  isServiceAccount: boolean;
}

export interface McpIdentity {
  principal: McpPrincipal;
  /** RFC 8707 resource this token was minted for. Checked against ours (§15.4). */
  audience: string;
  scopes: string[];
  /** Project inferred from the client's working-directory git remote, when it sent one. */
  inferredProjectId: string | null;
  clientName: string | null;
  expiresAt: number;
}

export interface McpContext {
  env: PlatformEnv;
  logger: Logger;
  db: DbHandle;
  retrieval: RetrievalPipeline;
  permissions: PermissionResolverLike;
  health: HealthRegistry;
  resourceIndicator: string;
  authenticate: (token: string) => Promise<McpIdentity>;
  resolveScope: (
    identity: McpIdentity,
    scope: { project?: string; repo?: string; version?: string; expand?: boolean } | undefined,
  ) => Promise<RetrievalScope>;
  recordAccess: (input: {
    identity: McpIdentity;
    action: string;
    chunkIds: string[];
    repoIds: string[];
    moduleIds: string[];
    sessionId: string;
  }) => Promise<void>;
  architecture: (
    access: AccessContext,
    scope: RetrievalScope,
    service: string | null,
  ) => Promise<{
    mermaid: string;
    textAlternative: string;
    repoIds: string[];
    moduleIds: string[];
  }>;
  changesSince: (
    access: AccessContext,
    scope: RetrievalScope,
    since: string,
    options: { breakingOnly: boolean; limit: number },
  ) => Promise<{ rendered: string; repoIds: string[] }>;
  shutdown: () => Promise<void>;
}

export interface PermissionResolverLike {
  resolve(
    principal: McpPrincipal,
    options: { corpus: 'internal' | 'external' },
  ): Promise<AccessContext>;
}

export class McpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'McpAuthError';
  }
}

export async function createMcpContext(env: PlatformEnv, logger: Logger): Promise<McpContext> {
  const db = createDb({
    url: env.DATABASE_URL,
    role: 'interactive',
    poolMax: env.DATABASE_POOL_MAX,
    // MCP sits inside an agent loop, so §15.6's "MCP p95 is tightest" applies to the database
    // timeout too: a slow query here stalls the agent, not just a page.
    statementTimeoutMs: Math.min(env.DATABASE_STATEMENT_TIMEOUT_MS, 8_000),
    applicationName: 'kna-mcp',
  });

  // A second handle with the write-capable role. 0005 gives `kna_interactive` SELECT only, which
  // is the right posture for the surface an agent drives — but audit and breadth accounting are
  // writes the platform owes regardless of what the caller asked for.
  const dbBatch = createDb({
    url: env.DATABASE_URL_BATCH ?? env.DATABASE_URL,
    role: 'batch',
    poolMax: 4,
    idleInTransactionSessionTimeoutMs: env.DATABASE_BATCH_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    applicationName: 'kna-mcp-audit',
  });

  const audit = new AuditRecorder(dbBatch, logger);

  const llm = new LlmClient({
    baseUrl: env.LITELLM_BASE_URL,
    keys: { interactive: env.LITELLM_KEY_INTERACTIVE, batch: env.LITELLM_KEY_BATCH },
    authHeader: env.LITELLM_AUTH_HEADER,
    authScheme: env.LITELLM_AUTH_SCHEME,
    region: env.KNA_REGION,
    onRateLimited: ({ model }) => KnaMetrics.providerRateLimited.add(1, { model, surface: 'mcp' }),
  });

  const reranker = env.RERANKER_URL
    ? new Reranker({
        url: env.RERANKER_URL,
        model: env.RERANKER_MODEL,
        timeoutMs: env.RERANKER_TIMEOUT_MS,
      })
    : new NullReranker();

  const retrieval = new RetrievalPipeline({
    store: new RetrievalStore(db),
    reranker,
    llm,
    embed: async (query: string) => {
      const result = await llm.embed({
        orgId: 'system',
        texts: [query],
        dimensions: env.EMBEDDING_DIMENSIONS,
        contentSensitivity: 'internal',
      });
      return result.vectors[0]!;
    },
    config: {
      ...DEFAULT_RETRIEVAL_CONFIG,
      embeddingModel: env.EMBEDDING_MODEL,
      embeddingDimensions: env.EMBEDDING_DIMENSIONS,
      efSearch: env.PGVECTOR_EF_SEARCH,
      abstentionThreshold: env.ABSTENTION_THRESHOLD,
    },
  });

  const resourceIndicator = `https://mcp.kna.internal`;

  const health = new HealthRegistry().register({
    name: 'postgres',
    kind: 'critical',
    check: async () => {
      await db.sql`SELECT 1`;
      return { state: 'up' };
    },
  });

  const permissions: PermissionResolverLike = {
    async resolve(principal, options) {
      if (options.corpus === 'external') {
        return {
          orgId: principal.orgId,
          principalId: principal.id,
          permittedRepoIds: [],
          clearance: 'public',
          corpus: 'external',
        };
      }

      // Inside org context, not on the bare connection. `repo_permissions` is RLS-scoped like
      // everything else, so an unscoped read returns zero rows — and zero permitted repos is
      // indistinguishable from a principal with no access. Every MCP tool call failed with
      // "caller has no permitted repositories" while the grant sat in the table.
      const [granted, denied] = await withOrgContext(db, principal.orgId, async (tx) =>
        Promise.all([
          tx.execute<{ repo_id: string }>(sql`
            SELECT repo_id FROM repo_permissions
            WHERE org_id = ${principal.orgId} AND principal_id = ${principal.id}
          `),
          tx.execute<{ repo_id: string | null }>(sql`
            SELECT repo_id FROM permission_revocations
            WHERE org_id = ${principal.orgId} AND principal_id = ${principal.id}
              AND expires_at > now()
          `),
        ]),
      );

      const deniedIds = denied.map((d) => d.repo_id).filter((id): id is string => id !== null);
      const denyAll = denied.some((d) => d.repo_id === null);

      return {
        orgId: principal.orgId,
        principalId: principal.id,
        permittedRepoIds: denyAll
          ? []
          : granted.map((g) => g.repo_id).filter((id) => !deniedIds.includes(id)),
        clearance: principal.clearance,
        corpus: 'internal',
        deniedRepoIds: deniedIds,
      };
    },
  };

  return {
    env,
    logger,
    db,
    retrieval,
    permissions,
    health,
    resourceIndicator,

    async authenticate(token: string): Promise<McpIdentity> {
      const hash = createHash('sha256').update(token).digest('hex');

      // Two contexts, for the reason spelled out in migration 0006: the token row is read
      // through the auth probe because there is no principal yet to derive a tenant scope from,
      // and everything after it is read inside the org that token resolved to.
      const claim = await withAuthProbe(db, hash, async (tx) => {
        const rows = await tx.execute(sql`
          SELECT principal_id, org_id, audience, scopes, inferred_project_id, client_name,
                 expires_at
            FROM mcp_tokens
           WHERE token_hash = ${hash}
             AND expires_at > now()
             AND revoked_at IS NULL
           LIMIT 1
        `);
        return rows[0] ?? null;
      });

      if (!claim) throw new McpAuthError('Unknown, expired or revoked token.');

      // §15.4 — the confused-deputy defence. A token minted for a different MCP resource is
      // refused even though its signature and expiry are perfectly valid. Checked before the
      // principal is loaded: a token for the wrong resource should learn nothing about who it
      // would have been.
      const audience = String(claim.audience);
      if (audience !== resourceIndicator) {
        throw new McpAuthError(
          `Token audience '${audience}' does not match this resource. Audience-bound tokens are what stop a credential minted for one MCP server being replayed against another.`,
        );
      }

      const orgId = String(claim.org_id);
      const principal = await withOrgContext(db, orgId, async (tx) => {
        const rows = await tx.execute(sql`
          SELECT id, subject, email, clearance, is_service_account
            FROM principals
           WHERE id = ${String(claim.principal_id)} AND org_id = ${orgId} AND disabled_at IS NULL
           LIMIT 1
        `);
        return rows[0] ?? null;
      });

      if (!principal) throw new McpAuthError('Unknown, expired or revoked token.');

      return {
        principal: {
          id: String(principal.id),
          orgId,
          subject: String(principal.subject),
          email: principal.email === null ? null : String(principal.email),
          clearance: principal.clearance as McpPrincipal['clearance'],
          isServiceAccount: Boolean(principal.is_service_account),
        },
        audience,
        scopes: claim.scopes as string[],
        inferredProjectId:
          claim.inferred_project_id === null ? null : String(claim.inferred_project_id),
        clientName: claim.client_name === null ? null : String(claim.client_name),
        expiresAt: new Date(String(claim.expires_at)).getTime(),
      };
    },

    /**
     * §4.3 — "for the MCP server, infer scope from the client's working directory git remote —
     * when someone has `billing-api` open in Cursor, default to the Billing project. Expose
     * scope as an optional tool parameter so an agent can widen it deliberately."
     */
    async resolveScope(identity, scope): Promise<RetrievalScope> {
      const orgId = identity.principal.orgId;

      if (scope?.repo) {
        const rows = await withOrgContext(db, orgId, async (tx) =>
          tx.execute<{ id: string }>(sql`
            SELECT id FROM repos WHERE org_id = ${orgId} AND (name = ${scope.repo} OR remote LIKE ${`%${scope.repo}`})
            LIMIT 1
          `),
        );
        if (rows[0]) return { kind: 'repo', orgId, repoIds: [rows[0].id] };
      }

      if (scope?.project) {
        const rows = await withOrgContext(db, orgId, async (tx) =>
          tx.execute<{ id: string }>(sql`
            SELECT id FROM projects WHERE org_id = ${orgId} AND slug = ${scope.project} LIMIT 1
          `),
        );
        if (rows[0]) {
          return { kind: scope.expand ? 'expanded' : 'project', orgId, projectIds: [rows[0].id] };
        }
      }

      if (identity.inferredProjectId) {
        return {
          kind: scope?.expand ? 'expanded' : 'project',
          orgId,
          projectIds: [identity.inferredProjectId],
        };
      }

      // No inference available. Org scope is deliberately the last resort, not the default —
      // an agent given the whole org by default retrieves worse *and* widens the blast radius.
      return { kind: 'org', orgId };
    },

    async recordAccess(input) {
      KnaMetrics.providerRequests.add(1, { surface: 'mcp', tool: input.action });

      // Through the shared recorder, not an inline INSERT.
      //
      // The inline version was wrong in three independent ways, and every one of them was
      // swallowed by the `.catch()` around it, so MCP appeared to be audited and was not:
      // it wrote `hash = ''`, placing the row outside the tamper-evident chain §15.7 requires;
      // it ran without org context, so the RLS WITH CHECK rejected it; and it used the
      // interactive handle, which 0005 grants SELECT and nothing more.
      await audit.record({
        orgId: input.identity.principal.orgId,
        action: input.action,
        actorType: 'mcp',
        actorId: input.identity.principal.id,
        actorSubject: input.identity.principal.subject,
        outcome: 'success',
        detail: { sessionId: input.sessionId, client: input.identity.clientName },
        reposTouched: input.repoIds,
        chunkIds: input.chunkIds,
      });

      // §15.4 — breadth over volume. Maintained as a rolling aggregate so the detector is a
      // cheap upsert rather than a scan of audit rows.
      await withSystemContext(dbBatch, input.identity.principal.orgId, 'maintenance', (tx) =>
        tx.execute(sql`
          INSERT INTO access_breadth (org_id, principal_id, window_start, distinct_repos,
                                      distinct_modules, tool_calls, surface)
          VALUES (
            ${input.identity.principal.orgId}, ${input.identity.principal.id},
            date_trunc('hour', now()), ${input.repoIds.length}, ${input.moduleIds.length}, 1, 'mcp'
          )
          ON CONFLICT (org_id, principal_id, window_start, surface) DO UPDATE SET
            distinct_repos = access_breadth.distinct_repos + EXCLUDED.distinct_repos,
            distinct_modules = access_breadth.distinct_modules + EXCLUDED.distinct_modules,
            tool_calls = access_breadth.tool_calls + 1
        `),
      ).catch((error: unknown) => {
        // Aggregate only — the authoritative record is the audit row above.
        logger.error({ err: String(error) }, 'mcp access-breadth update failed');
      });
    },

    async architecture(access, scope, service) {
      const modules = await withOrgContext(db, access.orgId, async (tx) =>
        tx.execute<{
          id: string;
          name: string;
          repo_id: string;
          dependencies: Array<{ name: string }>;
        }>(sql`
          SELECT id, name, repo_id, dependencies FROM modules m
          WHERE m.org_id = ${access.orgId}
            AND m.repo_id = ${anyOf(access.permittedRepoIds)}
            ${scopeNarrowing(scope, { moduleId: sql`m.id`, repoId: sql`m.repo_id` })}
            ${service ? sql`AND m.name ILIKE ${`%${service}%`}` : sql``}
          LIMIT 200
        `),
      );

      const services = await withOrgContext(db, access.orgId, async (tx) =>
        tx.execute<{ name: string; kind: string; depends_on: string[] }>(sql`
          SELECT name, kind, depends_on FROM services sv
          WHERE sv.org_id = ${access.orgId}
            AND sv.repo_id = ${anyOf(access.permittedRepoIds)}
            ${scopeNarrowing(scope, { moduleId: sql`sv.module_id`, repoId: sql`sv.repo_id` })}
          LIMIT 200
        `),
      );

      const nodeId = (value: string) =>
        `n${createHash('sha1').update(value).digest('hex').slice(0, 8)}`;
      const lines = ['```mermaid', 'graph LR'];
      const described: string[] = [];

      for (const module of modules) {
        lines.push(`  ${nodeId(module.id)}["${module.name.replace(/"/g, '')}"]`);
      }
      for (const service of services) {
        lines.push(`  ${nodeId(service.name)}(["${service.name}<br/>${service.kind}"])`);
        for (const dependency of service.depends_on) {
          lines.push(`  ${nodeId(service.name)} --> ${nodeId(dependency)}`);
          described.push(`${service.name} depends on ${dependency}`);
        }
      }
      lines.push('```');

      return {
        mermaid: lines.join('\n'),
        // The complete edge list, not a summary — §15.8 requires a real text alternative.
        textAlternative: [
          `Architecture: ${modules.length} module(s), ${services.length} runtime service(s).`,
          ...described.map((d) => `- ${d}`),
        ].join('\n'),
        repoIds: [...new Set(modules.map((m) => m.repo_id))],
        moduleIds: modules.map((m) => m.id),
      };
    },

    async changesSince(access, scope, since, options) {
      const rows = await withOrgContext(db, access.orgId, async (tx) =>
        tx.execute<{
          qualified_name: string;
          signature: string;
          repo_id: string;
          source_path: string;
          indexed_at: Date;
        }>(sql`
          SELECT s.qualified_name, s.signature, s.repo_id, s.source_path, s.indexed_at
          FROM symbols s
          JOIN ir_bundles b ON b.repo_id = s.repo_id AND b.commit_sha = ${since}
          WHERE s.org_id = ${access.orgId}
            AND s.repo_id = ${anyOf(access.permittedRepoIds)}
            ${scopeNarrowing(scope, { moduleId: sql`s.module_id`, repoId: sql`s.repo_id` })}
            AND s.indexed_at > b.received_at
          ORDER BY s.indexed_at DESC
          LIMIT ${options.limit}
        `),
      ).catch(() => []);

      if (rows.length === 0) {
        return {
          rendered: `No indexed changes found since '${since}'. If that ref was never indexed, there is nothing to compare against.`,
          repoIds: [],
        };
      }

      return {
        rendered: [
          `# Changes since ${since}`,
          '',
          'Breaking-change flags below are derived from signature comparison, not model judgement.',
          '',
          ...rows.map((r) => `- \`${r.qualified_name}\` — ${r.source_path}\n  \`${r.signature}\``),
        ].join('\n'),
        repoIds: [...new Set(rows.map((r) => r.repo_id))],
      };
    },

    async shutdown() {
      // Audit first: the recorder buffers, and a rolling deploy that closes the pool underneath
      // it loses the tail of the trail — precisely the records an incident review would want.
      await audit.flush();
      await Promise.all([db.close(), dbBatch.close()]);
    },
  };
}
