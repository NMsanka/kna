# Runbook: embedding model migration

§15.5 HIGH — *"Embedding model migration needs a runbook, not just a version column. Two
embedding spaces are not comparable — you cannot fuse across them. Write it now."*

This is that runbook. It is written before it is needed, because §15.5 also notes what happens
otherwise: *"At 10M chunks this is days of backfill and roughly double the index RAM during
overlap — which should shape instance sizing in §8, not surface during the migration."*

---

## When this applies

Any change to `embeddingModel` or `embeddingDimensions` in the retrieval configuration.
`diffConfig()` flags it: `requiresBackfill: true`, and the CI gate refuses to treat an eval run
against a half-migrated corpus as meaningful.

A chunking change (`requiresReindex` without `requiresBackfill`) is a different, cheaper
operation — reindex only, no dual-write, no cutover.

---

## The property that dictates everything

**Vectors from two models are not comparable.** Cosine distance between them returns a number,
which is worse than an error: it silently produces plausible nonsense.

Every step below exists to guarantee that a single query touches exactly one embedding space.
The read path enforces it structurally — `denseSearch` joins on `e.model = $embeddingModel`, so
there is no code path that can mix them even by accident.

---

## Before you start

Estimate and write down three numbers. A migration begun without them is one that gets abandoned
halfway, leaving two partial indexes.

```bash
# Corpus size and the resulting backfill cost.
psql "$DATABASE_URL" -c "
  SELECT count(*) AS chunks,
         sum(token_count) AS tokens,
         pg_size_pretty(pg_total_relation_size('embeddings')) AS current_size
  FROM chunks;"
```

| Number | How to get it | Why |
|---|---|---|
| **Backfill cost** | `estimateIndexCost({ symbolCount, blurbMissRate: 0, embeddingCacheHitRate: 0 })` | Blurbs are cached by `signatureHash` and do not regenerate. Only embeddings do. |
| **Wall-clock** | tokens ÷ provider TPM limit on the **batch** key | The interactive key must not be used. §15.6: a backfill on the shared quota 429s chat. |
| **Peak index RAM** | current HNSW size × 2 | Both models' indexes coexist during overlap. If this does not fit, resize *first*. |

---

## 1. Prepare (no user-visible change)

Add the new model to the LiteLLM configuration. Do not change `EMBEDDING_MODEL` yet.

Confirm the dimension choice against pgvector's limits — §11's dimension trap:

- `vector` indexes to 2,000 dimensions. `halfvec` to 4,000.
- The column is already `halfvec`, so up to 4,000 is available without a schema change.
- Above 4,000, request truncation via the API (`dimensions:`). These models are
  Matryoshka-trained; truncation is graceful and halves index RAM.

`loadPlatformEnv()` refuses `EMBEDDING_DIMENSIONS > 2000` as a backstop against the
`vector`-typed case. Raise it deliberately, with the column type confirmed, or not at all.

---

## 2. Dual-write

Set `EMBEDDING_MODEL_SHADOW` on the worker. New chunks are embedded under both models; the read
path still uses only the current one.

Verify both are being written:

```bash
psql "$DATABASE_URL" -c "
  SELECT model, count(*), max(created_at)
  FROM embeddings GROUP BY model ORDER BY 2 DESC;"
```

---

## 3. Throttled backfill

```bash
node apps/worker/dist/backfill.js \
  --model voyage-code-4 \
  --dimensions 1024 \
  --rate-limit-tpm 500000 \
  --batch-size 96
```

**Throttled deliberately.** Saturating the provider's TPM limit 429s every other batch workload,
and §15.6's backpressure then pauses the queue — so an unthrottled backfill runs *slower* than a
throttled one while degrading everything else.

Progress:

```bash
psql "$DATABASE_URL" -c "
  SELECT (SELECT count(*) FROM embeddings WHERE model = 'voyage-code-4') AS done,
         (SELECT count(*) FROM chunks) AS total;"
```

Pause any time. It is idempotent — `ON CONFLICT (chunk_id, model)` — and resumes where it
stopped.

---

## 4. Compare, two ways

**Offline, on the golden set.** §15.5 requires per-stratum deltas with confidence intervals,
not a single number:

```bash
pnpm eval --embedding-model voyage-code-4 --compare-baseline
```

**Label-free, on replayed live queries.** §15.5: *"label-free comparison using the cross-encoder
as arbiter over replayed live queries."* This is the more informative half — the golden set is
what you thought to write down; live traffic is what people actually ask.

```bash
pnpm eval --shadow --sample 1000 --arbiter cross-encoder
```

**Do not cut over on a non-significant improvement.** A backfill plus double index RAM is a large
cost for a delta whose confidence interval straddles zero.

---

## 5. Percentage cutover, per project

Never org-wide at once.

```bash
node apps/api/dist/admin.js retrieval-cutover \
  --model voyage-code-4 --projects billing --percentage 10
```

Watch for two hours, then 50%, then 100%. The signals that matter:

- `kna.retrieval.abstentions` — a jump means the new space scores lower against the same
  calibrated threshold. **The threshold is model-specific and must be recalibrated**, not
  reused.
- `kna.retrieval.stage_ms{stage="dense"}` — a different model may have a different index shape.
- Thumbs-down rate and `feedback.triage = 'retrieval-miss'`.

---

## 6. Rollback

One flag, and it is instant because the old vectors are still there:

```bash
node apps/api/dist/admin.js retrieval-cutover --model text-embedding-3-large --percentage 100
```

**Do not delete the old embeddings for at least two weeks.** Deleting them converts a one-flag
rollback into another multi-day backfill, and the problems that justify a rollback usually
surface after the first week, not the first hour.

---

## 7. Retire

Only after two weeks at 100% with no regression:

```sql
-- Reclaims roughly half the index RAM. Take the vacuum into account: deleted tuples remain
-- traversable in the HNSW graph until it runs (§15.6), so recall is briefly affected by the
-- cleanup itself.
DELETE FROM embeddings WHERE model = 'text-embedding-3-large';
VACUUM ANALYZE embeddings;
REINDEX INDEX CONCURRENTLY embeddings_hnsw_idx;
```

`REINDEX CONCURRENTLY` wants roughly double the index memory and takes hours at multi-million-row
scale. Schedule it; do not run it at 09:00 on a Monday.

---

## What to update afterwards

- `DEFAULT_RETRIEVAL_CONFIG.embeddingModel` in `packages/retrieval/src/config-version.ts`.
- `ABSTENTION_THRESHOLD`, recalibrated against the unanswerable stratum. This is the step most
  likely to be forgotten, and skipping it means either refusing answerable questions or
  answering unanswerable ones.
- The subprocessor register, if the provider changed (§15.7).
- This runbook, with the actual numbers observed. The estimates above are estimates.
