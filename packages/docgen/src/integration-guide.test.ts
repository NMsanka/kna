import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contentHash, type ApiSpec } from '@kna/ir';
import { makeSymbol } from '@kna/ir/testing';
import { renderIntegrationGuide } from './integration-guide.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(
  here,
  '..',
  '..',
  'analyzer-openapi',
  'test',
  'fixtures',
  'billing-api',
  'openapi.json',
);

const document = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;

function spec(overrides: Partial<ApiSpec> = {}): ApiSpec {
  return {
    specId: 'billing-api',
    moduleId: 'mod_api',
    title: 'Billing API',
    version: '2.1.0',
    format: 'openapi31',
    document,
    documentHash: contentHash(document),
    sourcePath: 'openapi.json',
    ...overrides,
  };
}

function text(doc: ReturnType<typeof renderIntegrationGuide>): string {
  return [...doc.sections.values()].join('\n\n');
}

describe('renderIntegrationGuide', () => {
  it('is deterministic', () => {
    // A guide that reorders between runs looks changed on every commit, and §7's whole cost
    // model depends on unchanged inputs producing unchanged output.
    const a = renderIntegrationGuide({ spec: spec() });
    const b = renderIntegrationGuide({ spec: spec() });
    expect([...a.sections.entries()]).toEqual([...b.sections.entries()]);
  });

  it('documents every security scheme, with the right header for each type', () => {
    const body = text(renderIntegrationGuide({ spec: spec() }));

    expect(body).toContain('Authorization: Bearer $ACCESS_TOKEN');
    // An apiKey header gets a placeholder named after itself. Reusing $ACCESS_TOKEN would tell
    // a partner to paste the wrong secret into the wrong header.
    expect(body).toContain('X-Acme-Signature: $X_ACME_SIGNATURE');
    expect(body).not.toContain('X-Acme-Signature: $ACCESS_TOKEN');
  });

  it('names the operations that opt out of authentication', () => {
    const body = text(renderIntegrationGuide({ spec: spec() }));
    expect(body).toContain('explicitly opt out of authentication');
    expect(body).toContain('`health`');
  });

  it('picks a write operation for the quickstart, not a GET', () => {
    // The first call should exercise auth, a body and error handling.
    const guide = renderIntegrationGuide({ spec: spec() });
    expect(guide.sections.get('guide.quickstart')).toContain('`POST /invoices`');
  });

  it('builds request examples from the schema, naming each field', () => {
    const body = text(renderIntegrationGuide({ spec: spec() }));

    // `<customerId>` is fillable; `<value>` is not.
    expect(body).toContain('"customerId": "<customerId>"');
    expect(body).toContain('"currency": "<currency>"');
    expect(body).not.toContain('"<value>"');
  });

  it('resolves $ref through components rather than printing the reference', () => {
    const body = text(renderIntegrationGuide({ spec: spec() }));
    // CreateInvoiceRequest.lines[].unitPrice is a $ref to Money.
    expect(body).toContain('amountMinor');
    expect(body).not.toContain('#/components/schemas/Money"');
  });

  it('substitutes path parameters into the example URL', () => {
    const body = text(renderIntegrationGuide({ spec: spec() }));
    expect(body).toContain('/invoices/<invoiceId>');
    expect(body).not.toContain('/invoices/{invoiceId}/issue"');
  });

  it('emits syntactically valid JSON in every curl payload', () => {
    const body = text(renderIntegrationGuide({ spec: spec() }));
    const payloads = [...body.matchAll(/-d '(\{[\s\S]*?\})'\n/g)].map((m) => m[1]!);

    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) {
      expect(() => JSON.parse(payload)).not.toThrow();
    }
  });

  it('emits balanced delimiters in every code block', () => {
    // §15.5 asks for generated snippets to be compiled against the real client, which is not
    // done here. This is the weaker structural check that is available: a snippet with
    // unbalanced braces is broken regardless of what it would compile against.
    const body = text(renderIntegrationGuide({ spec: spec() }));
    const blocks = [...body.matchAll(/```(?:typescript|python|csharp|bash|json)\n([\s\S]*?)```/g)];

    expect(blocks.length).toBeGreaterThan(0);
    for (const [, block] of blocks) {
      const code = block!;
      for (const [open, close] of [
        ['{', '}'],
        ['[', ']'],
        ['(', ')'],
      ] as const) {
        const opens = code.split(open).length - 1;
        const closes = code.split(close).length - 1;
        expect(opens, `unbalanced ${open}${close} in:\n${code.slice(0, 200)}`).toBe(closes);
      }
    }
  });

  it('collects an error catalogue across every operation, deduplicated by status', () => {
    const errors = renderIntegrationGuide({ spec: spec() }).sections.get('guide.errors') ?? '';

    for (const status of ['400', '401', '404', '409', '422', '429']) {
      expect(errors).toContain(`\`${status}\``);
    }
    // 401 appears on two operations; it should be one row naming both.
    expect(errors.split('\n').filter((l) => l.includes('`401`'))).toHaveLength(1);
    expect(errors).toContain('createInvoice');
    expect(errors).toContain('listInvoices');
  });

  it('advises respecting Retry-After when the API declares 429', () => {
    const errors = renderIntegrationGuide({ spec: spec() }).sections.get('guide.errors') ?? '';
    expect(errors).toContain('Retry-After');
  });

  it('groups endpoints by tag', () => {
    const guide = renderIntegrationGuide({ spec: spec() });
    expect(guide.sections.has('guide.endpoints.invoices')).toBe(true);
    expect(guide.sections.has('guide.endpoints.operations')).toBe(true);
  });

  it('marks required parameters, including required headers', () => {
    const invoices = renderIntegrationGuide({ spec: spec() }).sections.get(
      'guide.endpoints.invoices',
    )!;
    expect(invoices).toContain('`Idempotency-Key`');
    expect(invoices).toMatch(/`Idempotency-Key` \| header \| \*\*yes\*\*/);
  });

  it('links an operation to the handler that implements it', () => {
    const handler = makeSymbol({
      qualifiedName: 'InvoicesController.createInvoice',
      httpBinding: {
        method: 'POST',
        route: '/invoices',
        operationId: 'createInvoice',
        summary: null,
        tags: [],
        parameters: [],
        requestBody: null,
        responses: [],
        security: [],
        deprecated: false,
        specId: 'billing-api',
        specVersion: '2.1.0',
      },
    });

    const guide = renderIntegrationGuide({ spec: spec(), symbols: [handler] });
    expect(guide.sections.get('guide.endpoints.invoices')).toContain(
      'InvoicesController.createInvoice',
    );
    expect(guide.provenanceSymbolIds).toContain(handler.id);
  });

  it('omits handler links when publishing externally', () => {
    // §9 — the Documentation Assistant must never leak repo file paths to partners.
    const handler = makeSymbol({
      qualifiedName: 'InvoicesController.createInvoice',
      httpBinding: {
        method: 'POST',
        route: '/invoices',
        operationId: 'createInvoice',
        summary: null,
        tags: [],
        parameters: [],
        requestBody: null,
        responses: [],
        security: [],
        deprecated: false,
        specId: 'billing-api',
        specVersion: '2.1.0',
      },
    });

    const guide = renderIntegrationGuide({ spec: spec(), symbols: [handler], linkHandlers: false });
    expect(guide.sections.get('guide.endpoints.invoices')).not.toContain('Implemented by');
  });

  it('says the snippets are not compiled', () => {
    // Honesty where a reader will see it: §15.5 asks for typechecked snippets, and these are not.
    expect(text(renderIntegrationGuide({ spec: spec() }))).toContain('not been\n> compiled');
  });

  it('warns rather than reassures when a specification declares no errors', () => {
    const bare = spec({
      document: { openapi: '3.1.0', info: { title: 'Bare', version: '1' }, paths: {} },
    });
    const errors = renderIntegrationGuide({ spec: bare }).sections.get('guide.errors') ?? '';

    expect(errors).toContain('the specification is incomplete');
    expect(errors).toContain('defensively');
  });

  it('flags a specification with no security schemes as suspicious, not as open', () => {
    const bare = spec({
      document: { openapi: '3.1.0', info: { title: 'Bare', version: '1' }, paths: {} },
    });
    const auth = renderIntegrationGuide({ spec: bare }).sections.get('guide.authentication') ?? '';

    expect(auth).toContain('worth');
    expect(auth).toContain('confirming rather than assuming the API is open');
  });

  it('records the document hash as provenance', () => {
    // A guide is a rendering of one specification, so it is stale exactly when that document
    // changes — not when some unrelated symbol does.
    const guide = renderIntegrationGuide({ spec: spec() });
    const provenance = guide.frontmatter.provenance as {
      documentHash: string;
      operationIds: string[];
    };

    expect(provenance.documentHash).toBe(contentHash(document));
    expect(provenance.operationIds).toContain('createInvoice');
    expect(guide.slug).toBe('integration/billing-api');
  });
});
