import { runPipeline, explainDepth } from '@kna/analyzer-core';
import type { CliContext } from '../context.js';
import { ui } from '../ui.js';

/**
 * `kna doctor` — the self-service "why is my repo stale or shallow?" diagnostic.
 *
 * §15.8 BLOCKER lists this among the things that decide whether onboarding happens at all:
 * "Provide an admin console for org-wide onboarding, a bot that opens the onboarding PR rather
 * than asking teams to hand-write config, defaults that make config optional, and a
 * self-service 'why is my repo stale or shallow?' diagnostic. If onboarding costs a team half a
 * day, most teams never onboard."
 *
 * Every finding here has to end in something the developer can *do*. A diagnostic that reports
 * a state without an action is a support ticket with extra steps.
 */

export interface DoctorOptions {
  platformUrl?: string;
  token?: string;
}

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  action: string | null;
}

export async function doctorCommand(ctx: CliContext, options: DoctorOptions): Promise<number> {
  const checks: Check[] = [];

  // ── Local configuration ──────────────────────────────────────────────────────────────────
  checks.push({
    name: 'Repository identity',
    status: ctx.repo.provider === 'local' ? 'warn' : 'ok',
    detail:
      ctx.repo.provider === 'local'
        ? 'No git remote found; this repo can be analysed locally but not synced.'
        : `${ctx.repo.remote} (${ctx.repo.provider})`,
    action:
      ctx.repo.provider === 'local'
        ? 'Add a remote with `git remote add origin <url>` so CI indexing can identify this repo.'
        : null,
  });

  checks.push({
    name: 'Configuration',
    status: 'ok',
    detail: ctx.configPath
      ? ctx.configPath
      : 'Using defaults. No config file is needed for the common case.',
    action: null,
  });

  for (const warning of ctx.configWarnings) {
    checks.push({ name: 'Configuration warning', status: 'warn', detail: warning, action: null });
  }

  // ── Toolchains: the single most common reason for shallow analysis ───────────────────────
  const toolchain = await ctx.registry.probeAll(ctx.repoRoot);
  for (const [analyzer, version] of toolchain) {
    checks.push({
      name: `Analyser: ${analyzer}`,
      status: version ? 'ok' : 'warn',
      detail: version ?? 'toolchain not detected — this repo will index at Tier 0 locally',
      action: version
        ? null
        : 'Install the toolchain locally for richer results, or rely on CI, which has it by definition.',
    });
  }

  // ── Depth, per module ────────────────────────────────────────────────────────────────────
  const pipeline = await runPipeline({
    repoRoot: ctx.repoRoot,
    commitSha: ctx.version.commitSha,
    registry: ctx.registry,
    maxTier: ctx.config.analysis.maxTier,
    includeSource: false,
    timeoutMs: ctx.config.analysis.timeoutMs,
    exclude: ctx.config.exclude,
  });

  const shallow = pipeline.modules.filter((m) => m.depth === 'shallow');
  checks.push({
    name: 'Analysis depth',
    status: shallow.length === 0 ? 'ok' : 'warn',
    detail:
      shallow.length === 0
        ? `All ${pipeline.modules.length} module(s) reach semantic depth or better.`
        : `${shallow.length} of ${pipeline.modules.length} module(s) are shallow.`,
    action: shallow.length === 0 ? null : 'Run `kna doctor --verbose` for the per-module reasons.',
  });

  // ── Guardrail posture ────────────────────────────────────────────────────────────────────
  checks.push({
    name: 'Source upload',
    status: ctx.config.security.uploadSource ? 'warn' : 'ok',
    detail: ctx.config.security.uploadSource
      ? `Enabled, approved by ${ctx.config.security.uploadSourceApprovedBy ?? ui.red('nobody')}`
      : 'Disabled — only IR and generated documentation leave this machine.',
    action:
      ctx.config.security.uploadSource && !ctx.config.security.uploadSourceApprovedBy
        ? 'Record an approver in security.uploadSourceApprovedBy, or disable source upload.'
        : null,
  });

  checks.push({
    name: 'Bundle signing',
    status: process.env.KNA_INGEST_HMAC_SECRET ? 'ok' : 'warn',
    detail: process.env.KNA_INGEST_HMAC_SECRET
      ? 'HMAC secret present.'
      : 'No signing key; bundles will be unsigned and rejected by production.',
    action: process.env.KNA_INGEST_HMAC_SECRET
      ? null
      : 'Set KNA_INGEST_HMAC_SECRET, or use the CI OIDC exchange for a short-lived repo-scoped credential.',
  });

  // ── Platform-side state ──────────────────────────────────────────────────────────────────
  const platformUrl = options.platformUrl ?? ctx.config.platform.url;
  const token = options.token ?? process.env[ctx.config.platform.tokenEnv];

  if (token) {
    try {
      const response = await fetch(
        `${platformUrl}/v1/repos/${encodeURIComponent(ctx.repo.id)}/status`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      if (response.ok) {
        const status = (await response.json()) as {
          lastIndexedSha?: string;
          lastIndexedAt?: string;
          staleSinceSha?: string;
          staleReason?: string;
          pendingBulkReview?: boolean;
          pendingBulkReviewReason?: string;
        };

        const behind = status.lastIndexedSha && status.lastIndexedSha !== ctx.version.commitSha;
        checks.push({
          name: 'Index freshness',
          status: status.staleSinceSha ? 'fail' : behind ? 'warn' : 'ok',
          detail: status.staleSinceSha
            ? `Stale since ${status.staleSinceSha.slice(0, 8)}: ${status.staleReason ?? 'unknown'}`
            : behind
              ? `Indexed at ${status.lastIndexedSha!.slice(0, 8)}; HEAD is ${ctx.version.commitSha.slice(0, 8)}`
              : `Current as of ${status.lastIndexedAt ?? 'unknown'}`,
          action: status.staleSinceSha
            ? 'The last indexing run failed and the previous index was retained. Re-run the CI indexing job.'
            : behind
              ? 'A push has not been indexed yet, or the webhook was missed. The nightly reconciliation sweep will catch it.'
              : null,
        });

        if (status.pendingBulkReview) {
          checks.push({
            name: 'Bulk change review',
            status: 'warn',
            detail:
              status.pendingBulkReviewReason ?? 'A large change is awaiting operator approval.',
            action:
              'An operator must approve the change before documentation regeneration resumes. The search index is unaffected.',
          });
        }
      } else {
        checks.push({
          name: 'Platform',
          status: 'warn',
          detail: `Status endpoint returned ${response.status}.`,
          action: 'Check that this repo has been onboarded: `kna init`.',
        });
      }
    } catch (error) {
      checks.push({
        name: 'Platform',
        status: 'warn',
        detail: `Could not reach ${platformUrl}: ${error instanceof Error ? error.message : String(error)}`,
        action: 'Local analysis still works. Check the platform URL and your network.',
      });
    }
  } else {
    checks.push({
      name: 'Platform',
      status: 'warn',
      detail: 'No token, so platform-side state could not be checked.',
      action: `Set ${ctx.config.platform.tokenEnv} to include index freshness in this report.`,
    });
  }

  // ── Report ───────────────────────────────────────────────────────────────────────────────
  ui.heading('Diagnostics');
  for (const check of checks) {
    const marker =
      check.status === 'ok'
        ? ui.green('ok  ')
        : check.status === 'warn'
          ? ui.yellow('warn')
          : ui.red('fail');
    ui.log(`  ${marker}  ${check.name}`);
    ui.detail(check.detail);
    if (check.action) ui.detail(`→ ${check.action}`);
  }

  if (shallow.length > 0) {
    ui.heading('Depth detail');
    ui.log(explainDepth(pipeline));
  }

  const failures = checks.filter((c) => c.status === 'fail').length;
  const warnings = checks.filter((c) => c.status === 'warn').length;

  ui.log();
  if (failures === 0 && warnings === 0) {
    ui.success('Everything checks out.');
  } else {
    ui.info(`${failures} failure(s), ${warnings} warning(s).`);
  }

  return failures > 0 ? 1 : 0;
}
