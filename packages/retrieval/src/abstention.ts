import type { ScoredChunk } from './types.js';

/**
 * Abstention (§15.5 BLOCKER).
 *
 * "There is no abstention path. Documentation generation is protected by deterministic-first,
 * but the chat path has no equivalent: weak retrieval flows into the model identically to
 * strong retrieval. That is precisely how you produce the confident-and-wrong answer §16 says
 * loses a team permanently."
 *
 * Two design constraints follow directly:
 *
 *  - The threshold is calibrated on **cross-encoder scores**, which are absolutely comparable
 *    across queries. RRF ranks are not — a top RRF score of 0.05 is meaningless in isolation —
 *    so when the reranker is unavailable the rule changes rather than silently degrading.
 *  - `false-answer rate on unanswerable questions` is a first-class metric with a target, so
 *    the threshold is a tunable calibrated against a labelled unanswerable set, not a guess.
 */

export interface AbstentionPolicy {
  /** Calibrated against the labelled unanswerable stratum of the eval set. */
  rerankThreshold: number;
  /** Used only in the reranker-down degraded mode. Deliberately conservative. */
  minChunksWithoutReranker: number;
  /** Below this many results, even good scores are suspicious for a "how does X work" query. */
  minChunks: number;
}

export const DEFAULT_ABSTENTION_POLICY: AbstentionPolicy = {
  rerankThreshold: 0.35,
  minChunksWithoutReranker: 3,
  minChunks: 1,
};

export interface AbstentionInput {
  chunks: ScoredChunk[];
  topRerankScore: number | null;
  rerankerAvailable: boolean;
  policy?: AbstentionPolicy;
  /** Repos in scope that are known stale, from the reconciliation sweep (§7). */
  staleRepoIds?: string[];
}

export interface AbstentionVerdict {
  abstain: boolean;
  reason: string | null;
  /**
   * §15.5 — "force hedged phrasing when evidence comes only from `analysisDepth: 'shallow'`
   * modules or a repo marked stale." Hedging is not abstention: the answer is still given, but
   * the assistant must say what it is standing on.
   */
  requiresHedging: boolean;
  hedgingReason: string | null;
}

export function evaluateAbstention(input: AbstentionInput): AbstentionVerdict {
  const policy = input.policy ?? DEFAULT_ABSTENTION_POLICY;

  if (input.chunks.length < policy.minChunks) {
    return {
      abstain: true,
      reason: 'No evidence was retrieved within the caller’s scope.',
      requiresHedging: false,
      hedgingReason: null,
    };
  }

  if (input.rerankerAvailable) {
    if (input.topRerankScore === null || input.topRerankScore < policy.rerankThreshold) {
      return {
        abstain: true,
        reason: `Best evidence scored ${(input.topRerankScore ?? 0).toFixed(3)} against a calibrated threshold of ${policy.rerankThreshold}. Answering from evidence this weak is how confidently wrong answers get produced.`,
        requiresHedging: false,
        hedgingReason: null,
      };
    }
  } else {
    // Reranker down. RRF scores are not calibrated across queries, so the threshold cannot
    // simply be reused — substitute a structural signal instead of a numeric one.
    if (input.chunks.length < policy.minChunksWithoutReranker) {
      return {
        abstain: true,
        reason: `The reranker is unavailable and only ${input.chunks.length} candidate(s) were retrieved. Fusion scores are not comparable across queries, so weak evidence cannot be distinguished from strong evidence right now.`,
        requiresHedging: false,
        hedgingReason: null,
      };
    }
  }

  const hedging = evaluateHedging(input);
  return { abstain: false, reason: null, ...hedging };
}

function evaluateHedging(input: AbstentionInput): {
  requiresHedging: boolean;
  hedgingReason: string | null;
} {
  const reasons: string[] = [];

  const allShallow = input.chunks.every((c) => c.analysisDepth === 'shallow');
  if (allShallow) {
    reasons.push(
      'every supporting symbol came from shallow analysis — signatures as written, types not resolved',
    );
  }

  const staleRepos = new Set(input.staleRepoIds ?? []);
  const touchedStale = [...new Set(input.chunks.map((c) => c.repoId))].filter((r) =>
    staleRepos.has(r),
  );
  if (touchedStale.length > 0) {
    reasons.push(`${touchedStale.length} supporting repo(s) are behind their latest commit`);
  }

  const allGenerated = input.chunks.every((c) => c.generated);
  if (allGenerated) {
    reasons.push('all evidence came from machine-generated code');
  }

  if (!input.rerankerAvailable) {
    reasons.push('results are ordered by fusion score only');
  }

  return reasons.length > 0
    ? { requiresHedging: true, hedgingReason: reasons.join('; ') }
    : { requiresHedging: false, hedgingReason: null };
}

/**
 * The refusal a user actually sees.
 *
 * Deliberately actionable rather than apologetic: the most valuable thing an abstention can do
 * is tell the user what *would* answer the question, and — per §15.5's feedback taxonomy —
 * route a genuine gap into the documentation backlog rather than into a shrug.
 */
export function renderAbstention(verdict: AbstentionVerdict, query: string): string {
  return [
    "I don't have enough in the index to answer that reliably.",
    '',
    verdict.reason ?? '',
    '',
    'What would help:',
    '- If this concerns a repo that has not been onboarded, it will not be searchable yet.',
    '- If you know the symbol or endpoint name, searching for it directly usually resolves faster.',
    `- If the answer genuinely is not written down anywhere, flag this — "${truncate(query, 60)}" becomes a documentation backlog item rather than a dead end.`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * Hedge wording. Kept as a prefix rather than left to the model, because a system prompt asking
 * a model to hedge is a suggestion, and this needs to be a guarantee.
 */
export function renderHedge(reason: string): string {
  return `A note on confidence: ${reason}. Treat the following as a starting point rather than a settled answer.`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
