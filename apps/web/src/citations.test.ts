import { describe, expect, it } from 'vitest';
import { citedIn, groupByRepository, sourcesHeading } from './citations';
import type { Citation } from './api';

function citation(marker: number, repo: string | null): Citation {
  return {
    marker,
    chunkId: `chk_${marker}`,
    repo,
    qualifiedName: `Thing${marker}`,
    path: `src/thing${marker}.ts`,
    startLine: marker * 10,
    analysisDepth: 'semantic',
  };
}

describe('citedIn', () => {
  it('keeps only the evidence the answer refers to', () => {
    const cited = citedIn('Just the first [1].', [citation(1, 'a'), citation(2, 'b')]);
    expect(cited.map((c) => c.marker)).toEqual([1]);
  });

  it('keeps every marker that appears, once each', () => {
    const cited = citedIn('Here [1], and [2], and again [1].', [
      citation(1, 'a'),
      citation(2, 'b'),
    ]);
    expect(cited.map((c) => c.marker)).toEqual([1, 2]);
  });

  it('returns nothing when the answer cites nothing', () => {
    expect(citedIn('No markers at all.', [citation(1, 'a')])).toEqual([]);
  });
});

describe('groupByRepository', () => {
  it('groups several citations from one repository under it', () => {
    const groups = groupByRepository([citation(1, 'billing'), citation(2, 'billing')]);
    expect(groups).toHaveLength(1);
    expect(groups[0]![0]).toBe('billing');
    expect(groups[0]![1]).toHaveLength(2);
  });

  it('keeps first-appearance order rather than sorting', () => {
    const groups = groupByRepository([citation(1, 'web'), citation(2, 'billing')]);
    expect(groups.map(([name]) => name)).toEqual(['web', 'billing']);
  });

  it('names a citation with no repository rather than dropping it', () => {
    expect(groupByRepository([citation(1, null)])[0]![0]).toBe('unknown repository');
  });
});

describe('sourcesHeading', () => {
  const one = [citation(1, 'billing')];
  const two = [citation(1, 'billing'), citation(2, 'web')];

  it('counts repositories in the cross-repository view', () => {
    expect(sourcesHeading(two, groupByRepository(two), true)).toBe('Across 2 repositories');
  });

  it('says one repository rather than implying more', () => {
    expect(sourcesHeading(one, groupByRepository(one), true)).toBe('From one repository');
  });

  it('counts sources, not repositories, in the single-project view', () => {
    expect(sourcesHeading(one, groupByRepository(one), false)).toBe('Source');
    expect(sourcesHeading(two, groupByRepository(two), false)).toBe('Sources');
  });
});
