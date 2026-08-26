import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { scopeNarrowing } from './scope.js';
import type { RetrievalScope } from '@kna/retrieval';

const columns = { moduleId: sql`s.module_id`, repoId: sql`s.repo_id` };
const base = { orgId: 'org_alpha' } as const;

// Render through Drizzle's own dialect rather than walking the chunks by hand: the point of
// several of these assertions is what the driver will actually be handed.
const dialect = new PgDialect();
const render = (fragment: ReturnType<typeof scopeNarrowing>): string =>
  dialect.sqlToQuery(fragment).sql;

describe('scopeNarrowing', () => {
  it('narrows to the named repositories', () => {
    const scope: RetrievalScope = { ...base, kind: 'repo', repoIds: ['repo_a', 'repo_b'] };
    const rendered = render(scopeNarrowing(scope, columns));
    expect(rendered).toContain('s.repo_id');
    // anyOf() binds the array as a single parameter. A bare array in the template would be
    // spread into one placeholder per element, which Postgres rejects — see @kna/db.
    expect(rendered).toContain('ANY($1)');
  });

  it('prefers modules over repositories when both are present', () => {
    const scope: RetrievalScope = {
      ...base,
      kind: 'module',
      moduleIds: ['mod_a'],
      repoIds: ['repo_a'],
    };
    // Precedence copied from buildAclPredicate: module, then repo, then project.
    expect(render(scopeNarrowing(scope, columns))).toContain('s.module_id');
    expect(render(scopeNarrowing(scope, columns))).not.toContain('s.repo_id');
  });

  it('joins through module_projects for a project scope', () => {
    const scope: RetrievalScope = { ...base, kind: 'project', projectIds: ['prj_local'] };
    const rendered = render(scopeNarrowing(scope, columns));
    expect(rendered).toContain('module_projects');
    expect(rendered).toContain('s.module_id');
  });

  it('falls back to a repository test when there is no module column to join through', () => {
    // `services` has a nullable module_id, so a service row with none must still be reachable
    // by its repository rather than dropping out of the graph entirely.
    const scope: RetrievalScope = { ...base, kind: 'project', projectIds: ['prj_local'] };
    const rendered = render(scopeNarrowing(scope, { repoId: sql`sv.repo_id` }));
    expect(rendered).toContain('module_projects');
    expect(rendered).toContain('sv.repo_id');
  });

  // The important one. Org scope is what `resolveScope` returns when nothing could be
  // inferred, and adding a predicate there would silently hide rows the caller may read.
  it('adds nothing at org scope', () => {
    const scope: RetrievalScope = { ...base, kind: 'org' };
    expect(render(scopeNarrowing(scope, columns)).trim()).toBe('');
  });

  it('adds nothing when the scope names an empty list', () => {
    const scope: RetrievalScope = { ...base, kind: 'repo', repoIds: [] };
    expect(render(scopeNarrowing(scope, columns)).trim()).toBe('');
  });
});
