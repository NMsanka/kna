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
  if (!matchesKnownIssuer(digits)) return false;

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

/**
 * Whether a digit run is consistent with a real card scheme's length *and* prefix.
 *
 * Luhn alone is a weak filter: it passes one in ten arbitrary digit runs, and long numeric
 * identifiers are everywhere. A Shopify theme's section id — `template--22224696705326` — is
 * fourteen digits, passes Luhn, and blocked a publish with a CRITICAL "payment card" finding.
 *
 * Card numbers are not free-form. Each scheme fixes a length and an issuer prefix, so a
 * fourteen-digit number beginning `2222` belongs to no scheme that exists: at fourteen digits
 * only Diners Club is assigned, and `2221–2720` is Mastercard, which is always sixteen.
 * Checking the pair rejects the identifier while still catching every real card.
 *
 * This narrows detection deliberately, so it is worth being precise about what it gives up: a
 * card from a scheme not listed here is missed. That is the right trade for a fail-closed gate —
 * a false positive blocks a publish and teaches people to reach for the allowlist, and an
 * allowlist entry added in irritation is how a real credential gets waved through later.
 */
function matchesKnownIssuer(digits: string): boolean {
  const n = digits.length;
  const starts = (...prefixes: string[]) => prefixes.some((p) => digits.startsWith(p));
  const between = (from: number, to: number, width: number) => {
    const head = Number(digits.slice(0, width));
    return head >= from && head <= to;
  };

  // Visa: 13, 16 or 19 digits, always 4.
  if ((n === 13 || n === 16 || n === 19) && starts('4')) return true;

  // Mastercard: 16 digits, 51–55 or the 2221–2720 range.
  if (n === 16 && (between(51, 55, 2) || between(2221, 2720, 4))) return true;

  // American Express: 15 digits, 34 or 37.
  if (n === 15 && starts('34', '37')) return true;

  // Diners Club: 14 digits, 300–305, 3095, 36, 38, 39. The only 14-digit scheme.
  if (n === 14 && (between(300, 305, 3) || starts('3095', '36', '38', '39'))) return true;

  // Discover: 16 or 19 digits.
  if (
    (n === 16 || n === 19) &&
    (starts('6011', '65') || between(644, 649, 3) || between(622126, 622925, 6))
  ) {
    return true;
  }

  // JCB: 16–19 digits, 3528–3589.
  if (n >= 16 && n <= 19 && between(3528, 3589, 4)) return true;

  // UnionPay: 16–19 digits, 62.
  if (n >= 16 && n <= 19 && starts('62')) return true;

  return false;
}
