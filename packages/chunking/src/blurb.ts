import type { IrModule, IrSymbol } from '@kna/ir';
import type { LlmClient } from '@kna/llm';

/**
 * Context blurb generation — Anthropic's contextual retrieval (§8).
 *
 * "Prepending a short LLM-generated context blurb to each chunk before embedding substantially
 * reduces retrieval failures, because a bare function body is nearly meaningless without
 * knowing what system it belongs to. Generate these blurbs once at index time with a cheap
 * model and cache them keyed by `signatureHash` — they only regenerate when the code actually
 * changes."
 *
 * This is the highest-volume LLM job in the system and, per §15.6, the single largest one-time
 * spend during a first index. Three things keep it affordable, all of them structural:
 *
 *  - The cache key is `signatureHash`, so a body-only change (the common case) costs nothing.
 *  - Batching by module gives a long shared prefix, which prompt caching discounts heavily.
 *  - The whole job runs on the batch virtual key, so it cannot 429 the chat path (§15.6).
 */

export const BLURB_PROMPT_VERSION = '1.0.0';

const SYSTEM_PROMPT = `You write one-sentence context notes that help a code search engine
retrieve the right symbol.

Given a module summary and a symbol, write a single sentence (under 30 words) that situates the
symbol: what it is for, and what part of the system it belongs to.

Rules:
- State only what the provided facts support. Never guess at behaviour that is not shown.
- Do not restate the signature; the search engine already has it.
- No preamble, no quotes, no markdown. One sentence.
- If the facts are too thin to say anything useful, output exactly: (no context available)`;

export interface BlurbRequest {
  symbol: IrSymbol;
  module: IrModule;
}

export interface BlurbResult {
  signatureHash: string;
  moduleId: string;
  blurb: string;
  model: string;
  promptVersion: string;
}

export interface GenerateBlurbsOptions {
  client: LlmClient;
  orgId: string;
  repoId?: string;
  /** Already-cached hashes, so only genuine misses cost anything. */
  cachedSignatureHashes?: Set<string>;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function generateBlurbs(
  requests: BlurbRequest[],
  options: GenerateBlurbsOptions,
): Promise<BlurbResult[]> {
  const cached = options.cachedSignatureHashes ?? new Set<string>();

  // Deduplicate within the batch too: an interface and its five implementations frequently
  // share a signature hash, and paying five times for one blurb is pure waste.
  const pending = new Map<string, BlurbRequest>();
  for (const request of requests) {
    if (cached.has(request.symbol.signatureHash)) continue;
    if (request.symbol.sensitivity === 'restricted') continue;
    if (!pending.has(request.symbol.signatureHash)) {
      pending.set(request.symbol.signatureHash, request);
    }
  }

  const queue = [...pending.values()];
  const results: BlurbResult[] = [];
  const concurrency = Math.min(options.concurrency ?? 8, Math.max(queue.length, 1));
  let done = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        const request = queue.pop();
        if (!request) return;

        try {
          const result = await generateOne(request, options);
          if (result) results.push(result);
        } catch {
          // A blurb is an enhancement, not a requirement: the deterministic part of the context
          // header still situates the chunk. Failing the whole index over a prose sentence
          // would be a poor trade.
        } finally {
          options.onProgress?.(++done, pending.size);
        }
      }
    }),
  );

  return results;
}

async function generateOne(
  request: BlurbRequest,
  options: GenerateBlurbsOptions,
): Promise<BlurbResult | null> {
  const { symbol, module } = request;

  const response = await options.client.complete({
    workload: 'context-blurb',
    orgId: options.orgId,
    ...(options.repoId ? { repoId: options.repoId } : {}),
    contentSensitivity: symbol.sensitivity,
    maxTokens: 80,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: renderBlurbPrompt(symbol, module) },
    ],
  });

  const blurb = response.text.trim().replace(/^["']|["']$/g, '');
  if (!blurb || blurb === '(no context available)') return null;

  return {
    signatureHash: symbol.signatureHash,
    moduleId: symbol.moduleId,
    blurb,
    model: response.model,
    promptVersion: BLURB_PROMPT_VERSION,
  };
}

/**
 * Prompt layout puts the module preamble first and the symbol last, deliberately: the module
 * block is identical for every symbol in a module, so it is exactly the repeated prefix that
 * prompt caching discounts (§11 cost levers).
 */
export function renderBlurbPrompt(symbol: IrSymbol, module: IrModule): string {
  return [
    `Module: ${module.name}`,
    module.packageName ? `Package: ${module.packageName} (${module.ecosystem})` : null,
    `Languages: ${module.languages.join(', ')}`,
    module.owners.length ? `Owned by: ${module.owners.join(', ')}` : null,
    '',
    '---',
    '',
    `Symbol: ${symbol.qualifiedName}`,
    `Kind: ${symbol.visibility} ${symbol.kind}`,
    `File: ${symbol.sourceRef.path}`,
    `Signature: ${symbol.signature}`,
    symbol.docComment?.summary ? `Documented as: ${symbol.docComment.summary}` : null,
    symbol.decorators.length ? `Attributes: ${symbol.decorators.join(' ')}` : null,
    symbol.httpBinding
      ? `HTTP endpoint: ${symbol.httpBinding.method} ${symbol.httpBinding.route}`
      : null,
    symbol.edges.usedBy.length ? `Referenced by ${symbol.edges.usedBy.length} other symbols` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}
