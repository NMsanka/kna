import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  contentHash,
  normalizePath,
  sha256Short,
  zKnowledgeDocument,
  type DocumentAudience,
  type DocumentAuthority,
  type KnowledgeDocument,
  type Sensitivity,
} from '@kna/ir';
import type {
  DocumentSourceConnector,
  DocumentSourcePage,
  DocumentSourceRequest,
} from './connector.js';

export interface RepoMarkdownSourceOptions {
  repoRoot: string;
  orgId: string;
  repoId: string;
  commitSha: string;
  projectIds?: string[];
  modules?: Array<{ id: string; path: string }>;
  include?: string[];
  exclude?: string[];
  defaultSensitivity?: Sensitivity;
}

export class RepoMarkdownSource implements DocumentSourceConnector {
  readonly sourceType = 'repo-markdown';
  readonly instanceId: string;
  constructor(private readonly options: RepoMarkdownSourceOptions) {
    this.instanceId = options.repoId;
  }

  async pull(request: DocumentSourceRequest = {}): Promise<DocumentSourcePage> {
    const paths = await discoverMarkdownFiles(this.options);
    const offset = parseCursor(request.cursor?.value);
    const limit = request.limit ?? paths.length;
    const selected = paths.slice(offset, offset + limit);
    const documents: KnowledgeDocument[] = [];
    for (const sourcePath of selected) {
      const absolutePath = path.join(this.options.repoRoot, ...sourcePath.split('/'));
      const raw = await readFile(absolutePath, 'utf8');
      const { attributes, body } = parseFrontmatter(raw);
      const hash = contentHash(body);
      documents.push(
        zKnowledgeDocument.parse({
          id: `doc_${sha256Short(`${this.options.orgId}\n${this.options.repoId}\nrepo-markdown\n${sourcePath}`)}`,
          source: {
            type: this.sourceType,
            instanceId: this.instanceId,
            externalId: sourcePath,
            revision: `${this.options.commitSha}:${hash}`,
            canonicalUrl: null,
          },
          title:
            stringAttribute(attributes.title) ?? firstHeading(body) ?? titleFromPath(sourcePath),
          content: body,
          format: 'markdown',
          contentHash: hash,
          documentType: stringAttribute(attributes.documentType) ?? inferDocumentType(sourcePath),
          audience:
            enumAttribute<DocumentAudience>(attributes.audience, [
              'developer',
              'internal-user',
              'end-user',
              'mixed',
            ]) ?? 'developer',
          authority:
            enumAttribute<DocumentAuthority>(attributes.authority, [
              'canonical',
              'supporting',
              'historical',
            ]) ?? defaultAuthority(sourcePath),
          sensitivity:
            enumAttribute<Sensitivity>(attributes.sensitivity, [
              'public',
              'internal',
              'confidential',
              'restricted',
            ]) ??
            this.options.defaultSensitivity ??
            'internal',
          access: { mode: 'inherit-repositories' },
          repoIds: [this.options.repoId],
          projectIds: this.options.projectIds ?? [],
          moduleIds: moduleIdsFor(sourcePath, this.options.modules ?? []),
          sourcePath,
          updatedAt: null,
          metadata: { frontmatter: attributes },
        }),
      );
    }
    const nextOffset = offset + selected.length;
    const hasMore = nextOffset < paths.length;
    return {
      documents,
      tombstones: [],
      nextCursor: hasMore ? { value: String(nextOffset) } : null,
      hasMore,
    };
  }
}

function parseCursor(value: string | undefined): number {
  if (value === undefined) return 0;
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error('Invalid document source cursor');
  return offset;
}

export async function discoverMarkdownFiles(
  options: Pick<RepoMarkdownSourceOptions, 'repoRoot' | 'include' | 'exclude'>,
): Promise<string[]> {
  const include = options.include ?? ['README.md', '**/*.md', '**/*.mdx'];
  const exclude = options.exclude ?? ['**/node_modules/**', '**/.git/**', 'docs/generated/**'];
  const files: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = normalizePath(path.relative(options.repoRoot, absolute));
      if (matchesAny(relative, exclude)) continue;
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile() && matchesAny(relative, include)) files.push(relative);
    }
  }
  await walk(options.repoRoot);
  return files.sort((left, right) => left.localeCompare(right, 'en'));
}

function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globToRegExp(normalizePath(pattern)).test(value));
}
function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    const next = glob[index + 1];
    const after = glob[index + 2];
    if (char === '*' && next === '*' && after === '/') {
      source += '(?:.*/)?';
      index += 2;
    } else if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`${source}$`, 'i');
}
function parseFrontmatter(markdown: string): { attributes: Record<string, unknown>; body: string } {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return { attributes: {}, body: normalized };
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) return { attributes: {}, body: normalized };
  const attributes: Record<string, unknown> = {};
  for (const line of normalized.slice(4, end).split('\n')) {
    const match = /^([A-Za-z][\w-]*):\s*(.*?)\s*$/.exec(line);
    if (match) attributes[match[1]!] = unquote(match[2]!);
  }
  return { attributes, body: normalized.slice(end + 5) };
}
function firstHeading(markdown: string): string | null {
  return /^#\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1]?.trim() ?? null;
}
function titleFromPath(sourcePath: string): string {
  const name = sourcePath
    .split('/')
    .pop()!
    .replace(/\.(md|mdx)$/i, '');
  if (/^readme$/i.test(name))
    return sourcePath.includes('/') ? `${sourcePath.split('/').slice(-2, -1)[0]} README` : 'README';
  return name.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function inferDocumentType(sourcePath: string): string {
  const lower = sourcePath.toLowerCase();
  if (/(^|\/)readme\.mdx?$/.test(lower)) return 'readme';
  if (/(^|\/)adr(s)?\//.test(lower)) return 'adr';
  if (/runbook|operations|incident/.test(lower)) return 'runbook';
  if (/api|integration/.test(lower)) return 'integration-guide';
  if (/handbook|user-guide|end-user/.test(lower)) return 'user-guide';
  return 'technical-documentation';
}
function defaultAuthority(sourcePath: string): DocumentAuthority {
  return /(^|\/)readme\.mdx?$/i.test(sourcePath) ? 'canonical' : 'supporting';
}
function moduleIdsFor(sourcePath: string, modules: Array<{ id: string; path: string }>): string[] {
  return modules
    .filter(
      (module) =>
        module.path === '.' ||
        sourcePath === module.path ||
        sourcePath.startsWith(`${module.path}/`),
    )
    .sort((a, b) => b.path.length - a.path.length)
    .slice(0, 1)
    .map((module) => module.id);
}
function stringAttribute(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
function enumAttribute<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : null;
}
function unquote(value: string): string {
  return value.replace(/^(?:"(.*)"|'(.*)')$/, '$1$2');
}
