/**
 * Contract versions. §15.1 structural fix 2 — "version every contract, from day one".
 *
 * These are the only three numbers that make schema migration survivable. Every IR bundle
 * carries `irSchemaVersion`; every symbol carries the algorithm version that produced its id;
 * every persisted row carries the version that wrote it, so a background migration can find
 * stale rows with a `WHERE` clause instead of a flag day.
 */

/**
 * Semantic version of the IR schema itself. Bump MINOR for additive optional fields,
 * MAJOR for anything an N-2 upcast cannot repair.
 */
export const IR_SCHEMA_VERSION = '1.1.0' as const;

/**
 * Oldest bundle schema the ingest endpoint will accept. §15.3 — "CLI version skew across the
 * org is unmanaged" — an N-2 window with explicit upcast functions at ingest.
 */
export const IR_SCHEMA_MIN_SUPPORTED = '1.0.0' as const;

/**
 * Version of the symbol-id derivation algorithm. Changing this invalidates every provenance
 * link in every published document, so it must never change silently: a bump requires an
 * alias-table backfill (see `SymbolAlias`).
 */
export const SYMBOL_ID_ALGORITHM_VERSION = 2 as const;

/** Parsed semver triple, for the N-2 window check. */
export function parseVersion(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) throw new Error(`Not a semantic version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * True when `candidate` is not newer than this runtime and is within its N-2 MAJOR window.
 *
 * A newer minor version can contain additive fields that this runtime's Zod schema does not
 * know. Zod strips unknown object keys, so accepting that bundle would mutate the payload before
 * integrity verification and produce a misleading hash-mismatch error. More importantly, it
 * could silently discard knowledge. Forward compatibility therefore requires a runtime upgrade;
 * only older compatible bundles are upcast here.
 */
export function isWithinSupportWindow(
  candidate: string,
  current: string = IR_SCHEMA_VERSION,
): boolean {
  const candidateVersion = parseVersion(candidate);
  const currentVersion = parseVersion(current);
  const [candidateMajor] = candidateVersion;
  const [currentMajor] = currentVersion;
  return (
    candidateMajor >= currentMajor - 2 && compareVersions(candidateVersion, currentVersion) <= 0
  );
}

export function compareVersions(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let index = 0; index < left.length; index += 1) {
    const difference = left[index]! - right[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}
