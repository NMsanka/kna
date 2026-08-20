import { describe, expect, it } from 'vitest';
import {
  minimumDetectableEffect,
  pairedBootstrap,
  precisionAtK,
  recallAtK,
  reciprocalRank,
  summarise,
  type EvalItemResult,
  type IntentStratum,
} from './metrics.js';
import { DEFAULT_GATE, evaluateGate } from './report.js';

function item(overrides: Partial<EvalItemResult> = {}): EvalItemResult {
  return {
    itemId: overrides.itemId ?? `item_${Math.random().toString(36).slice(2, 8)}`,
    stratum: 'exact-identifier',
    expected: ['chk_1'],
    retrieved: ['chk_1', 'chk_2', 'chk_3'],
    abstained: false,
    latencyMs: 400,
    tokensIn: 2000,
    ...overrides,
  };
}

function stratum(name: IntentStratum, count: number, hitRate: number): EvalItemResult[] {
  return Array.from({ length: count }, (_, i) =>
    item({
      itemId: `${name}_${i}`,
      stratum: name,
      expected: ['gold'],
      retrieved: i / count < hitRate ? ['gold', 'other'] : ['other', 'another'],
    }),
  );
}

describe('metrics', () => {
  it('computes recall@k over the expected set', () => {
    expect(recallAtK(item({ expected: ['a', 'b'], retrieved: ['a', 'x', 'b'] }), 10)).toBe(1);
    expect(recallAtK(item({ expected: ['a', 'b'], retrieved: ['a', 'x'] }), 10)).toBe(0.5);
    expect(recallAtK(item({ expected: ['a'], retrieved: ['x', 'y'] }), 10)).toBe(0);
  });

  it('respects the k cutoff', () => {
    const result = item({ expected: ['a'], retrieved: ['x', 'y', 'z', 'a'] });
    expect(recallAtK(result, 3)).toBe(0);
    expect(recallAtK(result, 4)).toBe(1);
  });

  it('computes reciprocal rank from the first hit', () => {
    expect(reciprocalRank(item({ expected: ['a'], retrieved: ['a', 'b'] }))).toBe(1);
    expect(reciprocalRank(item({ expected: ['a'], retrieved: ['b', 'a'] }))).toBe(0.5);
    expect(reciprocalRank(item({ expected: ['a'], retrieved: ['b', 'c'] }))).toBe(0);
  });

  it('computes precision@k', () => {
    expect(
      precisionAtK(item({ expected: ['a', 'b'], retrieved: ['a', 'b', 'x', 'y', 'z'] }), 5),
    ).toBe(0.4);
  });
});

describe('summarise', () => {
  it('reports per stratum rather than as one number', () => {
    // The point of stratification: a change that helps one intent and hurts another nets to
    // "no change" in aggregate, which is the least useful thing it could say.
    const results = [...stratum('exact-identifier', 40, 0.9), ...stratum('why-rationale', 40, 0.3)];
    const summary = summarise(results, 'v1');

    const exact = summary.strata.find((s) => s.stratum === 'exact-identifier')!;
    const why = summary.strata.find((s) => s.stratum === 'why-rationale')!;

    expect(exact.recallAt10).toBeGreaterThan(0.8);
    expect(why.recallAt10).toBeLessThan(0.4);
  });

  it('tracks false-answer rate only on the unanswerable stratum', () => {
    const results = [
      ...stratum('exact-identifier', 10, 1),
      // Four unanswerable items; one was answered anyway.
      ...Array.from({ length: 4 }, (_, i) =>
        item({
          itemId: `un_${i}`,
          stratum: 'unanswerable',
          expected: [],
          retrieved: [],
          abstained: i > 0,
        }),
      ),
    ];

    const summary = summarise(results, 'v1');
    expect(summary.strata.find((s) => s.stratum === 'unanswerable')!.falseAnswerRate).toBe(0.25);
    // Null, not zero: a dashboard must not average a meaningless value into something reassuring.
    expect(
      summary.strata.find((s) => s.stratum === 'exact-identifier')!.falseAnswerRate,
    ).toBeNull();
  });
});

describe('paired bootstrap', () => {
  it('reports a large consistent improvement as significant', () => {
    const baseline = stratum('exact-identifier', 100, 0.4);
    const candidate = baseline.map((b) => ({ ...b, retrieved: ['gold', 'other'] }));

    const comparison = pairedBootstrap(baseline, candidate, (i) => recallAtK(i, 10), {
      metricName: 'recall@10',
    });

    expect(comparison.delta).toBeGreaterThan(0.4);
    expect(comparison.significant).toBe(true);
    expect(comparison.ci95[0]).toBeGreaterThan(0);
  });

  it('does not call a tiny difference significant', () => {
    const baseline = stratum('exact-identifier', 100, 0.5);
    // One item flips. A point estimate would show +1pp; the interval should straddle zero.
    const candidate = baseline.map((b, i) => (i === 0 ? { ...b, retrieved: ['gold'] } : b));

    const comparison = pairedBootstrap(baseline, candidate, (i) => recallAtK(i, 10), {
      metricName: 'recall@10',
    });

    expect(comparison.significant).toBe(false);
  });

  it('pairs on item id rather than position', () => {
    const baseline = stratum('exact-identifier', 20, 0.5);
    // Same items, shuffled. Pairing must survive it.
    const candidate = [...baseline].reverse();

    const comparison = pairedBootstrap(baseline, candidate, (i) => recallAtK(i, 10));
    expect(comparison.delta).toBe(0);
    expect(comparison.n).toBe(20);
  });
});

describe('minimum detectable effect', () => {
  it('shrinks as the sample grows', () => {
    const small = stratum('exact-identifier', 30, 0.5);
    const large = stratum('exact-identifier', 400, 0.5);

    const mdeSmall = minimumDetectableEffect(small, (i) => recallAtK(i, 10));
    const mdeLarge = minimumDetectableEffect(large, (i) => recallAtK(i, 10));

    expect(mdeLarge).toBeLessThan(mdeSmall);
  });

  it('shows that n=100 cannot resolve the changes people actually make', () => {
    // §15.5's finding, made concrete: at this size, a 1–3 point change is invisible.
    const underpowered = stratum('exact-identifier', 100, 0.5);
    const mde = minimumDetectableEffect(underpowered, (i) => recallAtK(i, 10));
    expect(mde).toBeGreaterThan(0.03);
  });
});

describe('CI gate', () => {
  const baseline = [
    ...stratum('exact-identifier', 60, 0.8),
    ...stratum('cross-repo-call-path', 60, 0.6),
    ...Array.from({ length: 40 }, (_, i) =>
      item({
        itemId: `un_${i}`,
        stratum: 'unanswerable',
        expected: [],
        retrieved: [],
        abstained: true,
      }),
    ),
  ];

  it('passes when nothing moved', () => {
    const summary = summarise(baseline, 'v1');
    const gate = evaluateGate(baseline, baseline, summary);

    expect(gate.passed).toBe(true);
    expect(gate.report).toContain('no evidence of change');
  });

  it('fails on a significant regression', () => {
    const candidate = baseline.map((b) =>
      b.stratum === 'exact-identifier' ? { ...b, retrieved: ['nothing'] } : b,
    );
    const gate = evaluateGate(baseline, candidate, summarise(candidate, 'v2'));

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('exact-identifier/recall@10 regressed');
  });

  it('passes a significant improvement and says so', () => {
    const candidate = baseline.map((b) =>
      b.stratum === 'cross-repo-call-path' ? { ...b, retrieved: ['gold'] } : b,
    );
    const gate = evaluateGate(baseline, candidate, summarise(candidate, 'v2'));

    expect(gate.passed).toBe(true);
    expect(gate.report).toContain('**improved**');
  });

  it('fails when unanswerable questions get answered', () => {
    // The failure recall cannot see, and the one §16 says loses a team permanently.
    const candidate = baseline.map((b) =>
      b.stratum === 'unanswerable' ? { ...b, abstained: false } : b,
    );
    const gate = evaluateGate(baseline, candidate, summarise(candidate, 'v2'));

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('False-answer rate');
  });

  it('warns rather than gates on an underpowered stratum', () => {
    const thin = [...stratum('why-rationale', 5, 0.2)];
    const candidate = thin.map((b) => ({ ...b, retrieved: ['nothing'] }));
    const gate = evaluateGate(thin, candidate, summarise(candidate, 'v2'), DEFAULT_GATE);

    expect(gate.passed).toBe(true);
    expect(gate.warnings.join(' ')).toContain('does not gate');
  });

  it('warns when the eval set has no unanswerable items at all', () => {
    const noUnanswerable = stratum('exact-identifier', 60, 0.8);
    const gate = evaluateGate(noUnanswerable, noUnanswerable, summarise(noUnanswerable, 'v1'));

    expect(gate.warnings.join(' ')).toContain('abstention is uncalibrated');
  });

  it('states the minimum detectable effect in the report', () => {
    const gate = evaluateGate(baseline, baseline, summarise(baseline, 'v1'));
    expect(gate.report).toContain('smallest recall@10 change this set can resolve');
  });
});
