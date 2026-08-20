import { z } from 'zod';

/**
 * Per-repo configuration (`kna.config.yaml` / `.knarc` / a `kna` key in package.json).
 *
 * §15.8 BLOCKER — "repo onboarding is the entire adoption funnel and is undefined... target
 * one command, under ten minutes, zero YAML for the default case." Every field here has a
 * defensible default, so a repo with no config file at all is fully onboardable. The file
 * exists for the teams who need to say something specific, not as a precondition.
 */

export const zSensitivityRule = z.object({
  /** Glob against repo-relative paths. */
  paths: z.array(z.string()).min(1),
  tier: z.enum(['public', 'internal', 'confidential', 'restricted']),
  reason: z.string().optional(),
});

export const zModuleConfig = z.object({
  path: z.string(),
  name: z.string().optional(),
  projects: z.array(z.string()).default([]),
  visibility: z.enum(['public', 'internal']).optional(),
  sensitivity: z.enum(['public', 'internal', 'confidential', 'restricted']).optional(),
  owners: z.array(z.string()).default([]),
});

export const zRepoConfig = z.object({
  /** Schema version of this config file, so the CLI can warn rather than silently misread. */
  version: z.literal(1).default(1),

  org: z.string().describe('Org slug; the CLI resolves it to an orgId at publish time'),

  /**
   * Projects this repo's modules belong to by default (§4.3: repo↔project is many-to-many and
   * module is what resolves it). A module may override.
   */
  projects: z.array(z.string()).default([]),

  modules: z.array(zModuleConfig).default([]),

  /** Additional ignore globs on top of .gitignore and the built-in denylist. */
  exclude: z.array(z.string()).default([]),
  /** Directories to index but treat with extra suspicion (§10 Layer 5). */
  vendored: z
    .array(z.string())
    .default(['**/node_modules/**', '**/vendor/**', '**/third_party/**', '**/packages/*/dist/**']),

  analysis: z
    .object({
      /** Skip Tier 1 even when the toolchain is present — for repos where it is too slow. */
      maxTier: z.enum(['tier0', 'tier1', 'tier2']).default('tier2'),
      /** Languages to analyse; empty means auto-detect. */
      languages: z.array(z.enum(['typescript', 'javascript', 'python', 'csharp'])).default([]),
      /** Where to find generated OpenAPI documents, if not auto-discoverable. */
      openapi: z.array(z.string()).default([]),
      /** Per-analyser subprocess timeout. A hung Roslyn run must not hang the pipeline. */
      timeoutMs: z.number().int().positive().default(600_000),
      /** Treat these as machine-generated and demote them in retrieval (§15.5). */
      generatedPatterns: z
        .array(z.string())
        .default([
          '**/*.g.cs',
          '**/*.designer.cs',
          '**/*_pb2.py',
          '**/*_pb2_grpc.py',
          '**/.openapi-generator/**',
          '**/generated/**',
          '**/*.generated.ts',
        ]),
    })
    .default({}),

  security: z
    .object({
      /**
       * §10 Layer 1 — raw source never leaves the machine by default. Turning this on is an
       * explicit, per-repo, opt-in decision, and the CLI records who made it and when.
       */
      uploadSource: z.boolean().default(false),
      uploadSourceApprovedBy: z.string().nullable().default(null),
      uploadSourceApprovedAt: z.string().nullable().default(null),

      defaultSensitivity: z
        .enum(['public', 'internal', 'confidential', 'restricted'])
        .default('internal'),
      sensitivityRules: z.array(zSensitivityRule).default([]),

      /** Extra secret-scanning patterns beyond the built-in ruleset. */
      extraSecretPatterns: z.array(z.string()).default([]),
      /**
       * Reviewed, justified suppressions. Each needs a reason — an unexplained allowlist entry
       * is how a real credential gets waved through six months later.
       */
      allowlist: z
        .array(z.object({ path: z.string(), rule: z.string(), reason: z.string() }))
        .default([]),
    })
    .default({}),

  docs: z
    .object({
      /** Where generated Markdown lands in this repo. Kept in-repo deliberately (§15.8 exit
       *  plan: "keep nothing that lives only in the platform's database"). */
      outputDir: z.string().default('docs/generated'),
      /** One PR per doc-affecting merge, or a rolling daily digest. Pick one, be consistent. */
      prStrategy: z.enum(['per-change', 'daily-digest', 'off']).default('daily-digest'),
      /** Regenerations safe to auto-merge — doc-comment-only and additions (§15.8). */
      autoMergeLowRisk: z.boolean().default(true),
      types: z
        .array(
          z.enum([
            'module-reference',
            'api-integration-guide',
            'architecture-overview',
            'release-notes',
            'onboarding',
            'design-doc',
          ]),
        )
        .default(['module-reference', 'api-integration-guide']),
    })
    .default({}),

  platform: z
    .object({
      url: z.string().url().default('http://localhost:8080'),
      /** Principal API token, for `ask` and `doctor`. */
      tokenEnv: z.string().default('KNA_TOKEN'),
      /**
       * Ingest credential, for `publish`. A different token entirely: short-lived, scoped to one
       * repository, and HMAC-signed rather than a principal identity. Sharing one variable
       * between the two meant a developer could authenticate one command or the other, never
       * both — and the failure looked like a permissions problem rather than a naming one.
       *
       * Never a static org secret in CI: see the OIDC exchange in the ingest client.
       */
      ingestTokenEnv: z.string().default('KNA_INGEST_TOKEN'),
    })
    .default({}),
});

export type RepoConfig = z.infer<typeof zRepoConfig>;
export type ModuleConfig = z.infer<typeof zModuleConfig>;
export type SensitivityRule = z.infer<typeof zSensitivityRule>;

/** The config a repo with no config file gets. Deliberately fully functional. */
export function defaultConfig(org = 'default'): RepoConfig {
  return zRepoConfig.parse({ org });
}
