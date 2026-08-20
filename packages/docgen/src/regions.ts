import { createHash } from 'node:crypto';

/**
 * Generated-region markers (§6 rule 4).
 *
 * "Human edits are preserved. Use marked regions so regeneration replaces only generated blocks
 * and leaves hand-written commentary intact. Without this, the first time your tool overwrites
 * someone's carefully written caveat, they will disable it."
 *
 * §7 restates it as a rule of etiquette: "Never clobber human-written commentary; that betrayal
 * only needs to happen once."
 *
 * The implementation detail that makes this trustworthy is the content hash on the end marker.
 * It lets regeneration detect that a human edited *inside* a generated block — which is not
 * misuse, it is someone fixing something the generator got wrong — and preserve it rather than
 * silently reverting their correction.
 */

const START = /<!--\s*kna:generated:start\s+id=([\w.:-]+)(?:\s+hash=([0-9a-f]{8,64}))?\s*-->/g;
const END = /<!--\s*kna:generated:end\s+id=([\w.:-]+)\s*-->/g;

export interface GeneratedRegion {
  id: string;
  /** Hash recorded when the region was last generated. */
  recordedHash: string | null;
  /** Hash of what is actually in the file now. */
  actualHash: string;
  content: string;
  startIndex: number;
  endIndex: number;
  /** True when a human edited inside the block after it was generated. */
  humanEdited: boolean;
}

export function parseRegions(document: string): GeneratedRegion[] {
  const regions: GeneratedRegion[] = [];
  const starts = [...document.matchAll(new RegExp(START.source, 'g'))];
  const ends = [...document.matchAll(new RegExp(END.source, 'g'))];

  for (const start of starts) {
    const id = start[1]!;
    const end = ends.find((e) => e[1] === id && e.index > start.index);
    if (!end) continue;

    const contentStart = start.index + start[0].length;
    const content = document.slice(contentStart, end.index);
    const actualHash = hashContent(content);

    regions.push({
      id,
      recordedHash: start[2] ?? null,
      actualHash,
      content,
      startIndex: start.index,
      endIndex: end.index + end[0].length,
      humanEdited: start[2] !== undefined && start[2] !== actualHash,
    });
  }

  return regions.sort((a, b) => a.startIndex - b.startIndex);
}

export function renderRegion(id: string, content: string): string {
  const body = content.endsWith('\n') ? content : `${content}\n`;
  return [
    `<!-- kna:generated:start id=${id} hash=${hashContent(`\n${body}`)} -->`,
    body.trimEnd(),
    `<!-- kna:generated:end id=${id} -->`,
  ].join('\n');
}

export interface MergeResult {
  document: string;
  replaced: string[];
  appended: string[];
  /** Regions left alone because a human edited them. Reported, never silently overwritten. */
  preserved: string[];
  /** Regions in the document with no counterpart in the new generation — likely orphaned. */
  orphaned: string[];
}

/**
 * Merge freshly generated regions into an existing document.
 *
 * The default is to preserve human edits: if someone corrected a generated block, regenerating
 * does not throw their correction away. `force` exists for the case where the underlying code
 * genuinely changed and the human text is now wrong — and even then the caller is expected to
 * surface it in the PR body rather than doing it quietly.
 */
export function mergeRegions(
  existing: string,
  generated: Map<string, string>,
  options: { force?: boolean } = {},
): MergeResult {
  const regions = parseRegions(existing);
  const byId = new Map(regions.map((r) => [r.id, r]));

  const replaced: string[] = [];
  const preserved: string[] = [];
  const appended: string[] = [];

  let document = existing;
  // Replace back-to-front so earlier indices stay valid as the document changes length.
  for (const region of [...regions].reverse()) {
    const fresh = generated.get(region.id);
    if (fresh === undefined) continue;

    if (region.humanEdited && !options.force) {
      preserved.push(region.id);
      continue;
    }

    document =
      document.slice(0, region.startIndex) +
      renderRegion(region.id, fresh) +
      document.slice(region.endIndex);
    replaced.push(region.id);
  }

  for (const [id, content] of generated) {
    if (byId.has(id)) continue;
    document = `${document.trimEnd()}\n\n${renderRegion(id, content)}\n`;
    appended.push(id);
  }

  const orphaned = regions.filter((r) => !generated.has(r.id)).map((r) => r.id);

  return { document, replaced, appended, preserved, orphaned };
}

/**
 * §15.8 exit plan — "ship a documented 'strip markers' command".
 *
 * If the platform is ever shut down, the generated Markdown lives in the customer's own repos
 * and must remain useful without the tool that made it. This removes the machinery and leaves
 * the prose.
 */
export function stripMarkers(document: string): string {
  return document
    .replace(new RegExp(START.source, 'g'), '')
    .replace(new RegExp(END.source, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .concat('\n');
}

function hashContent(content: string): string {
  return createHash('sha256').update(content.trim(), 'utf8').digest('hex').slice(0, 16);
}
