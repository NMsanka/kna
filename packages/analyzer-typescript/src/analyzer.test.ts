import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it, beforeAll } from 'vitest';
import { assemble, diffIr, type RawSymbol } from '@kna/ir';
import { AnalyzerRegistry, discover, runConformance, runPipeline } from '@kna/analyzer-core';
import { TypeScriptAnalyzer } from './analyzer.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot = join(here, '..', 'test', 'fixtures', 'billing');
const COMMIT = 'a'.repeat(40);

describe('TypeScriptAnalyzer', () => {
  let symbols: RawSymbol[];

  beforeAll(async () => {
    const analyzer = new TypeScriptAnalyzer();
    const discovery = await discover({ repoRoot: fixtureRoot });
    const module = discovery.modules[0]!;

    const response = await analyzer.analyze({
      protocol: 'kna-analyzer/1',
      repoRoot: fixtureRoot,
      commitSha: COMMIT,
      module: {
        path: module.module.path,
        name: module.module.name,
        manifestPath: module.manifestPath,
      },
      files: module.files.map((f) => ({
        path: f.path,
        language: f.language,
        generated: f.generated,
      })),
      options: { includeSource: false, timeoutMs: 60_000 },
    });

    expect(response.ok).toBe(true);
    symbols = response.symbols;
  }, 60_000);

  it('probes the toolchain by finding a tsconfig', async () => {
    expect(await new TypeScriptAnalyzer().probe(fixtureRoot)).toMatch(/tsconfig\.json/);
  });

  it('satisfies the shared analyser conformance suite', () => {
    const result = runConformance(symbols);
    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(true);
  });

  it('claims semantic depth and resolves parameter types to back it up', () => {
    const create = find(symbols, 'InvoiceService.create');
    expect(create.analysisDepth).toBe('semantic');
    expect(create.parameters.map((p) => p.name)).toEqual(['customerId', 'lines']);
    expect(create.parameters[0]!.type?.text).toBe('string');
    expect(create.parameters[1]!.type?.text).toContain('InvoiceLine');
    expect(create.parameters[1]!.type?.isArray).toBe(true);
  });

  it('resolves inferred return types, not just declared ones', () => {
    const total = find(symbols, 'InvoiceService.computeTotal');
    expect(total.returnType?.text).toBe('Money');
    const summarise = find(symbols, 'summariseInvoice');
    expect(summarise.returnType?.text).toBe('string');
  });

  it('joins JSDoc to the symbol and to individual parameters', () => {
    const create = find(symbols, 'InvoiceService.create');
    expect(create.docComment?.summary).toContain('Create a draft invoice');
    expect(create.parameters[0]!.description).toContain('Identifier of the customer');
    expect(create.docComment?.throws.map((t) => t.type)).toContain('RangeError');
    expect(create.docComment?.returns?.description).toContain('Draft');
  });

  it('records deprecation as structured data, not prose', () => {
    const forced = find(symbols, 'InvoiceService.forceIssue');
    expect(forced.deprecated).not.toBeNull();
    expect(forced.deprecated?.reason).toContain('issue');
  });

  it('distinguishes public API surface from internal helpers', () => {
    expect(find(symbols, 'formatMoney').visibility).toBe('public');
    expect(find(symbols, 'unusedHelper').visibility).toBe('internal');
    expect(find(symbols, 'InvoiceService.computeTotal').visibility).toBe('private');
  });

  it('builds a real call graph across declarations', () => {
    const create = find(symbols, 'InvoiceService.create');
    // `this.computeTotal(...)` and `this.repository.save(...)` both resolve through the checker.
    expect(create.edges.calls).toContain('InvoiceService.computeTotal');
    expect(create.edges.calls).toContain('save');

    const summarise = find(symbols, 'summariseInvoice');
    expect(summarise.edges.calls).toContain('formatMoney');
  });

  it('records inheritance and interface implementation', () => {
    const error = find(symbols, 'InvoiceNotFoundError');
    expect(error.edges.extends).toContain('Error');
  });

  it('captures enums, enum members, type aliases and interfaces', () => {
    expect(find(symbols, 'InvoiceStatus').kind).toBe('enum');
    expect(find(symbols, 'InvoiceStatus.Paid').kind).toBe('enumMember');
    expect(find(symbols, 'InvoiceId').kind).toBe('type');
    expect(find(symbols, 'Money').kind).toBe('interface');
    expect(find(symbols, 'Money.amountMinor').kind).toBe('property');
  });

  it('never emits source text unless the repo opted in', () => {
    expect(symbols.every((s) => s.sourceText === null)).toBe(true);
  });

  it('records a body hash so body-only changes are detectable', () => {
    expect(find(symbols, 'InvoiceService.create').bodyHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('pipeline end to end', () => {
  it('assembles a complete, internally consistent IR for the fixture repo', async () => {
    const registry = new AnalyzerRegistry().register(new TypeScriptAnalyzer());
    const result = await runPipeline({
      repoRoot: fixtureRoot,
      commitSha: COMMIT,
      registry,
      maxTier: 'tier2',
      includeSource: false,
      timeoutMs: 60_000,
    });

    expect(result.modules).toHaveLength(1);
    const module = result.modules[0]!;
    expect(module.depth).toBe('semantic');
    expect(module.module.packageName).toBe('@acme/billing');
    expect(module.module.ecosystem).toBe('npm');

    const assembled = assemble({
      orgId: 'org_test',
      repo: {
        id: 'repo_test',
        orgId: 'org_test',
        remote: 'github.com/acme/billing',
        name: 'billing',
        defaultBranch: 'main',
        provider: 'github',
      },
      version: { ref: 'main', kind: 'branch', commitSha: COMMIT, committedAt: null },
      projectIds: ['prj_billing'],
      modules: [{ module: module.module, symbols: module.symbols }],
      includeSource: false,
    });

    // Identity is minted exactly once, and every symbol carries its scope keys denormalised
    // so retrieval scoping is one indexed WHERE clause (§4.3).
    expect(new Set(assembled.symbols.map((s) => s.id)).size).toBe(assembled.symbols.length);
    expect(assembled.symbols.every((s) => s.id.startsWith('sym_'))).toBe(true);
    expect(assembled.symbols.every((s) => s.orgId === 'org_test')).toBe(true);
    expect(assembled.symbols.every((s) => s.projectIds.includes('prj_billing'))).toBe(true);

    // Every symbol got a canonical signature hash.
    expect(assembled.symbols.every((s) => /^[0-9a-f]{64}$/.test(s.signatureHash))).toBe(true);

    // Call edges resolved to ids where the target is in this repo.
    const create = assembled.symbols.find((s) => s.qualifiedName === 'InvoiceService.create')!;
    const computeTotal = assembled.symbols.find(
      (s) => s.qualifiedName === 'InvoiceService.computeTotal',
    )!;
    expect(create.edges.calls).toContain(computeTotal.id);

    // ...and the reverse edge was computed, which is what powers graph expansion.
    expect(computeTotal.edges.usedBy).toContain(create.id);

    // Parent links resolved.
    expect(create.parentId).toBe(
      assembled.symbols.find((s) => s.qualifiedName === 'InvoiceService')!.id,
    );
  }, 90_000);

  it('produces a stable IR across two identical runs, so an unchanged commit is a no-op', async () => {
    const registry = new AnalyzerRegistry().register(new TypeScriptAnalyzer());
    const options = {
      repoRoot: fixtureRoot,
      commitSha: COMMIT,
      registry,
      maxTier: 'tier2' as const,
      includeSource: false,
      timeoutMs: 60_000,
    };

    const first = await runPipeline(options);
    const second = await runPipeline(options);

    const payloadOf = (result: Awaited<ReturnType<typeof runPipeline>>) => {
      const assembled = assemble({
        orgId: 'org_test',
        repo: {
          id: 'repo_test',
          orgId: 'org_test',
          remote: 'github.com/acme/billing',
          name: 'billing',
          defaultBranch: 'main',
          provider: 'github',
        },
        version: { ref: 'main', kind: 'branch', commitSha: COMMIT, committedAt: null },
        projectIds: ['prj_billing'],
        modules: result.modules.map((m) => ({ module: m.module, symbols: m.symbols })),
        includeSource: false,
      });
      return {
        repo: {
          id: 'repo_test',
          orgId: 'org_test',
          remote: 'github.com/acme/billing',
          name: 'billing',
          defaultBranch: 'main' as const,
          provider: 'github' as const,
        },
        version: { ref: 'main', kind: 'branch' as const, commitSha: COMMIT, committedAt: null },
        modules: assembled.modules,
        symbols: assembled.symbols,
        apiSpecs: [],
        services: [],
        languages: ['typescript' as const],
        analysisDepth: 'semantic' as const,
        toolchain: { detected: {}, tiersRun: [], degradations: [], durationMs: 0 },
        scan: {
          scannerVersion: 'test',
          rulesetHash: 'test',
          filesScanned: 1,
          secretsFound: 0,
          piiFound: 0,
          pathsExcluded: 0,
          injectionPatternsFlagged: 0,
          passed: true,
        },
        includesSource: false,
        generatedAt: new Date(0).toISOString(),
      };
    };

    const diff = diffIr(payloadOf(first), payloadOf(second));

    // The whole cost model depends on this: re-analysing an unchanged commit must produce
    // zero reindex work and zero LLM calls (§7).
    expect(diff.totals.reindexCount).toBe(0);
    expect(diff.totals.regenerateCount).toBe(0);
    expect(diff.totals.added).toBe(0);
    expect(diff.totals.removed).toBe(0);
  }, 120_000);
});

function find(symbols: RawSymbol[], qualifiedName: string): RawSymbol {
  const found = symbols.find((s) => s.qualifiedName === qualifiedName);
  if (!found) {
    throw new Error(
      `No symbol '${qualifiedName}'. Extracted: ${symbols.map((s) => s.qualifiedName).join(', ')}`,
    );
  }
  return found;
}
