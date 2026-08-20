-- Withdraw the UPDATE half of the auth bootstrap added in 0006, and grant the probe explicitly.
--
-- 0006 added an `api_tokens_auth_touch` policy so authentication could stamp `last_used_at`.
-- That was the wrong trade. 0005 gives `kna_interactive` — the role serving every request from
-- the internet — SELECT and nothing else, deliberately. Stamping last-used would have meant
-- granting that role UPDATE on the credential table itself, which is a strictly worse position
-- than not having the timestamp: it is the one table where a write primitive in the request path
-- is most useful to an attacker and least useful to us.
--
-- The policy is dropped rather than left dormant, because a policy that permits a write no role
-- can perform reads to a future maintainer as an invitation to add the missing grant.
--
-- Credential-usage telemetry belongs on the audit path (§10 Layer 6), which already has its own
-- writer role and does not run inside the request transaction.
--
-- Postgres also made the mistake self-punishing in a way worth recording: the failing UPDATE was
-- wrapped in a `.catch()` and still broke authentication outright, because a statement error
-- aborts the whole transaction and the subsequent COMMIT fails. There is no such thing as a
-- best-effort statement inside a transaction that must succeed.

DROP POLICY IF EXISTS api_tokens_auth_touch ON api_tokens;

-- Matching the explicit grants in 0005 rather than relying on the default EXECUTE to PUBLIC, so
-- that revoking PUBLIC later does not silently break authentication.
GRANT EXECUTE ON FUNCTION kna_auth_probe() TO kna_interactive, kna_batch;
