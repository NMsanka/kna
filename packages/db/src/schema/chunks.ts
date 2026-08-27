import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sensitivityTier } from './tenancy.js';

/**
 * Chunks and embeddings — the retrieval substrate.
 *
 * Three findings shape this table more than anything else.
 *
 * §11 "the dimension trap": pgvector's HNSW index caps at 2,000 dimensions for `vector`, and
 * `text-embedding-3-large` is 3,072 native. The column is `halfvec`, which indexes to 4,000
 * dimensions at half precision with negligible recall impact, and the default write path still
 * requests `dimensions: 1024`. Both escape hatches are therefore open without a migration.
 *
 * §8 "store the model name and version on every embedding row. Model upgrades are inevitable,
 * and without versioning you cannot do a shadow reindex or a gradual cutover."
 *
 * §15.5 "hash them into one `retrieval_config_version`, stamp it on every chunk and every query
 * trace" — without this, a chunking change and an embedding change are indistinguishable in
 * the eval history.
 */

/** pgvector's half-precision vector type — indexable to 4,000 dimensions. */
export const halfvec = (dimensions: number) =>
  customType<{ data: number[]; driverData: string; config: { dimensions: number } }>({
    dataType() {
      return `halfvec(${dimensions})`;
    },
    toDriver(value: number[]): string {
      return `[${value.join(',')}]`;
    },
    fromDriver(value: string): number[] {
      return value
        .slice(1, -1)
        .split(',')
        .map((v) => Number(v));
    },
  });

/** Matches EMBEDDING_DIMENSIONS. Changing it is an expand/contract migration, never an ALTER. */
export const EMBEDDING_DIMENSIONS = 1024;

const embeddingVector = halfvec(EMBEDDING_DIMENSIONS)('embedding', {
  dimensions: EMBEDDING_DIMENSIONS,
});

export const chunks = pgTable(
  'chunks',
  {
    id: text('id').primaryKey(),

    // ── Scope keys, denormalised. §4.3: "scoping then costs one indexed WHERE clause, not a
    //    join across three tables on the hot path." ──────────────────────────────────────────
    orgId: text('org_id').notNull(),
    repoId: text('repo_id').notNull(),
    moduleId: text('module_id'),
    projectIds: jsonb('project_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    versionId: text('version_id').notNull(),
    /** Vector namespace. Documentation and code are searched as separate ranked arms. */
    corpus: text('corpus').notNull().default('code'),

    symbolId: text('symbol_id'),
    /** Present for documentation chunks. Code chunks use symbolId instead. */
    documentId: text('document_id'),
    /** Ordinal within an oversized symbol that had to be split. */
    ordinal: integer('ordinal').notNull().default(0),

    /**
     * The text that was embedded, including the generated context header. Anthropic's
     * contextual retrieval: "the highest-ROI single improvement in this entire pipeline."
     */
    content: text('content').notNull(),
    /** Header alone, cached separately and keyed by signatureHash so it regenerates only on
     *  a real code change rather than on every index run. */
    contextHeader: text('context_header'),
    contentHash: text('content_hash').notNull(),
    tokenCount: integer('token_count').notNull().default(0),

    // ── Retrieval signals ────────────────────────────────────────────────────────────────────
    /** §15.5 — near-duplicate clustering, so one query cannot return eight byte-similar chunks
     *  from five repos and reduce effective top-8 to effective top-1. */
    simhash: text('simhash'),
    duplicateClusterId: text('duplicate_cluster_id'),
    /** True for the one representative served from a duplicate cluster. */
    isClusterRepresentative: boolean('is_cluster_representative').notNull().default(true),
    /** Machine-generated code is demoted, not excluded — it is still the right answer sometimes. */
    generated: boolean('generated').notNull().default(false),

    sensitivity: sensitivityTier('sensitivity').notNull().default('internal'),
    analysisDepth: text('analysis_depth').notNull().default('shallow'),

    sourcePath: text('source_path'),
    sourceUrl: text('source_url'),
    sourceStartLine: integer('source_start_line'),
    sourceEndLine: integer('source_end_line'),

    /** §15.5 — stamped on every chunk so a full index can sweep-delete non-matching rows. */
    indexedCommitSha: text('indexed_commit_sha').notNull(),
    retrievalConfigVersion: text('retrieval_config_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('chunks_identity_idx').on(t.orgId, t.symbolId, t.ordinal, t.versionId),
    // The hot-path filter: org + module + version, then everything else.
    index('chunks_scope_idx').on(t.orgId, t.moduleId, t.versionId),
    index('chunks_repo_idx').on(t.repoId, t.versionId),
    index('chunks_corpus_idx').on(t.orgId, t.corpus, t.sensitivity),
    // Stale-chunk garbage collection (§15.5): "serving deleted code as current is
    // indistinguishable from confabulation to the user."
    index('chunks_sweep_idx').on(t.moduleId, t.indexedCommitSha),
    index('chunks_cluster_idx').on(t.duplicateClusterId),
    index('chunks_config_version_idx').on(t.retrievalConfigVersion),
  ],
);

/**
 * Embeddings live in their own table, partitioned by model.
 *
 * §15.5 "embedding model migration needs a runbook, not just a version column... separate
 * partition per model, throttled backfill, a read path pinned to exactly one model per query."
 * Two embedding spaces are not comparable and must never be fused, so the read path selects a
 * model first and filters on it — it cannot accidentally mix.
 */
export const embeddings = pgTable(
  'embeddings',
  {
    chunkId: text('chunk_id').notNull(),
    orgId: text('org_id').notNull(),
    moduleId: text('module_id'),
    versionId: text('version_id').notNull(),
    /** Vector namespace. Documentation and code are searched as separate ranked arms. */
    corpus: text('corpus').notNull().default('code'),
    /** Identity of the space this vector lives in. Never nullable, never defaulted. */
    model: text('model').notNull(),
    dimensions: integer('dimensions').notNull(),
    embedding: embeddingVector,
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('embeddings_identity_idx').on(t.chunkId, t.model),
    index('embeddings_scope_idx').on(t.orgId, t.model, t.moduleId),
    index('embeddings_corpus_scope_idx').on(t.orgId, t.model, t.corpus, t.versionId),
  ],
);

/**
 * §15.6 — "add a content-hash-keyed embedding cache: vendored code and shared libraries
 * produce large volumes of byte-identical chunks across an org, and deduplicating them is the
 * cheapest cost lever available."
 */
export const embeddingCache = pgTable(
  'embedding_cache',
  {
    contentHash: text('content_hash').notNull(),
    model: text('model').notNull(),
    orgId: text('org_id').notNull(),
    embedding: halfvec(EMBEDDING_DIMENSIONS)('embedding', { dimensions: EMBEDDING_DIMENSIONS }),
    hits: integer('hits').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('embedding_cache_identity_idx').on(t.orgId, t.contentHash, t.model)],
);

/**
 * Context blurbs, cached by `signatureHash` (§8): "generate these blurbs once at index time
 * with a cheap model and cache them keyed by signatureHash — they only regenerate when the
 * code actually changes." This is what keeps the highest-volume LLM job in the system from
 * re-running on every push.
 */
export const contextBlurbs = pgTable(
  'context_blurbs',
  {
    orgId: text('org_id').notNull(),
    signatureHash: text('signature_hash').notNull(),
    moduleId: text('module_id').notNull(),
    blurb: text('blurb').notNull(),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('context_blurbs_identity_idx').on(t.orgId, t.signatureHash, t.promptVersion),
    index('context_blurbs_module_idx').on(t.moduleId),
  ],
);

/**
 * Published documentation, chunked separately.
 *
 * §10 Layer 4 — "the Documentation Assistant queries a physically distinct corpus view —
 * published docs and public modules, containing zero code chunks. This matters more than any
 * prompt engineering: a jailbreak or injection against that assistant cannot surface internal
 * content, because internal content was never in the candidate set to begin with."
 */
export const documents = pgTable(
  'documents',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    projectId: text('project_id'),
    repoId: text('repo_id'),
    moduleId: text('module_id'),
    versionId: text('version_id').notNull(),

    slug: text('slug').notNull(),
    title: text('title').notNull(),
    docType: text('doc_type').notNull(),
    /** Where it lives in the customer's own repo — the exit-cheap property (§15.8). */
    repoPath: text('repo_path'),
    sourceId: text('source_id'),
    sourceType: text('source_type').notNull().default('generated'),
    sourceInstanceId: text('source_instance_id'),
    externalId: text('external_id'),
    sourceRevision: text('source_revision'),
    canonicalUrl: text('canonical_url'),
    audience: text('audience').notNull().default('developer'),
    authority: text('authority').notNull().default('supporting'),
    accessPolicy: jsonb('access_policy')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    sourceMetadata: jsonb('source_metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    sourceUpdatedAt: timestamp('source_updated_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),

    /** Symbol ids this document was built from. Drives drift detection and "show me the
     *  source" links. §6 rule 2: every generated section records its provenance. */
    provenanceSymbolIds: jsonb('provenance_symbol_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Signature hashes at generation time, so staleness is a comparison not a guess. */
    provenanceSignatureHashes: jsonb('provenance_signature_hashes')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),

    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),

    visibility: text('visibility').notNull().default('internal'),
    sensitivity: sensitivityTier('sensitivity').notNull().default('internal'),

    /** §15.8 — surfaced on the page: "Owned by Team Billing, last verified 12 Aug 2026". */
    ownerTeam: text('owner_team'),
    lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }),
    lastVerifiedBy: text('last_verified_by'),

    /** Audit trail for §10 "provider posture": which model wrote this, in which region. */
    generatedByModel: text('generated_by_model'),
    generatedByProvider: text('generated_by_provider'),
    generatedInRegion: text('generated_in_region'),
    generatedAt: timestamp('generated_at', { withTimezone: true }),

    status: text('status').notNull().default('draft'),
    stalenessScore: real('staleness_score').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('documents_slug_idx').on(t.orgId, t.slug, t.versionId),
    index('documents_scope_idx').on(t.orgId, t.projectId, t.visibility),
    index('documents_staleness_idx').on(t.orgId, t.stalenessScore),
  ],
);

/** Configured documentation sources and their incremental synchronization checkpoint. */
export const documentSources = pgTable(
  'document_sources',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    sourceType: text('source_type').notNull(),
    instanceId: text('instance_id').notNull(),
    config: jsonb('config')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    cursor: text('cursor'),
    status: text('status').notNull().default('active'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('document_sources_identity_idx').on(t.orgId, t.sourceType, t.instanceId),
    index('document_sources_status_idx').on(t.orgId, t.status),
  ],
);

/** Explicit and inferred links from documents to repositories, projects, modules, and symbols. */
export const documentAssociations = pgTable(
  'document_associations',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    documentId: text('document_id').notNull(),
    repoId: text('repo_id'),
    projectId: text('project_id'),
    moduleId: text('module_id'),
    symbolId: text('symbol_id'),
    associationType: text('association_type').notNull(),
    confidence: real('confidence').notNull().default(1),
    createdBy: text('created_by').notNull().default('connector'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('document_associations_identity_idx').on(
      t.orgId,
      t.documentId,
      t.repoId,
      t.projectId,
      t.moduleId,
      t.symbolId,
      t.associationType,
    ),
    index('document_associations_repo_idx').on(t.orgId, t.repoId, t.documentId),
    index('document_associations_project_idx').on(t.orgId, t.projectId, t.documentId),
  ],
);
