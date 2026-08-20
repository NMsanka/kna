import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Audit, feedback, evaluation and job bookkeeping.
 *
 * §15.7 — "audit logs sit in the database they are meant to police." This table is the hot
 * write path; a separate shipper streams every row to an append-only, object-locked sink under
 * different credentials (see `apps/worker/src/jobs/audit-shipper.ts`). Rows here are the
 * queryable copy, not the authoritative one.
 */

export const auditEvents = pgTable(
  'audit_events',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    /** Hash chain over the previous row's hash — tamper-evidence inside the hot store too. */
    previousHash: text('previous_hash'),
    hash: text('hash').notNull(),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    actorSubject: text('actor_subject'),

    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    outcome: text('outcome').notNull().default('success'),

    /** §10 Layer 6 — "audit every retrieval: identity, query, returned chunk IDs, repos
     *  touched, timestamp. After an incident, this is the only thing that lets you answer
     *  'what was exposed?'" Chunk ids, never chunk text. */
    detail: jsonb('detail')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    reposTouched: jsonb('repos_touched')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    chunkIds: jsonb('chunk_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    traceId: text('trace_id'),
    llmTraceId: text('llm_trace_id'),
    sourceIp: text('source_ip'),
    userAgent: text('user_agent'),
    /** Set once the row has been durably shipped to the WORM sink. */
    shippedAt: timestamp('shipped_at', { withTimezone: true }),
  },
  (t) => [
    index('audit_events_org_time_idx').on(t.orgId, t.occurredAt),
    index('audit_events_actor_idx').on(t.orgId, t.actorId, t.occurredAt),
    index('audit_events_action_idx').on(t.orgId, t.action, t.occurredAt),
    index('audit_events_unshipped_idx').on(t.shippedAt),
  ],
);

/**
 * §15.4 — "legitimate insiders can exfiltrate the corpus through MCP undetected... alert on
 * **breadth** rather than volume — an engineer touching 40 repos in an hour is the signal."
 * Maintained as a rolling aggregate so the detector is a cheap read, not a scan of audit rows.
 */
export const accessBreadth = pgTable(
  'access_breadth',
  {
    orgId: text('org_id').notNull(),
    principalId: text('principal_id').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    distinctRepos: integer('distinct_repos').notNull().default(0),
    distinctModules: integer('distinct_modules').notNull().default(0),
    toolCalls: integer('tool_calls').notNull().default(0),
    surface: text('surface').notNull(),
    alerted: boolean('alerted').notNull().default(false),
  },
  (t) => [
    uniqueIndex('access_breadth_identity_idx').on(t.orgId, t.principalId, t.windowStart, t.surface),
    index('access_breadth_alert_idx').on(t.orgId, t.windowStart, t.alerted),
  ],
);

/**
 * §15.5 — "feedback capture has no trace and no triage taxonomy. A thumbs-down with only
 * (query, answer) is unactionable. Capture the full replayable trace."
 */
export const queryTraces = pgTable(
  'query_traces',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    principalId: text('principal_id'),
    sessionId: text('session_id'),
    surface: text('surface').notNull(),

    rawQuery: text('raw_query').notNull(),
    /** §15.5 multi-turn: the standalone rewrite is what actually hit retrieval. */
    rewrittenQuery: text('rewritten_query'),
    intentClass: text('intent_class'),
    scope: jsonb('scope')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    /** Per-arm candidates with ranks and scores, so a bad answer is replayable end to end. */
    denseCandidates: jsonb('dense_candidates')
      .$type<Array<{ chunkId: string; rank: number; score: number }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    lexicalCandidates: jsonb('lexical_candidates')
      .$type<Array<{ chunkId: string; rank: number; score: number }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    symbolCandidates: jsonb('symbol_candidates')
      .$type<Array<{ chunkId: string; rank: number; score: number }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    fusedCandidates: jsonb('fused_candidates')
      .$type<Array<{ chunkId: string; rank: number; score: number }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    rerankedCandidates: jsonb('reranked_candidates')
      .$type<Array<{ chunkId: string; rank: number; score: number }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** What actually survived context truncation — usually the difference that matters. */
    servedChunkIds: jsonb('served_chunk_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    expansionChunkIds: jsonb('expansion_chunk_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** Per-stage latency and token accounting (§15.5 context budget, §15.6 SLIs). */
    stageTimingsMs: jsonb('stage_timings_ms')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    stageTokens: jsonb('stage_tokens')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    topRerankScore: real('top_rerank_score'),
    abstained: boolean('abstained').notNull().default(false),
    abstentionReason: text('abstention_reason'),
    degradedModes: jsonb('degraded_modes')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    model: text('model'),
    promptVersion: text('prompt_version'),
    embeddingModel: text('embedding_model'),
    retrievalConfigVersion: text('retrieval_config_version').notNull(),

    traceId: text('trace_id'),
    llmTraceId: text('llm_trace_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('query_traces_org_time_idx').on(t.orgId, t.createdAt),
    index('query_traces_config_idx').on(t.retrievalConfigVersion, t.createdAt),
    index('query_traces_session_idx').on(t.sessionId),
  ],
);

export const feedback = pgTable(
  'feedback',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    queryTraceId: text('query_trace_id').notNull(),
    principalId: text('principal_id'),

    signal: text('signal').notNull(),
    /** §15.5 triage taxonomy. `knowledge-absent` is the bucket that becomes a docs backlog
     *  ticket — "the one this platform is uniquely able to close." */
    triage: text('triage'),
    comment: text('comment'),
    /** Implicit signals: explicit thumbs run 1–3% and will never give you volume. */
    implicit: boolean('implicit').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('feedback_org_time_idx').on(t.orgId, t.createdAt),
    index('feedback_triage_idx').on(t.orgId, t.triage),
    index('feedback_trace_idx').on(t.queryTraceId),
  ],
);

/**
 * §15.5 BLOCKER — "the eval set as specified is statistically underpowered... build 300+ items
 * stratified by intent class... and bind each gold item to symbol IDs so the nightly IR diff
 * can quarantine items whose targets were renamed or deleted."
 */
export const evalItems = pgTable(
  'eval_items',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    question: text('question').notNull(),
    /** exact-identifier | cross-repo-call-path | why-rationale | how-to-integrate | unanswerable */
    intentClass: text('intent_class').notNull(),
    scope: jsonb('scope')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    expectedSymbolIds: jsonb('expected_symbol_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    expectedChunkIds: jsonb('expected_chunk_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    expectedAnswer: text('expected_answer'),
    /** True for items where the correct behaviour is refusal. */
    unanswerable: boolean('unanswerable').notNull().default(false),

    /** Multi-turn items: prior turns, so single-turn eval cannot show green while multi-turn
     *  quality goes unmeasured (§15.5). */
    priorTurns: jsonb('prior_turns')
      .$type<Array<{ role: string; content: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    /** Quarantined when the nightly IR diff finds its target symbols renamed or deleted. */
    quarantined: boolean('quarantined').notNull().default(false),
    quarantineReason: text('quarantine_reason'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('eval_items_stratum_idx').on(t.orgId, t.intentClass, t.quarantined)],
);

export const evalRuns = pgTable(
  'eval_runs',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    retrievalConfigVersion: text('retrieval_config_version').notNull(),
    configSnapshot: jsonb('config_snapshot').$type<Record<string, unknown>>().notNull(),
    gitSha: text('git_sha'),
    /** Per-stratum metrics with confidence intervals — the CI gate reads these. */
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull(),
    itemCount: integer('item_count').notNull(),
    /** Set when this run was a shadow execution on sampled live traffic, not served. */
    shadow: boolean('shadow').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('eval_runs_config_idx').on(t.orgId, t.retrievalConfigVersion, t.createdAt)],
);

/**
 * Job bookkeeping.
 *
 * §15.6 — "per-repo concurrency of 1 is not achievable with stock BullMQ (group concurrency is
 * a Pro feature)... use a Postgres advisory lock keyed on moduleId, or buy Pro; decide now."
 * The decision here is the advisory lock, held in Postgres alongside the write it protects.
 * `moduleLocks` records who holds what, for operator visibility; the lock itself is a
 * `pg_advisory_xact_lock` taken inside the same transaction as the partition swap.
 */
export const moduleLocks = pgTable(
  'module_locks',
  {
    moduleId: text('module_id').primaryKey(),
    orgId: text('org_id').notNull(),
    lockedBy: text('locked_by').notNull(),
    jobId: text('job_id'),
    acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('module_locks_expiry_idx').on(t.expiresAt)],
);

/** §15.6 — "a real dead-letter queue with an operator drain/replay tool (BullMQ's `failed` set
 *  is not a DLQ)". Payloads are pointers into object storage, never the bundle itself. */
export const deadLetters = pgTable(
  'dead_letters',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    queue: text('queue').notNull(),
    jobName: text('job_name').notNull(),
    payloadRef: text('payload_ref'),
    payloadSummary: jsonb('payload_summary')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    attempts: integer('attempts').notNull(),
    lastError: text('last_error').notNull(),
    firstFailedAt: timestamp('first_failed_at', { withTimezone: true }).notNull(),
    lastFailedAt: timestamp('last_failed_at', { withTimezone: true }).notNull().defaultNow(),
    replayedAt: timestamp('replayed_at', { withTimezone: true }),
    replayedBy: text('replayed_by'),
  },
  (t) => [
    index('dead_letters_queue_idx').on(t.queue, t.lastFailedAt),
    index('dead_letters_unreplayed_idx').on(t.orgId, t.replayedAt),
  ],
);

/**
 * §15.8 — "no cost model, budget owner, or chargeback design. Nobody has computed cost per
 * repo per month across embeddings, blurbs, rerank, generation and chat."
 */
export const spendLedger = pgTable(
  'spend_ledger',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    repoId: text('repo_id'),
    projectId: text('project_id'),
    workload: text('workload').notNull(),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
    region: text('region'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedInputTokens: integer('cached_input_tokens').notNull().default(0),
    estimatedUsd: real('estimated_usd').notNull().default(0),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('spend_ledger_org_time_idx').on(t.orgId, t.occurredAt),
    index('spend_ledger_repo_idx').on(t.repoId, t.occurredAt),
    index('spend_ledger_workload_idx').on(t.orgId, t.workload, t.occurredAt),
  ],
);

/** §15.7 — deletion is a fan-out with an SLA across many stores, so it needs a tracked record. */
export const erasureRequests = pgTable(
  'erasure_requests',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    subjectType: text('subject_type').notNull(),
    subjectIdentifier: text('subject_identifier').notNull(),
    requestedBy: text('requested_by').notNull(),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    dueBy: timestamp('due_by', { withTimezone: true }).notNull(),
    /** Each downstream store reports completion separately; partial erasure is not erasure. */
    targets: jsonb('targets')
      .$type<Array<{ store: string; status: string; completedAt: string | null; note?: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    status: text('status').notNull().default('pending'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [index('erasure_requests_status_idx').on(t.orgId, t.status, t.dueBy)],
);
