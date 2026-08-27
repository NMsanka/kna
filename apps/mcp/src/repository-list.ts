import { sql, type SQL } from 'drizzle-orm';
import { anyOf } from '@kna/db';

/**
 * Mandatory tenant and user-permission predicate for MCP repository discovery.
 *
 * Keep this separate and fail closed so a future edit cannot turn an empty permission set into
 * an unscoped repository listing. Active revocations have already been removed from
 * `permittedRepoIds` by the permission resolver.
 */
export function repositoryListPredicate(access: {
  orgId: string;
  permittedRepoIds: string[];
}): SQL {
  if (access.permittedRepoIds.length === 0) {
    throw new Error('Refusing to list repositories without a user permission set.');
  }

  return sql`r.org_id = ${access.orgId} AND r.id = ${anyOf(access.permittedRepoIds)}`;
}
