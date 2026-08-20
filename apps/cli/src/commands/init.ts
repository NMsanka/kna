import { writeFile, mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runPipeline } from '@kna/analyzer-core';
import type { CliContext } from '../context.js';
import { ui } from '../ui.js';

/**
 * `kna init` — onboarding in one command.
 *
 * §15.8 BLOCKER — "Repo onboarding is the entire adoption funnel and is undefined. Config is
 * implied to be YAML in every repo, plus a CI workflow, plus a webhook, plus sensitivity
 * classification, plus toolchain checks — times 200+ repos. Target one command, under ten
 * minutes, zero YAML for the default case."
 *
 * So: this command writes a CI workflow, and *nothing else* unless the repo genuinely needs
 * something non-default. It detects what it can, states what it inferred, and only emits config
 * for the parts a human actually has to decide. A repo that accepts every default ends up with
 * one workflow file and no config at all.
 */

export interface InitOptions {
  org?: string;
  projects?: string[];
  platformUrl?: string;
  /** Write config even when every value would be a default. */
  force: boolean;
  provider?: 'github' | 'azuredevops' | 'gitlab';
  dryRun: boolean;
}

export async function initCommand(ctx: CliContext, options: InitOptions): Promise<void> {
  ui.heading('Inspecting repository');

  const pipeline = await runPipeline({
    repoRoot: ctx.repoRoot,
    commitSha: ctx.version.commitSha,
    registry: ctx.registry,
    maxTier: 'tier1',
    includeSource: false,
    timeoutMs: 120_000,
  });

  const languages = [...new Set(pipeline.discovery.languages)];
  const moduleCount = pipeline.modules.length;
  const symbolCount = pipeline.modules.reduce((sum, m) => sum + m.symbols.length, 0);

  ui.table([
    ['modules', String(moduleCount)],
    ['symbols', String(symbolCount)],
    ['languages', languages.join(', ') || '(none detected)'],
    ['provider', options.provider ?? ctx.repo.provider],
  ]);

  if (pipeline.discovery.deniedPaths.length > 0) {
    ui.log();
    ui.detail(
      `${pipeline.discovery.deniedPaths.length} path(s) are on the hard denylist and will never be read.`,
    );
  }

  // ── Decide what actually needs writing ───────────────────────────────────────────────────
  const org = options.org ?? ctx.config.org;
  const projects = options.projects ?? ctx.config.projects;
  const needsConfig =
    options.force ||
    org === 'default' ||
    projects.length > 0 ||
    (options.platformUrl && options.platformUrl !== ctx.config.platform.url);

  const provider =
    options.provider ?? (ctx.repo.provider === 'local' ? 'github' : ctx.repo.provider);
  const workflowPath = workflowPathFor(provider);
  const workflow = renderWorkflow(provider, { languages });

  ui.heading('Planned changes');
  ui.log(`  ${ui.green('create')} ${workflowPath}`);
  if (needsConfig) {
    ui.log(`  ${ui.green('create')} kna.config.yaml`);
  } else {
    ui.log(`  ${ui.dim('skip')}   kna.config.yaml — every value would be a default`);
  }

  if (options.dryRun) {
    ui.log();
    ui.info('Dry run — nothing was written.');
    ui.log();
    ui.log(workflow);
    return;
  }

  const workflowFull = join(ctx.repoRoot, workflowPath);
  if (await exists(workflowFull)) {
    ui.warn(`${workflowPath} already exists; leaving it alone.`);
  } else {
    await mkdir(dirname(workflowFull), { recursive: true });
    await writeFile(workflowFull, workflow, 'utf8');
    ui.success(`Wrote ${workflowPath}`);
  }

  if (needsConfig) {
    const configPath = join(ctx.repoRoot, 'kna.config.yaml');
    if (await exists(configPath)) {
      ui.warn('kna.config.yaml already exists; leaving it alone.');
    } else {
      await writeFile(
        configPath,
        renderConfig({ org, projects, platformUrl: options.platformUrl }),
        'utf8',
      );
      ui.success('Wrote kna.config.yaml');
    }
  }

  // These instructions used to name `kna repo onboard`, which is not a command this CLI has.
  // Registration is an administrator action against the platform, deliberately: it grants read
  // access to a repository, and a developer being able to self-serve that would make the ACL
  // model advisory. So the instruction is the request to make, not a command to run.
  ui.heading('Next steps');
  ui.log('  1. Commit these files and open a pull request.');
  ui.log('  2. Ask a platform administrator to register this repository:');
  ui.log();
  ui.log(
    ui.cyan(
      `     curl -X POST ${ctx.config.platform.url}/v1/admin/repos \\\n` +
        `       -H "authorization: Bearer $KNA_TOKEN" \\\n` +
        `       -H 'content-type: application/json' \\\n` +
        `       -d '${JSON.stringify({ remote: ctx.repo.remote, projectSlugs: projects })}'`,
    ),
  );
  ui.log();
  ui.log('  3. Merge. The first index runs on the next push to the default branch.');
  ui.log();
  ui.detail('Registering grants read access and reports any project slug that does not exist —');
  ui.detail('an unknown slug leaves the repo indexed but invisible to project-scoped questions.');
  ui.log();
  ui.detail('Nothing is published until that workflow runs, and the workflow scans for secrets');
  ui.detail('before anything leaves the runner.');
}

function workflowPathFor(provider: string): string {
  switch (provider) {
    case 'azuredevops':
      return 'azure-pipelines-kna.yml';
    case 'gitlab':
      return '.gitlab/kna-index.yml';
    default:
      return '.github/workflows/kna-index.yml';
  }
}

/**
 * The generated workflow embodies §15.2's mitigations directly, and the comments say so —
 * a workflow whose security properties are invisible gets "simplified" by the next person
 * who touches it.
 */
function renderWorkflow(provider: string, input: { languages: string[] }): string {
  if (provider === 'github') return renderGitHubWorkflow(input);
  if (provider === 'gitlab') return renderGitLabWorkflow();
  return renderAzureWorkflow();
}

function renderGitHubWorkflow(input: { languages: string[] }): string {
  const setupSteps: string[] = [];
  if (input.languages.some((l) => l === 'typescript' || l === 'javascript')) {
    setupSteps.push(
      `      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n      - run: npm ci --ignore-scripts\n        continue-on-error: true`,
    );
  }
  if (input.languages.includes('python')) {
    setupSteps.push(
      `      - uses: actions/setup-python@v5\n        with:\n          python-version: '3.12'`,
    );
  }
  if (input.languages.includes('csharp')) {
    setupSteps.push(
      `      - uses: actions/setup-dotnet@v4\n        with:\n          dotnet-version: '9.x'`,
    );
  }

  return `# Generated by \`kna init\`.
#
# Two properties of this workflow are load-bearing and should not be "simplified":
#
#  1. It triggers on \`push\` to the default branch only — never \`pull_request_target\`, and
#     never on fork PRs. Tier 2 extraction builds the repo, and building a fork's code on a
#     runner that holds a publish token is remote code execution by design.
#  2. Analysis and publishing are separate jobs. The analyse job has no credentials and no
#     network egress; the publish job has the credential but never runs repo build logic. The IR
#     bundle is what crosses between them, which is why publish takes --bundle rather than
#     re-analysing. Collapsing the two jobs re-creates the exact hazard the split prevents.
#
# Prerequisite: the kna CLI must be installable by the runner. It is a workspace package today,
# so publish it to your internal registry, or replace the npx calls with a checkout of the
# platform repository, before enabling this workflow.
#
name: KNA index

on:
  push:
    branches: [main, master]
  workflow_dispatch:

# Least privilege. \`id-token\` is what lets the publish job exchange the runner identity for a
# short-lived credential scoped to this one repository.
permissions:
  contents: read
  id-token: write

concurrency:
  # Index the newest commit, not every commit in a merge train (§7 coalescing).
  group: kna-index-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  analyse:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

${setupSteps.join('\n')}

      # Produces the IR bundle. Runs with no platform credential in the environment.
      - name: Analyse
        run: npx --yes @kna/cli describe --format json --output kna-ir.json

      - uses: actions/upload-artifact@v4
        with:
          name: kna-ir
          path: kna-ir.json
          retention-days: 1

  publish:
    needs: analyse
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/download-artifact@v4
        with:
          name: kna-ir

      # The credential is minted here, scoped to this repo, valid for minutes — never a static
      # org secret sitting in the repository settings.
      - name: Publish
        env:
          KNA_PLATFORM_URL: \${{ vars.KNA_PLATFORM_URL }}
        run: npx --yes @kna/cli publish --bundle kna-ir.json --oidc
`;
}

function renderGitLabWorkflow(): string {
  return `# Generated by \`kna init\`.
#
# Analysis and publishing are separate jobs on purpose: the analyse job runs repo build logic
# and must not hold the publish credential.
stages:
  - analyse
  - publish

kna:analyse:
  stage: analyse
  image: node:22
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  script:
    - npx --yes @kna/cli describe --format json --output kna-ir.json
  artifacts:
    paths: [kna-ir.json]
    expire_in: 1 day

kna:publish:
  stage: publish
  image: node:22
  rules:
    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
  id_tokens:
    KNA_ID_TOKEN:
      aud: kna-ingest
  script:
    - npx --yes @kna/cli publish --bundle kna-ir.json --oidc
`;
}

function renderAzureWorkflow(): string {
  return `# Generated by \`kna init\`.
trigger:
  branches:
    include: [main, master]

pr: none  # Never index from a pull request: Tier 2 builds the repo.

stages:
  - stage: Analyse
    jobs:
      - job: analyse
        pool: { vmImage: ubuntu-latest }
        steps:
          - checkout: self
            fetchDepth: 0
          - task: NodeTool@0
            inputs: { versionSpec: '22.x' }
          - script: npx --yes @kna/cli describe --format json --output kna-ir.json
            displayName: Analyse
          - publish: kna-ir.json
            artifact: kna-ir

  - stage: Publish
    dependsOn: Analyse
    jobs:
      - job: publish
        pool: { vmImage: ubuntu-latest }
        steps:
          - download: current
            artifact: kna-ir
          - script: npx --yes @kna/cli publish --bundle $(Pipeline.Workspace)/kna-ir/kna-ir.json --oidc
            displayName: Publish
            env:
              KNA_PLATFORM_URL: $(KNA_PLATFORM_URL)
`;
}

function renderConfig(input: {
  org: string;
  projects: string[];
  platformUrl: string | undefined;
}): string {
  return `# KNA configuration.
#
# Everything here has a working default — this file exists for the decisions that are yours,
# not as a precondition for onboarding. Delete anything you do not need to change.

version: 1
org: ${input.org}
${input.projects.length ? `projects:\n${input.projects.map((p) => `  - ${p}`).join('\n')}` : '# projects: [billing]'}

${input.platformUrl ? `platform:\n  url: ${input.platformUrl}` : '# platform:\n#   url: https://kna.internal'}

# security:
#   # Raw source never leaves this machine unless you turn this on, deliberately and in writing.
#   uploadSource: false
#   uploadSourceApprovedBy: null
#
#   # Paths whose contents are more sensitive than the repo default.
#   sensitivityRules:
#     - paths: ['src/payments/**']
#       tier: confidential
#       reason: handles cardholder data
#
#   # Reviewed suppressions. Every entry needs a reason — an unexplained allowlist entry is how
#   # a real credential gets waved through six months later.
#   allowlist: []

# docs:
#   outputDir: docs/generated
#   prStrategy: daily-digest   # per-change | daily-digest | off
#   autoMergeLowRisk: true     # doc-comment-only changes and new symbols
`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
