import { z } from 'zod';
import {
  zAnalysisDepth,
  zDeprecation,
  zDocComment,
  zLanguage,
  zParameter,
  zSensitivity,
  zSourceRef,
  zSymbolKind,
  zTypeRef,
  zVisibility,
} from './primitives.js';
import { zHttpBinding } from './http.js';

/**
 * Graph edges. `usedBy` is computed at index time (it needs the whole project's IR), so
 * analysers leave it empty and the cross-repo resolution pass fills it.
 */
export const zSymbolEdges = z.object({
  calls: z.array(z.string()).default([]),
  implements: z.array(z.string()).default([]),
  extends: z.array(z.string()).default([]),
  references: z.array(z.string()).default([]),
  usedBy: z.array(z.string()).default([]),
});
export type SymbolEdges = z.infer<typeof zSymbolEdges>;

/**
 * Unresolved edge target. Tier 0 sees the *name* `createInvoice` but cannot resolve it to an
 * id; Tier 1 usually can. Keeping the unresolved form rather than discarding it lets the
 * cross-repo pass resolve later, and lets retrieval fall back to name matching.
 */
export const zUnresolvedRef = z.object({
  name: z.string(),
  kind: z.enum(['call', 'type', 'import', 'extends', 'implements']),
  hint: z.string().nullable().default(null),
});

export const zSymbol = z.object({
  id: z.string().describe('computeSymbolId() — algorithm version 2'),
  /**
   * Ids this symbol was known by before a rename the analyser could prove. Persisted as
   * redirects so provenance links in already-published docs keep resolving (§15.1 fix 2).
   */
  previousIds: z.array(z.string()).default([]),

  qualifiedName: z.string().min(1),
  name: z.string().min(1).describe('Unqualified, for exact-identifier lookup'),
  kind: zSymbolKind,
  language: zLanguage,
  visibility: zVisibility,

  /** Owning module id, denormalised so scoping is one indexed WHERE clause (§4.3). */
  moduleId: z.string(),
  repoId: z.string(),
  projectIds: z.array(z.string()).default([]),
  orgId: z.string(),

  signature: z.string().describe('Canonical rendering — see normalizeSignature()'),
  signatureHash: z.string().describe('sha256 of the canonical signature; drives drift detection'),

  parameters: z.array(zParameter).default([]),
  returnType: zTypeRef.nullable().default(null),
  typeParameters: z.array(z.string()).default([]),
  typeRefs: z.array(zTypeRef).default([]),

  docComment: zDocComment.nullable().default(null),
  docHash: z.string().nullable().default(null).describe('sha256 of normalised doc text'),
  deprecated: zDeprecation.nullable().default(null),

  modifiers: z.array(z.string()).default([]).describe('static, abstract, async, readonly, sealed…'),
  decorators: z.array(z.string()).default([]).describe('Attributes/decorators as written'),

  edges: zSymbolEdges.default({
    calls: [],
    implements: [],
    extends: [],
    references: [],
    usedBy: [],
  }),
  unresolved: z.array(zUnresolvedRef).default([]),

  httpBinding: zHttpBinding.nullable().default(null),

  /** Enclosing symbol (class for a method, module for a class). Drives chunk context headers. */
  parentId: z.string().nullable().default(null),

  sourceRef: zSourceRef,
  analysisDepth: zAnalysisDepth,

  /** §10 Layer 3 — set by the classifier, not by the analyser; defaults to the module's tier. */
  sensitivity: zSensitivity.default('internal'),

  /**
   * Verbatim source, present only when the repo has explicitly opted in to snippet upload
   * (§10 Layer 1: raw source never leaves the developer machine by default).
   */
  sourceText: z.string().nullable().default(null),

  /** Hash of the symbol body, so "body changed, signature stable" is detectable (§7). */
  bodyHash: z.string().nullable().default(null),

  /** Set when the analyser recognised the file as machine-generated (§15.5 dedup/demote). */
  generated: z.boolean().default(false),
});
export type IrSymbol = z.infer<typeof zSymbol>;

/** Symbol as an analyser emits it — ids and scope keys are assigned during IR assembly. */
export const zRawSymbol = zSymbol
  .omit({
    id: true,
    moduleId: true,
    repoId: true,
    projectIds: true,
    orgId: true,
    signatureHash: true,
    docHash: true,
    sensitivity: true,
  })
  .extend({
    /** Overload disambiguator; assembly folds it into the id. */
    overloadDiscriminator: z.string().nullable().default(null),
    /** Parent expressed by qualified name, since ids do not exist yet. */
    parentQualifiedName: z.string().nullable().default(null),
    edges: z
      .object({
        calls: z.array(z.string()).default([]),
        implements: z.array(z.string()).default([]),
        extends: z.array(z.string()).default([]),
        references: z.array(z.string()).default([]),
      })
      .default({ calls: [], implements: [], extends: [], references: [] })
      .describe('Qualified names, not ids — assembly resolves them'),
  })
  .omit({ parentId: true });
export type RawSymbol = z.infer<typeof zRawSymbol>;
