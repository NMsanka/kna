import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { globby } from 'globby';
import { parse as parseYaml } from 'yaml';
import { contentHash, type ApiSpec, type HttpBinding } from '@kna/ir';

/**
 * Tier 2 — OpenAPI extraction (§5).
 *
 * "For API integration guides specifically, generated OpenAPI documents beat AST parsing every
 * time. They encode routes, status codes, auth schemes, content types, and fully serialised DTO
 * shapes — things static parsing recovers unreliably or not at all."
 *
 * Two outputs come from one pass: the raw documents, stored verbatim because they are the
 * customer-facing source of truth, and per-operation `HttpBinding`s keyed by a name the IR
 * assembly can match back to a handler symbol. That second output is what turns "a controller
 * method" into "a documented endpoint", and it is what makes the frontend-call-to-backend-
 * handler cross-repo edge resolvable at all (§4.3).
 */

const SPEC_GLOBS = [
  '**/openapi.{json,yaml,yml}',
  '**/openapi-*.{json,yaml,yml}',
  '**/swagger.{json,yaml,yml}',
  '**/*.openapi.{json,yaml,yml}',
  '**/api-spec.{json,yaml,yml}',
  '**/{docs,api,spec,specs,contracts}/**/*.{json,yaml,yml}',
  '**/bin/**/*.json',
  '**/obj/**/*.json',
];

const IGNORE_GLOBS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/package-lock.json',
  '**/tsconfig*.json',
  '**/*.tsbuildinfo',
];

export interface ExtractSpecsInput {
  repoRoot: string;
  modules: Array<{ path: string; name: string }>;
  /** Explicit paths from config, for specs the globs cannot find. */
  explicitPaths?: string[];
}

export interface ExtractSpecsResult {
  specs: ApiSpec[];
  /**
   * Keyed by `operationId`, and additionally by the handler name when one is recoverable from
   * `x-` extensions. Assembly looks up by qualified name first, then by unqualified name.
   */
  bindings: Map<string, HttpBinding>;
  /** Files that looked like specs but could not be parsed — reported, never fatal. */
  skipped: Array<{ path: string; reason: string }>;
}

export async function extractApiSpecs(input: ExtractSpecsInput): Promise<ExtractSpecsResult> {
  const candidates = new Set<string>(input.explicitPaths ?? []);

  const found = await globby(SPEC_GLOBS, {
    cwd: input.repoRoot,
    ignore: IGNORE_GLOBS,
    onlyFiles: true,
    followSymbolicLinks: false,
  });
  for (const path of found) candidates.add(path);

  const specs: ApiSpec[] = [];
  const bindings = new Map<string, HttpBinding>();
  const skipped: ExtractSpecsResult['skipped'] = [];

  for (const relPath of candidates) {
    let document: unknown;
    try {
      const raw = await readFile(join(input.repoRoot, relPath), 'utf8');
      document = relPath.endsWith('.json') ? JSON.parse(raw) : parseYaml(raw);
    } catch (error) {
      skipped.push({
        path: relPath,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const detected = detectFormat(document);
    if (!detected) continue; // Not a spec; the globs are deliberately wide.

    const doc = document as OpenApiDocument;
    const specId = doc.info?.title
      ? slug(doc.info.title)
      : slug(relPath.replace(/\.(json|ya?ml)$/, ''));
    const specVersion = doc.info?.version ?? '0.0.0';

    specs.push({
      specId,
      // Resolved against the module list by the caller, which knows the assembled module ids.
      moduleId: '',
      title: doc.info?.title ?? specId,
      version: specVersion,
      format: detected,
      document,
      documentHash: contentHash(document),
      sourcePath: relPath,
    });

    for (const [key, binding] of extractBindings(doc, specId, specVersion)) {
      // First spec wins on collision: a build output and a checked-in copy of the same spec
      // are common, and silently merging two versions of one operation is worse than either.
      if (!bindings.has(key)) bindings.set(key, binding);
    }
  }

  return { specs, bindings, skipped };
}

// ── Document shape (only what is read; the document is stored verbatim regardless) ──────────

interface OpenApiDocument {
  openapi?: string;
  swagger?: string;
  info?: { title?: string; version?: string };
  paths?: Record<string, Record<string, OpenApiOperation> & { parameters?: OpenApiParameter[] }>;
  components?: { securitySchemes?: Record<string, { type?: string; scheme?: string }> };
  securityDefinitions?: Record<string, { type?: string }>;
  security?: Array<Record<string, string[]>>;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: unknown; example?: unknown }>;
  };
  responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: unknown }>;
      headers?: Record<string, unknown>;
      schema?: unknown;
    }
  >;
  security?: Array<Record<string, string[]>>;
  'x-handler'?: string;
  'x-controller'?: string;
  'x-operation-name'?: string;
}

interface OpenApiParameter {
  name?: string;
  in?: string;
  required?: boolean;
  schema?: unknown;
  description?: string;
  deprecated?: boolean;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;

function detectFormat(document: unknown): ApiSpec['format'] | null {
  if (!document || typeof document !== 'object') return null;
  const doc = document as OpenApiDocument;
  if (typeof doc.openapi === 'string') {
    return doc.openapi.startsWith('3.1') ? 'openapi31' : 'openapi3';
  }
  if (typeof doc.swagger === 'string') return 'swagger2';
  return null;
}

function* extractBindings(
  doc: OpenApiDocument,
  specId: string,
  specVersion: string,
): Generator<[string, HttpBinding]> {
  const schemeTypes = new Map<string, string>();
  for (const [name, scheme] of Object.entries(doc.components?.securitySchemes ?? {})) {
    schemeTypes.set(name, scheme.type ?? 'unknown');
  }
  for (const [name, scheme] of Object.entries(doc.securityDefinitions ?? {})) {
    schemeTypes.set(name, scheme.type ?? 'unknown');
  }

  for (const [route, pathItem] of Object.entries(doc.paths ?? {})) {
    const pathLevelParameters = pathItem.parameters ?? [];

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as OpenApiOperation | undefined;
      if (!operation || typeof operation !== 'object') continue;

      const security = (operation.security ?? doc.security ?? []).flatMap((requirement) =>
        Object.entries(requirement).map(([scheme, scopes]) => ({
          scheme,
          type: normaliseSecurityType(schemeTypes.get(scheme)),
          scopes,
        })),
      );

      const binding: HttpBinding = {
        method: method.toUpperCase() as HttpBinding['method'],
        route,
        operationId: operation.operationId ?? null,
        summary: operation.summary ?? operation.description ?? null,
        tags: operation.tags ?? [],
        parameters: [...pathLevelParameters, ...(operation.parameters ?? [])].map((p) => ({
          name: p.name ?? '',
          in: (p.in ?? 'query') as 'path' | 'query' | 'header' | 'cookie',
          required: p.required ?? p.in === 'path',
          schema: p.schema ?? null,
          description: p.description ?? null,
          deprecated: p.deprecated ?? false,
        })),
        requestBody: extractRequestBody(operation),
        responses: Object.entries(operation.responses ?? {}).map(([status, response]) => {
          const contentType = Object.keys(response.content ?? {})[0] ?? null;
          return {
            status,
            description: response.description ?? '',
            contentType,
            schemaRef: null,
            schema: contentType
              ? (response.content?.[contentType]?.schema ?? null)
              : (response.schema ?? null),
            headers: Object.fromEntries(Object.keys(response.headers ?? {}).map((h) => [h, ''])),
          };
        }),
        security,
        deprecated: operation.deprecated ?? false,
        specId,
        specVersion,
      };

      // Emit under every name the handler symbol might carry. Assembly tries the qualified
      // name first, so a fully-qualified `x-handler` beats a bare operationId.
      const keys = [
        operation['x-handler'],
        operation['x-controller'] && operation['x-operation-name']
          ? `${operation['x-controller']}.${operation['x-operation-name']}`
          : null,
        operation.operationId,
        // Conventional derivation: `createInvoice` → also try `InvoiceController.createInvoice`.
        operation.operationId ? capitalise(operation.operationId) : null,
      ].filter((k): k is string => Boolean(k));

      for (const key of keys) yield [key, binding];
    }
  }
}

function extractRequestBody(operation: OpenApiOperation): HttpBinding['requestBody'] {
  const content = operation.requestBody?.content;
  if (!content) return null;
  const contentType = Object.keys(content)[0];
  if (!contentType) return null;
  return {
    contentType,
    schemaRef: null,
    schema: content[contentType]?.schema ?? null,
    required: operation.requestBody?.required ?? false,
    example: content[contentType]?.example ?? null,
  };
}

function normaliseSecurityType(type: string | undefined): HttpBinding['security'][number]['type'] {
  switch (type) {
    case 'apiKey':
    case 'http':
    case 'oauth2':
    case 'openIdConnect':
    case 'mutualTLS':
      return type;
    case 'basic':
      return 'http';
    default:
      return 'unknown';
  }
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
