import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/**
 * Migration runner.
 *
 * Deliberately hand-rolled rather than `drizzle-kit migrate`, for two reasons that both come
 * from §15.6's expand/contract discipline:
 *
 *  - Several migrations must run OUTSIDE a transaction. `CREATE INDEX CONCURRENTLY` is the
 *    whole point of the search-index migration — running it inside a transaction takes an
 *    ACCESS EXCLUSIVE lock and stalls every assistant query in the org — and Postgres refuses
 *    it in a transaction block anyway. Generated migrations wrap everything.
 *  - RLS, roles, grants and autovacuum tuning are not expressible in the ORM's schema, so they
 *    are first-class SQL files rather than an afterthought applied by hand in production.
 *
 * Drizzle still generates the table DDL (`pnpm db:generate`); this runner applies generated and
 * hand-written files in one ordered sequence.
 */

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', 'migrations');

/** Statements that Postgres refuses inside a transaction block. */
const NON_TRANSACTIONAL =
  /\bCREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b|\bREINDEX\s+CONCURRENTLY\b|\bDROP\s+INDEX\s+CONCURRENTLY\b|\bALTER\s+TYPE\s+\w+\s+ADD\s+VALUE\b/i;

export interface MigrateOptions {
  url: string;
  /** Print statements without executing them. */
  dryRun?: boolean;
  onLog?: (message: string) => void;
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(options: MigrateOptions): Promise<MigrationResult> {
  const log = options.onLog ?? ((m: string) => console.log(m));
  // Notices are expected in bulk here — DROP POLICY IF EXISTS and CREATE ... IF NOT EXISTS
  // both emit one per object — and printing hundreds of them buries the actual progress.
  const client = postgres(options.url, {
    max: 1,
    prepare: false,
    idle_timeout: 5,
    onnotice: () => undefined,
  });

  try {
    await client`
      CREATE TABLE IF NOT EXISTS kna_migrations (
        name        text PRIMARY KEY,
        checksum    text NOT NULL,
        applied_at  timestamptz NOT NULL DEFAULT now(),
        duration_ms integer NOT NULL DEFAULT 0
      )
    `;

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const alreadyApplied = new Map(
      (
        await client<
          { name: string; checksum: string }[]
        >`SELECT name, checksum FROM kna_migrations`
      ).map((r) => [r.name, r.checksum]),
    );

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const file of files) {
      const sqlText = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      const checksum = await sha256(sqlText);

      const prior = alreadyApplied.get(file);
      if (prior) {
        if (prior !== checksum) {
          // Editing an applied migration is how two environments silently diverge.
          throw new Error(
            `Migration ${file} has already been applied but its contents have changed.\n` +
              `Migrations are immutable once applied. Add a new migration instead.`,
          );
        }
        skipped.push(file);
        continue;
      }

      log(`applying ${file}`);
      if (options.dryRun) {
        applied.push(file);
        continue;
      }

      const started = Date.now();
      if (NON_TRANSACTIONAL.test(sqlText)) {
        // Statement by statement, no wrapping transaction. A partial failure here leaves the
        // earlier statements applied — which is correct for CONCURRENTLY, where the recovery
        // is to drop the invalid index and re-run rather than to roll back the whole file.
        log(`  (running outside a transaction: contains a CONCURRENTLY or ALTER TYPE statement)`);
        for (const statement of splitStatements(sqlText)) {
          await client.unsafe(statement);
        }
      } else {
        await client.begin(async (tx) => {
          await tx.unsafe(sqlText);
        });
      }

      const duration = Date.now() - started;
      await client`
        INSERT INTO kna_migrations (name, checksum, duration_ms)
        VALUES (${file}, ${checksum}, ${duration})
      `;
      log(`  applied in ${duration}ms`);
      applied.push(file);
    }

    return { applied, skipped };
  } finally {
    await client.end({ timeout: 5 });
  }
}

/**
 * Split on semicolons at the top level, respecting dollar-quoted blocks. Naive splitting
 * breaks every `DO $$ ... $$` block, and this schema has several.
 */
export function splitStatements(sqlText: string): string[] {
  const statements: string[] = [];
  let current = '';
  let dollarTag: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let inSingleQuote = false;

  for (let i = 0; i < sqlText.length; i++) {
    const ch = sqlText[i]!;
    const next = sqlText[i + 1];

    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      current += ch;
      if (ch === '*' && next === '/') {
        current += next;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (dollarTag) {
      current += ch;
      if (ch === '$' && sqlText.startsWith(dollarTag, i)) {
        current += sqlText.slice(i + 1, i + dollarTag.length);
        i += dollarTag.length - 1;
        dollarTag = null;
      }
      continue;
    }
    if (inSingleQuote) {
      current += ch;
      if (ch === "'" && next !== "'") inSingleQuote = false;
      else if (ch === "'" && next === "'") {
        current += next;
        i++;
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      current += ch;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      current += ch;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      current += ch;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sqlText.slice(i));
      if (tag) {
        dollarTag = tag[0];
        current += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
    }
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) statements.push(trimmed);
      current = '';
      continue;
    }

    current += ch;
  }

  const tail = current.trim();
  if (tail) statements.push(tail);
  return statements;
}

async function sha256(input: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
