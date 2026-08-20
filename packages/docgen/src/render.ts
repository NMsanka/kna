import type { HttpBinding, IrModule, IrSymbol } from '@kna/ir';

/**
 * The deterministic renderer (§6).
 *
 *   Deterministic renderer  →  facts, tables, signatures, diagrams   (always correct)
 *           +
 *   LLM prose layer         →  narrative, rationale, examples        (bounded by facts)
 *
 * Nothing in this file calls a model. Everything it emits is mechanically derived from the IR,
 * which is what makes it "always correct" in the sense §1 means: "Systems that ask an LLM to
 * 'read the repo and write the docs' produce confident, plausible, wrong documentation and lose
 * developer trust permanently after about two bad answers."
 *
 * Frontmatter carries the symbol ids and their signature hashes. That is not bookkeeping — it
 * is what makes staleness a structural comparison rather than a judgement call (§4.2), and what
 * makes "show me the source" a real link.
 */

export interface RenderContext {
  module: IrModule;
  symbols: IrSymbol[];
  /** Repo-relative source URL template, e.g. `https://github.com/acme/billing/blob/{sha}/{path}#L{line}`. */
  sourceUrlTemplate?: string;
  commitSha: string;
}

export interface RenderedDocument {
  slug: string;
  title: string;
  docType: string;
  frontmatter: Record<string, unknown>;
  /** Section id → deterministic body. The prose layer fills separate, clearly-marked regions. */
  sections: Map<string, string>;
  provenanceSymbolIds: string[];
  provenanceSignatureHashes: Record<string, string>;
}

// ── Module reference ───────────────────────────────────────────────────────────────────────

/**
 * §6 calls this "the most reliably automatable; closest to traditional API docs" — which is
 * exactly why it is the Phase 1 document type. It is the one where deterministic rendering
 * alone produces something a human would have written.
 */
export function renderModuleReference(ctx: RenderContext): RenderedDocument {
  const publicSymbols = ctx.symbols
    .filter((s) => s.visibility === 'public' && s.kind !== 'enumMember')
    .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));

  const sections = new Map<string, string>();

  sections.set('overview', renderOverview(ctx, publicSymbols));

  const byKind = groupBy(publicSymbols, (s) => s.kind);
  for (const [kind, symbols] of byKind) {
    sections.set(
      `api.${kind}`,
      symbols.map((symbol) => renderSymbol(symbol, ctx)).join('\n\n---\n\n'),
    );
  }

  const deprecated = publicSymbols.filter((s) => s.deprecated);
  if (deprecated.length > 0) sections.set('deprecations', renderDeprecations(deprecated, ctx));

  return {
    slug: `reference/${moduleSlug(ctx.module)}`,
    title: `${ctx.module.name} reference`,
    docType: 'module-reference',
    frontmatter: buildFrontmatter(ctx, publicSymbols, 'module-reference'),
    sections,
    provenanceSymbolIds: publicSymbols.map((s) => s.id),
    provenanceSignatureHashes: Object.fromEntries(
      publicSymbols.map((s) => [s.id, s.signatureHash]),
    ),
  };
}

function renderOverview(ctx: RenderContext, symbols: IrSymbol[]): string {
  const lines: string[] = [];

  lines.push(`| | |`);
  lines.push(`|---|---|`);
  if (ctx.module.packageName) {
    lines.push(`| Package | \`${ctx.module.packageName}\` (${ctx.module.ecosystem}) |`);
  }
  lines.push(`| Path | \`${ctx.module.path}\` |`);
  lines.push(`| Languages | ${ctx.module.languages.join(', ')} |`);
  lines.push(`| Public symbols | ${symbols.length} |`);
  if (ctx.module.owners.length > 0) {
    lines.push(`| Owned by | ${ctx.module.owners.join(', ')} |`);
  }

  // §5 — the analysis-depth badge follows the content all the way to the reader. A page built
  // from shallow analysis must not look identical to one built from a resolved type graph.
  if (ctx.module.analysisDepth === 'shallow') {
    lines.push('');
    lines.push(
      '> **Shallow analysis.** Signatures below are as written in source; types are not resolved',
    );
    lines.push(
      "> and the call graph is incomplete. Install this module's toolchain, or check the CI index,",
    );
    lines.push('> for a complete picture.');
  }

  return lines.join('\n');
}

function renderSymbol(symbol: IrSymbol, ctx: RenderContext): string {
  const lines: string[] = [];

  lines.push(`### \`${symbol.name}\``);
  lines.push('');

  if (symbol.deprecated) {
    const replacement = symbol.deprecated.replacement
      ? ` Use \`${symbol.deprecated.replacement}\` instead.`
      : '';
    lines.push(`> **Deprecated.** ${symbol.deprecated.reason}${replacement}`);
    lines.push('');
  }

  if (symbol.docComment?.summary) {
    lines.push(symbol.docComment.summary);
    lines.push('');
  }

  lines.push('```' + languageTag(symbol.language));
  lines.push(symbol.signature);
  lines.push('```');
  lines.push('');

  if (symbol.parameters.length > 0) {
    lines.push('| Parameter | Type | Description |');
    lines.push('|---|---|---|');
    for (const param of symbol.parameters) {
      const name = param.optional ? `\`${param.name}\`?` : `\`${param.name}\``;
      const type = param.type?.text ? `\`${escapePipes(param.type.text)}\`` : '—';
      const defaultNote = param.defaultValue ? ` (default \`${param.defaultValue}\`)` : '';
      lines.push(`| ${name} | ${type} | ${escapePipes(param.description ?? '')}${defaultNote} |`);
    }
    lines.push('');
  }

  if (symbol.returnType) {
    const description = symbol.docComment?.returns?.description;
    lines.push(
      `**Returns** \`${escapePipes(symbol.returnType.text)}\`${description ? ` — ${description}` : ''}`,
    );
    lines.push('');
  }

  if (symbol.docComment?.throws.length) {
    lines.push('**Throws**');
    lines.push('');
    for (const thrown of symbol.docComment.throws) {
      lines.push(`- \`${thrown.type}\` — ${thrown.description}`);
    }
    lines.push('');
  }

  if (symbol.httpBinding) {
    lines.push(renderHttpBinding(symbol.httpBinding));
    lines.push('');
  }

  if (symbol.docComment?.examples.length) {
    lines.push('**Example**');
    lines.push('');
    for (const example of symbol.docComment.examples) {
      lines.push('```' + languageTag(symbol.language));
      lines.push(example.trim());
      lines.push('```');
    }
    lines.push('');
  }

  // Provenance on every symbol, not just at the page level. §6 rule 2.
  lines.push(`<sub>${sourceLink(symbol, ctx)}</sub>`);

  return lines.join('\n');
}

function renderHttpBinding(binding: HttpBinding): string {
  const lines: string[] = [];
  lines.push(`**Endpoint** \`${binding.method} ${binding.route}\``);
  lines.push('');

  if (binding.security.length > 0) {
    lines.push(
      `**Authentication** ${binding.security
        .map(
          (s) =>
            `${s.scheme} (${s.type})${s.scopes.length ? ` — scopes: ${s.scopes.join(', ')}` : ''}`,
        )
        .join(', ')}`,
    );
    lines.push('');
  }

  if (binding.parameters.length > 0) {
    lines.push('| Name | In | Required | Description |');
    lines.push('|---|---|---|---|');
    for (const param of binding.parameters) {
      lines.push(
        `| \`${param.name}\` | ${param.in} | ${param.required ? 'yes' : 'no'} | ${escapePipes(param.description ?? '')} |`,
      );
    }
    lines.push('');
  }

  if (binding.responses.length > 0) {
    lines.push('| Status | Description |');
    lines.push('|---|---|');
    for (const response of binding.responses) {
      lines.push(`| \`${response.status}\` | ${escapePipes(response.description)} |`);
    }
  }

  return lines.join('\n');
}

function renderDeprecations(symbols: IrSymbol[], ctx: RenderContext): string {
  const lines = ['| Symbol | Since | Replacement | Reason |', '|---|---|---|---|'];
  for (const symbol of symbols) {
    lines.push(
      `| \`${symbol.qualifiedName}\` | ${symbol.deprecated?.since ?? '—'} | ${
        symbol.deprecated?.replacement ? `\`${symbol.deprecated.replacement}\`` : '—'
      } | ${escapePipes(symbol.deprecated?.reason ?? '')} |`,
    );
  }
  void ctx;
  return lines.join('\n');
}

// ── Architecture ───────────────────────────────────────────────────────────────────────────

/**
 * Mermaid, generated from the dependency graph. §6: "Generate these from the dependency graph
 * deterministically; do not ask an LLM to draw them."
 *
 * §15.8 also requires a text alternative for accessibility — "no text alternative for Mermaid
 * output" is named as a specific failure — so every diagram ships with a prose summary of the
 * same edges.
 */
export function renderDependencyDiagram(input: {
  modules: IrModule[];
  edges: Array<{ from: string; to: string; kind: string }>;
}): { mermaid: string; textAlternative: string } {
  const nodeId = (id: string) => `n${id.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}`;
  const byId = new Map(input.modules.map((m) => [m.id, m]));

  const lines = ['```mermaid', 'graph LR'];
  for (const module of input.modules) {
    lines.push(`  ${nodeId(module.id)}["${escapeMermaid(module.name)}"]`);
  }
  for (const edge of input.edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const arrow = edge.kind === 'api-contract' ? '-->|API|' : '-->';
    lines.push(`  ${nodeId(edge.from)} ${arrow} ${nodeId(edge.to)}`);
  }
  lines.push('```');

  const described = input.edges
    .filter((e) => byId.has(e.from) && byId.has(e.to))
    .map((e) => `${byId.get(e.from)!.name} depends on ${byId.get(e.to)!.name} (${e.kind})`);

  const textAlternative = [
    `Dependency graph of ${input.modules.length} module(s) with ${described.length} relationship(s).`,
    ...described.map((d) => `- ${d}`),
  ].join('\n');

  return { mermaid: lines.join('\n'), textAlternative };
}

// ── Shared ─────────────────────────────────────────────────────────────────────────────────

/**
 * Filename-safe slug for a module.
 *
 * A repo-root module has `path: '.'`, which naively slugifies to a filename of `.` — a file
 * called `..md` that no tool can open. Fall back to the package or module name, and strip
 * anything that is not filename-safe rather than hoping.
 */
export function moduleSlug(module: IrModule): string {
  const fromPath = module.path === '.' || module.path === '' ? '' : module.path;
  const source = fromPath || module.packageName || module.name || module.id;
  return (
    source
      .split('/')
      .join('-')
      .split('\\')
      .join('-')
      .replace(/[^a-zA-Z0-9._-]/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .toLowerCase() || module.id
  );
}

function buildFrontmatter(
  ctx: RenderContext,
  symbols: IrSymbol[],
  docType: string,
): Record<string, unknown> {
  return {
    title: `${ctx.module.name} reference`,
    docType,
    generated: true,
    generator: 'kna-docgen',
    moduleId: ctx.module.id,
    repoId: ctx.module.repoId,
    commitSha: ctx.commitSha,
    analysisDepth: ctx.module.analysisDepth,
    owners: ctx.module.owners,
    // Provenance: which symbols this page was built from, and what they hashed to. The doc-
    // staleness check is a comparison against these values, not an LLM judgement (§4.2).
    provenance: {
      symbolIds: symbols.map((s) => s.id),
      signatureHashes: Object.fromEntries(symbols.map((s) => [s.id, s.signatureHash])),
    },
  };
}

export function serialiseFrontmatter(frontmatter: Record<string, unknown>): string {
  return ['---', toYaml(frontmatter, 0), '---'].join('\n');
}

function toYaml(value: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map((v) => `${pad}- ${scalarOrNested(v, indent + 1)}`).join('\n');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, v]) => {
        if (v && typeof v === 'object') {
          const nested = toYaml(v, indent + 1);
          return `${pad}${key}:\n${nested}`;
        }
        return `${pad}${key}: ${scalar(v)}`;
      })
      .join('\n');
  }
  return `${pad}${scalar(value)}`;
}

function scalarOrNested(value: unknown, indent: number): string {
  if (value && typeof value === 'object') return `\n${toYaml(value, indent)}`;
  return scalar(value);
}

function scalar(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') {
    return /^[\w./@-]+$/.test(value) ? value : JSON.stringify(value);
  }
  return String(value);
}

function sourceLink(symbol: IrSymbol, ctx: RenderContext): string {
  const location = `${symbol.sourceRef.path}:${symbol.sourceRef.startLine}`;
  if (!ctx.sourceUrlTemplate) return `Source: \`${location}\``;
  const url = ctx.sourceUrlTemplate
    .replace('{sha}', ctx.commitSha)
    .replace('{path}', symbol.sourceRef.path)
    .replace('{line}', String(symbol.sourceRef.startLine));
  return `[Source](${url})`;
}

function languageTag(language: string): string {
  switch (language) {
    case 'csharp':
      return 'csharp';
    case 'python':
      return 'python';
    case 'javascript':
      return 'javascript';
    default:
      return 'typescript';
  }
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function escapeMermaid(value: string): string {
  return value.replace(/["\n]/g, ' ');
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k) ?? [];
    list.push(item);
    out.set(k, list);
  }
  return out;
}
