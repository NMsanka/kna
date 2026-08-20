import { z } from 'zod';

/** Languages with a registered analyser. Adding one is a spec change (§13), not a commit. */
export const zLanguage = z.enum(['typescript', 'javascript', 'python', 'csharp', 'unknown']);
export type Language = z.infer<typeof zLanguage>;

export const zSymbolKind = z.enum([
  'class',
  'interface',
  'function',
  'method',
  'property',
  'field',
  'enum',
  'enumMember',
  'type',
  'constant',
  'module',
  'namespace',
  'endpoint',
  'record',
  'struct',
]);
export type SymbolKind = z.infer<typeof zSymbolKind>;

export const zVisibility = z.enum(['public', 'protected', 'internal', 'private']);
export type Visibility = z.infer<typeof zVisibility>;

/**
 * How much the analyser actually knew. §5 "Graceful degradation" — never let the assistant
 * present shallow output with the same confidence as semantic output, so this rides all the
 * way through to the chat response and the MCP payload.
 */
export const zAnalysisDepth = z.enum(['shallow', 'semantic', 'artifact']);
export type AnalysisDepth = z.infer<typeof zAnalysisDepth>;

/** §10 Layer 3. `restricted` is never embedded — the safest chunk is one never vectorised. */
export const zSensitivity = z.enum(['public', 'internal', 'confidential', 'restricted']);
export type Sensitivity = z.infer<typeof zSensitivity>;

export const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export const zEcosystem = z.enum(['npm', 'nuget', 'pypi', 'go', 'maven', 'none']);
export type Ecosystem = z.infer<typeof zEcosystem>;

export const zSourceRef = z.object({
  path: z.string().min(1).describe('Repo-relative, forward slashes'),
  startLine: z.number().int().nonnegative(),
  endLine: z.number().int().nonnegative(),
  startColumn: z.number().int().nonnegative().optional(),
  endColumn: z.number().int().nonnegative().optional(),
  commitSha: z.string().regex(/^[0-9a-f]{7,40}$/),
});
export type SourceRef = z.infer<typeof zSourceRef>;

export const zDocComment = z.object({
  /** Raw text as written, comment markers stripped. */
  summary: z.string(),
  description: z.string().nullable().default(null),
  params: z
    .array(z.object({ name: z.string(), type: z.string().nullable(), description: z.string() }))
    .default([]),
  returns: z
    .object({ type: z.string().nullable(), description: z.string() })
    .nullable()
    .default(null),
  throws: z.array(z.object({ type: z.string(), description: z.string() })).default([]),
  examples: z.array(z.string()).default([]),
  seeAlso: z.array(z.string()).default([]),
  tags: z.record(z.string(), z.string()).default({}),
  /** Which docstring dialect it was parsed from — useful when prose generation reads it. */
  format: z
    .enum(['jsdoc', 'tsdoc', 'xmldoc', 'google', 'numpy', 'sphinx', 'plain'])
    .default('plain'),
});
export type DocComment = z.infer<typeof zDocComment>;

export const zDeprecation = z.object({
  since: z.string().nullable().default(null),
  reason: z.string().default(''),
  replacement: z.string().nullable().default(null),
});
export type Deprecation = z.infer<typeof zDeprecation>;

export const zTypeRef = z.object({
  /** As rendered in the source language, e.g. `Promise<Invoice[]>` or `List[Invoice]`. */
  text: z.string(),
  /** Resolved symbol id when the analyser could resolve it (Tier 1 only). */
  symbolId: z.string().nullable().default(null),
  /** Where the type came from when it is not local, e.g. `@acme/billing-client`. */
  package: z.string().nullable().default(null),
  nullable: z.boolean().default(false),
  isArray: z.boolean().default(false),
  typeArguments: z.array(z.string()).default([]),
});
export type TypeRef = z.infer<typeof zTypeRef>;

export const zParameter = z.object({
  name: z.string(),
  type: zTypeRef.nullable().default(null),
  optional: z.boolean().default(false),
  defaultValue: z.string().nullable().default(null),
  rest: z.boolean().default(false),
  description: z.string().nullable().default(null),
});
export type Parameter = z.infer<typeof zParameter>;
