import { writeFile } from 'node:fs/promises';
import { analyze } from './analyze.js';
import type { CliContext } from '../context.js';
import { ui } from '../ui.js';

/**
 * `kna describe` — print the IR for a repo as JSON.
 *
 * §18: "If you want one concrete starting point: the IR package and the TypeScript analyser,
 * plus a `docs-cli describe` command that prints the IR for a repo as JSON. No LLM, no vector
 * database, no web service. That artefact is unglamorous and it is the whole system."
 *
 * It is also the fastest way for a developer to see what the platform will know about their
 * code before they let it publish anything — which matters for adoption more than the feature
 * list suggests.
 */

export interface DescribeOptions {
  output?: string;
  format: 'json' | 'summary' | 'symbols';
  maxTier?: 'tier0' | 'tier1' | 'tier2';
  /** describe publishes nothing, so a scan is informational rather than blocking. */
  scan: boolean;
  pretty: boolean;
}

export async function describeCommand(ctx: CliContext, options: DescribeOptions): Promise<void> {
  const result = await analyze(ctx, {
    ...(options.maxTier ? { maxTier: options.maxTier } : {}),
    skipScan: !options.scan,
    quiet: options.format === 'json' && !options.output,
  });

  if (options.format === 'json') {
    const json = JSON.stringify(result.bundle, null, options.pretty ? 2 : 0);
    if (options.output) {
      await writeFile(options.output, json, 'utf8');
      ui.success(`IR written to ${options.output} (${(json.length / 1024).toFixed(0)} KB)`);
    } else {
      process.stdout.write(`${json}\n`);
    }
    return;
  }

  if (options.format === 'symbols') {
    for (const symbol of result.bundle.payload.symbols) {
      const depth =
        symbol.analysisDepth === 'shallow' ? ui.yellow('shallow') : symbol.analysisDepth;
      ui.log(
        `${symbol.visibility.padEnd(9)} ${symbol.kind.padEnd(10)} ${symbol.qualifiedName}  ${ui.dim(
          `${symbol.sourceRef.path}:${symbol.sourceRef.startLine} [${depth}]`,
        )}`,
      );
    }
    return;
  }

  printSummary(ctx, result);
}

function printSummary(ctx: CliContext, result: Awaited<ReturnType<typeof analyze>>): void {
  const { payload } = result.bundle;

  ui.heading('Repository');
  ui.table([
    ['remote', ctx.repo.remote],
    ['repoId', ctx.repo.id],
    ['ref', `${ctx.version.ref} @ ${ctx.version.commitSha.slice(0, 8)}`],
    ['config', ctx.configPath ?? 'defaults (no config file — this is fine)'],
  ]);

  ui.heading('Modules');
  for (const module of payload.modules) {
    const depth =
      module.analysisDepth === 'shallow'
        ? ui.yellow(module.analysisDepth)
        : ui.green(module.analysisDepth);
    ui.log(`  ${module.path}`);
    ui.table(
      [
        ['package', module.packageName ?? '(none)'],
        ['symbols', String(module.symbolCount)],
        ['depth', depth],
        ['sensitivity', module.sensitivity],
        ['owners', module.owners.join(', ') || '(no CODEOWNERS entry)'],
      ],
      '    ',
    );
  }

  const byKind = new Map<string, number>();
  for (const symbol of payload.symbols) {
    byKind.set(symbol.kind, (byKind.get(symbol.kind) ?? 0) + 1);
  }

  ui.heading('Symbols');
  ui.table(
    [...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => [kind, String(count)]),
  );

  const publicSymbols = payload.symbols.filter((s) => s.visibility === 'public');
  const documented = publicSymbols.filter((s) => s.docComment?.summary);
  ui.log();
  ui.table([
    ['public symbols', String(publicSymbols.length)],
    [
      'documented',
      `${documented.length} (${publicSymbols.length ? Math.round((documented.length / publicSymbols.length) * 100) : 0}%)`,
    ],
    ['endpoints', String(payload.symbols.filter((s) => s.httpBinding).length)],
    ['deprecated', String(payload.symbols.filter((s) => s.deprecated).length)],
  ]);

  if (payload.apiSpecs.length > 0) {
    ui.heading('API specifications (Tier 2)');
    for (const spec of payload.apiSpecs) {
      ui.log(`  ${spec.title} v${spec.version}  ${ui.dim(spec.sourcePath ?? '')}`);
    }
  }

  if (payload.services.length > 0) {
    ui.heading('Deployment topology');
    for (const service of payload.services) {
      const deps = service.dependsOn.length ? ` → ${service.dependsOn.join(', ')}` : '';
      ui.log(`  ${service.kind.padEnd(9)} ${service.name}${ui.dim(deps)}`);
    }
  }

  if (result.gate) {
    ui.heading('Guardrails');
    ui.table([
      ['files scanned', String(result.gate.stats.filesScanned)],
      ['paths denied', String(result.gate.deniedPaths.length)],
      ['secrets', String(result.gate.stats.secretsFound)],
      ['pii', String(result.gate.stats.piiFound)],
      ['injection flags', String(result.gate.stats.injectionPatternsFlagged)],
    ]);
  }

  const degradations = payload.toolchain.degradations;
  if (degradations.length > 0) {
    ui.heading('Why some modules are shallow');
    for (const degradation of degradations) {
      ui.log(`  ${ui.yellow('!')} ${degradation.module}: ${degradation.reason}`);
    }
    ui.log();
    ui.detail('CI runners that build this repo already have these toolchains, so the shared');
    ui.detail('index will be complete even when a local run is not.');
  }
}
