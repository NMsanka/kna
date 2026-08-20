import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle generates the table DDL only. RLS, roles, grants, HNSW indexes and autovacuum tuning
 * live in hand-written SQL under `migrations/` — see `src/migrate.ts` for why.
 */
export default defineConfig({
  // The compiled output, not the source: drizzle-kit loads the schema through a CommonJS
  // require that cannot resolve the NodeNext `.js` specifiers the source uses. Run
  // `pnpm --filter @kna/db build` before generating.
  schema: './dist/schema/index.js',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/kna' },
  verbose: true,
  strict: true,
  migrations: { prefix: 'index' },
});
