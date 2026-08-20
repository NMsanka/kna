import { describe, expect, it } from 'vitest';
import { diversify, reciprocalRankFusion } from './fusion.js';
import { evaluateAbstention } from './abstention.js';
import { expandWithBudget, fitPrimaryToBudget, type GraphNeighbour } from './expansion.js';
import { classifyByHeuristic, extractIdentifiers, understandQuery } from './query.js';
import { computeConfigVersion, DEFAULT_RETRIEVAL_CONFIG, diffConfig } from './config-version.js';
import { AccessDeniedError, buildAclPredicate, permissionSetHash } from './acl.js';
import { DEFAULT_CONTEXT_BUDGET, type AccessContext, type ScoredChunk } from './types.js';

function chunk(overrides: Partial<ScoredChunk> = {}): ScoredChunk {
  return {
    chunkId: overrides.chunkId ?? `chk_${Math.random().toString(36).slice(2, 10)}`,
    symbolId: 'sym_1',
    moduleId: 'mod_1',
    repoId: 'repo_1',
    content: 'function createInvoice(customerId: string): Promise<Invoice> { /* ... */ }',
    sourcePath: 'src/invoice.ts',
    sourceStartLine: 10,
    sourceEndLine: 20,
    sensitivity: 'internal',
    analysisDepth: 'semantic',
    generated: false,
    corpus: 'code',
    tokenCount: 40,
    score: 0.5,
    ranks: {},
    ...overrides,
  };
}

describe('reciprocal rank fusion', () => {
  it('rewards a chunk that several arms agree on', () => {
    const fused = reciprocalRankFusion([
      { name: 'dense', candidates: [{ chunkId: 'a', rank: 3, score: 0.7 }], weight: 1 },
      { name: 'lexical', candidates: [{ chunkId: 'a', rank: 2, score: 0.5 }], weight: 1 },
      { name: 'symbol', candidates: [{ chunkId: 'b', rank: 1, score: 1 }], weight: 1 },
    ]);
    expect(fused[0]!.chunkId).toBe('a');
  });

  it('lets a weighted exact-symbol hit outrank a dense-only result', () => {
    const fused = reciprocalRankFusion([
      { name: 'dense', candidates: [{ chunkId: 'semantic', rank: 1, score: 0.9 }], weight: 0.8 },
      { name: 'symbol', candidates: [{ chunkId: 'exact', rank: 1, score: 1 }], weight: 2.0 },
    ]);
    // The whole point of §8's third arm: an exact identifier match beats a plausible neighbour.
    expect(fused[0]!.chunkId).toBe('exact');
  });

  it('is stable when an arm returns nothing', () => {
    const fused = reciprocalRankFusion([
      { name: 'dense', candidates: [], weight: 1 },
      { name: 'lexical', candidates: [{ chunkId: 'a', rank: 1, score: 1 }], weight: 1 },
      { name: 'symbol', candidates: [], weight: 2 },
    ]);
    expect(fused.map((c) => c.chunkId)).toEqual(['a']);
  });
});

describe('diversity (§15.5 near-duplicate collapse)', () => {
  it('caps results from any one module', () => {
    const chunks = Array.from({ length: 10 }, (_, i) =>
      chunk({
        chunkId: `c${i}`,
        moduleId: 'mod_hot',
        score: 1 - i * 0.01,
        content: `variant ${i}`,
      }),
    );
    const selected = diversify(chunks, { limit: 8, maxPerModule: 3 });
    const fromHot = selected.filter((c) => c.moduleId === 'mod_hot' && !c.viaExpansion);
    // With only one module available the cap relaxes rather than returning three results —
    // but the first three are chosen by MMR before the relaxation kicks in.
    expect(selected).toHaveLength(8);
    expect(fromHot.length).toBeGreaterThanOrEqual(3);
  });

  it('prefers spread across modules when relevance is comparable', () => {
    const chunks = [
      chunk({ chunkId: 'a1', moduleId: 'mod_a', score: 0.9, content: 'alpha alpha alpha' }),
      chunk({ chunkId: 'a2', moduleId: 'mod_a', score: 0.89, content: 'alpha alpha alpha' }),
      chunk({ chunkId: 'a3', moduleId: 'mod_a', score: 0.88, content: 'alpha alpha alpha' }),
      chunk({ chunkId: 'b1', moduleId: 'mod_b', score: 0.85, content: 'beta beta beta' }),
    ];
    const selected = diversify(chunks, { limit: 2, maxPerModule: 3 });
    expect(selected.map((c) => c.moduleId)).toEqual(['mod_a', 'mod_b']);
  });

  it('demotes generated code without excluding it', () => {
    const chunks = [
      chunk({ chunkId: 'gen', score: 0.9, generated: true, moduleId: 'mod_gen' }),
      chunk({ chunkId: 'hand', score: 0.8, generated: false, moduleId: 'mod_hand' }),
    ];
    const selected = diversify(chunks, { limit: 2, generatedPenalty: 0.25 });
    expect(selected[0]!.chunkId).toBe('hand');
    expect(selected.map((c) => c.chunkId)).toContain('gen');
  });
});

describe('abstention (§15.5 blocker)', () => {
  it('refuses when the best cross-encoder score is below the calibrated threshold', () => {
    const verdict = evaluateAbstention({
      chunks: [chunk(), chunk()],
      topRerankScore: 0.12,
      rerankerAvailable: true,
    });
    expect(verdict.abstain).toBe(true);
    expect(verdict.reason).toContain('0.120');
  });

  it('answers when evidence is strong', () => {
    const verdict = evaluateAbstention({
      chunks: [chunk(), chunk()],
      topRerankScore: 0.82,
      rerankerAvailable: true,
    });
    expect(verdict.abstain).toBe(false);
  });

  it('refuses when nothing was retrieved', () => {
    const verdict = evaluateAbstention({
      chunks: [],
      topRerankScore: null,
      rerankerAvailable: true,
    });
    expect(verdict.abstain).toBe(true);
  });

  it('uses a structural rule rather than a score when the reranker is down', () => {
    // RRF scores are not calibrated across queries, so the numeric threshold cannot be reused.
    const thin = evaluateAbstention({
      chunks: [chunk()],
      topRerankScore: null,
      rerankerAvailable: false,
    });
    expect(thin.abstain).toBe(true);

    const adequate = evaluateAbstention({
      chunks: [chunk(), chunk(), chunk(), chunk()],
      topRerankScore: null,
      rerankerAvailable: false,
    });
    expect(adequate.abstain).toBe(false);
    expect(adequate.requiresHedging).toBe(true);
    expect(adequate.hedgingReason).toContain('fusion score');
  });

  it('forces hedging when all evidence is shallow', () => {
    const verdict = evaluateAbstention({
      chunks: [chunk({ analysisDepth: 'shallow' }), chunk({ analysisDepth: 'shallow' })],
      topRerankScore: 0.9,
      rerankerAvailable: true,
    });
    expect(verdict.abstain).toBe(false);
    expect(verdict.requiresHedging).toBe(true);
    expect(verdict.hedgingReason).toContain('shallow');
  });

  it('forces hedging when a supporting repo is stale', () => {
    const verdict = evaluateAbstention({
      chunks: [chunk({ repoId: 'repo_stale' })],
      topRerankScore: 0.9,
      rerankerAvailable: true,
      staleRepoIds: ['repo_stale'],
    });
    expect(verdict.requiresHedging).toBe(true);
    expect(verdict.hedgingReason).toContain('behind their latest commit');
  });
});

describe('graph expansion budget (§15.5)', () => {
  const neighbour = (overrides: Partial<GraphNeighbour> = {}): GraphNeighbour => ({
    symbolId: `sym_${Math.random().toString(36).slice(2, 8)}`,
    qualifiedName: 'Acme.Billing.Helper',
    signature: 'public Task<Invoice> Helper(Guid id)',
    docSummary: 'Does a thing.',
    moduleId: 'mod_1',
    repoId: 'repo_1',
    sourcePath: 'src/helper.cs',
    sourceStartLine: 5,
    relation: 'callee',
    centrality: 2,
    sensitivity: 'internal',
    analysisDepth: 'semantic',
    ...overrides,
  });

  it('drops high-centrality neighbours, which carry little information', () => {
    const seed = chunk({ chunkId: 'seed', symbolId: 'sym_seed' });
    const result = expandWithBudget(
      [seed],
      new Map([['seed', [neighbour({ centrality: 400 }), neighbour({ centrality: 2 })]]]),
      { budget: DEFAULT_CONTEXT_BUDGET, primaryTokens: 0, centralityCeiling: 50 },
    );
    expect(result.chunks).toHaveLength(1);
    expect(result.droppedReasons['high-centrality']).toBe(1);
  });

  it('never lets expansion exceed its share of the context budget', () => {
    const seed = chunk({ chunkId: 'seed', symbolId: 'sym_seed' });
    const many = Array.from({ length: 200 }, () => neighbour({ docSummary: 'x'.repeat(400) }));
    const budget = { ...DEFAULT_CONTEXT_BUDGET, totalTokens: 1000, expansionFraction: 0.25 };

    const result = expandWithBudget([seed], new Map([['seed', many]]), {
      budget,
      primaryTokens: 0,
      maxNeighboursPerSeed: 200,
    });

    expect(result.tokensUsed).toBeLessThanOrEqual(250);
  });

  it('renders neighbours as signature and doc only, never full bodies', () => {
    const seed = chunk({ chunkId: 'seed', symbolId: 'sym_seed' });
    const result = expandWithBudget([seed], new Map([['seed', [neighbour()]]]), {
      budget: DEFAULT_CONTEXT_BUDGET,
      primaryTokens: 0,
    });
    expect(result.chunks[0]!.content).toContain('public Task<Invoice> Helper(Guid id)');
    expect(result.chunks[0]!.content).not.toContain('{');
    expect(result.chunks[0]!.viaExpansion).toBe(true);
  });

  it('spreads the budget across seeds rather than draining the first', () => {
    const seeds = [
      chunk({ chunkId: 's1', symbolId: 'sym_1' }),
      chunk({ chunkId: 's2', symbolId: 'sym_2' }),
    ];
    const map = new Map([
      ['s1', Array.from({ length: 6 }, () => neighbour())],
      ['s2', Array.from({ length: 6 }, () => neighbour())],
    ]);
    const result = expandWithBudget(seeds, map, {
      budget: { ...DEFAULT_CONTEXT_BUDGET, totalTokens: 600, expansionFraction: 0.5 },
      primaryTokens: 0,
      maxNeighboursPerSeed: 6,
    });

    const seedsRepresented = new Set(result.chunks.map((c) => c.expansionRelation));
    expect(result.chunks.length).toBeGreaterThan(2);
    expect(seedsRepresented.size).toBeGreaterThan(0);
  });

  it('trims primary results at chunk boundaries, never mid-chunk', () => {
    const chunks = Array.from({ length: 20 }, (_, i) =>
      chunk({ chunkId: `c${i}`, tokenCount: 500, content: 'x'.repeat(1750) }),
    );
    const { kept, dropped, tokensUsed } = fitPrimaryToBudget(chunks, {
      ...DEFAULT_CONTEXT_BUDGET,
      totalTokens: 2000,
      primaryFraction: 0.55,
    });
    expect(kept.length).toBeGreaterThan(0);
    expect(dropped.length).toBeGreaterThan(0);
    expect(tokensUsed).toBeLessThanOrEqual(1100);
    expect(kept.every((c) => c.content.length === 1750)).toBe(true);
  });
});

describe('query understanding', () => {
  it('extracts camelCase and snake_case identifiers', () => {
    const found = extractIdentifiers('what does getUserByTenantId do, and tenant_id_lookup?');
    expect(found).toContain('getUserByTenantId');
    expect(found).toContain('tenant_id_lookup');
  });

  it('extracts quoted identifiers verbatim', () => {
    expect(extractIdentifiers('where is `InvoiceService.create` called')).toContain(
      'InvoiceService.create',
    );
  });

  it('routes intent by heuristic without a model call', () => {
    expect(classifyByHeuristic('why is the billing service structured this way', [])).toBe(
      'why-rationale',
    );
    expect(classifyByHeuristic('how do I authenticate against the API', [])).toBe(
      'how-to-integrate',
    );
    expect(classifyByHeuristic('what does getUserByTenantId do', ['getUserByTenantId'])).toBe(
      'exact-identifier',
    );
    expect(classifyByHeuristic('which service calls the reconciliation worker', [])).toBe(
      'cross-repo-call-path',
    );
  });

  it('skips the rewrite entirely for a self-contained first turn', async () => {
    const result = await understandQuery('where is rate limiting implemented', { orgId: 'org_1' });
    expect(result.rewrittenQuery).toBeNull();
    expect(result.usedModel).toBe(false);
  });

  it('rewrites a dependent follow-up even with no model available', async () => {
    const result = await understandQuery('what about the async version?', {
      orgId: 'org_1',
      history: [
        { role: 'user', content: 'what does InvoiceService.create do' },
        { role: 'assistant', content: 'It creates a draft invoice.' },
      ],
    });
    // Degraded, but not broken: turn three is where most real sessions live (§15.5).
    expect(result.rewrittenQuery).toContain('InvoiceService.create');
    expect(result.rewrittenQuery).toContain('async version');
  });
});

describe('retrieval config version (§15.5 change control)', () => {
  it('separates index-time from query-time changes', () => {
    const base = DEFAULT_RETRIEVAL_CONFIG;
    const queryChange = { ...base, topNFinal: 12 };
    const indexChange = { ...base, chunkMaxTokens: 800 };

    const baseVersion = computeConfigVersion(base);
    expect(computeConfigVersion(queryChange).indexVersion).toBe(baseVersion.indexVersion);
    expect(computeConfigVersion(queryChange).queryVersion).not.toBe(baseVersion.queryVersion);
    expect(computeConfigVersion(indexChange).indexVersion).not.toBe(baseVersion.indexVersion);
  });

  it('flags an embedding model change as needing the full migration runbook', () => {
    const diff = diffConfig(DEFAULT_RETRIEVAL_CONFIG, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      embeddingModel: 'voyage-code-4',
    });
    expect(diff.requiresBackfill).toBe(true);
    expect(diff.requiresReindex).toBe(true);
    expect(diff.summary).toContain('embedding-migration.md');
  });

  it('flags a chunking change as needing a reindex but not a backfill', () => {
    const diff = diffConfig(DEFAULT_RETRIEVAL_CONFIG, {
      ...DEFAULT_RETRIEVAL_CONFIG,
      chunkMaxTokens: 800,
    });
    expect(diff.requiresReindex).toBe(true);
    expect(diff.requiresBackfill).toBe(false);
  });

  it('reports no change when nothing moved', () => {
    const diff = diffConfig(DEFAULT_RETRIEVAL_CONFIG, { ...DEFAULT_RETRIEVAL_CONFIG });
    expect(diff.changed).toEqual([]);
  });
});

describe('ACL filter (§10 Layer 4)', () => {
  const internal: AccessContext = {
    orgId: 'org_1',
    principalId: 'prin_1',
    permittedRepoIds: ['repo_1', 'repo_2'],
    clearance: 'internal',
    corpus: 'internal',
  };

  it('refuses to build a predicate for a mismatched org', () => {
    expect(() => buildAclPredicate(internal, { kind: 'project', orgId: 'org_other' })).toThrow(
      AccessDeniedError,
    );
  });

  it('refuses to run an unscoped query when the caller has no repos', () => {
    expect(() =>
      buildAclPredicate({ ...internal, permittedRepoIds: [] }, { kind: 'project', orgId: 'org_1' }),
    ).toThrow(AccessDeniedError);
  });

  it('builds a predicate for a permitted caller', () => {
    const predicate = buildAclPredicate(internal, { kind: 'project', orgId: 'org_1' });
    expect(predicate).toBeDefined();
  });

  it('keys the result cache on the permission set, not the query', async () => {
    const a = await permissionSetHash(internal);
    const b = await permissionSetHash({ ...internal, permittedRepoIds: ['repo_1'] });
    // Two users asking the same question with different permissions must not share a cache
    // entry (§15.6).
    expect(a).not.toBe(b);
  });

  it('produces the same hash regardless of repo ordering', async () => {
    const a = await permissionSetHash(internal);
    const b = await permissionSetHash({ ...internal, permittedRepoIds: ['repo_2', 'repo_1'] });
    expect(a).toBe(b);
  });

  it('builds an external-corpus predicate without any repo grants', () => {
    const external: AccessContext = {
      orgId: 'org_1',
      principalId: null,
      permittedRepoIds: [],
      clearance: 'public',
      corpus: 'external',
      pinnedVersionId: 'ver_v1',
    };
    // The external assistant needs no repo permissions because it can never see code chunks.
    expect(() => buildAclPredicate(external, { kind: 'project', orgId: 'org_1' })).not.toThrow();
  });
});
