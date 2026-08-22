-- Grant the application roles access to the tables that already existed when 0005 ran.
--
-- 0005 set up the login roles and their posture, and did it with `ALTER DEFAULT PRIVILEGES`:
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO kna_interactive;
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ... kna_batch;
--
-- Default privileges apply only to objects created *after* the statement runs. Every table in
-- this schema is created in 0001b, four migrations earlier, so none of them were covered. The
-- roles could log in, could see the schema, and had no privilege on a single table.
--
-- The omission looks like an oversight rather than a decision, because the sequence grant three
-- lines above it is written the other way — `GRANT USAGE, SELECT ON ALL SEQUENCES`, a one-time
-- grant over what exists. The tables needed both halves and got only one.
--
-- This never surfaced in development because the databases we had were not built solely by these
-- migrations; they had accumulated the grants some other way and carried on working. It surfaced
-- the first time the suite ran against a database created from nothing, which is also exactly
-- what a first production deployment is. The failure there would have been total and immediate:
-- every service starting cleanly, passing its startup assertions, and then returning "permission
-- denied" for the first query of any kind.
--
-- Both halves are stated explicitly below. `ALTER DEFAULT PRIVILEGES` is repeated rather than
-- assumed from 0005, so this migration alone describes the intended end state and a reader does
-- not have to hold two files in their head to work out what a role may do.

GRANT SELECT ON ALL TABLES IN SCHEMA public TO kna_interactive;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kna_batch;

-- Idempotent restatement of 0005's intent, so future tables keep inheriting the same posture.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO kna_interactive;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kna_batch;

-- Sequences were granted correctly in 0005, but only for what existed then. Same treatment, so a
-- sequence added by a later migration does not repeat this whole story.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kna_batch;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO kna_batch;

-- Note what is deliberately absent: any *new* write grant for `kna_interactive`.
--
-- A correction while this is in view. 0007's comment says 0005 gives that role "SELECT and
-- nothing else". That is the right principle and not quite the fact: 0002 grants it INSERT on
-- `audit_events`, `query_traces` and `feedback`. Those three are append-only records the request
-- path owes regardless of the caller, and they hold no tenant content — which is why they were
-- carved out and why the carve-out is narrow.
--
-- The rule the two migrations are actually expressing is: the internet-facing role may append to
-- its own trail, and may not modify anything else — no tenant data, and above all nothing in the
-- credential tables. 0007 refused `last_used_at` on `api_tokens` for exactly that reason.
-- Migrations are immutable, so the correction lands here rather than in 0007.
