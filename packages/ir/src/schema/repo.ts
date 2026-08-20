import { z } from 'zod';

export const zRepoRef = z.object({
  id: z.string(),
  orgId: z.string(),
  /** Canonical remote — see canonicalRemote(). */
  remote: z.string(),
  name: z.string(),
  defaultBranch: z.string().default('main'),
  provider: z.enum(['github', 'azuredevops', 'gitlab', 'bitbucket', 'local']).default('local'),
});
export type RepoRef = z.infer<typeof zRepoRef>;

/**
 * The version axis (§4.3). `(scopeKeys, version)` is the full addressing tuple on every chunk;
 * the column exists from day one even though Phase 1 only ever writes `main`, because
 * retrofitting it means reindexing everything.
 */
export const zVersionRef = z.object({
  ref: z.string().describe("'main' | 'v2.1.0' | 'release/2026-08'"),
  kind: z.enum(['branch', 'tag']),
  commitSha: z.string().regex(/^[0-9a-f]{7,40}$/),
  committedAt: z.string().datetime().nullable().default(null),
});
export type VersionRef = z.infer<typeof zVersionRef>;
