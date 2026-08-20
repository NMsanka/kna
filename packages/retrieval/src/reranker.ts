import type { ScoredChunk } from './types.js';

/**
 * Cross-encoder reranking.
 *
 * §11 "the hole: OpenAI has no reranker" — the recommendation is a self-hosted cross-encoder
 * (`bge-reranker-v2-m3` behind a small service), which is also the right answer for §15.7's
 * finding that "the reranker receives the full text of the top-50 chunks — the highest
 * sensitivity payload in the pipeline."
 *
 * §15.5 sets the operational contract: "give the reranker a hard timeout with fallback to RRF
 * order". A slow reranker must degrade the *ordering*, never the availability — the named
 * degraded mode is "serve RRF order with a banner, not a 500" (§15.6).
 */

export interface RerankerOptions {
  url: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
  onDegraded?: (reason: string) => void;
}

export interface RerankOutcome {
  chunks: ScoredChunk[];
  /** Null when the reranker did not run — the abstention policy branches on this. */
  topScore: number | null;
  available: boolean;
  degradedReason: string | null;
  latencyMs: number;
}

export class Reranker {
  private readonly fetchImpl: typeof fetch;
  /** Simple breaker: after repeated failures, stop paying the timeout on every query. */
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(private readonly options: RerankerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async rerank(query: string, candidates: ScoredChunk[], topN: number): Promise<RerankOutcome> {
    const started = performance.now();

    if (candidates.length === 0) {
      return { chunks: [], topScore: null, available: true, degradedReason: null, latencyMs: 0 };
    }

    if (Date.now() < this.openUntil) {
      return this.fallback(
        candidates,
        topN,
        'Reranker circuit is open after repeated failures.',
        started,
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.options.url}/rerank`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.options.model,
          query,
          documents: candidates.map((c) => c.content),
          top_n: Math.min(topN, candidates.length),
          return_documents: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.recordFailure();
        return this.fallback(candidates, topN, `Reranker returned ${response.status}.`, started);
      }

      const body = (await response.json()) as {
        results?: Array<{ index: number; relevance_score: number }>;
      };
      if (!body.results?.length) {
        this.recordFailure();
        return this.fallback(candidates, topN, 'Reranker returned no results.', started);
      }

      this.consecutiveFailures = 0;

      const reranked = body.results
        .filter((r) => r.index >= 0 && r.index < candidates.length)
        .sort((a, b) => b.relevance_score - a.relevance_score)
        .slice(0, topN)
        .map((result, rank) => {
          const chunk = candidates[result.index]!;
          return {
            ...chunk,
            score: result.relevance_score,
            ranks: { ...chunk.ranks, reranked: rank + 1 },
          };
        });

      return {
        chunks: reranked,
        topScore: reranked[0]?.score ?? null,
        available: true,
        degradedReason: null,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (error) {
      this.recordFailure();
      const reason =
        error instanceof Error && error.name === 'AbortError'
          ? `Reranker exceeded its ${this.options.timeoutMs}ms budget.`
          : `Reranker unreachable: ${error instanceof Error ? error.message : String(error)}`;
      return this.fallback(candidates, topN, reason, started);
    } finally {
      clearTimeout(timer);
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= 5) {
      this.openUntil = Date.now() + 30_000;
      this.consecutiveFailures = 0;
    }
  }

  /**
   * Fall back to fusion order. `topScore` is deliberately null rather than borrowed from RRF:
   * fusion scores are not calibrated across queries, so reusing them as an abstention signal
   * would produce refusals that vary with corpus size rather than with evidence quality.
   */
  private fallback(
    candidates: ScoredChunk[],
    topN: number,
    reason: string,
    started: number,
  ): RerankOutcome {
    this.options.onDegraded?.(reason);
    return {
      chunks: candidates.slice(0, topN),
      topScore: null,
      available: false,
      degradedReason: reason,
      latencyMs: Math.round(performance.now() - started),
    };
  }
}

/**
 * No-op reranker for Phase 1 and for eval baselines.
 *
 * §11 recommends exactly this as the Phase 1 posture: "ship without it initially — RRF-only...
 * Acceptable for Phase 1; measure the delta on the golden set before deciding."
 */
export class NullReranker {
  async rerank(_query: string, candidates: ScoredChunk[], topN: number): Promise<RerankOutcome> {
    return {
      chunks: candidates.slice(0, topN),
      topScore: null,
      available: false,
      degradedReason: 'No reranker configured (RRF ordering).',
      latencyMs: 0,
    };
  }
}

export type RerankerLike = Pick<Reranker, 'rerank'>;
