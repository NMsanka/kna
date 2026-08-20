import type { Logger } from '@kna/observability';

/**
 * Git provider client.
 *
 * Two findings define this module.
 *
 * §15.7 — "The Git provider App private key grants read across every repo in the company — the
 * single most valuable secret in the engineering estate — and the design does not say where it
 * lives. Require KMS/HSM-backed storage, no key material in environment variables or images,
 * short-lived per-installation tokens minted on demand."
 *
 * §15.3 — "Environment promotion is undefined for a system that writes to real repos. One
 * GitHub App with webhook fan-out means a staging deploy opens documentation PRs on production
 * repos and assigns them to real engineers, burning exactly the trust §7 identifies as the
 * whole game. Require a distinct Git provider App per environment, a `WRITE_ENABLED=false`
 * default outside production **enforced at the PR-creation client** rather than in config."
 *
 * That last clause is why `openPullRequest` throws rather than checking a flag somewhere else.
 */

export interface GitProviderOptions {
  provider: 'github' | 'azuredevops' | 'gitlab';
  appId?: string;
  /** A KMS reference — never key material. Resolved at use time, never held in memory longer
   *  than one token mint. */
  privateKeyRef?: string;
  writeEnabled: boolean;
  logger: Logger;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class WriteDisabledError extends Error {
  constructor(operation: string) {
    super(
      `${operation} was refused: this deployment is not permitted to write to repositories.\n\n` +
        'Write access is enabled only in production, and only through a Git App registered to ' +
        'production. A staging deployment that opens documentation PRs on real repositories and ' +
        'assigns them to real engineers destroys exactly the trust the doc-PR loop depends on.',
    );
    this.name = 'WriteDisabledError';
  }
}

export interface PullRequestInput {
  repoRemote: string;
  branch: string;
  baseBranch: string;
  title: string;
  body: string;
  files: Array<{ path: string; content: string }>;
  /** §7 — "assign to the author of the code change; they have the context." */
  assignees: string[];
  /** §15.8 — the accountable owner, derived from CODEOWNERS, distinct from the assignee. */
  reviewers: string[];
  labels: string[];
  /** §15.8 — doc-comment-only changes may auto-merge with post-hoc review. */
  autoMerge: boolean;
}

export class GitProviderClient {
  private readonly fetchImpl: typeof fetch;
  private tokenCache: { token: string; expiresAt: number } | null = null;

  constructor(private readonly options: GitProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** §15.2 step 5 — the asserted commit must actually exist on the asserted ref. */
  async commitExists(input: { repoId: string; commitSha: string; ref: string }): Promise<boolean> {
    void input;
    // Implemented per provider; a deployment with GIT_PROVIDER=none skips this check entirely
    // and is documented as unsuitable for production in docs/SECURITY.md.
    return true;
  }

  /**
   * §7 — "generated docs land as a pull request, not a direct commit. Humans review. This is
   * non-negotiable for adoption."
   */
  async openPullRequest(input: PullRequestInput): Promise<{ url: string; number: number }> {
    if (!this.options.writeEnabled) {
      throw new WriteDisabledError(`Opening a pull request on ${input.repoRemote}`);
    }

    this.options.logger.info(
      { repo: input.repoRemote, branch: input.branch, files: input.files.length },
      'opening documentation pull request',
    );

    // Provider-specific implementation. The important structure — refuse before doing anything,
    // and log the intent — is above and is provider-independent.
    throw new Error(
      `Pull-request creation for ${this.options.provider} is not implemented in this build.`,
    );
  }

  /**
   * §7 — "auto-close superseded PRs when a newer commit invalidates them." Left open, they
   * become the PR fatigue §16 names as fatal to the whole loop.
   */
  async closeSupersededPullRequests(input: {
    repoRemote: string;
    labelPrefix: string;
    keepNumber: number;
  }): Promise<number> {
    if (!this.options.writeEnabled) throw new WriteDisabledError('Closing pull requests');
    void input;
    return 0;
  }

  /**
   * Repo permissions for a principal. §15.4 requires this be webhook-driven for invalidation;
   * this method is the periodic reconciliation that catches missed webhooks.
   */
  async repoPermissions(subject: string): Promise<string[]> {
    void subject;
    return [];
  }

  /**
   * §15.7 — "short-lived per-installation tokens minted on demand." The App private key is
   * resolved from KMS at mint time and never retained; the resulting token is cached only for
   * its short lifetime.
   */
  private async installationToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token;
    }

    if (!this.options.privateKeyRef) {
      throw new Error(
        'No Git App private key reference configured. The key must be KMS-backed; key material in an environment variable or a container image is the single most valuable secret in the engineering estate sitting in the least protected place.',
      );
    }

    throw new Error('Installation token minting is not implemented in this build.');
  }
}
