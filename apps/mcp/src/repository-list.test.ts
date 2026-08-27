import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { repositoryListPredicate } from './repository-list.js';

const dialect = new PgDialect();

describe('repositoryListPredicate', () => {
  it('always restricts discovery by tenant and the current user permission set', () => {
    const rendered = dialect.sqlToQuery(
      repositoryListPredicate({
        orgId: 'org_alpha',
        permittedRepoIds: ['repo_allowed_a', 'repo_allowed_b'],
      }),
    );

    expect(rendered.sql).toContain('r.org_id = $1');
    expect(rendered.sql).toContain('r.id = ANY($2)');
    expect(rendered.params).toEqual(['org_alpha', ['repo_allowed_a', 'repo_allowed_b']]);
  });

  it('fails closed when the user has no repository grants', () => {
    expect(() => repositoryListPredicate({ orgId: 'org_alpha', permittedRepoIds: [] })).toThrow(
      'without a user permission set',
    );
  });
});
