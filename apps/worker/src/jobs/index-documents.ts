import { sql } from 'drizzle-orm';
import { withSystemContext, type Db } from '@kna/db';
import { sha256Short, type IrBundlePayload, type KnowledgeDocument } from '@kna/ir';
import { chunkDocument } from '@kna/documents';
import { computeConfigVersion } from '@kna/retrieval';
import type { WorkerContext } from '../context.js';
import { embedChunks } from './index-module.js';
import { resolveProjectIds } from './project-scope.js';

export interface IndexDocumentsInput {
  orgId: string;
  repoId: string;
  commitSha: string;
  ref: string;
  bundleStorageKey: string;
}

export interface IndexDocumentsResult {
  documentsUpserted: number;
  documentsDeleted: number;
  chunksUpserted: number;
  embeddingsComputed: number;
  embeddingsFromCache: number;
  estimatedUsd: number;
}

/** Index existing documentation independently from source-code module indexing. */
export async function indexDocuments(
  ctx: WorkerContext,
  input: IndexDocumentsInput,
): Promise<IndexDocumentsResult> {
  const payload: IrBundlePayload = await ctx.bundleStore.getPayload(input.bundleStorageKey);
  const versionId = await resolveVersionId(ctx, input, payload);

  const documents = payload.documents.filter((document) => document.repoIds.includes(input.repoId));
  const retrievalConfigVersion = computeConfigVersion(ctx.retrievalConfig).version;
  const chunkRows = documents
    .filter((document) => document.sensitivity !== 'restricted')
    .flatMap((document) => chunkDocument(document).map((chunk) => ({ document, chunk })));
  const embedded = await embedChunks(
    ctx,
    input.orgId,
    chunkRows.map((entry) => ({
      id: entry.chunk.id,
      content: entry.chunk.content,
      contentHash: entry.chunk.contentHash,
      sensitivity: entry.document.sensitivity,
    })),
  );

  const result = await withSystemContext(ctx.db, input.orgId, 'indexing', async (tx) => {
    let upserted = 0;
    let deleted = 0;
    const seen = new Set<string>();

    for (const document of documents) {
      seen.add(document.id);
      const sourceId = sourceRecordId(input.orgId, document);
      const projectIds = await resolveProjectIds(ctx, input.orgId, document.projectIds);
      await tx.execute(sql`
        INSERT INTO document_sources (id, org_id, source_type, instance_id, config, status, last_synced_at, updated_at)
        VALUES (${sourceId}, ${input.orgId}, ${document.source.type}, ${document.source.instanceId},
                ${JSON.stringify({ repoIds: document.repoIds })}::jsonb, 'active', now(), now())
        ON CONFLICT (org_id, source_type, instance_id) DO UPDATE SET
          status = 'active', last_synced_at = now(), updated_at = now()
      `);

      await tx.execute(sql`
        INSERT INTO documents (
          id, org_id, project_id, repo_id, module_id, version_id, slug, title, doc_type,
          repo_path, source_id, source_type, source_instance_id, external_id, source_revision,
          canonical_url, audience, authority, access_policy, source_metadata, source_updated_at,
          content, content_hash, visibility, sensitivity, status, updated_at, deleted_at
        ) VALUES (
          ${document.id}, ${input.orgId}, ${projectIds[0] ?? null}, ${document.repoIds[0] ?? input.repoId},
          ${document.moduleIds[0] ?? null}, ${versionId}, ${slugFor(document)}, ${document.title},
          ${document.documentType}, ${document.sourcePath}, ${sourceId}, ${document.source.type},
          ${document.source.instanceId}, ${document.source.externalId}, ${document.source.revision},
          ${document.source.canonicalUrl}, ${document.audience}, ${document.authority},
          ${JSON.stringify(document.access)}::jsonb, ${JSON.stringify(document.metadata)}::jsonb,
          ${document.updatedAt}, ${document.content}, ${document.contentHash},
          ${document.sensitivity === 'public' ? 'public' : 'internal'}, ${document.sensitivity},
          'published', now(), null
        ) ON CONFLICT (id) DO UPDATE SET
          project_id = EXCLUDED.project_id, repo_id = EXCLUDED.repo_id, module_id = EXCLUDED.module_id,
          version_id = EXCLUDED.version_id, slug = EXCLUDED.slug, title = EXCLUDED.title,
          doc_type = EXCLUDED.doc_type, repo_path = EXCLUDED.repo_path, source_id = EXCLUDED.source_id,
          source_type = EXCLUDED.source_type, source_instance_id = EXCLUDED.source_instance_id,
          external_id = EXCLUDED.external_id, source_revision = EXCLUDED.source_revision,
          canonical_url = EXCLUDED.canonical_url, audience = EXCLUDED.audience,
          authority = EXCLUDED.authority, access_policy = EXCLUDED.access_policy,
          source_metadata = EXCLUDED.source_metadata, source_updated_at = EXCLUDED.source_updated_at,
          content = EXCLUDED.content, content_hash = EXCLUDED.content_hash,
          visibility = EXCLUDED.visibility, sensitivity = EXCLUDED.sensitivity,
          status = 'published', updated_at = now(), deleted_at = null
      `);

      await tx.execute(
        sql`DELETE FROM document_associations WHERE org_id = ${input.orgId} AND document_id = ${document.id}`,
      );
      await writeAssociations(tx, input.orgId, document, projectIds);

      const priorChunks = await tx.execute<{ id: string }>(sql`
        SELECT id FROM chunks WHERE org_id = ${input.orgId} AND document_id = ${document.id}
      `);
      for (const prior of priorChunks)
        await tx.execute(
          sql`DELETE FROM embeddings WHERE org_id = ${input.orgId} AND chunk_id = ${prior.id}`,
        );
      await tx.execute(
        sql`DELETE FROM chunks WHERE org_id = ${input.orgId} AND document_id = ${document.id}`,
      );
      upserted += 1;
    }

    const existing = await tx.execute<{ id: string }>(sql`
      SELECT id FROM documents
       WHERE org_id = ${input.orgId} AND source_type = 'repo-markdown'
         AND source_instance_id = ${input.repoId} AND deleted_at IS NULL
    `);
    for (const row of existing) {
      if (seen.has(row.id)) continue;
      const priorChunks = await tx.execute<{ id: string }>(
        sql`SELECT id FROM chunks WHERE org_id = ${input.orgId} AND document_id = ${row.id}`,
      );
      for (const prior of priorChunks)
        await tx.execute(
          sql`DELETE FROM embeddings WHERE org_id = ${input.orgId} AND chunk_id = ${prior.id}`,
        );
      await tx.execute(
        sql`DELETE FROM chunks WHERE org_id = ${input.orgId} AND document_id = ${row.id}`,
      );
      await tx.execute(
        sql`UPDATE documents SET status = 'deleted', deleted_at = now(), updated_at = now() WHERE org_id = ${input.orgId} AND id = ${row.id}`,
      );
      deleted += 1;
    }
    return { upserted, deleted };
  });

  await withSystemContext(ctx.db, input.orgId, 'indexing', async (tx) => {
    for (const { document, chunk } of chunkRows) {
      const projectIds = await resolveProjectIds(ctx, input.orgId, document.projectIds);
      const moduleId = document.moduleIds[0] ?? null;
      await tx.execute(sql`
        INSERT INTO chunks (
          id, org_id, repo_id, module_id, project_ids, version_id, symbol_id, document_id,
          ordinal, corpus, content, context_header, content_hash, token_count,
          is_cluster_representative, generated, sensitivity, analysis_depth, source_path,
          source_url, source_start_line, source_end_line, indexed_commit_sha,
          retrieval_config_version
        ) VALUES (
          ${chunk.id}, ${input.orgId}, ${document.repoIds[0] ?? input.repoId}, ${moduleId},
          ${JSON.stringify(projectIds)}::jsonb, ${versionId}, ${null}, ${document.id},
          ${chunk.ordinal}, 'docs', ${chunk.content}, ${null}, ${chunk.contentHash},
          ${chunk.tokenCount}, true, false, ${document.sensitivity}, 'artifact',
          ${document.sourcePath}, ${document.source.canonicalUrl}, ${chunk.sourceStartLine},
          ${chunk.sourceEndLine}, ${input.commitSha}, ${retrievalConfigVersion}
        )
      `);
      const vector = embedded.vectors.get(chunk.id);
      if (vector)
        await tx.execute(sql`
        INSERT INTO embeddings (chunk_id, org_id, module_id, version_id, corpus, model, dimensions, embedding)
        VALUES (${chunk.id}, ${input.orgId}, ${moduleId}, ${versionId}, 'docs',
                ${ctx.retrievalConfig.embeddingModel}, ${ctx.retrievalConfig.embeddingDimensions},
                ${`[${vector.join(',')}]`}::halfvec)
        ON CONFLICT (chunk_id, model) DO UPDATE SET embedding = EXCLUDED.embedding
      `);
    }
  });

  return {
    documentsUpserted: result.upserted,
    documentsDeleted: result.deleted,
    chunksUpserted: chunkRows.length,
    embeddingsComputed: embedded.computed,
    embeddingsFromCache: embedded.fromCache,
    estimatedUsd: embedded.usd,
  };
}

async function resolveVersionId(
  ctx: WorkerContext,
  input: IndexDocumentsInput,
  payload: IrBundlePayload,
): Promise<string> {
  const versionId = `ver_${input.repoId.slice(5, 21)}_${input.ref.replace(/[^\w.-]/g, '-')}`;
  await withSystemContext(ctx.db, input.orgId, 'indexing', (tx) =>
    tx.execute(sql`
    INSERT INTO versions (id, org_id, repo_id, ref, kind, commit_sha, committed_at, is_default)
    VALUES (${versionId}, ${input.orgId}, ${input.repoId}, ${input.ref}, ${payload.version.kind},
            ${input.commitSha}, ${payload.version.committedAt}, ${payload.version.kind === 'branch'})
    ON CONFLICT (id) DO UPDATE SET commit_sha = EXCLUDED.commit_sha,
      committed_at = EXCLUDED.committed_at, is_default = EXCLUDED.is_default
  `),
  );
  return versionId;
}

function sourceRecordId(orgId: string, document: KnowledgeDocument): string {
  return `dsrc_${sha256Short(`${orgId}\n${document.source.type}\n${document.source.instanceId}`)}`;
}

function slugFor(document: KnowledgeDocument): string {
  return `${document.source.type}/${document.source.externalId}`
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .toLowerCase();
}

async function writeAssociations(
  tx: Db,
  orgId: string,
  document: KnowledgeDocument,
  projectIds: string[],
): Promise<void> {
  const rows = [
    ...document.repoIds.map((repoId) => ({
      repoId,
      projectId: null,
      moduleId: null,
      symbolId: null,
      type: 'connector-config',
    })),
    ...projectIds.map((projectId) => ({
      repoId: null,
      projectId,
      moduleId: null,
      symbolId: null,
      type: 'connector-config',
    })),
    ...document.moduleIds.map((moduleId) => ({
      repoId: null,
      projectId: null,
      moduleId,
      symbolId: null,
      type: 'path-reference',
    })),
    ...document.symbolIds.map((symbolId) => ({
      repoId: null,
      projectId: null,
      moduleId: null,
      symbolId,
      type: 'symbol-reference',
    })),
  ];
  for (const row of rows) {
    const id = `das_${sha256Short(`${orgId}\n${document.id}\n${row.repoId ?? ''}\n${row.projectId ?? ''}\n${row.moduleId ?? ''}\n${row.symbolId ?? ''}\n${row.type}`)}`;
    await tx.execute(sql`
      INSERT INTO document_associations (
        id, org_id, document_id, repo_id, project_id, module_id, symbol_id,
        association_type, confidence, created_by
      ) VALUES (
        ${id}, ${orgId}, ${document.id}, ${row.repoId}, ${row.projectId}, ${row.moduleId},
        ${row.symbolId}, ${row.type}, 1, 'connector'
      )
    `);
  }
}
