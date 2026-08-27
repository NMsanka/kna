import { runPipeline, type PipelineResult } from '@kna/analyzer-core';
import { IR_SCHEMA_VERSION, assemble, buildBundle, type ApiSpec, type IrBundle } from '@kna/ir';
import { classify, formatGateReport, runGate, type GateResult } from '@kna/scanner';
import { extractApiSpecs, extractServices } from '@kna/analyzer-openapi';
import { signHmac, signUnsignedDev, canonicalClaims } from '@kna/contracts';
import { discoverMarkdownFiles, RepoMarkdownSource } from '@kna/documents';
import type { KnowledgeDocument } from '@kna/ir';
import type { CliContext } from '../context.js';
import { ui } from '../ui.js';

/**
 * The shared analysis path behind `describe`, `index` and `publish`.
 *
 * Order matters and is not negotiable: **scan before analysis output is assembled, and refuse
 * to continue on a finding.** §10 Layer 2 — "fail closed. On detection, refuse to publish that
 * file's chunks, report the finding to the developer, and exit non-zero in CI. Do not
 * warn-and-continue." §16 adds why: a secret that reaches the index cannot be retracted.
 */

export interface AnalyzeOptions {
  maxTier?: 'tier0' | 'tier1' | 'tier2';
  /** Skip the guardrail gate. Only ever valid for `describe`, which publishes nothing. */
  skipScan?: boolean;
  quiet?: boolean;
}

export interface AnalyzeOutput {
  pipeline: PipelineResult;
  gate: GateResult | null;
  bundle: IrBundle;
  apiSpecs: ApiSpec[];
  documents: KnowledgeDocument[];
}

export class GuardrailBlockedError extends Error {
  constructor(readonly gate: GateResult) {
    super('Guardrail scan blocked this run.');
    this.name = 'GuardrailBlockedError';
  }
}

export async function analyze(
  ctx: CliContext,
  options: AnalyzeOptions = {},
): Promise<AnalyzeOutput> {
  const progress = options.quiet ? null : ui.progress('Discovering repository');

  // ── Tier 0/1/2 extraction ────────────────────────────────────────────────────────────────
  const pipeline = await runPipeline({
    repoRoot: ctx.repoRoot,
    commitSha: ctx.version.commitSha,
    registry: ctx.registry,
    maxTier: options.maxTier ?? ctx.config.analysis.maxTier,
    includeSource: ctx.config.security.uploadSource,
    timeoutMs: ctx.config.analysis.timeoutMs,
    exclude: ctx.config.exclude,
    vendored: ctx.config.vendored,
    generatedPatterns: ctx.config.analysis.generatedPatterns,
    languages: ctx.config.analysis.languages.length ? ctx.config.analysis.languages : undefined,
    onProgress: (event) => {
      progress?.update(
        event.module
          ? `${event.phase}: ${event.module}${event.analyzer ? ` (${event.analyzer})` : ''}`
          : event.phase,
      );
    },
  });

  progress?.update('Scanning for secrets and PII');

  const markdownConfig = ctx.config.docs.sources.find(
    (source) => source.type === 'repo-markdown' && source.enabled,
  );
  const markdownPaths = markdownConfig
    ? await discoverMarkdownFiles({
        repoRoot: ctx.repoRoot,
        include: markdownConfig.include,
        exclude: markdownConfig.exclude,
      })
    : [];

  // ── Guardrail gate ───────────────────────────────────────────────────────────────────────
  let gate: GateResult | null = null;
  if (!options.skipScan) {
    const files = [
      ...pipeline.discovery.modules.flatMap((m) => m.files.map((f) => f.path)),
      ...markdownPaths,
    ];
    gate = await runGate({
      repoRoot: ctx.repoRoot,
      files: [...new Set(files)],
      allowlist: ctx.config.security.allowlist,
      extraSecretPatterns: ctx.config.security.extraSecretPatterns,
    });

    if (!gate.passed) {
      progress?.done();
      ui.log(formatGateReport(gate));
      throw new GuardrailBlockedError(gate);
    }
  }

  progress?.update('Extracting build artifacts');

  // ── Tier 2 ───────────────────────────────────────────────────────────────────────────────
  const { specs, bindings } = await extractApiSpecs({
    repoRoot: ctx.repoRoot,
    modules: pipeline.discovery.modules.map((m) => ({
      path: m.module.path,
      name: m.module.name,
    })),
    explicitPaths: ctx.config.analysis.openapi,
  });
  const serviceManifests = await extractServices({ repoRoot: ctx.repoRoot });

  progress?.update('Assembling IR');

  // ── Sensitivity classification (§10 Layer 3) ─────────────────────────────────────────────
  const sensitivityByModulePath: Record<string, ReturnType<typeof classify>['tier']> = {};
  for (const module of pipeline.modules) {
    const configured = ctx.config.modules.find((m) => m.path === module.module.path);
    const rules = ctx.config.security.sensitivityRules.flatMap((rule) =>
      rule.paths.map((p) => ({
        pattern: globToRegExp(p),
        tier: rule.tier,
        reason: rule.reason ?? 'repository configuration',
      })),
    );
    sensitivityByModulePath[module.module.path] = classify({
      path: module.module.path,
      configuredTier: configured?.sensitivity ?? null,
      repoDefault: ctx.config.security.defaultSensitivity,
      rules: rules.length > 0 ? rules : undefined,
      codeMarkers: module.symbols.flatMap((s) => s.decorators),
    }).tier;
  }

  // ── IR assembly ──────────────────────────────────────────────────────────────────────────
  const assembled = assemble({
    orgId: ctx.repo.orgId,
    repo: ctx.repo,
    version: ctx.version,
    projectIds: ctx.config.projects,
    modules: pipeline.modules.map((m) => ({ module: m.module, symbols: m.symbols })),
    sensitivityByModulePath,
    includeSource: ctx.config.security.uploadSource,
  });

  // Attach Tier 2 HTTP bindings to their handler symbols. This is the join that turns "a
  // controller method" into "a documented endpoint", and it is the highest-fidelity edge in
  // the system (§5, §4.3).
  let bound = 0;
  for (const symbol of assembled.symbols) {
    const binding = bindings.get(symbol.qualifiedName) ?? bindings.get(symbol.name);
    if (binding) {
      symbol.httpBinding = binding;
      symbol.analysisDepth = 'artifact';
      bound++;
    }
  }

  const resolvedSpecs: ApiSpec[] = specs.map((spec) => ({
    ...spec,
    moduleId:
      assembled.modules.find((m) => spec.sourcePath?.startsWith(m.path))?.id ??
      assembled.modules[0]?.id ??
      '',
  }));

  progress?.update('Collecting repository documentation');
  const documents = markdownConfig
    ? (
        await new RepoMarkdownSource({
          repoRoot: ctx.repoRoot,
          orgId: ctx.repo.orgId,
          repoId: ctx.repo.id,
          commitSha: ctx.version.commitSha,
          projectIds: ctx.config.projects,
          modules: assembled.modules.map((module) => ({ id: module.id, path: module.path })),
          include: markdownConfig.include,
          exclude: markdownConfig.exclude,
          defaultSensitivity: ctx.config.security.defaultSensitivity,
        }).pull()
      ).documents
    : [];

  const bundle = buildBundle({
    ...assembled,
    orgId: ctx.repo.orgId,
    repo: ctx.repo,
    version: ctx.version,
    apiSpecs: resolvedSpecs,
    services: serviceManifests,
    documents,
    toolchain: {
      detected: pipeline.toolchain,
      tiersRun: resolvedSpecs.length > 0 ? [...pipeline.tiersRun, 'tier2'] : pipeline.tiersRun,
      degradations: pipeline.modules.flatMap((m) =>
        m.degradations.map((d) => ({
          module: m.module.path,
          reason: d.reason,
          missing: d.missing,
        })),
      ),
      durationMs: pipeline.durationMs,
    },
    scan: {
      scannerVersion: gate?.scannerVersion ?? 'skipped',
      rulesetHash: gate?.rulesetHash ?? 'skipped',
      filesScanned: gate?.stats.filesScanned ?? 0,
      secretsFound: gate?.stats.secretsFound ?? 0,
      piiFound: gate?.stats.piiFound ?? 0,
      pathsExcluded: gate?.deniedPaths.length ?? 0,
      injectionPatternsFlagged: gate?.stats.injectionPatternsFlagged ?? 0,
      // A skipped scan is never reported as passed: the ingest endpoint refuses on `false`,
      // which is exactly what should happen if someone tries to publish a `describe` bundle.
      passed: gate?.passed ?? false,
    },
    includesSource: ctx.config.security.uploadSource,
    producerVersion: CLI_VERSION,
    environment: ctx.isCi ? 'ci' : 'local',
    sign: (payloadHash, claims) => {
      const canonical = canonicalClaims({
        orgId: ctx.repo.orgId,
        repoId: ctx.repo.id,
        commitSha: ctx.version.commitSha,
        ref: ctx.version.ref,
        nonce: claims.nonce!,
        expiresAt: claims.expiresAt!,
        payloadHash,
        irSchemaVersion: IR_SCHEMA_VERSION,
      });
      const secret = process.env.KNA_INGEST_HMAC_SECRET;
      return secret ? signHmac(secret, canonical) : signUnsignedDev(canonical);
    },
  });

  progress?.done(
    `Analysed ${assembled.symbols.length} symbols and ${documents.length} document(s) across ${assembled.modules.length} module(s)` +
      (bound > 0 ? `, ${bound} bound to HTTP endpoints` : ''),
  );

  return { pipeline, gate, bundle, apiSpecs: resolvedSpecs, documents };
}

export const CLI_VERSION = '1.0.0';

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('**')
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .split('*')
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(source);
}
