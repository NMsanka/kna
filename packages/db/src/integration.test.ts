import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  assertRlsEffective,
  createDb,
  RlsIneffectiveError,
  tryModuleLock,
  withModuleLock,
  withAuthProbe,
  withIdentityProbe,
  withRepoProbe,
  withOrgContext,
  withSystemContext,
  type DbHandle,
} from './client.js';
import { anyOf } from './sql.js';

/**
 * Integration tests against a real Postgres.
 *
 * These exist because the two properties they check cannot be verified any other way. §15.4
 * calls a missing `WHERE` clause "a cross-tenant source-code breach" and prescribes forced RLS
 * as defence in depth — but RLS that is enabled and does not actually isolate is worse than no
 * RLS, because it is believed. And §15.6's per-module advisory lock is the thing standing in
 * for a queue guarantee BullMQ cannot give; if it does not serialise, the reindex path corrupts
 * state under exactly the conditions that are hardest to reproduce.
 *
 * Skipped when DATABASE_URL is unset, so the unit suite stays runnable with no infrastructure.
 */

/**
 * Two URLs, deliberately.
 *
 * `ADMIN_URL` is the owner/superuser connection used to set up and tear down fixtures.
 * `DATABASE_URL` is the *application* connection, as a non-superuser role — because a
 * superuser bypasses RLS silently, and testing isolation over a superuser connection proves
 * nothing at all. That is the exact misconfiguration migration 0005 exists to prevent.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const APP_URL =
  process.env.TEST_APP_DATABASE_URL ?? ADMIN_URL?.replace('//kna:kna@', '//kna_batch:devpass@');
const describeIf = ADMIN_URL && APP_URL ? describe : describe.skip;

describeIf('database integration', () => {
  let handle: DbHandle;
  let admin: DbHandle;

  beforeAll(async () => {
    admin = createDb({ url: ADMIN_URL!, role: 'migration', applicationName: 'kna-test-admin' });
    handle = createDb({ url: APP_URL!, role: 'batch', applicationName: 'kna-test' });

    await admin.sql`
      INSERT INTO orgs (id, slug, name) VALUES
        ('org_alpha', 'alpha', 'Alpha'),
        ('org_beta', 'beta', 'Beta')
      ON CONFLICT (id) DO NOTHING
    `;

    for (const [orgId, repoId] of [
      ['org_alpha', 'repo_alpha'],
      ['org_beta', 'repo_beta'],
    ]) {
      await admin.sql`
        INSERT INTO repos (id, org_id, remote, name)
        VALUES (${repoId}, ${orgId}, ${`github.com/${orgId}/x`}, 'x')
        ON CONFLICT (id) DO NOTHING
      `;
      await admin.sql`
        INSERT INTO modules (id, org_id, repo_id, key, path, name)
        VALUES (${`mod_${orgId}`}, ${orgId}, ${repoId}, ${`pkg:npm/${orgId}`}, 'src', 'x')
        ON CONFLICT (id) DO NOTHING
      `;
    }
  }, 60_000);

  afterAll(async () => {
    await admin.sql`DELETE FROM modules WHERE org_id IN ('org_alpha','org_beta')`;
    await admin.sql`DELETE FROM repos WHERE org_id IN ('org_alpha','org_beta')`;
    await admin.sql`DELETE FROM orgs WHERE id IN ('org_alpha','org_beta')`;
    await handle.close();
    await admin.close();
  });

  it('runs as a role that RLS actually applies to', async () => {
    // If this fails, every isolation assertion below is meaningless — which is precisely how
    // an inert RLS configuration survives into production.
    await expect(assertRlsEffective(handle)).resolves.toBeUndefined();
    await expect(assertRlsEffective(admin)).rejects.toThrow(RlsIneffectiveError);
  });

  describe('row-level security (§15.4)', () => {
    it('shows a tenant only its own rows', async () => {
      const alpha = await withOrgContext(handle, 'org_alpha', async (tx) =>
        tx.execute<{ id: string }>(sql`SELECT id FROM repos`),
      );
      const beta = await withOrgContext(handle, 'org_beta', async (tx) =>
        tx.execute<{ id: string }>(sql`SELECT id FROM repos`),
      );

      expect(alpha.map((r) => r.id)).toEqual(['repo_alpha']);
      expect(beta.map((r) => r.id)).toEqual(['repo_beta']);
    });

    it('hides another tenant even when the query names its id directly', async () => {
      // The case that matters: an application bug that forgets the org filter and passes an id
      // straight through from a request.
      const rows = await withOrgContext(handle, 'org_alpha', async (tx) =>
        tx.execute<{ id: string }>(sql`SELECT id FROM repos WHERE id = 'repo_beta'`),
      );
      expect(rows).toHaveLength(0);
    });

    it('refuses to write a row belonging to another tenant', async () => {
      // WITH CHECK, not just USING: a bug that writes the wrong org_id must fail loudly rather
      // than creating a row nobody can see.
      await expect(
        withOrgContext(handle, 'org_alpha', async (tx) =>
          tx.execute(sql`
            INSERT INTO repos (id, org_id, remote, name)
            VALUES ('repo_smuggled', 'org_beta', 'github.com/x/y', 'y')
          `),
        ),
      ).rejects.toThrow();
    });

    it('returns nothing at all when no tenant context is set', async () => {
      // Fails closed. An unset context must not mean "everything".
      const rows = await handle.sql<Array<{ id: string }>>`SELECT id FROM repos`;
      expect(rows).toHaveLength(0);
    });

    it('covers every org-scoped table', async () => {
      const unprotected = await admin.sql<Array<{ table_name: string }>>`
        SELECT * FROM kna_tables_without_rls()
      `;
      expect(unprotected.map((r) => r.table_name)).toEqual([]);
    });
  });

  describe('module advisory lock (§15.6)', () => {
    it('serialises two concurrent writers to the same module', async () => {
      const order: string[] = [];

      const first = withModuleLock(handle, 'mod_org_alpha', async () => {
        order.push('first:start');
        await new Promise((resolve) => setTimeout(resolve, 300));
        order.push('first:end');
      });

      // Started while the first holds the lock; must not interleave.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const second = withModuleLock(handle, 'mod_org_alpha', async () => {
        order.push('second:start');
        order.push('second:end');
      });

      await Promise.all([first, second]);

      expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
    }, 30_000);

    it('lets a second worker skip rather than block, when it asks to', async () => {
      let released: (() => void) | null = null;
      const holding = new Promise<void>((resolve) => {
        released = resolve;
      });

      const holder = withModuleLock(handle, 'mod_org_beta', async () => {
        await holding;
      });

      await new Promise((resolve) => setTimeout(resolve, 100));
      const attempt = await tryModuleLock(handle, 'mod_org_beta', async () => 'did work');

      expect(attempt.acquired).toBe(false);

      released!();
      await holder;
    }, 30_000);

    it('does not serialise different modules against each other', async () => {
      const started: string[] = [];

      await Promise.all([
        withModuleLock(handle, 'mod_org_alpha', async () => {
          started.push('alpha');
          await new Promise((resolve) => setTimeout(resolve, 200));
        }),
        withModuleLock(handle, 'mod_org_beta', async () => {
          started.push('beta');
          await new Promise((resolve) => setTimeout(resolve, 200));
        }),
      ]);

      // Both ran; the whole point of module-level rather than repo-level locking (§15.1 fix 3).
      expect(started.sort()).toEqual(['alpha', 'beta']);
    }, 30_000);
  });

  describe('privileges (§15.4)', () => {
    /**
     * Every table must be reachable by the roles that serve requests.
     *
     * 0005 established the roles with `ALTER DEFAULT PRIVILEGES`, which applies only to objects
     * created *after* it — and every table is created four migrations earlier. The roles could
     * log in, could see the schema, and had privileges on nothing. It went unnoticed because the
     * databases in use had accumulated the grants by other means; it appeared the first time the
     * suite ran against a database built from the migrations alone, which is precisely what a
     * first deployment is.
     *
     * Asserted over every table rather than a sample, because the failure is per-table: a single
     * table added by a future migration without grants breaks exactly one feature, at runtime,
     * with a permission error naming a table and no hint of why it differs from its neighbours.
     */
    it('grants the application roles access to every table', async () => {
      const rows = await admin.sql<Array<{ table_name: string; missing: string }>>`
        WITH tables AS (
          SELECT tablename AS table_name
            FROM pg_tables
           WHERE schemaname = 'public'
             -- The migration runner connects as the owner, so this one needs no grant.
             AND tablename <> 'kna_migrations'
        ),
        granted AS (
          SELECT table_name, grantee, array_agg(privilege_type) AS privs
            FROM information_schema.role_table_grants
           WHERE table_schema = 'public'
             AND grantee IN ('kna_interactive', 'kna_batch')
           GROUP BY table_name, grantee
        )
        SELECT t.table_name,
               concat_ws(', ',
                 CASE WHEN NOT EXISTS (
                   SELECT 1 FROM granted g
                    WHERE g.table_name = t.table_name
                      AND g.grantee = 'kna_interactive'
                      AND 'SELECT' = ANY(g.privs)
                 ) THEN 'kna_interactive:SELECT' END,
                 CASE WHEN NOT EXISTS (
                   SELECT 1 FROM granted g
                    WHERE g.table_name = t.table_name
                      AND g.grantee = 'kna_batch'
                      AND 'SELECT' = ANY(g.privs) AND 'INSERT' = ANY(g.privs)
                 ) THEN 'kna_batch:SELECT+INSERT' END
               ) AS missing
          FROM tables t
      `;

      const gaps = rows.filter((r) => r.missing !== '');
      expect(
        gaps.map((r) => `${r.table_name} missing ${r.missing}`),
        'tables the application roles cannot use',
      ).toEqual([]);
    });

    it('does not let the interactive role modify tenant data', async () => {
      // The narrow exception is append-only bookkeeping: audit_events, query_traces, feedback.
      // Anything beyond those three would mean the internet-facing role can alter the corpus.
      const rows = await admin.sql<Array<{ table_name: string }>>`
        SELECT DISTINCT table_name
          FROM information_schema.role_table_grants
         WHERE table_schema = 'public'
           AND grantee = 'kna_interactive'
           AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
           AND table_name NOT IN ('audit_events', 'query_traces', 'feedback')
      `;
      expect(rows.map((r) => r.table_name)).toEqual([]);
    });
  });

  describe('array parameters', () => {
    /**
     * Drizzle's `sql` template does not bind a JavaScript array as one parameter — it *spreads*
     * it, emitting one placeholder per element. `ANY(${ids})` therefore compiles to `ANY($1)` for
     * one id and `ANY($1, $2)` for two, and Postgres rejects both. Twenty-five call sites across
     * five packages were written the natural way and every one of them was wrong.
     *
     * The failure is invisible without a real database: the template reads exactly like the SQL
     * it was meant to be, and a mocked driver never notices. So it is pinned here.
     */
    it('binds an array as a single parameter, not one placeholder per element', async () => {
      for (const values of [['a'], ['a', 'b'], ['a', 'b', 'c']]) {
        const rows = await handle.db.execute<{ hit: boolean }>(
          sql`SELECT 'a' = ${anyOf(values)} AS hit`,
        );
        expect(rows[0]?.hit).toBe(true);
      }
    });

    it('treats an empty array as matching nothing rather than failing', async () => {
      const rows = await handle.db.execute<{ hit: boolean }>(sql`SELECT 'a' = ${anyOf([])} AS hit`);
      expect(rows[0]?.hit).toBe(false);
    });

    it('fails the way the bug did when the array is passed unwrapped', async () => {
      // Guards the fix rather than the symptom: if a future drizzle release starts binding arrays
      // as one parameter, this test fails and `anyOf` can be simplified away deliberately.
      await expect(
        handle.db.execute(sql`SELECT 'a' = ANY(${['a', 'b']}) AS hit`),
      ).rejects.toThrow();
    });
  });

  describe('authentication bootstrap (§15.4)', () => {
    /**
     * Resolving a bearer token happens before there is a principal, so there is no org to scope
     * by — and the org-isolation policy correctly hid every row, which made the API answer
     * "unknown or expired token" for tokens that existed and were valid. Migration 0006 opens
     * exactly the row whose hash the caller declares.
     */
    beforeAll(async () => {
      await admin.sql`
        INSERT INTO principals (id, org_id, subject, clearance)
        VALUES ('prin_alpha', 'org_alpha', 'alpha-user', 'internal')
        ON CONFLICT (id) DO NOTHING
      `;
      await admin.sql`
        INSERT INTO api_tokens (id, org_id, principal_id, token_hash, name, last_four_chars)
        VALUES ('tok_alpha', 'org_alpha', 'prin_alpha', 'hash_alpha', 'test', 'aaaa')
        ON CONFLICT (id) DO NOTHING
      `;
    });

    it('cannot see a token row without declaring which hash it is resolving', async () => {
      const rows = await handle.db.execute(
        sql`SELECT id FROM api_tokens WHERE token_hash = 'hash_alpha'`,
      );
      expect(rows).toHaveLength(0);
    });

    it('sees exactly the declared token row', async () => {
      const rows = await withAuthProbe(handle, 'hash_alpha', async (tx) =>
        tx.execute<{ org_id: string }>(sql`SELECT org_id FROM api_tokens`),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.org_id).toBe('org_alpha');
    });

    it('does not open the whole table to a caller that declares a wrong hash', async () => {
      const rows = await withAuthProbe(handle, 'hash_that_does_not_exist', async (tx) =>
        tx.execute(sql`SELECT id FROM api_tokens`),
      );
      expect(rows).toHaveLength(0);
    });

    it('drops the declaration when the transaction ends', async () => {
      // The PgBouncer hazard: a declaration that outlived its transaction would give the next
      // borrower of that pooled connection the right to read someone else's credential row.
      await withAuthProbe(handle, 'hash_alpha', async (tx) => tx.execute(sql`SELECT 1`));
      const rows = await handle.db.execute(sql`SELECT id FROM api_tokens`);
      expect(rows).toHaveLength(0);
    });

    it('resolves a provider identity across tenants only for the declared subject', async () => {
      const found = await withIdentityProbe(handle, 'alpha-user', async (tx) =>
        tx.execute<{ org_id: string }>(sql`SELECT org_id FROM principals`),
      );
      expect(found.map((r) => r.org_id)).toEqual(['org_alpha']);

      const none = await withIdentityProbe(handle, 'nobody', async (tx) =>
        tx.execute(sql`SELECT id FROM principals`),
      );
      expect(none).toHaveLength(0);
    });
  });

  describe('resolving a repository before the tenant is known (§7)', () => {
    /**
     * The third read that precedes a tenant scope, and the one whose absence was hardest to
     * see. A git webhook names a remote and asks which tenant owns it; an unscoped read answered
     * "nobody" for every repository that exists, so every push event was ignored as "repo not
     * registered" and automatic indexing never ran — while looking, from the outside, exactly
     * like a correctly wired integration with nothing to do.
     */
    it('cannot resolve a repo without declaring which remote it is looking for', async () => {
      const rows = await handle.db.execute(
        sql`SELECT id FROM repos WHERE remote = 'github.com/alpha/one'`,
      );
      expect(rows).toHaveLength(0);
    });

    it('resolves exactly the declared remote', async () => {
      await admin.sql`
        UPDATE repos SET remote = 'github.com/alpha/one' WHERE id = 'repo_alpha'
      `;

      const rows = await withRepoProbe(handle, 'github.com/alpha/one', async (tx) =>
        tx.execute<{ id: string; org_id: string }>(sql`SELECT id, org_id FROM repos`),
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.org_id).toBe('org_alpha');
    });

    it('does not open the table to a caller declaring an unknown remote', async () => {
      const rows = await withRepoProbe(handle, 'github.com/nobody/nothing', async (tx) =>
        tx.execute(sql`SELECT id FROM repos`),
      );
      expect(rows).toHaveLength(0);
    });

    it('drops the declaration when the transaction ends', async () => {
      await withRepoProbe(handle, 'github.com/alpha/one', async (tx) => tx.execute(sql`SELECT 1`));
      const rows = await handle.db.execute(sql`SELECT id FROM repos`);
      expect(rows).toHaveLength(0);
    });
  });

  describe('a ref that has moved', () => {
    // Regression. The version id is stable per `(repo, ref)` because the stale-chunk sweep is
    // scoped to `(module, version)`. The upsert that maintains it named the
    // `(repo_id, ref, commit_sha)` index as its conflict target, which does not fire when only
    // the sha changes — so a second commit on a branch collided with the primary key instead.
    //
    // Nothing offline could see it: the statement is valid SQL and the first insert of any ref
    // succeeds. It needs two commits on one ref against a real database, which is this test.
    it('moves the version forward instead of colliding on the primary key', async () => {
      const upsert = (sha: string) =>
        withSystemContext(handle, 'org_alpha', 'indexing', async (tx) => {
          await tx.execute(sql`
            INSERT INTO versions (id, org_id, repo_id, ref, kind, commit_sha, is_default)
            VALUES ('ver_moving', 'org_alpha', 'repo_alpha', 'release', 'branch', ${sha}, true)
            ON CONFLICT (id) DO UPDATE SET
              commit_sha = EXCLUDED.commit_sha,
              is_default = EXCLUDED.is_default
          `);
        });

      await upsert('a'.repeat(40));
      await upsert('b'.repeat(40));

      const rows = await withSystemContext(handle, 'org_alpha', 'indexing', (tx) =>
        tx.execute<{ commit_sha: string }>(
          sql`SELECT commit_sha FROM versions WHERE id = 'ver_moving'`,
        ),
      );

      // One row, at the newer commit — not two rows, and not an exception.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.commit_sha).toBe('b'.repeat(40));
    });
  });

  describe('pgvector', () => {
    it('stores and searches halfvec embeddings through the HNSW index', async () => {
      const dimensions = 1536;
      const vector = (seed: number) =>
        `[${Array.from({ length: dimensions }, (_, i) => ((i * seed) % 97) / 97).join(',')}]`;

      await withSystemContext(handle, 'org_alpha', 'indexing', async (tx) => {
        await tx.execute(sql`
          INSERT INTO versions (id, org_id, repo_id, ref, kind, commit_sha)
          VALUES ('ver_test', 'org_alpha', 'repo_alpha', 'main', 'branch', ${'a'.repeat(40)})
          ON CONFLICT DO NOTHING
        `);

        for (const [id, seed] of [
          ['chk_a', 3],
          ['chk_b', 7],
        ] as const) {
          await tx.execute(sql`
            INSERT INTO chunks (id, org_id, repo_id, module_id, version_id, content,
                                content_hash, indexed_commit_sha, retrieval_config_version)
            VALUES (${id}, 'org_alpha', 'repo_alpha', 'mod_org_alpha', 'ver_test',
                    ${`content ${id}`}, ${id}, ${'a'.repeat(40)}, 'test')
            ON CONFLICT DO NOTHING
          `);
          await tx.execute(sql`
            INSERT INTO embeddings (chunk_id, org_id, module_id, version_id, model, dimensions, embedding)
            VALUES (${id}, 'org_alpha', 'mod_org_alpha', 'ver_test', 'test-model', ${dimensions},
                    ${vector(seed)}::halfvec)
            ON CONFLICT DO NOTHING
          `);
        }
      });

      const results = await withOrgContext(handle, 'org_alpha', async (tx) =>
        tx.execute<{ chunk_id: string; distance: number }>(sql`
          SELECT chunk_id, (embedding <=> ${vector(3)}::halfvec) AS distance
          FROM embeddings
          WHERE org_id = 'org_alpha' AND model = 'test-model'
          ORDER BY embedding <=> ${vector(3)}::halfvec
          LIMIT 2
        `),
      );

      expect(results[0]?.chunk_id).toBe('chk_a');
      expect(Number(results[0]?.distance)).toBeLessThan(Number(results[1]?.distance));

      await admin.sql`DELETE FROM embeddings WHERE org_id = 'org_alpha'`;
      await admin.sql`DELETE FROM chunks WHERE org_id = 'org_alpha'`;
      await admin.sql`DELETE FROM versions WHERE org_id = 'org_alpha'`;
    }, 60_000);

    it('rejects a vector of the wrong dimensionality', async () => {
      // Dimension drift corrupts an index in a way that is hard to diagnose later, because
      // cosine distance still returns numbers. The column type is the last line of defence.
      await expect(handle.sql`SELECT ${'[1,2,3]'}::halfvec(1536)`).rejects.toThrow();
    });
  });
});
