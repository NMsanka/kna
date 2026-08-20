import { describe, expect, it } from 'vitest';
import { makeDocComment, makeModule, makeSymbol } from '@kna/ir/testing';
import { chunkSymbols, estimateTokens, splitToBudget } from './chunker.js';

/**
 * The size bound.
 *
 * These tests exist because of a production failure, and they are written to fail in the same
 * way it did. The chunker skipped splitting entirely for symbols whose source was not uploaded —
 * which is the default posture (§10 Layer 1) — so a symbol with a large doc comment produced one
 * chunk of unbounded size. The embedding provider rejected it with "maximum input length is 8192
 * tokens", which failed the whole batch, which failed the module's index job.
 *
 * Nothing in the suite caught it, because every existing chunker test used small fixtures. The
 * bound is a contract with an external service, so it is asserted directly rather than inferred.
 */

const options = {
  module: makeModule(),
  versionId: 'ver_test',
  commitSha: 'a'.repeat(40),
  retrievalConfigVersion: 'cfgtest',
};

/** A doc comment large enough to exceed any sensible chunk budget on its own. */
function longProse(paragraphs: number): string {
  return Array.from(
    { length: paragraphs },
    (_, i) =>
      `Paragraph ${i}. ${'The deterministic facts for this symbol are described at length here. '.repeat(8)}`,
  ).join('\n\n');
}

describe('chunk size bound', () => {
  it('splits a symbol with no source text but an oversized doc comment', () => {
    const symbol = makeSymbol({
      sourceText: null,
      docComment: makeDocComment({ summary: longProse(60) }),
    });
    const chunks = chunkSymbols([symbol], { ...options, maxTokens: 400 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(400);
    }
  });

  it('splits a symbol with oversized source text', () => {
    const symbol = makeSymbol({
      sourceText: Array.from({ length: 400 }, (_, i) => `  const value${i} = compute(${i});`).join(
        '\n',
      ),
    });
    const chunks = chunkSymbols([symbol], { ...options, maxTokens: 400 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(estimateTokens(chunk.content)).toBeLessThanOrEqual(400);
    }
  });

  it('leaves a symbol that already fits as a single chunk', () => {
    const chunks = chunkSymbols([makeSymbol()], { ...options, maxTokens: 400 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.ordinal).toBe(0);
  });

  it('gives each piece of a split symbol a distinct ordinal', () => {
    const symbol = makeSymbol({ sourceText: 'x'.repeat(20_000) });
    const chunks = chunkSymbols([symbol], { ...options, maxTokens: 300 });
    const ordinals = chunks.map((c) => c.ordinal);
    expect(new Set(ordinals).size).toBe(ordinals.length);
  });

  it('stamps the retrieval config version on every chunk', () => {
    // §15.5 — the version is what identifies a chunk as built under superseded settings. It was
    // accepted as an option and never written, so the column held a literal 'v1' for every row.
    const chunks = chunkSymbols([makeSymbol()], options);
    expect(chunks.every((c) => c.retrievalConfigVersion === 'cfgtest')).toBe(true);
  });
});

describe('splitToBudget', () => {
  it('respects the budget for text with no statement boundaries at all', () => {
    const prose = longProse(80);
    for (const piece of splitToBudget(prose, 200, 0)) {
      expect(estimateTokens(piece)).toBeLessThanOrEqual(200);
    }
  });

  it('respects the budget for a single line longer than the budget', () => {
    // A minified bundle, a base64 blob, or a printed type with no newline in it. Both the
    // statement-boundary and line-boundary strategies return such a line whole.
    const oneLine = 'a'.repeat(50_000);
    const pieces = splitToBudget(oneLine, 200, 0);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(estimateTokens(piece)).toBeLessThanOrEqual(200);
    }
  });

  it('loses no content when splitting a single oversized line', () => {
    const oneLine = 'abcdefghij'.repeat(5_000);
    expect(splitToBudget(oneLine, 200, 0).join('')).toBe(oneLine);
  });

  it('returns the input unchanged when it already fits', () => {
    expect(splitToBudget('short enough', 200, 0)).toEqual(['short enough']);
  });
});
