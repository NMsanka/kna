/**
 * Retrieval metrics, with confidence intervals.
 *
 * §15.5 BLOCKER — "The eval set as specified is statistically underpowered. At n=100
 * unstratified, a paired bootstrap resolves recall@10 deltas of only ~5–8 points; most real
 * changes move 1–3 points and will be invisible or look like wins."
 *
 * Two consequences shape this module:
 *
 *  - Every metric is reported **per intent stratum**, not as a single number. A change that
 *    improves exact-identifier lookup and degrades cross-repo call paths nets to "no change" in
 *    aggregate, which is the least useful thing it could tell you.
 *  - Every comparison is a **paired bootstrap** with a confidence interval. A point estimate
 *    that moved 2 points is not evidence, and reporting it as one is how a team spends a
 *    quarter tuning noise.
 */

export type IntentStratum =
  | 'exact-identifier'
  | 'cross-repo-call-path'
  | 'why-rationale'
  | 'how-to-integrate'
  | 'unanswerable';

export interface EvalItemResult {
  itemId: string;
  stratum: IntentStratum;
  /** Chunk or symbol ids that should have been retrieved. Empty for unanswerable items. */
  expected: string[];
  /** What was actually returned, in rank order. */
  retrieved: string[];
  /** True when the system declined to answer. */
  abstained: boolean;
  latencyMs: number;
  tokensIn: number;
}

export interface StratumMetrics {
  stratum: IntentStratum;
  n: number;
  recallAt10: number;
  mrr: number;
  precisionAt5: number;
  /**
   * §15.5 — "track **false-answer rate on unanswerable questions** as a first-class metric with
   * a target." Answering an unanswerable question confidently is the failure that costs trust,
   * and it is invisible in recall.
   */
  falseAnswerRate: number | null;
  abstentionRate: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
}

export interface EvalSummary {
  strata: StratumMetrics[];
  overall: Omit<StratumMetrics, 'stratum'>;
  retrievalConfigVersion: string;
  itemCount: number;
  quarantinedCount: number;
}

export function summarise(
  results: EvalItemResult[],
  retrievalConfigVersion: string,
  quarantinedCount = 0,
): EvalSummary {
  const byStratum = new Map<IntentStratum, EvalItemResult[]>();
  for (const result of results) {
    const list = byStratum.get(result.stratum) ?? [];
    list.push(result);
    byStratum.set(result.stratum, list);
  }

  const strata = [...byStratum.entries()].map(([stratum, items]) => computeMetrics(stratum, items));

  return {
    strata: strata.sort((a, b) => a.stratum.localeCompare(b.stratum)),
    overall: { ...computeMetrics('exact-identifier', results), stratum: undefined } as never,
    retrievalConfigVersion,
    itemCount: results.length,
    quarantinedCount,
  };
}

function computeMetrics(stratum: IntentStratum, items: EvalItemResult[]): StratumMetrics {
  const answerable = items.filter((i) => i.expected.length > 0);
  const unanswerable = items.filter((i) => i.expected.length === 0);

  const latencies = items.map((i) => i.latencyMs).sort((a, b) => a - b);

  return {
    stratum,
    n: items.length,
    recallAt10: mean(answerable.map((i) => recallAtK(i, 10))),
    mrr: mean(answerable.map((i) => reciprocalRank(i))),
    precisionAt5: mean(answerable.map((i) => precisionAtK(i, 5))),
    // Only meaningful for the unanswerable stratum; null elsewhere rather than zero, so a
    // dashboard cannot silently average it into something reassuring.
    falseAnswerRate:
      unanswerable.length > 0
        ? unanswerable.filter((i) => !i.abstained).length / unanswerable.length
        : null,
    abstentionRate: items.length > 0 ? items.filter((i) => i.abstained).length / items.length : 0,
    p50LatencyMs: percentile(latencies, 0.5),
    p95LatencyMs: percentile(latencies, 0.95),
  };
}

export function recallAtK(item: EvalItemResult, k: number): number {
  if (item.expected.length === 0) return 0;
  const topK = new Set(item.retrieved.slice(0, k));
  const hits = item.expected.filter((id) => topK.has(id)).length;
  return hits / item.expected.length;
}

export function precisionAtK(item: EvalItemResult, k: number): number {
  const topK = item.retrieved.slice(0, k);
  if (topK.length === 0) return 0;
  const expected = new Set(item.expected);
  return topK.filter((id) => expected.has(id)).length / topK.length;
}

export function reciprocalRank(item: EvalItemResult): number {
  const expected = new Set(item.expected);
  const index = item.retrieved.findIndex((id) => expected.has(id));
  return index === -1 ? 0 : 1 / (index + 1);
}

/**
 * Paired bootstrap.
 *
 * Paired because the two configurations are evaluated on the *same* items: comparing
 * independent samples throws away the pairing and needs far more items for the same power. The
 * output is a confidence interval on the delta, which is the only form in which a 2-point move
 * can be honestly reported.
 */
export interface BootstrapComparison {
  stratum: IntentStratum | 'overall';
  metric: string;
  baseline: number;
  candidate: number;
  delta: number;
  ci95: [number, number];
  /** True when the interval excludes zero — the only case where "improved" is a claim. */
  significant: boolean;
  n: number;
}

export function pairedBootstrap(
  baseline: EvalItemResult[],
  candidate: EvalItemResult[],
  metric: (item: EvalItemResult) => number,
  options: { iterations?: number; metricName?: string; stratum?: IntentStratum | 'overall' } = {},
): BootstrapComparison {
  const iterations = options.iterations ?? 2_000;

  const byId = new Map(candidate.map((c) => [c.itemId, c]));
  const pairs: Array<[number, number]> = [];
  for (const base of baseline) {
    const cand = byId.get(base.itemId);
    if (cand) pairs.push([metric(base), metric(cand)]);
  }

  if (pairs.length === 0) {
    return {
      stratum: options.stratum ?? 'overall',
      metric: options.metricName ?? 'metric',
      baseline: 0,
      candidate: 0,
      delta: 0,
      ci95: [0, 0],
      significant: false,
      n: 0,
    };
  }

  const baselineMean = mean(pairs.map(([b]) => b));
  const candidateMean = mean(pairs.map(([, c]) => c));

  const deltas: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < pairs.length; j++) {
      const [b, c] = pairs[Math.floor(Math.random() * pairs.length)]!;
      sum += c - b;
    }
    deltas.push(sum / pairs.length);
  }
  deltas.sort((a, b) => a - b);

  const lower = percentile(deltas, 0.025);
  const upper = percentile(deltas, 0.975);

  return {
    stratum: options.stratum ?? 'overall',
    metric: options.metricName ?? 'metric',
    baseline: baselineMean,
    candidate: candidateMean,
    delta: candidateMean - baselineMean,
    ci95: [lower, upper],
    // The whole point: a delta whose interval straddles zero is not evidence of anything.
    significant: (lower > 0 && upper > 0) || (lower < 0 && upper < 0),
    n: pairs.length,
  };
}

/**
 * Minimum detectable effect, given the current sample.
 *
 * Surfaced in the report because §15.5's finding is fundamentally about power: a team that
 * cannot see this number will keep making 2-point changes against a set that can only resolve
 * 6-point ones, and will keep believing the results.
 */
export function minimumDetectableEffect(
  results: EvalItemResult[],
  metric: (i: EvalItemResult) => number,
): number {
  const values = results.map(metric);
  if (values.length < 2) return 1;
  const sd = Math.sqrt(variance(values));
  // Roughly 2.8 standard errors for 80% power at alpha 0.05, two-sided.
  return (2.8 * sd) / Math.sqrt(values.length);
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(Math.floor(p * sorted.length), sorted.length - 1);
  return sorted[index]!;
}
