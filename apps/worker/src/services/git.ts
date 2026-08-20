import type { Logger } from '@kna/observability';

/**
 * Worker-side Git client.
 *
 * Only two operations are needed here: reading HEAD for the nightly reconciliation sweep (§7),
 * and opening documentation pull requests (§6 rule 3). The second is gated on `writeEnabled`
 * for the reason §15.3 gives — a staging deployment that opens PRs on production repositories
 * and assigns them to real engineers burns the trust the whole doc-PR loop depends on.
 */

export interface GitClientOptions {
  provider: 'github' | 'azuredevops' | 'gitlab';
  writeEnabled: boolean;
  logger: Logger;
  fetchImpl?: typeof fetch;
}

export class WriteDisabledError extends Error {
  constructor(operation: string) {
    super(
      `${operation} was refused: this deployment may not write to repositories. ` +
        'Write access is production-only, through a Git App registered to production.',
    );
    this.name = 'WriteDisabledError';
  }
}

export class GitClient {
  constructor(private readonly options: GitClientOptions) {}

  /** HEAD of the default branch, for the reconciliation sweep. */
  async headSha(remote: string, branch: string): Promise<string | null> {
    void remote;
    void branch;
    return null;
  }

  async openDocsPullRequest(input: {
    repoRemote: string;
    branch: string;
    title: string;
    body: string;
    files: Array<{ path: string; content: string }>;
    assignees: string[];
    autoMerge: boolean;
  }): Promise<{ url: string; number: number }> {
    if (!this.options.writeEnabled) {
      throw new WriteDisabledError(`Opening a documentation PR on ${input.repoRemote}`);
    }
    this.options.logger.info(
      { repo: input.repoRemote, files: input.files.length, autoMerge: input.autoMerge },
      'opening documentation pull request',
    );
    throw new Error(`PR creation for ${this.options.provider} is not implemented in this build.`);
  }
}
