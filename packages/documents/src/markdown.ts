import { contentHash, sha256Short, type KnowledgeDocument } from '@kna/ir';

export interface MarkdownSection {
  heading: string;
  level: number;
  content: string;
  startLine: number;
  endLine: number;
}

/** Split on ATX headings while keeping headings inside fenced code blocks as content. */
export function parseMarkdownSections(markdown: string, fallbackTitle: string): MarkdownSection[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const sections: MarkdownSection[] = [];
  let inFence = false;
  let fenceMarker = '';
  let heading = fallbackTitle;
  let level = 1;
  let startLine = 1;
  let body: string[] = [];
  const flush = (endLine: number) => {
    const content = body.join('\n').trim();
    if (content) sections.push({ heading, level, content, startLine, endLine });
    body = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const fence = /^\s*(```+|~~~+)/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1]![0]!;
      } else if (fence[1]![0] === fenceMarker) inFence = false;
      body.push(line);
      continue;
    }
    const match = !inFence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null;
    if (!match) {
      body.push(line);
      continue;
    }
    flush(index);
    heading = stripInlineMarkup(match[2]!);
    level = match[1]!.length;
    startLine = index + 2;
  }
  flush(lines.length);
  return sections;
}

export interface DocumentationChunk {
  id: string;
  documentId: string;
  ordinal: number;
  title: string;
  heading: string;
  content: string;
  contentHash: string;
  tokenCount: number;
  sourceStartLine: number | null;
  sourceEndLine: number | null;
}

/** Documentation uses heading boundaries; source code continues to use AST boundaries. */
export function chunkDocument(
  document: KnowledgeDocument,
  options: { maxTokens?: number; overlapTokens?: number } = {},
): DocumentationChunk[] {
  const maxTokens = options.maxTokens ?? 900;
  const overlapTokens = options.overlapTokens ?? 60;
  const sections =
    document.format === 'markdown'
      ? parseMarkdownSections(document.content, document.title)
      : [
          {
            heading: document.title,
            level: 1,
            content: document.content,
            startLine: 1,
            endLine: lineCount(document.content),
          },
        ];
  const chunks: DocumentationChunk[] = [];
  for (const section of sections) {
    const header = `Document: ${document.title}\nSection: ${section.heading}\nSource: ${document.source.type}`;
    const pieces = splitToTokenBudget(
      section.content,
      Math.max(maxTokens - estimateTokens(header), 80),
      overlapTokens,
    );
    for (const piece of pieces) {
      const content = `${header}\n\n${piece}`;
      const hash = contentHash(content);
      const ordinal = chunks.length;
      chunks.push({
        id: `dch_${sha256Short(`${document.id}\n${ordinal}\n${hash}`)}`,
        documentId: document.id,
        ordinal,
        title: document.title,
        heading: section.heading,
        content,
        contentHash: hash,
        tokenCount: estimateTokens(content),
        sourceStartLine: document.sourcePath ? section.startLine : null,
        sourceEndLine: document.sourcePath ? section.endLine : null,
      });
    }
  }
  return chunks;
}

function splitToTokenBudget(text: string, maxTokens: number, overlapTokens: number): string[] {
  if (estimateTokens(text) <= maxTokens) return [text.trim()].filter(Boolean);
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const pieces: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  const emit = () => {
    if (current.length === 0) return;
    pieces.push(current.join('\n\n'));
    const overlap: string[] = [];
    let used = 0;
    for (let index = current.length - 1; index >= 0; index -= 1) {
      const paragraph = current[index]!;
      const tokens = estimateTokens(paragraph);
      if (used + tokens > overlapTokens) break;
      overlap.unshift(paragraph);
      used += tokens;
    }
    current = overlap;
    currentTokens = used;
  };
  for (const paragraph of paragraphs) {
    const tokens = estimateTokens(paragraph);
    if (tokens > maxTokens) {
      emit();
      const words = paragraph.split(/\s+/);
      const wordsPerPiece = Math.max(Math.floor(maxTokens * 0.7), 40);
      for (let index = 0; index < words.length; index += wordsPerPiece)
        pieces.push(words.slice(index, index + wordsPerPiece).join(' '));
      continue;
    }
    if (currentTokens + tokens > maxTokens) emit();
    current.push(paragraph);
    currentTokens += tokens;
  }
  emit();
  return pieces;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}
function lineCount(text: string): number {
  return text.replace(/\r\n/g, '\n').split('\n').length;
}
function stripInlineMarkup(value: string): string {
  return value.replace(/[*_`[\]]/g, '').trim();
}
