import { z } from 'zod';
import { zAnalysisDepth, zEcosystem, zLanguage, zSensitivity } from './primitives.js';

/**
 * §4.3 — Module, not Repo, is the unit of project membership, and per §15.1 fix 3 it is also
 * the unit of reindex atomicity and concurrency. A monorepo swapped as one repo-level
 * transaction is a multi-hour lock; swapped per module it is a partition swap.
 */
export const zModule = z.object({
  id: z.string(),
  /** Logical key from moduleKey() — package identity where one exists, else repo path. */
  key: z.string(),
  orgId: z.string(),
  repoId: z.string(),
  projectIds: z.array(z.string()).default([]),

  path: z.string().describe("'packages/billing' | 'src/Acme.Billing.Api'"),
  name: z.string(),
  ecosystem: zEcosystem.default('none'),
  packageName: z.string().nullable().default(null),
  packageVersion: z.string().nullable().default(null),
  languages: z.array(zLanguage).default([]),

  /** Externally publishable vs internal-only. §15.7 — promotion to public is a reviewed event. */
  visibility: z.enum(['public', 'internal']).default('internal'),
  sensitivity: zSensitivity.default('internal'),

  analysisDepth: zAnalysisDepth.default('shallow'),
  /** Why the depth is what it is — surfaced in the "why is my repo shallow?" diagnostic. */
  analysisNotes: z.array(z.string()).default([]),

  /** CODEOWNERS-derived. §15.8 — a generated document needs an accountable owner. */
  owners: z.array(z.string()).default([]),

  symbolCount: z.number().int().nonnegative().default(0),
  fileCount: z.number().int().nonnegative().default(0),
  /** Declared dependencies, for the cross-repo package-dependency edge. */
  dependencies: z
    .array(
      z.object({
        name: z.string(),
        version: z.string().nullable(),
        dev: z.boolean().default(false),
      }),
    )
    .default([]),
});
export type IrModule = z.infer<typeof zModule>;

export const zRawModule = zModule.omit({
  id: true,
  key: true,
  orgId: true,
  repoId: true,
  projectIds: true,
  sensitivity: true,
});
export type RawModule = z.infer<typeof zRawModule>;
