import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { analyze } from './analyze.js';
import { canonicalClaims, explainFailure, signHmac, type IngestResponse } from '@kna/contracts';
import { zIrBundle, type IrBundle } from '@kna/ir';
import type { CliContext } from '../context.js';
import { ui } from '../ui.js';

/**
 * `kna publish` — send the IR bundle to the platform.
 *
 * The credential story here is the whole of §15.2's mitigation. In CI, the token is minted by
 * exchanging the runner's OIDC identity for a credential "scoped to one `repoId` for ~10
 * minutes, never a static org secret". Locally, it is a user token that carries the developer's
 * own permissions.
 *
 * The other half of that finding — running analysers in a network-egress-denied sandbox with
 * the publish step *outside* it — cannot be enforced from here. It is enforced by the workflow
 * (see `.github/workflows/kna-index.yml`), which is why the publish step is a separate job.
 */

export interface PublishOptions {
  platformUrl?: string;
  token?: string;
  dryRun: boolean;
  maxTier?: 'tier0' | 'tier1' | 'tier2';
  /**
   * Publish a bundle produced by an earlier `kna describe --format json --output`.
   *
   * This is what makes the separation in the docstring above real rather than aspirational.
   * Analysis executes repository build logic — resolving a TypeScript project or restoring
   * packages runs code from the repo — and doing that on a runner holding a publish credential
   * is remote code execution by design. The workflow therefore analyses in a job with no
   * credentials and publishes in a job that never runs repo build logic; the bundle is what
   * passes between them.
   *
   * Without this flag the publish job re-analysed from source, and both halves of the split
   * collapsed back into one job that had the credential *and* ran the repository's code.
   */
  bundlePath?: string;
  /**
   * Exchange the CI workload identity for a short-lived, repo-scoped credential.
   *
   * §15.2 — "never a static org secret". The flag was declared on the command and never read,
   * so `--oidc` silently did nothing and CI fell back to whatever happened to be in the
   * environment — usually the long-lived credential the flag exists to avoid.
   */
  oidc?: boolean;
}

export class PublishError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly guidance: string | null,
  ) {
    super(message);
    this.name = 'PublishError';
  }
}

export async function publishCommand(ctx: CliContext, options: PublishOptions): Promise<void> {
  // §10 Layer 1 — source upload is an explicit, attributable decision. Refuse rather than
  // silently uploading, because this is the control that means "nothing to leak".
  if (ctx.config.security.uploadSource && !ctx.config.security.uploadSourceApprovedBy) {
    throw new Error(
      'security.uploadSource is enabled but security.uploadSourceApprovedBy is not set.\n\n' +
        'Uploading source is a deliberate, attributable decision — the default is that raw\n' +
        'source never leaves this machine. Record who approved it and when, then re-run.',
    );
  }

  const bundle = options.bundlePath
    ? resignEnvelope(await loadBundle(options.bundlePath))
    : (await analyze(ctx, options.maxTier ? { maxTier: options.maxTier } : {})).bundle;

  ui.heading('Bundle');
  ui.table([
    ['bundleId', bundle.envelope.bundleId],
    ['commit', bundle.envelope.commitSha.slice(0, 12)],
    ['symbols', String(bundle.payload.symbols.length)],
    ['modules', String(bundle.payload.modules.length)],
    ['size', `${(bundle.envelope.payloadBytes / 1024).toFixed(0)} KB`],
    ['signature', bundle.envelope.signature.algorithm],
    ['source included', bundle.payload.includesSource ? ui.yellow('yes') : 'no'],
  ]);

  if (bundle.envelope.signature.algorithm === 'unsigned-dev') {
    ui.warn(
      'This bundle is unsigned. Production will reject it — an unsigned bundle lets any token\n' +
        "  holder assert another tenant's orgId. Set KNA_INGEST_HMAC_SECRET, or use the CI OIDC\n" +
        '  exchange, before publishing anywhere real.',
    );
  }

  if (options.dryRun) {
    ui.success('Dry run — nothing was sent.');
    return;
  }

  const platformUrl = options.platformUrl ?? ctx.config.platform.url;
  const token = options.oidc
    ? await exchangeOidcIdentity(ctx, platformUrl)
    : (options.token ?? process.env[ctx.config.platform.ingestTokenEnv]);

  if (!token) {
    // Names the ingest variable, not the principal one. These are different credentials and the
    // previous message pointed at the wrong one, which sent people to set a token that would
    // never have worked here.
    throw new Error(
      `No ingest credential. Set ${ctx.config.platform.ingestTokenEnv}, or pass --token.\n\n` +
        'In CI, prefer --oidc over a static secret: a long-lived org token that can publish for\n' +
        'every repo is the credential you least want sitting on a build runner.',
    );
  }

  const progress = ui.progress('Publishing');
  try {
    const response = await fetch(`${platformUrl}/v1/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-kna-cli-version': '1.0.0',
      },
      body: JSON.stringify(bundle),
    });

    const body = (await response.json().catch(() => null)) as
      IngestResponse | { error?: { message?: string; guidance?: string } } | null;

    if (!response.ok) {
      const error = (body as { error?: { message?: string; guidance?: string } })?.error;
      progress.done();
      throw new PublishError(
        error?.message ?? `Ingest returned ${response.status}`,
        response.status,
        error?.guidance ?? null,
      );
    }

    const accepted = body as IngestResponse;
    progress.done('Published');

    if (accepted.warnings.length > 0) {
      for (const warning of accepted.warnings) ui.warn(warning);
    }

    if (accepted.diff) {
      ui.heading('Change classification');
      ui.table([
        ['added', String(accepted.diff.added)],
        ['removed', String(accepted.diff.removed)],
        ['changed', String(accepted.diff.changed)],
        ['unchanged', String(accepted.diff.unchanged)],
        ['breaking', accepted.diff.breaking > 0 ? ui.yellow(String(accepted.diff.breaking)) : '0'],
        ['reindexing', String(accepted.diff.reindexCount)],
        ['docs to regenerate', String(accepted.diff.regenerateCount)],
      ]);
    }

    // §15.3 — a tripped breaker is not a failure, but it is something a human has to clear.
    if (accepted.circuitBreaker?.tripped) {
      ui.log();
      ui.warn(`Circuit breaker tripped (${accepted.circuitBreaker.rule}).`);
      ui.detail(accepted.circuitBreaker.reason ?? '');
      ui.detail('Documentation regeneration is paused until an operator approves this change.');
      ui.detail('The search index is still being updated — it reflects reality either way.');
    }

    ui.log();
    ui.success(`${accepted.jobIds.length} indexing job(s) queued.`);
  } catch (error) {
    progress.done();
    throw error;
  }
}

/**
 * §15.2 — exchange the CI OIDC identity for a short-lived, repo-scoped ingest credential.
 *
 * The runner never holds a credential that can publish for any other repo, and the credential
 * expires in minutes rather than living in a secret store for years.
 */
export async function exchangeOidcToken(input: {
  platformUrl: string;
  idToken: string;
  repoRemote: string;
  audience?: string;
}): Promise<{ token: string; expiresAt: string; repoId: string }> {
  const response = await fetch(`${input.platformUrl}/v1/auth/ci-exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      idToken: input.idToken,
      repoRemote: input.repoRemote,
      audience: input.audience ?? 'kna-ingest',
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(
      `OIDC exchange failed (${response.status}): ${text.slice(0, 300)}\n\n` +
        'Check that the workflow requests an id-token with the right audience, and that this\n' +
        'repository is registered with the platform.',
    );
  }

  return (await response.json()) as { token: string; expiresAt: string; repoId: string };
}

export function formatPublishError(error: PublishError): string {
  return explainFailure({
    valid: false,
    failure: null,
    detail: error.message,
  }).replace('Bundle accepted.', error.guidance ?? error.message);
}

/**
 * Read and validate a bundle produced by an earlier `kna describe`.
 *
 * Parsed through the schema rather than cast, because this file crossed a job boundary as a CI
 * artifact. Everything downstream — the envelope check at ingest, the diff, the indexer — treats
 * the bundle as structurally sound, so a truncated upload or a version mismatch should fail here
 * with something a human can read rather than three stages later as a type error.
 */
async function loadBundle(path: string): Promise<IrBundle> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `Cannot read bundle at ${path}.\n\n` +
        'Produce one with: kna describe --format json --output kna-ir.json',
    );
  }

  const parsed = zIrBundle.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `${path} is not a valid IR bundle.\n\n` +
        parsed.error.issues
          .slice(0, 5)
          .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('\n'),
    );
  }

  ui.detail(`Publishing a pre-analysed bundle from ${path}; no analysis runs in this step.`);
  return parsed.data;
}

/**
 * Exchange the CI runner's workload identity for a credential scoped to this repository.
 *
 * The identity is requested from the CI provider rather than held by us: GitHub mints an OIDC
 * token on demand for a job that declares `id-token: write`, bound to that repository and
 * workflow. The platform verifies it and returns a credential good for one repo and a few
 * minutes, which is what §15.2 asks for in place of a static secret.
 */
async function exchangeOidcIdentity(ctx: CliContext, platformUrl: string): Promise<string> {
  const audience = process.env.KNA_OIDC_AUDIENCE ?? 'kna-platform';
  const idToken = await requestCiIdToken(audience);

  const response = await fetch(`${platformUrl}/v1/auth/ci-exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idToken, repoRemote: ctx.repo.remote, audience }),
  });

  const body = (await response.json().catch(() => null)) as {
    token?: string;
    expiresAt?: string;
    error?: { message?: string; guidance?: string };
  } | null;

  if (!response.ok || !body?.token) {
    throw new PublishError(
      body?.error?.message ?? `OIDC exchange returned ${response.status}`,
      response.status,
      body?.error?.guidance ?? null,
    );
  }

  ui.detail(`Exchanged CI identity for a repo-scoped credential, expiring ${body.expiresAt}.`);
  return body.token;
}

/** Ask the CI provider for a workload identity token. */
async function requestCiIdToken(audience: string): Promise<string> {
  // GitHub Actions. These two variables are injected only into jobs that declare
  // `permissions: id-token: write`, which is why a workflow missing that line fails here loudly
  // rather than quietly publishing with something weaker.
  const githubUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const githubToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (githubUrl && githubToken) {
    const response = await fetch(`${githubUrl}&audience=${encodeURIComponent(audience)}`, {
      headers: { authorization: `Bearer ${githubToken}` },
    });
    const body = (await response.json().catch(() => null)) as { value?: string } | null;
    if (!response.ok || !body?.value) {
      throw new Error(
        `Could not obtain a GitHub OIDC token (${response.status}).\n\n` +
          'The job needs `permissions: id-token: write`.',
      );
    }
    return body.value;
  }

  // GitLab and Azure DevOps inject the token directly rather than offering an endpoint.
  const injected =
    process.env.KNA_CI_ID_TOKEN ?? process.env.CI_JOB_JWT_V2 ?? process.env.SYSTEM_ACCESSTOKEN;
  if (injected) return injected;

  throw new Error(
    'No CI workload identity is available, so --oidc cannot be used here.\n\n' +
      'On GitHub Actions the job needs `permissions: id-token: write`. Outside CI, publish with\n' +
      'an ingest credential instead: POST /v1/admin/repos/:repoId/ingest-credential.',
  );
}

/**
 * Re-sign a bundle that was produced by a separate analysis step.
 *
 * The signature belongs to whoever publishes, not to whoever analysed. That falls out of the
 * job split: the analyse job runs the repository's own build logic, so it deliberately holds no
 * credentials — which means it cannot sign, and the artifact it hands over is unsigned. If the
 * analyse job *could* sign, it would be holding the very credential the split exists to keep
 * away from repo-controlled code.
 *
 * So the publish step signs what it is about to send. It re-derives the signature over the
 * payload hash already in the envelope, which is what binds the signature to the bundle
 * contents: a tampered payload no longer matches its hash, and ingest checks the hash before it
 * checks the signature.
 *
 * The nonce and expiry are refreshed at the same time. The envelope carries a short expiry
 * deliberately, and the clock starts when the bundle was analysed — a queued or retried publish
 * job would otherwise present a credential-shaped thing that expired while it waited.
 */
function resignEnvelope(bundle: IrBundle): IrBundle {
  const secret = process.env.KNA_INGEST_HMAC_SECRET;
  if (!secret) {
    // Left as-is rather than failed here. A permissive-dev platform accepts an unsigned bundle,
    // and publish already warns about it below; failing would make local experimentation
    // require a secret that serves no purpose against a local stack.
    return bundle;
  }

  const nonce = randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();

  const envelope = { ...bundle.envelope, nonce, expiresAt };
  return {
    ...bundle,
    envelope: {
      ...envelope,
      signature: signHmac(
        secret,
        canonicalClaims({
          orgId: envelope.orgId,
          repoId: envelope.repoId,
          commitSha: envelope.commitSha,
          ref: envelope.ref,
          nonce,
          expiresAt,
          payloadHash: envelope.payloadHash,
          irSchemaVersion: envelope.irSchemaVersion,
        }),
      ),
    },
  };
}
