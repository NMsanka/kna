import { randomUUID } from 'node:crypto';
import type { LlmClient } from '@kna/llm';
import {
  DEFAULT_ABSTENTION_POLICY,
  evaluateAbstention,
  type AbstentionPolicy,
} from './abstention.js';
import { diversify, reciprocalRankFusion, type FusionArm } from './fusion.js';
import { expandWithBudget, fitPrimaryToBudget } from './expansion.js';
import { ARM_WEIGHTS_BY_INTENT, understandQuery } from './query.js';
import {
  computeConfigVersion,
  DEFAULT_RETRIEVAL_CONFIG,
  type RetrievalConfig,
} from './config-version.js';
import type { RetrievalStore } from './store.js';
import type { RerankerLike } from './reranker.js';
import {
  DEFAULT_CONTEXT_BUDGET,
  type ContextBudget,
  type RetrievalRequest,
  type RetrievalResult,
  type RetrievalTrace,
  type ScoredChunk,
} from './types.js';

/**
 * The retrieval pipeline (§8).
 *
 *   Query
 *     ├─► Dense search    (pgvector cosine, k=50)
 *     ├─► BM25 / tsvector (exact identifiers, k=50)
 *     └─► Symbol exact    (direct IR lookup, k=10)
 *              ▼
 *      Reciprocal Rank Fusion
 *              ▼
 *      Diversity (MMR + per-module cap)      ← §15.5, before reranking
 *              ▼
 *      Cross-encoder rerank (top 50 → top 8)
 *              ▼
 *      Graph expansion — callers, callees, type definitions, within budget
 *              ▼
 *      Context assembly with provenance
 *
 * Everything the reviews added sits in the same flow rather than beside it: multi-turn rewrite
 * ahead of the arms, diversity between fusion and rerank, a token budget around expansion, an
 * abstention gate before anything reaches a model, and a full replayable trace emitted whatever
 * the outcome.
 */

export interface RetrievalPipelineOptions {
  store: RetrievalStore;
  reranker: RerankerLike;
  llm?: LlmClient;
  embed: (query: string) => Promise<number[]>;
  config?: RetrievalConfig;
  budget?: ContextBudget;
  abstentionPolicy?: AbstentionPolicy;
  onDegraded?: (mode: string) => void;
}

export class RetrievalPipeline {
  private readonly config: RetrievalConfig;
  private readonly budget: ContextBudget;
  private readonly abstentionPolicy: AbstentionPolicy;

  constructor(private readonly options: RetrievalPipelineOptions) {
    this.config = options.config ?? DEFAULT_RETRIEVAL_CONFIG;
    this.budget = options.budget ?? DEFAULT_CONTEXT_BUDGET;
    this.abstentionPolicy = options.abstentionPolicy ?? DEFAULT_ABSTENTION_POLICY;
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalResult> {
    const traceId = randomUUID();
    const timings: Record<string, number> = {};
    const tokens: Record<string, number> = {};
    const degradedModes: string[] = [];
    const configVersion = computeConfigVersion(this.config).version;

    const emptyTrace = (): RetrievalTrace => ({
      traceId,
      rawQuery: request.query,
      rewrittenQuery: null,
      intentClass: 'conceptual',
      scope: request.scope,
      denseCandidates: [],
      lexicalCandidates: [],
      symbolCandidates: [],
      fusedCandidates: [],
      rerankedCandidates: [],
      servedChunkIds: [],
      expansionChunkIds: [],
      stageTimingsMs: timings,
      stageTokens: tokens,
      topRerankScore: null,
      retrievalConfigVersion: configVersion,
      embeddingModel: this.config.embeddingModel,
    });

    // ── Stage 1: understand the query ──────────────────────────────────────────────────────
    const understanding = await time(timings, 'understand', () =>
      understandQuery(request.query, {
        ...(this.options.llm ? { client: this.options.llm } : {}),
        orgId: request.access.orgId,
        ...(request.history ? { history: request.history } : {}),
        ...(request.sessionSymbolIds ? { sessionSymbolNames: request.sessionSymbolIds } : {}),
      }),
    );

    const searchQuery = understanding.rewrittenQuery ?? request.query;
    tokens.query = Math.ceil(searchQuery.length / 3.5);

    if (!understanding.needsRetrieval) {
      // §15.5's "no new retrieval needed" classifier: the conversation already holds the answer.
      return {
        chunks: [],
        abstain: false,
        abstentionReason: null,
        requiresHedging: false,
        hedgingReason: null,
        intentClass: understanding.intentClass,
        rewrittenQuery: understanding.rewrittenQuery,
        degradedModes,
        trace: {
          ...emptyTrace(),
          rewrittenQuery: understanding.rewrittenQuery,
          intentClass: understanding.intentClass,
        },
      };
    }

    const weights = ARM_WEIGHTS_BY_INTENT[understanding.intentClass];
    const searchOptions = {
      scope: request.scope,
      access: request.access,
      embeddingModel: this.config.embeddingModel,
      efSearch: this.config.efSearch,
      corpora: weights.corpora,
    };

    // ── Stage 2: three arms, in parallel ───────────────────────────────────────────────────
    const [dense, lexical, symbolHits] = await Promise.all([
      time(timings, 'dense', async () => {
        const vector = await this.options.embed(searchQuery);
        return this.options.store.denseSearch(vector, this.config.topKDense, searchOptions);
      }).catch((error: unknown) => {
        // Embeddings down. §15.6's named degraded mode keeps the other arms serving rather
        // than failing the request: lexical and symbol lookup need no provider at all.
        degradedModes.push('embeddings-unavailable');
        this.options.onDegraded?.('embeddings-unavailable');
        void error;
        return [];
      }),
      time(timings, 'lexical', () =>
        this.options.store.lexicalSearch(searchQuery, this.config.topKLexical, searchOptions),
      ),
      time(timings, 'symbol', () =>
        this.options.store.symbolSearch(
          understanding.identifiers,
          this.config.topKSymbol,
          searchOptions,
        ),
      ),
    ]);

    const arms: FusionArm[] = [
      { name: 'dense', candidates: dense, weight: weights.dense },
      { name: 'lexical', candidates: lexical, weight: weights.lexical },
      { name: 'symbol', candidates: symbolHits, weight: weights.symbol },
    ];

    // ── Stage 3: fusion ────────────────────────────────────────────────────────────────────
    const fused = reciprocalRankFusion(arms, {
      k: this.config.rrfK,
      limit: Math.max(this.config.topKDense, this.config.topKLexical),
    });

    if (fused.length === 0) {
      const verdict = evaluateAbstention({
        chunks: [],
        topRerankScore: null,
        rerankerAvailable: true,
        policy: this.abstentionPolicy,
      });
      return {
        chunks: [],
        abstain: verdict.abstain,
        abstentionReason: verdict.reason,
        requiresHedging: false,
        hedgingReason: null,
        intentClass: understanding.intentClass,
        rewrittenQuery: understanding.rewrittenQuery,
        degradedModes,
        trace: {
          ...emptyTrace(),
          rewrittenQuery: understanding.rewrittenQuery,
          intentClass: understanding.intentClass,
          denseCandidates: dense,
          lexicalCandidates: lexical,
          symbolCandidates: symbolHits,
        },
      };
    }

    const hydrated = await time(timings, 'hydrate', () =>
      this.options.store.hydrate(fused, searchOptions),
    );

    // Session continuity: symbols already resolved in this conversation are boosted, so
    // "what about the async version?" stays anchored to the thing under discussion (§15.5).
    const sessionSymbols = new Set(request.sessionSymbolIds ?? []);
    const boosted = hydrated.map((chunk) =>
      chunk.symbolId && sessionSymbols.has(chunk.symbolId)
        ? { ...chunk, score: chunk.score * 1.15 }
        : chunk,
    );

    // ── Stage 4: diversity, BEFORE reranking ───────────────────────────────────────────────
    // §15.5 — otherwise eight byte-similar chunks from five repos reduce effective top-8 to
    // effective top-1, and the reranker faithfully ranks eight copies of the same answer.
    const diversified = time.sync(timings, 'diversify', () =>
      diversify(boosted, {
        lambda: this.config.mmrLambda,
        maxPerModule: this.config.maxPerModule,
        generatedPenalty: this.config.generatedPenalty,
        limit: Math.min(50, boosted.length),
      }),
    );

    // ── Stage 5: rerank ────────────────────────────────────────────────────────────────────
    const topN = request.topN ?? this.config.topNFinal;
    const rerank = request.disableRerank
      ? {
          chunks: diversified.slice(0, topN),
          topScore: null,
          available: false,
          degradedReason: null,
          latencyMs: 0,
        }
      : await this.options.reranker.rerank(searchQuery, diversified, topN);

    timings.rerank = rerank.latencyMs;
    if (!rerank.available && !request.disableRerank) {
      degradedModes.push('reranker-unavailable');
      this.options.onDegraded?.('reranker-unavailable');
    }

    // ── Stage 6: budget the primary results, then expand within what is left ───────────────
    const primary = fitPrimaryToBudget(rerank.chunks, this.budget);
    tokens.primary = primary.tokensUsed;

    let expansionChunks: ScoredChunk[] = [];
    if (!request.disableGraphExpansion) {
      const seedSymbolIds = primary.kept
        .map((c) => c.symbolId)
        .filter((id): id is string => id !== null);

      const neighboursBySymbol = await time(timings, 'neighbours', () =>
        this.options.store.neighbours(seedSymbolIds, searchOptions),
      );

      // Re-key by chunk id, since expansion budgets per seed chunk rather than per symbol.
      const neighboursBySeed = new Map(
        primary.kept
          .filter((c) => c.symbolId)
          .map((c) => [c.chunkId, neighboursBySymbol.get(c.symbolId!) ?? []] as const),
      );

      const expansion = time.sync(timings, 'expand', () =>
        expandWithBudget(primary.kept, neighboursBySeed, {
          budget: this.budget,
          primaryTokens: primary.tokensUsed,
          maxNeighboursPerSeed: this.config.expansionMaxPerSeed,
          centralityCeiling: this.config.expansionCentralityCeiling,
        }),
      );
      expansionChunks = expansion.chunks;
      tokens.expansion = expansion.tokensUsed;
    }

    // ── Stage 7: abstention gate ───────────────────────────────────────────────────────────
    const staleRepoIds = await this.options.store
      .staleRepoIds(request.access.orgId, [...new Set(primary.kept.map((c) => c.repoId))])
      .catch(() => [] as string[]);

    const verdict = evaluateAbstention({
      chunks: primary.kept,
      topRerankScore: rerank.topScore,
      rerankerAvailable: rerank.available,
      policy: this.abstentionPolicy,
      staleRepoIds,
    });

    const served = [...primary.kept, ...expansionChunks];

    return {
      chunks: verdict.abstain ? [] : served,
      abstain: verdict.abstain,
      abstentionReason: verdict.reason,
      requiresHedging: verdict.requiresHedging,
      hedgingReason: verdict.hedgingReason,
      intentClass: understanding.intentClass,
      rewrittenQuery: understanding.rewrittenQuery,
      degradedModes,
      trace: {
        traceId,
        rawQuery: request.query,
        rewrittenQuery: understanding.rewrittenQuery,
        intentClass: understanding.intentClass,
        scope: request.scope,
        denseCandidates: dense,
        lexicalCandidates: lexical,
        symbolCandidates: symbolHits,
        fusedCandidates: fused,
        rerankedCandidates: rerank.chunks.map((c, i) => ({
          chunkId: c.chunkId,
          rank: i + 1,
          score: c.score,
        })),
        // What actually survived truncation — §15.5 calls this out specifically, because it is
        // usually the difference between a good answer and a baffling one.
        servedChunkIds: primary.kept.map((c) => c.chunkId),
        expansionChunkIds: expansionChunks.map((c) => c.chunkId),
        stageTimingsMs: timings,
        stageTokens: tokens,
        topRerankScore: rerank.topScore,
        retrievalConfigVersion: configVersion,
        embeddingModel: this.config.embeddingModel,
      },
    };
  }
}

/** Timing helper that records into the trace whether the stage succeeds or throws. */
async function time<T>(
  into: Record<string, number>,
  stage: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    into[stage] = Math.round(performance.now() - started);
  }
}

time.sync = function timeSync<T>(into: Record<string, number>, stage: string, fn: () => T): T {
  const started = performance.now();
  try {
    return fn();
  } finally {
    into[stage] = Math.round(performance.now() - started);
  }
};
