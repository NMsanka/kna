import { describe, expect, it } from 'vitest';
import { makeModule, makePayload, makeSymbol } from '@kna/ir/testing';
import type { IrBundlePayload } from '@kna/ir';
import { renderArchitectureOverview } from './architecture.js';

function payloadWith(overrides: Partial<IrBundlePayload> = {}): IrBundlePayload {
  return makePayload([], overrides);
}

function sectionText(doc: ReturnType<typeof renderArchitectureOverview>, id: string): string {
  return doc.sections.get(id) ?? '';
}

describe('renderArchitectureOverview', () => {
  it('is deterministic — the same bundle renders identically', () => {
    // §7's cost model depends on this: a document that reorders between runs looks changed on
    // every commit and regenerates forever.
    const payload = payloadWith({
      modules: [
        makeModule({ id: 'mod_a', path: 'packages/a', packageName: '@x/a' }),
        makeModule({ id: 'mod_b', path: 'packages/b', packageName: '@x/b' }),
      ],
    });

    const first = renderArchitectureOverview({ payload });
    const second = renderArchitectureOverview({ payload });

    expect([...first.sections.entries()]).toEqual([...second.sections.entries()]);
  });

  it('resolves declared dependencies into edges between modules in the bundle', () => {
    const payload = payloadWith({
      modules: [
        makeModule({
          id: 'mod_app',
          path: 'apps/app',
          packageName: '@x/app',
          dependencies: [{ name: '@x/lib', version: '1.0.0', dev: false }],
        }),
        makeModule({ id: 'mod_lib', path: 'packages/lib', packageName: '@x/lib' }),
      ],
    });

    const container = sectionText(
      renderArchitectureOverview({ payload }),
      'architecture.container',
    );

    expect(container).toContain('@x/app');
    expect(container).toContain('@x/lib');
    expect(container).toContain('@x/app depends on @x/lib');
  });

  it('ignores dependencies on packages outside the bundle', () => {
    // A CLI run covers one repository, so a dependency on an unrelated npm package is not an
    // internal edge. Cross-repo edges need the platform's resolution pass (§4.3).
    const payload = payloadWith({
      modules: [
        makeModule({
          id: 'mod_a',
          path: 'packages/a',
          packageName: '@x/a',
          dependencies: [{ name: 'zod', version: '^3', dev: false }],
        }),
      ],
    });

    const container = sectionText(
      renderArchitectureOverview({ payload }),
      'architecture.container',
    );
    expect(container).toContain('0 internal dependency edge(s)');
  });

  it('distinguishes development-only dependencies in both the diagram and the text', () => {
    const payload = payloadWith({
      modules: [
        makeModule({
          id: 'mod_a',
          path: 'packages/a',
          packageName: '@x/a',
          dependencies: [{ name: '@x/b', version: '1.0.0', dev: true }],
        }),
        makeModule({ id: 'mod_b', path: 'packages/b', packageName: '@x/b' }),
      ],
    });

    const container = sectionText(
      renderArchitectureOverview({ payload }),
      'architecture.container',
    );

    // Dashed in Mermaid, and stated in the text alternative — conflating build-time with
    // runtime is how an architecture diagram stops being trusted.
    expect(container).toContain('-.->');
    expect(container).toContain('(development only)');
  });

  it('gives every diagram a complete text alternative, not a summary', () => {
    // §15.8 names the missing text alternative for Mermaid as a specific accessibility failure.
    // A lossy alternative gives a screen-reader user less than a sighted one.
    const payload = payloadWith({
      modules: [
        makeModule({
          id: 'mod_a',
          path: 'a',
          packageName: '@x/a',
          dependencies: [
            { name: '@x/b', version: '1', dev: false },
            { name: '@x/c', version: '1', dev: false },
          ],
        }),
        makeModule({ id: 'mod_b', path: 'b', packageName: '@x/b' }),
        makeModule({ id: 'mod_c', path: 'c', packageName: '@x/c' }),
      ],
    });

    const container = sectionText(
      renderArchitectureOverview({ payload }),
      'architecture.container',
    );

    expect(container).toContain('Text description of the diagram above');
    // Both edges described, not "2 dependencies" as a count.
    expect(container).toContain('@x/a depends on @x/b');
    expect(container).toContain('@x/a depends on @x/c');
  });

  it('renders runtime topology from harvested service manifests', () => {
    const payload = payloadWith({
      services: [
        {
          name: 'api',
          kind: 'service',
          moduleId: null,
          image: null,
          dependsOn: ['db'],
          ports: [],
          source: 'docker-compose.yml',
        },
        {
          name: 'db',
          kind: 'database',
          moduleId: null,
          image: 'postgres:17',
          dependsOn: [],
          ports: [5432],
          source: 'docker-compose.yml',
        },
      ],
    });

    const context = sectionText(renderArchitectureOverview({ payload }), 'architecture.context');

    expect(context).toContain('api (service) depends on db');
    // Databases get the cylinder shape.
    expect(context).toMatch(/\[\(.*db/);
    expect(context).toContain('docker-compose.yml');
  });

  it('marks a dependency on something outside the repo as an external system', () => {
    const payload = payloadWith({
      services: [
        {
          name: 'api',
          kind: 'service',
          moduleId: null,
          image: null,
          dependsOn: ['stripe'],
          ports: [],
          source: 'compose.yml',
        },
      ],
    });

    const context = sectionText(renderArchitectureOverview({ payload }), 'architecture.context');

    // Dropping the edge would be worse: the reader would not know the dependency exists.
    expect(context).toContain('external');
    expect(context).toContain('api (service) depends on stripe');
  });

  it('says so plainly when there is no runtime topology to show', () => {
    const summary = sectionText(
      renderArchitectureOverview({ payload: payloadWith() }),
      'architecture.summary',
    );
    expect(summary).toContain('describes what the code references rather than what actually runs');
  });

  it('ranks modules by in-degree, so the centre of gravity is first', () => {
    const payload = payloadWith({
      modules: [
        makeModule({ id: 'mod_leaf', path: 'leaf', packageName: '@x/leaf' }),
        makeModule({
          id: 'mod_a',
          path: 'a',
          packageName: '@x/a',
          dependencies: [{ name: '@x/core', version: '1', dev: false }],
        }),
        makeModule({
          id: 'mod_b',
          path: 'b',
          packageName: '@x/b',
          dependencies: [{ name: '@x/core', version: '1', dev: false }],
        }),
        makeModule({ id: 'mod_core', path: 'core', packageName: '@x/core' }),
      ],
    });

    const component = sectionText(
      renderArchitectureOverview({ payload }),
      'architecture.component',
    );
    const rows = component.split('\n').filter((l) => l.startsWith('| `'));

    expect(rows[0]).toContain('`core`');
    expect(component).toContain('the one where a breaking change costs most');
  });

  it('flags shallow modules, because a shallow diagram is missing edges it cannot see', () => {
    // §5 — never present shallow output with the confidence of semantic output.
    const payload = payloadWith({
      modules: [
        makeModule({
          id: 'mod_a',
          path: 'a',
          analysisDepth: 'shallow',
          analysisNotes: ['csharp: toolchain for roslyn not found'],
        }),
      ],
    });

    const confidence = sectionText(
      renderArchitectureOverview({ payload }),
      'architecture.confidence',
    );

    expect(confidence).toContain('1 of 1 module(s) were analysed at shallow depth');
    expect(confidence).toContain('roslyn');
  });

  it('reports full confidence only when every module reached semantic depth', () => {
    const payload = payloadWith({ modules: [makeModule({ analysisDepth: 'semantic' })] });
    const confidence = sectionText(
      renderArchitectureOverview({ payload }),
      'architecture.confidence',
    );
    expect(confidence).toContain('resolved rather than inferred');
  });

  it('lists the HTTP surface and flags endpoints declaring no auth', () => {
    const binding = {
      method: 'POST' as const,
      route: '/v1/invoices',
      operationId: 'createInvoice',
      summary: null,
      tags: [],
      parameters: [],
      requestBody: null,
      responses: [],
      security: [],
      deprecated: false,
      specId: null,
      specVersion: null,
    };

    const payload = payloadWith({
      symbols: [makeSymbol({ qualifiedName: 'Api.Create', httpBinding: binding })],
    });

    const surface = sectionText(
      renderArchitectureOverview({ payload }),
      'architecture.api-surface',
    );

    expect(surface).toContain('/v1/invoices');
    expect(surface).toContain('declare no authentication');
    // Hedged rather than alarmist: health checks legitimately have none.
    expect(surface).toContain('may be correct');
  });

  it('omits the API section entirely when there are no endpoints', () => {
    const doc = renderArchitectureOverview({ payload: payloadWith() });
    expect(doc.sections.has('architecture.api-surface')).toBe(false);
  });

  it('records module and endpoint provenance for staleness detection', () => {
    const payload = payloadWith({
      modules: [makeModule({ id: 'mod_a' })],
      symbols: [makeSymbol({ id: 'sym_1' })],
    });

    const doc = renderArchitectureOverview({ payload });
    const provenance = doc.frontmatter.provenance as { moduleIds: string[] };

    expect(provenance.moduleIds).toContain('mod_a');
    expect(doc.docType).toBe('architecture-overview');
    expect(doc.slug).toBe('architecture/overview');
  });
});
