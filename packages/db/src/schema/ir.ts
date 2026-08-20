import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { analysisDepth, languageEnum, modules, orgs, repos, sensitivityTier } from './tenancy.js';
import type {
  DocComment,
  Deprecation,
  HttpBinding,
  Parameter,
  SymbolEdges,
  TypeRef,
} from '@kna/ir';

/**
 * The IR, persisted.
 *
 * §15.1 fix 1 is the framing decision: "make the IR bundle store the system of record...
 * Postgres becomes an explicitly *derived cache*." Every table here can be rebuilt by replaying
 * bundles from object storage. Nothing in this file is the only copy of anything.
 */

/**
 * §4.3 "the version axis" — `(scopeKeys, version)` is the full addressing tuple. The column
 * exists from day one even though Phase 1 only ever writes `main`, because retrofitting it
 * means reindexing everything.
 */
export const versions = pgTable(
  'versions',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    ref: text('ref').notNull(),
    kind: text('kind').notNull(),
    commitSha: text('commit_sha').notNull(),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    /** The Documentation Assistant answers from tagged releases; the Dev Assistant from main. */
    isDefault: boolean('is_default').notNull().default(false),
    isPublished: boolean('is_published').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('versions_repo_ref_sha_idx').on(t.repoId, t.ref, t.commitSha),
    index('versions_default_idx').on(t.repoId, t.isDefault),
  ],
);

/** Immutable record of every bundle received. The pointer into the system of record. */
export const irBundles = pgTable(
  'ir_bundles',
  {
    bundleId: text('bundle_id').primaryKey(),
    orgId: text('org_id').notNull(),
    repoId: text('repo_id').notNull(),
    commitSha: text('commit_sha').notNull(),
    ref: text('ref').notNull(),
    irSchemaVersion: text('ir_schema_version').notNull(),
    producerName: text('producer_name').notNull(),
    producerVersion: text('producer_version').notNull(),
    environment: text('environment').notNull(),
    payloadHash: text('payload_hash').notNull(),
    payloadBytes: integer('payload_bytes').notNull(),
    /** Object-storage key. Postgres holds the pointer; the bundle itself lives in S3/MinIO. */
    storageKey: text('storage_key').notNull(),
    signatureAlgorithm: text('signature_algorithm').notNull(),
    signerClaims: jsonb('signer_claims').$type<Record<string, string | null>>(),
    /** §15.2 — single-use nonce. A replayed bundle is a no-op, enforced by this unique index. */
    nonce: text('nonce').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    /** Set when an N-2 upcast ran, so stale producers are visible in a dashboard. */
    upcastedFrom: text('upcasted_from'),
    scanReport: jsonb('scan_report').$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex('ir_bundles_nonce_idx').on(t.orgId, t.nonce),
    uniqueIndex('ir_bundles_commit_idx').on(t.orgId, t.repoId, t.commitSha, t.payloadHash),
    index('ir_bundles_repo_idx').on(t.repoId, t.receivedAt),
  ],
);

export const symbols = pgTable(
  'symbols',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    repoId: text('repo_id').notNull(),
    moduleId: text('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    versionId: text('version_id')
      .notNull()
      .references(() => versions.id, { onDelete: 'cascade' }),

    qualifiedName: text('qualified_name').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    language: languageEnum('language').notNull(),
    visibility: text('visibility').notNull(),

    signature: text('signature').notNull(),
    /** The trigger for the entire regeneration pipeline (§7). */
    signatureHash: text('signature_hash').notNull(),
    docHash: text('doc_hash'),
    bodyHash: text('body_hash'),

    parameters: jsonb('parameters')
      .$type<Parameter[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    returnType: jsonb('return_type').$type<TypeRef | null>(),
    typeParameters: jsonb('type_parameters')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    typeRefs: jsonb('type_refs')
      .$type<TypeRef[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    docComment: jsonb('doc_comment').$type<DocComment | null>(),
    deprecated: jsonb('deprecated').$type<Deprecation | null>(),
    modifiers: jsonb('modifiers')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    decorators: jsonb('decorators')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    edges: jsonb('edges').$type<SymbolEdges>().notNull(),
    httpBinding: jsonb('http_binding').$type<HttpBinding | null>(),

    parentId: text('parent_id'),
    sourcePath: text('source_path').notNull(),
    sourceStartLine: integer('source_start_line').notNull(),
    sourceEndLine: integer('source_end_line').notNull(),
    commitSha: text('commit_sha').notNull(),

    analysisDepth: analysisDepth('analysis_depth').notNull(),
    sensitivity: sensitivityTier('sensitivity').notNull().default('internal'),
    generated: boolean('generated').notNull().default(false),
    /** Present only when the repo opted in to snippet upload (§10 Layer 1). */
    sourceText: text('source_text'),

    /** §15.3 — lets a background migration find rows written under an older schema. */
    writtenByIrVersion: text('written_by_ir_version').notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('symbols_scope_idx').on(t.orgId, t.moduleId, t.versionId),
    // Exact-identifier lookup: the third retrieval arm in §8, and the one that matters most
    // when a developer types a symbol name verbatim.
    index('symbols_name_idx').on(t.orgId, t.name),
    index('symbols_qualified_name_idx').on(t.orgId, t.qualifiedName),
    index('symbols_signature_hash_idx').on(t.signatureHash),
    index('symbols_repo_version_idx').on(t.repoId, t.versionId),
    index('symbols_written_by_idx').on(t.writtenByIrVersion),
  ],
);

/**
 * §15.1 fix 2 — "add a symbol alias/redirect table alongside it".
 *
 * Symbol ids are not rename-stable in every case, and provenance links in published documents
 * must keep resolving after a rename. A read for a dead id follows the redirect rather than
 * 404ing and silently orphaning a documentation page.
 */
export const symbolAliases = pgTable(
  'symbol_aliases',
  {
    orgId: text('org_id').notNull(),
    previousId: text('previous_id').notNull(),
    currentId: text('current_id').notNull(),
    reason: text('reason').notNull().default('rename'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orgId, t.previousId] }),
    index('symbol_aliases_current_idx').on(t.currentId),
  ],
);

/**
 * Cross-repo edges, resolved by the dedicated pass after per-repo indexing (§4.3).
 *
 * §15.6 flags this pass as the real scaling wall, so edges carry a `pending` state: the
 * fallback publishes per-repo results with cross-repo edges marked pending rather than
 * blocking the whole project's freshness on one slow resolution.
 */
export const crossRepoEdges = pgTable(
  'cross_repo_edges',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    projectId: text('project_id').notNull(),
    fromSymbolId: text('from_symbol_id').notNull(),
    toSymbolId: text('to_symbol_id'),
    /** Set when the target is known by name but not yet resolvable to an id. */
    toQualifiedName: text('to_qualified_name'),
    kind: text('kind').notNull(),
    /** How the link was proven: package dependency, OpenAPI operationId, shared DTO shape, IaC. */
    evidence: text('evidence').notNull(),
    confidence: text('confidence').notNull().default('certain'),
    status: text('status').notNull().default('resolved'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('cross_repo_edges_from_idx').on(t.orgId, t.fromSymbolId),
    index('cross_repo_edges_to_idx').on(t.orgId, t.toSymbolId),
    index('cross_repo_edges_project_idx').on(t.projectId, t.status),
    uniqueIndex('cross_repo_edges_unique_idx').on(t.fromSymbolId, t.toSymbolId, t.kind),
  ],
);

export const apiSpecs = pgTable(
  'api_specs',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    repoId: text('repo_id').notNull(),
    moduleId: text('module_id').notNull(),
    versionId: text('version_id').notNull(),
    specId: text('spec_id').notNull(),
    title: text('title').notNull(),
    specVersion: text('spec_version').notNull(),
    format: text('format').notNull(),
    document: jsonb('document').notNull(),
    documentHash: text('document_hash').notNull(),
    sourcePath: text('source_path'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('api_specs_identity_idx').on(t.orgId, t.specId, t.specVersion, t.versionId),
    index('api_specs_module_idx').on(t.moduleId),
  ],
);

export const services = pgTable(
  'services',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    repoId: text('repo_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    moduleId: text('module_id'),
    image: text('image'),
    dependsOn: jsonb('depends_on')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    sourcePath: text('source_path').notNull(),
  },
  (t) => [index('services_org_name_idx').on(t.orgId, t.name)],
);
