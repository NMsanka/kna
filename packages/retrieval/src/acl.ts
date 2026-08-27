import { sql, type SQL } from 'drizzle-orm';
import { anyOf } from '@kna/db';
import type { AccessContext, RetrievalScope } from './types.js';

/**
 * The ACL filter.
 *
 * §10 Layer 4, verbatim on the two things that matter: applied "in the database query, before
 * scoring", and "never as a post-filter: filtering after ranking still leaks result counts and
 * relative scores for repos the user cannot read."
 *
 * So this module produces SQL predicates, not a JavaScript filter function. There is no code
 * path in this package that retrieves first and filters second, and `buildAclPredicate` is the
 * only way to reach the chunks table.
 */

const SENSITIVITY_ORDER = ['public', 'internal', 'confidential', 'restricted'] as const;

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessDeniedError';
  }
}

/**
 * Build the mandatory predicate. Throws rather than returning an empty filter when the caller
 * has no access at all — an empty predicate that accidentally means "everything" is exactly
 * the failure this design is guarding against.
 */
export function buildAclPredicate(access: AccessContext, scope: RetrievalScope): SQL {
  if (access.orgId !== scope.orgId) {
    throw new AccessDeniedError('Scope org does not match the caller identity.');
  }

  const clauses: SQL[] = [sql`c.org_id = ${access.orgId}`];

  if (access.corpus === 'external') {
    // §10 Layer 4 — the external corpus contains published documentation and `public` modules
    // and *zero code chunks*. This is the control that makes a jailbreak against the
    // Documentation Assistant harmless: internal content was never a candidate.
    clauses.push(sql`c.corpus IN ('docs', 'spec')`);
    clauses.push(sql`c.sensitivity = 'public'`);
    clauses.push(
      sql`c.module_id IN (
        SELECT id FROM modules
        WHERE org_id = ${access.orgId}
          AND visibility = 'public'
          AND external_publication_approved_at IS NOT NULL
      )`,
    );
    // Partner keys are scoped to their contracted API version (§15.7).
    if (access.pinnedVersionId) {
      clauses.push(sql`c.version_id = ${access.pinnedVersionId}`);
    }
  } else {
    if (access.permittedRepoIds.length === 0) {
      throw new AccessDeniedError(
        'Caller has no permitted repositories. Refusing to run an unscoped query.',
      );
    }
    // Existing documentation is independently indexed, but repo-linked documents inherit the
    // same repository grants. Connector-native ACLs fail closed until their identities have
    // been mapped; merely adding a connector can never make its pages readable by accident.
    clauses.push(sql`(
      (c.corpus <> 'docs' AND ${inArray('c.repo_id', access.permittedRepoIds)})
      OR
      (c.corpus = 'docs' AND ${inArray('c.repo_id', access.permittedRepoIds)} AND (
        c.document_id IS NULL OR EXISTS (
          SELECT 1 FROM documents d
          WHERE d.org_id = c.org_id AND d.id = c.document_id
            AND d.deleted_at IS NULL
            AND COALESCE(d.access_policy ->> 'mode', 'inherit-repositories')
                IN ('inherit-repositories', 'public')
        )
      ))
    )`);

    // §15.4 — revocations are a short-TTL deny list that takes precedence over any grant. A
    // permission removal must not wait for the next positive-cache refresh.
    if (access.deniedRepoIds?.length) {
      clauses.push(sql`NOT (${inArray('c.repo_id', access.deniedRepoIds)})`);
    }

    clauses.push(sql`c.sensitivity = ANY(${sql.raw(sensitivityArrayLiteral(access.clearance))})`);
  }

  // Scope narrowing, applied on top of the access filter — never instead of it.
  if (scope.moduleIds?.length) clauses.push(inArray('c.module_id', scope.moduleIds));
  else if (scope.repoIds?.length) clauses.push(inArray('c.repo_id', scope.repoIds));
  else if (scope.projectIds?.length) clauses.push(projectOverlap(scope.projectIds));

  if (scope.versionId) clauses.push(sql`c.version_id = ${scope.versionId}`);

  // Serve one representative per near-duplicate cluster (§15.5).
  clauses.push(sql`c.is_cluster_representative = true`);

  return clauses.reduce((acc, clause) => sql`${acc} AND ${clause}`);
}

/**
 * Clearance is a ceiling: a caller sees their tier and everything below it. `restricted` never
 * appears here at all, because §10 Layer 3 excludes it from the embedding pipeline — it is
 * reachable only by direct, audited symbol lookup.
 */
function sensitivityArrayLiteral(clearance: AccessContext['clearance']): string {
  const ceiling = SENSITIVITY_ORDER.indexOf(clearance);
  const allowed = SENSITIVITY_ORDER.slice(0, ceiling + 1).filter((t) => t !== 'restricted');
  return `ARRAY[${allowed.map((t) => `'${t}'`).join(',')}]::sensitivity_tier[]`;
}

function inArray(column: string, values: string[]): SQL {
  // Parameterised as a single array rather than N placeholders: a principal with 400 repo
  // permissions would otherwise blow past the bind-parameter limit.
  return sql`${sql.raw(column)} = ${anyOf(values)}`;
}

function projectOverlap(projectIds: string[]): SQL {
  // `sql.param` for the same reason as anyOf(): an unwrapped array is spread into one
  // placeholder per element, and `?|` then receives a bare text value instead of a text[].
  return sql`c.project_ids ?| ${sql.param([...projectIds])}`;
}

/**
 * §15.6 — "if you add a retrieval result cache, key it on the caller's **permission-set hash**,
 * never on query text alone, or you will serve one user's authorised results to another."
 */
export async function permissionSetHash(access: AccessContext): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256')
    .update(
      [
        access.orgId,
        access.corpus,
        access.clearance,
        access.pinnedVersionId ?? '',
        [...access.permittedRepoIds].sort().join(','),
        [...(access.deniedRepoIds ?? [])].sort().join(','),
      ].join('\n'),
    )
    .digest('hex')
    .slice(0, 32);
}

/**
 * Zero results after ACL filtering is ambiguous — nothing matched, or nothing was permitted.
 * The user-facing message must not distinguish them, or the assistant becomes an oracle for
 * "does repo X exist" (§15.7 on the external assistant, but the same applies internally to
 * confidential repos).
 */
export function uniformEmptyMessage(): string {
  return 'No results matched that query in the current scope.';
}
