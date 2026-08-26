#!/usr/bin/env node
/**
 * Post-process generated migrations to unquote pgvector's parameterised types.
 *
 * Drizzle's `customType` emits whatever `dataType()` returns as a quoted identifier, so a
 * `halfvec(1024)` column is generated as `"halfvec(1024)"` — which Postgres reads as a type
 * literally named `halfvec(1024)`, and rejects. There is no way to express a parameterised
 * custom type in Drizzle that avoids this today.
 *
 * Rather than hand-editing every generated migration (and forgetting once), generation runs
 * this. It is idempotent and touches nothing else.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const QUOTED_VECTOR = /"(halfvec|vector|sparsevec)\((\d+)\)"/g;

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql'));
let patched = 0;

for (const file of files) {
  const path = join(migrationsDir, file);
  const original = await readFile(path, 'utf8');
  const fixed = original.replace(QUOTED_VECTOR, '$1($2)');
  if (fixed !== original) {
    await writeFile(path, fixed, 'utf8');
    console.log(`unquoted vector types in ${file}`);
    patched++;
  }
}

console.log(patched === 0 ? 'no vector type fixes needed' : `${patched} file(s) patched`);
