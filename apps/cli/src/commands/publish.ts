import { analyze } from './analyze.js';
import { explainFailure, type IngestResponse } from '@kna/contracts';
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

  const result = await analyze(ctx, options.maxTier ? { maxTier: options.maxTier } : {});
  const { bundle } = result;

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
  const token = options.token ?? process.env[ctx.config.platform.tokenEnv];
  if (!token) {
    throw new Error(
      `No platform token. Set ${ctx.config.platform.tokenEnv}, or pass --token.\n\n` +
        'In CI, prefer the OIDC exchange over a static secret: a long-lived org token that can\n' +
        'publish for every repo is the credential you least want on a build runner.',
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
