import { randomUUID } from 'node:crypto';
import { contentHash, sha256Hex } from './hash.js';
import { computeModuleId, computeSymbolId, moduleKey, normalizePath } from './ids.js';
import { normalizeDocText, normalizeSignature, type NormalizableLanguage } from './normalize.js';
import type { RawModule } from './schema/module.js';
import type { IrModule } from './schema/module.js';
import type { IrSymbol, RawSymbol } from './schema/symbol.js';
import type { RepoRef, VersionRef } from './schema/repo.js';
import type { ApiSpec, IrBundle, IrBundlePayload } from './schema/bundle.js';
import { zIrBundlePayload } from './schema/bundle.js';
import { IR_SCHEMA_VERSION } from './version.js';
import type { AnalysisDepth, Sensitivity } from './schema/primitives.js';

/**
 * IR assembly — the CLI's normalisation step (§3.1).
 *
 * Analysers emit *raw* symbols keyed by qualified name, because a subprocess cannot know the
 * org id or the module id. Assembly is the single place where identity is minted, edges are
 * resolved from names to ids, and canonical hashes are computed. Keeping it here rather than
 * in each analyser is what lets three separately-authored analysers produce byte-identical IR
 * semantics (§13 — the highest-value spec in the project).
 */

export interface AssembleInput {
  orgId: string;
  repo: RepoRef;
  version: VersionRef;
  projectIds: string[];
  modules: Array<{ module: RawModule; symbols: RawSymbol[] }>;
  apiSpecs?: ApiSpec[];
  /** Per-module sensitivity from the classifier (§10 Layer 3); defaults to `internal`. */
  sensitivityByModulePath?: Record<string, Sensitivity>;
  includeSource: boolean;
}

export interface AssembleResult {
  modules: IrModule[];
  symbols: IrSymbol[];
  /** Names an analyser referenced but assembly could not resolve to a symbol in this repo.
   *  They are kept on the symbol as `unresolved` for the cross-repo pass to pick up. */
  unresolvedCount: number;
}

export function assemble(input: AssembleInput): AssembleResult {
  const modules: IrModule[] = [];
  const symbols: IrSymbol[] = [];

  // Pass 1 — mint module identity, then symbol identity, building the name → id index that
  // pass 2 uses to resolve edges. Two passes because edges routinely point forwards.
  const nameIndex = new Map<string, string>();
  const staged: Array<{ module: IrModule; raw: RawSymbol; id: string }> = [];

  for (const entry of input.modules) {
    const raw = entry.module;
    const path = normalizePath(raw.path);
    const key = moduleKey({
      repoId: input.repo.id,
      path,
      ecosystem: raw.ecosystem,
      packageName: raw.packageName,
    });
    const moduleId = computeModuleId(input.orgId, key);
    const sensitivity = input.sensitivityByModulePath?.[path] ?? 'internal';

    const module: IrModule = {
      ...raw,
      id: moduleId,
      key,
      path,
      orgId: input.orgId,
      repoId: input.repo.id,
      projectIds: input.projectIds,
      sensitivity,
      symbolCount: entry.symbols.length,
    };
    modules.push(module);

    for (const rawSymbol of entry.symbols) {
      const id = computeSymbolId({
        orgId: input.orgId,
        moduleKey: key,
        language: rawSymbol.language,
        kind: rawSymbol.kind,
        qualifiedName: rawSymbol.qualifiedName,
        overloadDiscriminator: rawSymbol.overloadDiscriminator,
      });
      staged.push({ module, raw: rawSymbol, id });

      // Last writer wins on collision; overloads are disambiguated by discriminator above, so
      // a genuine collision means two modules declare the same qualified name, which is a real
      // ambiguity the cross-repo pass reports rather than silently picks.
      nameIndex.set(qualifiedKey(module.id, rawSymbol.qualifiedName), id);
      if (!nameIndex.has(rawSymbol.qualifiedName)) {
        nameIndex.set(rawSymbol.qualifiedName, id);
      }
    }
  }

  let unresolvedCount = 0;

  // Pass 2 — resolve, hash, and finalise.
  for (const { module, raw, id } of staged) {
    const language = raw.language as NormalizableLanguage;
    const canonicalSignature = normalizeSignature(raw.signature, language);
    const normalizedDoc = raw.docComment
      ? normalizeDocText(
          [raw.docComment.summary, raw.docComment.description ?? ''].filter(Boolean).join('\n\n'),
        )
      : '';

    const resolve = (name: string): string | null =>
      nameIndex.get(qualifiedKey(module.id, name)) ?? nameIndex.get(name) ?? null;

    const unresolved = [...raw.unresolved];
    const resolveList = (names: string[], kind: 'call' | 'type' | 'extends' | 'implements') => {
      const ids: string[] = [];
      for (const name of names) {
        const resolved = resolve(name);
        if (resolved) {
          ids.push(resolved);
        } else {
          unresolved.push({ name, kind, hint: module.packageName });
          unresolvedCount++;
        }
      }
      return ids;
    };

    const symbol: IrSymbol = {
      id,
      previousIds: raw.previousIds,
      qualifiedName: raw.qualifiedName,
      name: raw.name,
      kind: raw.kind,
      language: raw.language,
      visibility: raw.visibility,

      moduleId: module.id,
      repoId: input.repo.id,
      projectIds: input.projectIds,
      orgId: input.orgId,

      signature: canonicalSignature,
      signatureHash: sha256Hex(`${raw.language}\n${raw.kind}\n${canonicalSignature}`),

      parameters: raw.parameters,
      returnType: raw.returnType,
      typeParameters: raw.typeParameters,
      typeRefs: raw.typeRefs,

      docComment: raw.docComment,
      docHash: normalizedDoc ? sha256Hex(normalizedDoc) : null,
      deprecated: raw.deprecated,

      modifiers: [...raw.modifiers].sort(),
      decorators: raw.decorators,

      edges: {
        calls: resolveList(raw.edges.calls, 'call'),
        implements: resolveList(raw.edges.implements, 'implements'),
        extends: resolveList(raw.edges.extends, 'extends'),
        references: resolveList(raw.edges.references, 'type'),
        usedBy: [],
      },
      unresolved,

      httpBinding: raw.httpBinding,
      parentId: raw.parentQualifiedName ? resolve(raw.parentQualifiedName) : null,

      sourceRef: { ...raw.sourceRef, path: normalizePath(raw.sourceRef.path) },
      analysisDepth: raw.analysisDepth,
      sensitivity: module.sensitivity,

      // §10 Layer 1 — raw source never leaves the machine unless the repo opted in, in writing.
      sourceText: input.includeSource ? raw.sourceText : null,
      bodyHash: raw.bodyHash,
      generated: raw.generated,
    };

    symbols.push(symbol);
  }

  // Reverse edges. `usedBy` needs the whole repo present, which is why analysers leave it empty
  // and why the cross-repo variant is a separate pass on the platform side (§4.3).
  const byId = new Map(symbols.map((s) => [s.id, s]));
  for (const symbol of symbols) {
    for (const target of [...symbol.edges.calls, ...symbol.edges.references]) {
      byId.get(target)?.edges.usedBy.push(symbol.id);
    }
  }
  for (const symbol of symbols) {
    symbol.edges.usedBy = [...new Set(symbol.edges.usedBy)].sort();
  }

  for (const module of modules) {
    const own = symbols.filter((s) => s.moduleId === module.id);
    module.symbolCount = own.length;
    module.analysisDepth = weakestDepth(own.map((s) => s.analysisDepth));
    module.languages = [...new Set(own.map((s) => s.language))];
  }

  return { modules, symbols, unresolvedCount };
}

function qualifiedKey(moduleId: string, qualifiedName: string): string {
  return `${moduleId}::${qualifiedName}`;
}

/** A module is only as deep as its shallowest symbol — never overstate confidence (§5). */
export function weakestDepth(depths: AnalysisDepth[]): AnalysisDepth {
  if (depths.length === 0) return 'shallow';
  if (depths.includes('shallow')) return 'shallow';
  if (depths.includes('semantic')) return 'semantic';
  return 'artifact';
}

export interface BuildBundleInput extends AssembleResult {
  orgId: string;
  repo: RepoRef;
  version: VersionRef;
  apiSpecs: ApiSpec[];
  services: IrBundlePayload['services'];
  toolchain: IrBundlePayload['toolchain'];
  scan: IrBundlePayload['scan'];
  includesSource: boolean;
  producerVersion: string;
  environment: 'ci' | 'local' | 'replay';
  /** Signing is injected so the IR package stays free of crypto-provider dependencies. */
  sign: (
    payloadHash: string,
    envelopeClaims: Record<string, string>,
  ) => IrBundle['envelope']['signature'];
  ttlSeconds?: number;
}

export function buildBundle(input: BuildBundleInput): IrBundle {
  const payload: IrBundlePayload = zIrBundlePayload.parse({
    repo: input.repo,
    version: input.version,
    modules: input.modules,
    symbols: input.symbols,
    apiSpecs: input.apiSpecs,
    services: input.services,
    languages: [...new Set(input.symbols.map((s) => s.language))],
    analysisDepth: weakestDepth(input.modules.map((m) => m.analysisDepth)),
    toolchain: input.toolchain,
    scan: input.scan,
    includesSource: input.includesSource,
    generatedAt: new Date().toISOString(),
  });

  const payloadJson = JSON.stringify(payload);
  const payloadHash = contentHash(payload);
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + (input.ttlSeconds ?? 900) * 1000);
  const nonce = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 8);

  const claims = {
    orgId: input.orgId,
    repoId: input.repo.id,
    commitSha: input.version.commitSha,
    ref: input.version.ref,
    nonce,
    expiresAt: expiresAt.toISOString(),
  };

  return {
    envelope: {
      irSchemaVersion: IR_SCHEMA_VERSION,
      bundleId: randomUUID(),
      orgId: input.orgId,
      repoId: input.repo.id,
      commitSha: input.version.commitSha,
      ref: input.version.ref,
      nonce,
      issuedAt: issuedAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      producer: {
        name: 'docs-cli',
        version: input.producerVersion,
        environment: input.environment,
      },
      payloadHash,
      payloadBytes: Buffer.byteLength(payloadJson, 'utf8'),
      storageKey: null,
      signature: input.sign(payloadHash, claims),
    },
    payload,
  };
}
