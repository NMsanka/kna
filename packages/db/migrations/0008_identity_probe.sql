-- Two more reads that legitimately precede a tenant scope, and one that never did.
--
-- 0006 established the pattern: a read that must happen before `app.org_id` can be known declares
-- what it is resolving, and the policy permits exactly that. Two more reads need it.
--
-- 1. Role checks. `requireAdmin` read `principal_roles` on a bare connection, so RLS hid the row
--    and *every* admin route answered 403 to a genuine administrator. Unlike the token lookup the
--    org is known here, so this is scoped by org and does not need a probe — it needs the caller
--    to stop reading outside a transaction, which the application now does.
--
-- 2. Identity webhooks. A provider tells us "this login left the organisation"; §15.4 requires
--    that revocation land immediately, and a login can map to principals in more than one org, so
--    the lookup is genuinely cross-tenant. `subject` is a public GitHub login rather than a
--    256-bit secret, so unlike the token probe this does not carry its own proof — the request is
--    HMAC-verified against the provider's webhook secret before the query runs, and that
--    signature is the actual authorisation. The probe is narrow on purpose: SELECT only, and only
--    the identity columns needed to fan out revocations.
--
-- Recorded plainly because the guarantee is weaker than 0006's: an attacker who could set this
-- setting could enumerate principals by login. They cannot — only the application roles may set
-- it, and the only code path that does is behind signature verification — but a future caller
-- must know that before reaching for this policy.

CREATE OR REPLACE FUNCTION kna_identity_probe() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.identity_subject', true), '')
$$;

DROP POLICY IF EXISTS principals_identity_probe ON principals;
CREATE POLICY principals_identity_probe ON principals
  FOR SELECT USING (subject = kna_identity_probe());

GRANT EXECUTE ON FUNCTION kna_identity_probe() TO kna_interactive, kna_batch;
