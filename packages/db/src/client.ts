import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import * as schema from './schema/index.js';

/**
 * Database access.
 *
 * Two structural decisions from §15.6, both about resource isolation rather than correctness:
 *
 *  - Separate pools and DB roles for interactive versus batch traffic, "so a reindex storm
 *    cannot exhaust connections for chat".
 *  - A mandatory `statement_timeout` on the retrieval path. An unbounded query on the hot path
 *    stalls every assistant in the org.
 *
 * And one from §15.4, about safety: `withOrgContext` sets `app.org_id` inside the transaction,
 * because with PgBouncer transaction pooling a `SET` outside a transaction leaks tenant context
 * across pooled connections. RLS policies read that setting.
 */

export type Db = PostgresJsDatabase<typeof schema>;

export interface DbOptions {
  url: string;
  poolMax?: number;
  statementTimeoutMs?: number;
  applicationName?: string;
  /** Interactive traffic gets a short timeout; batch work legitimately runs long. */
  role: 'interactive' | 'batch' | 'migration';
  onNotice?: (notice: unknown) => void;
}

export interface DbHandle {
  db: Db;
  sql: postgres.Sql;
  close: () => Promise<void>;
  role: DbOptions['role'];
}

export function createDb(options: DbOptions): DbHandle {
  const statementTimeout =
    options.statementTimeoutMs ?? (options.role === 'interactive' ? 10_000 : 600_000);

  const client = postgres(options.url, {
    max: options.poolMax ?? (options.role === 'interactive' ? 10 : 4),
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    prepare: false, // Required for PgBouncer transaction pooling.
    connection: {
      application_name: options.applicationName ?? `kna-${options.role}`,
      statement_timeout: statementTimeout,
      // Bound the time a lock wait can hold a connection hostage during a reindex swap.
      lock_timeout: options.role === 'interactive' ? 3_000 : 30_000,
      idle_in_transaction_session_timeout: 60_000,
    },
    onnotice: options.onNotice ?? (() => undefined),
  });

  return {
    db: drizzle(client, { schema }),
    sql: client,
    role: options.role,
    close: async () => {
      await client.end({ timeout: 10 });
    },
  };
}

export class RlsIneffectiveError extends Error {
  constructor(role: string) {
    super(
      `Connected as '${role}', which bypasses row-level security.\n\n` +
        'A superuser, or any role with BYPASSRLS, ignores RLS entirely and silently: policies\n' +
        'exist, relrowsecurity is true, the invariant check passes, and every tenant can read\n' +
        'every other tenant. Nothing errors.\n\n' +
        'Connect as kna_interactive or kna_batch instead. RLS that is enabled and inert is\n' +
        'worse than no RLS, because it is believed.',
    );
    this.name = 'RlsIneffectiveError';
  }
}

/**
 * Assert that RLS actually applies to this connection.
 *
 * Called at startup by every service. §15.4 asks for forced RLS as defence in depth; this is
 * what makes the depth real rather than nominal, and it is deliberately fatal — a deployment
 * that silently lost tenant isolation should not start.
 */
export async function assertRlsEffective(handle: DbHandle): Promise<void> {
  const rows = await handle.sql<Array<{ effective: boolean; role: string }>>`
    SELECT kna_rls_is_effective() AS effective, current_user AS role
  `;
  const row = rows[0];
  if (!row?.effective) throw new RlsIneffectiveError(row?.role ?? 'unknown');
}

/**
 * Run work with tenant context set for RLS.
 *
 * The `SET LOCAL` must be inside the transaction — this is the PgBouncer hazard §15.4 names
 * explicitly. Outside a transaction the setting sticks to a pooled connection and the next
 * tenant to borrow it inherits the wrong context.
 */
export async function withOrgContext<T>(
  handle: DbHandle,
  orgId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    return fn(tx as unknown as Db);
  });
}

/**
 * Resolve a bearer token before there is a principal to scope by.
 *
 * The chicken-and-egg in §15.4's tenant isolation: `app.org_id` comes from the authenticated
 * principal, and authentication is what reads the token row. Setting no org means the isolation
 * policy hides the row; guessing an org means trusting the caller.
 *
 * So the transaction declares the token hash instead. Migration 0006 permits reading exactly the
 * row whose `token_hash` equals the declaration — a credential the caller demonstrably already
 * holds — and nothing else. `SET LOCAL` again, for the same PgBouncer reason as `withOrgContext`:
 * the declaration must die with the transaction, not linger on a pooled connection where the
 * next borrower would inherit the right to read someone else's token row.
 *
 * Everything after the lookup belongs in `withOrgContext` with the org the token resolved to.
 */
export async function withAuthProbe<T>(
  handle: DbHandle,
  tokenHash: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.auth_token_hash', ${tokenHash}, true)`);
    return fn(tx as unknown as Db);
  });
}

/**
 * Resolve a provider identity across tenants, before any org is known.
 *
 * The identity-webhook counterpart to `withAuthProbe`: a provider reports that a login left the
 * organisation, and §15.4 requires the revocation to land at once, but that login may map to
 * principals in several orgs. Migration 0008 permits reading principals whose `subject` matches
 * the declaration and nothing else.
 *
 * The guarantee is weaker than the token probe's, because a login is public where a token hash is
 * not. Callers must therefore be authenticated by other means first — the webhook route verifies
 * the provider's HMAC signature before it gets here. Do not reach for this from a path that has
 * not already established who is calling.
 */
export async function withIdentityProbe<T>(
  handle: DbHandle,
  subject: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.identity_subject', ${subject}, true)`);
    return fn(tx as unknown as Db);
  });
}

/**
 * Resolve a repository by its git remote, before any org is known.
 *
 * The webhook and CI-exchange counterpart to `withAuthProbe`. A provider event names a remote and
 * asks, in effect, "whose is this?" — so there is no tenant to scope by until the answer comes
 * back. Migration 0009 permits reading the repo row whose `remote` matches the declaration.
 *
 * As with `withIdentityProbe`, a remote is not a secret, so this narrows an already-authorised
 * caller's reach rather than authorising anything itself. Callers must have verified a webhook
 * signature or an OIDC token first.
 */
export async function withRepoProbe<T>(
  handle: DbHandle,
  remote: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.repo_remote', ${remote}, true)`);
    return fn(tx as unknown as Db);
  });
}

/**
 * Two paths deliberately run outside user context and need explicit org partitioning instead
 * (§15.4): the cross-repo resolution pass and the indexing workers. This wrapper makes that
 * choice visible at the call site rather than implicit in a missing `withOrgContext`.
 */
export async function withSystemContext<T>(
  handle: DbHandle,
  orgId: string,
  reason: 'indexing' | 'cross-repo-resolution' | 'maintenance',
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return handle.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.org_id', ${orgId}, true)`);
    await tx.execute(sql`SELECT set_config('app.system_context', ${reason}, true)`);
    return fn(tx as unknown as Db);
  });
}

/**
 * §15.6 — per-module advisory lock, which is what actually enforces "per-repo concurrency of 1"
 * now that we know stock BullMQ cannot. Taken as a transaction-scoped lock so it releases on
 * commit *or* crash: a worker that dies mid-reindex does not wedge the module forever.
 */
export async function withModuleLock<T>(
  handle: DbHandle,
  moduleId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return handle.db.transaction(async (tx) => {
    // hashtextextended gives a stable 64-bit key from the module id.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${moduleId}, 0))`);
    return fn(tx as unknown as Db);
  });
}

/** Non-blocking variant, for the "another worker already has it" fast path. */
export async function tryModuleLock<T>(
  handle: DbHandle,
  moduleId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false; result: null }> {
  return handle.db.transaction(async (tx) => {
    const rows = await tx.execute<{ locked: boolean }>(
      sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${moduleId}, 0)) AS locked`,
    );
    if (!rows[0]?.locked) return { acquired: false as const, result: null };
    return { acquired: true as const, result: await fn(tx as unknown as Db) };
  });
}

/**
 * Tune pgvector's search-time recall/latency trade-off for this transaction.
 * §15.5 — "tune pgvector `ef_search` against the eval set rather than defaulting it; that one
 * parameter usually buys more p99 than anything else."
 */
export async function setEfSearch(tx: Db, efSearch: number): Promise<void> {
  await tx.execute(sql`SET LOCAL hnsw.ef_search = ${sql.raw(String(Math.floor(efSearch)))}`);
}

export { schema, sql };
