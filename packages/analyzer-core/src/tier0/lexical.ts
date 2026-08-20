import type { Language, RawSymbol, SymbolKind, Visibility } from '@kna/ir';
import { sha256Hex } from '@kna/ir';
import { parseDocComment } from '../doc-comment.js';

/**
 * Tier 0 — the universal floor (§5).
 *
 * "Works on any language, no toolchain, tolerates broken code... This is the floor. Every repo
 * gets at least this, immediately, with zero setup. It is also what makes the CLI feel instant
 * on first run — a critical adoption factor."
 *
 * Everything this produces is marked `analysisDepth: 'shallow'` and must never be presented
 * with the confidence of semantic output. It sees signatures *as written*: no type resolution,
 * no inference, no cross-file call graph. What it does give you, universally and instantly, is
 * structure — which symbols exist, where, with what doc comments and what shape.
 *
 * A tree-sitter backend (see `treesitter.ts`) supersedes this when grammars are available; the
 * two are interchangeable behind `Tier0Parser` and produce the same IR semantics.
 */

export interface Tier0Input {
  path: string;
  content: string;
  language: Language;
  commitSha: string;
  generated: boolean;
}

interface Container {
  qualifiedName: string;
  kind: SymbolKind;
  /** Indentation (Python) or brace depth (braced languages) at which this container closes. */
  closeAt: number;
}

const TS_DECLARATION =
  /^(?<indent>\s*)(?<modifiers>(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:static\s+)?(?:readonly\s+)?(?:public\s+|private\s+|protected\s+)?)(?<keyword>class|interface|enum|type|function|const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)(?<rest>.*)$/;

const TS_METHOD =
  /^(?<indent>\s*)(?<modifiers>(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|abstract\s+|override\s+|async\s+|get\s+|set\s+)*)(?<name>[A-Za-z_$#][\w$]*)\s*(?<generics><[^>]*>)?\s*\((?<params>[^)]*)\)\s*(?<returns>:[^{;=]+)?\s*[{;]/;

const PY_DECLARATION =
  /^(?<indent>\s*)(?<async>async\s+)?(?<keyword>def|class)\s+(?<name>[A-Za-z_]\w*)\s*(?<rest>.*)$/;

const CS_TYPE =
  /^(?<indent>\s*)(?<modifiers>(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|sealed\s+|abstract\s+|partial\s+|readonly\s+|record\s+)*)(?<keyword>class|interface|struct|record|enum)\s+(?<name>[A-Za-z_]\w*)(?<rest>.*)$/;

const CS_MEMBER =
  /^(?<indent>\s*)(?<modifiers>(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|virtual\s+|override\s+|abstract\s+|async\s+|sealed\s+|extern\s+|new\s+)+)(?<returns>[\w<>,[\]?.\s]+?)\s+(?<name>[A-Za-z_]\w*)\s*(?<generics><[^>]*>)?\s*(?<params>\([^)]*\))?\s*(?<tail>[{;=]|=>)/;

const CS_NAMESPACE = /^\s*namespace\s+(?<name>[\w.]+)\s*[;{]?/;

export function parseTier0(input: Tier0Input): RawSymbol[] {
  switch (input.language) {
    case 'typescript':
    case 'javascript':
      return parseBracedTs(input);
    case 'python':
      return parsePython(input);
    case 'csharp':
      return parseCSharp(input);
    default:
      return [];
  }
}

// ── TypeScript / JavaScript ────────────────────────────────────────────────────────────────

function parseBracedTs(input: Tier0Input): RawSymbol[] {
  const lines = input.content.split('\n');
  const symbols: RawSymbol[] = [];
  const containers: Container[] = [];
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentOrEmpty(line)) {
      depth += braceDelta(line);
      continue;
    }

    while (containers.length > 0 && depth <= containers[containers.length - 1]!.closeAt) {
      containers.pop();
    }

    const decl = TS_DECLARATION.exec(line);
    if (decl?.groups) {
      const { modifiers = '', keyword, name, rest = '' } = decl.groups as Record<string, string>;
      const kind = tsKeywordToKind(keyword!, rest);
      if (kind) {
        const parent = containers[containers.length - 1];
        const qualifiedName = parent ? `${parent.qualifiedName}.${name}` : name!;
        const signature = collectSignature(lines, i);

        symbols.push(
          makeRawSymbol({
            input,
            name: name!,
            qualifiedName,
            kind,
            signature,
            visibility: tsVisibility(modifiers, name!),
            modifiers: modifiers.trim().split(/\s+/).filter(Boolean),
            parentQualifiedName: parent?.qualifiedName ?? null,
            startLine: i + 1,
            endLine: i + 1 + signature.split('\n').length - 1,
            doc: precedingDoc(lines, i),
            params: extractParams(signature, 'typescript'),
          }),
        );

        if (kind === 'class' || kind === 'interface' || kind === 'enum') {
          containers.push({ qualifiedName, kind, closeAt: depth });
        }
      }
    } else if (containers.length > 0) {
      const method = TS_METHOD.exec(line);
      // Guard against control-flow keywords, which match the method shape exactly.
      if (method?.groups && !TS_KEYWORDS.has(method.groups.name!)) {
        const { modifiers = '', name } = method.groups as Record<string, string>;
        const parent = containers[containers.length - 1]!;
        const qualifiedName = `${parent.qualifiedName}.${name}`;
        const signature = collectSignature(lines, i);

        symbols.push(
          makeRawSymbol({
            input,
            name: name!,
            qualifiedName,
            kind: parent.kind === 'interface' ? 'method' : 'method',
            signature,
            visibility: tsVisibility(modifiers, name!),
            modifiers: modifiers.trim().split(/\s+/).filter(Boolean),
            parentQualifiedName: parent.qualifiedName,
            startLine: i + 1,
            endLine: i + 1,
            doc: precedingDoc(lines, i),
            params: extractParams(signature, 'typescript'),
          }),
        );
      }
    }

    depth += braceDelta(line);
  }

  return symbols;
}

const TS_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'function',
  'constructor',
  'do',
  'else',
  'try',
  'typeof',
  'await',
  'new',
  'delete',
  'throw',
]);

function tsKeywordToKind(keyword: string, rest: string): SymbolKind | null {
  switch (keyword) {
    case 'class':
      return 'class';
    case 'interface':
      return 'interface';
    case 'enum':
      return 'enum';
    case 'type':
      return 'type';
    case 'function':
      return 'function';
    case 'const':
    case 'let':
    case 'var':
      // Only arrow functions and function expressions are worth a symbol; a plain constant is
      // noise in a code-search index unless it is exported and typed.
      if (/=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>/.test(rest)) return 'function';
      if (/=\s*(?:async\s+)?function\b/.test(rest)) return 'function';
      if (/^\s*:\s*/.test(rest)) return 'constant';
      return null;
    default:
      return null;
  }
}

function tsVisibility(modifiers: string, name: string): Visibility {
  if (/\bprivate\b/.test(modifiers) || name.startsWith('#') || name.startsWith('_'))
    return 'private';
  if (/\bprotected\b/.test(modifiers)) return 'protected';
  if (/\bexport\b/.test(modifiers)) return 'public';
  return 'internal';
}

// ── Python ─────────────────────────────────────────────────────────────────────────────────

function parsePython(input: Tier0Input): RawSymbol[] {
  const lines = input.content.split('\n');
  const symbols: RawSymbol[] = [];
  const containers: Container[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*(#|$)/.test(line)) continue;

    const decl = PY_DECLARATION.exec(line);
    if (!decl?.groups) continue;

    const { indent = '', keyword, name } = decl.groups as Record<string, string>;
    const indentWidth = indent.replace(/\t/g, '    ').length;

    while (containers.length > 0 && indentWidth <= containers[containers.length - 1]!.closeAt) {
      containers.pop();
    }

    const parent = containers[containers.length - 1];
    const qualifiedName = parent ? `${parent.qualifiedName}.${name}` : name!;
    const signature = collectSignature(lines, i, ':');
    const kind: SymbolKind = keyword === 'class' ? 'class' : parent ? 'method' : 'function';

    symbols.push(
      makeRawSymbol({
        input,
        name: name!,
        qualifiedName,
        kind,
        signature,
        // Python has no access modifiers; the convention is the contract.
        visibility: name!.startsWith('__')
          ? 'private'
          : name!.startsWith('_')
            ? 'internal'
            : 'public',
        modifiers: decl.groups.async ? ['async'] : [],
        decorators: precedingDecorators(lines, i),
        parentQualifiedName: parent?.qualifiedName ?? null,
        startLine: i + 1,
        endLine: i + 1,
        doc: followingDocstring(lines, i),
        params: extractParams(signature, 'python'),
      }),
    );

    containers.push({ qualifiedName, kind, closeAt: indentWidth });
  }

  return symbols;
}

// ── C# ─────────────────────────────────────────────────────────────────────────────────────

function parseCSharp(input: Tier0Input): RawSymbol[] {
  const lines = input.content.split('\n');
  const symbols: RawSymbol[] = [];
  const containers: Container[] = [];
  let namespaceName = '';
  let depth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isCommentOrEmpty(line)) {
      depth += braceDelta(line);
      continue;
    }

    const ns = CS_NAMESPACE.exec(line);
    if (ns?.groups) {
      namespaceName = ns.groups.name!;
      depth += braceDelta(line);
      continue;
    }

    while (containers.length > 0 && depth <= containers[containers.length - 1]!.closeAt) {
      containers.pop();
    }

    const type = CS_TYPE.exec(line);
    if (type?.groups) {
      const { modifiers = '', keyword, name } = type.groups as Record<string, string>;
      const parent = containers[containers.length - 1];
      const prefix = parent?.qualifiedName ?? namespaceName;
      const qualifiedName = prefix ? `${prefix}.${name}` : name!;
      const kind = csKeywordToKind(keyword!);
      const signature = collectSignature(lines, i);

      symbols.push(
        makeRawSymbol({
          input,
          name: name!,
          qualifiedName,
          kind,
          signature,
          visibility: csVisibility(modifiers),
          modifiers: modifiers.trim().split(/\s+/).filter(Boolean),
          decorators: precedingAttributes(lines, i),
          parentQualifiedName: parent?.qualifiedName ?? null,
          startLine: i + 1,
          endLine: i + 1,
          doc: precedingDoc(lines, i),
          params: [],
        }),
      );

      containers.push({ qualifiedName, kind, closeAt: depth });
      depth += braceDelta(line);
      continue;
    }

    if (containers.length > 0) {
      const member = CS_MEMBER.exec(line);
      if (member?.groups && !CS_KEYWORDS.has(member.groups.name!)) {
        const {
          modifiers = '',
          name,
          params,
          returns,
          tail,
        } = member.groups as Record<string, string>;
        const parent = containers[containers.length - 1]!;
        const qualifiedName = `${parent.qualifiedName}.${name}`;
        const signature = collectSignature(lines, i);
        const kind: SymbolKind = params ? 'method' : tail === '{' ? 'property' : 'field';

        symbols.push(
          makeRawSymbol({
            input,
            name: name!,
            qualifiedName,
            kind,
            signature,
            visibility: csVisibility(modifiers),
            modifiers: modifiers.trim().split(/\s+/).filter(Boolean),
            decorators: precedingAttributes(lines, i),
            parentQualifiedName: parent.qualifiedName,
            startLine: i + 1,
            endLine: i + 1,
            doc: precedingDoc(lines, i),
            params: params ? extractParams(signature, 'csharp') : [],
            returnTypeText: returns?.trim() ?? null,
          }),
        );
      }
    }

    depth += braceDelta(line);
  }

  return symbols;
}

const CS_KEYWORDS = new Set([
  'if',
  'for',
  'foreach',
  'while',
  'switch',
  'catch',
  'return',
  'using',
  'lock',
]);

function csKeywordToKind(keyword: string): SymbolKind {
  switch (keyword) {
    case 'interface':
      return 'interface';
    case 'record':
      return 'record';
    case 'struct':
      return 'struct';
    case 'enum':
      return 'enum';
    default:
      return 'class';
  }
}

function csVisibility(modifiers: string): Visibility {
  if (/\bpublic\b/.test(modifiers)) return 'public';
  if (/\bprotected\b/.test(modifiers)) return 'protected';
  if (/\binternal\b/.test(modifiers)) return 'internal';
  return 'private';
}

// ── Shared helpers ─────────────────────────────────────────────────────────────────────────

function isCommentOrEmpty(line: string): boolean {
  return /^\s*(\/\/|\/\*|\*|$)/.test(line);
}

function braceDelta(line: string): number {
  // Strip strings and comments so braces inside them do not shift the depth. Crude by design:
  // Tier 0 tolerates being wrong here, and Tier 1 supersedes it wherever a toolchain exists.
  const stripped = line
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '');
  let delta = 0;
  for (const ch of stripped) {
    if (ch === '{') delta++;
    else if (ch === '}') delta--;
  }
  return delta;
}

/** Gather a declaration that wraps across lines, up to a terminator or a sane line budget. */
function collectSignature(lines: string[], start: number, terminator = '{'): string {
  const first = lines[start]!.trim();
  if (first.includes(terminator) || first.endsWith(';') || balanced(first)) {
    return first.replace(/\s*\{\s*$/, '').trim();
  }

  const parts = [first];
  for (let i = start + 1; i < Math.min(start + 25, lines.length); i++) {
    const line = lines[i]!.trim();
    parts.push(line);
    const joined = parts.join(' ');
    if (
      balanced(joined) &&
      (line.includes(terminator) || line.endsWith(';') || line.endsWith(')'))
    ) {
      break;
    }
  }
  return parts
    .join(' ')
    .replace(/\s*\{\s*$/, '')
    .trim();
}

function balanced(text: string): boolean {
  let parens = 0;
  let angles = 0;
  for (const ch of text) {
    if (ch === '(') parens++;
    else if (ch === ')') parens--;
    else if (ch === '<') angles++;
    else if (ch === '>') angles--;
  }
  return parens <= 0 && angles <= 0 && text.includes('(');
}

function precedingDoc(lines: string[], index: number): string | null {
  const collected: string[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line === '') {
      if (collected.length > 0) break;
      continue;
    }
    if (/^(\/\*\*|\*|\*\/|\/\/\/|\/\/)/.test(line)) {
      collected.unshift(line);
      if (line.startsWith('/**')) break;
      continue;
    }
    // An attribute or decorator sits between the doc and the declaration.
    if (/^[[@]/.test(line)) continue;
    break;
  }
  return collected.length > 0 ? collected.join('\n') : null;
}

function followingDocstring(lines: string[], declIndex: number): string | null {
  for (let i = declIndex + 1; i < Math.min(declIndex + 6, lines.length); i++) {
    const line = lines[i]!.trim();
    if (line === '') continue;
    const opener = /^(?:[rRbBuU]{0,2})("""|''')/.exec(line);
    if (!opener) return null;

    const quote = opener[1]!;
    const rest = line.slice(opener[0].length);
    if (rest.includes(quote)) return rest.slice(0, rest.indexOf(quote));

    const body = [rest];
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j]!;
      const close = next.indexOf(quote);
      if (close >= 0) {
        body.push(next.slice(0, close));
        return body.join('\n').trim();
      }
      body.push(next);
    }
    return body.join('\n').trim();
  }
  return null;
}

function precedingDecorators(lines: string[], index: number): string[] {
  const out: string[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (line.startsWith('@')) out.unshift(line);
    else if (line === '') continue;
    else break;
  }
  return out;
}

function precedingAttributes(lines: string[], index: number): string[] {
  const out: string[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (/^\[.*\]$/.test(line)) out.unshift(line);
    else if (line === '' || /^(\/\/\/|\/\/|\*)/.test(line)) continue;
    else break;
  }
  return out;
}

/** Parameters as written. Types are unresolved strings — that is the Tier 0 contract. */
export function extractParams(signature: string, language: Language): RawSymbol['parameters'] {
  const open = signature.indexOf('(');
  if (open < 0) return [];
  const close = findMatching(signature, open);
  if (close < 0) return [];

  const inner = signature.slice(open + 1, close).trim();
  if (!inner) return [];

  return splitTopLevel(inner).map((raw) => {
    const part = raw.trim();
    const rest = part.replace(/^(?:this|self|cls)\b\s*,?\s*/, '');
    if (!rest) {
      return {
        name: part,
        type: null,
        optional: false,
        defaultValue: null,
        rest: false,
        description: null,
      };
    }

    const defaultSplit = splitOnce(rest, '=');
    const head = defaultSplit[0]!.trim();
    const defaultValue = defaultSplit[1]?.trim() ?? null;

    let name = head;
    let typeText: string | null = null;
    let optional = false;
    let isRest = false;

    if (language === 'csharp') {
      // `Guid id` / `[FromBody] CreateInvoice body` / `params string[] tags`
      const tokens = head.replace(/^\[[^\]]*\]\s*/, '').split(/\s+/);
      name = tokens[tokens.length - 1] ?? head;
      typeText = tokens.slice(0, -1).join(' ') || null;
      isRest = /\bparams\b/.test(head);
      optional = defaultValue !== null;
    } else {
      const colon = head.indexOf(':');
      if (colon >= 0) {
        name = head.slice(0, colon).trim();
        typeText = head.slice(colon + 1).trim() || null;
      }
      if (name.endsWith('?')) {
        optional = true;
        name = name.slice(0, -1);
      }
      if (name.startsWith('...') || name.startsWith('*')) {
        isRest = true;
        name = name.replace(/^(\.\.\.|\*+)/, '');
      }
      optional = optional || defaultValue !== null;
    }

    return {
      name: name.trim(),
      type: typeText
        ? {
            text: typeText,
            symbolId: null,
            package: null,
            nullable: /\?$|\| *null|Optional\[/.test(typeText),
            isArray: /\[\]$|List\[|Array<|IEnumerable</.test(typeText),
            typeArguments: [],
          }
        : null,
      optional,
      defaultValue,
      rest: isRest,
      description: null,
    };
  });
}

function findMatching(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on commas that are not inside brackets, so `Map<string, number>` stays one parameter. */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if ('<([{'.includes(ch)) depth++;
    else if ('>)]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

function splitOnce(input: string, separator: string): [string, string?] {
  let depth = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if ('<([{'.includes(ch)) depth++;
    else if ('>)]}'.includes(ch)) depth--;
    else if (ch === separator && depth === 0 && input[i + 1] !== '>' && input[i - 1] !== '=') {
      return [input.slice(0, i), input.slice(i + 1)];
    }
  }
  return [input];
}

interface MakeSymbolArgs {
  input: Tier0Input;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  signature: string;
  visibility: Visibility;
  modifiers: string[];
  decorators?: string[];
  parentQualifiedName: string | null;
  startLine: number;
  endLine: number;
  doc: string | null;
  params: RawSymbol['parameters'];
  returnTypeText?: string | null;
}

function makeRawSymbol(args: MakeSymbolArgs): RawSymbol {
  const doc = args.doc ? parseDocComment(args.doc, args.input.language) : null;
  return {
    previousIds: [],
    qualifiedName: args.qualifiedName,
    name: args.name,
    kind: args.kind,
    language: args.input.language,
    visibility: args.visibility,
    signature: args.signature,
    parameters: args.params,
    returnType: args.returnTypeText
      ? {
          text: args.returnTypeText,
          symbolId: null,
          package: null,
          nullable: args.returnTypeText.includes('?'),
          isArray: /\[\]$/.test(args.returnTypeText),
          typeArguments: [],
        }
      : null,
    typeParameters: [],
    typeRefs: [],
    docComment: doc,
    deprecated: doc?.tags.deprecated
      ? { since: null, reason: doc.tags.deprecated, replacement: null }
      : null,
    modifiers: args.modifiers,
    decorators: args.decorators ?? [],
    edges: { calls: [], implements: [], extends: [], references: [] },
    unresolved: [],
    httpBinding: null,
    sourceRef: {
      path: args.input.path,
      startLine: args.startLine,
      endLine: args.endLine,
      commitSha: args.input.commitSha,
    },
    // The whole point of Tier 0: honest about what it knows.
    analysisDepth: 'shallow',
    sourceText: null,
    bodyHash: sha256Hex(args.signature),
    generated: args.input.generated,
    overloadDiscriminator: args.params.map((p) => p.type?.text ?? '?').join(','),
    parentQualifiedName: args.parentQualifiedName,
  };
}
