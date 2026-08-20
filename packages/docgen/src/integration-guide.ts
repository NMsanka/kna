import type { ApiSpec, IrSymbol } from '@kna/ir';
import type { RenderedDocument } from './render.js';

/**
 * API integration guide — deterministic, from the OpenAPI document (§6).
 *
 * "API integration guide | Tier 2 OpenAPI + Tier 1 types | Auth flows, request/response
 * examples, error catalogue, generated SDK snippets in 3 languages"
 *
 * §5 is emphatic about the source: "for API integration guides specifically, generated OpenAPI
 * documents beat AST parsing every time. They encode routes, status codes, auth schemes,
 * content types, and fully serialised DTO shapes — things static parsing recovers unreliably or
 * not at all." So this renders from the specification, and consults IR symbols only to link an
 * operation back to the handler that implements it.
 *
 * This is also the customer-facing surface, which §7 gives the highest fan-out priority. A
 * mistake here reaches integration partners, so nothing is inferred: every field, status code
 * and auth scheme below is copied from the document the build produced.
 *
 * **The snippets are not compiled.** §15.5 asks for generated SDK snippets to be typechecked
 * against the real client, and that is not done here. They are syntactically constructed from
 * the schema and are a starting point, not a guarantee — the guide says so where a reader will
 * see it.
 */

export interface IntegrationGuideContext {
  spec: ApiSpec;
  /** Symbols with an HTTP binding, used to link an operation to its handler. */
  symbols?: IrSymbol[];
  /** Include the source link back to the handler. Off for externally published guides. */
  linkHandlers?: boolean;
}

export function renderIntegrationGuide(ctx: IntegrationGuideContext): RenderedDocument {
  const doc = ctx.spec.document as OpenApiDocument;
  const operations = collectOperations(doc);
  const schemes = collectSecuritySchemes(doc);

  const sections = new Map<string, string>();

  sections.set('guide.overview', renderOverview(ctx.spec, doc, operations));
  sections.set('guide.authentication', renderAuthentication(doc, schemes));
  sections.set('guide.quickstart', renderQuickstart(doc, operations, schemes));

  for (const [tag, tagged] of groupByTag(operations)) {
    sections.set(`guide.endpoints.${slug(tag)}`, renderEndpointGroup(tag, tagged, doc, ctx));
  }

  sections.set('guide.errors', renderErrorCatalogue(operations));

  const handlerSymbols = (ctx.symbols ?? []).filter((s) => s.httpBinding);

  return {
    slug: `integration/${slug(ctx.spec.specId)}`,
    title: `${doc.info?.title ?? ctx.spec.title} integration guide`,
    docType: 'api-integration-guide',
    frontmatter: {
      title: `${doc.info?.title ?? ctx.spec.title} integration guide`,
      docType: 'api-integration-guide',
      generated: true,
      generator: 'kna-docgen',
      specId: ctx.spec.specId,
      apiVersion: ctx.spec.version,
      specFormat: ctx.spec.format,
      // The document hash is the real provenance here: this guide is a rendering of one
      // specification, and it is stale exactly when that specification changes.
      provenance: {
        documentHash: ctx.spec.documentHash,
        sourcePath: ctx.spec.sourcePath,
        operationIds: operations.map((o) => o.operationId).filter(Boolean),
        symbolIds: handlerSymbols.map((s) => s.id),
        signatureHashes: Object.fromEntries(handlerSymbols.map((s) => [s.id, s.signatureHash])),
      },
    },
    sections,
    provenanceSymbolIds: handlerSymbols.map((s) => s.id),
    provenanceSignatureHashes: Object.fromEntries(
      handlerSymbols.map((s) => [s.id, s.signatureHash]),
    ),
  };
}

// ── Sections ────────────────────────────────────────────────────────────────────────────────

function renderOverview(spec: ApiSpec, doc: OpenApiDocument, operations: Operation[]): string {
  const lines: string[] = [];

  if (doc.info?.description) {
    lines.push(doc.info.description, '');
  }

  lines.push('| | |');
  lines.push('|---|---|');
  lines.push(`| Version | \`${doc.info?.version ?? spec.version}\` |`);
  lines.push(`| Operations | ${operations.length} |`);

  const servers = doc.servers ?? [];
  if (servers.length > 0) {
    lines.push(
      `| Base URL | ${servers.map((s) => `\`${s.url}\`${s.description ? ` (${s.description})` : ''}`).join('<br/>')} |`,
    );
  }
  lines.push(`| Specification | \`${spec.sourcePath ?? 'generated at build time'}\` |`);

  lines.push('');
  lines.push(
    'This guide is generated from the API specification produced by the service build, so the',
  );
  lines.push(
    'routes, status codes and field names below match what the service actually serves. Prose',
  );
  lines.push('written around them is not; where the two disagree, the specification is correct.');

  return lines.join('\n');
}

/** §6 — "auth flows" first, because nothing else in the guide is reachable without them. */
function renderAuthentication(doc: OpenApiDocument, schemes: SecurityScheme[]): string {
  if (schemes.length === 0) {
    return [
      'This API declares no security schemes.',
      '',
      '> That is unusual for a partner-facing API. It may mean authentication is handled by a',
      '> gateway in front of the service and is genuinely absent from this specification — worth',
      '> confirming rather than assuming the API is open.',
    ].join('\n');
  }

  const lines: string[] = [];
  const globalRequirement = (doc.security ?? []).flatMap((r) => Object.keys(r));

  for (const scheme of schemes) {
    lines.push(`### \`${scheme.name}\``);
    lines.push('');
    if (scheme.description) lines.push(scheme.description, '');

    lines.push(`Type: **${scheme.type}**${scheme.scheme ? ` (${scheme.scheme})` : ''}`);
    if (globalRequirement.includes(scheme.name)) {
      lines.push('Applied to every operation unless an operation overrides it.');
    }
    lines.push('');

    lines.push('```http');
    lines.push(headerFor(scheme));
    lines.push('```');
    lines.push('');
  }

  const unauthenticated = doc.paths
    ? Object.values(doc.paths).flatMap((item) =>
        HTTP_METHODS.map((m) => item[m]).filter(
          (op): op is OpenApiOperation =>
            !!op && Array.isArray(op.security) && op.security.length === 0,
        ),
      )
    : [];

  if (unauthenticated.length > 0) {
    lines.push(
      `${unauthenticated.length} operation(s) explicitly opt out of authentication: ` +
        unauthenticated.map((o) => `\`${o.operationId}\``).join(', ') +
        '.',
    );
  }

  return lines.join('\n');
}

/**
 * §6 — "request/response examples". One worked example beats a reference table for someone
 * making their first call, which is the moment §17 measures as "time-to-first-successful-API-call".
 */
function renderQuickstart(
  doc: OpenApiDocument,
  operations: Operation[],
  schemes: SecurityScheme[],
): string {
  // Prefer a write operation: it exercises auth, a request body and error handling, so it is
  // the more informative first call.
  const example =
    operations.find((o) => o.method === 'POST' && o.requestSchema) ??
    operations.find((o) => o.method !== 'GET') ??
    operations[0];

  if (!example) return '_No operations in this specification._';

  const baseUrl = doc.servers?.[0]?.url ?? 'https://api.example.com';
  const scheme = schemes[0];

  return [
    `The shortest path to a successful call is \`${example.method} ${example.path}\`.`,
    '',
    '```bash',
    renderCurl(example, baseUrl, scheme),
    '```',
    '',
    ...languageBlocks(example, baseUrl, scheme),
    '',
    '> The snippets in this guide are constructed from the specification and have **not been',
    '> compiled or executed**. Field names, routes and required parameters are accurate; the',
    '> surrounding client code is a starting point.',
  ].join('\n');
}

function renderEndpointGroup(
  tag: string,
  operations: Operation[],
  doc: OpenApiDocument,
  ctx: IntegrationGuideContext,
): string {
  const baseUrl = doc.servers?.[0]?.url ?? 'https://api.example.com';
  const schemes = collectSecuritySchemes(doc);
  const handlers = new Map(
    (ctx.symbols ?? [])
      .filter((s) => s.httpBinding?.operationId)
      .map((s) => [s.httpBinding!.operationId!, s]),
  );

  const lines: string[] = [`## ${tag}`, ''];

  for (const operation of operations) {
    lines.push(`### \`${operation.method} ${operation.path}\``);
    lines.push('');
    if (operation.summary) lines.push(`**${operation.summary}**`, '');
    if (operation.description) lines.push(operation.description, '');

    if (operation.deprecated) {
      lines.push('> **Deprecated.** This operation will be removed in a future version.', '');
    }

    if (Array.isArray(operation.security) && operation.security.length === 0) {
      lines.push('_No authentication required._', '');
    }

    if (operation.parameters.length > 0) {
      lines.push('| Parameter | In | Required | Type | Description |');
      lines.push('|---|---|---|---|---|');
      for (const p of operation.parameters) {
        lines.push(
          `| \`${p.name}\` | ${p.in} | ${p.required ? '**yes**' : 'no'} | ${typeOf(p.schema)} | ${clean(p.description)} |`,
        );
      }
      lines.push('');
    }

    if (operation.requestSchema) {
      lines.push('**Request body**', '');
      lines.push(...renderFieldTable(operation.requestSchema, doc));
      lines.push('');
    }

    if (operation.responses.length > 0) {
      lines.push('| Status | Meaning |');
      lines.push('|---|---|');
      for (const r of operation.responses) {
        lines.push(`| \`${r.status}\` | ${clean(r.description)} |`);
      }
      lines.push('');
    }

    lines.push('```bash');
    lines.push(renderCurl(operation, baseUrl, schemes[0]));
    lines.push('```');
    lines.push('');
    lines.push(...languageBlocks(operation, baseUrl, schemes[0]));

    const handler = operation.operationId ? handlers.get(operation.operationId) : undefined;
    if (handler && ctx.linkHandlers !== false) {
      lines.push('');
      lines.push(
        `<sub>Implemented by \`${handler.qualifiedName}\` — \`${handler.sourceRef.path}:${handler.sourceRef.startLine}\`</sub>`,
      );
    }

    lines.push('', '---', '');
  }

  return lines.join('\n');
}

/**
 * §6 — "error catalogue". Collected across every operation and deduplicated, because a partner
 * writing error handling wants one list, not to read forty response tables.
 */
function renderErrorCatalogue(operations: Operation[]): string {
  const byStatus = new Map<string, { descriptions: Set<string>; operations: string[] }>();

  for (const operation of operations) {
    for (const response of operation.responses) {
      if (/^2/.test(response.status)) continue;
      const entry = byStatus.get(response.status) ?? { descriptions: new Set(), operations: [] };
      if (response.description) entry.descriptions.add(response.description);
      entry.operations.push(operation.operationId ?? `${operation.method} ${operation.path}`);
      byStatus.set(response.status, entry);
    }
  }

  if (byStatus.size === 0) {
    return [
      'This specification declares no error responses.',
      '',
      '> Every API returns errors. Their absence here means the specification is incomplete, not',
      '> that the calls cannot fail — build error handling defensively.',
    ].join('\n');
  }

  const lines = ['| Status | Meaning | Returned by |', '|---|---|---|'];

  for (const [status, entry] of [...byStatus.entries()].sort()) {
    const shown = entry.operations
      .slice(0, 4)
      .map((o) => `\`${o}\``)
      .join(', ');
    const more = entry.operations.length > 4 ? `, +${entry.operations.length - 4} more` : '';
    lines.push(
      `| \`${status}\` | ${clean([...entry.descriptions].join(' / '))} | ${shown}${more} |`,
    );
  }

  if (byStatus.has('429')) {
    lines.push('');
    lines.push(
      'A `429` carries `Retry-After`. Respect it rather than retrying immediately — retrying into',
    );
    lines.push('a rate limit extends the outage rather than shortening it.');
  }

  return lines.join('\n');
}

// ── Snippets ────────────────────────────────────────────────────────────────────────────────

function renderCurl(
  operation: Operation,
  baseUrl: string,
  scheme: SecurityScheme | undefined,
): string {
  const url = `${baseUrl}${fillPath(operation)}`;
  const parts = [`curl -X ${operation.method} '${url}${queryString(operation)}'`];

  if (scheme && !(Array.isArray(operation.security) && operation.security.length === 0)) {
    parts.push(`  -H '${headerFor(scheme)}'`);
  }
  for (const header of operation.parameters.filter((p) => p.in === 'header')) {
    parts.push(`  -H '${header.name}: ${exampleScalar(header.schema, header.name)}'`);
  }
  if (operation.requestSchema) {
    parts.push(`  -H 'Content-Type: application/json'`);
    parts.push(`  -d '${JSON.stringify(exampleFor(operation.requestSchema, operation.doc))}'`);
  }

  return parts.join(' \\\n');
}

/** §6 asks for three languages. These match the three the platform analyses. */
function languageBlocks(
  operation: Operation,
  baseUrl: string,
  scheme: SecurityScheme | undefined,
): string[] {
  return [
    '<details>',
    '<summary>TypeScript, Python and C#</summary>',
    '',
    '```typescript',
    renderTypeScript(operation, baseUrl, scheme),
    '```',
    '',
    '```python',
    renderPython(operation, baseUrl, scheme),
    '```',
    '',
    '```csharp',
    renderCSharp(operation, baseUrl, scheme),
    '```',
    '',
    '</details>',
  ];
}

function renderTypeScript(
  operation: Operation,
  baseUrl: string,
  scheme: SecurityScheme | undefined,
): string {
  const headers = [`'Content-Type': 'application/json'`];
  if (scheme)
    headers.unshift(
      `${JSON.stringify(headerName(scheme))}: \`${headerValueTemplate(scheme, '${token}')}\``,
    );
  for (const h of operation.parameters.filter((p) => p.in === 'header')) {
    headers.push(`${JSON.stringify(h.name)}: ${JSON.stringify(exampleScalar(h.schema, h.name))}`);
  }

  const body = operation.requestSchema
    ? `,\n  body: JSON.stringify(${JSON.stringify(exampleFor(operation.requestSchema, operation.doc), null, 2).replace(/\n/g, '\n  ')})`
    : '';

  return [
    `const response = await fetch('${baseUrl}${fillPath(operation)}${queryString(operation)}', {`,
    `  method: '${operation.method}',`,
    `  headers: {\n    ${headers.join(',\n    ')}\n  }${body}`,
    `});`,
    ``,
    `if (!response.ok) {`,
    `  // See the error catalogue below — ${
      operation.responses
        .filter((r) => !/^2/.test(r.status))
        .map((r) => r.status)
        .join(', ') || 'errors are undocumented'
    }`,
    `  throw new Error(\`${operation.operationId ?? 'request'} failed: \${response.status}\`);`,
    `}`,
    ``,
    `const result = await response.json();`,
  ].join('\n');
}

function renderPython(
  operation: Operation,
  baseUrl: string,
  scheme: SecurityScheme | undefined,
): string {
  // Eight spaces: dict members sit one level inside the `headers={` that is itself one level
  // inside the call. A snippet a partner pastes should at least be valid Python.
  const headers: string[] = [];
  if (scheme) {
    headers.push(
      `        ${JSON.stringify(headerName(scheme))}: f"${headerValueTemplate(scheme, '{token}')}",`,
    );
  }
  for (const h of operation.parameters.filter((p) => p.in === 'header')) {
    headers.push(
      `        ${JSON.stringify(h.name)}: ${JSON.stringify(exampleScalar(h.schema, h.name))},`,
    );
  }

  // Re-indent the JSON literal to the call's level for the same reason.
  const body = operation.requestSchema
    ? `,\n    json=${pythonLiteral(exampleFor(operation.requestSchema, operation.doc)).split('\n').join('\n    ')}`
    : '';

  return [
    `import httpx`,
    ``,
    `response = httpx.${operation.method.toLowerCase()}(`,
    `    "${baseUrl}${fillPath(operation)}${queryString(operation)}",`,
    `    headers={`,
    ...headers,
    `    }${body}`,
    `)`,
    `response.raise_for_status()`,
    `result = response.json()`,
  ].join('\n');
}

function renderCSharp(
  operation: Operation,
  baseUrl: string,
  scheme: SecurityScheme | undefined,
): string {
  const lines = [`using var client = new HttpClient();`];
  if (scheme) {
    lines.push(
      `client.DefaultRequestHeaders.Add("${headerName(scheme)}", $"${headerValueTemplate(scheme, '{token}')}");`,
    );
  }
  for (const h of operation.parameters.filter((p) => p.in === 'header')) {
    lines.push(
      `client.DefaultRequestHeaders.Add("${h.name}", "${exampleScalar(h.schema, h.name)}");`,
    );
  }

  const url = `"${baseUrl}${fillPath(operation)}${queryString(operation)}"`;

  if (operation.requestSchema) {
    lines.push(``);
    lines.push(
      `var payload = ${JSON.stringify(JSON.stringify(exampleFor(operation.requestSchema, operation.doc)))};`,
    );
    lines.push(`var content = new StringContent(payload, Encoding.UTF8, "application/json");`);
    lines.push(
      `var response = await client.${csharpMethod(operation.method)}(${url}${operation.method === 'DELETE' ? '' : ', content'});`,
    );
  } else {
    lines.push(`var response = await client.${csharpMethod(operation.method)}(${url});`);
  }

  lines.push(`response.EnsureSuccessStatusCode();`);
  lines.push(`var result = await response.Content.ReadAsStringAsync();`);

  return lines.join('\n');
}

function csharpMethod(method: string): string {
  switch (method) {
    case 'POST':
      return 'PostAsync';
    case 'PUT':
      return 'PutAsync';
    case 'PATCH':
      return 'PatchAsync';
    case 'DELETE':
      return 'DeleteAsync';
    default:
      return 'GetAsync';
  }
}

// ── Schema handling ─────────────────────────────────────────────────────────────────────────

function renderFieldTable(schema: JsonSchema, doc: OpenApiDocument): string[] {
  const resolved = resolve(schema, doc);
  const properties = resolved.properties ?? {};
  const required = new Set(resolved.required ?? []);

  if (Object.keys(properties).length === 0) {
    return [`\`\`\`json`, JSON.stringify(exampleFor(schema, doc), null, 2), '```'];
  }

  const lines = ['| Field | Type | Required | Description |', '|---|---|---|---|'];
  for (const [name, property] of Object.entries(properties)) {
    const p = resolve(property, doc);
    lines.push(
      `| \`${name}\` | ${typeOf(property)} | ${required.has(name) ? '**yes**' : 'no'} | ${clean(p.description)} |`,
    );
  }
  return lines;
}

/** Build a plausible example from a schema. Deterministic: the same schema always renders the
 *  same example, so a guide does not appear to change when nothing did. */
function exampleFor(
  schema: JsonSchema | undefined,
  doc: OpenApiDocument,
  depth = 0,
  fieldName = 'value',
): unknown {
  if (!schema || depth > 4) return null;
  const s = resolve(schema, doc);

  if (s.example !== undefined) return s.example;
  if (s.enum?.length) return s.enum[0];
  if (s.default !== undefined) return s.default;

  switch (s.type) {
    case 'array':
      return [exampleFor(s.items, doc, depth + 1, fieldName)];
    case 'integer':
      return 0;
    case 'number':
      return 0;
    case 'boolean':
      return true;
    case 'object':
    case undefined: {
      const properties = s.properties ?? {};
      if (Object.keys(properties).length === 0) return {};
      const out: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(properties)) {
        out[name] = exampleFor(property, doc, depth + 1, name);
      }
      return out;
    }
    default:
      return exampleScalar(s, fieldName);
  }
}

function exampleScalar(schema: JsonSchema | undefined, name: string): string {
  const s = schema ?? {};
  if (s.example !== undefined) return String(s.example);
  if (s.enum?.length) return String(s.enum[0]);
  if (s.format === 'date-time') return '2026-08-20T09:00:00Z';
  if (s.format === 'uuid') return '00000000-0000-0000-0000-000000000000';
  if (s.type === 'integer' || s.type === 'number') return '0';
  if (s.type === 'boolean') return 'true';
  return `<${name}>`;
}

function typeOf(schema: JsonSchema | undefined): string {
  if (!schema) return '—';
  if (schema.$ref) return `\`${schema.$ref.split('/').pop()}\``;
  if (schema.enum?.length) return schema.enum.map((v) => `\`${String(v)}\``).join(' \\| ');
  if (schema.type === 'array') return `\`${typeOf(schema.items).replace(/`/g, '')}[]\``;
  return `\`${schema.type ?? 'object'}\``;
}

function resolve(schema: JsonSchema, doc: OpenApiDocument): JsonSchema {
  if (!schema.$ref) return schema;
  const name = schema.$ref.split('/').pop();
  if (!name) return schema;
  return doc.components?.schemas?.[name] ?? schema;
}

// ── Document traversal ──────────────────────────────────────────────────────────────────────

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'] as const;

interface Operation {
  method: string;
  path: string;
  operationId: string | null;
  summary: string | null;
  description: string | null;
  tags: string[];
  deprecated: boolean;
  parameters: Array<{
    name: string;
    in: string;
    required: boolean;
    schema: JsonSchema | undefined;
    description: string | null;
  }>;
  requestSchema: JsonSchema | undefined;
  responses: Array<{ status: string; description: string }>;
  security: unknown[] | undefined;
  doc: OpenApiDocument;
}

function collectOperations(doc: OpenApiDocument): Operation[] {
  const out: Operation[] = [];

  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    const shared = item.parameters ?? [];
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) continue;

      const content = operation.requestBody?.content ?? {};
      const contentType = Object.keys(content)[0];

      out.push({
        method: method.toUpperCase(),
        path,
        operationId: operation.operationId ?? null,
        summary: operation.summary ?? null,
        description: operation.description ?? null,
        tags: operation.tags ?? ['Endpoints'],
        deprecated: operation.deprecated ?? false,
        parameters: [...shared, ...(operation.parameters ?? [])].map((p) => ({
          name: p.name ?? '',
          in: p.in ?? 'query',
          required: p.required ?? p.in === 'path',
          schema: p.schema,
          description: p.description ?? null,
        })),
        requestSchema: contentType ? content[contentType]?.schema : undefined,
        responses: Object.entries(operation.responses ?? {}).map(([status, r]) => ({
          status,
          description: r.description ?? '',
        })),
        security: operation.security,
        doc,
      });
    }
  }

  // Stable ordering: path, then method. A guide that reorders looks changed when nothing did.
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

function groupByTag(operations: Operation[]): Map<string, Operation[]> {
  const out = new Map<string, Operation[]>();
  for (const operation of operations) {
    const tag = operation.tags[0] ?? 'Endpoints';
    out.set(tag, [...(out.get(tag) ?? []), operation]);
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

interface SecurityScheme {
  name: string;
  type: string;
  scheme?: string;
  bearerFormat?: string;
  in?: string;
  headerName?: string;
  description?: string;
}

function collectSecuritySchemes(doc: OpenApiDocument): SecurityScheme[] {
  return Object.entries(doc.components?.securitySchemes ?? {})
    .map(([name, s]) => ({
      name,
      type: s.type ?? 'unknown',
      scheme: s.scheme,
      bearerFormat: s.bearerFormat,
      in: s.in,
      headerName: s.name,
      description: s.description,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function headerName(scheme: SecurityScheme): string {
  if (scheme.type === 'apiKey' && scheme.in === 'header') return scheme.headerName ?? 'X-API-Key';
  return 'Authorization';
}

function headerValueTemplate(scheme: SecurityScheme, token: string): string {
  if (scheme.type === 'http' && scheme.scheme === 'bearer') return `Bearer ${token}`;
  if (scheme.type === 'http' && scheme.scheme === 'basic') return `Basic ${token}`;
  if (scheme.type === 'oauth2') return `Bearer ${token}`;
  return token;
}

/**
 * A placeholder named after the credential it stands for. Reusing `$ACCESS_TOKEN` for an HMAC
 * signature header tells a partner to paste the wrong secret into the wrong place, which is a
 * small ambiguity with an expensive failure mode.
 */
function placeholderFor(scheme: SecurityScheme): string {
  if (scheme.type === 'http' && scheme.scheme === 'basic') return '$BASIC_CREDENTIALS';
  if (scheme.type === 'apiKey') {
    return `$${(scheme.headerName ?? scheme.name).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
  }
  return '$ACCESS_TOKEN';
}

function headerFor(scheme: SecurityScheme): string {
  return `${headerName(scheme)}: ${headerValueTemplate(scheme, placeholderFor(scheme))}`;
}

function fillPath(operation: Operation): string {
  let path = operation.path;
  for (const parameter of operation.parameters.filter((p) => p.in === 'path')) {
    path = path.replace(`{${parameter.name}}`, exampleScalar(parameter.schema, parameter.name));
  }
  return path;
}

function queryString(operation: Operation): string {
  const required = operation.parameters.filter((p) => p.in === 'query' && p.required);
  if (required.length === 0) return '';
  return `?${required.map((p) => `${p.name}=${exampleScalar(p.schema, p.name)}`).join('&')}`;
}

function pythonLiteral(value: unknown): string {
  return JSON.stringify(value, null, 4)
    .replace(/\btrue\b/g, 'True')
    .replace(/\bfalse\b/g, 'False')
    .replace(/\bnull\b/g, 'None');
}

function clean(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Minimal document shape ──────────────────────────────────────────────────────────────────

interface JsonSchema {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
  nullable?: boolean;
}

interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: JsonSchema;
  description?: string;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { description?: string }>;
  security?: unknown[];
}

type PathItem = { [M in (typeof HTTP_METHODS)[number]]?: OpenApiOperation } & {
  parameters?: OpenApiParameter[];
};

interface OpenApiDocument {
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  security?: Array<Record<string, string[]>>;
  paths?: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, JsonSchema>;
    securitySchemes?: Record<
      string,
      {
        type?: string;
        scheme?: string;
        bearerFormat?: string;
        in?: string;
        name?: string;
        description?: string;
      }
    >;
  };
}
