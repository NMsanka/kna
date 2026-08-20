#!/usr/bin/env tsx
import { migrate } from '../src/migrate.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

migrate({ url, dryRun })
  .then((result) => {
    console.log(`\n${result.applied.length} applied, ${result.skipped.length} already current.`);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
