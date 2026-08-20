import type { IrDiff } from './types.js';

/**
 * §15.3 BLOCKER — "no magnitude circuit breaker; one codemod causes a cost and PR storm".
 *
 * A formatter upgrade, a namespace rename, or an SDK bump that shifts inferred types flips
 * `signatureHash` on 100k+ symbols at once. Without an admission check that fans out into mass
 * regeneration, mass embedding, and hundreds of simultaneous doc PRs assigned to real people —
 * which is exactly how the tool gets switched off.
 *
 * The check runs *before* fan-out, not during it. Halting mid-write leaves a partially
 * reindexed corpus, which is worse than never starting.
 */
export interface CircuitBreakerPolicy {
  /** Fraction of the repo's symbols that may change before the breaker trips. */
  maxChurnRatio: number;
  /** Absolute count that trips regardless of ratio — protects small repos from ratio noise
   *  and huge repos from an unreasonable absolute cost. */
  maxChangedSymbols: number;
  /** Doc-regeneration jobs that may be queued from one commit. */
  maxRegenerations: number;
  /** A first index of a new repo is legitimately 100% churn; exempt it explicitly. */
  exemptFirstIndex: boolean;
  /** Repos below this symbol count never trip the ratio rule. */
  smallRepoFloor: number;
}

export const DEFAULT_CIRCUIT_BREAKER: CircuitBreakerPolicy = {
  maxChurnRatio: 0.25,
  maxChangedSymbols: 2_000,
  maxRegenerations: 50,
  exemptFirstIndex: true,
  smallRepoFloor: 50,
};

export type BreakerVerdict =
  | { tripped: false; policy: CircuitBreakerPolicy }
  | {
      tripped: true;
      policy: CircuitBreakerPolicy;
      /** Machine-readable rule, for the alert and the operator console. */
      rule: 'churn-ratio' | 'absolute-count' | 'regeneration-count';
      reason: string;
      /** What the operator is being asked to approve, in plain numbers. */
      observed: { changed: number; churnRatio: number; regenerations: number; total: number };
    };

export function evaluateCircuitBreaker(
  diff: IrDiff,
  policy: CircuitBreakerPolicy = DEFAULT_CIRCUIT_BREAKER,
): BreakerVerdict {
  const { totals } = diff;
  const changed = totals.added + totals.removed + totals.changed;
  const observed = {
    changed,
    churnRatio: totals.churnRatio,
    regenerations: totals.regenerateCount,
    total: totals.symbolsAfter,
  };

  const isFirstIndex = diff.fromCommitSha === null;
  if (isFirstIndex && policy.exemptFirstIndex) {
    return { tripped: false, policy };
  }

  if (changed > policy.maxChangedSymbols) {
    return {
      tripped: true,
      policy,
      rule: 'absolute-count',
      reason: `${changed} symbols changed in one commit (limit ${policy.maxChangedSymbols}). This looks like a codemod, a formatter upgrade, or an SDK bump that shifted inferred types.`,
      observed,
    };
  }

  if (totals.symbolsAfter >= policy.smallRepoFloor && totals.churnRatio > policy.maxChurnRatio) {
    return {
      tripped: true,
      policy,
      rule: 'churn-ratio',
      reason: `${(totals.churnRatio * 100).toFixed(1)}% of the repo changed in one commit (limit ${(policy.maxChurnRatio * 100).toFixed(0)}%).`,
      observed,
    };
  }

  if (totals.regenerateCount > policy.maxRegenerations) {
    return {
      tripped: true,
      policy,
      rule: 'regeneration-count',
      reason: `${totals.regenerateCount} documents would be regenerated from one commit (limit ${policy.maxRegenerations}); this would open a PR storm.`,
      observed,
    };
  }

  return { tripped: false, policy };
}

/**
 * Reindexing is safe to continue even when regeneration is halted: the vector index reflects
 * reality rather than asserting anything (§7, "two latencies, deliberately different"). So a
 * tripped breaker degrades to index-only rather than stopping the pipeline entirely — unless
 * the trip was on raw magnitude, where the embedding spend itself is the concern.
 */
export function degradedPlan(verdict: BreakerVerdict): {
  reindex: boolean;
  regenerate: boolean;
  requiresOperatorApproval: boolean;
} {
  if (!verdict.tripped) {
    return { reindex: true, regenerate: true, requiresOperatorApproval: false };
  }
  return {
    reindex: verdict.rule === 'regeneration-count',
    regenerate: false,
    requiresOperatorApproval: true,
  };
}
