import type { IrSymbol } from '../schema/symbol.js';

/**
 * §7 — "Change classification is what keeps this cheap". Most commits change bodies, not
 * signatures, so a typical merge should trigger a handful of embedding upserts and zero LLM
 * calls. Every class below states exactly which of the two pipelines it wakes up.
 */
export type ChangeClass =
  | 'unchanged'
  | 'formatting-only'
  | 'body-changed'
  | 'doc-changed'
  | 'signature-changed'
  | 'visibility-changed'
  | 'deprecation-changed'
  | 'http-binding-changed'
  | 'added'
  | 'removed'
  | 'moved'
  | 'renamed';

export interface ChangeAction {
  /** Upsert or delete this symbol's chunks in the vector index. Minutes, silent, no human. */
  reindex: boolean;
  /** Queue the owning documents for regeneration. Hours to days, via reviewed PR. */
  regenerate: boolean;
  /** Surfaced prominently in the doc PR title and the release notes. */
  potentiallyBreaking: boolean;
  /** Ordering hint for the fan-out queue; OpenAPI changes are the customer-facing surface. */
  priority: 'low' | 'normal' | 'high';
}

export const CHANGE_ACTIONS: Record<ChangeClass, ChangeAction> = {
  unchanged: { reindex: false, regenerate: false, potentiallyBreaking: false, priority: 'low' },
  'formatting-only': {
    reindex: false,
    regenerate: false,
    potentiallyBreaking: false,
    priority: 'low',
  },
  'body-changed': {
    reindex: true,
    regenerate: false,
    potentiallyBreaking: false,
    priority: 'normal',
  },
  'doc-changed': { reindex: true, regenerate: true, potentiallyBreaking: false, priority: 'low' },
  'signature-changed': {
    reindex: true,
    regenerate: true,
    potentiallyBreaking: true,
    priority: 'high',
  },
  'visibility-changed': {
    reindex: true,
    regenerate: true,
    potentiallyBreaking: true,
    priority: 'high',
  },
  'deprecation-changed': {
    reindex: true,
    regenerate: true,
    potentiallyBreaking: false,
    priority: 'normal',
  },
  'http-binding-changed': {
    reindex: true,
    regenerate: true,
    potentiallyBreaking: true,
    priority: 'high',
  },
  added: { reindex: true, regenerate: true, potentiallyBreaking: false, priority: 'normal' },
  removed: { reindex: true, regenerate: true, potentiallyBreaking: true, priority: 'high' },
  moved: { reindex: true, regenerate: false, potentiallyBreaking: false, priority: 'low' },
  renamed: { reindex: true, regenerate: true, potentiallyBreaking: true, priority: 'high' },
};

export interface SymbolChange {
  symbolId: string;
  qualifiedName: string;
  moduleId: string;
  changeClass: ChangeClass;
  action: ChangeAction;
  /** Human-readable reasons, used verbatim in the doc PR body so review is fast (§7). */
  reasons: string[];
  breaking: BreakingChange[];
  before: IrSymbol | null;
  after: IrSymbol | null;
}

/** Griffe-style breaking-change taxonomy, applied uniformly across all three languages. */
export type BreakingKind =
  | 'symbol-removed'
  | 'parameter-removed'
  | 'parameter-added-required'
  | 'parameter-type-changed'
  | 'parameter-renamed'
  | 'parameter-made-required'
  | 'return-type-changed'
  | 'visibility-reduced'
  | 'endpoint-removed'
  | 'route-changed'
  | 'method-changed'
  | 'response-removed'
  | 'request-field-required-added'
  | 'security-added';

export interface BreakingChange {
  kind: BreakingKind;
  detail: string;
  /** Confidence is `certain` for structural facts, `likely` where the analyser was shallow. */
  confidence: 'certain' | 'likely';
}

export interface ModuleDiffSummary {
  moduleId: string;
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  breaking: number;
  /** Fraction of the module's symbols that changed — feeds the magnitude circuit breaker. */
  churnRatio: number;
}

export interface IrDiff {
  repoId: string;
  fromCommitSha: string | null;
  toCommitSha: string;
  changes: SymbolChange[];
  modules: ModuleDiffSummary[];
  totals: {
    symbolsBefore: number;
    symbolsAfter: number;
    added: number;
    removed: number;
    changed: number;
    unchanged: number;
    breaking: number;
    reindexCount: number;
    regenerateCount: number;
    churnRatio: number;
  };
}
