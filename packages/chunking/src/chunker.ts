import {
  computeChunkId,
  contentHash,
  type IrModule,
  type IrSymbol,
  type Sensitivity,
} from '@kna/ir';

/**
 * Chunking (§8).
 *
 * "Chunk on AST boundaries from the IR, not character counts. One chunk per meaningful symbol
 * (function, method, class), with: the symbol's own source, its signature and resolved types,
 * its doc comment, and a generated context header."
 *
 * The context header is Anthropic's contextual retrieval, which §8 calls "the highest-ROI
 * single improvement in this entire pipeline". It is generated once per `signatureHash` by a
 * cheap model and cached, so it only regenerates when the code actually changes.
 *
 * Note what is *not* here: no character-count splitting of the primary path. A 40-line method
 * and a 400-line method are both one chunk, because the retrieval unit that matters is the
 * declaration. Only genuinely oversized symbols split, at statement boundaries, with a shared
 * parent reference so the pieces stay findable together.
 */

export interface Chunk {
  id: string;
  orgId: string;
  repoId: string;
  moduleId: string;
  projectIds: string[];
  versionId: string;
  symbolId: string;
  ordinal: number;
  corpus: 'code' | 'docs' | 'spec' | 'adr' | 'infra';
  /** Full embedded text: context header, then the deterministic facts, then any source. */
  content: string;
  contextHeader: string | null;
  contentHash: string;
  tokenCount: number;
  sensitivity: Sensitivity;
  analysisDepth: string;
  sourcePath: string | null;
  sourceStartLine: number | null;
  sourceEndLine: number | null;
  generated: boolean;
  indexedCommitSha: string;
}

export interface ChunkOptions {
  module: IrModule;
  versionId: string;
  commitSha: string;
  retrievalConfigVersion: string;
  /** Cached blurbs keyed by signatureHash — the whole point of the cache (§8). */
  blurbsBySignatureHash?: Map<string, string>;
  /** Above this, a symbol splits at statement boundaries with overlap. */
  maxTokens?: number;
  overlapTokens?: number;
}

const DEFAULT_MAX_TOKENS = 1_200;
const DEFAULT_OVERLAP_TOKENS = 80;

export function chunkSymbols(symbols: IrSymbol[], options: ChunkOptions): Chunk[] {
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  const chunks: Chunk[] = [];

  for (const symbol of symbols) {
    // §10 Layer 3 — restricted content never enters the embedding pipeline. The safest chunk
    // is the one that was never vectorised.
    if (symbol.sensitivity === 'restricted') continue;

    // Enum members, fields and properties are retrieved through their parent, not on their
    // own; indexing them individually floods the candidate set with near-empty chunks.
    if (isSubsumedByParent(symbol)) continue;

    const header = buildContextHeader(symbol, options);
    const facts = renderDeterministicFacts(symbol);
    const source = symbol.sourceText;

    const body = [facts, source].filter(Boolean).join('\n\n');
    const full = header ? `${header}\n\n${body}` : body;

    if (estimateTokens(full) <= maxTokens || !source) {
      chunks.push(makeChunk(symbol, options, header, full, 0));
      continue;
    }

    // Oversized: split the *source* at statement boundaries, keeping the header and facts on
    // every piece so each remains independently interpretable.
    const pieces = splitAtStatementBoundaries(
      source,
      maxTokens - estimateTokens(`${header}\n\n${facts}`),
      options.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
    );
    pieces.forEach((piece, index) => {
      const content = [header, facts, `// part ${index + 1} of ${pieces.length}\n${piece}`]
        .filter(Boolean)
        .join('\n\n');
      chunks.push(makeChunk(symbol, options, header, content, index));
    });
  }

  return chunks;
}

function makeChunk(
  symbol: IrSymbol,
  options: ChunkOptions,
  header: string | null,
  content: string,
  ordinal: number,
): Chunk {
  const hash = contentHash(content);
  return {
    id: computeChunkId(symbol.id, ordinal, hash),
    orgId: symbol.orgId,
    repoId: symbol.repoId,
    moduleId: symbol.moduleId,
    projectIds: symbol.projectIds,
    versionId: options.versionId,
    symbolId: symbol.id,
    ordinal,
    corpus: symbol.httpBinding ? 'spec' : 'code',
    content,
    contextHeader: header,
    contentHash: hash,
    tokenCount: estimateTokens(content),
    sensitivity: symbol.sensitivity,
    analysisDepth: symbol.analysisDepth,
    sourcePath: symbol.sourceRef.path,
    sourceStartLine: symbol.sourceRef.startLine,
    sourceEndLine: symbol.sourceRef.endLine,
    generated: symbol.generated,
    indexedCommitSha: options.commitSha,
  };
}

/**
 * The context header.
 *
 * "A bare function body is nearly meaningless without knowing what system it belongs to."
 * Everything except the last line is deterministic — file path, module, class — so the header
 * is useful even before the LLM blurb exists, which matters for the cold-start case (§15.5)
 * where a newly onboarded repo has no cached blurbs at all.
 */
export function buildContextHeader(symbol: IrSymbol, options: ChunkOptions): string {
  const module = options.module;
  const lines = [
    `// Module: ${module.name}${module.packageName ? ` (${module.packageName})` : ''}`,
    `// File: ${symbol.sourceRef.path}`,
  ];

  if (symbol.parentId) {
    const parentName = symbol.qualifiedName.split('.').slice(0, -1).join('.');
    if (parentName) lines.push(`// Declared in: ${parentName}`);
  }

  lines.push(`// Kind: ${symbol.visibility} ${symbol.kind}`);

  if (symbol.analysisDepth === 'shallow') {
    // Carried into retrieval so the assistant can hedge (§15.5: "force hedged phrasing when
    // evidence comes only from shallow modules").
    lines.push(`// Analysis: shallow — signature as written, types not resolved`);
  }

  const blurb = options.blurbsBySignatureHash?.get(symbol.signatureHash);
  if (blurb) lines.push(`// Context: ${blurb.replace(/\s+/g, ' ').trim()}`);

  return lines.join('\n');
}

/**
 * Deterministic facts.
 *
 * §6's generation contract applies to retrieval too: what goes into the index is mechanically
 * extracted and always correct. The prose layer never touches this.
 */
export function renderDeterministicFacts(symbol: IrSymbol): string {
  const parts: string[] = [`${symbol.qualifiedName}`, symbol.signature];

  if (symbol.docComment?.summary) parts.push(`\n${symbol.docComment.summary}`);
  if (symbol.docComment?.description) parts.push(symbol.docComment.description);

  if (symbol.parameters.length > 0) {
    parts.push(
      '\nParameters:\n' +
        symbol.parameters
          .map((p) => {
            const type = p.type?.text ?? 'unknown';
            const optional = p.optional ? '?' : '';
            const description = p.description ? ` — ${p.description}` : '';
            return `  ${p.name}${optional}: ${type}${description}`;
          })
          .join('\n'),
    );
  }

  if (symbol.returnType) {
    const description = symbol.docComment?.returns?.description;
    parts.push(`\nReturns: ${symbol.returnType.text}${description ? ` — ${description}` : ''}`);
  }

  if (symbol.docComment?.throws.length) {
    parts.push(
      '\nThrows:\n' +
        symbol.docComment.throws.map((t) => `  ${t.type}: ${t.description}`).join('\n'),
    );
  }

  if (symbol.deprecated) {
    parts.push(`\nDEPRECATED: ${symbol.deprecated.reason || 'no reason given'}`);
  }

  if (symbol.httpBinding) {
    const binding = symbol.httpBinding;
    parts.push(`\nHTTP: ${binding.method} ${binding.route}`);
    if (binding.operationId) parts.push(`operationId: ${binding.operationId}`);
    if (binding.security.length) {
      parts.push(`Auth: ${binding.security.map((s) => s.scheme).join(', ')}`);
    }
    if (binding.responses.length) {
      parts.push(
        `Responses: ${binding.responses.map((r) => `${r.status} ${r.description}`.trim()).join('; ')}`,
      );
    }
  }

  if (symbol.decorators.length > 0) parts.push(`\nAttributes: ${symbol.decorators.join(' ')}`);

  return parts.filter(Boolean).join('\n');
}

/** Members whose retrieval value lies with their parent declaration. */
function isSubsumedByParent(symbol: IrSymbol): boolean {
  if (symbol.kind === 'enumMember') return true;
  if ((symbol.kind === 'field' || symbol.kind === 'property') && !symbol.docComment) return true;
  return false;
}

/**
 * Split oversized source at statement boundaries. Deliberately crude — a genuinely oversized
 * symbol is already a code smell, and precision here buys little. What matters is that the
 * split does not land mid-expression, and that consecutive pieces overlap so a statement near
 * a boundary is retrievable from either side.
 */
export function splitAtStatementBoundaries(
  source: string,
  maxTokens: number,
  overlapTokens: number,
): string[] {
  const lines = source.split('\n');
  const pieces: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  let depth = 0;

  for (const line of lines) {
    current.push(line);
    currentTokens += estimateTokens(line);

    for (const ch of line) {
      if ('{(['.includes(ch)) depth++;
      else if ('})]'.includes(ch)) depth--;
    }

    // Only break at depth 0 — inside a nested block there is no statement boundary worth using.
    const atBoundary = depth <= 0 && /[;}]\s*$/.test(line);
    if (currentTokens >= maxTokens && atBoundary) {
      pieces.push(current.join('\n'));
      const overlap: string[] = [];
      let overlapCount = 0;
      for (let i = current.length - 1; i >= 0 && overlapCount < overlapTokens; i--) {
        overlap.unshift(current[i]!);
        overlapCount += estimateTokens(current[i]!);
      }
      current = overlap;
      currentTokens = overlapCount;
    }
  }

  if (current.length > 0) pieces.push(current.join('\n'));
  return pieces.length > 0 ? pieces : [source];
}

/**
 * Token estimate.
 *
 * Approximate on purpose: an exact tokeniser would tie chunking to one provider's vocabulary,
 * and every provider's differs. ~3.5 characters per token is a reasonable average for source
 * code, which is denser in punctuation than prose. Used for budgeting, never for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
