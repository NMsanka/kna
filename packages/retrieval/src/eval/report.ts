import {
  minimumDetectableEffect,
  pairedBootstrap,
  recallAtK,
  reciprocalRank,
  type BootstrapComparison,
  type EvalItemResult,
  type EvalSummary,
  type IntentStratum,
} from './metrics.js';

/**
 * The CI gate.
 *
 * §15.5 — "gate merges on a CI eval reporting per-stratum deltas with confidence intervals".
 *
 * The gate is deliberately asymmetric. A significant *regression* in any stratum fails the
 * build; a non-significant improvement passes but is reported as "no evidence of change", which
 * is what it is. The asymmetry matters because the cost of the two errors is not symmetric: a
 * shipped regression degrades every query until someone notices, and an unshipped improvement
 * costs one more iteration.
 */

export interface GatePolicy {
  /** Regression beyond this, with a confidence interval excluding zero, fails the build. */
  maxRegression: number;
  /** Below this many items in a stratum, the result is reported but never gates. */
  minStratumSize: number;
  /** §15.5 — false-answer rate on unanswerable questions is a first-class metric with a target. */
  maxFalseAnswerRate: number;
  /** §15.5 latency budget: p50 under 1s to first token, p95 under 2.5s. */
  maxP95LatencyMs: number;
}

export const DEFAULT_GATE: GatePolicy = {
  maxRegression: 0.02,
  minStratumSize: 30,
  maxFalseAnswerRate: 0.1,
  maxP95LatencyMs: 2_500,
};

export interface GateResult {
  passed: boolean;
  comparisons: BootstrapComparison[];
  failures: string[];
  warnings: string[];
  report: string;
}

export function evaluateGate(
  baseline: EvalItemResult[],
  candidate: EvalItemResult[],
  summary: EvalSummary,
  policy: GatePolicy = DEFAULT_GATE,
): GateResult {
  const comparisons: BootstrapComparison[] = [];
  const failures: string[] = [];
  const warnings: string[] = [];

  const strata = [...new Set(baseline.map((b) => b.stratum))];

  for (const stratum of strata) {
    const baseSlice = baseline.filter((b) => b.stratum === stratum);
    const candSlice = candidate.filter((c) => c.stratum === stratum);

    for (const [name, metric] of [
      ['recall@10', (i: EvalItemResult) => recallAtK(i, 10)],
      ['mrr', reciprocalRank],
    ] as const) {
      const comparison = pairedBootstrap(baseSlice, candSlice, metric, {
        metricName: name,
        stratum,
      });
      comparisons.push(comparison);

      if (comparison.n < policy.minStratumSize) {
        warnings.push(
          `${stratum}/${name}: only ${comparison.n} item(s). Below ${policy.minStratumSize} this stratum cannot resolve the changes people actually make, so it is reported but does not gate.`,
        );
        continue;
      }

      if (comparison.significant && comparison.delta < -policy.maxRegression) {
        failures.push(
          `${stratum}/${name} regressed by ${(comparison.delta * 100).toFixed(1)} points ` +
            `(95% CI ${fmtCi(comparison.ci95)}), beyond the ${(policy.maxRegression * 100).toFixed(0)}-point tolerance.`,
        );
      }
    }
  }

  // §15.5 — the metric that catches confidently-wrong answers, which recall cannot see.
  const unanswerable = summary.strata.find((s) => s.stratum === 'unanswerable');
  if (unanswerable?.falseAnswerRate != null) {
    if (unanswerable.falseAnswerRate > policy.maxFalseAnswerRate) {
      failures.push(
        `False-answer rate on unanswerable questions is ${(unanswerable.falseAnswerRate * 100).toFixed(1)}%, ` +
          `above the ${(policy.maxFalseAnswerRate * 100).toFixed(0)}% target. Answering questions the corpus ` +
          `cannot support is the failure mode that loses a team permanently.`,
      );
    }
  } else {
    warnings.push(
      'No unanswerable stratum in this eval set. Without it, the false-answer rate is unmeasured and abstention is uncalibrated.',
    );
  }

  for (const stratum of summary.strata) {
    if (stratum.p95LatencyMs > policy.maxP95LatencyMs) {
      warnings.push(
        `${stratum.stratum}: p95 latency ${stratum.p95LatencyMs}ms exceeds the ${policy.maxP95LatencyMs}ms budget.`,
      );
    }
  }

  return {
    passed: failures.length === 0,
    comparisons,
    failures,
    warnings,
    report: render(summary, comparisons, failures, warnings, baseline),
  };
}

function render(
  summary: EvalSummary,
  comparisons: BootstrapComparison[],
  failures: string[],
  warnings: string[],
  baseline: EvalItemResult[],
): string {
  const lines: string[] = [];

  lines.push('# Retrieval eval');
  lines.push('');
  lines.push(`Config version: \`${summary.retrievalConfigVersion}\``);
  lines.push(
    `Items: ${summary.itemCount}${summary.quarantinedCount > 0 ? ` (${summary.quarantinedCount} quarantined)` : ''}`,
  );
  lines.push('');

  lines.push('## Per-stratum results');
  lines.push('');
  lines.push('| Stratum | n | recall@10 | MRR | P@5 | abstained | false-answer | p95 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const s of summary.strata) {
    lines.push(
      `| ${s.stratum} | ${s.n} | ${pct(s.recallAt10)} | ${s.mrr.toFixed(3)} | ${pct(s.precisionAt5)} | ` +
        `${pct(s.abstentionRate)} | ${s.falseAnswerRate == null ? '—' : pct(s.falseAnswerRate)} | ${s.p95LatencyMs}ms |`,
    );
  }
  lines.push('');

  if (comparisons.length > 0) {
    lines.push('## Change against baseline');
    lines.push('');
    lines.push('| Stratum | Metric | Baseline | Candidate | Delta | 95% CI | Verdict |');
    lines.push('|---|---|---:|---:|---:|---|---|');
    for (const c of comparisons) {
      const verdict = !c.significant
        ? 'no evidence of change'
        : c.delta > 0
          ? '**improved**'
          : '**regressed**';
      lines.push(
        `| ${c.stratum} | ${c.metric} | ${pct(c.baseline)} | ${pct(c.candidate)} | ` +
          `${c.delta >= 0 ? '+' : ''}${(c.delta * 100).toFixed(1)}pp | ${fmtCi(c.ci95)} | ${verdict} |`,
      );
    }
    lines.push('');
    lines.push(
      'A delta whose interval straddles zero is noise, whatever the point estimate says. ' +
        'That distinction is the difference between tuning and guessing.',
    );
    lines.push('');
  }

  // §15.5's underlying point is about statistical power, so the report states it outright.
  const mde = minimumDetectableEffect(baseline, (i) => recallAtK(i, 10));
  lines.push('## Power');
  lines.push('');
  lines.push(
    `With ${baseline.length} items, the smallest recall@10 change this set can resolve is about ` +
      `**${(mde * 100).toFixed(1)} points**.`,
  );
  if (mde > 0.03) {
    lines.push('');
    lines.push(
      '> Most real changes move 1–3 points. At this sample size they will be invisible, or will ' +
        'look like wins. Grow the set before trusting a small improvement.',
    );
  }
  lines.push('');

  if (failures.length > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const failure of failures) lines.push(`- ${failure}`);
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    for (const warning of warnings) lines.push(`- ${warning}`);
    lines.push('');
  }

  lines.push(failures.length === 0 ? '**Gate passed.**' : '**Gate failed.**');

  return lines.join('\n');
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function fmtCi([lower, upper]: [number, number]): string {
  return `[${(lower * 100).toFixed(1)}, ${(upper * 100).toFixed(1)}]pp`;
}

export type { IntentStratum };
