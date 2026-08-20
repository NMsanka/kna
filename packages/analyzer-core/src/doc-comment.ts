import type { DocComment, Language } from '@kna/ir';
import { normalizeDocText } from '@kna/ir';

/**
 * Doc-comment parsing across the four dialects the platform supports.
 *
 * This lands in `analyzer-core` rather than in each analyser on purpose: §13 names the
 * analyser contract "the single highest-value spec in the project", and a JSDoc `@param` and a
 * Google-style `Args:` block must produce byte-identical IR. Three separate implementations
 * would drift within a quarter.
 */

const EMPTY_DOC: Omit<DocComment, 'format'> = {
  summary: '',
  description: null,
  params: [],
  returns: null,
  throws: [],
  examples: [],
  seeAlso: [],
  tags: {},
};

export function parseDocComment(raw: string, language: Language): DocComment | null {
  const text = normalizeDocText(raw);
  if (!text) return null;

  if (language === 'csharp' && text.includes('<summary>')) return parseXmlDoc(text);
  if (language === 'python') return parsePythonDoc(text);
  return parseJsDoc(text);
}

// ── JSDoc / TSDoc ──────────────────────────────────────────────────────────────────────────

const JSDOC_TAG = /^@(\w+)\s*(.*)$/;

function parseJsDoc(text: string): DocComment {
  const doc: DocComment = {
    ...EMPTY_DOC,
    format: 'jsdoc',
    params: [],
    throws: [],
    examples: [],
    seeAlso: [],
    tags: {},
  };
  const prose: string[] = [];
  const lines = text.split('\n');

  let currentTag: { name: string; buffer: string[] } | null = null;
  const flush = () => {
    if (!currentTag) return;
    applyJsDocTag(doc, currentTag.name, currentTag.buffer.join('\n').trim());
    currentTag = null;
  };

  for (const line of lines) {
    const tag = JSDOC_TAG.exec(line.trim());
    if (tag) {
      flush();
      currentTag = { name: tag[1]!.toLowerCase(), buffer: [tag[2] ?? ''] };
      continue;
    }
    if (currentTag) currentTag.buffer.push(line);
    else prose.push(line);
  }
  flush();

  assignProse(doc, prose);
  return doc;
}

function applyJsDocTag(doc: DocComment, tag: string, body: string): void {
  switch (tag) {
    case 'param':
    case 'arg':
    case 'argument': {
      // `@param {string} customerId The customer.` — braces optional in TSDoc.
      const typed = /^\{([^}]*)\}\s*(\S+)\s*-?\s*([\s\S]*)$/.exec(body);
      if (typed) {
        doc.params.push({
          name: stripOptional(typed[2]!),
          type: typed[1]!,
          description: typed[3]!.trim(),
        });
        return;
      }
      const untyped = /^(\S+)\s*-?\s*([\s\S]*)$/.exec(body);
      if (untyped) {
        doc.params.push({
          name: stripOptional(untyped[1]!),
          type: null,
          description: untyped[2]!.trim(),
        });
      }
      return;
    }
    case 'returns':
    case 'return': {
      const typed = /^\{([^}]*)\}\s*([\s\S]*)$/.exec(body);
      doc.returns = typed
        ? { type: typed[1]!, description: typed[2]!.trim() }
        : { type: null, description: body };
      return;
    }
    case 'throws':
    case 'exception': {
      const typed = /^\{([^}]*)\}\s*([\s\S]*)$/.exec(body);
      doc.throws.push(
        typed
          ? { type: typed[1]!, description: typed[2]!.trim() }
          : { type: 'Error', description: body },
      );
      return;
    }
    case 'example':
      doc.examples.push(body);
      return;
    case 'see':
    case 'link':
      doc.seeAlso.push(body);
      return;
    default:
      doc.tags[tag] = body;
  }
}

function stripOptional(name: string): string {
  return name.replace(/^\[(.+?)(?:=.*)?\]$/, '$1');
}

// ── C# XML documentation ───────────────────────────────────────────────────────────────────

function parseXmlDoc(text: string): DocComment {
  const doc: DocComment = {
    ...EMPTY_DOC,
    format: 'xmldoc',
    params: [],
    throws: [],
    examples: [],
    seeAlso: [],
    tags: {},
  };

  doc.summary = clean(extractTag(text, 'summary') ?? '');
  const remarks = extractTag(text, 'remarks');
  doc.description = remarks ? clean(remarks) : null;

  for (const m of text.matchAll(/<param\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/param>/g)) {
    doc.params.push({ name: m[1]!, type: null, description: clean(m[2]!) });
  }
  const returns = extractTag(text, 'returns');
  if (returns) doc.returns = { type: null, description: clean(returns) };

  for (const m of text.matchAll(/<exception\s+cref=["']([^"']+)["']\s*>([\s\S]*?)<\/exception>/g)) {
    doc.throws.push({ type: m[1]!.replace(/^T:/, ''), description: clean(m[2]!) });
  }
  for (const m of text.matchAll(/<example>([\s\S]*?)<\/example>/g)) {
    doc.examples.push(clean(m[1]!));
  }
  for (const m of text.matchAll(/<seealso\s+cref=["']([^"']+)["']\s*\/?>/g)) {
    doc.seeAlso.push(m[1]!.replace(/^[A-Z]:/, ''));
  }

  return doc;
}

function extractTag(text: string, tag: string): string | null {
  return new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(text)?.[1] ?? null;
}

function clean(value: string): string {
  return value
    .replace(/<see\s+cref=["']([^"']+)["']\s*\/?>/g, (_m, ref: string) =>
      ref.replace(/^[A-Z]:/, ''),
    )
    .replace(/<paramref\s+name=["']([^"']+)["']\s*\/?>/g, '$1')
    .replace(/<\/?(c|para|code|list|item|description|term)[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Python: Google, NumPy and Sphinx ────────────────────────────────────────────────────────

const GOOGLE_SECTION =
  /^(Args|Arguments|Parameters|Returns|Yields|Raises|Examples?|Note|Attributes)\s*:\s*$/;
const NUMPY_UNDERLINE = /^[-=]{3,}\s*$/;

function parsePythonDoc(text: string): DocComment {
  const lines = text.split('\n');

  if (lines.some((l) => GOOGLE_SECTION.test(l.trim()))) return parseGoogleDoc(lines);
  if (
    lines.some((l, i) => NUMPY_UNDERLINE.test(lines[i + 1]?.trim() ?? '') && l.trim().length > 0)
  ) {
    return parseNumpyDoc(lines);
  }
  if (/^\s*:(param|returns?|raises|rtype)\b/m.test(text)) return parseSphinxDoc(lines);

  const doc: DocComment = {
    ...EMPTY_DOC,
    format: 'plain',
    params: [],
    throws: [],
    examples: [],
    seeAlso: [],
    tags: {},
  };
  assignProse(doc, lines);
  return doc;
}

function parseGoogleDoc(lines: string[]): DocComment {
  const doc: DocComment = {
    ...EMPTY_DOC,
    format: 'google',
    params: [],
    throws: [],
    examples: [],
    seeAlso: [],
    tags: {},
  };
  const prose: string[] = [];
  let section: string | null = null;

  for (const line of lines) {
    const heading = GOOGLE_SECTION.exec(line.trim());
    if (heading) {
      section = heading[1]!.toLowerCase();
      continue;
    }
    if (!section) {
      prose.push(line);
      continue;
    }

    const body = line.trim();
    if (!body) continue;

    if (section === 'args' || section === 'arguments' || section === 'parameters') {
      // `customer_id (str): The customer identifier.`
      const m = /^(\*{0,2}\w+)\s*(?:\(([^)]*)\))?\s*:\s*(.*)$/.exec(body);
      if (m)
        doc.params.push({
          name: m[1]!.replace(/^\*+/, ''),
          type: m[2] ?? null,
          description: m[3]!,
        });
    } else if (section === 'returns' || section === 'yields') {
      const m = /^([\w.[\], ]+)\s*:\s*(.*)$/.exec(body);
      doc.returns = m
        ? { type: m[1]!.trim(), description: m[2]! }
        : { type: null, description: body };
    } else if (section === 'raises') {
      const m = /^(\w+)\s*:\s*(.*)$/.exec(body);
      doc.throws.push(
        m ? { type: m[1]!, description: m[2]! } : { type: 'Exception', description: body },
      );
    } else if (section.startsWith('example')) {
      doc.examples.push(body);
    } else {
      doc.tags[section] = `${doc.tags[section] ?? ''}${body}\n`.trim();
    }
  }

  assignProse(doc, prose);
  return doc;
}

function parseNumpyDoc(lines: string[]): DocComment {
  const doc: DocComment = {
    ...EMPTY_DOC,
    format: 'numpy',
    params: [],
    throws: [],
    examples: [],
    seeAlso: [],
    tags: {},
  };
  const prose: string[] = [];
  let section: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (NUMPY_UNDERLINE.test(lines[i + 1]?.trim() ?? '') && line.trim()) {
      section = line.trim().toLowerCase();
      i++;
      continue;
    }
    if (!section) {
      prose.push(line);
      continue;
    }

    const body = line.trim();
    if (!body) continue;

    if (section === 'parameters') {
      const m = /^(\w+)\s*:\s*(.*)$/.exec(body);
      if (m) doc.params.push({ name: m[1]!, type: m[2]!.trim(), description: '' });
      else if (doc.params.length > 0) {
        const last = doc.params[doc.params.length - 1]!;
        last.description = `${last.description} ${body}`.trim();
      }
    } else if (section === 'returns') {
      doc.returns = { type: body, description: '' };
    } else if (section === 'raises') {
      doc.throws.push({ type: body, description: '' });
    } else if (section === 'examples') {
      doc.examples.push(body);
    }
  }

  assignProse(doc, prose);
  return doc;
}

function parseSphinxDoc(lines: string[]): DocComment {
  const doc: DocComment = {
    ...EMPTY_DOC,
    format: 'sphinx',
    params: [],
    throws: [],
    examples: [],
    seeAlso: [],
    tags: {},
  };
  const prose: string[] = [];
  const types = new Map<string, string>();

  for (const line of lines) {
    const body = line.trim();
    const param = /^:param\s+(?:([\w.[\], ]+)\s+)?(\w+)\s*:\s*(.*)$/.exec(body);
    if (param) {
      doc.params.push({ name: param[2]!, type: param[1]?.trim() ?? null, description: param[3]! });
      continue;
    }
    const type = /^:type\s+(\w+)\s*:\s*(.*)$/.exec(body);
    if (type) {
      types.set(type[1]!, type[2]!);
      continue;
    }
    const returns = /^:returns?\s*:\s*(.*)$/.exec(body);
    if (returns) {
      doc.returns = { type: doc.returns?.type ?? null, description: returns[1]! };
      continue;
    }
    const rtype = /^:rtype\s*:\s*(.*)$/.exec(body);
    if (rtype) {
      doc.returns = { type: rtype[1]!, description: doc.returns?.description ?? '' };
      continue;
    }
    const raises = /^:raises?\s+(\w+)\s*:\s*(.*)$/.exec(body);
    if (raises) {
      doc.throws.push({ type: raises[1]!, description: raises[2]! });
      continue;
    }
    if (!body.startsWith(':')) prose.push(line);
  }

  for (const param of doc.params) {
    if (!param.type && types.has(param.name)) param.type = types.get(param.name)!;
  }

  assignProse(doc, prose);
  return doc;
}

/** First paragraph is the summary; the rest is the description. */
function assignProse(doc: DocComment, lines: string[]): void {
  const text = lines.join('\n').trim();
  if (!text) return;
  const split = text.indexOf('\n\n');
  if (split < 0) {
    doc.summary = text.replace(/\s+/g, ' ').trim();
    return;
  }
  doc.summary = text.slice(0, split).replace(/\s+/g, ' ').trim();
  const rest = text.slice(split).trim();
  doc.description = rest || null;
}
