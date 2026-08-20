import { createHash } from 'node:crypto';

/** Hex sha256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** First `len` hex chars of a sha256 — used for ids, where 128 bits is ample. */
export function sha256Short(input: string, len = 32): string {
  return sha256Hex(input).slice(0, len);
}

/**
 * Deterministic JSON: keys sorted at every level, undefined dropped. Two structurally equal
 * objects always produce the same string, so content hashes are stable across Node versions
 * and across analyser implementations.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortDeep);
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) {
    if (src[key] === undefined) continue;
    out[key] = sortDeep(src[key]);
  }
  return out;
}

/** Content hash of arbitrary structured data. */
export function contentHash(value: unknown): string {
  return sha256Hex(stableStringify(value));
}
