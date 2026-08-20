import { createHash } from 'node:crypto';
import type { Chunk } from './chunker.js';

/**
 * Near-duplicate detection (§15.5 HIGH).
 *
 * "Generated OpenAPI clients, vendored directories, copy-pasted DTOs and forked templates mean
 * one query can return eight byte-similar chunks from five repos, reducing effective top-8 to
 * effective top-1."
 *
 * The fix has three parts, and this module implements the index-time half:
 *  - SimHash clustering at index time, one canonical representative served per cluster;
 *  - a diversity constraint between fusion and reranking (see @kna/retrieval);
 *  - explicit detection and demotion of generated code.
 */

const HASH_BITS = 64;

/**
 * SimHash over shingled tokens. Chosen over MinHash because a 64-bit fingerprint with Hamming
 * distance is cheap to store on every chunk row and cheap to compare in SQL, and near-duplicate
 * source differs by small edits rather than by set membership.
 */
export function simhash(text: string): bigint {
  const tokens = shingle(normalizeForHashing(text), 3);
  if (tokens.length === 0) return 0n;

  const weights = new Array<number>(HASH_BITS).fill(0);
  for (const token of tokens) {
    const hash = hash64(token);
    for (let bit = 0; bit < HASH_BITS; bit++) {
      const isSet = (hash >> BigInt(bit)) & 1n;
      weights[bit]! += isSet ? 1 : -1;
    }
  }

  let fingerprint = 0n;
  for (let bit = 0; bit < HASH_BITS; bit++) {
    if (weights[bit]! > 0) fingerprint |= 1n << BigInt(bit);
  }
  return fingerprint;
}

export function hammingDistance(a: bigint, b: bigint): number {
  let xor = a ^ b;
  let count = 0;
  while (xor !== 0n) {
    count += Number(xor & 1n);
    xor >>= 1n;
  }
  return count;
}

export interface DuplicateCluster {
  clusterId: string;
  representativeChunkId: string;
  memberChunkIds: string[];
  /** Modules the cluster spans — surfaced to the user as "also present in N modules". */
  moduleIds: string[];
}

export interface ClusterResult {
  clusters: DuplicateCluster[];
  /** chunkId → clusterId, for stamping onto rows. */
  assignments: Map<string, string>;
  /** chunkIds that are the served representative of their cluster. */
  representatives: Set<string>;
}

export interface ClusterOptions {
  /** Hamming distance under which two chunks are considered near-identical. */
  threshold?: number;
  /** Chunks shorter than this are skipped — short chunks collide spuriously. */
  minTokens?: number;
}

/**
 * Cluster chunks by fingerprint similarity.
 *
 * Representative selection is not arbitrary: prefer a non-generated chunk, then one from a
 * module with a package name (a published library beats a vendored copy), then the longest.
 * Serving the vendored copy of a shared DTO as canonical is a small thing that reads as the
 * system not understanding the codebase.
 */
export function clusterChunks(chunks: Chunk[], options: ClusterOptions = {}): ClusterResult {
  const threshold = options.threshold ?? 3;
  const minTokens = options.minTokens ?? 40;

  const eligible = chunks.filter((c) => c.tokenCount >= minTokens);
  const fingerprints = new Map<string, bigint>();
  for (const chunk of eligible) fingerprints.set(chunk.id, simhash(chunk.content));

  const assignments = new Map<string, string>();
  const clusters: DuplicateCluster[] = [];
  const seen = new Set<string>();

  for (const chunk of eligible) {
    if (seen.has(chunk.id)) continue;

    const members = [chunk];
    seen.add(chunk.id);
    const fingerprint = fingerprints.get(chunk.id)!;

    for (const candidate of eligible) {
      if (seen.has(candidate.id)) continue;
      if (hammingDistance(fingerprint, fingerprints.get(candidate.id)!) <= threshold) {
        members.push(candidate);
        seen.add(candidate.id);
      }
    }

    if (members.length === 1) continue;

    const representative = pickRepresentative(members);
    const clusterId = `dup_${createHash('sha256')
      .update(
        members
          .map((m) => m.id)
          .sort()
          .join('|'),
      )
      .digest('hex')
      .slice(0, 24)}`;

    for (const member of members) assignments.set(member.id, clusterId);

    clusters.push({
      clusterId,
      representativeChunkId: representative.id,
      memberChunkIds: members.map((m) => m.id),
      moduleIds: [...new Set(members.map((m) => m.moduleId))],
    });
  }

  const representatives = new Set([
    ...clusters.map((c) => c.representativeChunkId),
    // Anything not in a cluster is trivially its own representative.
    ...chunks.filter((c) => !assignments.has(c.id)).map((c) => c.id),
  ]);

  return { clusters, assignments, representatives };
}

function pickRepresentative(members: Chunk[]): Chunk {
  return [...members].sort((a, b) => {
    if (a.generated !== b.generated) return a.generated ? 1 : -1;
    if (a.tokenCount !== b.tokenCount) return b.tokenCount - a.tokenCount;
    return a.id.localeCompare(b.id);
  })[0]!;
}

/**
 * Generated-code detection by path convention (§15.5: "explicitly detect and demote generated
 * code (`.openapi-generator`, `*.g.cs`, `*_pb2.py`)"). Demoted in ranking, never excluded — a
 * generated client is sometimes exactly the right answer to "how do I call this API".
 */
const GENERATED_PATH_PATTERNS = [
  /\.openapi-generator\//,
  /\.g\.cs$/i,
  /\.designer\.cs$/i,
  /_pb2(_grpc)?\.py$/,
  /\.pb\.go$/,
  /\.generated\.[tj]sx?$/,
  /(^|\/)generated(\/|$)/,
  /(^|\/)__generated__(\/|$)/,
  /\.d\.ts$/,
];

export function isGeneratedPath(path: string): boolean {
  return GENERATED_PATH_PATTERNS.some((p) => p.test(path));
}

function normalizeForHashing(text: string): string {
  return (
    text
      // Comments carry the context header, which is *designed* to differ per module — hashing it
      // would defeat the clustering it is meant to enable.
      .replace(/\/\/[^\n]*/g, ' ')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/#[^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase()
      .trim()
  );
}

function shingle(text: string, size: number): string[] {
  const words = text.split(' ').filter(Boolean);
  if (words.length < size) return words;
  const out: string[] = [];
  for (let i = 0; i <= words.length - size; i++) out.push(words.slice(i, i + size).join(' '));
  return out;
}

function hash64(input: string): bigint {
  const digest = createHash('sha256').update(input).digest();
  return digest.readBigUInt64BE(0);
}
