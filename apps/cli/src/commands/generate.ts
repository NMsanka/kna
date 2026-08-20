import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  mergeRegions,
  renderModuleReference,
  renderRegion,
  serialiseFrontmatter,
  type RenderedDocument,
} from '@kna/docgen';
import { analyze } from './analyze.js';
import type { CliContext } from '../context.js';
import { ui } from '../ui.js';

/**
 * `kna generate` — write documentation into the repository.
 *
 * §6 rule 3: "Generated docs land as a pull request, not a direct commit. Humans review." This
 * command writes files into the working tree; it never commits and never pushes. Whether those
 * changes become a PR is the CI workflow's job, and keeping that separation means a developer
 * can run this locally to see what would change without anything reaching a colleague.
 *
 * §15.8's exit plan is also honoured here by construction: the Markdown lives in the customer's
 * own repo, so if the platform is ever switched off the documentation stays where it is.
 */

/**
 * Document types this build can actually produce.
 *
 * §6 lists six types; only the module reference is implemented. It is also the one §6 calls
 * "the most reliably automatable; closest to traditional API docs" — the right one to have
 * first, and the one where deterministic rendering alone produces something a human would
 * have written.
 */
const SUPPORTED_DOC_TYPES = ['module-reference'];

export interface GenerateOptions {
  types?: string[];
  outputDir?: string;
  /** Deterministic facts always render; prose is the optional layer (§6). */
  prose: boolean;
  dryRun: boolean;
}

export async function generateCommand(ctx: CliContext, options: GenerateOptions): Promise<void> {
  const result = await analyze(ctx);
  const outputDir = options.outputDir ?? ctx.config.docs.outputDir;
  const types = options.types ?? ctx.config.docs.types;

  // Report what was asked for and will not be produced. The previous check was inverted — it
  // warned when `module-reference` was *absent* — so a repo configuring `architecture-overview`
  // got silence and no file. Configuration that is silently ignored is worse than configuration
  // that is rejected: the developer believes it took effect.
  const unsupported = types.filter((type) => !SUPPORTED_DOC_TYPES.includes(type));
  if (unsupported.length > 0) {
    ui.warn(
      `Not generated: ${unsupported.join(', ')}. ` +
        `This build produces ${SUPPORTED_DOC_TYPES.join(', ')} only.`,
    );
    ui.detail('Configured in docs.types. The remaining types are not implemented yet, not off.');
  }

  if (!types.includes('module-reference')) {
    ui.warn('docs.types does not include module-reference, so nothing will be generated.');
    return;
  }

  const symbolsByModule = new Map<string, typeof result.bundle.payload.symbols>();
  for (const symbol of result.bundle.payload.symbols) {
    const list = symbolsByModule.get(symbol.moduleId) ?? [];
    list.push(symbol);
    symbolsByModule.set(symbol.moduleId, list);
  }

  const written: string[] = [];
  const preserved: string[] = [];

  if (options.prose) {
    // Prose needs a platform-side model route, and the CLI deliberately holds no provider
    // credentials of its own. Said once, not once per module.
    ui.detail('Prose layer runs on the platform, where model routing and the grounding check');
    ui.detail('live. The deterministic sections below are complete without it.');
  }

  for (const module of result.bundle.payload.modules) {
    const symbols = symbolsByModule.get(module.id) ?? [];
    if (symbols.length === 0) continue;

    const document = renderModuleReference({
      module,
      symbols,
      commitSha: ctx.version.commitSha,
      sourceUrlTemplate: sourceUrlTemplate(ctx),
    });

    const relPath = join(outputDir, `${document.slug}.md`);
    const fullPath = join(ctx.repoRoot, relPath);
    const rendered = await renderToFile(fullPath, document);

    if (rendered.preserved.length > 0) {
      preserved.push(...rendered.preserved.map((id) => `${relPath}#${id}`));
    }

    if (options.dryRun) {
      ui.log(`${ui.green('would write')} ${relPath} (${document.sections.size} section(s))`);
      continue;
    }

    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, rendered.content, 'utf8');
    written.push(relPath);
  }

  if (options.dryRun) {
    ui.log();
    ui.info('Dry run — nothing was written.');
    return;
  }

  ui.heading('Generated');
  for (const path of written) ui.log(`  ${path}`);

  if (preserved.length > 0) {
    ui.heading('Preserved human edits');
    for (const region of preserved) ui.log(`  ${region}`);
    ui.log();
    ui.detail('These regions were edited by hand after they were last generated, so the');
    ui.detail('generator left them alone. Pass --force to overwrite them deliberately.');
  }

  ui.log();
  ui.detail('Nothing has been committed. Review the diff, then open a pull request — generated');
  ui.detail('documentation should never reach the default branch without a human agreeing to it.');
}

async function renderToFile(
  fullPath: string,
  document: RenderedDocument,
): Promise<{ content: string; preserved: string[] }> {
  const generated = new Map<string, string>();
  for (const [id, body] of document.sections) generated.set(id, body);

  let existing: string | null = null;
  try {
    existing = await readFile(fullPath, 'utf8');
  } catch {
    existing = null;
  }

  if (!existing) {
    const parts = [serialiseFrontmatter(document.frontmatter), '', `# ${document.title}`, ''];
    for (const [id, body] of generated) parts.push(renderRegion(id, body), '');
    return { content: parts.join('\n'), preserved: [] };
  }

  // Frontmatter is regenerated wholesale — it is pure provenance, and a human editing it would
  // be editing the staleness bookkeeping rather than the document.
  const withoutFrontmatter = existing.replace(/^---\n[\s\S]*?\n---\n/, '');
  const merged = mergeRegions(withoutFrontmatter, generated);

  return {
    content: `${serialiseFrontmatter(document.frontmatter)}\n${merged.document}`,
    preserved: merged.preserved,
  };
}

function sourceUrlTemplate(ctx: CliContext): string | undefined {
  const remote = ctx.repo.remote;
  if (ctx.repo.provider === 'github') return `https://${remote}/blob/{sha}/{path}#L{line}`;
  if (ctx.repo.provider === 'gitlab') return `https://${remote}/-/blob/{sha}/{path}#L{line}`;
  if (ctx.repo.provider === 'azuredevops') {
    return `https://${remote}?path={path}&version=GC{sha}&line={line}`;
  }
  return undefined;
}
