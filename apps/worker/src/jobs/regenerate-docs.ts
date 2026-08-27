import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withSystemContext } from '@kna/db';
import { computeConfigVersion } from '@kna/retrieval';
import { estimateTokens, splitToBudget, type Chunk } from '@kna/chunking';
import {
  generateProse,
  renderArchitectureOverview,
  renderIntegrationGuide,
  renderModuleReference,
  renderRegion,
  serialiseFrontmatter,
  type RenderedDocument,
} from '@kna/docgen';
import type { IrBundlePayload, IrModule } from '@kna/ir';
import type { WorkerContext } from '../context.js';
import { embedChunks } from './index-module.js';
import { resolveProjectIds } from './project-scope.js';

/**
 * Regenerate documentation for a repository.
 *
 * §6 — deterministic first, LLM second. Everything a reader can check against the code is
 * rendered from the IR; the model is asked only for the connective prose, and anything it says
 * that the facts do not entail is dropped rather than published.
 *
 * This job is the platform-side half of `kna generate`. The CLI writes Markdown into the
 * developer's working tree, which is what §15.8's exit plan requires — "keep nothing that lives
 * only in the platform's database". This writes the *queryable* copy: rows in `documents`, and
 * chunks in the `docs` corpus so `search_docs` can answer from prose written for the purpose
 * rather than from a function body that happens to mention the right words.
 *
 * Both halves are needed and neither is redundant. Deleting the repo copy would strand the
 * customer if the platform went away; deleting this copy would mean the documentation the
 * platform generates is invisible to the platform's own retrieval.
 *
 * Nothing consumed this queue before. The API enqueued a job on every doc-affecting ingest and
 * the worker registered handlers for three of the four queues, so the jobs accumulated in Redis
 * indefinitely, `documents` stayed empty, and `search_docs` answered "no documentation matched"
 * for every question — a total feature outage that no test, health check or dashboard reported,
 * because every individual component was working exactly as written.
 */

export interface RegenerateDocsInput {
  orgId: string;
  repoId: string;
  commitSha: string;
  ref: string;
  bundleStorageKey: string;
}

export interface RegenerateDocsResult {
  documentsWritten: number;
  chunksUpserted: number;
  proseSections: number;
  /** Prose the model produced that the grounding check refused. A quality signal. */
  proseRejected: number;
  /** Prose that never happened: provider error, timeout, budget. An availability signal. */
  proseFailed: number;
  estimatedUsd: number;
  skipped: boolean;
  skipReason: string | null;
}

/**
 * Document types this build produces.
 *
 * §6 lists six; three are implemented, and they are the three that can be rendered from the IR
 * without inventing anything. The repo's own `docs.types` selection is deliberately *not*
 * consulted here — it lives in the repository's config file and the IR bundle does not carry it,
 * so the platform cannot see it. The consequence is worth stating plainly rather than hiding:
 * a repo that narrowed `docs.types` still gets the full set in the platform's queryable copy,
 * while the files written into its working tree by `kna generate` honour the setting. Making the
 * platform honour it too means putting the selection in the bundle envelope, which is an IR
 * schema change and belongs with the next version bump.
 */
const SUPPORTED_DOC_TYPES = ['module-reference', 'architecture-overview', 'api-integration-guide'];

export async function regenerateDocs(
  ctx: WorkerContext,
  input: RegenerateDocsInput,
): Promise<RegenerateDocsResult> {
  const empty: RegenerateDocsResult = {
    documentsWritten: 0,
    chunksUpserted: 0,
    proseSections: 0,
    proseRejected: 0,
    proseFailed: 0,
    estimatedUsd: 0,
    skipped: false,
    skipReason: null,
  };

  const payload: IrBundlePayload = await ctx.bundleStore.getPayload(input.bundleStorageKey);

  const versionId = await resolveVersionId(ctx, input);
  if (!versionId) {
    // The indexing jobs for this bundle create the version row. If it is not there yet, this
    // job arrived first; failing is correct because BullMQ will retry, and writing documents
    // against a version that does not exist would violate the foreign key anyway.
    throw new Error(
      `No version row for ${input.repoId} at ${input.commitSha}. Indexing has not run yet; this job will retry.`,
    );
  }

  const symbolsByModule = new Map<string, IrBundlePayload['symbols']>();
  for (const symbol of payload.symbols) {
    const list = symbolsByModule.get(symbol.moduleId) ?? [];
    list.push(symbol);
    symbolsByModule.set(symbol.moduleId, list);
  }

  // Resolved once for the whole repo. Every module in a bundle carries the same declared
  // project list — it comes from the repo's config — so this is one lookup, not one per module.
  const projectIds = await resolveProjectIds(
    ctx,
    input.orgId,
    payload.modules[0]?.projectIds ?? [],
  );

  const modulesById = new Map(payload.modules.map((m) => [m.id, m] as const));
  const sourceUrlTemplate = sourceUrlTemplateFor(payload);

  // ── Deterministic rendering ─────────────────────────────────────────────────────────────
  const rendered: Array<{ document: RenderedDocument; module: IrModule | null }> = [];

  for (const module of payload.modules) {
    const symbols = symbolsByModule.get(module.id) ?? [];
    if (symbols.length === 0) continue;
    rendered.push({
      module,
      document: renderModuleReference({
        module,
        symbols,
        // The exact commit, because this copy is the platform's record of what was
        // indexed and is only worth anything if it is exact.
        revision: input.commitSha,
        ...(sourceUrlTemplate ? { sourceUrlTemplate } : {}),
      }),
    });
  }

  rendered.push({
    module: null,
    document: renderArchitectureOverview({
      payload,
      revision: input.commitSha,
      ...(sourceUrlTemplate ? { sourceUrlTemplate } : {}),
    }),
  });

  for (const spec of payload.apiSpecs) {
    rendered.push({
      module: modulesById.get(spec.moduleId) ?? null,
      document: renderIntegrationGuide({ spec, symbols: payload.symbols }),
    });
  }

  if (rendered.length === 0) {
    return { ...empty, skipped: true, skipReason: 'bundle contained no documentable modules' };
  }

  // ── Prose, second and optional ──────────────────────────────────────────────────────────
  //
  // §6 rule: the deterministic sections are complete without this. If the provider is down, or
  // the budget is spent, the documentation is still correct — it is merely drier. That is the
  // reason prose runs after rendering rather than being interleaved with it.
  let proseSections = 0;
  let proseRejected = 0;
  // Counted separately from rejections on purpose. "The model said something the facts do not
  // support" and "the model was unreachable" both end with a document that has no prose, and
  // conflating them means a misconfigured model route reads as a content-quality problem. The
  // first time this ran, every one of 21 modules reported a grounding rejection and the actual
  // cause was a model name the API key had no access to.
  let proseFailed = 0;
  let estimatedUsd = 0;

  const admission = await ctx.budget.admit(input.orgId, estimateProseCost(rendered.length));
  if (!admission.admitted) {
    ctx.logger.warn(
      { orgId: input.orgId, repoId: input.repoId, reason: admission.reason },
      'documentation prose skipped: budget ceiling; deterministic sections still published',
    );
  } else {
    for (const entry of rendered) {
      if (!entry.module) continue;
      const symbols = symbolsByModule.get(entry.module.id) ?? [];
      if (symbols.length === 0) continue;

      try {
        const prose = await generateProse(
          { module: entry.module, symbols, section: 'module-overview' },
          { client: ctx.llm, orgId: input.orgId, repoId: input.repoId, verify: true },
        );

        // §6: the grounding check is not advisory. Ungrounded prose is dropped, and the
        // document ships without it rather than shipping a claim nothing supports.
        if (prose.text && prose.grounded) {
          entry.document.sections.set('overview-prose', prose.text);
          proseSections += 1;
        } else if (prose.text) {
          proseRejected += 1;
          ctx.logger.warn(
            {
              moduleId: entry.module.id,
              ungroundedClaims: prose.ungroundedClaims.slice(0, 3),
            },
            'prose rejected by grounding check',
          );
        }
      } catch (error) {
        // One module's prose failing must not cost the whole repository its documentation.
        proseFailed += 1;
        ctx.logger.warn(
          {
            moduleId: entry.module.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'prose generation failed; publishing deterministic sections only',
        );
      }
    }
  }

  // ── Persist ─────────────────────────────────────────────────────────────────────────────
  const retrievalConfigVersion = computeConfigVersion(ctx.retrievalConfig).version;
  const docChunks: Chunk[] = [];

  for (const entry of rendered) {
    const content = assemble(entry.document);
    const contentHash = createHash('sha256').update(content).digest('hex');
    const repoPath = `docs/generated/${entry.document.slug}.md`;

    await withSystemContext(ctx.db, input.orgId, 'indexing', async (tx) => {
      await tx.execute(sql`
        INSERT INTO documents (
          id, org_id, repo_id, module_id, version_id, slug, title, doc_type, repo_path,
          provenance_symbol_ids, provenance_signature_hashes, content, content_hash,
          visibility, sensitivity, owner_team, generated_by_model, generated_by_provider,
          generated_in_region, generated_at, status, staleness_score
        ) VALUES (
          ${`doc_${createHash('sha256').update(`${input.orgId}\n${entry.document.slug}\n${versionId}`).digest('hex').slice(0, 32)}`},
          ${input.orgId}, ${input.repoId}, ${entry.module?.id ?? null}, ${versionId},
          ${entry.document.slug}, ${entry.document.title}, ${entry.document.docType}, ${repoPath},
          ${JSON.stringify(entry.document.provenanceSymbolIds)}::jsonb,
          ${JSON.stringify(entry.document.provenanceSignatureHashes)}::jsonb,
          ${content}, ${contentHash},
          ${entry.module?.visibility ?? 'internal'},
          ${entry.module?.sensitivity ?? 'internal'},
          ${entry.module?.owners[0] ?? null},
          ${ctx.retrievalConfig.embeddingModel}, 'litellm', ${ctx.env.KNA_REGION}, now(),
          -- Generated documentation is a draft until a human has looked at it (§6 rule 3).
          -- Publishing straight to 'current' would make the platform the author of record.
          'draft', 0
        )
        ON CONFLICT (org_id, slug, version_id) DO UPDATE SET
          title = EXCLUDED.title,
          doc_type = EXCLUDED.doc_type,
          repo_path = EXCLUDED.repo_path,
          provenance_symbol_ids = EXCLUDED.provenance_symbol_ids,
          provenance_signature_hashes = EXCLUDED.provenance_signature_hashes,
          content = EXCLUDED.content,
          content_hash = EXCLUDED.content_hash,
          sensitivity = EXCLUDED.sensitivity,
          generated_by_model = EXCLUDED.generated_by_model,
          generated_at = EXCLUDED.generated_at,
          staleness_score = 0,
          updated_at = now()
      `);
    });

    // §10 Layer 3 — a document inherits the tier of what it describes, and `restricted` never
    // enters the embedding pipeline. Excluding it here rather than filtering at query time is
    // the difference between "not returned" and "never vectorised".
    const sensitivity = entry.module?.sensitivity ?? 'internal';
    if (sensitivity === 'restricted') continue;

    // A document is not a retrieval unit. A module reference for a large module runs to many
    // thousands of tokens — past the embedding provider's hard 8,192-token limit, and far past
    // the point where one vector still means anything specific. Split on the same budget the
    // code corpus uses, so a question about one section retrieves that section rather than the
    // whole file.
    const pieces = splitToBudget(content, ctx.retrievalConfig.chunkMaxTokens, 0);

    pieces.forEach((piece, ordinal) => {
      const pieceHash = createHash('sha256').update(piece).digest('hex');
      docChunks.push({
        id: `chk_${createHash('sha256').update(`${entry.document.slug}\n${versionId}\n${ordinal}\n${pieceHash}`).digest('hex').slice(0, 40)}`,
        orgId: input.orgId,
        repoId: input.repoId,
        // Architecture and integration guides describe the repo rather than one module. They are
        // attributed to a module anyway, because `chunks.module_id` is not nullable and the ACL
        // filter scopes through it — an unattributed chunk would be unreachable, not unrestricted.
        moduleId: entry.module?.id ?? payload.modules[0]?.id ?? '',
        projectIds,
        versionId,
        symbolId: '',
        ordinal,
        corpus: 'docs',
        // Every piece names the document it came from. Without it a middle section retrieved on
        // its own is a paragraph with no subject.
        content:
          pieces.length === 1
            ? piece
            : `// Document: ${entry.document.title} (part ${ordinal + 1} of ${pieces.length})\n\n${piece}`,
        contextHeader: null,
        contentHash: pieceHash,
        tokenCount: estimateTokens(piece),
        sensitivity,
        analysisDepth: entry.module?.analysisDepth ?? 'shallow',
        sourcePath: repoPath,
        sourceStartLine: null,
        sourceEndLine: null,
        generated: true,
        indexedCommitSha: input.commitSha,
        retrievalConfigVersion,
      });
    });
  }

  if (docChunks.length === 0) {
    return {
      ...empty,
      documentsWritten: rendered.length,
      proseSections,
      proseRejected,
      proseFailed,
    };
  }

  const { vectors, usd } = await embedChunks(ctx, input.orgId, docChunks);
  estimatedUsd += usd;

  const upserted = await withSystemContext(ctx.db, input.orgId, 'indexing', async (tx) => {
    // Replace rather than upsert. `chunks_identity_idx` is unique on
    // `(org_id, symbol_id, ordinal, version_id)`, and a documentation chunk has no symbol —
    // Postgres treats every NULL as distinct, so `ON CONFLICT` would never fire and each
    // regeneration would append another copy of the whole corpus. Scoped by `source_path`, so
    // one document's chunks are replaced without touching another's.
    for (const sourcePath of new Set(docChunks.map((c) => c.sourcePath))) {
      await tx.execute(sql`
        DELETE FROM chunks
         WHERE org_id = ${input.orgId}
           AND version_id = ${versionId}
           AND corpus = 'docs'
           AND source_path = ${sourcePath}
      `);
    }

    let count = 0;
    for (const chunk of docChunks) {
      await tx.execute(sql`
        INSERT INTO chunks (
          id, org_id, repo_id, module_id, project_ids, version_id, symbol_id, ordinal, corpus,
          content, context_header, content_hash, token_count, is_cluster_representative,
          generated, sensitivity, analysis_depth, source_path, indexed_commit_sha,
          retrieval_config_version
        ) VALUES (
          ${chunk.id}, ${chunk.orgId}, ${chunk.repoId}, ${chunk.moduleId},
          ${JSON.stringify(chunk.projectIds)}::jsonb, ${chunk.versionId}, ${null},
          ${chunk.ordinal}, 'docs', ${chunk.content}, ${null}, ${chunk.contentHash},
          ${chunk.tokenCount}, true, true, ${chunk.sensitivity}, ${chunk.analysisDepth},
          ${chunk.sourcePath}, ${chunk.indexedCommitSha}, ${chunk.retrievalConfigVersion}
        )
        ON CONFLICT (id) DO UPDATE SET
          content = EXCLUDED.content,
          content_hash = EXCLUDED.content_hash,
          project_ids = EXCLUDED.project_ids,
          token_count = EXCLUDED.token_count,
          indexed_commit_sha = EXCLUDED.indexed_commit_sha,
          retrieval_config_version = EXCLUDED.retrieval_config_version
      `);

      const vector = vectors.get(chunk.id);
      if (vector) {
        await tx.execute(sql`
          INSERT INTO embeddings (chunk_id, org_id, module_id, version_id, corpus, model, dimensions, embedding)
          VALUES (
            ${chunk.id}, ${chunk.orgId}, ${chunk.moduleId}, ${chunk.versionId}, 'docs',
            ${ctx.retrievalConfig.embeddingModel}, ${ctx.retrievalConfig.embeddingDimensions},
            ${`[${vector.join(',')}]`}::halfvec
          )
          ON CONFLICT (chunk_id, model) DO UPDATE SET embedding = EXCLUDED.embedding
        `);
      }
      count += 1;
    }
    return count;
  });

  return {
    documentsWritten: rendered.length,
    chunksUpserted: upserted,
    proseSections,
    proseRejected,
    proseFailed,
    estimatedUsd,
    skipped: false,
    skipReason: null,
  };
}

/** The document as it would be written to disk: frontmatter, title, then the marked regions. */
function assemble(document: RenderedDocument): string {
  const parts = [serialiseFrontmatter(document.frontmatter), '', `# ${document.title}`, ''];
  for (const [id, body] of document.sections) parts.push(renderRegion(id, body), '');
  return parts.join('\n');
}

/**
 * Read the version this bundle belongs to rather than creating it.
 *
 * Indexing owns that row: it is written per module under the module lock, and inventing a second
 * writer here would race it. Documentation is downstream of indexing by nature — the provenance
 * a document records is only meaningful once the symbols it cites exist.
 */
async function resolveVersionId(
  ctx: WorkerContext,
  input: RegenerateDocsInput,
): Promise<string | null> {
  const rows = await withSystemContext(ctx.db, input.orgId, 'indexing', async (tx) =>
    tx.execute<{ id: string }>(sql`
      SELECT id FROM versions
       WHERE org_id = ${input.orgId}
         AND repo_id = ${input.repoId}
         AND commit_sha = ${input.commitSha}
       ORDER BY created_at DESC
       LIMIT 1
    `),
  );
  return rows[0] ? String(rows[0].id) : null;
}

/**
 * A rough ceiling, not a quote. §15.3 wants admission to happen before the spend, and the cost
 * of being approximately right here is far lower than the cost of finding out mid-run.
 */
function estimateProseCost(documentCount: number): number {
  const perDocumentUsd = 0.01;
  return documentCount * perDocumentUsd;
}

function sourceUrlTemplateFor(payload: IrBundlePayload): string | undefined {
  const remote = payload.repo.remote;
  if (!remote) return undefined;
  if (remote.includes('github.com')) return `https://${remote}/blob/{sha}/{path}#L{line}`;
  if (remote.includes('gitlab')) return `https://${remote}/-/blob/{sha}/{path}#L{line}`;
  return undefined;
}

export { SUPPORTED_DOC_TYPES };
