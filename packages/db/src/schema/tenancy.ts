import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Tenancy, scope and access control.
 *
 * §4.3 — "logically separated, physically shared". Everything lives in one store and every row
 * carries the scope keys needed to filter it, because the highest-value questions in this
 * platform are precisely the ones that cross a repo boundary.
 *
 * §15.4 adds row-level security as defence in depth: "a single missing WHERE clause is a
 * cross-tenant source-code breach". See `migrations/0002_rls.sql` — RLS is declared in SQL
 * because Drizzle cannot express `FORCE ROW LEVEL SECURITY`.
 */

export const sensitivityTier = pgEnum('sensitivity_tier', [
  'public',
  'internal',
  'confidential',
  'restricted',
]);

export const analysisDepth = pgEnum('analysis_depth', ['shallow', 'semantic', 'artifact']);

export const languageEnum = pgEnum('language', [
  'typescript',
  'javascript',
  'python',
  'csharp',
  'unknown',
]);

export const gitProvider = pgEnum('git_provider', [
  'github',
  'azuredevops',
  'gitlab',
  'bitbucket',
  'local',
]);

export const orgs = pgTable('orgs', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  /**
   * §15.7 — per-tenant encryption keys make backup-resident data crypto-shreddable, which is
   * the only workable answer to erasure across PITR snapshots. Stores a KMS key reference,
   * never key material.
   */
  kmsKeyRef: text('kms_key_ref'),
  /** §15.7 — region is pinned per tenant; cross-region provider fallback fails closed. */
  dataRegion: text('data_region').notNull().default('local'),
  dailySpendCeilingUsd: integer('daily_spend_ceiling_usd').notNull().default(500),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const projects = pgTable(
  'projects',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** §15.8 — a generated document needs an accountable owner, not just a PR assignee. */
    ownerTeam: text('owner_team'),
    /** §15.5 — repos join default scope only after passing a readiness gate. */
    readinessScore: integer('readiness_score').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('projects_org_slug_idx').on(t.orgId, t.slug)],
);

export const repos = pgTable(
  'repos',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    remote: text('remote').notNull(),
    name: text('name').notNull(),
    provider: gitProvider('provider').notNull().default('local'),
    defaultBranch: text('default_branch').notNull().default('main'),

    /** Last commit successfully indexed. Drives the nightly reconciliation sweep (§7). */
    lastIndexedSha: text('last_indexed_sha'),
    lastIndexedAt: timestamp('last_indexed_at', { withTimezone: true }),
    /** §7 "fail safe, not empty" — a failed run marks the repo stale and keeps the last index. */
    staleSinceSha: text('stale_since_sha'),
    staleReason: text('stale_reason'),

    /** §10 Layer 1 — snippet upload is an explicit, attributable, per-repo decision. */
    sourceUploadEnabled: boolean('source_upload_enabled').notNull().default(false),
    sourceUploadApprovedBy: text('source_upload_approved_by'),
    sourceUploadApprovedAt: timestamp('source_upload_approved_at', { withTimezone: true }),

    /** §15.3 — a repo halted by the magnitude circuit breaker awaits operator approval. */
    pendingBulkReview: boolean('pending_bulk_review').notNull().default(false),
    pendingBulkReviewReason: text('pending_bulk_review_reason'),

    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('repos_org_remote_idx').on(t.orgId, t.remote),
    index('repos_stale_idx').on(t.orgId, t.lastIndexedAt),
  ],
);

/**
 * Modules. §15.1 fix 3 — "make the module, not the repo, the unit of atomicity and
 * concurrency", so reindexing a monorepo is a series of partition swaps rather than one
 * multi-hour transaction that blocks every subsequent push.
 */
export const modules = pgTable(
  'modules',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    path: text('path').notNull(),
    name: text('name').notNull(),
    ecosystem: text('ecosystem').notNull().default('none'),
    packageName: text('package_name'),
    packageVersion: text('package_version'),
    languages: jsonb('languages')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    visibility: text('visibility').notNull().default('internal'),
    sensitivity: sensitivityTier('sensitivity').notNull().default('internal'),
    /** §15.7 — external publication is a reviewed event, recorded, not an inferred property. */
    externalPublicationApprovedBy: text('external_publication_approved_by'),
    externalPublicationApprovedAt: timestamp('external_publication_approved_at', {
      withTimezone: true,
    }),

    analysisDepth: analysisDepth('analysis_depth').notNull().default('shallow'),
    analysisNotes: jsonb('analysis_notes')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    owners: jsonb('owners')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    dependencies: jsonb('dependencies')
      .$type<Array<{ name: string; version: string | null; dev: boolean }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),

    symbolCount: integer('symbol_count').notNull().default(0),
    fileCount: integer('file_count').notNull().default(0),

    /** Commit whose index this module currently reflects. Enables the stale-chunk sweep. */
    indexedCommitSha: text('indexed_commit_sha'),
    indexedAt: timestamp('indexed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('modules_org_key_idx').on(t.orgId, t.key),
    index('modules_repo_idx').on(t.repoId),
    index('modules_sensitivity_idx').on(t.orgId, t.sensitivity),
  ],
);

/** Module ↔ project is many-to-many; §4.3 is explicit that repo↔project is not the join. */
export const moduleProjects = pgTable(
  'module_projects',
  {
    moduleId: text('module_id')
      .notNull()
      .references(() => modules.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    orgId: text('org_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.moduleId, t.projectId] }),
    index('module_projects_project_idx').on(t.projectId),
  ],
);

/**
 * ACL. §4.3 — "a hard filter in the query, derived from the caller's SSO identity mapped to
 * Git-provider repo permissions". §15.4 requires immediate invalidation on a permission
 * webhook, so revocations are a separate short-TTL deny list that takes precedence.
 */
export const principals = pgTable(
  'principals',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** SSO subject claim — the identity the ACL filter is derived from. */
    subject: text('subject').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    /** Highest sensitivity tier this principal may see. */
    clearance: sensitivityTier('clearance').notNull().default('internal'),
    isServiceAccount: boolean('is_service_account').notNull().default(false),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('principals_org_subject_idx').on(t.orgId, t.subject)],
);

export const repoPermissions = pgTable(
  'repo_permissions',
  {
    principalId: text('principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    repoId: text('repo_id')
      .notNull()
      .references(() => repos.id, { onDelete: 'cascade' }),
    orgId: text('org_id').notNull(),
    level: text('level').notNull().default('read'),
    /** When the Git provider last confirmed this. Staleness is a security signal. */
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.principalId, t.repoId] }),
    index('repo_permissions_repo_idx').on(t.repoId),
  ],
);

/**
 * §15.4 BLOCKER — "make revocations a short-TTL deny cache that takes precedence over the
 * positive cache". A row here beats any grant, for its TTL, regardless of what the periodic
 * sync last wrote.
 */
export const permissionRevocations = pgTable(
  'permission_revocations',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    principalId: text('principal_id').notNull(),
    /** Null means "all repos" — used on offboarding. */
    repoId: text('repo_id'),
    reason: text('reason').notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('permission_revocations_lookup_idx').on(t.orgId, t.principalId, t.expiresAt)],
);

export const orgRelations = relations(orgs, ({ many }) => ({
  projects: many(projects),
  repos: many(repos),
}));

export const repoRelations = relations(repos, ({ one, many }) => ({
  org: one(orgs, { fields: [repos.orgId], references: [orgs.id] }),
  modules: many(modules),
}));

export const moduleRelations = relations(modules, ({ one, many }) => ({
  repo: one(repos, { fields: [modules.repoId], references: [repos.id] }),
  projects: many(moduleProjects),
}));
