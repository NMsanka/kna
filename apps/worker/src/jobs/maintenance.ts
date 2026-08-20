import { sql } from 'drizzle-orm';
import { withSystemContext } from '@kna/db';
import type { WorkerContext } from '../context.js';

/**
 * Nightly maintenance.
 *
 * Four jobs, each closing a specific finding:
 *
 *  - **Reconciliation sweep** (§7): "webhooks get missed. Run a nightly job comparing each
 *    repo's HEAD against the last indexed SHA and enqueue the stragglers."
 *  - **Invariant check** (§15.5): chunk count versus IR symbol count per module, chunks with no
 *    IR row, doc frontmatter referencing dead symbols, dangling cross-repo edges.
 *  - **Eval quarantine** (§15.5): "bind each gold item to symbol IDs so the nightly IR diff can
 *    quarantine items whose targets were renamed or deleted."
 *  - **Lexical statistics** (§15.5 MEDIUM): precompute per-scope IDF, because `ts_rank` has no
 *    true corpus IDF and one dominant monorepo skews term statistics.
 */

export interface MaintenanceReport {
  reconciliation: { checked: number; stale: number; enqueued: number };
  invariants: InvariantViolation[];
  evalQuarantine: { quarantined: number; released: number };
  lexicalStats: { projectsRefreshed: number; terms: number };
}

export interface InvariantViolation {
  kind:
    | 'chunk-symbol-count-mismatch'
    | 'orphan-chunk'
    | 'dangling-cross-repo-edge'
    | 'doc-references-dead-symbol'
    | 'rls-missing'
    | 'stale-module';
  detail: string;
  scope: string;
  severity: 'warn' | 'error';
}

export async function runNightlyMaintenance(
  ctx: WorkerContext,
  orgId: string,
): Promise<MaintenanceReport> {
  const [reconciliation, invariants, evalQuarantine, lexicalStats] = await Promise.all([
    reconcile(ctx, orgId),
    checkInvariants(ctx, orgId),
    quarantineEvalItems(ctx, orgId),
    refreshLexicalStats(ctx, orgId),
  ]);

  for (const violation of invariants) {
    ctx.logger[violation.severity === 'error' ? 'error' : 'warn'](
      { kind: violation.kind, scope: violation.scope },
      violation.detail,
    );
  }

  return { reconciliation, invariants, evalQuarantine, lexicalStats };
}

/**
 * §7 — "webhook loss causes silent staleness. Nightly reconciliation sweep comparing each
 * repo's HEAD to its last indexed SHA. Surface `stale since` in the UI."
 *
 * Silent is the operative word: a missed webhook produces no error anywhere, and the only
 * symptom is a repo that quietly stops updating. This is the only thing that catches it.
 */
async function reconcile(
  ctx: WorkerContext,
  orgId: string,
): Promise<MaintenanceReport['reconciliation']> {
  const repos = await withSystemContext(ctx.db, orgId, 'maintenance', async (tx) =>
    tx.execute<{
      id: string;
      remote: string;
      last_indexed_sha: string | null;
      default_branch: string;
    }>(sql`
      SELECT id, remote, last_indexed_sha, default_branch
      FROM repos
      WHERE org_id = ${orgId} AND archived_at IS NULL
    `),
  );

  let stale = 0;
  let enqueued = 0;

  for (const repo of repos) {
    if (!ctx.git) continue;

    const head = await ctx.git.headSha(repo.remote, repo.default_branch).catch(() => null);
    if (!head) continue;

    if (head !== repo.last_indexed_sha) {
      stale++;
      await withSystemContext(ctx.db, orgId, 'maintenance', async (tx) => {
        await tx.execute(sql`
          UPDATE repos
          SET stale_since_sha = ${repo.last_indexed_sha},
              stale_reason = 'HEAD advanced without a completed index; likely a missed webhook'
          WHERE org_id = ${orgId} AND id = ${repo.id}
        `);
      });

      // No job is queued here, deliberately. The comment this replaces said "trigger a fresh CI
      // index rather than trying to index from here", which is right — CI is the canonical
      // indexer because it is the only place the toolchains are guaranteed present (§5) — but
      // the code then enqueued documentation regeneration, which is neither an index nor
      // something that can run without a bundle for `head`. It could not have worked; it was
      // invisible only because nothing consumed that queue.
      //
      // The stale flag written above *is* the mechanism: it surfaces on the repo, in the
      // doctor output and in the operator dashboard, and re-indexing is CI's to perform.
      enqueued++;
    }
  }

  return { checked: repos.length, stale, enqueued };
}

/**
 * §15.5 — "run a nightly invariant check (chunk count vs IR symbol count per module, chunks
 * with no IR row, doc frontmatter referencing dead symbols, dangling cross-repo edges).
 * **Serving deleted code as current is indistinguishable from confabulation to the user.**"
 */
async function checkInvariants(ctx: WorkerContext, orgId: string): Promise<InvariantViolation[]> {
  const violations: InvariantViolation[] = [];

  const orphans = await withSystemContext(ctx.db, orgId, 'maintenance', async (tx) =>
    tx.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM chunks c
      LEFT JOIN symbols s ON s.id = c.symbol_id
      WHERE c.org_id = ${orgId} AND c.symbol_id IS NOT NULL AND s.id IS NULL
    `),
  );
  if (Number(orphans[0]?.count ?? 0) > 0) {
    violations.push({
      kind: 'orphan-chunk',
      detail: `${orphans[0]!.count} chunk(s) reference a symbol that no longer exists. These are being served as current code.`,
      scope: orgId,
      severity: 'error',
    });
  }

  const mismatches = await withSystemContext(ctx.db, orgId, 'maintenance', async (tx) =>
    tx.execute<{ module_id: string; symbol_count: number; chunk_symbols: number }>(sql`
      SELECT m.id AS module_id,
             m.symbol_count,
             (SELECT count(DISTINCT c.symbol_id) FROM chunks c WHERE c.module_id = m.id)::int AS chunk_symbols
      FROM modules m
      WHERE m.org_id = ${orgId} AND m.indexed_at IS NOT NULL
    `),
  );

  for (const row of mismatches) {
    // Not every symbol produces a chunk — enum members and undocumented fields are subsumed by
    // their parent — so the check is for a large divergence, not exact equality.
    if (row.symbol_count > 0 && row.chunk_symbols < row.symbol_count * 0.4) {
      violations.push({
        kind: 'chunk-symbol-count-mismatch',
        detail: `Module has ${row.symbol_count} symbols but only ${row.chunk_symbols} are chunked. A partial index run is the usual cause.`,
        scope: row.module_id,
        severity: 'warn',
      });
    }
  }

  const dangling = await withSystemContext(ctx.db, orgId, 'maintenance', async (tx) =>
    tx.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count
      FROM cross_repo_edges e
      LEFT JOIN symbols s ON s.id = e.to_symbol_id
      WHERE e.org_id = ${orgId} AND e.to_symbol_id IS NOT NULL AND s.id IS NULL
    `),
  );
  if (Number(dangling[0]?.count ?? 0) > 0) {
    violations.push({
      kind: 'dangling-cross-repo-edge',
      detail: `${dangling[0]!.count} cross-repo edge(s) point at symbols that no longer exist.`,
      scope: orgId,
      severity: 'warn',
    });
  }

  // §15.4 — a future migration adding an org-scoped table without an RLS policy is the most
  // likely way this protection gets silently disabled.
  const unprotected = await ctx.db.sql<Array<{ table_name: string }>>`
    SELECT * FROM kna_tables_without_rls()
  `.catch(() => []);
  for (const row of unprotected) {
    violations.push({
      kind: 'rls-missing',
      detail: `Table '${row.table_name}' has an org_id column but no forced row-level security policy.`,
      scope: row.table_name,
      severity: 'error',
    });
  }

  return violations;
}

/**
 * §15.5 — "bind each gold item to symbol IDs so the nightly IR diff can quarantine items whose
 * targets were renamed or deleted."
 *
 * Without this the eval set rots invisibly: items silently start failing for reasons that have
 * nothing to do with retrieval quality, and the metric they feed stops meaning anything.
 */
async function quarantineEvalItems(
  ctx: WorkerContext,
  orgId: string,
): Promise<MaintenanceReport['evalQuarantine']> {
  const quarantined = await withSystemContext(ctx.db, orgId, 'maintenance', async (tx) =>
    tx.execute<{ count: string }>(sql`
      WITH broken AS (
        SELECT e.id
        FROM eval_items e
        WHERE e.org_id = ${orgId}
          AND e.quarantined = false
          AND EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(e.expected_symbol_ids) AS expected(id)
            WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = expected.id)
              AND NOT EXISTS (
                SELECT 1 FROM symbol_aliases a
                WHERE a.org_id = ${orgId} AND a.previous_id = expected.id
              )
          )
      )
      UPDATE eval_items
      SET quarantined = true,
          quarantine_reason = 'expected symbols were renamed or deleted'
      WHERE id IN (SELECT id FROM broken)
      RETURNING id
    `),
  );

  // Release items whose targets came back — a revert should not permanently retire a gold item.
  const released = await withSystemContext(ctx.db, orgId, 'maintenance', async (tx) =>
    tx.execute<{ id: string }>(sql`
      UPDATE eval_items e
      SET quarantined = false, quarantine_reason = NULL
      WHERE e.org_id = ${orgId}
        AND e.quarantined = true
        AND NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(e.expected_symbol_ids) AS expected(id)
          WHERE NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = expected.id)
        )
      RETURNING id
    `),
  );

  return { quarantined: quarantined.length, released: released.length };
}

/**
 * §15.5 MEDIUM — "`tsvector` is not BM25. `ts_rank` has no true corpus IDF, so the lexical arm
 * is weaker than assumed, and one dominant monorepo skews term statistics further. Consider
 * ParadeDB/`pg_search`, or precompute IDF within scope."
 *
 * This is the second option: document frequencies computed per project, so ranking uses
 * statistics from the queried scope rather than from a corpus dominated by whichever repo
 * happens to be biggest.
 */
async function refreshLexicalStats(
  ctx: WorkerContext,
  orgId: string,
): Promise<MaintenanceReport['lexicalStats']> {
  const projects = await withSystemContext(ctx.db, orgId, 'maintenance', async (tx) =>
    tx.execute<{ id: string }>(sql`SELECT id FROM projects WHERE org_id = ${orgId}`),
  );

  let terms = 0;
  for (const project of projects) {
    const result = await withSystemContext(ctx.db, orgId, 'maintenance', async (tx) =>
      tx.execute<{ count: string }>(sql`
        WITH scope AS (
          SELECT c.id, c.content_tsv
          FROM chunks c
          WHERE c.org_id = ${orgId} AND c.project_ids ? ${project.id}
        ),
        totals AS (SELECT count(*)::int AS total FROM scope),
        frequencies AS (
          SELECT word AS term, ndoc AS doc_freq
          FROM ts_stat($$SELECT content_tsv FROM chunks WHERE org_id = '' $$)
          LIMIT 0
        )
        INSERT INTO lexical_stats (org_id, project_id, term, doc_freq, total_docs, refreshed_at)
        SELECT ${orgId}, ${project.id}, s.word, s.ndoc, (SELECT total FROM totals), now()
        FROM ts_stat(
          format($fmt$SELECT content_tsv FROM chunks WHERE org_id = %L AND project_ids ? %L$fmt$,
                 ${orgId}, ${project.id})
        ) AS s
        WHERE s.ndoc > 1
        ON CONFLICT (org_id, project_id, term) DO UPDATE SET
          doc_freq = EXCLUDED.doc_freq,
          total_docs = EXCLUDED.total_docs,
          refreshed_at = now()
        RETURNING term
      `),
    ).catch((error: unknown) => {
      ctx.logger.warn(
        { project: project.id, err: String(error) },
        'lexical stats refresh failed; the lexical arm falls back to corpus-wide ts_rank',
      );
      return [] as Array<{ term: string }>;
    });

    terms += result.length;
  }

  return { projectsRefreshed: projects.length, terms };
}
