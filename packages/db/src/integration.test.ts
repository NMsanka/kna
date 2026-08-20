import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  assertRlsEffective,
  createDb,
  RlsIneffectiveError,
  tryModuleLock,
  withModuleLock,
  withOrgContext,
  withSystemContext,
  type DbHandle,
} from './client.js';

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
