# Runbook: retrieval tuning

§15.5 is the longest section of the review for a reason: retrieval quality is where this
platform succeeds or quietly fails. This runbook is the order to try things in, and what each
change actually costs.

---

## Before changing anything

**Reproduce the failure from a trace.** §15.5 — a thumbs-down with only (query, answer) is
unactionable. The trace has the whole pipeline:

```sql
SELECT raw_query, rewritten_query, intent_class,
       jsonb_array_length(dense_candidates)   AS dense,
       jsonb_array_length(lexical_candidates) AS lexical,
       jsonb_array_length(symbol_candidates)  AS symbol,
       served_chunk_ids, expansion_chunk_ids,
       stage_timings_ms, stage_tokens, top_rerank_score, abstained
FROM query_traces WHERE id = $1;
```

Then triage it into one of §15.5's five buckets, because each has a different fix:

| Bucket | Signal in the trace | Fix |
|---|---|---|
| **Retrieval miss** | The right chunk is in no arm's candidates | Chunking, embedding, or the lexical arm |
| **Ranking miss** | It is in `fused_candidates` but not `served_chunk_ids` | Reranker, diversity, arm weights |
| **Context truncation** | It is in `reranked_candidates` but not served | Context budget, expansion fan-out |
| **Generation error** | Correct chunks served, wrong answer | Prompt, model |
| **Knowledge absent** | It is genuinely not in the corpus | **A documentation ticket, not a retrieval task** |

That last bucket is the one this platform is uniquely able to close. Tuning retrieval to find
something that does not exist is a long way to fail.

---

## In order of expected value

### 1. `ef_search`

§15.5 — *"that one parameter usually buys more p99 than anything else."* Free, instant,
reversible.

```bash
PGVECTOR_EF_SEARCH=200 pnpm eval --stratum exact-identifier
```

Higher means better recall and more latency. The knee is usually 100–200. Leaving it at the
default is leaving the cheapest improvement on the table.

### 2. Arm weights per intent

`ARM_WEIGHTS_BY_INTENT` in `packages/retrieval/src/query.ts`. §8's query routing: *"a cheap
classifier in front of retrieval measurably beats one-size-fits-all search."*

The weights are deliberately modest. An aggressive weight turns a routing mistake into a
retrieval failure rather than a slight reordering, and the classifier is not perfect.

### 3. The reranker

§11 names it *"one of the highest-value components in the pipeline"* and notes OpenAI has none.
If running RRF-only, measure the delta before deciding — §11's Phase 1 recommendation is to ship
without it and check.

```bash
pnpm eval --no-rerank --compare-baseline
```

The reranker also unlocks calibrated abstention: RRF scores are not comparable across queries,
so without it the refusal rule is structural rather than numeric, and necessarily blunter.

### 4. Diversity

`mmrLambda` and `maxPerModule`. §15.5 — generated clients, vendored directories and copy-pasted
DTOs mean one query can return eight byte-similar chunks and reduce effective top-8 to effective
top-1.

Check whether it is actually happening before tuning it:

```sql
SELECT duplicate_cluster_id, count(*), count(DISTINCT module_id) AS modules
FROM chunks WHERE org_id = $1 AND duplicate_cluster_id IS NOT NULL
GROUP BY 1 ORDER BY 2 DESC LIMIT 20;
```

### 5. Chunking

Requires a full reindex — `diffConfig` reports `requiresReindex`. Not free, and an eval against a
half-reindexed corpus means nothing.

Look at the token distribution first. Symbols hitting the split path are the ones to examine:

```sql
SELECT width_bucket(token_count, 0, 2000, 20) * 100 AS bucket, count(*)
FROM chunks WHERE org_id = $1 GROUP BY 1 ORDER BY 1;
```

### 6. The embedding model

The most expensive change available: a full backfill and roughly double the index RAM during
overlap. See [embedding-migration.md](embedding-migration.md).

§11 is honest that OpenAI embeddings are general-purpose while code retrieval is
identifier-heavy — but also that the hybrid design hedges, since the BM25 arm and exact symbol
lookup carry most of the identifier load. **Measure it rather than assuming it.**

---

## The lexical arm

§15.5 MEDIUM — *"`tsvector` is not BM25. `ts_rank` has no true corpus IDF, so the lexical arm is
weaker than assumed, and one dominant monorepo skews term statistics further."*

Two mitigations are already in place: the `simple` configuration (stemming actively harms
identifier matching — it turns `getUserByTenantId` into something that no longer matches itself),
and per-scope IDF precomputed nightly into `lexical_stats`.

If the lexical arm is still the ceiling, the documented next step is ParadeDB/`pg_search` for
real BM25. That is a second extension to operate, so measure the gap before taking it.

---

## Calibrating abstention

**This is model-specific and must be redone after any embedding or reranker change.** Reusing a
threshold across models means either refusing answerable questions or answering unanswerable
ones, and only one of those is visible in the metrics people watch.

```bash
pnpm eval --calibrate-abstention --stratum unanswerable
```

The trade-off, stated plainly: a lower threshold answers more questions and produces more
confidently-wrong ones. §16 prices the second — two bad answers loses a team permanently.

Target: false-answer rate on unanswerable questions under 10%, which is what the CI gate
enforces.

---

## What not to do

**Do not tune against a single failing query.** It is an anecdote. Add it to the eval set as an
item and tune against the set.

**Do not trust a non-significant improvement.** The report prints a confidence interval and the
minimum detectable effect for exactly this reason. At n=100 a set resolves 5–8 point deltas, and
most real changes move 1–3.

**Do not change two things at once.** `retrieval_config_version` hashes them into one value, so
the eval history cannot tell you which one moved the number.
