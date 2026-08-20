#!/usr/bin/env node
import { Command } from 'commander';
import { runGate, formatGateReport, formatGitHubAnnotations } from '@kna/scanner';
import { discover } from '@kna/analyzer-core';
import { createContext } from './context.js';
import { describeCommand } from './commands/describe.js';
import { publishCommand, PublishError } from './commands/publish.js';
import { doctorCommand } from './commands/doctor.js';
import { initCommand } from './commands/init.js';
import { askCommand } from './commands/ask.js';
import { GuardrailBlockedError, CLI_VERSION } from './commands/analyze.js';
import { generateCommand } from './commands/generate.js';
import { reportError, ui } from './ui.js';

/**
 * docs-cli.
 *
 * §5 — "the local CLI runs Tier 0 always, probes for toolchains, and silently upgrades when it
 * finds them. Developers get instant local answers; the shared index is authoritative and
 * complete." Every command here works with no platform, no token and no config, because a tool
 * that requires setup before it does anything useful does not get adopted (§15.8).
 */

const program = new Command();

program
  .name('kna')
  .description('Analyse repositories, generate documentation, and query the knowledge platform')
  .version(CLI_VERSION)
  .option('--cwd <path>', 'directory to operate in', process.cwd())
  .option('--org <slug>', 'organisation slug (overrides config)')
  .option('--ref <ref>', 'git ref to record (defaults to the current branch)');

// ── init ───────────────────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Onboard this repository: write a CI workflow and, if needed, a config file')
  .option('--org <slug>', 'organisation slug')
  .option('--project <slug...>', 'project slugs this repo belongs to')
  .option('--platform-url <url>', 'platform base URL')
  .option('--provider <provider>', 'github | azuredevops | gitlab')
  .option('--cli-source <mode>', 'source | registry — where CI gets the kna CLI', 'source')
  .option('--platform-repo <owner/name>', 'platform repository, for --cli-source source')
  .option('--force', 'write a config file even when every value would be a default', false)
  .option('--dry-run', 'show what would be written without writing it', false)
  .action(async (options) => {
    const ctx = await context(options);
    await initCommand(ctx, {
      org: options.org,
      projects: options.project,
      platformUrl: options.platformUrl,
      provider: options.provider,
      cliSource: options.cliSource,
      platformRepo: options.platformRepo,
      force: Boolean(options.force),
      dryRun: Boolean(options.dryRun),
    });
  });

// ── describe ───────────────────────────────────────────────────────────────────────────────
program
  .command('describe')
  .description('Analyse this repository and print its Intermediate Representation')
  .option('-f, --format <format>', 'json | summary | symbols', 'summary')
  .option('-o, --output <path>', 'write JSON to a file instead of stdout')
  .option('--max-tier <tier>', 'tier0 | tier1 | tier2')
  .option('--no-scan', 'skip the guardrail scan (describe publishes nothing)')
  .option('--no-pretty', 'emit compact JSON')
  .action(async (options) => {
    const ctx = await context(program.opts());
    await describeCommand(ctx, {
      format: options.format,
      output: options.output,
      maxTier: options.maxTier,
      scan: options.scan !== false,
      pretty: options.pretty !== false,
    });
  });

// ── scan ───────────────────────────────────────────────────────────────────────────────────
program
  .command('scan')
  .description('Run the guardrail scan alone: secrets, PII, and injection patterns')
  .option('--annotations', 'emit GitHub Actions annotations', false)
  .action(async (options) => {
    const ctx = await context(program.opts());
    const discovery = await discover({
      repoRoot: ctx.repoRoot,
      exclude: ctx.config.exclude,
    });

    const gate = await runGate({
      repoRoot: ctx.repoRoot,
      files: discovery.modules.flatMap((m) => m.files.map((f) => f.path)),
      allowlist: ctx.config.security.allowlist,
      extraSecretPatterns: ctx.config.security.extraSecretPatterns,
    });

    if (options.annotations) process.stdout.write(`${formatGitHubAnnotations(gate)}\n`);
    ui.log(formatGateReport(gate));

    // §10 Layer 2 — "exit non-zero in CI. Do not warn-and-continue."
    process.exitCode = gate.passed ? 0 : 1;
  });

// ── generate ───────────────────────────────────────────────────────────────────────────────
program
  .command('generate')
  .description('Generate documentation from the IR into the repository')
  .option('-t, --type <type...>', 'document types to generate')
  .option('-o, --output <dir>', 'output directory (defaults to docs.outputDir)')
  .option('--no-prose', 'deterministic facts only — no LLM prose layer')
  .option('--dry-run', 'print what would be written', false)
  .action(async (options) => {
    const ctx = await context(program.opts());
    await generateCommand(ctx, {
      types: options.type,
      outputDir: options.output,
      prose: options.prose !== false,
      dryRun: Boolean(options.dryRun),
    });
  });

// ── publish ────────────────────────────────────────────────────────────────────────────────
program
  .command('publish')
  .description('Analyse and publish the IR bundle to the platform')
  .option('--platform-url <url>', 'platform base URL')
  .option('--token <token>', 'platform token (prefer the environment or --oidc)')
  .option(
    '--oidc',
    'exchange the CI OIDC identity for a short-lived, repo-scoped credential',
    false,
  )
  .option('--max-tier <tier>', 'tier0 | tier1 | tier2')
  .option('--bundle <path>', 'publish a bundle from `kna describe --output` instead of analysing')
  .option('--dry-run', 'analyse and sign, but do not send', false)
  .action(async (options) => {
    const ctx = await context(program.opts());
    await publishCommand(ctx, {
      platformUrl: options.platformUrl,
      token: options.token,
      maxTier: options.maxTier,
      bundlePath: options.bundle,
      oidc: Boolean(options.oidc),
      dryRun: Boolean(options.dryRun),
    });
  });

// ── ask ────────────────────────────────────────────────────────────────────────────────────
program
  .command('ask [question...]')
  .description('Ask the Developer Assistant about this codebase')
  .option('--platform-url <url>', 'platform base URL')
  .option('--token <token>', 'platform token')
  .option('-s, --scope <scope>', 'project | repo | org | expanded', 'project')
  .option('-n, --top <n>', 'number of results', '8')
  .option('--json', 'emit raw JSON', false)
  .option('-i, --interactive', 'start a multi-turn session', false)
  .action(async (words: string[], options) => {
    const ctx = await context(program.opts());
    const code = await askCommand(ctx, words.length > 0 ? words.join(' ') : undefined, {
      platformUrl: options.platformUrl,
      token: options.token,
      scope: options.scope,
      topN: Number(options.top),
      json: Boolean(options.json),
      interactive: Boolean(options.interactive),
    });
    process.exitCode = code;
  });

// ── doctor ─────────────────────────────────────────────────────────────────────────────────
program
  .command('doctor')
  .description('Explain why this repository is shallow, stale, or not indexed')
  .option('--platform-url <url>', 'platform base URL')
  .option('--token <token>', 'platform token')
  .action(async (options) => {
    const ctx = await context(program.opts());
    process.exitCode = await doctorCommand(ctx, {
      platformUrl: options.platformUrl,
      token: options.token,
    });
  });

async function context(options: { cwd?: string; org?: string; ref?: string }) {
  const ctx = await createContext(options);
  for (const warning of ctx.configWarnings) ui.warn(warning);
  return ctx;
}

async function main(): Promise<void> {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof GuardrailBlockedError) {
      // The report has already been printed in full; adding a second summary here would bury it.
      process.exitCode = 1;
      return;
    }
    if (error instanceof PublishError) {
      ui.error(error.message);
      if (error.guidance) ui.detail(error.guidance);
      process.exitCode = 1;
      return;
    }
    reportError(error);
    process.exitCode = 1;
  }
}

void main();
