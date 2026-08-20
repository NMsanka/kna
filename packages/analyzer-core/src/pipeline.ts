import { readFile } from 'node:fs/promises';
import type { AnalysisDepth, RawModule, RawSymbol } from '@kna/ir';
import {
  discover,
  type DiscoveredModule,
  type DiscoveryOptions,
  type DiscoveryResult,
} from './discovery.js';
import { parseTier0 } from './tier0/lexical.js';
import { type AnalyzerRegistry, type Analyzer, type AnalyzerRequest } from './registry.js';

/**
 * The extraction pipeline (§5).
 *
 *   Tier 0 — universal, always runs, zero toolchain, tolerates broken code.
 *   Tier 1 — semantic, when the toolchain is present (ts-morph / Griffe / Roslyn).
 *   Tier 2 — build artifacts: OpenAPI, IaC, service manifests. Highest fidelity.
 *
 * The governing rule is graceful degradation: "If the .NET SDK is absent, do not fail. Emit
 * Tier 0, mark the module `analysisDepth: 'shallow'`, and surface that badge... Never let the
 * assistant present shallow-analysis output with the same confidence as semantic output."
 *
 * Tier 1 output supersedes Tier 0 for the same symbol rather than merging with it — merging
 * two views of one declaration produces IR that is neither, and the conformance suite would
 * not be able to say which analyser was wrong.
 */

export interface PipelineOptions extends DiscoveryOptions {
  commitSha: string;
  registry: AnalyzerRegistry;
  maxTier: 'tier0' | 'tier1' | 'tier2';
  includeSource: boolean;
  timeoutMs: number;
  onProgress?: (event: PipelineProgress) => void;
}

export interface PipelineProgress {
  phase: 'discovery' | 'tier0' | 'tier1' | 'tier2';
  module?: string;
  analyzer?: string;
  completed: number;
  total: number;
}

export interface ModuleAnalysis {
  module: RawModule;
  symbols: RawSymbol[];
  depth: AnalysisDepth;
  degradations: Array<{ reason: string; missing: string | null }>;
}

export interface PipelineResult {
  discovery: DiscoveryResult;
  modules: ModuleAnalysis[];
  toolchain: Record<string, string | null>;
  tiersRun: Array<'tier0' | 'tier1' | 'tier2'>;
  durationMs: number;
  diagnostics: Array<{ level: 'info' | 'warn' | 'error'; message: string; path: string | null }>;
}

export async function runPipeline(options: PipelineOptions): Promise<PipelineResult> {
  const started = Date.now();
  const diagnostics: PipelineResult['diagnostics'] = [];

  options.onProgress?.({ phase: 'discovery', completed: 0, total: 1 });
  const discovery = await discover(options);

  const toolchain = Object.fromEntries(await options.registry.probeAll(options.repoRoot));
  const tiersRun: PipelineResult['tiersRun'] = ['tier0'];

  const modules: ModuleAnalysis[] = [];
  let completed = 0;

  for (const discovered of discovery.modules) {
    options.onProgress?.({
      phase: 'tier0',
      module: discovered.module.path,
      completed,
      total: discovery.modules.length,
    });

    const analysis = await analyseModule(discovered, options, toolchain, diagnostics);
    modules.push(analysis);
    completed++;
  }

  if (options.maxTier !== 'tier0' && modules.some((m) => m.depth !== 'shallow')) {
    tiersRun.push('tier1');
  }

  return {
    discovery,
    modules,
    toolchain,
    tiersRun,
    durationMs: Date.now() - started,
    diagnostics,
  };
}

async function analyseModule(
  discovered: DiscoveredModule,
  options: PipelineOptions,
  toolchain: Record<string, string | null>,
  diagnostics: PipelineResult['diagnostics'],
): Promise<ModuleAnalysis> {
  const degradations: ModuleAnalysis['degradations'] = [];

  // ── Tier 0: always, for every file. This is the floor and it never fails the run. ─────────
  const tier0ByFile = new Map<string, RawSymbol[]>();
  for (const file of discovered.files) {
    if (file.language === 'unknown') continue;
    try {
      const content = await readFile(file.absolutePath, 'utf8');
      tier0ByFile.set(
        file.path,
        parseTier0({
          path: file.path,
          content,
          language: file.language,
          commitSha: options.commitSha,
          generated: file.generated,
        }),
      );
    } catch (error) {
      diagnostics.push({
        level: 'warn',
        message: `Tier 0 could not read file: ${error instanceof Error ? error.message : String(error)}`,
        path: file.path,
      });
    }
  }

  const allTier0 = (): RawSymbol[] => [...tier0ByFile.values()].flat();

  if (options.maxTier === 'tier0') {
    return {
      module: { ...discovered.module, analysisNotes: ['Tier 1 disabled by configuration'] },
      symbols: allTier0(),
      depth: 'shallow',
      degradations: [{ reason: 'analysis.maxTier is tier0', missing: null }],
    };
  }

  // ── Tier 1: semantic, per language, when the toolchain is present. ───────────────────────
  const languages = [...new Set(discovered.files.map((f) => f.language))].filter(
    (l) => l !== 'unknown',
  );

  const semanticSymbols: RawSymbol[] = [];
  /** Files a Tier 1 analyser covered — their Tier 0 output is dropped, not merged. */
  const supersededFiles = new Set<string>();
  const analysersRun = new Set<string>();

  for (const language of languages) {
    const candidates = options.registry.forLanguage(language);
    if (candidates.length === 0) {
      degradations.push({ reason: `No analyser registered for ${language}`, missing: language });
      continue;
    }

    const analyzer = candidates.find((a) => toolchain[a.name] != null);
    if (!analyzer) {
      // The single most important line in the file: a missing toolchain is a degradation, not
      // a failure, and it is reported precisely enough to be actionable.
      degradations.push({
        reason: `${language}: toolchain for ${candidates.map((c) => c.name).join(' or ')} not found; using Tier 0 only`,
        missing: candidates[0]!.name,
      });
      continue;
    }

    options.onProgress?.({
      phase: 'tier1',
      module: discovered.module.path,
      analyzer: analyzer.name,
      completed: 0,
      total: 1,
    });

    const request: AnalyzerRequest = {
      protocol: 'kna-analyzer/1',
      repoRoot: options.repoRoot,
      commitSha: options.commitSha,
      module: {
        path: discovered.module.path,
        name: discovered.module.name,
        manifestPath: discovered.manifestPath,
      },
      files: discovered.files
        .filter((f) => f.language === language)
        .map((f) => ({ path: f.path, language: f.language, generated: f.generated })),
      options: { includeSource: options.includeSource, timeoutMs: options.timeoutMs },
    };

    try {
      const response = await analyzer.analyze(request);
      if (!response.ok) {
        degradations.push({
          reason: `${analyzer.name} reported failure; falling back to Tier 0 for ${language}`,
          missing: analyzer.name,
        });
        continue;
      }

      semanticSymbols.push(...response.symbols);
      for (const file of response.filesAnalyzed) supersededFiles.add(file);
      degradations.push(...response.degradations);
      diagnostics.push(...response.diagnostics);
      analysersRun.add(analyzer.name);
    } catch (error) {
      // §5: quality degrades visibly; the system does not break.
      degradations.push({
        reason: `${analyzer.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        missing: analyzer.name,
      });
      diagnostics.push({
        level: 'warn',
        message: `Tier 1 analyser ${analyzer.name} failed for module ${discovered.module.path}; retaining Tier 0 output.`,
        path: discovered.module.path,
      });
    }
  }

  // Supersede per file, never merge per symbol. Merging two views of one declaration produces
  // IR that is neither, and the conformance suite could not say which analyser was wrong.
  const merged: RawSymbol[] = [...semanticSymbols];
  for (const [path, symbols] of tier0ByFile) {
    if (supersededFiles.has(path)) continue;
    merged.push(...symbols);
  }

  const depth = computeDepth(merged);

  return {
    module: {
      ...discovered.module,
      analysisDepth: depth,
      analysisNotes: degradations.map((d) => d.reason),
      symbolCount: merged.length,
    },
    symbols: merged,
    depth,
    degradations,
  };
}

/** A module is only as deep as its shallowest symbol. Never overstate confidence. */
function computeDepth(symbols: RawSymbol[]): AnalysisDepth {
  if (symbols.length === 0) return 'shallow';
  if (symbols.some((s) => s.analysisDepth === 'shallow')) return 'shallow';
  if (symbols.some((s) => s.analysisDepth === 'semantic')) return 'semantic';
  return 'artifact';
}

/** Human-readable answer to "why is my repo stale or shallow?" (§15.8). */
export function explainDepth(result: PipelineResult): string {
  const lines: string[] = [];
  lines.push('Analysis depth by module:');
  for (const m of result.modules) {
    lines.push(`  ${m.depth.padEnd(9)} ${m.module.path}  (${m.symbols.length} symbols)`);
    for (const d of m.degradations) {
      lines.push(`            ↳ ${d.reason}`);
    }
  }

  const missing = new Set(
    result.modules.flatMap((m) =>
      m.degradations.map((d) => d.missing).filter((x): x is string => !!x),
    ),
  );
  if (missing.size > 0) {
    lines.push('');
    lines.push('To reach semantic depth, install the toolchains for: ' + [...missing].join(', '));
    lines.push('CI runners that build this repo already have them — the shared index is complete');
    lines.push('even when your local run is not.');
  }

  return lines.join('\n');
}

export type { Analyzer };
