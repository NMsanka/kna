import { z } from 'zod';
import { zRawSymbol, type Language, type RawSymbol } from '@kna/ir';
import type { DiscoveredFile } from './discovery.js';

/**
 * The analyser contract (§13 — "three implementations must produce byte-identical IR
 * semantics. This is the single highest-value spec in the project").
 *
 * An analyser is a subprocess speaking newline-delimited JSON over stdio. That boundary is
 * what keeps the polyglot complexity isolated: the platform layer never knows or cares what
 * language a symbol came from, and adding a fourth language is one process, not a refactor.
 */

export const zAnalyzerRequest = z.object({
  /** Protocol version. Mismatches are rejected loudly rather than misinterpreted. */
  protocol: z.literal('kna-analyzer/1'),
  repoRoot: z.string(),
  commitSha: z.string(),
  module: z.object({
    path: z.string(),
    name: z.string(),
    manifestPath: z.string().nullable(),
  }),
  files: z.array(z.object({ path: z.string(), language: z.string(), generated: z.boolean() })),
  options: z.object({
    /** Whether the repo opted in to snippet upload; analysers must not emit source otherwise. */
    includeSource: z.boolean().default(false),
    timeoutMs: z.number().int().positive().default(600_000),
  }),
});
export type AnalyzerRequest = z.infer<typeof zAnalyzerRequest>;

export const zAnalyzerResponse = z.object({
  protocol: z.literal('kna-analyzer/1'),
  ok: z.boolean(),
  analyzer: z.object({ name: z.string(), version: z.string() }),
  symbols: z.array(zRawSymbol).default([]),
  /**
   * Repo-relative paths this analyser actually covered.
   *
   * The pipeline supersedes Tier 0 output *per file* using this list. Superseding by symbol
   * identity does not work across tiers: Tier 0 reports `lines: InvoiceLine[]` as written
   * while Tier 1 reports the resolved type, so the two never agree on an overload
   * discriminator and every symbol would be emitted twice — dragging the module's declared
   * depth back down to `shallow` and doubling the chunk count.
   *
   * A file present here but contributing no symbols is a valid answer (it genuinely declares
   * nothing); a file absent from here keeps its Tier 0 symbols.
   */
  filesAnalyzed: z.array(z.string()).default([]),
  /** Why the analyser could not reach full depth. Surfaced verbatim in the CLI diagnostic. */
  degradations: z
    .array(z.object({ reason: z.string(), missing: z.string().nullable() }))
    .default([]),
  diagnostics: z
    .array(
      z.object({
        level: z.enum(['info', 'warn', 'error']),
        message: z.string(),
        path: z.string().nullable(),
      }),
    )
    .default([]),
  durationMs: z.number().int().nonnegative().default(0),
});
export type AnalyzerResponse = z.infer<typeof zAnalyzerResponse>;

export interface AnalyzerCapabilities {
  /** Depth this analyser reaches when its toolchain is present. */
  depth: 'semantic' | 'artifact';
  /** Whether it resolves types and a real call graph, or only declarations. */
  resolvesTypes: boolean;
  resolvesCallGraph: boolean;
}

export interface Analyzer {
  name: string;
  version: string;
  languages: Language[];
  capabilities: AnalyzerCapabilities;
  /**
   * Probe for the toolchain. Returns the detected version, or null when absent — in which case
   * the pipeline degrades to Tier 0 rather than failing (§5 "graceful degradation").
   */
  probe(repoRoot: string): Promise<string | null>;
  analyze(request: AnalyzerRequest): Promise<AnalyzerResponse>;
}

export class AnalyzerRegistry {
  private readonly analyzers = new Map<string, Analyzer>();

  register(analyzer: Analyzer): this {
    this.analyzers.set(analyzer.name, analyzer);
    return this;
  }

  forLanguage(language: Language): Analyzer[] {
    return [...this.analyzers.values()].filter((a) => a.languages.includes(language));
  }

  all(): Analyzer[] {
    return [...this.analyzers.values()];
  }

  /**
   * Probe every registered analyser once per run. The result feeds both the pipeline's tier
   * decisions and the "why is my repo shallow?" diagnostic (§15.8) — a developer should never
   * have to guess why their C# module came back at Tier 0.
   */
  async probeAll(repoRoot: string): Promise<Map<string, string | null>> {
    const results = new Map<string, string | null>();
    await Promise.all(
      this.all().map(async (analyzer) => {
        try {
          results.set(analyzer.name, await analyzer.probe(repoRoot));
        } catch {
          results.set(analyzer.name, null);
        }
      }),
    );
    return results;
  }
}

/**
 * Conformance expectations every analyser must satisfy, checked by the shared suite.
 * These are the invariants downstream code is allowed to rely on.
 */
export interface ConformanceExpectation {
  description: string;
  check: (symbols: RawSymbol[]) => string | null;
}

export const CORE_CONFORMANCE: ConformanceExpectation[] = [
  {
    description: 'every symbol has a non-empty qualified name and unqualified name',
    check: (symbols) => {
      const bad = symbols.find((s) => !s.qualifiedName || !s.name);
      return bad ? `symbol with empty name: ${JSON.stringify(bad.sourceRef)}` : null;
    },
  },
  {
    description: 'qualified name ends with the unqualified name',
    check: (symbols) => {
      const bad = symbols.find((s) => !s.qualifiedName.endsWith(s.name));
      return bad ? `${bad.qualifiedName} does not end with ${bad.name}` : null;
    },
  },
  {
    description: 'source ranges are 1-based and well ordered',
    check: (symbols) => {
      const bad = symbols.find(
        (s) => s.sourceRef.startLine < 1 || s.sourceRef.endLine < s.sourceRef.startLine,
      );
      return bad ? `bad range on ${bad.qualifiedName}: ${JSON.stringify(bad.sourceRef)}` : null;
    },
  },
  {
    description: 'declared analysis depth matches what the analyser actually produced',
    check: (symbols) => {
      const overclaimed = symbols.find(
        (s) =>
          s.analysisDepth !== 'shallow' &&
          s.parameters.length > 0 &&
          s.parameters.every((p) => p.type === null),
      );
      return overclaimed
        ? `${overclaimed.qualifiedName} claims ${overclaimed.analysisDepth} but resolved no parameter types`
        : null;
    },
  },
  {
    description: 'no symbol carries source text unless source upload was requested',
    check: (symbols) => {
      const leaked = symbols.find((s) => s.sourceText !== null);
      return leaked ? `${leaked.qualifiedName} carries sourceText without opt-in` : null;
    },
  },
  {
    description: 'overload discriminators distinguish same-named siblings',
    check: (symbols) => {
      const seen = new Map<string, string>();
      for (const s of symbols) {
        const key = `${s.qualifiedName}|${s.kind}|${s.overloadDiscriminator ?? ''}`;
        if (seen.has(key)) return `duplicate identity for ${s.qualifiedName} (${key})`;
        seen.set(key, s.qualifiedName);
      }
      return null;
    },
  },
  {
    description: 'parent qualified names refer to a symbol in the same emission',
    check: (symbols) => {
      const names = new Set(symbols.map((s) => s.qualifiedName));
      const orphan = symbols.find(
        (s) => s.parentQualifiedName && !names.has(s.parentQualifiedName),
      );
      return orphan
        ? `${orphan.qualifiedName} references missing parent ${orphan.parentQualifiedName}`
        : null;
    },
  },
];

export function runConformance(symbols: RawSymbol[]): { passed: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const expectation of CORE_CONFORMANCE) {
    const failure = expectation.check(symbols);
    if (failure) failures.push(`${expectation.description}: ${failure}`);
  }
  return { passed: failures.length === 0, failures };
}

export type { DiscoveredFile };
