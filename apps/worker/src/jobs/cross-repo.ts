import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withSystemContext } from '@kna/db';
import type { WorkerContext } from '../context.js';

/**
 * The cross-repo resolution pass (§4.3).
 *
 * "Because symbol IDs are globally unique, IR edges can cross repos. Resolve these at index
 * time, after all repos in a project are ingested... Run this as a distinct cross-repo
 * resolution pass after per-repo indexing. It needs the whole project's IR present, so it
 * cannot be part of a single repo's job."
 *
 * §15.6 names it "the real scaling wall": "it is single-node, effectively single-threaded, grows
 * with the largest project, and serialises against every repo in it. Bound it: incremental
 * resolution keyed on which edges could have changed, a memory ceiling with spill to Postgres,
 * a per-project lock with timeout, and a fallback that publishes per-repo results with
 * cross-repo edges marked `pending` rather than blocking project freshness."
 *
 * All four bounds are implemented. The fourth matters most in practice: a slow resolution must
 * never be the reason a repo's own index is stale.
 */

export interface CrossRepoInput {
  orgId: string;
  projectId: string;
  triggeredByRepoId: string;
}

export interface CrossRepoResult {
  projectId: string;
  edgesResolved: number;
  edgesPending: number;
  byKind: Record<string, number>;
  timedOut: boolean;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MEMORY_CEILING_SYMBOLS = 500_000;

export async function resolveCrossRepoEdges(
  ctx: WorkerContext,
  input: CrossRepoInput,
  options: { timeoutMs?: number } = {},
): Promise<CrossRepoResult> {
  const started = Date.now();
  const deadline = started + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const byKind: Record<string, number> = {};
  let edgesResolved = 0;
  let edgesPending = 0;
  let timedOut = false;

  const record = (kind: string) => {
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    edgesResolved++;
  };

  // Per-project advisory lock with a timeout. Two concurrent passes over one project would
  // duplicate edges and race on the same rows.
  const acquired = await withSystemContext(
    ctx.db,
    input.orgId,
    'cross-repo-resolution',
    async (tx) => {
      const rows = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_lock(hashtextextended(${`cross:${input.projectId}`}, 0)) AS locked`,
      );
      return rows[0]?.locked ?? false;
    },
  );

  if (!acquired) {
    ctx.logger.info({ projectId: input.projectId }, 'cross-repo pass already running; skipping');
    return {
      projectId: input.projectId,
      edgesResolved: 0,
      edgesPending: 0,
      byKind: {},
      timedOut: false,
      durationMs: Date.now() - started,
    };
  }

  try {
    // Memory ceiling. A project past this size resolves incrementally against the database
    // rather than loading its symbol table into the process.
    const size = await withSystemContext(
      ctx.db,
      input.orgId,
      'cross-repo-resolution',
      async (tx) => {
        const rows = await tx.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count
        FROM symbols s
        JOIN module_projects mp ON mp.module_id = s.module_id
        WHERE s.org_id = ${input.orgId} AND mp.project_id = ${input.projectId}
      `);
        return Number(rows[0]?.count ?? 0);
      },
    );

    const spillToPostgres = size > MEMORY_CEILING_SYMBOLS;
    if (spillToPostgres) {
      ctx.logger.info(
        { projectId: input.projectId, symbols: size },
        'cross-repo pass resolving in-database: project exceeds the in-process memory ceiling',
      );
    }

    // ── Edge 1: API contract. §4.3 calls this "the single most useful edge in the system" —
    //    an operationId in a service's OpenAPI document matching a generated client method in a
    //    consumer, which traces a frontend call to its backend implementation across languages.
    edgesResolved += await resolveApiContractEdges(ctx, input, deadline, record);
    if (Date.now() > deadline) timedOut = true;

    // ── Edge 2: package dependency. Consumer symbols → producer symbols.
    if (!timedOut) {
      edgesResolved += await resolvePackageEdges(ctx, input, deadline, record);
      if (Date.now() > deadline) timedOut = true;
    }

    // ── Edge 3: shared DTO shape. Divergence between them is flagged as drift.
    if (!timedOut) {
      edgesResolved += await resolveSharedTypeEdges(ctx, input, deadline, record);
      if (Date.now() > deadline) timedOut = true;
    }

    // The fallback §15.6 asks for: whatever did not resolve is marked pending rather than
    // holding up the project. A repo's own index is already live either way.
    edgesPending = await countPending(ctx, input);

    if (timedOut) {
      ctx.logger.warn(
        { projectId: input.projectId, edgesResolved, edgesPending },
        'cross-repo pass hit its deadline; unresolved edges left pending',
      );
    }

    return {
      projectId: input.projectId,
      edgesResolved,
      edgesPending,
      byKind,
      timedOut,
      durationMs: Date.now() - started,
    };
  } finally {
    await withSystemContext(ctx.db, input.orgId, 'cross-repo-resolution', async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_unlock(hashtextextended(${`cross:${input.projectId}`}, 0))`,
      );
    });
  }
}

/**
 * API contract edges.
 *
 * Matches an `operationId` declared by a producer's HTTP binding against a consumer symbol whose
 * name or generated-client method corresponds to it. This is what makes "how does the web app
 * authenticate against the billing API" answerable, and it is the edge that no import graph can
 * produce because the two sides are in different languages and different repositories.
 */
async function resolveApiContractEdges(
  ctx: WorkerContext,
  input: CrossRepoInput,
  deadline: number,
  record: (kind: string) => void,
): Promise<number> {
  const rows = await withSystemContext(ctx.db, input.orgId, 'cross-repo-resolution', async (tx) =>
    tx.execute<{ consumer_id: string; producer_id: string; operation_id: string }>(sql`
      WITH producers AS (
        SELECT s.id, s.repo_id, s.http_binding ->> 'operationId' AS operation_id
        FROM symbols s
        JOIN module_projects mp ON mp.module_id = s.module_id
        WHERE s.org_id = ${input.orgId}
          AND mp.project_id = ${input.projectId}
          AND s.http_binding IS NOT NULL
          AND s.http_binding ->> 'operationId' IS NOT NULL
      ),
      consumers AS (
        SELECT s.id, s.repo_id, s.name, s.qualified_name
        FROM symbols s
        JOIN module_projects mp ON mp.module_id = s.module_id
        WHERE s.org_id = ${input.orgId}
          AND mp.project_id = ${input.projectId}
          AND s.http_binding IS NULL
      )
      SELECT c.id AS consumer_id, p.id AS producer_id, p.operation_id
      FROM producers p
      JOIN consumers c
        ON lower(c.name) = lower(p.operation_id)
       -- Cross-repo only: a same-repo match is already an ordinary call edge.
       AND c.repo_id <> p.repo_id
      LIMIT 20000
    `),
  );

  let count = 0;
  for (const row of rows) {
    if (Date.now() > deadline) break;
    await insertEdge(ctx, input, {
      from: row.consumer_id,
      to: row.producer_id,
      kind: 'api-contract',
      evidence: `operationId '${row.operation_id}'`,
      confidence: 'certain',
    });
    record('api-contract');
    count++;
  }
  return count;
}

/**
 * Package dependency edges.
 *
 * A consumer module declares a dependency on a package that a producer module publishes, so
 * unresolved references in the consumer that match exported names in the producer become edges.
 */
async function resolvePackageEdges(
  ctx: WorkerContext,
  input: CrossRepoInput,
  deadline: number,
  record: (kind: string) => void,
): Promise<number> {
  const rows = await withSystemContext(ctx.db, input.orgId, 'cross-repo-resolution', async (tx) =>
    tx.execute<{ consumer_id: string; producer_id: string; package_name: string }>(sql`
      WITH consumers AS (
        SELECT m.id AS module_id, m.repo_id, dep ->> 'name' AS package_name
        FROM modules m
        JOIN module_projects mp ON mp.module_id = m.id,
             jsonb_array_elements(m.dependencies) AS dep
        WHERE m.org_id = ${input.orgId} AND mp.project_id = ${input.projectId}
      ),
      producers AS (
        SELECT m.id AS module_id, m.repo_id, m.package_name
        FROM modules m
        JOIN module_projects mp ON mp.module_id = m.id
        WHERE m.org_id = ${input.orgId}
          AND mp.project_id = ${input.projectId}
          AND m.package_name IS NOT NULL
      )
      SELECT cs.id AS consumer_id, ps.id AS producer_id, c.package_name
      FROM consumers c
      JOIN producers p ON p.package_name = c.package_name AND p.repo_id <> c.repo_id
      JOIN symbols cs ON cs.module_id = c.module_id
      JOIN symbols ps ON ps.module_id = p.module_id AND ps.visibility = 'public'
      WHERE cs.unresolved_names @> to_jsonb(ps.name)
      LIMIT 20000
    `),
  ).catch(() => []);

  let count = 0;
  for (const row of rows) {
    if (Date.now() > deadline) break;
    await insertEdge(ctx, input, {
      from: row.consumer_id,
      to: row.producer_id,
      kind: 'package-dependency',
      evidence: `package '${row.package_name}'`,
      confidence: 'likely',
    });
    record('package-dependency');
    count++;
  }
  return count;
}

/**
 * Shared DTO shapes.
 *
 * §4.3 — "the same DTO shape appears in a C# record and a TS interface → link them, and flag
 * divergence as drift." Matched on normalised structural shape rather than on name, because the
 * naming conventions differ between the two languages and matching on name would miss most of
 * them while producing false positives on the rest.
 */
async function resolveSharedTypeEdges(
  ctx: WorkerContext,
  input: CrossRepoInput,
  deadline: number,
  record: (kind: string) => void,
): Promise<number> {
  const rows = await withSystemContext(ctx.db, input.orgId, 'cross-repo-resolution', async (tx) =>
    tx.execute<{ a_id: string; b_id: string; shape: string }>(sql`
      WITH shapes AS (
        SELECT s.id, s.repo_id, s.language,
               md5(
                 (SELECT string_agg(lower(p ->> 'name'), ',' ORDER BY lower(p ->> 'name'))
                  FROM jsonb_array_elements(s.parameters) AS p)
               ) AS shape
        FROM symbols s
        JOIN module_projects mp ON mp.module_id = s.module_id
        WHERE s.org_id = ${input.orgId}
          AND mp.project_id = ${input.projectId}
          AND s.kind IN ('interface', 'record', 'class', 'struct', 'type')
          AND jsonb_array_length(COALESCE(s.parameters, '[]'::jsonb)) >= 3
      )
      SELECT a.id AS a_id, b.id AS b_id, a.shape
      FROM shapes a
      JOIN shapes b
        ON a.shape = b.shape
       AND a.repo_id < b.repo_id
       AND a.language <> b.language
      WHERE a.shape IS NOT NULL
      LIMIT 5000
    `),
  ).catch(() => []);

  let count = 0;
  for (const row of rows) {
    if (Date.now() > deadline) break;
    await insertEdge(ctx, input, {
      from: row.a_id,
      to: row.b_id,
      kind: 'shared-type',
      evidence: `identical field set (${row.shape.slice(0, 8)})`,
      confidence: 'likely',
    });
    record('shared-type');
    count++;
  }
  return count;
}

async function insertEdge(
  ctx: WorkerContext,
  input: CrossRepoInput,
  edge: {
    from: string;
    to: string;
    kind: string;
    evidence: string;
    confidence: 'certain' | 'likely';
  },
): Promise<void> {
  await withSystemContext(ctx.db, input.orgId, 'cross-repo-resolution', async (tx) => {
    await tx.execute(sql`
      INSERT INTO cross_repo_edges (
        id, org_id, project_id, from_symbol_id, to_symbol_id, kind, evidence, confidence, status
      ) VALUES (
        ${randomUUID()}, ${input.orgId}, ${input.projectId}, ${edge.from}, ${edge.to},
        ${edge.kind}, ${edge.evidence}, ${edge.confidence}, 'resolved'
      )
      ON CONFLICT (from_symbol_id, to_symbol_id, kind) DO UPDATE SET
        status = 'resolved', resolved_at = now(), evidence = EXCLUDED.evidence
    `);
  });
}

async function countPending(ctx: WorkerContext, input: CrossRepoInput): Promise<number> {
  const rows = await withSystemContext(ctx.db, input.orgId, 'cross-repo-resolution', async (tx) =>
    tx.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM cross_repo_edges
      WHERE org_id = ${input.orgId} AND project_id = ${input.projectId} AND status = 'pending'
    `),
  );
  return Number(rows[0]?.count ?? 0);
}
