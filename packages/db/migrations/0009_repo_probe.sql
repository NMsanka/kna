-- Resolving a repository by its remote, before any org is known.
--
-- The third read that legitimately precedes a tenant scope, after the token lookup (0006) and
-- the identity webhook (0008). Two callers need it and neither can know the org first:
--
--   * A git webhook says "github.com/acme/billing was pushed". Working out which tenant owns
--     that remote is the whole question.
--   * CI presents an OIDC identity at /v1/auth/ci-exchange and asks for a credential for a
--     repository named by remote.
--
-- `resolveRepoForIdentity` did this read on a bare connection, so the org-isolation policy hid
-- every row and it returned null for every repository that exists. The effect was total and
-- silent: every push webhook answered "repo not registered" and did nothing, and the automatic
-- indexing path appeared to be wired up while never firing once.
--
-- Like the identity probe in 0008, and unlike the token probe in 0006, the declared value is not
-- itself a secret — a git remote is usually public. The probe is therefore not the
-- authorisation; it only narrows what an already-authorised caller may read. Both callers
-- authenticate first: the webhook route verifies the provider's HMAC signature over the raw body
-- before parsing it, and the exchange route verifies the OIDC token's issuer and signature. Do
-- not reach for this policy from a path that has not already established who is calling.
--
-- Scoped to SELECT, and to the columns a caller needs to route the event to a tenant.

CREATE OR REPLACE FUNCTION kna_repo_probe() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.repo_remote', true), '')
$$;

DROP POLICY IF EXISTS repos_remote_probe ON repos;
CREATE POLICY repos_remote_probe ON repos
  FOR SELECT USING (remote = kna_repo_probe());

GRANT EXECUTE ON FUNCTION kna_repo_probe() TO kna_interactive, kna_batch;
