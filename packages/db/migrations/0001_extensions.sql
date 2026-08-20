-- Extensions and database-level settings.
--
-- pg_trgm backs identifier fuzzy matching; pgvector backs the dense arm. `halfvec` requires
-- pgvector 0.7.0 or later, which is also where the 4,000-dimension index ceiling comes from
-- (§11, "the dimension trap").

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS btree_gin;

DO $$
DECLARE
  vector_version text;
BEGIN
  SELECT extversion INTO vector_version FROM pg_extension WHERE extname = 'vector';
  IF vector_version IS NULL OR string_to_array(vector_version, '.')::int[] < ARRAY[0,7,0] THEN
    RAISE EXCEPTION
      'pgvector % is too old: halfvec and the 4000-dimension index ceiling need >= 0.7.0. '
      'Without halfvec the only options are truncating embeddings to 2000 dimensions or '
      'running unindexed, which is not viable at corpus scale.', COALESCE(vector_version, 'absent');
  END IF;
END
$$;

-- Roles. §15.6 — "PgBouncer with separate pools and DB roles for interactive versus batch
-- traffic so a reindex storm cannot exhaust connections for chat."
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kna_interactive') THEN
    CREATE ROLE kna_interactive NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kna_batch') THEN
    CREATE ROLE kna_batch NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kna_audit_writer') THEN
    -- Audit rows are written under a role that cannot delete them (§15.7).
    CREATE ROLE kna_audit_writer NOLOGIN;
  END IF;
END
$$;
