import { describe, expect, it } from 'vitest';
import { chunkDocument, parseMarkdownSections } from './markdown.js';
import { contentHash, zKnowledgeDocument } from '@kna/ir';

describe('Markdown documentation parsing', () => {
  it('splits on headings but not headings inside fenced code', () => {
    const sections = parseMarkdownSections(
      '# Setup\n\nInstall it.\n\n```md\n# Not a section\n```\n\n## Run\n\nStart it.',
      'Guide',
    );
    expect(sections.map((section) => section.heading)).toEqual(['Setup', 'Run']);
    expect(sections[0]!.content).toContain('# Not a section');
  });

  it('creates stable documentation chunks with source lines', () => {
    const content = '# Setup\n\nInstall it.\n\n## Run\n\nStart it.';
    const document = zKnowledgeDocument.parse({
      id: 'doc_1',
      source: {
        type: 'repo-markdown',
        instanceId: 'repo_1',
        externalId: 'README.md',
        revision: 'abc',
      },
      title: 'Example',
      content,
      format: 'markdown',
      contentHash: contentHash(content),
      documentType: 'readme',
      repoIds: ['repo_1'],
      sourcePath: 'README.md',
    });
    const first = chunkDocument(document);
    const second = chunkDocument(document);
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0]!.sourceStartLine).toBe(2);
    expect(first[1]!.heading).toBe('Run');
  });
});
