import type { IrSymbol } from '../schema/symbol.js';
import type { Parameter } from '../schema/primitives.js';
import type { BreakingChange } from './types.js';
import { SENSITIVITY_RANK } from '../schema/primitives.js';

const VISIBILITY_RANK: Record<string, number> = {
  public: 3,
  protected: 2,
  internal: 1,
  private: 0,
};

/**
 * Structural breaking-change detection. §4.2 — "drift detection becomes a structural diff, not
 * an LLM judgement". Everything here is a fact derivable from the IR; nothing is inferred by a
 * model, so a "breaking change" badge on a doc PR is never a guess.
 *
 * Confidence is downgraded to `likely` when either side was analysed at `shallow` depth, since
 * Tier 0 reports signatures as written rather than as resolved.
 */
export function detectBreakingChanges(before: IrSymbol, after: IrSymbol): BreakingChange[] {
  const out: BreakingChange[] = [];
  const confidence: 'certain' | 'likely' =
    before.analysisDepth === 'shallow' || after.analysisDepth === 'shallow' ? 'likely' : 'certain';

  if (VISIBILITY_RANK[after.visibility]! < VISIBILITY_RANK[before.visibility]!) {
    out.push({
      kind: 'visibility-reduced',
      detail: `${before.visibility} → ${after.visibility}`,
      confidence,
    });
  }

  out.push(...diffParameters(before.parameters, after.parameters, confidence));

  const beforeReturn = before.returnType?.text ?? null;
  const afterReturn = after.returnType?.text ?? null;
  if (beforeReturn !== afterReturn && (beforeReturn || afterReturn)) {
    out.push({
      kind: 'return-type-changed',
      detail: `${beforeReturn ?? '(none)'} → ${afterReturn ?? '(none)'}`,
      confidence,
    });
  }

  if (before.httpBinding || after.httpBinding) {
    // Note the missing `confidence` argument. HTTP bindings come from a build-generated
    // OpenAPI document — Tier 2, `analysisDepth: 'artifact'` — so these findings are certain
    // regardless of how deeply the surrounding code was analysed. Passing the symbol's
    // confidence through here would downgrade a fact to a guess.
    out.push(...diffHttpBinding(before, after));
  }

  return out;
}

function diffParameters(
  before: Parameter[],
  after: Parameter[],
  confidence: 'certain' | 'likely',
): BreakingChange[] {
  const out: BreakingChange[] = [];
  const afterByName = new Map(after.map((p) => [p.name, p]));
  const beforeByName = new Map(before.map((p) => [p.name, p]));

  for (const [i, b] of before.entries()) {
    const a = afterByName.get(b.name);
    if (!a) {
      // Could be a removal or a rename. Positional match with an identical type reads as a
      // rename, which is breaking for named-argument callers but not for positional ones.
      const positional = after[i];
      if (positional && !beforeByName.has(positional.name) && sameType(b, positional)) {
        out.push({
          kind: 'parameter-renamed',
          detail: `${b.name} → ${positional.name}`,
          confidence: 'likely',
        });
      } else {
        out.push({ kind: 'parameter-removed', detail: b.name, confidence });
      }
      continue;
    }
    if (!sameType(b, a)) {
      out.push({
        kind: 'parameter-type-changed',
        detail: `${b.name}: ${b.type?.text ?? '(untyped)'} → ${a.type?.text ?? '(untyped)'}`,
        confidence,
      });
    }
    if (b.optional && !a.optional) {
      out.push({ kind: 'parameter-made-required', detail: a.name, confidence });
    }
  }

  for (const a of after) {
    if (beforeByName.has(a.name)) continue;
    if (!a.optional && a.defaultValue === null && !a.rest) {
      out.push({ kind: 'parameter-added-required', detail: a.name, confidence });
    }
  }

  return out;
}

function sameType(a: Parameter, b: Parameter): boolean {
  return (a.type?.text ?? null) === (b.type?.text ?? null);
}

/**
 * Every finding here is `certain`, deliberately. The binding is extracted from a
 * build-generated OpenAPI document rather than inferred from source, so a route change or a
 * removed response is a fact about the published contract — and §7 gives these the highest
 * fan-out priority precisely because integration guides are the customer-facing surface.
 */
function diffHttpBinding(before: IrSymbol, after: IrSymbol): BreakingChange[] {
  const out: BreakingChange[] = [];
  const b = before.httpBinding;
  const a = after.httpBinding;

  if (b && !a) {
    out.push({ kind: 'endpoint-removed', detail: `${b.method} ${b.route}`, confidence: 'certain' });
    return out;
  }
  if (!b || !a) return out;

  if (b.route !== a.route) {
    out.push({ kind: 'route-changed', detail: `${b.route} → ${a.route}`, confidence: 'certain' });
  }
  if (b.method !== a.method) {
    out.push({
      kind: 'method-changed',
      detail: `${b.method} → ${a.method}`,
      confidence: 'certain',
    });
  }

  const beforeStatuses = new Set(b.responses.map((r) => r.status));
  for (const status of beforeStatuses) {
    if (!a.responses.some((r) => r.status === status)) {
      out.push({
        kind: 'response-removed',
        detail: `${status} response removed`,
        confidence: 'certain',
      });
    }
  }

  const beforeParams = new Map(b.parameters.map((p) => [`${p.in}:${p.name}`, p]));
  for (const p of a.parameters) {
    const key = `${p.in}:${p.name}`;
    const prior = beforeParams.get(key);
    if (!prior && p.required) {
      out.push({
        kind: 'request-field-required-added',
        detail: `${p.in} parameter '${p.name}' is now required`,
        confidence: 'certain',
      });
    } else if (prior && !prior.required && p.required) {
      out.push({
        kind: 'request-field-required-added',
        detail: `${p.in} parameter '${p.name}' became required`,
        confidence: 'certain',
      });
    }
  }

  const beforeSchemes = new Set(b.security.map((s) => s.scheme));
  for (const s of a.security) {
    if (!beforeSchemes.has(s.scheme)) {
      out.push({
        kind: 'security-added',
        detail: `new security requirement '${s.scheme}'`,
        confidence: 'certain',
      });
    }
  }

  return out;
}

/** Sensitivity may only ever be raised automatically; lowering it is a reviewed event (§15.7). */
export function isSensitivityDowngrade(before: IrSymbol, after: IrSymbol): boolean {
  return SENSITIVITY_RANK[after.sensitivity] < SENSITIVITY_RANK[before.sensitivity];
}
