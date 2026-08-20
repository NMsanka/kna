/**
 * Shannon entropy over the observed character distribution.
 *
 * Used to gate the loose rules: `apiKey = "getUserByTenantId"` is an assignment that matches
 * the generic secret pattern but is obviously not a secret, and entropy separates the two
 * cheaply. Applied only where a rule declares `minEntropy`, because entropy alone is a poor
 * detector — high-entropy hashes, UUIDs and base64 test data are everywhere in a real repo.
 */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

const PLACEHOLDER_PATTERNS = [
  /^(?:x{4,}|\*{4,}|\.{4,}|-{4,}|0{4,})$/i,
  /\b(?:your|my|the)[_-]?(?:api)?[_-]?(?:key|token|secret|password)\b/i,
  /^(?:changeme|placeholder|example|sample|dummy|fake|test|todo|redacted|none|null|undefined)$/i,
  /^\$\{?[A-Z_][A-Z0-9_]*\}?$/,
  /^<[^>]+>$/,
  /^\{\{.*\}\}$/,
  /^%[A-Z_]+%$/,
];

/**
 * Obvious non-secrets. Suppressing these is the difference between a scanner people leave on
 * and one they disable on day two — but note the asymmetry: a false negative here is
 * unrecoverable, so the list only covers values that cannot be real credentials.
 */
export function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  return PLACEHOLDER_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * A camelCase or snake_case word that happens to be long. `apiKey = "getUserByTenantIdentifier"`
 * clears a 3.5-bit entropy bar comfortably — English letter distribution is not that far from
 * base62 — so entropy alone cannot separate an identifier from a key. Real credentials mix
 * character classes: digits, and usually punctuation from base64 or a vendor prefix.
 */
export function looksLikeNaturalIdentifier(value: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(value)) return false;

  const digits = (value.match(/\d/g) ?? []).length;
  const separators = (value.match(/[_.-]/g) ?? []).length;
  const digitRatio = digits / value.length;

  // Vendor keys are digit-rich; identifiers are not. Allow a version-ish digit or two.
  if (digitRatio > 0.15) return false;
  // A run of 6+ consecutive letters reads as words, not as random base62.
  return /[A-Za-z]{6,}/.test(value) && separators <= 3;
}

/**
 * Luhn check, so the credit-card rule does not fire on every long digit run.
 *
 * The leading-zero rejection is not cosmetic. A payment card's first digit is its Major
 * Industry Identifier, and 0 is unassigned — no real card begins with one. Without this,
 * `00000000-0000-0000-0000-000000000000` passes Luhn (its digits sum to zero), so every
 * codebase containing a nil UUID or a zero-padded numeric id gets a CRITICAL finding and a
 * blocked publish. Found by this repository's own fixture tripping the gate.
 */
export function isLuhnValid(candidate: string): boolean {
  const digits = candidate.replace(/[^\d]/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  if (digits.startsWith('0')) return false;

  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
