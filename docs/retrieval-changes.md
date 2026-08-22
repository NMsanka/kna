# Retrieval change log

> **Authorship.** Entries are written by whoever made the change. The first was written by an
> LLM (Claude Opus 5) in the session that made it. See [Authorship and evidence](AUTHORSHIP.md).

Every change to a file that moves retrieval quality needs an entry here. CI enforces it:
`scripts/check-retrieval-config.mjs` fails when a watched file changes and this file does not.

**This is an interim control, and a weak one.** §15.5's actual requirement is a measured gate —
run the eval set before and after, and refuse a regression whose confidence interval excludes
zero. The harness for that exists in `packages/retrieval/src/eval` and is unit-tested; the runner
and the golden set do not exist yet. Until they do, the honest position is that a retrieval change
is reviewed by a human who writes down *why* it is safe, in public, next to the change.

An entry that says "small change, looks fine" is worth nothing. §15.5's point is precisely that
at n=100 the eval set resolves 5–8 point deltas while most real changes move 1–3, so "it looked
fine locally" was never evidence. State the mechanism by which the change cannot regress quality,
or state honestly that it might and why that is acceptable.

Newest first.

---

## 2026-08-21 — Bound the chunk size, and stamp the retrieval config version

**Files:** `packages/chunking/src/chunker.ts`, `packages/retrieval/src/store.ts`

**What changed.** Three things, only one of which alters what gets retrieved:

1. `chunkSymbols` now splits symbols whose content exceeds the token budget when no source text
   is present. Previously it emitted a single unbounded chunk in that case, which the embedding
   provider rejected outright at 8,192 tokens.
2. `retrievalConfigVersion` is written onto each chunk. It was accepted as an option and silently
   dropped, so the column held a literal `'v1'` for every row.
3. `store.ts` binds an array parameter through `sql.param` instead of passing it unwrapped. The
   previous form did not execute at all — Drizzle spread the array, and Postgres rejected it.

**Why this cannot regress retrieval quality.**

Changes 2 and 3 do not affect ranking. Change 3 is a query that previously threw; nothing about
scoring moves. Change 2 writes a column no query reads today.

Change 1 alters chunk boundaries, but only for symbols that were **not retrievable at all**
before it. A symbol over the budget produced one chunk, that chunk failed to embed, the failure
aborted the whole batch, and the batch failure aborted the module's index job. So the affected
symbols previously contributed nothing to the corpus — along with every other symbol in the same
module. The change moves them from absent to present, and leaves every chunk that already fitted
the budget byte-identical.

That is the argument, and it is a structural one rather than a measured one: the population whose
chunking changed is exactly the population that previously had no chunks. It does not depend on an
eval set to be true.

**What it does not establish.** Whether the *split* boundaries chosen for those newly-present
symbols are good ones. A symbol split at statement boundaries with a repeated header may retrieve
worse than the same symbol split some other way. Nothing here measures that, and nothing can until
the runner exists.

**Reviewed by:** pending — this entry is part of the pull request that introduces the mechanism.
