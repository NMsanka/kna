#!/usr/bin/env tsx
/**
 * Bootstrap a local development tenant.
 *
 * Nothing else creates the rows the platform needs before it can accept a single request: an
 * org, a project, a principal, an API token, and the repo permissions the ACL filter reads.
 * Without them every endpoint correctly refuses, which looks like a broken deployment rather
 * than an empty one.
 *
 * Idempotent — safe to re-run. Tokens are regenerated each time and printed once, because they
 * are stored hashed and cannot be recovered afterwards.
 *
 * **Development only.** It writes a known org, grants broad permissions, and prints
 * credentials to stdout. It refuses to run against `KNA_ENV=production`.
 */
import { randomBytes, createHash } from 'node:crypto';
import postgres from 'postgres';
import { createHmac } from 'node:crypto';
import { canonicalRemote, computeRepoId } from '@kna/ir';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

if (process.env.KNA_ENV === 'production') {
  console.error(
    'Refusing to seed a production database. This creates a known org with broad permissions\n' +
      'and prints credentials to stdout.',
  );
  process.exit(1);
}

/**
 * Must match the `org:` value in the repository's kna.config.yaml. The CLI treats that value as
 * the org id directly and asserts it in the bundle envelope; the ingest endpoint compares it
 * against the credential's claim and refuses a mismatch (§15.2). Overridable so a repo whose
 * config says something else can still be seeded.
 */
const ORG_ID = process.env.SEED_ORG_ID ?? 'org_local';
const ORG_SLUG = process.env.SEED_ORG ?? 'local';
const PROJECT_ID = 'prj_local';
const PROJECT_SLUG = process.env.SEED_PROJECT ?? 'platform';
const PRINCIPAL_ID = 'prin_local_dev';
const SUBJECT = process.env.SEED_SUBJECT ?? 'local-developer';

/** Which repositories this tenant may index. Defaults to the repo the seed is run from. */
const REPO_REMOTES = (process.env.SEED_REPOS ?? '')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);

const sql = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });

function token(prefix: string): { plain: string; hash: string; last4: string } {
  const plain = `${prefix}_${randomBytes(24).toString('base64url')}`;
  return {
    plain,
    hash: createHash('sha256').update(plain).digest('hex'),
    last4: plain.slice(-4),
  };
}

/**
 * Fixed ids with a configurable org is a trap the first two runs of this script fell into.
 *
 * `prj_local` and `prin_local_dev` are constants so the seed is idempotent, but `SEED_ORG_ID` is
 * not: re-seeding under a different org left those rows pointing at the *previous* org while the
 * freshly minted token pointed at the new one. Authentication then resolved the token, looked up
 * its principal inside the token's org, and found nothing — reported as "unknown or expired
 * token" for a token created seconds earlier.
 *
 * Every upsert below therefore reconciles `org_id` rather than leaving it at whatever the first
 * run happened to write.
 */
async function main(): Promise<void> {
  await sql`
    INSERT INTO orgs (id, slug, name, data_region)
    VALUES (${ORG_ID}, ${ORG_SLUG}, 'Local development', 'local')
    ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug
  `;

  await sql`
    INSERT INTO projects (id, org_id, slug, name, owner_team)
    VALUES (${PROJECT_ID}, ${ORG_ID}, ${PROJECT_SLUG}, 'Platform', 'local')
    ON CONFLICT (id) DO UPDATE SET slug = EXCLUDED.slug, org_id = EXCLUDED.org_id
  `;

  await sql`
    INSERT INTO principals (id, org_id, subject, email, display_name, clearance)
    VALUES (${PRINCIPAL_ID}, ${ORG_ID}, ${SUBJECT}, 'dev@localhost', 'Local developer', 'confidential')
    ON CONFLICT (id) DO UPDATE SET
      clearance = EXCLUDED.clearance, disabled_at = NULL, org_id = EXCLUDED.org_id
  `;

  await sql`
    INSERT INTO principal_roles (principal_id, org_id, role, granted_by)
    VALUES (${PRINCIPAL_ID}, ${ORG_ID}, 'admin', 'seed')
    ON CONFLICT (principal_id, role) DO UPDATE SET org_id = EXCLUDED.org_id
  `;

  // Repositories. Each needs a row before ingest will accept a bundle for it, because the
  // envelope verifier resolves the asserted repoId against a registered remote (§15.2).
  const repos: Array<{ id: string; remote: string }> = [];
  for (const remote of REPO_REMOTES) {
    const canonical = canonicalRemote(remote);
    const id = computeRepoId(ORG_ID, remote);
    repos.push({ id, remote: canonical });

    await sql`
      INSERT INTO repos (id, org_id, remote, name, provider, default_branch)
      VALUES (${id}, ${ORG_ID}, ${canonical}, ${canonical.split('/').pop() ?? canonical}, 'local', 'main')
      ON CONFLICT (org_id, remote) DO UPDATE SET name = EXCLUDED.name
    `;

    // The ACL filter reads this table on every query. A repo with no permission row is
    // invisible, which is correct behaviour and a confusing first experience.
    await sql`
      INSERT INTO repo_permissions (principal_id, repo_id, org_id, level)
      VALUES (${PRINCIPAL_ID}, ${id}, ${ORG_ID}, 'read')
      ON CONFLICT (principal_id, repo_id) DO UPDATE SET org_id = EXCLUDED.org_id
    `;
  }

  // Fresh tokens each run: they are stored hashed, so an existing one cannot be reprinted.
  const apiToken = token('kna');
  await sql`
    INSERT INTO api_tokens (id, org_id, principal_id, token_hash, name, last_four_chars, scopes)
    VALUES (
      ${`tok_${randomBytes(8).toString('hex')}`}, ${ORG_ID}, ${PRINCIPAL_ID},
      ${apiToken.hash}, 'local development', ${apiToken.last4},
      ${JSON.stringify(['kna:search', 'kna:symbols', 'kna:docs', 'kna:admin'])}::jsonb
    )
  `;

  // Ingest credentials, one per repository. Production mints these by OIDC exchange with a
  // ~10-minute life (§15.2); a local seed issues a long-lived one because there is no CI to
  // exchange an identity with, and the secret is a development constant anyway.
  const ingestSecret = process.env.INGEST_HMAC_SECRET ?? 'development-ingest-secret';
  const ingestTokens = repos.map((repo) => {
    const claims = {
      orgId: ORG_ID,
      repoId: repo.id,
      issuedAt: Date.now(),
      expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
      jti: randomBytes(16).toString('hex'),
    };
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const signature = createHmac('sha256', ingestSecret).update(payload).digest('base64url');
    return { remote: repo.remote, token: `${payload}.${signature}` };
  });

  const mcpToken = token('mcp');
  await sql`
    INSERT INTO mcp_tokens (
      id, org_id, principal_id, token_hash, audience, scopes, inferred_project_id,
      client_name, expires_at
    ) VALUES (
      ${`mcp_${randomBytes(8).toString('hex')}`}, ${ORG_ID}, ${PRINCIPAL_ID}, ${mcpToken.hash},
      'https://mcp.kna.internal',
      ${JSON.stringify(['kna:search', 'kna:symbols', 'kna:docs', 'kna:architecture'])}::jsonb,
      ${PROJECT_ID}, 'local development',
      now() + interval '30 days'
    )
  `;

  console.log('');
  console.log('Seeded a local tenant.');
  console.log('');
  console.log(`  org        ${ORG_ID} (${ORG_SLUG})`);
  console.log(`  project    ${PROJECT_ID} (${PROJECT_SLUG})`);
  console.log(`  principal  ${PRINCIPAL_ID} (${SUBJECT}), clearance: confidential, role: admin`);
  console.log(
    `  repos      ${repos.length === 0 ? 'none — pass SEED_REPOS to register some' : ''}`,
  );
  for (const repo of repos) {
    console.log(`             ${repo.id}  ${repo.remote}`);
  }
  console.log('');
  console.log('Tokens — shown once, stored hashed, regenerated on every seed:');
  console.log('');
  console.log(`  export KNA_TOKEN=${apiToken.plain}`);
  console.log(`  export KNA_MCP_TOKEN=${mcpToken.plain}`);
  for (const ingest of ingestTokens) {
    console.log('');
    console.log(`  # publish credential for ${ingest.remote}`);
    console.log(`  export KNA_INGEST_TOKEN=${ingest.token}`);
  }
  console.log('');
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => void sql.end({ timeout: 5 }));
