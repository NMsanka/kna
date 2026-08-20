-- Row-level security for `lexical_stats`.
--
-- Found by the invariant check in 0002 (`kna_tables_without_rls()`), which is exactly what it
-- exists for: `lexical_stats` is created in 0002 *after* the loop that applies policies, so it
-- carries an `org_id` column with no policy protecting it.
--
-- Fixed forward rather than by editing 0002, because the migration runner treats an applied
-- migration as immutable — editing one is how two environments silently diverge, and the
-- runner refuses to re-apply a file whose checksum has changed.
--
-- Per-scope term frequencies are not source code, but they are derived from it: term
-- distributions across a tenant's corpus reveal identifier vocabulary, which is enough to
-- infer what a codebase does. It gets the same isolation as anything else keyed by org.

ALTER TABLE lexical_stats ENABLE ROW LEVEL SECURITY;
ALTER TABLE lexical_stats FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS lexical_stats_org_isolation ON lexical_stats;
CREATE POLICY lexical_stats_org_isolation ON lexical_stats
  USING (org_id = kna_current_org())
  WITH CHECK (org_id = kna_current_org());

GRANT SELECT ON lexical_stats TO kna_interactive;
