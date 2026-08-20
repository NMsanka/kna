import type { IrSymbol } from '@kna/ir';

/**
 * Documentation staleness — a structural comparison, not a judgement (§4.2).
 *
 * "Because every generated document records which symbol IDs it was built from, you know
 * *deterministically* which pages are stale and can regenerate exactly those. This is the
 * difference between a system that costs a few cents per merge and one that costs hundreds of
 * dollars re-running an LLM over the whole corpus."
 *
 * The output is also what makes a doc PR reviewable in two minutes (§7 PR etiquette): the title
 * states the impact, and the body says exactly which symbols moved and how.
 */

export interface DocProvenance {
  documentId: string;
  slug: string;
  title: string;
  ownerTeam: string | null;
  symbolIds: string[];
  signatureHashes: Record<string, string>;
}

export type StalenessReason =
  | 'signature-changed'
  | 'symbol-removed'
  | 'symbol-renamed'
  | 'doc-comment-changed'
  | 'endpoint-changed';

export interface StaleFinding {
  symbolId: string;
  qualifiedName: string;
  reason: StalenessReason;
  detail: string;
  breaking: boolean;
}

export interface StalenessAssessment {
  documentId: string;
  slug: string;
  stale: boolean;
  /** 0–1. Drives ordering in the digest PR and the "how urgent is this" signal. */
  score: number;
  findings: StaleFinding[];
  /** §15.8 — auto-mergeable when every change is low risk. */
  lowRisk: boolean;
  /** Symbols the document cites that no longer exist anywhere — the page has dead links. */
  orphanedSymbolIds: string[];
}

export function assessStaleness(
  provenance: DocProvenance,
  currentSymbols: Map<string, IrSymbol>,
  aliases: Map<string, string> = new Map(),
): StalenessAssessment {
  const findings: StaleFinding[] = [];
  const orphaned: string[] = [];

  for (const symbolId of provenance.symbolIds) {
    // Follow the alias chain first. A rename must not present as a deletion, or every rename
    // orphans every page that cited the symbol (§15.1 fix 2).
    const currentId = aliases.get(symbolId) ?? symbolId;
    const symbol = currentSymbols.get(currentId);

    if (!symbol) {
      orphaned.push(symbolId);
      findings.push({
        symbolId,
        qualifiedName: symbolId,
        reason: 'symbol-removed',
        detail: 'Symbol no longer exists; this section is orphaned.',
        breaking: true,
      });
      continue;
    }

    if (currentId !== symbolId) {
      findings.push({
        symbolId,
        qualifiedName: symbol.qualifiedName,
        reason: 'symbol-renamed',
        detail: `Renamed; now ${symbol.qualifiedName}.`,
        breaking: true,
      });
      continue;
    }

    const recordedHash = provenance.signatureHashes[symbolId];
    if (recordedHash && recordedHash !== symbol.signatureHash) {
      findings.push({
        symbolId,
        qualifiedName: symbol.qualifiedName,
        reason: symbol.httpBinding ? 'endpoint-changed' : 'signature-changed',
        detail: `Signature is now: ${symbol.signature}`,
        breaking: true,
      });
    }
  }

  const total = Math.max(provenance.symbolIds.length, 1);
  const score = findings.length / total;

  // §15.8 — "auto-merge low-risk regenerations (doc-comment-only, added symbols) with post-hoc
  // review, batch the rest". Anything breaking is never low risk.
  const lowRisk = findings.length > 0 && findings.every((f) => !f.breaking);

  return {
    documentId: provenance.documentId,
    slug: provenance.slug,
    stale: findings.length > 0,
    score,
    findings,
    lowRisk,
    orphanedSymbolIds: orphaned,
  };
}

/**
 * §7 PR etiquette — "title the PR with the *impact*, not the mechanism: 'Billing API:
 * `CreateInvoiceAsync` signature changed — 3 docs affected'."
 */
export function renderPullRequestTitle(
  moduleName: string,
  assessments: StalenessAssessment[],
): string {
  const allFindings = assessments.flatMap((a) => a.findings);
  const breaking = allFindings.filter((f) => f.breaking);
  const docCount = assessments.length;

  if (breaking.length === 0) {
    return `${moduleName}: documentation refresh — ${docCount} page${docCount === 1 ? '' : 's'}`;
  }

  const headline = breaking[0]!;
  const others = breaking.length - 1;
  const suffix = others > 0 ? ` and ${others} other change${others === 1 ? '' : 's'}` : '';

  return `${moduleName}: \`${lastSegment(headline.qualifiedName)}\` ${describeReason(headline.reason)}${suffix} — ${docCount} doc${docCount === 1 ? '' : 's'} affected`;
}

/**
 * The PR body. §7 — "include the source diff and the symbol IDs in the PR body so review is
 * fast", and §15.8 — surface the accountable owner rather than just an assignee.
 */
export function renderPullRequestBody(input: {
  moduleName: string;
  ownerTeam: string | null;
  commitSha: string;
  assessments: StalenessAssessment[];
  autoMerged: boolean;
}): string {
  const lines: string[] = [];
  const allFindings = input.assessments.flatMap((a) => a.findings);
  const breaking = allFindings.filter((f) => f.breaking);

  lines.push(`Regenerated from \`${input.commitSha.slice(0, 8)}\`.`);
  lines.push('');

  if (breaking.length > 0) {
    lines.push(`### Potentially breaking (${breaking.length})`);
    lines.push('');
    for (const finding of breaking) {
      lines.push(`- **\`${finding.qualifiedName}\`** — ${describeReason(finding.reason)}`);
      lines.push(`  ${finding.detail}`);
      lines.push(`  <sub>\`${finding.symbolId}\`</sub>`);
    }
    lines.push('');
  }

  const nonBreaking = allFindings.filter((f) => !f.breaking);
  if (nonBreaking.length > 0) {
    lines.push(`### Other changes (${nonBreaking.length})`);
    lines.push('');
    for (const finding of nonBreaking) {
      lines.push(`- \`${finding.qualifiedName}\` — ${describeReason(finding.reason)}`);
    }
    lines.push('');
  }

  lines.push('### Pages');
  lines.push('');
  for (const assessment of input.assessments) {
    lines.push(`- \`${assessment.slug}\` — ${assessment.findings.length} change(s)`);
  }
  lines.push('');

  const orphaned = input.assessments.flatMap((a) => a.orphanedSymbolIds);
  if (orphaned.length > 0) {
    lines.push('### Orphaned sections');
    lines.push('');
    lines.push(
      `${orphaned.length} section(s) reference symbols that no longer exist. They have been marked for deletion rather than removed automatically — deleting documentation is a decision, not a consequence.`,
    );
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  if (input.ownerTeam) {
    lines.push(`Owned by ${input.ownerTeam}.`);
  }
  if (input.autoMerged) {
    lines.push(
      'This change is documentation-comment-only and was merged automatically. Review post hoc if you disagree — nothing here changes the shape of the API.',
    );
  } else {
    lines.push(
      'Hand-written commentary inside generated regions has been preserved. If a region shows a change you did not expect, that region was edited by a human and the generator left it alone.',
    );
  }

  return lines.join('\n');
}

function describeReason(reason: StalenessReason): string {
  switch (reason) {
    case 'signature-changed':
      return 'signature changed';
    case 'symbol-removed':
      return 'was removed';
    case 'symbol-renamed':
      return 'was renamed';
    case 'doc-comment-changed':
      return 'documentation updated';
    case 'endpoint-changed':
      return 'endpoint changed';
  }
}

function lastSegment(qualifiedName: string): string {
  return qualifiedName.split('.').pop() ?? qualifiedName;
}
