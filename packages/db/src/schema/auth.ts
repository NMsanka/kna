import { sql } from 'drizzle-orm';
import {
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { orgs, principals } from './tenancy.js';

/**
 * Credentials.
 *
 * Every token is stored as a sha256 hash, never in plaintext. A database dump, a backup, or a
 * read replica must not hand over live credentials — and §15.7 makes backups a first-class
 * concern by requiring per-tenant keys for crypto-shredding.
 */

export const principalRoles = pgTable(
  'principal_roles',
  {
    principalId: text('principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    orgId: text('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    grantedBy: text('granted_by'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.principalId, t.role] }),
    index('principal_roles_org_idx').on(t.orgId),
  ],
);

/** Long-lived API tokens for the CLI and for service accounts. */
export const apiTokens = pgTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    principalId: text('principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    /** Shown in a connected-apps list, so a user can recognise what they are revoking. */
    name: text('name').notNull(),
    lastFourChars: text('last_four_chars').notNull(),
    scopes: jsonb('scopes')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('api_tokens_hash_idx').on(t.tokenHash),
    index('api_tokens_principal_idx').on(t.principalId),
  ],
);

/**
 * MCP access tokens.
 *
 * §15.4 BLOCKER — "the platform as an OAuth *resource server* with RFC 8707 resource indicators
 * and audience-bound tokens (otherwise a token minted for one IDE is replayable against any
 * other MCP server the user has connected — the confused deputy problem), mandatory PKCE,
 * Dynamic Client Registration gated by allowlist or approval, access-token TTL ≤15 minutes,
 * scopes narrower than the user's full permission set (default to the git-remote-inferred
 * project), and a user-visible connected-apps list with per-token revocation."
 *
 * Every clause in that sentence is a column here.
 */
export const mcpTokens = pgTable(
  'mcp_tokens',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    principalId: text('principal_id')
      .notNull()
      .references(() => principals.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),

    /** RFC 8707 resource indicator. Checked on every request; a mismatch is refused. */
    audience: text('audience').notNull(),
    /** Deliberately narrower than the principal's full permission set. */
    scopes: jsonb('scopes')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Project inferred from the client's working-directory git remote (§4.3). */
    inferredProjectId: text('inferred_project_id'),

    /** For the connected-apps list — a user cannot revoke what they cannot recognise. */
    clientId: text('client_id'),
    clientName: text('client_name'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** TTL <= 15 minutes; refresh re-evaluates permissions (§15.4). */
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedBy: text('revoked_by'),
  },
  (t) => [
    uniqueIndex('mcp_tokens_hash_idx').on(t.tokenHash),
    index('mcp_tokens_principal_idx').on(t.principalId, t.revokedAt),
    index('mcp_tokens_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * OAuth clients.
 *
 * §15.4 — "Dynamic Client Registration gated by allowlist or approval". DCR with no gate lets
 * anything on the network register itself as a client, which defeats the point of having
 * clients at all.
 */
export const oauthClients = pgTable(
  'oauth_clients',
  {
    clientId: text('client_id').primaryKey(),
    orgId: text('org_id').notNull(),
    name: text('name').notNull(),
    redirectUris: jsonb('redirect_uris')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** Registered dynamically but inert until approved. */
    status: text('status').notNull().default('pending'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    /** PKCE is mandatory; recorded so a client that stops using it is visible. */
    requiresPkce: text('requires_pkce').notNull().default('S256'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oauth_clients_org_status_idx').on(t.orgId, t.status)],
);

/** Partner API keys for the external Documentation Assistant. */
export const partnerKeys = pgTable(
  'partner_keys',
  {
    id: text('id').primaryKey(),
    orgId: text('org_id').notNull(),
    partnerName: text('partner_name').notNull(),
    keyHash: text('key_hash').notNull(),
    /** §15.7 — "scope partner keys to their contracted API version." */
    pinnedVersionId: text('pinned_version_id'),
    /** §10 Layer 6 — rate limit per key, and alert on enumeration patterns. */
    requestsPerHour: text('requests_per_hour').notNull().default('1000'),
    contactEmail: text('contact_email'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('partner_keys_hash_idx').on(t.keyHash),
    index('partner_keys_org_idx').on(t.orgId, t.revokedAt),
  ],
);
