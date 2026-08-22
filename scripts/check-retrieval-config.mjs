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
 *
 * Until the eval runner exists, this enforces the weaker control the gate's own message already
 * promised and nothing implemented: a retrieval change must carry a written justification in
 * `docs/retrieval-changes.md`, in the same diff. That is not a measured gate and does not pretend
 * to be one. What it does is make the reasoning reviewable and refuse the silent case — because
 * as written, with no runner and no escape hatch, *no* retrieval change could ever merge, which
 * is not a gate but a wall.
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

/** Where the justification for a retrieval change has to be written. */
const CHANGE_LOG = 'docs/retrieval-changes.md';

const hits = changed.filter((file) => WATCHED.includes(file));
const didChange = hits.length > 0;
const justified = changed.includes(CHANGE_LOG);

if (process.env.GITHUB_OUTPUT) {
  // The eval gate runs only when the change is *unjustified*. A change with a written rationale
  // is allowed through with a warning, because the alternative — given no runner exists — is that
  // retrieval can never be changed at all.
  appendFileSync(process.env.GITHUB_OUTPUT, `changed=${didChange && !justified}\n`);
}

if (!didChange) {
  console.log('No retrieval configuration change; skipping the eval gate.');
  process.exit(0);
}

console.log('Retrieval configuration changed:');
for (const file of hits) console.log(`  ${file}`);

if (justified) {
  console.log(`\n${CHANGE_LOG} was updated in the same change.`);
  console.log('');
  console.log('Allowed through on a written justification rather than a measured result.');
  console.log('That is the interim control, and it is weaker than what §15.5 asks for: the');
  console.log('eval runner does not exist yet, so nothing here has been measured. A reviewer');
  console.log('should read the entry and decide whether the argument actually holds.');
} else {
  console.log(`\nNo entry in ${CHANGE_LOG}. The eval gate will run and fail.`);
}
