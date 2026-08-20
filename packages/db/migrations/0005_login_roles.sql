-- Login roles, and the reason they are not optional.
--
-- §15.4 asks for `FORCE ROW LEVEL SECURITY` as defence in depth. FORCE makes the *table owner*
-- subject to its own policies — but a **superuser, or any role with BYPASSRLS, ignores RLS
-- entirely, silently**. Nothing errors. Policies exist, `relrowsecurity` is true, the invariant
-- check passes, and every row is visible to every tenant.
--
-- This was caught by the integration test in `src/integration.test.ts`, which is the only way
-- it can be caught: the configuration looks correct from every angle except the one that
-- matters. RLS that is enabled and inert is worse than no RLS, because it is believed.
--
-- So: applications connect as `kna_interactive` or `kna_batch`, which are NOINHERIT, NOSUPERUSER
-- and NOBYPASSRLS. `createDb` asserts this at startup and refuses to serve otherwise.
--
-- Passwords are set out of band (see deploy/postgres/bootstrap-roles.sh for local development,
-- and the KMS-sourced values in production). This migration only makes the roles capable of
-- logging in and grants them what they need.

ALTER ROLE kna_interactive WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE kna_batch       WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
ALTER ROLE kna_audit_writer WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

GRANT USAGE ON SCHEMA public TO kna_interactive, kna_batch, kna_audit_writer;

-- Sequences, for the tables that use them.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kna_batch;

-- The advisory-lock functions the worker relies on for per-module serialisation (§15.6).
GRANT EXECUTE ON FUNCTION pg_advisory_xact_lock(bigint) TO kna_batch;
GRANT EXECUTE ON FUNCTION pg_try_advisory_xact_lock(bigint) TO kna_batch;
GRANT EXECUTE ON FUNCTION pg_advisory_lock(bigint) TO kna_batch;
GRANT EXECUTE ON FUNCTION pg_advisory_unlock(bigint) TO kna_batch;
GRANT EXECUTE ON FUNCTION kna_current_org() TO kna_interactive, kna_batch;
GRANT EXECUTE ON FUNCTION kna_tables_without_rls() TO kna_interactive, kna_batch;

-- Future tables inherit the same posture, so a new table added by a later migration does not
-- quietly arrive with no grants and break the application at deploy time.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO kna_interactive;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kna_batch;

/**
 * Runtime assertion helper.
 *
 * Called by `createDb` at startup. Returns false when the current role would bypass RLS, which
 * is the misconfiguration this whole file exists to prevent.
 */
CREATE OR REPLACE FUNCTION kna_rls_is_effective() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NOT (rolsuper OR rolbypassrls)
  FROM pg_roles
  WHERE rolname = current_user
$$;

GRANT EXECUTE ON FUNCTION kna_rls_is_effective() TO PUBLIC;
