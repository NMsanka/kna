-- Search indexes: the dense arm, the lexical arm, and the exact-identifier arm.
--
-- §8: "pure dense retrieval fails badly on code. When a developer asks 'what does
-- getUserByTenantId do', they want exact lexical matching on that identifier; embeddings will
-- happily return five semantically similar but wrong functions." Hybrid is mandatory, so all
-- three arms get first-class index support.

-- ── Dense arm ───────────────────────────────────────────────────────────────────────────────
-- HNSW on halfvec. m/ef_construction are the build-time recall/RAM trade-off; ef_search is set
-- per-transaction from the tuned value (§15.5).
--
-- CONCURRENTLY so a rebuild does not take an ACCESS EXCLUSIVE lock and stall every assistant
-- query in the org (§15.6, the expand/contract discipline).
CREATE INDEX CONCURRENTLY IF NOT EXISTS embeddings_hnsw_idx
  ON embeddings USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Vectors are never fused across models (§15.5), so the read path always filters on `model`
-- first. A composite btree makes that filter cheap before the HNSW scan.
CREATE INDEX IF NOT EXISTS embeddings_model_scope_idx
  ON embeddings (model, org_id, module_id);

-- ── Lexical arm ─────────────────────────────────────────────────────────────────────────────
-- §15.5 MEDIUM: "`tsvector` is not BM25. `ts_rank` has no true corpus IDF, so the lexical arm
-- is weaker than assumed, and one dominant monorepo skews term statistics further."
--
-- Two mitigations are in place here. First, `simple` rather than `english`: stemming actively
-- harms identifier matching, turning `getUserByTenantId` into something that no longer matches
-- itself. Second, per-scope IDF is precomputed in `lexical_stats` below, so ranking uses
-- statistics from the queried scope rather than from the whole corpus.
--
-- If the lexical arm proves to be the ceiling on quality, the documented next step is
-- ParadeDB/pg_search for real BM25 — see docs/runbooks/retrieval-tuning.md.
ALTER TABLE chunks
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED;

CREATE INDEX CONCURRENTLY IF NOT EXISTS chunks_content_tsv_idx
  ON chunks USING gin (content_tsv);

-- Identifiers are frequently queried as substrings (`TenantId`, `_pb2`), which tsvector cannot
-- match. Trigram covers that case.
CREATE INDEX CONCURRENTLY IF NOT EXISTS chunks_content_trgm_idx
  ON chunks USING gin (content gin_trgm_ops);

-- `lexical_stats` is created in 0002, before the grants that reference it.

-- ── Exact-identifier arm ────────────────────────────────────────────────────────────────────
-- Direct IR lookup, k=10 in §8's diagram. Case-insensitive because developers do not
-- consistently match casing when they type a name from memory.
CREATE INDEX CONCURRENTLY IF NOT EXISTS symbols_name_lower_idx
  ON symbols (org_id, lower(name));

CREATE INDEX CONCURRENTLY IF NOT EXISTS symbols_qualified_name_trgm_idx
  ON symbols USING gin (qualified_name gin_trgm_ops);

-- ── Autovacuum tuning for the high-churn vector tables ──────────────────────────────────────
-- §15.6 HIGH: "deletes leave tuples in the HNSW graph until vacuum; sustained churn degrades
-- recall *and* latency." The defaults are far too lax for a table that is rewritten on every
-- merge, so both thresholds are lowered aggressively.
ALTER TABLE embeddings SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 0,
  autovacuum_vacuum_insert_scale_factor = 0.05
);

ALTER TABLE chunks SET (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_delay = 0
);
