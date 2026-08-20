import { sha256Hex } from '../hash.js';
import { normalizeSignature } from '../normalize.js';
import type { IrSymbol } from '../schema/symbol.js';
import type { IrModule } from '../schema/module.js';
import type { IrBundlePayload } from '../schema/bundle.js';

/**
 * Fixture builders shared by unit tests and by the analyser conformance suite (§13 — "pair
 * the analyser contract with a shared conformance test suite every analyser must pass").
 * Exported from the IR package deliberately: the fixtures are part of the contract.
 */

let counter = 0;

export function makeSymbol(overrides: Partial<IrSymbol> = {}): IrSymbol {
  counter += 1;
  const qualifiedName = overrides.qualifiedName ?? `Acme.Billing.Service.method${counter}`;
  const signature = normalizeSignature(
    overrides.signature ?? `public Task<Invoice> ${qualifiedName.split('.').pop()}(Guid id)`,
    'csharp',
  );
  return {
    id: overrides.id ?? `sym_${sha256Hex(qualifiedName).slice(0, 40)}`,
    previousIds: [],
    qualifiedName,
    name: qualifiedName.split('.').pop() ?? qualifiedName,
    kind: 'method',
    language: 'csharp',
    visibility: 'public',
    moduleId: 'mod_test',
    repoId: 'repo_test',
    projectIds: ['prj_test'],
    orgId: 'org_test',
    signature,
    signatureHash: sha256Hex(`csharp\nmethod\n${signature}`),
    parameters: [],
    returnType: null,
    typeParameters: [],
    typeRefs: [],
    docComment: null,
    docHash: null,
    deprecated: null,
    modifiers: [],
    decorators: [],
    edges: { calls: [], implements: [], extends: [], references: [], usedBy: [] },
    unresolved: [],
    httpBinding: null,
    parentId: null,
    sourceRef: { path: 'src/Service.cs', startLine: 10, endLine: 20, commitSha: 'a'.repeat(40) },
    analysisDepth: 'semantic',
    sensitivity: 'internal',
    sourceText: null,
    bodyHash: sha256Hex(`body-${qualifiedName}`),
    generated: false,
    ...overrides,
  };
}

/** Rebuild the derived hashes after mutating `signature` — mirrors what assembly does. */
export function withSignature(symbol: IrSymbol, signature: string): IrSymbol {
  const canonical = normalizeSignature(signature, symbol.language);
  return {
    ...symbol,
    signature: canonical,
    signatureHash: sha256Hex(`${symbol.language}\n${symbol.kind}\n${canonical}`),
  };
}

export function makeModule(overrides: Partial<IrModule> = {}): IrModule {
  return {
    id: 'mod_test',
    key: 'pkg:nuget/Acme.Billing',
    orgId: 'org_test',
    repoId: 'repo_test',
    projectIds: ['prj_test'],
    path: 'src/Acme.Billing',
    name: 'Acme.Billing',
    ecosystem: 'nuget',
    packageName: 'Acme.Billing',
    packageVersion: '1.0.0',
    languages: ['csharp'],
    visibility: 'internal',
    sensitivity: 'internal',
    analysisDepth: 'semantic',
    analysisNotes: [],
    owners: ['@acme/billing'],
    symbolCount: 0,
    fileCount: 1,
    dependencies: [],
    ...overrides,
  };
}

export function makePayload(
  symbols: IrSymbol[],
  overrides: Partial<IrBundlePayload> = {},
): IrBundlePayload {
  const commitSha = overrides.version?.commitSha ?? 'b'.repeat(40);
  return {
    repo: {
      id: 'repo_test',
      orgId: 'org_test',
      remote: 'github.com/acme/billing',
      name: 'billing',
      defaultBranch: 'main',
      provider: 'github',
    },
    version: { ref: 'main', kind: 'branch', commitSha, committedAt: null },
    modules: [makeModule({ symbolCount: symbols.length })],
    symbols,
    apiSpecs: [],
    services: [],
    languages: ['csharp'],
    analysisDepth: 'semantic',
    toolchain: { detected: {}, tiersRun: ['tier0', 'tier1'], degradations: [], durationMs: 0 },
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
    generatedAt: new Date('2026-08-20T00:00:00.000Z').toISOString(),
    ...overrides,
  };
}
