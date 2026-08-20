import { createHash } from 'node:crypto';
import {
  isLuhnValid,
  isPlaceholder,
  looksLikeNaturalIdentifier,
  shannonEntropy,
} from './entropy.js';
import {
  ALL_RULES,
  DENY_PATH_PATTERNS,
  SKIP_PATH_PATTERNS,
  shouldSuppressInTests,
  type Category,
  type Rule,
  type Severity,
} from './rules.js';

export interface Finding {
  ruleId: string;
  category: Category;
  severity: Severity;
  path: string;
  line: number;
  column: number;
  /** Never the secret itself. Enough to locate it, not enough to leak it further. */
  redacted: string;
  description: string;
  /** Set when a repo allowlist entry matched; kept in the report for audit. */
  suppressedBy: string | null;
}

export interface ScanOptions {
  /** Repo-relative path, used for denylist and test-directory heuristics. */
  path: string;
  content: string;
  rules?: Rule[];
  allowlist?: Array<{ path: string; rule: string; reason: string }>;
  extraSecretPatterns?: string[];
  /** Stop after this many findings in one file — a leaked key file has thousands. */
  maxFindingsPerFile?: number;
}

export interface FileScanResult {
  path: string;
  findings: Finding[];
  skipped: boolean;
  skipReason: 'denied-path' | 'binary-or-generated' | 'too-large' | null;
}

const MAX_SCAN_BYTES = 2 * 1024 * 1024;

/** A file matching the hard denylist is never read, never analysed, never published. */
export function isDeniedPath(path: string): boolean {
  return DENY_PATH_PATTERNS.some((p) => p.test(path));
}

export function isSkippablePath(path: string): boolean {
  return SKIP_PATH_PATTERNS.some((p) => p.test(path));
}

export function scanFile(options: ScanOptions): FileScanResult {
  const { path, content } = options;

  if (isDeniedPath(path)) {
    return { path, findings: [], skipped: true, skipReason: 'denied-path' };
  }
  if (isSkippablePath(path)) {
    return { path, findings: [], skipped: true, skipReason: 'binary-or-generated' };
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_SCAN_BYTES) {
    // Too large to be hand-written source. Skipping is safe because it is also not indexed.
    return { path, findings: [], skipped: true, skipReason: 'too-large' };
  }

  const rules = [...(options.rules ?? ALL_RULES), ...compileExtra(options.extraSecretPatterns)];
  const lineStarts = computeLineStarts(content);
  const findings: Finding[] = [];
  const cap = options.maxFindingsPerFile ?? 100;

  for (const rule of rules) {
    if (shouldSuppressInTests(rule, path)) continue;
    if (rule.excludePaths?.some((p) => p.test(path))) continue;

    // Rules are module-level and carry the /g lastIndex; reset defensively.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(content)) !== null) {
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }

      const captured =
        rule.captureGroup != null ? (match[rule.captureGroup] ?? match[0]) : match[0];
      if (!passesHeuristics(rule, captured)) continue;

      const { line, column } = positionOf(match.index, lineStarts);
      const suppressedBy = findSuppression(options.allowlist, path, rule.id);

      findings.push({
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        path,
        line,
        column,
        redacted: redact(captured),
        description: rule.description,
        suppressedBy,
      });

      if (findings.length >= cap) {
        return { path, findings, skipped: false, skipReason: null };
      }
    }
  }

  return { path, findings, skipped: false, skipReason: null };
}

function passesHeuristics(rule: Rule, captured: string): boolean {
  if (rule.category === 'secret' && isPlaceholder(captured)) return false;
  // Only the loose, identifier-shaped rules need this. A rule with a vendor prefix has already
  // proved what it matched, and suppressing it on shape would be a false negative.
  if (rule.minEntropy != null && looksLikeNaturalIdentifier(captured)) return false;
  if (rule.minEntropy != null && shannonEntropy(captured) < rule.minEntropy) return false;
  if (rule.id === 'credit-card' && !isLuhnValid(captured)) return false;
  if (rule.id === 'iban' && !isPlausibleIban(captured)) return false;
  return true;
}

function isPlausibleIban(value: string): boolean {
  // Mod-97 check; without it, the pattern fires on constants like `US20240115ABCDEF`.
  const rearranged = value.slice(4) + value.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = ch.charCodeAt(0);
    const digits = code >= 65 && code <= 90 ? String(code - 55) : ch;
    for (const d of digits) remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return remainder === 1;
}

/** Show shape and location, never material. Four leading chars is enough to find it in an editor. */
export function redact(value: string): string {
  if (value.length <= 8) return `${value.slice(0, 1)}${'*'.repeat(Math.max(value.length - 1, 3))}`;
  return `${value.slice(0, 4)}${'*'.repeat(8)}${value.slice(-2)} (${value.length} chars)`;
}

function findSuppression(
  allowlist: ScanOptions['allowlist'],
  path: string,
  ruleId: string,
): string | null {
  const entry = allowlist?.find((a) => a.rule === ruleId && matchesGlobish(path, a.path));
  return entry ? entry.reason : null;
}

/** Deliberately simple glob: `*` within a segment, `**` across segments. */
function matchesGlobish(path: string, pattern: string): boolean {
  if (pattern === path) return true;
  const escaped = pattern
    .split('**')
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .split('*')
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${escaped}$`).test(path);
}

function compileExtra(patterns: string[] | undefined): Rule[] {
  if (!patterns?.length) return [];
  return patterns.map((source, i) => ({
    id: `repo-custom-${i}`,
    description: 'Repository-defined secret pattern',
    category: 'secret' as const,
    severity: 'high' as const,
    pattern: new RegExp(source, 'g'),
  }));
}

function computeLineStarts(content: string): number[] {
  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function positionOf(index: number, lineStarts: number[]): { line: number; column: number } {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (lineStarts[mid]! <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - lineStarts[lo]! + 1 };
}

/** Stable hash of the active ruleset, recorded on every bundle's scan report. */
export function rulesetHash(rules: Rule[] = ALL_RULES): string {
  const canonical = rules
    .map((r) => `${r.id}:${r.pattern.source}:${r.pattern.flags}:${r.minEntropy ?? ''}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32);
}
