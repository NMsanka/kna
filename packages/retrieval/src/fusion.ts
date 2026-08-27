import type { CandidateRef, ScoredChunk } from './types.js';

/**
 * Reciprocal Rank Fusion and diversity.
 *
 * §8 puts RRF between the three retrieval arms and the reranker. RRF is chosen over score
 * normalisation for a specific reason: cosine similarity, `ts_rank` and an exact-match boolean
 * are not on comparable scales, and any attempt to normalise them introduces a tuning
 * parameter per arm that nobody will ever revisit. Rank is the one thing all three agree on.
 *
 * The corollary matters for §15.5's abstention design: RRF scores are *not* calibrated across
 * queries — a top RRF score of 0.05 means nothing in isolation. That is why the refusal
 * threshold is set on cross-encoder scores, which are absolutely calibratable, and why the
 * reranker-down degraded mode must also relax the abstention rule rather than reuse it.
 */

export interface FusionArm {
  name: string;
  candidates: CandidateRef[];
  /** Arms are not equal: an exact symbol-name hit is stronger evidence than a dense neighbour. */
  weight: number;
}

export interface FusionOptions {
  /** The RRF constant. 60 is the standard value and behaves well across arm-count changes. */
  k?: number;
  limit?: number;
}

export function reciprocalRankFusion(
  arms: FusionArm[],
  options: FusionOptions = {},
): CandidateRef[] {
  const k = options.k ?? 60;
  const scores = new Map<string, number>();

  for (const arm of arms) {
    for (const candidate of arm.candidates) {
      const contribution = arm.weight / (k + candidate.rank);
      scores.set(candidate.chunkId, (scores.get(candidate.chunkId) ?? 0) + contribution);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, options.limit ?? 100)
    .map(([chunkId, score], index) => ({ chunkId, rank: index + 1, score }));
}

/**
 * Maximal Marginal Relevance with a hard per-module cap.
 *
 * §15.5 HIGH — "enforce diversity (MMR or a hard per-module cap) between fusion and reranking."
 * Both are applied: MMR handles semantic near-duplication that SimHash missed (a DTO expressed
 * differently in two languages), and the module cap handles the structural case where one
 * monorepo package legitimately contains twelve similar handlers and would otherwise fill the
 * entire candidate set.
 */
export interface DiversifyOptions {
  /** 1.0 is pure relevance, 0.0 is pure diversity. 0.7 keeps relevance dominant. */
  lambda?: number;
  maxPerModule?: number;
  limit: number;
  /** Generated code is demoted, not dropped — sometimes it is the right answer (§15.5). */
  generatedPenalty?: number;
}

export function diversify(chunks: ScoredChunk[], options: DiversifyOptions): ScoredChunk[] {
  const lambda = options.lambda ?? 0.7;
  const maxPerModule = options.maxPerModule ?? 3;
  const generatedPenalty = options.generatedPenalty ?? 0.25;

  // Tokenise once up front: MMR is O(n·k) comparisons and re-splitting each chunk inside the
  // loop dominates the cost of the whole stage.
  const tokens = new Map<string, Set<string>>();
  for (const chunk of chunks) tokens.set(chunk.chunkId, tokenSet(chunk.content));

  const remaining = [...chunks];
  const selected: ScoredChunk[] = [];
  const perModule = new Map<string, number>();

  while (selected.length < options.limit && remaining.length > 0) {
    let bestIndex = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i]!;

      const diversityKey = candidate.moduleId ?? `repo:${candidate.repoId}:docs`;
      const used = perModule.get(diversityKey) ?? 0;
      if (used >= maxPerModule) continue;

      const relevance = candidate.score * (candidate.generated ? 1 - generatedPenalty : 1);
      const redundancy =
        selected.length === 0 ? 0 : maxSimilarity(tokens.get(candidate.chunkId)!, selected, tokens);
      const mmr = lambda * relevance - (1 - lambda) * redundancy;

      if (mmr > bestScore) {
        bestScore = mmr;
        bestIndex = i;
      }
    }

    // Every remaining candidate is module-capped: relax rather than return a short list, since
    // eight results from one module still beats three results total.
    if (bestIndex === -1) {
      const fallback = remaining.shift();
      if (!fallback) break;
      selected.push(fallback);
      continue;
    }

    const [chosen] = remaining.splice(bestIndex, 1);
    selected.push(chosen!);
    const diversityKey = chosen!.moduleId ?? `repo:${chosen!.repoId}:docs`;
    perModule.set(diversityKey, (perModule.get(diversityKey) ?? 0) + 1);
  }

  return selected;
}

/**
 * Similarity proxy over token sets. A real embedding-space comparison would be more accurate
 * but requires the vectors at rank time, which doubles the payload out of the database for a
 * decision that only needs to be roughly right.
 */
function maxSimilarity(
  candidateTokens: Set<string>,
  selected: ScoredChunk[],
  tokens: Map<string, Set<string>>,
): number {
  let max = 0;
  for (const other of selected) {
    const otherTokens = tokens.get(other.chunkId);
    if (!otherTokens) continue;
    const similarity = jaccard(candidateTokens, otherTokens);
    if (similarity > max) max = similarity;
  }
  return max;
}

export function tokenSet(content: string): Set<string> {
  return new Set(
    content
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}
