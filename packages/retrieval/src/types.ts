import type { Sensitivity } from '@kna/ir';

/**
 * Retrieval contracts.
 *
 * §4.3 "scoping at query time" and §10 Layer 4 both land here. The critical property is that
 * `AccessContext` is computed from the caller's identity *upstream* of retrieval and is never
 * derivable from retrieved content — §10 Layer 5: "never let retrieved content influence tool
 * selection, scope widening, or ACL decisions."
 */

export type ScopeKind = 'project' | 'expanded' | 'org' | 'repo' | 'module';

export interface RetrievalScope {
  kind: ScopeKind;
  orgId: string;
  /** Default scope is project — it matches how developers reason (§4.3). */
  projectIds?: string[];
  repoIds?: string[];
  moduleIds?: string[];
  /** The version axis: which commit or release this query is answered from. */
  versionId?: string;
  languages?: string[];
  kinds?: string[];
}

/**
 * Everything the ACL filter needs, resolved before the query runs.
 *
 * §10 Layer 4 — "the ACL filter is applied in the database query, before scoring... Never as a
 * prompt instruction, and never as a post-filter: filtering after ranking still leaks result
 * counts and relative scores for repos the user cannot read."
 */
export interface AccessContext {
  orgId: string;
  principalId: string | null;
  /** Repo ids the caller may read. Empty means no code access at all. */
  permittedRepoIds: string[];
  clearance: Sensitivity;
  /**
   * Corpus separation. §10 Layer 4 — the Documentation Assistant queries a physically distinct
   * view containing zero code chunks, so a jailbreak against it cannot surface internal
   * content because internal content was never in the candidate set.
   */
  corpus: 'external' | 'internal';
  /** Set when a short-TTL deny entry applies; takes precedence over any grant (§15.4). */
  deniedRepoIds?: string[];
  /** Present for external partner keys, which are scoped to a contracted API version. */
  pinnedVersionId?: string | null;
}

export type IntentClass =
  | 'exact-identifier'
  | 'cross-repo-call-path'
  | 'why-rationale'
  | 'how-to-integrate'
  | 'conceptual'
  | 'unanswerable';

export interface RetrievalRequest {
  query: string;
  scope: RetrievalScope;
  access: AccessContext;
  /** Prior turns, for the standalone-query rewrite (§15.5 multi-turn). */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** Symbol ids resolved in earlier turns, boosted in this one. */
  sessionSymbolIds?: string[];
  topN?: number;
  /** Skip the reranker — used by the eval harness to measure its contribution. */
  disableRerank?: boolean;
  disableGraphExpansion?: boolean;
  sessionId?: string;
}

export interface ScoredChunk {
  chunkId: string;
  symbolId: string | null;
  moduleId: string;
  repoId: string;
  content: string;
  sourcePath: string | null;
  sourceStartLine: number | null;
  sourceEndLine: number | null;
  sensitivity: Sensitivity;
  analysisDepth: string;
  generated: boolean;
  corpus: string;
  tokenCount: number;
  score: number;
  /** Per-arm ranks, kept for the replayable query trace (§15.5 feedback). */
  ranks: { dense?: number; lexical?: number; symbol?: number; fused?: number; reranked?: number };
  /** Set when this chunk represents a near-duplicate cluster spanning several modules. */
  alsoPresentInModules?: string[];
  /** True when pulled in by graph expansion rather than by direct retrieval. */
  viaExpansion?: boolean;
  expansionRelation?: 'caller' | 'callee' | 'type' | 'parent' | 'implementation';
}

export interface RetrievalResult {
  chunks: ScoredChunk[];
  /** §15.5 — the abstention path. Weak retrieval must not flow into the model like strong
   *  retrieval; that is how the confident-and-wrong answer gets produced. */
  abstain: boolean;
  abstentionReason: string | null;
  /** Forced when evidence comes only from shallow modules or a repo marked stale. */
  requiresHedging: boolean;
  hedgingReason: string | null;
  intentClass: IntentClass;
  rewrittenQuery: string | null;
  /** §15.6 named degraded modes, surfaced to the user as a banner rather than a 500. */
  degradedModes: string[];
  trace: RetrievalTrace;
}

export interface RetrievalTrace {
  traceId: string;
  rawQuery: string;
  rewrittenQuery: string | null;
  intentClass: IntentClass;
  scope: RetrievalScope;
  denseCandidates: CandidateRef[];
  lexicalCandidates: CandidateRef[];
  symbolCandidates: CandidateRef[];
  fusedCandidates: CandidateRef[];
  rerankedCandidates: CandidateRef[];
  servedChunkIds: string[];
  expansionChunkIds: string[];
  stageTimingsMs: Record<string, number>;
  /** §15.5 — "log tokens-in per stage per query". The context budget is only enforceable if
   *  it is measured. */
  stageTokens: Record<string, number>;
  topRerankScore: number | null;
  retrievalConfigVersion: string;
  embeddingModel: string;
}

export interface CandidateRef {
  chunkId: string;
  rank: number;
  score: number;
}

/**
 * §15.5 — "context budget: roughly 55% primary / 25% expansion / 20% rewritten query and
 * conversation state". Without this, graph expansion on a shared utility with 400 `usedBy`
 * edges silently evicts the chunks that were actually retrieved.
 */
export interface ContextBudget {
  totalTokens: number;
  primaryFraction: number;
  expansionFraction: number;
  conversationFraction: number;
}

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  totalTokens: 24_000,
  primaryFraction: 0.55,
  expansionFraction: 0.25,
  conversationFraction: 0.2,
};
