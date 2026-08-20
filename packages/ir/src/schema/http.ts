import { z } from 'zod';

/**
 * Tier 2 binding. §5 — "for API integration guides specifically, generated OpenAPI documents
 * beat AST parsing every time". When this is populated the symbol is the highest-fidelity
 * artefact in the system and drives the customer-facing integration guides.
 */
export const zHttpMethod = z.enum([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
  'TRACE',
]);

export const zHttpParameter = z.object({
  name: z.string(),
  in: z.enum(['path', 'query', 'header', 'cookie']),
  required: z.boolean().default(false),
  schema: z.unknown().nullable().default(null),
  description: z.string().nullable().default(null),
  deprecated: z.boolean().default(false),
});

export const zHttpBody = z.object({
  contentType: z.string(),
  schemaRef: z.string().nullable().default(null),
  schema: z.unknown().nullable().default(null),
  required: z.boolean().default(false),
  example: z.unknown().nullable().default(null),
});

export const zHttpResponse = z.object({
  status: z.string().describe('"200", "4XX", "default"'),
  description: z.string().default(''),
  contentType: z.string().nullable().default(null),
  schemaRef: z.string().nullable().default(null),
  schema: z.unknown().nullable().default(null),
  headers: z.record(z.string(), z.string()).default({}),
});

export const zSecurityRequirement = z.object({
  scheme: z.string(),
  type: z.enum(['apiKey', 'http', 'oauth2', 'openIdConnect', 'mutualTLS', 'unknown']),
  scopes: z.array(z.string()).default([]),
});

export const zHttpBinding = z.object({
  method: zHttpMethod,
  /** Templated path exactly as the framework declares it: `/v1/invoices/{invoiceId}`. */
  route: z.string(),
  /** Stable cross-repo join key. This edge — frontend client method → backend handler — is
   *  described in §4.3 as "the single most useful edge in the system". */
  operationId: z.string().nullable().default(null),
  summary: z.string().nullable().default(null),
  tags: z.array(z.string()).default([]),
  parameters: z.array(zHttpParameter).default([]),
  requestBody: zHttpBody.nullable().default(null),
  responses: z.array(zHttpResponse).default([]),
  security: z.array(zSecurityRequirement).default([]),
  deprecated: z.boolean().default(false),
  /** Which service/spec this operation belongs to, for `get_api_spec`. */
  specId: z.string().nullable().default(null),
  specVersion: z.string().nullable().default(null),
});
export type HttpBinding = z.infer<typeof zHttpBinding>;
