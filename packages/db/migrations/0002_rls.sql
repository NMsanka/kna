-- Row-level security.
--
-- §15.4 HIGH — "a single missing `WHERE` clause is a cross-tenant source-code breach. Add
-- Postgres row-level security with `FORCE ROW LEVEL SECURITY` as defence in depth."
--
-- This is deliberately *not* the primary access control. The primary control is the ACL filter
-- applied in the query before scoring (§10 Layer 4). RLS exists so that a bug in that filter is
-- contained rather than catastrophic — the application should never rely on it, and should
-- never be able to notice it is there.
--
-- FORCE is essential: without it, the table owner bypasses the policy, and the migration role
-- is usually the owner.

-- Per-scope document frequencies, refreshed by the nightly maintenance job. This is the
-- "precompute IDF within scope" mitigation from §15.5: `ts_rank` has no true corpus IDF, and
-- one dominant monorepo skews term statistics for everyone else.
--
-- Declared here rather than alongside the search indexes because the grants below reference it,
-- and a grant on a table that does not exist yet fails the whole migration.
CREATE TABLE IF NOT EXISTS lexical_stats (
  org_id       text    NOT NULL,
  project_id   text    NOT NULL,
  term         text    NOT NULL,
  doc_freq     integer NOT NULL,
  total_docs   integer NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, project_id, term)
);

CREATE INDEX IF NOT EXISTS lexical_stats_refresh_idx ON lexical_stats (refreshed_at);

-- Helper: the org id for the current transaction, set by withOrgContext().
CREATE OR REPLACE FUNCTION kna_current_org() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')
$$;

DO $$
DECLARE
  target_table text;
  org_scoped_tables text[] := ARRAY[
    'projects', 'repos', 'modules', 'module_projects',
    'principals', 'repo_permissions', 'permission_revocations',
    'versions', 'ir_bundles', 'symbols', 'symbol_aliases', 'cross_repo_edges',
    'api_specs', 'services',
    'chunks', 'embeddings', 'embedding_cache', 'context_blurbs', 'documents',
    'audit_events', 'access_breadth', 'query_traces', 'feedback',
    'eval_items', 'eval_runs', 'module_locks', 'dead_letters', 'spend_ledger',
    'erasure_requests',
    'principal_roles', 'api_tokens', 'mcp_tokens', 'oauth_clients', 'partner_keys'
  ];
BEGIN
  FOREACH target_table IN ARRAY org_scoped_tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = target_table) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', target_table);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', target_table);

      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', target_table || '_org_isolation', target_table);
      EXECUTE format(
        'CREATE POLICY %I ON %I USING (org_id = kna_current_org()) WITH CHECK (org_id = kna_current_org())',
        target_table || '_org_isolation', target_table
      );
    END IF;
  END LOOP;
END
$$;

-- `orgs` itself is scoped on its own primary key rather than an org_id column.
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS orgs_self_isolation ON orgs;
CREATE POLICY orgs_self_isolation ON orgs
  USING (id = kna_current_org())
  WITH CHECK (id = kna_current_org());

-- Audit rows are append-only from the application's point of view. §15.7 — "ship audit events
-- to an append-only sink under separate credentials"; this makes the hot copy match that
-- posture rather than quietly diverging from it.
REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;
GRANT INSERT, SELECT ON audit_events TO kna_audit_writer;
GRANT INSERT, SELECT ON audit_events TO kna_interactive;

-- Interactive traffic never writes to the index and never reads raw bundles.
GRANT SELECT ON chunks, embeddings, symbols, documents, modules, repos, projects,
  versions, cross_repo_edges, api_specs, services, symbol_aliases TO kna_interactive;
GRANT SELECT, INSERT ON query_traces, feedback TO kna_interactive;
GRANT SELECT ON principals, repo_permissions, permission_revocations TO kna_interactive;

-- Batch traffic owns the write path.
GRANT SELECT, INSERT, UPDATE, DELETE ON chunks, embeddings, embedding_cache, context_blurbs,
  symbols, symbol_aliases, cross_repo_edges, api_specs, services, documents, modules,
  module_projects, versions, ir_bundles, module_locks, dead_letters, spend_ledger,
  access_breadth, lexical_stats TO kna_batch;
GRANT SELECT, UPDATE ON repos TO kna_batch;
GRANT SELECT ON projects, orgs, principals TO kna_batch;
GRANT INSERT, SELECT ON audit_events TO kna_batch;

-- A guard against the most likely way this protection gets silently disabled: a future
-- migration adding an org-scoped table without a policy. The nightly invariant check
-- (§15.5) calls this and alerts on a non-empty result.
CREATE OR REPLACE FUNCTION kna_tables_without_rls()
RETURNS TABLE (table_name text)
LANGUAGE sql STABLE AS $$
  SELECT c.relname::text
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN information_schema.columns col
    ON col.table_name = c.relname AND col.column_name = 'org_id'
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)
$$;
