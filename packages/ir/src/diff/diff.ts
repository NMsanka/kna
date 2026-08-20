import type { IrSymbol } from '../schema/symbol.js';
import type { IrBundlePayload } from '../schema/bundle.js';
import { contentHash } from '../hash.js';
import { detectBreakingChanges } from './breaking.js';
import {
  CHANGE_ACTIONS,
  type ChangeClass,
  type IrDiff,
  type ModuleDiffSummary,
  type SymbolChange,
} from './types.js';

/**
 * Diff two IR snapshots symbol by symbol.
 *
 * The whole synchronisation design (§7) rests on this being deterministic and cheap: it is a
 * hash comparison over a map, not a model call, and it runs on every push.
 */
export function diffIr(before: IrBundlePayload | null, after: IrBundlePayload): IrDiff {
  const beforeSymbols = new Map<string, IrSymbol>();
  const aliasToCurrent = new Map<string, string>();

  for (const s of before?.symbols ?? []) {
    beforeSymbols.set(s.id, s);
  }
  // Rename tracking: an analyser that could prove a rename emitted the old id in previousIds.
  for (const s of after.symbols) {
    for (const prev of s.previousIds) aliasToCurrent.set(prev, s.id);
  }

  const changes: SymbolChange[] = [];
  const seenBefore = new Set<string>();

  for (const afterSymbol of after.symbols) {
    let beforeSymbol = beforeSymbols.get(afterSymbol.id) ?? null;
    let renamed = false;

    if (!beforeSymbol) {
      for (const prev of afterSymbol.previousIds) {
        const candidate = beforeSymbols.get(prev);
        if (candidate) {
          beforeSymbol = candidate;
          renamed = true;
          break;
        }
      }
    }

    if (beforeSymbol) seenBefore.add(beforeSymbol.id);

    changes.push(classifySymbol(beforeSymbol, afterSymbol, renamed));
  }

  for (const [id, beforeSymbol] of beforeSymbols) {
    if (seenBefore.has(id) || aliasToCurrent.has(id)) continue;
    changes.push({
      symbolId: id,
      qualifiedName: beforeSymbol.qualifiedName,
      moduleId: beforeSymbol.moduleId,
      changeClass: 'removed',
      action: CHANGE_ACTIONS.removed,
      reasons: ['Symbol no longer present at the indexed commit'],
      breaking: [
        { kind: 'symbol-removed', detail: beforeSymbol.qualifiedName, confidence: 'certain' },
      ],
      before: beforeSymbol,
      after: null,
    });
  }

  return summarise(before, after, changes);
}

function classifySymbol(before: IrSymbol | null, after: IrSymbol, renamed: boolean): SymbolChange {
  const base = {
    symbolId: after.id,
    qualifiedName: after.qualifiedName,
    moduleId: after.moduleId,
    before,
    after,
  };

  if (!before) {
    return {
      ...base,
      changeClass: 'added',
      action: CHANGE_ACTIONS.added,
      reasons: [`New ${after.kind} ${after.qualifiedName}`],
      breaking: [],
    };
  }

  const reasons: string[] = [];
  let cls: ChangeClass = 'unchanged';

  const httpChanged =
    contentHash(before.httpBinding) !== contentHash(after.httpBinding) &&
    (before.httpBinding !== null || after.httpBinding !== null);
  const signatureChanged = before.signatureHash !== after.signatureHash;
  const visibilityChanged = before.visibility !== after.visibility;
  const docChanged = (before.docHash ?? '') !== (after.docHash ?? '');
  const deprecationChanged = contentHash(before.deprecated) !== contentHash(after.deprecated);
  const bodyChanged = (before.bodyHash ?? '') !== (after.bodyHash ?? '');
  const moved =
    before.sourceRef.path !== after.sourceRef.path ||
    before.sourceRef.startLine !== after.sourceRef.startLine;

  // Ordered by blast radius, not by likelihood: the highest-consequence class wins.
  if (renamed) {
    cls = 'renamed';
    reasons.push(`Renamed from ${before.qualifiedName}`);
  } else if (httpChanged) {
    cls = 'http-binding-changed';
    reasons.push('HTTP binding changed - integration guides affected');
  } else if (signatureChanged) {
    cls = 'signature-changed';
    reasons.push(`Signature changed: ${before.signature} -> ${after.signature}`);
  } else if (visibilityChanged) {
    cls = 'visibility-changed';
    reasons.push(`Visibility ${before.visibility} -> ${after.visibility}`);
  } else if (deprecationChanged) {
    cls = 'deprecation-changed';
    reasons.push(after.deprecated ? 'Marked deprecated' : 'Deprecation removed');
  } else if (docChanged) {
    cls = 'doc-changed';
    reasons.push('Documentation comment changed');
  } else if (bodyChanged) {
    cls = 'body-changed';
    reasons.push('Implementation changed; public surface stable');
  } else if (moved) {
    cls = 'moved';
    reasons.push(`Moved to ${after.sourceRef.path}:${after.sourceRef.startLine}`);
  } else if (before.signature !== after.signature) {
    // Same canonical hash but different raw text - reformatting only. This is the branch that
    // stops a Prettier upgrade from opening four hundred documentation PRs (§15.3).
    cls = 'formatting-only';
    reasons.push('Formatting only - canonical signature unchanged');
  }

  const breaking =
    cls === 'signature-changed' ||
    cls === 'visibility-changed' ||
    cls === 'http-binding-changed' ||
    cls === 'renamed'
      ? detectBreakingChanges(before, after)
      : [];

  return { ...base, changeClass: cls, action: CHANGE_ACTIONS[cls], reasons, breaking };
}

function summarise(
  before: IrBundlePayload | null,
  after: IrBundlePayload,
  changes: SymbolChange[],
): IrDiff {
  const byModule = new Map<string, ModuleDiffSummary>();
  const moduleTotals = new Map<string, number>();

  for (const s of after.symbols) {
    moduleTotals.set(s.moduleId, (moduleTotals.get(s.moduleId) ?? 0) + 1);
  }

  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  let breaking = 0;
  let reindexCount = 0;
  let regenerateCount = 0;

  for (const c of changes) {
    const summary =
      byModule.get(c.moduleId) ??
      ({
        moduleId: c.moduleId,
        added: 0,
        removed: 0,
        changed: 0,
        unchanged: 0,
        breaking: 0,
        churnRatio: 0,
      } satisfies ModuleDiffSummary);

    if (c.changeClass === 'added') {
      added++;
      summary.added++;
    } else if (c.changeClass === 'removed') {
      removed++;
      summary.removed++;
    } else if (c.changeClass === 'unchanged' || c.changeClass === 'formatting-only') {
      unchanged++;
      summary.unchanged++;
    } else {
      changed++;
      summary.changed++;
    }

    if (c.breaking.length > 0) {
      breaking++;
      summary.breaking++;
    }
    if (c.action.reindex) reindexCount++;
    if (c.action.regenerate) regenerateCount++;

    byModule.set(c.moduleId, summary);
  }

  for (const summary of byModule.values()) {
    const total =
      moduleTotals.get(summary.moduleId) ??
      summary.added + summary.removed + summary.changed + summary.unchanged;
    const touched = summary.added + summary.removed + summary.changed;
    summary.churnRatio = total > 0 ? touched / total : 0;
  }

  const symbolsAfter = after.symbols.length;
  const touchedTotal = added + removed + changed;

  return {
    repoId: after.repo.id,
    fromCommitSha: before?.version.commitSha ?? null,
    toCommitSha: after.version.commitSha,
    changes,
    modules: [...byModule.values()],
    totals: {
      symbolsBefore: before?.symbols.length ?? 0,
      symbolsAfter,
      added,
      removed,
      changed,
      unchanged,
      breaking,
      reindexCount,
      regenerateCount,
      churnRatio: symbolsAfter > 0 ? touchedTotal / symbolsAfter : touchedTotal > 0 ? 1 : 0,
    },
  };
}
