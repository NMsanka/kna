import type { Citation } from './api';

/**
 * Which evidence the answer actually cited, and which repositories it came from.
 *
 * Pure, and in its own module, because it is the part of the conversation view worth testing:
 * the response carries everything that was put in front of the model, and treating all of it as
 * a citation claims eight sources for an answer that made one — the opposite of what citations
 * are for. Testing it through a rendered component would need a DOM, a testing library and a
 * renderer to assert something that is a pair of list operations.
 */

/** Only the evidence whose marker appears in the answer text. */
export function citedIn(text: string, citations: Citation[]): Citation[] {
  const referenced = new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  return citations.filter((c) => referenced.has(c.marker));
}

/**
 * Grouped by repository, in first-appearance order.
 *
 * Insertion order rather than alphabetical: the first group is the one the answer leaned on
 * most, and sorting would bury it under whichever repository happens to sort first.
 */
export function groupByRepository(cited: Citation[]): Array<[string, Citation[]]> {
  const groups = new Map<string, Citation[]>();
  for (const c of cited) {
    const key = c.repo ?? 'unknown repository';
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  return [...groups.entries()];
}

/** What to call the source list, which is a claim about breadth and should be accurate. */
export function sourcesHeading(
  cited: Citation[],
  groups: Array<[string, Citation[]]>,
  everywhere: boolean,
): string {
  if (!everywhere) return cited.length === 1 ? 'Source' : 'Sources';
  // One repository is a perfectly good answer to a cross-repository question, and saying so is
  // better than implying breadth the evidence does not have.
  return groups.length === 1 ? 'From one repository' : `Across ${groups.length} repositories`;
}
