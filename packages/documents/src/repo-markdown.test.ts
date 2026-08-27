import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RepoMarkdownSource, discoverMarkdownFiles } from './repo-markdown.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('RepoMarkdownSource', () => {
  it('discovers root and nested Markdown while excluding generated output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kna-docs-'));
    temporary.push(root);
    await mkdir(path.join(root, 'docs', 'generated'), { recursive: true });
    await mkdir(path.join(root, 'guide'), { recursive: true });
    await writeFile(path.join(root, 'README.md'), '# Product\n');
    await writeFile(path.join(root, 'NOTES.md'), '# Notes\n');
    await writeFile(path.join(root, 'guide', 'start.mdx'), '# Start\n');
    await writeFile(path.join(root, 'docs', 'generated', 'reference.md'), '# Generated\n');

    await expect(discoverMarkdownFiles({ repoRoot: root })).resolves.toEqual([
      'guide/start.mdx',
      'NOTES.md',
      'README.md',
    ]);
  });

  it('normalizes source metadata and frontmatter', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kna-docs-'));
    temporary.push(root);
    await writeFile(
      path.join(root, 'README.md'),
      [
        '---',
        'audience: end-user',
        'authority: canonical',
        'documentType: handbook',
        '---',
        '# Product handbook',
        '',
        'Use the product.',
      ].join('\n'),
    );
    const page = await new RepoMarkdownSource({
      repoRoot: root,
      orgId: 'org_1',
      repoId: 'repo_1',
      commitSha: 'a'.repeat(40),
      projectIds: ['project-one'],
      defaultSensitivity: 'internal',
    }).pull();
    expect(page.documents).toHaveLength(1);
    expect(page.documents[0]).toMatchObject({
      title: 'Product handbook',
      audience: 'end-user',
      authority: 'canonical',
      documentType: 'handbook',
      repoIds: ['repo_1'],
      sourcePath: 'README.md',
      source: { type: 'repo-markdown', externalId: 'README.md' },
    });
  });

  it('pages through a source without dropping documents', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'kna-docs-'));
    temporary.push(root);
    await mkdir(path.join(root, 'guide'), { recursive: true });
    await writeFile(path.join(root, 'README.md'), '# Product\n');
    await writeFile(path.join(root, 'NOTES.md'), '# Notes\n');
    await writeFile(path.join(root, 'guide', 'start.mdx'), '# Start\n');
    const source = new RepoMarkdownSource({
      repoRoot: root,
      orgId: 'org_1',
      repoId: 'repo_1',
      commitSha: 'a'.repeat(40),
    });

    const first = await source.pull({ limit: 2 });
    const second = await source.pull({ limit: 2, cursor: first.nextCursor });

    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toEqual({ value: '2' });
    expect(second.hasMore).toBe(false);
    expect(
      [...first.documents, ...second.documents].map((document) => document.source.externalId),
    ).toEqual(['guide/start.mdx', 'NOTES.md', 'README.md']);
  });
});
