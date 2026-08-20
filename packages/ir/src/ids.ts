import { sha256Short } from './hash.js';
import { SYMBOL_ID_ALGORITHM_VERSION } from './version.js';

/**
 * Identity derivation.
 *
 * §15.1 fix 2 flags the naive `sha256(repo + module + qualifiedName)` as not rename-stable:
 * moving `src/Acme.Billing` to `src/services/Acme.Billing` silently invalidates provenance in
 * every published document and every eval item keyed to those symbols.
 *
 * Algorithm v2 fixes the common case by keying on the module's *logical* identity — its
 * published package name — and only falling back to the filesystem path when the module does
 * not publish one. A path rename of an npm/NuGet/PyPI package is then a no-op for identity.
 *
 * The residual cases (a package rename, an unpublished module moving) are handled by the
 * alias table rather than by the hash, because no hash can be stable across a rename it
 * cannot observe. Analysers emit `previousIds` when they can prove the link; the platform
 * persists them as `symbol_aliases` and redirects reads.
 */

/**
 * Structural type rather than an import of `Ecosystem` from the schema: identity derivation
 * must not depend on Zod, so the CLI can compute ids in hot loops without schema overhead.
 */
type EcosystemLike = 'npm' | 'nuget' | 'pypi' | 'go' | 'maven' | 'none';

/** Stable logical key for a module. Prefers package identity over filesystem location. */
export function moduleKey(input: {
  repoId: string;
  path: string;
  ecosystem: EcosystemLike;
  packageName?: string | null;
}): string {
  if (input.packageName && input.ecosystem !== 'none') {
    return `pkg:${input.ecosystem}/${input.packageName}`;
  }
  return `path:${input.repoId}/${normalizePath(input.path)}`;
}

/** Repo-relative paths are normalised to forward slashes with no leading or trailing slash. */
export function normalizePath(p: string): string {
  return p
    .split('\\')
    .join('/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '');
}

/**
 * Repo identity is the canonical git remote, not a random uuid, so two independent CI runs
 * for the same repo agree without coordinating through the database.
 */
export function computeRepoId(orgId: string, remoteUrl: string): string {
  return `repo_${sha256Short(`${orgId}\n${canonicalRemote(remoteUrl)}`, 32)}`;
}

/** Strip credentials, protocol, `.git` suffix and case, so ssh and https forms agree. */
export function canonicalRemote(remoteUrl: string): string {
  let u = remoteUrl.trim();
  u = u.replace(/^[a-z]+:\/\//i, '').replace(/^git@/, '');
  u = u.replace(/^[^@/]+@/, '');
  u = u.replace(/:/g, '/');
  // Trailing dots and slashes are noise a human typed, not part of the repository's identity.
  // Stripping them before the `.git` suffix matters: a remote recorded as `repo.git.` would
  // otherwise keep its suffix, and correcting the typo later would change `repoId` — orphaning
  // every symbol, chunk and document already indexed under the old one.
  u = u.replace(/[./]+$/, '');
  u = u.replace(/\.git$/i, '');
  u = u.replace(/[./]+$/, '');
  return u.toLowerCase();
}

export function computeModuleId(orgId: string, key: string): string {
  return `mod_${sha256Short(`v${SYMBOL_ID_ALGORITHM_VERSION}\n${orgId}\n${key}`, 32)}`;
}

export interface SymbolIdInput {
  orgId: string;
  moduleKey: string;
  language: string;
  kind: string;
  qualifiedName: string;
  /**
   * Disambiguator for overloads, which share a qualified name. Analysers pass the normalised
   * parameter type list; without it, C# and TypeScript overload sets collapse into one symbol.
   */
  overloadDiscriminator?: string | null;
}

export function computeSymbolId(input: SymbolIdInput): string {
  const parts = [
    `v${SYMBOL_ID_ALGORITHM_VERSION}`,
    input.orgId,
    input.moduleKey,
    input.language,
    input.kind,
    input.qualifiedName,
    input.overloadDiscriminator ?? '',
  ];
  return `sym_${sha256Short(parts.join('\n'), 40)}`;
}

/** Chunk identity is content-addressed within a symbol, so re-chunking is idempotent. */
export function computeChunkId(symbolId: string, ordinal: number, contentHashHex: string): string {
  return `chk_${sha256Short(`${symbolId}\n${ordinal}\n${contentHashHex}`, 40)}`;
}

const ID_PREFIXES = ['repo_', 'mod_', 'sym_', 'chk_', 'doc_', 'org_', 'prj_'] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];

export function isId(value: string, prefix?: IdPrefix): boolean {
  if (prefix) return value.startsWith(prefix) && /^[a-z]+_[0-9a-f]{32,40}$/.test(value);
  return ID_PREFIXES.some((p) => value.startsWith(p)) && /^[a-z]+_[0-9a-f]{32,40}$/.test(value);
}
