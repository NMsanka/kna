import type { ContextBudget, ScoredChunk } from './types.js';
import { estimateTokens } from '@kna/chunking';

/**
 * Graph expansion — the differentiator, and the footgun.
 *
 * §8: "Because you have the IR call graph, when a chunk is retrieved you can automatically
 * include its type definitions and immediate callers. Generic code-RAG tools cannot do this."
 *
 * §15.5 HIGH: "Graph expansion is unbounded fan-out with no context budget. Top-8 chunks plus
 * 'callers, callees, type definitions' is fine for a leaf function and catastrophic for a
 * shared utility with 400 `usedBy` edges — the expansion silently evicts the chunks you
 * actually retrieved."
 *
 * The four controls that make it safe are all here:
 *  1. An explicit token budget, with expansion capped at its share.
 *  2. Neighbours per seed capped, ranked by inverse centrality — a utility called by 400 things
 *     tells you less per caller than one called by two.
 *  3. Expanded neighbours rendered as **signature and doc comment only**, never full bodies.
 *  4. Tokens logged per stage, so the budget is observable rather than aspirational.
 */

export interface GraphNeighbour {
  symbolId: string;
  qualifiedName: string;
  signature: string;
  docSummary: string | null;
  moduleId: string;
  repoId: string;
  sourcePath: string;
  sourceStartLine: number;
  relation: 'caller' | 'callee' | 'type' | 'parent' | 'implementation';
  /** Number of inbound edges on the *neighbour*. High centrality means low information. */
  centrality: number;
  sensitivity: ScoredChunk['sensitivity'];
  analysisDepth: string;
}

export interface ExpansionOptions {
  budget: ContextBudget;
  /** Tokens already consumed by primary results. */
  primaryTokens: number;
  maxNeighboursPerSeed?: number;
  /** Neighbours above this centrality are dropped: a symbol used by 400 callers is a utility,
   *  and listing its callers is noise rather than context. */
  centralityCeiling?: number;
  /** Relations in preference order. Types first: they are what make a signature legible. */
  relationPriority?: GraphNeighbour['relation'][];
}

export interface ExpansionResult {
  chunks: ScoredChunk[];
  tokensUsed: number;
  /** Neighbours that existed but did not fit — reported so the budget is visible in traces. */
  droppedCount: number;
  droppedReasons: Record<string, number>;
}

const DEFAULT_RELATION_PRIORITY: GraphNeighbour['relation'][] = [
  'type',
  'parent',
  'callee',
  'implementation',
  'caller',
];

export function expandWithBudget(
  seeds: ScoredChunk[],
  neighboursBySeed: Map<string, GraphNeighbour[]>,
  options: ExpansionOptions,
): ExpansionResult {
  const expansionBudget = Math.floor(options.budget.totalTokens * options.budget.expansionFraction);
  const maxPerSeed = options.maxNeighboursPerSeed ?? 4;
  const centralityCeiling = options.centralityCeiling ?? 50;
  const priority = options.relationPriority ?? DEFAULT_RELATION_PRIORITY;

  const droppedReasons: Record<string, number> = {};
  const drop = (reason: string) => {
    droppedReasons[reason] = (droppedReasons[reason] ?? 0) + 1;
  };

  const seen = new Set(seeds.map((s) => s.symbolId).filter((id): id is string => id !== null));
  const selected: ScoredChunk[] = [];
  let tokensUsed = 0;

  // Round-robin across seeds rather than draining seed 1 first: otherwise the top result's
  // neighbours consume the whole budget and results 2–8 arrive with no context at all.
  const queues = seeds.map((seed) => {
    const candidates = (neighboursBySeed.get(seed.chunkId) ?? [])
      .filter((n) => {
        if (seen.has(n.symbolId)) {
          drop('already-present');
          return false;
        }
        if (n.centrality > centralityCeiling) {
          drop('high-centrality');
          return false;
        }
        return true;
      })
      .sort(
        (a, b) =>
          priority.indexOf(a.relation) - priority.indexOf(b.relation) ||
          a.centrality - b.centrality,
      )
      .slice(0, maxPerSeed);
    return { seed, candidates, index: 0 };
  });

  let progressed = true;
  while (progressed && tokensUsed < expansionBudget) {
    progressed = false;

    for (const queue of queues) {
      if (queue.index >= queue.candidates.length) continue;
      const neighbour = queue.candidates[queue.index++]!;
      progressed = true;

      if (seen.has(neighbour.symbolId)) continue;

      const content = renderNeighbour(neighbour);
      const tokens = estimateTokens(content);

      if (tokensUsed + tokens > expansionBudget) {
        drop('budget-exhausted');
        continue;
      }

      seen.add(neighbour.symbolId);
      tokensUsed += tokens;
      selected.push({
        chunkId: `exp_${neighbour.symbolId}`,
        symbolId: neighbour.symbolId,
        moduleId: neighbour.moduleId,
        repoId: neighbour.repoId,
        content,
        sourcePath: neighbour.sourcePath,
        sourceStartLine: neighbour.sourceStartLine,
        sourceEndLine: null,
        sensitivity: neighbour.sensitivity,
        analysisDepth: neighbour.analysisDepth,
        generated: false,
        corpus: 'code',
        tokenCount: tokens,
        score: 0,
        ranks: {},
        viaExpansion: true,
        expansionRelation: neighbour.relation,
      });
    }
  }

  const droppedCount = Object.values(droppedReasons).reduce((a, b) => a + b, 0);

  return { chunks: selected, tokensUsed, droppedCount, droppedReasons };
}

/**
 * Signature and doc comment only. §15.5 is explicit about this: rendering full bodies for
 * neighbours is what turns a helpful expansion into an eviction event for the primary results.
 */
export function renderNeighbour(neighbour: GraphNeighbour): string {
  const relationLabel: Record<GraphNeighbour['relation'], string> = {
    caller: 'Called by',
    callee: 'Calls',
    type: 'Type used',
    parent: 'Declared in',
    implementation: 'Implemented by',
  };

  const lines = [
    `// ${relationLabel[neighbour.relation]}: ${neighbour.qualifiedName}`,
    `// ${neighbour.sourcePath}:${neighbour.sourceStartLine}`,
    neighbour.signature,
  ];
  if (neighbour.docSummary) lines.push(`// ${neighbour.docSummary}`);
  return lines.join('\n');
}

/**
 * Trim primary results to their share of the budget.
 *
 * Called before expansion so expansion sees the true remaining space. Trimming happens at chunk
 * granularity, never mid-chunk: half a function body is worse than no function body, because
 * the model cannot tell it is looking at a fragment.
 */
export function fitPrimaryToBudget(
  chunks: ScoredChunk[],
  budget: ContextBudget,
): { kept: ScoredChunk[]; dropped: ScoredChunk[]; tokensUsed: number } {
  const primaryBudget = Math.floor(budget.totalTokens * budget.primaryFraction);
  const kept: ScoredChunk[] = [];
  const dropped: ScoredChunk[] = [];
  let tokensUsed = 0;

  for (const chunk of chunks) {
    const tokens = chunk.tokenCount || estimateTokens(chunk.content);
    if (tokensUsed + tokens > primaryBudget && kept.length > 0) {
      dropped.push(chunk);
      continue;
    }
    kept.push(chunk);
    tokensUsed += tokens;
  }

  return { kept, dropped, tokensUsed };
}
