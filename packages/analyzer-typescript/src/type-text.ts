/**
 * Put every union's members in a fixed order.
 *
 * The compiler does not promise one. The same declaration printed on two machines can come out
 * as `"development" | "test" | "staging" | "production"` here and
 * `"production" | "development" | "test" | "staging"` on CI, because a union's members are
 * ordered by type id and ids are assigned in the order the checker happens to create them.
 *
 * That is not cosmetic. `computeSymbolId` hashes the overload discriminator, which is the
 * parameter type list — so a parameter typed by an unstable union gives one declaration two
 * ids, and §7's cost model rests on re-analysing an unchanged commit producing no work at all.
 * It also made CI's "documentation is current" step fail against documentation that was
 * current: correct code, failing build, and no edit that could make it pass.
 *
 * Sorting is the cheapest fixed order that needs no agreement between machines.
 *
 * This has to parse, not pattern-match. A first attempt split on `|` wherever the bracket depth
 * was zero and mangled everything that is not a union: `{ a: X | Y; b: Z }` became
 * `{"Y; b: Z" | "a: X"}`, and `(x) => A | B` became `"B" | "(x) => A"`. The separators that bind
 * looser than `|` have to be handled first, in this order:
 *
 *   1. `;` and `,`   — member and parameter lists
 *   2. `? :`         — conditional types
 *   3. `:`           — a labelled member, whose type is everything to the right
 *   4. `=>`          — a function type, whose return type is everything to the right
 *   5. `|`           — the union itself, and the only thing reordered
 *   6. `&`           — intersections, recursed into but left in place
 *
 * Whitespace and the choice of `;` or `,` are preserved exactly, so the only thing that changes
 * in a signature is the order of union members.
 */

const OPENERS: Record<string, string | undefined> = { '{': '}', '(': ')', '[': ']', '<': '>' };
const CLOSERS = new Set(['}', ')', ']', '>']);
const BACKSLASH = 92;

export function normaliseTypeText(text: string): string {
  return text.trim().length === 0 ? text : normalise(text);
}

function normalise(text: string): string {
  const list = splitList(text);
  if (list.parts.length > 1) {
    return list.parts.map(normalise).reduce((acc, part, i) => acc + list.separators[i - 1] + part);
  }

  const conditional = splitConditional(text);
  if (conditional) {
    const [check, thenType, elseType] = conditional;
    return `${keep(check)}?${keep(thenType)}:${keep(elseType)}`;
  }

  // A labelled member: `name: T`, `name?: T`, `[key: string]: T`. Only the type is normalised —
  // the label is not a type and reordering anything in it would be nonsense.
  const label = indexOfTop(text, ':');
  if (label >= 0) {
    // The left side is descended into, not copied. On a printed signature it is not a bare
    // name — `createApiContext(env: {KNA_ENV: "a" | "b"}): Promise<T>` puts the whole parameter
    // list to the left of the return type's colon, and copying it verbatim left every union in
    // there in whatever order the compiler chose.
    return descend(text.slice(0, label + 1)) + keep(text.slice(label + 1));
  }

  // A function type. Its return type extends to the right, so `(x) => A | B` returns a union
  // rather than being a union of a function and a `B`.
  const arrow = indexOfTop(text, '=>');
  if (arrow >= 0) {
    return descend(text.slice(0, arrow)) + '=>' + keep(text.slice(arrow + 2));
  }

  const union = splitOn(text, '|');
  if (union.length > 1) {
    // Code-unit order, not locale order: two machines must agree, and localeCompare does not
    // promise that across ICU versions.
    return union
      .map(normalise)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .join(' | ');
  }

  const intersection = splitOn(text, '&');
  if (intersection.length > 1) {
    // Recursed into but not reordered. `A & B` and `B & A` are the same type, but an
    // intersection is usually written most-general-first and that reads as intended.
    return intersection.map(normalise).join(' & ');
  }

  return descend(text);
}

/** Recurse into every bracketed region, leaving the text between them exactly as it was. */
function descend(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (isQuote(ch)) {
      const end = endOfString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '=' && text[i + 1] === '>') {
      out += '=>';
      i += 2;
      continue;
    }
    const close = OPENERS[ch];
    if (close) {
      const end = matching(text, i);
      const inner = text.slice(i + 1, end);
      const lead = /^\s*/.exec(inner)![0];
      const trail = /\s*$/.exec(inner)![0];
      const body = inner.trim();
      out += ch + lead + (body.length ? normalise(body) : '') + trail + (text[end] ?? '');
      i = end + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Split a member or parameter list, keeping each separator exactly as written.
 *
 * TypeScript prints object types with `;` and parameter lists with `,`, and prints them with or
 * without a following space depending on where they came from. Rebuilding with a house style
 * would rewrite every signature in the corpus for no reason.
 */
function splitList(text: string): { parts: string[]; separators: string[] } {
  const parts: string[] = [];
  const separators: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    if (isQuote(ch)) {
      i = endOfString(text, i);
      continue;
    }
    if (ch === '=' && text[i + 1] === '>') {
      i += 2;
      continue;
    }
    if (OPENERS[ch]) depth += 1;
    else if (CLOSERS.has(ch)) depth -= 1;
    else if ((ch === ';' || ch === ',') && depth === 0) {
      parts.push(text.slice(start, i));
      const sep = /^[;,]\s*/.exec(text.slice(i))![0];
      separators.push(sep);
      i += sep.length;
      start = i;
      continue;
    }
    i += 1;
  }

  parts.push(text.slice(start));
  // A trailing separator leaves an empty last part; keep it attached rather than dropping it,
  // so `{ a: X; }` does not silently become `{ a: X }`.
  if (parts.length > 1 && parts[parts.length - 1]!.trim().length === 0) {
    const tail = parts.pop()!;
    const sep = separators.pop()!;
    parts[parts.length - 1] += sep + tail;
  }
  return { parts, separators };
}

/**
 * Normalise a fragment and put its surrounding whitespace back exactly.
 *
 * Only the order of union members should ever change. Rebuilding with a house style instead
 * would rewrite every signature in the corpus — a very large diff saying nothing.
 */
function keep(raw: string): string {
  const lead = /^\s*/.exec(raw)![0];
  const trail = /\s*$/.exec(raw)![0];
  const body = raw.slice(lead.length, raw.length - trail.length);
  return lead + (body.length ? normalise(body) : '') + trail;
}

/** `A extends B ? C : D`, distinguished from an optional member by what follows the `?`. */
function splitConditional(text: string): [string, string, string] | null {
  const question = indexOfTop(text, '?');
  if (question < 0 || text[question + 1] === ':') return null;
  const afterQuestion = text.slice(question + 1);
  const colon = indexOfTop(afterQuestion, ':');
  if (colon < 0) return null;
  return [text.slice(0, question), afterQuestion.slice(0, colon), afterQuestion.slice(colon + 1)];
}

function splitOn(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    if (isQuote(ch)) {
      i = endOfString(text, i);
      continue;
    }
    if (ch === '=' && text[i + 1] === '>') {
      i += 2;
      continue;
    }
    if (OPENERS[ch]) depth += 1;
    else if (CLOSERS.has(ch)) depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
    i += 1;
  }

  parts.push(text.slice(start).trim());
  // A leading `|`, which TypeScript sometimes prints, is not an empty member.
  return parts.filter((p) => p.length > 0);
}

/** Index of `needle` at bracket depth zero, or -1. */
function indexOfTop(text: string, needle: string): number {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (isQuote(ch)) {
      i = endOfString(text, i);
      continue;
    }
    if (ch === '=' && text[i + 1] === '>') {
      if (needle === '=>' && depth === 0) return i;
      i += 2;
      continue;
    }
    if (OPENERS[ch]) depth += 1;
    else if (CLOSERS.has(ch)) depth -= 1;
    else if (depth === 0 && text.startsWith(needle, i)) return i;
    i += 1;
  }
  return -1;
}

function isQuote(ch: string): boolean {
  return ch === '"' || ch === "'" || ch === '`';
}

function endOfString(text: string, start: number): number {
  const quote = text[start];
  let i = start + 1;
  while (i < text.length) {
    // 92 is a backslash; writing the literal is a needless escaping hazard.
    if (text.charCodeAt(i) === BACKSLASH) i += 2;
    else if (text[i] === quote) return i + 1;
    else i += 1;
  }
  return text.length;
}

function matching(text: string, start: number): number {
  const open = text[start]!;
  const close = OPENERS[open]!;
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const ch = text[i]!;
    if (isQuote(ch)) {
      i = endOfString(text, i);
      continue;
    }
    if (ch === '=' && text[i + 1] === '>') {
      i += 2;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return text.length;
}
