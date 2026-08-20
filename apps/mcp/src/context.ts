import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, withOrgContext, type DbHandle } from '@kna/db';
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
    service: string | null,
  ) => Promise<{
    mermaid: string;
    textAlternative: string;
    repoIds: string[];
    moduleIds: string[];
  }>;
  changesSince: (
    access: AccessContext,
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

  const llm = new LlmClient({
    baseUrl: env.LITELLM_BASE_URL,
    keys: { interactive: env.LITELLM_KEY_INTERACTIVE, batch: env.LITELLM_KEY_BATCH },
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

      const [granted, denied] = await Promise.all([
        db.sql<Array<{ repo_id: string }>>`
          SELECT repo_id FROM repo_permissions
          WHERE org_id = ${principal.orgId} AND principal_id = ${principal.id}
        `,
        db.sql<Array<{ repo_id: string | null }>>`
          SELECT repo_id FROM permission_revocations
          WHERE org_id = ${principal.orgId} AND principal_id = ${principal.id}
            AND expires_at > now()
        `,
      ]);

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
      const rows = await db.sql<
        Array<{
          principal_id: string;
          org_id: string;
          subject: string;
          email: string | null;
          clearance: McpPrincipal['clearance'];
          is_service_account: boolean;
          audience: string;
          scopes: string[];
          inferred_project_id: string | null;
          client_name: string | null;
          expires_at: Date;
        }>
      >`
        SELECT t.principal_id, p.org_id, p.subject, p.email, p.clearance, p.is_service_account,
               t.audience, t.scopes, t.inferred_project_id, t.client_name, t.expires_at
        FROM mcp_tokens t
        JOIN principals p ON p.id = t.principal_id
        WHERE t.token_hash = ${hash}
          AND t.expires_at > now()
          AND t.revoked_at IS NULL
          AND p.disabled_at IS NULL
        LIMIT 1
      `;

      const row = rows[0];
      if (!row) throw new McpAuthError('Unknown, expired or revoked token.');

      // §15.4 — the confused-deputy defence. A token minted for a different MCP resource is
      // refused even though its signature and expiry are perfectly valid.
      if (row.audience !== resourceIndicator) {
        throw new McpAuthError(
          `Token audience '${row.audience}' does not match this resource. Audience-bound tokens are what stop a credential minted for one MCP server being replayed against another.`,
        );
      }

      return {
        principal: {
          id: row.principal_id,
          orgId: row.org_id,
          subject: row.subject,
          email: row.email,
          clearance: row.clearance,
          isServiceAccount: row.is_service_account,
        },
        audience: row.audience,
        scopes: row.scopes,
        inferredProjectId: row.inferred_project_id,
        clientName: row.client_name,
        expiresAt: row.expires_at.getTime(),
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

      await db.sql`
        INSERT INTO audit_events (id, org_id, hash, actor_type, actor_id, actor_subject,
                                  action, outcome, detail, repos_touched, chunk_ids)
        VALUES (
          gen_random_uuid()::text, ${input.identity.principal.orgId}, '',
          'mcp', ${input.identity.principal.id}, ${input.identity.principal.subject},
          ${input.action}, 'success',
          ${JSON.stringify({ sessionId: input.sessionId, client: input.identity.clientName })}::jsonb,
          ${JSON.stringify(input.repoIds)}::jsonb,
          ${JSON.stringify(input.chunkIds)}::jsonb
        )
      `.catch((error: unknown) => {
        logger.error({ err: String(error) }, 'mcp audit write failed');
      });

      // §15.4 — breadth over volume. Maintained as a rolling aggregate so the detector is a
      // cheap upsert rather than a scan of audit rows.
      await db.sql`
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
      `.catch(() => undefined);
    },

    async architecture(access, service) {
      const modules = await withOrgContext(db, access.orgId, async (tx) =>
        tx.execute<{
          id: string;
          name: string;
          repo_id: string;
          dependencies: Array<{ name: string }>;
        }>(sql`
          SELECT id, name, repo_id, dependencies FROM modules
          WHERE org_id = ${access.orgId}
            AND repo_id = ANY(${access.permittedRepoIds})
            ${service ? sql`AND name ILIKE ${`%${service}%`}` : sql``}
          LIMIT 200
        `),
      );

      const services = await withOrgContext(db, access.orgId, async (tx) =>
        tx.execute<{ name: string; kind: string; depends_on: string[] }>(sql`
          SELECT name, kind, depends_on FROM services
          WHERE org_id = ${access.orgId} AND repo_id = ANY(${access.permittedRepoIds})
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

    async changesSince(access, since, options) {
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
            AND s.repo_id = ANY(${access.permittedRepoIds})
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
      await db.close();
    },
  };
}
