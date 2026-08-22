import { sql } from 'drizzle-orm';
import { anyOf, withSystemContext } from '@kna/db';
import type { WorkerContext } from '../context.js';

/**
 * Translate the project references a repository declares into the project ids the platform uses.
 *
 * A repo writes slugs in its `kna.config.yaml` — `projects: [platform]` — because it cannot be
 * expected to know the platform's internal ids, any more than it knows its own orgId. Everything
 * downstream of ingest speaks in ids: `module_projects`, `chunks.project_ids`, and therefore the
 * ACL filter's project-overlap test.
 *
 * Shared rather than duplicated because the two jobs that write chunks must agree. They did not:
 * indexing resolved slugs to ids while documentation regeneration wrote the raw slugs, so the
 * code corpus and the docs corpus ended up in different namespaces. Every project-scoped query —
 * which is every MCP tool call, since scope is inferred from the client's working directory —
 * matched the code chunks and silently filtered out all 317 documentation chunks. The
 * documentation was generated, stored, embedded, and unreachable.
 *
 * Unknown references are dropped rather than invented, so a typo narrows visibility instead of
 * granting it.
 */
export async function resolveProjectIds(
  ctx: WorkerContext,
  orgId: string,
  declared: readonly string[],
): Promise<string[]> {
  if (declared.length === 0) return [];
  return withSystemContext(ctx.db, orgId, 'indexing', async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id FROM projects
       WHERE org_id = ${orgId}
         AND (id = ${anyOf(declared)} OR slug = ${anyOf(declared)})
    `);
    return rows.map((r) => String(r.id));
  });
}
