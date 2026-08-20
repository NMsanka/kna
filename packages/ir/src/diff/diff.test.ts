import { describe, expect, it } from 'vitest';
import { makePayload, makeSymbol, withSignature } from '../testing/fixtures.js';
import { sha256Hex } from '../hash.js';
import { diffIr } from './diff.js';
import {
  DEFAULT_CIRCUIT_BREAKER,
  degradedPlan,
  evaluateCircuitBreaker,
} from './circuit-breaker.js';

describe('diffIr change classification', () => {
  it('classifies a body-only change as reindex-without-regenerate (the common case)', () => {
    const before = makeSymbol({ qualifiedName: 'Acme.Billing.Service.Create' });
    const after = { ...before, bodyHash: sha256Hex('new body') };

    const diff = diffIr(makePayload([before]), makePayload([after]));

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]!.changeClass).toBe('body-changed');
    expect(diff.changes[0]!.action.reindex).toBe(true);
    expect(diff.changes[0]!.action.regenerate).toBe(false);
    expect(diff.totals.regenerateCount).toBe(0);
  });

  it('skips formatting-only changes entirely', () => {
    const before = makeSymbol({ qualifiedName: 'Acme.Billing.Service.Create' });
    // Same canonical signature, different raw text. Nothing should fire.
    const after = { ...before, signature: before.signature.replace(/,\s*/g, ' ,  ') };

    const diff = diffIr(makePayload([before]), makePayload([after]));

    expect(diff.changes[0]!.action.reindex).toBe(false);
    expect(diff.changes[0]!.action.regenerate).toBe(false);
  });

  it('flags a signature change as potentially breaking and high priority', () => {
    const before = withSignature(
      makeSymbol({ qualifiedName: 'Acme.Billing.Service.Create' }),
      'public Task<Invoice> Create(Guid id)',
    );
    const after = withSignature(before, 'public Task<Invoice> Create(Guid id, string reference)');
    after.parameters = [
      {
        name: 'id',
        type: null,
        optional: false,
        defaultValue: null,
        rest: false,
        description: null,
      },
      {
        name: 'reference',
        type: null,
        optional: false,
        defaultValue: null,
        rest: false,
        description: null,
      },
    ];
    before.parameters = [
      {
        name: 'id',
        type: null,
        optional: false,
        defaultValue: null,
        rest: false,
        description: null,
      },
    ];

    const diff = diffIr(makePayload([before]), makePayload([after]));
    const change = diff.changes[0]!;

    expect(change.changeClass).toBe('signature-changed');
    expect(change.action.potentiallyBreaking).toBe(true);
    expect(change.action.priority).toBe('high');
    expect(change.breaking.map((b) => b.kind)).toContain('parameter-added-required');
  });

  it('detects an added symbol and a removed symbol', () => {
    const kept = makeSymbol({ qualifiedName: 'Acme.Billing.Service.Keep' });
    const gone = makeSymbol({ qualifiedName: 'Acme.Billing.Service.Gone' });
    const added = makeSymbol({ qualifiedName: 'Acme.Billing.Service.New' });

    const diff = diffIr(makePayload([kept, gone]), makePayload([kept, added]));

    const classes = diff.changes.map((c) => c.changeClass).sort();
    expect(classes).toEqual(['added', 'removed', 'unchanged']);
    expect(diff.totals.breaking).toBe(1);
  });

  it('follows previousIds so a proven rename is not a delete-and-add', () => {
    const before = makeSymbol({ qualifiedName: 'Acme.Billing.Service.Old', id: 'sym_old' });
    const after = makeSymbol({
      qualifiedName: 'Acme.Billing.Service.New',
      id: 'sym_new',
      previousIds: ['sym_old'],
    });

    const diff = diffIr(makePayload([before]), makePayload([after]));

    expect(diff.changes).toHaveLength(1);
    expect(diff.changes[0]!.changeClass).toBe('renamed');
  });

  it('treats an HTTP binding change as the highest priority class', () => {
    const binding = {
      method: 'POST' as const,
      route: '/v1/invoices',
      operationId: 'createInvoice',
      summary: null,
      tags: [],
      parameters: [],
      requestBody: null,
      responses: [],
      security: [],
      deprecated: false,
      specId: null,
      specVersion: null,
    };
    const before = makeSymbol({ qualifiedName: 'Acme.Billing.Api.Create', httpBinding: binding });
    const after = {
      ...before,
      httpBinding: { ...binding, route: '/v2/invoices' },
    };

    const diff = diffIr(makePayload([before]), makePayload([after]));

    expect(diff.changes[0]!.changeClass).toBe('http-binding-changed');
    expect(diff.changes[0]!.breaking.map((b) => b.kind)).toContain('route-changed');
  });

  it('treats a first index as every symbol added', () => {
    const diff = diffIr(null, makePayload([makeSymbol(), makeSymbol()]));
    expect(diff.totals.added).toBe(2);
    expect(diff.fromCommitSha).toBeNull();
  });
});

describe('magnitude circuit breaker', () => {
  it('does not trip on a first index, which is legitimately 100% churn', () => {
    const diff = diffIr(null, makePayload(Array.from({ length: 500 }, () => makeSymbol())));
    expect(evaluateCircuitBreaker(diff).tripped).toBe(false);
  });

  it('trips when a codemod flips a large fraction of the repo', () => {
    const before = Array.from({ length: 200 }, (_, i) =>
      makeSymbol({ qualifiedName: `Acme.Billing.S${i}.Run`, id: `sym_${i}` }),
    );
    const after = before.map((s) =>
      withSignature(s, `public Task<Invoice> Run(Guid id, int page)`),
    );

    const diff = diffIr(makePayload(before), makePayload(after));
    const verdict = evaluateCircuitBreaker(diff);

    expect(verdict.tripped).toBe(true);
    // Churn ratio is checked before PR volume, because a repo-wide signature flip is a cost
    // problem before it is a review-fatigue problem.
    if (verdict.tripped) expect(verdict.rule).toBe('churn-ratio');
  });

  it('trips on PR volume even when the churn ratio looks harmless', () => {
    // 60 doc-comment changes across a 1,000-symbol repo: 6% churn, but 60 doc PRs.
    const before = Array.from({ length: 1000 }, (_, i) =>
      makeSymbol({ qualifiedName: `Acme.Billing.S${i}.Run`, id: `sym_${i}` }),
    );
    const after = before.map((s, i) => (i < 60 ? { ...s, docHash: `doc-${i}` } : s));

    const verdict = evaluateCircuitBreaker(diffIr(makePayload(before), makePayload(after)));

    expect(verdict.tripped).toBe(true);
    if (verdict.tripped) expect(verdict.rule).toBe('regeneration-count');
    // Index-only is still safe here: the vector index reflects reality rather than asserting it.
    expect(degradedPlan(verdict).reindex).toBe(true);
  });

  it('halts regeneration but keeps the index truthful when it trips on PR volume', () => {
    const before = Array.from({ length: 200 }, (_, i) =>
      makeSymbol({ qualifiedName: `Acme.Billing.S${i}.Run`, id: `sym_${i}` }),
    );
    const after = before.map((s) =>
      withSignature(s, 'public Task<Invoice> Run(Guid id, int page)'),
    );
    const verdict = evaluateCircuitBreaker(diffIr(makePayload(before), makePayload(after)));

    const plan = degradedPlan(verdict);
    expect(plan.regenerate).toBe(false);
    expect(plan.requiresOperatorApproval).toBe(true);
  });

  it('lets a normal small commit straight through', () => {
    const before = Array.from({ length: 200 }, (_, i) =>
      makeSymbol({ qualifiedName: `Acme.Billing.S${i}.Run`, id: `sym_${i}` }),
    );
    const after = [...before];
    after[0] = { ...before[0]!, bodyHash: 'changed' };

    const verdict = evaluateCircuitBreaker(
      diffIr(makePayload(before), makePayload(after)),
      DEFAULT_CIRCUIT_BREAKER,
    );
    expect(verdict.tripped).toBe(false);
  });
});
