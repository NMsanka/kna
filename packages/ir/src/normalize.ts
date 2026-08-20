/**
 * Signature normalisation.
 *
 * `signatureHash` is the trigger for the entire regeneration pipeline (§7), so its stability
 * decides whether a Prettier upgrade costs nothing or opens four hundred documentation PRs.
 * The rule: a normalised signature must be invariant under formatting, and must change under
 * any semantic edit to the declared surface.
 *
 * Deliberately NOT invariant under parameter renames — a renamed public parameter is a
 * breaking change for callers using named arguments, and the docs should say so.
 */

const LINE_COMMENT = /(^|[^:])\/\/[^\n]*/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const HASH_COMMENT = /(^|\s)#[^\n]*/g;
const STRING_LITERAL = /(["'`])(?:\\.|(?!\1)[^\\])*\1/g;

/**
 * Placeholder for a masked string literal. Word characters only, so it survives the
 * punctuation-stripping pass unchanged; the prefix is improbable enough in real source that a
 * collision would require someone to write it deliberately.
 */
const SENTINEL_PATTERN = /KNAxLITx(\d+)xEND/g;
const sentinel = (index: number): string => `KNAxLITx${index}xEND`;

/** Spans of quoted text, so whitespace inside string literals survives collapsing. */
function protectLiterals(input: string): { masked: string; literals: string[] } {
  const literals: string[] = [];
  const masked = input.replace(STRING_LITERAL, (match) => {
    literals.push(match);
    return sentinel(literals.length - 1);
  });
  return { masked, literals };
}

function restoreLiterals(input: string, literals: string[]): string {
  return input.replace(
    SENTINEL_PATTERN,
    (match, index: string) => literals[Number(index)] ?? match,
  );
}

export type NormalizableLanguage = 'typescript' | 'javascript' | 'python' | 'csharp' | 'unknown';

/**
 * Produce the canonical rendering of a declaration signature.
 *
 * @param signature Signature as written in source.
 * @param language  Drives which comment syntax is stripped.
 */
export function normalizeSignature(
  signature: string,
  language: NormalizableLanguage = 'unknown',
): string {
  if (!signature) return '';
  const { masked, literals } = protectLiterals(signature);

  let s = masked;
  if (language === 'python') {
    s = s.replace(HASH_COMMENT, '$1');
  } else if (language !== 'unknown') {
    s = s.replace(BLOCK_COMMENT, ' ').replace(LINE_COMMENT, '$1');
  }

  s = s
    // Collapse all whitespace (incl. newlines from multi-line parameter lists) to one space.
    .replace(/\s+/g, ' ')
    // Drop space adjacent to structural punctuation.
    .replace(/\s*([(),;:<>[\]{}=|&?])\s*/g, '$1')
    // ...then restore separators. The stored form is user-visible — it lands in doc PR titles
    // and in generated reference pages — so it is canonicalised for readability, not minified.
    // A crushed `type X=A|B|C` is technically canonical and unreadable, which defeats the
    // purpose of putting it in front of a person.
    //
    // Each lookaround protects a compound operator that happens to share a character:
    // `::` (C# alias qualifier), `=>`, `==`/`<=`/`>=`/`!=`, and `||`.
    .replace(/,/g, ', ')
    .replace(/(?<!:):(?!:)/g, ': ')
    .replace(/=>/g, ' => ')
    .replace(/(?<![=!<>+\-*/&|])=(?![=>])/g, ' = ')
    .replace(/(?<!\|)\|(?!\|)/g, ' | ')
    .replace(/\s+/g, ' ')
    // A trailing comma before a closing bracket is pure formatting.
    .replace(/,\s*([)\]}>])/g, '$1')
    // Trailing statement terminators and body braces carry no signature meaning.
    .replace(/[;{]\s*$/, '')
    .trim();

  return restoreLiterals(s, literals);
}

const DOC_MARKER = /^\s*(\/\*\*?|\*\/|\*|\/\/\/?|#'?|#)\s?/;

/**
 * Normalise a doc comment for change detection: strip leading comment markers and collapse
 * blank runs, so re-indenting a JSDoc block is not a "documentation changed" event.
 */
export function normalizeDocText(text: string | null | undefined): string {
  if (!text) return '';
  return text
    .split('\n')
    .map((line) => line.replace(DOC_MARKER, '').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
