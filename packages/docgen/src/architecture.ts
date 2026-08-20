import type { IrBundlePayload, IrModule, IrSymbol } from '@kna/ir';
import type { RenderedDocument } from './render.js';

/**
 * Architecture overview — deterministic (§6).
 *
 * "Architecture overview | Dependency graph + IaC + service manifests | C4-style: context,
 * container, component. Render Mermaid or Structurizr DSL" — and, critically, "generate these
 * from the dependency graph deterministically; do not ask an LLM to draw them."
 *
 * Nothing here calls a model. Every node and every edge is a fact already in the IR bundle:
 * module manifests give the dependency graph, harvested compose/Helm/Terraform files give the
 * runtime topology, and Tier 2 HTTP bindings give the API surface. §5 is explicit that this is
 * what makes architecture documentation "*actually* accurate instead of inferred" — an import
 * graph describes what the code references, while compose files describe what actually runs.
 *
 * Every diagram ships with a **complete** text equivalent, not a summary. §15.8 names the
 * missing text alternative for Mermaid output as a specific accessibility failure, and a lossy
 * alternative is not an alternative — a screen-reader user should not receive less information
 * than a sighted one.
 */

export interface ArchitectureContext {
  payload: IrBundlePayload;
  /** Repo-relative source URL template, as for the module reference. */
  sourceUrlTemplate?: string;
}

interface ModuleEdge {
  from: string;
  to: string;
  /** What proves the edge: a declared package dependency, or a service manifest. */
  evidence: string;
  dev: boolean;
}

export function renderArchitectureOverview(ctx: ArchitectureContext): RenderedDocument {
  const { payload } = ctx;
  const modules = [...payload.modules].sort((a, b) => a.path.localeCompare(b.path));
  const edges = resolveModuleEdges(modules);
  const endpoints = payload.symbols
    .filter((s) => s.httpBinding)
    .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName));

  const sections = new Map<string, string>();

  sections.set('architecture.summary', renderSummary(payload, modules, edges, endpoints));
  sections.set('architecture.context', renderContext(payload));
  sections.set('architecture.container', renderContainer(modules, edges));
  sections.set('architecture.component', renderComponent(modules, payload));

  if (endpoints.length > 0) {
    sections.set('architecture.api-surface', renderApiSurface(endpoints, modules));
  }

  sections.set('architecture.confidence', renderConfidence(modules));

  return {
    slug: 'architecture/overview',
    title: `${payload.repo.name} architecture`,
    docType: 'architecture-overview',
    frontmatter: {
      title: `${payload.repo.name} architecture`,
      docType: 'architecture-overview',
      generated: true,
      generator: 'kna-docgen',
      repoId: payload.repo.id,
      commitSha: payload.version.commitSha,
      analysisDepth: payload.analysisDepth,
      // Module-level provenance, since this document is built from the module graph rather
      // than from individual declarations.
      provenance: {
        moduleIds: modules.map((m) => m.id),
        moduleKeys: modules.map((m) => m.key),
        edgeCount: edges.length,
        serviceCount: payload.services.length,
        // Endpoint symbols are the one place this document quotes a signature, so they are the
        // symbols whose drift should mark it stale.
        symbolIds: endpoints.map((s) => s.id),
        signatureHashes: Object.fromEntries(endpoints.map((s) => [s.id, s.signatureHash])),
      },
    },
    sections,
    provenanceSymbolIds: endpoints.map((s) => s.id),
    provenanceSignatureHashes: Object.fromEntries(endpoints.map((s) => [s.id, s.signatureHash])),
  };
}

// ── Sections ────────────────────────────────────────────────────────────────────────────────

function renderSummary(
  payload: IrBundlePayload,
  modules: IrModule[],
  edges: ModuleEdge[],
  endpoints: IrSymbol[],
): string {
  const lines: string[] = [];

  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Repository | \`${payload.repo.remote}\` |`);
  lines.push(
    `| Commit | \`${payload.version.commitSha.slice(0, 12)}\` on \`${payload.version.ref}\` |`,
  );
  lines.push(`| Modules | ${modules.length} |`);
  lines.push(`| Internal dependencies | ${edges.length} |`);
  lines.push(`| Runtime services | ${payload.services.length} |`);
  lines.push(`| HTTP endpoints | ${endpoints.length} |`);
  lines.push(`| Languages | ${payload.languages.filter((l) => l !== 'unknown').join(', ')} |`);

  if (payload.services.length === 0) {
    lines.push('');
    lines.push(
      '> No runtime topology was found. This view is derived from package manifests alone, so it',
    );
    lines.push(
      '> describes what the code references rather than what actually runs. Compose files, Helm',
    );
    lines.push('> charts or Terraform in the repository would make it concrete.');
  }

  return lines.join('\n');
}

/** C4 level 1 — what runs, and what it talks to. Harvested from IaC, not inferred (§5). */
function renderContext(payload: IrBundlePayload): string {
  if (payload.services.length === 0) {
    return '_No service manifests found in this repository._';
  }

  const services = [...payload.services].sort((a, b) => a.name.localeCompare(b.name));
  const known = new Set(services.map((s) => s.name));

  const diagram = ['```mermaid', 'graph LR'];
  for (const service of services) {
    diagram.push(`  ${nodeId(service.name)}${shapeFor(service.kind, service.name, service.kind)}`);
  }
  // A dependency naming something not in this repo is an external system, and saying so is more
  // useful than dropping the edge.
  const external = new Set<string>();
  for (const service of services) {
    for (const dependency of service.dependsOn) {
      if (!known.has(dependency)) external.add(dependency);
    }
  }
  for (const name of [...external].sort()) {
    diagram.push(`  ${nodeId(name)}[/"${escape(name)}<br/>external"/]`);
  }
  for (const service of services) {
    for (const dependency of [...service.dependsOn].sort()) {
      diagram.push(`  ${nodeId(service.name)} --> ${nodeId(dependency)}`);
    }
  }
  diagram.push('```');

  const described: string[] = [];
  for (const service of services) {
    const deps = [...service.dependsOn].sort();
    described.push(
      deps.length === 0
        ? `${service.name} (${service.kind}) depends on nothing in this repository`
        : `${service.name} (${service.kind}) depends on ${deps.join(', ')}`,
    );
  }

  const table = ['| Service | Kind | Image | Declared in |', '|---|---|---|---|'];
  for (const service of services) {
    table.push(
      `| \`${service.name}\` | ${service.kind} | ${service.image ? `\`${service.image}\`` : '—'} | \`${service.source}\` |`,
    );
  }

  return [
    ...diagram,
    '',
    textAlternative(
      `Runtime topology: ${services.length} service(s)` +
        (external.size > 0 ? ` and ${external.size} external system(s)` : ''),
      described,
    ),
    '',
    ...table,
  ].join('\n');
}

/** C4 level 2 — modules and the dependencies they declare. */
function renderContainer(modules: IrModule[], edges: ModuleEdge[]): string {
  if (modules.length === 0) return '_No modules found._';

  const byId = new Map(modules.map((m) => [m.id, m]));
  const diagram = ['```mermaid', 'graph LR'];

  for (const module of modules) {
    const label = module.packageName ?? module.name;
    diagram.push(`  ${nodeId(module.id)}["${escape(label)}"]`);
  }
  for (const edge of edges) {
    // Development-only dependencies are drawn dashed: they shape the build, not the runtime,
    // and conflating the two is how an architecture diagram stops being trusted.
    diagram.push(`  ${nodeId(edge.from)} ${edge.dev ? '-.->' : '-->'} ${nodeId(edge.to)}`);
  }
  diagram.push('```');

  const described = edges.map((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    return `${from?.packageName ?? from?.name ?? edge.from} depends on ${
      to?.packageName ?? to?.name ?? edge.to
    }${edge.dev ? ' (development only)' : ''}`;
  });

  return [
    ...diagram,
    '',
    textAlternative(
      `Module graph: ${modules.length} module(s), ${edges.length} internal dependency edge(s). ` +
        'Solid arrows are runtime dependencies; dashed arrows are development-only.',
      described,
    ),
  ].join('\n');
}

/**
 * C4 level 3 — what each module contains, ordered by how much depends on it.
 *
 * §6 for the onboarding guide: "rank modules by in-degree to find what actually matters." The
 * same ranking is the useful ordering here, because a reader landing on an architecture page
 * wants to know where the centre of gravity is, not the alphabet.
 */
function renderComponent(modules: IrModule[], payload: IrBundlePayload): string {
  const inDegree = new Map<string, number>();
  for (const edge of resolveModuleEdges(modules)) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const publicByModule = new Map<string, number>();
  const endpointsByModule = new Map<string, number>();
  for (const symbol of payload.symbols) {
    if (symbol.visibility === 'public') {
      publicByModule.set(symbol.moduleId, (publicByModule.get(symbol.moduleId) ?? 0) + 1);
    }
    if (symbol.httpBinding) {
      endpointsByModule.set(symbol.moduleId, (endpointsByModule.get(symbol.moduleId) ?? 0) + 1);
    }
  }

  const ranked = [...modules].sort(
    (a, b) =>
      (inDegree.get(b.id) ?? 0) - (inDegree.get(a.id) ?? 0) ||
      (publicByModule.get(b.id) ?? 0) - (publicByModule.get(a.id) ?? 0) ||
      a.path.localeCompare(b.path),
  );

  const lines = [
    '| Module | Depended on by | Public symbols | Endpoints | Languages | Owners |',
    '|---|---:|---:|---:|---|---|',
  ];

  for (const module of ranked) {
    lines.push(
      `| \`${module.path}\` | ${inDegree.get(module.id) ?? 0} | ${publicByModule.get(module.id) ?? 0} | ` +
        `${endpointsByModule.get(module.id) ?? 0} | ${module.languages.join(', ') || '—'} | ` +
        `${module.owners.join(', ') || '—'} |`,
    );
  }

  const top = ranked[0];
  if (top && (inDegree.get(top.id) ?? 0) > 0) {
    lines.push('');
    lines.push(
      `Ordered by in-degree. \`${top.path}\` is the most depended-upon module here, which makes ` +
        'it the one where a breaking change costs most.',
    );
  }

  return lines.join('\n');
}

/** The customer-facing surface. §5 — Tier 2 OpenAPI beats AST parsing for exactly this. */
function renderApiSurface(endpoints: IrSymbol[], modules: IrModule[]): string {
  const byModule = new Map(modules.map((m) => [m.id, m]));
  const lines = ['| Method | Route | Module | Auth | Handler |', '|---|---|---|---|---|'];

  for (const symbol of endpoints) {
    const binding = symbol.httpBinding!;
    const auth = binding.security.length
      ? binding.security.map((s) => s.scheme).join(', ')
      : '_none declared_';
    lines.push(
      `| \`${binding.method}\` | \`${binding.route}\` | \`${byModule.get(symbol.moduleId)?.path ?? '—'}\` | ` +
        `${auth} | \`${symbol.qualifiedName}\` |`,
    );
  }

  const unauthenticated = endpoints.filter((s) => s.httpBinding!.security.length === 0);
  if (unauthenticated.length > 0) {
    lines.push('');
    lines.push(
      `> ${unauthenticated.length} endpoint(s) declare no authentication in their specification. ` +
        'That may be correct — health checks and public documentation routes usually are — but ' +
        'it is worth confirming rather than assuming the specification is incomplete.',
    );
  }

  return lines.join('\n');
}

/**
 * §5 — "never let the assistant present shallow-analysis output with the same confidence as
 * semantic output." A diagram drawn from shallow analysis is missing edges it cannot see, and a
 * reader has no way to tell unless the page says so.
 */
function renderConfidence(modules: IrModule[]): string {
  const shallow = modules.filter((m) => m.analysisDepth === 'shallow');

  if (shallow.length === 0) {
    return `All ${modules.length} module(s) were analysed at semantic depth or better, so the dependency edges above are resolved rather than inferred from text.`;
  }

  const lines = [
    `**${shallow.length} of ${modules.length} module(s) were analysed at shallow depth.** Their`,
    'dependency edges come from declared manifests only; type references and call edges that',
    'would appear at semantic depth are missing from the diagrams above.',
    '',
    '| Module | Why |',
    '|---|---|',
  ];

  for (const module of shallow) {
    lines.push(`| \`${module.path}\` | ${module.analysisNotes[0] ?? 'no toolchain detected'} |`);
  }

  lines.push('');
  lines.push('CI runners that build this repository have those toolchains by definition, so the');
  lines.push(
    'shared index is more complete than a local run. `kna doctor` explains a specific case.',
  );

  return lines.join('\n');
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────

/**
 * Resolve declared dependencies to modules in the same bundle.
 *
 * Only intra-bundle edges are produced here, which is honest for a CLI run over one repository.
 * Cross-repo edges need the whole project's IR and are resolved by the platform's dedicated
 * pass (§4.3).
 */
function resolveModuleEdges(modules: IrModule[]): ModuleEdge[] {
  const byPackage = new Map<string, IrModule>();
  for (const module of modules) {
    if (module.packageName) byPackage.set(module.packageName, module);
  }

  const edges: ModuleEdge[] = [];
  const seen = new Set<string>();

  for (const module of modules) {
    for (const dependency of module.dependencies) {
      const target = byPackage.get(dependency.name);
      if (!target || target.id === module.id) continue;

      const key = `${module.id}->${target.id}`;
      if (seen.has(key)) continue;
      seen.add(key);

      edges.push({
        from: module.id,
        to: target.id,
        evidence: `declares ${dependency.name}${dependency.version ? `@${dependency.version}` : ''}`,
        dev: dependency.dev,
      });
    }
  }

  return edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/**
 * The text equivalent of a diagram.
 *
 * Complete, not summarised. §15.8 requires a text alternative for generated diagrams, and one
 * that omits edges gives a screen-reader user strictly less information than a sighted reader —
 * which is the failure the requirement exists to prevent.
 */
function textAlternative(headline: string, items: string[]): string {
  return [
    '<details>',
    '<summary>Text description of the diagram above</summary>',
    '',
    headline,
    '',
    ...items.map((item) => `- ${item}`),
    '',
    '</details>',
  ].join('\n');
}

function shapeFor(kind: string, name: string, sublabel: string): string {
  const label = `"${escape(name)}<br/>${escape(sublabel)}"`;
  switch (kind) {
    case 'database':
      return `[(${label})]`;
    case 'queue':
      return `>${label}]`;
    case 'cache':
      return `[[${label}]]`;
    case 'external':
      return `[/${label}/]`;
    default:
      return `(${label})`;
  }
}

/** Mermaid node ids must be identifier-safe and stable across runs. */
function nodeId(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return `n${Math.abs(hash).toString(36)}`;
}

function escape(value: string): string {
  return value.replace(/["\n|]/g, ' ').trim();
}
