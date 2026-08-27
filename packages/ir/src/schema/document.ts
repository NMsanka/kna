import { z } from 'zod';
import { zSensitivity } from './primitives.js';

/**
 * Connector-neutral documentation contract.
 *
 * A connector owns acquisition only. It converts its native object (a Markdown file, wiki
 * page, support article, or work item) into this shape; scanning, persistence, chunking,
 * embedding, ACL enforcement, and retrieval stay source-independent.
 */
export const zDocumentAudience = z.enum(['developer', 'internal-user', 'end-user', 'mixed']);
export type DocumentAudience = z.infer<typeof zDocumentAudience>;

export const zDocumentAuthority = z.enum(['canonical', 'supporting', 'historical']);
export type DocumentAuthority = z.infer<typeof zDocumentAuthority>;

export const zDocumentAccessPolicy = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inherit-repositories') }),
  z.object({ mode: z.literal('public') }),
  z.object({
    mode: z.literal('source'),
    principalIds: z.array(z.string()).default([]),
    groupIds: z.array(z.string()).default([]),
  }),
]);
export type DocumentAccessPolicy = z.infer<typeof zDocumentAccessPolicy>;

export const zDocumentSourceRef = z.object({
  /** Connector family, for example `repo-markdown`, `confluence`, or `freshdesk`. */
  type: z.string().min(1),
  /** One configured source instance, such as a repository id or Confluence site id. */
  instanceId: z.string().min(1),
  /** Stable native identity inside the source: repo path, page id, or article id. */
  externalId: z.string().min(1),
  /** Native revision/version. Connectors must change it when content or permissions change. */
  revision: z.string().min(1),
  canonicalUrl: z.string().url().nullable().default(null),
});
export type DocumentSourceRef = z.infer<typeof zDocumentSourceRef>;

export const zKnowledgeDocument = z.object({
  id: z.string().min(1),
  source: zDocumentSourceRef,
  title: z.string().min(1),
  content: z.string(),
  format: z.enum(['markdown', 'plain-text']),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),

  documentType: z.string().min(1),
  audience: zDocumentAudience.default('developer'),
  authority: zDocumentAuthority.default('supporting'),
  sensitivity: zSensitivity.default('internal'),
  access: zDocumentAccessPolicy.default({ mode: 'inherit-repositories' }),

  repoIds: z.array(z.string()).default([]),
  projectIds: z.array(z.string()).default([]),
  moduleIds: z.array(z.string()).default([]),
  symbolIds: z.array(z.string()).default([]),

  sourcePath: z.string().nullable().default(null),
  createdAt: z.string().datetime().nullable().default(null),
  updatedAt: z.string().datetime().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type KnowledgeDocument = z.infer<typeof zKnowledgeDocument>;
