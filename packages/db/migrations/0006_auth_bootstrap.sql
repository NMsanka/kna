-- Authentication is a bootstrap read, and org-isolation RLS cannot express it.
--
-- Every policy in 0002 is `org_id = kna_current_org()`, and `app.org_id` is set by
-- withOrgContext() from the *authenticated* principal's org. Resolving a bearer token is the one
-- read that happens before there is a principal, so there is no org to set — and the policy
-- correctly evaluated to false, hid every row, and the API answered "Unknown or expired token"
-- for tokens that existed, had not expired, and had not been revoked.
--
-- The behaviour was invisible for a long time because the ingest path authenticates with an
-- HMAC-signed envelope rather than a token row: publishing worked perfectly while every
-- principal-authenticated endpoint was unreachable.
--
-- The fix keeps the closed default and opens exactly one row. The caller declares, in the
-- transaction, the token hash it is resolving; the policy permits reading the row whose hash
-- matches that declaration and nothing else. The hash is the SHA-256 of the bearer token, so
-- being able to name it is equivalent to holding the credential — this grants the caller sight
-- of a secret it already possesses, and no enumeration: there is no `true` branch, no wildcard,
-- and a caller that sets nothing sees nothing.
--
-- The alternatives were worse. A BYPASSRLS role for authentication would hand the whole corpus
-- to the process most exposed to untrusted input. A SECURITY DEFINER function does not help,
-- because 0005 sets FORCE ROW LEVEL SECURITY and the owner is subject to its own policies.

CREATE OR REPLACE FUNCTION kna_auth_probe() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.auth_token_hash', true), '')
$$;

-- Permissive policies are OR-ed with the org-isolation policy from 0002, so tenant reads are
-- unchanged: this adds a second way to see a row, not a replacement for the first.
DROP POLICY IF EXISTS api_tokens_auth_bootstrap ON api_tokens;
CREATE POLICY api_tokens_auth_bootstrap ON api_tokens
  FOR SELECT USING (token_hash = kna_auth_probe());

DROP POLICY IF EXISTS mcp_tokens_auth_bootstrap ON mcp_tokens;
CREATE POLICY mcp_tokens_auth_bootstrap ON mcp_tokens
  FOR SELECT USING (token_hash = kna_auth_probe());

-- `last_used_at` is written on every authenticated request, and the write happens in the same
-- pre-principal transaction as the read. Scoped to the same single row.
DROP POLICY IF EXISTS api_tokens_auth_touch ON api_tokens;
CREATE POLICY api_tokens_auth_touch ON api_tokens
  FOR UPDATE USING (token_hash = kna_auth_probe())
  WITH CHECK (token_hash = kna_auth_probe());
