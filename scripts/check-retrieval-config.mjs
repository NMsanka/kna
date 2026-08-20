#!/usr/bin/env node
/**
 * Detect a change to anything that moves retrieval quality.
 *
 * §15.5 BLOCKER — "Nothing defines what a retrieval 'change' is, and there is no gate. Chunking
 * strategy, blurb prompt and model, embedding model, RRF constant, reranker, top-k,
 * graph-expansion depth and the system prompt all move quality independently."
 *
 * The eval is expensive, so it does not run on every pull request. It runs when this says the
 * retrieval configuration moved — which is the point at which "it looked fine locally" stops
 * being evidence.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const baseSha = process.argv[2];
if (!baseSha) {
  console.error('usage: check-retrieval-config.mjs <base-sha>');
  process.exit(1);
}

/** Every file whose contents feed `computeConfigVersion`, plus the prompts. */
const WATCHED = [
  'packages/retrieval/src/config-version.ts',
  'packages/retrieval/src/fusion.ts',
  'packages/retrieval/src/expansion.ts',
  'packages/retrieval/src/abstention.ts',
  'packages/retrieval/src/query.ts',
  'packages/retrieval/src/store.ts',
  'packages/retrieval/src/pipeline.ts',
  'packages/chunking/src/chunker.ts',
  'packages/chunking/src/blurb.ts',
  'packages/chunking/src/dedupe.ts',
];

const changed = execFileSync('git', ['diff', '--name-only', `${baseSha}...HEAD`], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean);

const hits = changed.filter((file) => WATCHED.includes(file));
const didChange = hits.length > 0;

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${didChange}\n`);
}

if (didChange) {
  console.log('Retrieval configuration changed:');
  for (const file of hits) console.log(`  ${file}`);
  console.log('\nThe eval gate will run.');
} else {
  console.log('No retrieval configuration change; skipping the eval gate.');
}
