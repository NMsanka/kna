import { readFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { rulesetHash, scanFile, type Finding } from './scanner.js';
import { ALL_RULES } from './rules.js';

export const SCANNER_VERSION = '1.0.0';

export interface GateOptions {
  repoRoot: string;
  /** Absolute or repo-relative paths to scan. */
  files: string[];
  allowlist?: Array<{ path: string; rule: string; reason: string }>;
  extraSecretPatterns?: string[];
  concurrency?: number;
  onProgress?: (scanned: number, total: number) => void;
}

export interface GateResult {
  passed: boolean;
  findings: Finding[];
  /** Suppressed by a reviewed allowlist entry — reported but not blocking. */
  suppressed: Finding[];
  /** Injection patterns are logged for review, never blocking (§10 Layer 5). */
  flagged: Finding[];
  /** Files never read because of the hard path denylist. */
  deniedPaths: string[];
  stats: {
    filesScanned: number;
    filesSkipped: number;
    secretsFound: number;
    piiFound: number;
    injectionPatternsFlagged: number;
    durationMs: number;
  };
  scannerVersion: string;
  rulesetHash: string;
}

/**
 * §10 Layer 2 — "fail closed. On detection, refuse to publish that file's chunks, report the
 * finding to the developer, and exit non-zero in CI. Do not warn-and-continue."
 *
 * The gate returns `passed: false` when any unsuppressed secret or PII finding exists. Callers
 * must treat that as terminal: the CLI exits non-zero and the ingest endpoint rejects a bundle
 * whose scan report says otherwise.
 */
export async function runGate(options: GateOptions): Promise<GateResult> {
  const started = Date.now();
  const concurrency = options.concurrency ?? 16;

  const findings: Finding[] = [];
  const suppressed: Finding[] = [];
  const flagged: Finding[] = [];
  const deniedPaths: string[] = [];
  let filesScanned = 0;
  let filesSkipped = 0;

  const queue = [...options.files];
  const workers = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    for (;;) {
      const next = queue.pop();
      if (next === undefined) return;

      const absolute = resolve(options.repoRoot, next);
      const relPath = relative(options.repoRoot, absolute).split(sep).join('/');

      let content: string;
      try {
        content = await readFile(absolute, 'utf8');
      } catch {
        // Unreadable is not a pass: it is a skip, and the file is not published either.
        filesSkipped++;
        continue;
      }

      const result = scanFile({
        path: relPath,
        content,
        allowlist: options.allowlist,
        extraSecretPatterns: options.extraSecretPatterns,
      });

      if (result.skipped) {
        filesSkipped++;
        if (result.skipReason === 'denied-path') deniedPaths.push(relPath);
        continue;
      }

      filesScanned++;
      options.onProgress?.(filesScanned, options.files.length);

      for (const finding of result.findings) {
        if (finding.category === 'injection') flagged.push(finding);
        else if (finding.suppressedBy) suppressed.push(finding);
        else findings.push(finding);
      }
    }
  });

  await Promise.all(workers);

  const secretsFound = findings.filter((f) => f.category === 'secret').length;
  const piiFound = findings.filter((f) => f.category === 'pii').length;

  return {
    passed: findings.length === 0,
    findings: sortFindings(findings),
    suppressed: sortFindings(suppressed),
    flagged: sortFindings(flagged),
    deniedPaths,
    stats: {
      filesScanned,
      filesSkipped,
      secretsFound,
      piiFound,
      injectionPatternsFlagged: flagged.length,
      durationMs: Date.now() - started,
    },
    scannerVersion: SCANNER_VERSION,
    rulesetHash: rulesetHash(ALL_RULES),
  };
}

const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2 } as const;

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.path.localeCompare(b.path) ||
      a.line - b.line,
  );
}

/** Human-readable report for the CLI and for CI annotations. */
export function formatGateReport(result: GateResult): string {
  const lines: string[] = [];

  if (result.findings.length > 0) {
    lines.push(`Blocked: ${result.findings.length} finding(s) must be resolved before publish.`);
    lines.push('');
    for (const f of result.findings) {
      lines.push(`  ${f.severity.toUpperCase().padEnd(8)} ${f.path}:${f.line}:${f.column}`);
      lines.push(`           ${f.description} [${f.ruleId}]`);
      lines.push(`           value: ${f.redacted}`);
    }
    lines.push('');
    lines.push('A secret that reaches the index has also reached the embedding cache and the');
    lines.push('query logs. Rotate anything real, then remove it from the working tree — and');
    lines.push('from git history if it was ever committed.');
    lines.push('');
    lines.push('If a finding is a false positive, add a reviewed allowlist entry with a reason:');
    lines.push('  security.allowlist: [{ path, rule, reason }]');
  } else {
    lines.push(`Scan passed. ${result.stats.filesScanned} files scanned.`);
  }

  if (result.flagged.length > 0) {
    lines.push('');
    lines.push(`Flagged for review (not blocking): ${result.flagged.length} injection pattern(s).`);
    for (const f of result.flagged.slice(0, 10)) {
      lines.push(`  ${f.path}:${f.line}  ${f.description} [${f.ruleId}]`);
    }
    if (result.flagged.length > 10) lines.push(`  ...and ${result.flagged.length - 10} more`);
  }

  if (result.suppressed.length > 0) {
    lines.push('');
    lines.push(`Suppressed by allowlist: ${result.suppressed.length}`);
  }

  return lines.join('\n');
}

/** GitHub Actions annotation format, so findings appear inline on the PR. */
export function formatGitHubAnnotations(result: GateResult): string {
  return [...result.findings, ...result.flagged]
    .map((f) => {
      const level = f.category === 'injection' ? 'warning' : 'error';
      return `::${level} file=${f.path},line=${f.line},col=${f.column},title=${f.ruleId}::${f.description} (${f.redacted})`;
    })
    .join('\n');
}
