import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Citation } from './api';
import { AnswerText } from './pages/Chat';

const citation: Citation = {
  marker: 1,
  chunkId: 'chunk-1',
  repo: 'example',
  qualifiedName: 'example',
  path: 'README.md',
  startLine: 1,
  analysisDepth: 'artifact',
};

describe('chat Markdown rendering', () => {
  it('renders fenced code, lists, tables, and citations', () => {
    const html = renderToStaticMarkup(
      <AnswerText
        index={2}
        citations={[citation]}
        text={[
          '## Setup',
          '',
          '- Install dependencies',
          '- Run the build [1]',
          '',
          '| Command | Purpose |',
          '| --- | --- |',
          '| `pnpm build` | Build it |',
          '',
          '```yaml',
          'name: Build',
          '```',
        ].join('\n')}
      />,
    );

    expect(html).toContain('<h2>Setup</h2>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<table>');
    expect(html).toContain('<pre><code class="language-yaml">name: Build');
    expect(html).toContain('href="#s2-1"');
    expect(html).toContain('class="cite">1</a>');
    expect(html).not.toContain('node="');
  });

  it('does not interpret raw HTML or load remote images', () => {
    const html = renderToStaticMarkup(
      <AnswerText
        index={0}
        citations={[]}
        text={'<script>alert(1)</script>\n\n![tracker](https://example.test/pixel.png)'}
      />,
    );

    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('https://example.test');
    expect(html).toContain('[Image: tracker]');
  });

  it('does not convert citation-like text inside code', () => {
    const html = renderToStaticMarkup(
      <AnswerText index={0} citations={[citation]} text={'Use `items[1]`, then see [1].'} />,
    );

    expect(html).toContain('<code>items[1]</code>');
    expect(html.match(/class="cite"/g)).toHaveLength(1);
  });
});
