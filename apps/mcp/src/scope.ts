import { sql, type SQL } from 'drizzle-orm';
import { anyOf } from '@kna/db';
import type { RetrievalScope } from '@kna/retrieval';

/**
 * Narrow a symbol, module or service query to the caller's scope.
 *
 * §4.3 — "for the MCP server, infer scope from the client's working directory git remote —
 * when someone has `billing-api` open in Cursor, default to the Billing project. Expose scope
 * as an optional tool parameter so an agent can widen it deliberately."
 *
 * `buildAclPredicate` in @kna/retrieval already does this for the chunk-shaped tables, which
 * carry a `project_ids` column. These tables do not: project membership lives in
 * `module_projects`, so the project case has to be an EXISTS against that table rather than a
 * column test. The precedence — module, then repo, then project — is copied from
 * `buildAclPredicate` deliberately, so the two surfaces cannot come to disagree about what a
 * given scope means.
 *
 * This only ever *narrows*. Access is decided by the ACL predicate the caller has already
 * applied; scope is about relevance, and must never be able to widen what someone may read.
 */
export function scopeNarrowing(
  scope: RetrievalScope,
  column: { moduleId?: SQL; repoId: SQL },
): SQL {
  if (scope.moduleIds?.length && column.moduleId) {
    return sql` AND ${column.moduleId} = ${anyOf(scope.moduleIds)}`;
  }

  if (scope.repoIds?.length) {
    return sql` AND ${column.repoId} = ${anyOf(scope.repoIds)}`;
  }

  if (scope.projectIds?.length) {
    if (column.moduleId) {
      return sql` AND EXISTS (
        SELECT 1 FROM module_projects mp
         WHERE mp.module_id = ${column.moduleId}
           AND mp.project_id = ${anyOf(scope.projectIds)}
      )`;
    }

    // No module column to join through — narrow to repositories that have at least one module
    // in the project. Coarser than the module-level test, and the honest best available.
    return sql` AND ${column.repoId} IN (
      SELECT m.repo_id FROM modules m
        JOIN module_projects mp ON mp.module_id = m.id
       WHERE mp.project_id = ${anyOf(scope.projectIds)}
    )`;
  }

  // Org scope. Nothing to narrow — `resolveScope` reaches it only as a last resort, when no
  // project could be inferred and none was named.
  return sql``;
}
