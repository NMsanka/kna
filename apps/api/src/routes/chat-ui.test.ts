import { describe, expect, it } from 'vitest';
import { renderTurn, scopeFrom, type Citation, type Turn } from './chat-ui.js';

/**
 * The cross-repository section's whole reason to exist is that it shows which repositories an
 * answer drew on. That path is awkward to reach through the running system — retrieval quite
 * correctly returns the single best repository for most questions, so an answer spanning two of
 * them cannot be summoned on demand. These pin the behaviour instead.
 */

function citation(marker: number, repo: string | null, path: string): Citation {
  return {
    marker,
    chunkId: `chk_${marker}`,
    repo,
    qualifiedName: `Thing${marker}`,
    path,
    startLine: marker * 10,
    analysisDepth: 'semantic',
  };
}

function turn(answer: string, citations: Citation[]): Turn {
  return { question: 'who calls what?', answer, citations, abstained: false, note: null };
}

describe('the cross-repository section', () => {
  it('groups the evidence by repository and counts them', () => {
    const html = renderTurn(
      turn('Both sides do it [1] and also [2].', [
        citation(1, 'billing-api', 'src/charge.ts'),
        citation(2, 'web-app', 'app/checkout.ts'),
      ]),
      0,
      'all',
    );

    expect(html).toContain('Across 2 repositories');
    expect(html).toContain('billing-api');
    expect(html).toContain('web-app');
  });

  it('says one repository rather than implying breadth it does not have', () => {
    const html = renderTurn(
      turn('Only here [1].', [citation(1, 'billing-api', 'src/charge.ts')]),
      0,
      'all',
    );
    expect(html).toContain('From one repository');
    expect(html).not.toContain('Across');
  });

  it('puts several citations from one repository under a single heading for it', () => {
    const html = renderTurn(
      turn('Here [1] and here [2].', [
        citation(1, 'billing-api', 'src/charge.ts'),
        citation(2, 'billing-api', 'src/refund.ts'),
      ]),
      0,
      'all',
    );
    expect(html).toContain('From one repository');
    expect(html.match(/repo-name/g)).toHaveLength(1);
  });

  it('does not group in the single-project section', () => {
    const html = renderTurn(
      turn('Here [1].', [citation(1, 'billing-api', 'src/charge.ts')]),
      0,
      'project',
    );
    expect(html).toContain('Source');
    expect(html).not.toContain('repo-name');
  });

  // Evidence handed to the model but never referenced is not a citation, in either section.
  it('lists only the evidence the answer actually cites', () => {
    const html = renderTurn(
      turn('Just the first [1].', [
        citation(1, 'billing-api', 'src/charge.ts'),
        citation(2, 'web-app', 'app/checkout.ts'),
      ]),
      0,
      'all',
    );
    expect(html).toContain('From one repository');
    expect(html).not.toContain('web-app');
  });

  it('escapes a repository name rather than trusting it', () => {
    const html = renderTurn(
      turn('Here [1].', [citation(1, '<img src=x onerror=alert(1)>', 'src/a.ts')]),
      0,
      'all',
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('the scope picker', () => {
  it('turns a project choice into a project scope', () => {
    expect(scopeFrom('project', 'project:prj_local')).toEqual({
      kind: 'project',
      projectIds: ['prj_local'],
    });
  });

  it('turns a repository choice into a repository scope', () => {
    expect(scopeFrom('project', 'repo:repo_abc')).toEqual({ kind: 'repo', repoIds: ['repo_abc'] });
  });

  it('falls back to the org rather than guessing at an unrecognised value', () => {
    expect(scopeFrom('project', 'nonsense')).toEqual({ kind: 'org' });
  });

  // A value posted from the other section must not narrow the section that exists to be wide.
  it('ignores the picker entirely in the cross-repository section', () => {
    expect(scopeFrom('all', 'repo:repo_abc')).toEqual({ kind: 'org' });
    expect(scopeFrom('all', 'project:prj_local')).toEqual({ kind: 'org' });
  });
});
