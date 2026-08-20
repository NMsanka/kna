import { simpleGit, type SimpleGit } from 'simple-git';
import { computeRepoId, canonicalRemote, type RepoRef, type VersionRef } from '@kna/ir';
import { loadRepoConfig, type RepoConfig } from '@kna/config';
import { AnalyzerRegistry } from '@kna/analyzer-core';
import { TypeScriptAnalyzer } from '@kna/analyzer-typescript';

/**
 * Shared CLI context: where we are, what repo this is, and which analysers are available.
 *
 * Resolving the git identity here rather than per command matters for a reason §15.1 gives:
 * `repoId` is derived from the canonical remote, so two independent CI runs for the same repo
 * agree on identity without coordinating through the database.
 */

export interface CliContext {
  cwd: string;
  repoRoot: string;
  config: RepoConfig;
  configPath: string | null;
  configIsDefault: boolean;
  configWarnings: string[];
  repo: RepoRef;
  version: VersionRef;
  registry: AnalyzerRegistry;
  git: SimpleGit;
  /** True when this is running in CI, which is the canonical indexer (§5). */
  isCi: boolean;
}

export class NotAGitRepoError extends Error {
  constructor(cwd: string) {
    super(
      `${cwd} is not inside a git repository.\n\n` +
        'The platform keys everything on the git remote and commit SHA, so analysis needs a\n' +
        'repository to describe. Run `git init` first, or point at a repo with --cwd.',
    );
    this.name = 'NotAGitRepoError';
  }
}

export async function createContext(options: {
  cwd?: string;
  org?: string;
  ref?: string;
}): Promise<CliContext> {
  const cwd = options.cwd ?? process.cwd();
  const git = simpleGit(cwd);

  if (!(await git.checkIsRepo())) throw new NotAGitRepoError(cwd);

  const repoRoot = (await git.revparse(['--show-toplevel'])).trim();
  const loaded = await loadRepoConfig(repoRoot, options.org);

  const remotes = await git.getRemotes(true);
  const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0];
  // A repo with no remote is still analysable locally — the CLI must work before onboarding.
  const remoteUrl = origin?.refs.fetch ?? `local:${repoRoot}`;

  const orgId = options.org ?? loaded.config.org;

  // A repository with no commits yet is a normal state during onboarding — `kna init` on a
  // freshly created repo lands here. Analysis still works; only the commit identity is
  // synthetic, and a bundle carrying it is rejected at ingest because the commit does not
  // exist at the Git provider, which is the correct outcome.
  const commitSha = (await git.revparse(['HEAD']).catch(() => null))?.trim() ?? UNBORN_COMMIT_SHA;
  const branch =
    options.ref ??
    (await git.revparse(['--abbrev-ref', 'HEAD']).catch(() => null))?.trim() ??
    (await currentBranchName(git));
  const isTag = branch !== 'HEAD' && /^v?\d+\.\d+/.test(branch);

  let committedAt: string | null = null;
  try {
    const log = await git.log({ maxCount: 1 });
    committedAt = log.latest?.date ? new Date(log.latest.date).toISOString() : null;
  } catch {
    committedAt = null;
  }

  const registry = new AnalyzerRegistry().register(new TypeScriptAnalyzer());

  return {
    cwd,
    repoRoot,
    config: loaded.config,
    configPath: loaded.filepath,
    configIsDefault: loaded.isDefault,
    configWarnings: loaded.warnings,
    repo: {
      id: computeRepoId(orgId, remoteUrl),
      orgId,
      remote: canonicalRemote(remoteUrl),
      name: repoNameFrom(remoteUrl, repoRoot),
      defaultBranch: 'main',
      provider: providerFrom(remoteUrl),
    },
    version: {
      ref: branch,
      kind: isTag ? 'tag' : 'branch',
      commitSha,
      committedAt,
    },
    registry,
    git,
    isCi: isCiEnvironment(),
  };
}

/**
 * Placeholder SHA for a repository with no commits. All zeros is git's own convention for
 * "no object", so it is unmistakable in a log or a rejected-bundle report.
 */
export const UNBORN_COMMIT_SHA = '0'.repeat(40);

export function isUnborn(commitSha: string): boolean {
  return commitSha === UNBORN_COMMIT_SHA;
}

/** The branch a repo would be on once it has a commit. */
async function currentBranchName(git: SimpleGit): Promise<string> {
  try {
    const head = await git.raw(['symbolic-ref', '--short', 'HEAD']);
    return head.trim() || 'main';
  } catch {
    return 'main';
  }
}

function repoNameFrom(remoteUrl: string, repoRoot: string): string {
  const canonical = canonicalRemote(remoteUrl);
  const last = canonical.split('/').pop();
  if (last && last !== 'local:') return last;
  return repoRoot.split(/[\\/]/).pop() ?? 'repo';
}

function providerFrom(remoteUrl: string): RepoRef['provider'] {
  const canonical = canonicalRemote(remoteUrl);
  if (canonical.includes('github.com')) return 'github';
  if (canonical.includes('dev.azure.com') || canonical.includes('visualstudio.com')) {
    return 'azuredevops';
  }
  if (canonical.includes('gitlab')) return 'gitlab';
  if (canonical.includes('bitbucket')) return 'bitbucket';
  return 'local';
}

export function isCiEnvironment(): boolean {
  return Boolean(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.TF_BUILD ||
    process.env.GITLAB_CI ||
    process.env.BUILDKITE,
  );
}

/**
 * Files changed between two commits — the fast path for incremental local runs. Not used by
 * the canonical CI index, which always analyses the full tree so the IR is complete.
 */
export async function changedFiles(git: SimpleGit, from: string, to = 'HEAD'): Promise<string[]> {
  const diff = await git.diff(['--name-only', `${from}..${to}`]);
  return diff.split('\n').filter(Boolean);
}
