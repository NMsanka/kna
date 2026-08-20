import { z } from 'zod';
import { zIrBundle } from '@kna/ir';

/**
 * HTTP API contracts, shared by the CLI, the API, the MCP server and the web UI.
 *
 * §13 names the MCP tool surface a public API to external agents where "churn silently breaks
 * people's IDE integrations". The same is true of the ingest endpoint, which hundreds of
 * independently owned CI pipelines call and nobody can force-upgrade — so every request and
 * response shape lives here, versioned, rather than being implied by the handler that happens
 * to serve it.
 */

// ── Ingest ─────────────────────────────────────────────────────────────────────────────────

export const zIngestRequest = zIrBundle;
export type IngestRequest = z.infer<typeof zIngestRequest>;

export const zIngestResponse = z.object({
  accepted: z.boolean(),
  bundleId: z.string(),
  /** Object-storage key of the durably stored bundle — the system of record (§15.1). */
  storageKey: z.string().nullable(),
  /** Queued indexing jobs, one per module (§15.1 fix 3: module is the unit of atomicity). */
  jobIds: z.array(z.string()),
  /** Non-fatal notices, e.g. an N-2 upcast or a deprecated CLI version. */
  warnings: z.array(z.string()).default([]),
  /** Set when the magnitude circuit breaker halted fan-out (§15.3). */
  circuitBreaker: z
    .object({
      tripped: z.boolean(),
      rule: z.string().nullable(),
      reason: z.string().nullable(),
      requiresOperatorApproval: z.boolean(),
    })
    .nullable()
    .default(null),
  diff: z
    .object({
      added: z.number(),
      removed: z.number(),
      changed: z.number(),
      unchanged: z.number(),
      breaking: z.number(),
      reindexCount: z.number(),
      regenerateCount: z.number(),
    })
    .nullable()
    .default(null),
});
export type IngestResponse = z.infer<typeof zIngestResponse>;

/**
 * §15.2 — "mint the ingest credential via CI OIDC exchange scoped to one `repoId` for ~10
 * minutes, never a static org secret."
 */
export const zTokenExchangeRequest = z.object({
  /** OIDC ID token from the CI provider. */
  idToken: z.string().min(1),
  repoRemote: z.string().min(1),
  audience: z.string().default('kna-ingest'),
});

export const zTokenExchangeResponse = z.object({
  token: z.string(),
  expiresAt: z.string().datetime(),
  /** The single repo this token may publish for. */
  repoId: z.string(),
  orgId: z.string(),
});

// ── Retrieval and chat ─────────────────────────────────────────────────────────────────────

export const zScopeInput = z.object({
  kind: z.enum(['project', 'expanded', 'org', 'repo', 'module']).default('project'),
  projectIds: z.array(z.string()).optional(),
  repoIds: z.array(z.string()).optional(),
  moduleIds: z.array(z.string()).optional(),
  version: z.string().optional().describe("'main' | 'v2.1.0'"),
  languages: z.array(z.string()).optional(),
});

export const zSearchRequest = z.object({
  query: z.string().min(1).max(2000),
  scope: zScopeInput.default({ kind: 'project' }),
  topN: z.number().int().min(1).max(50).default(8),
  sessionId: z.string().optional(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string() }))
    .max(20)
    .optional(),
});
export type SearchRequest = z.infer<typeof zSearchRequest>;

export const zSearchHit = z.object({
  chunkId: z.string(),
  symbolId: z.string().nullable(),
  qualifiedName: z.string().nullable(),
  content: z.string(),
  score: z.number(),
  /** Provenance, always. §6 rule 2 — every claim traces to a symbol and a source location. */
  provenance: z.object({
    repoId: z.string(),
    moduleId: z.string(),
    path: z.string().nullable(),
    startLine: z.number().nullable(),
    endLine: z.number().nullable(),
    commitSha: z.string().nullable(),
  }),
  /** §5 — never let shallow output be presented with the confidence of semantic output. */
  analysisDepth: z.enum(['shallow', 'semantic', 'artifact']),
  viaExpansion: z.boolean().default(false),
  expansionRelation: z.string().nullable().default(null),
  alsoPresentInModules: z.array(z.string()).default([]),
});

export const zSearchResponse = z.object({
  hits: z.array(zSearchHit),
  abstained: z.boolean(),
  abstentionReason: z.string().nullable(),
  hedging: z.string().nullable(),
  intentClass: z.string(),
  rewrittenQuery: z.string().nullable(),
  /** §15.6 — degraded modes are a banner, not a 500. */
  degradedModes: z.array(z.string()).default([]),
  /** For feedback correlation. §15.5 — a thumbs-down needs a replayable trace. */
  traceId: z.string(),
  timings: z.record(z.string(), z.number()).default({}),
});
export type SearchResponse = z.infer<typeof zSearchResponse>;

export const zChatRequest = zSearchRequest.extend({
  stream: z.boolean().default(false),
  /** Which assistant. Determines corpus, not just prompt (§9, §10 Layer 4). */
  assistant: z.enum(['developer', 'documentation']).default('developer'),
});

export const zFeedbackRequest = z.object({
  traceId: z.string(),
  signal: z.enum(['up', 'down', 'copied', 'rephrased', 'abandoned']),
  triage: z
    .enum([
      'retrieval-miss',
      'ranking-miss',
      'context-truncation',
      'generation-error',
      'knowledge-absent',
    ])
    .optional(),
  comment: z.string().max(2000).optional(),
});

// ── Admin ──────────────────────────────────────────────────────────────────────────────────

export const zOnboardRepoRequest = z.object({
  remote: z.string().min(1),
  projectSlugs: z.array(z.string()).default([]),
  /** §15.8 — onboarding must be one command with zero YAML for the default case. */
  openPullRequest: z.boolean().default(true),
});

export const zBulkReviewDecision = z.object({
  repoId: z.string(),
  decision: z.enum(['approve', 'reject']),
  reason: z.string().min(1),
});

/** §15.7 — external publication is an explicit human-reviewed event with a diff. */
export const zPublishExternallyRequest = z.object({
  moduleIds: z.array(z.string()).min(1),
  approvedBy: z.string().min(1),
  acknowledgement: z.literal(
    'I have reviewed the symbols listed and confirm they may be visible to integration partners.',
  ),
});

/**
 * §15.1 — "reproducible evaluation, and cheap reindexing when the embedding model changes."
 *
 * That benefit is only real if something can actually ask for a reindex. Ingest deliberately
 * skips modules whose IR has not changed, and BullMQ keys job identity on `(moduleId, commitSha)`
 * so a republish of the same commit is a no-op — correct for webhooks, and a dead end when the
 * *platform* changed rather than the code: a new embedding model, new chunking parameters, a bug
 * fixed in the indexer. This endpoint is the deliberate override, and it carries a mandatory
 * reason because a reindex spends real money on a real provider.
 */
export const zReindexRequest = z
  .object({
    repoIds: z.array(z.string()).default([]),
    moduleIds: z.array(z.string()).default([]),
    reason: z.string().min(1),
  })
  .refine((v) => v.repoIds.length > 0 || v.moduleIds.length > 0, {
    message: 'Specify at least one repoId or moduleId. Reindexing an entire org is not implicit.',
  });

export const zReindexResponse = z.object({
  jobIds: z.array(z.string()),
  moduleCount: z.number().int().nonnegative(),
  skipped: z.array(z.object({ repoId: z.string(), reason: z.string() })),
});

export const zPublishExternallyPreview = z.object({
  moduleId: z.string(),
  moduleName: z.string(),
  /** "these 14 symbols become externally visible" */
  newlyVisibleSymbols: z.array(
    z.object({ symbolId: z.string(), qualifiedName: z.string(), kind: z.string() }),
  ),
  currentSensitivity: z.string(),
});

export const zHealthResponse = z.object({
  status: z.enum(['ok', 'degraded', 'not-ready']),
  version: z.string(),
  irSchemaVersion: z.string(),
  retrievalConfigVersion: z.string(),
  degradedModes: z.array(z.string()).default([]),
  dependencies: z
    .array(z.object({ name: z.string(), kind: z.string(), state: z.string() }))
    .default([]),
});

export const zErrorResponse = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Present when the caller can do something about it. */
    guidance: z.string().nullable().default(null),
    traceId: z.string().nullable().default(null),
  }),
});
export type ErrorResponse = z.infer<typeof zErrorResponse>;
