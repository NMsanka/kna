import { sql } from 'drizzle-orm';
import { anyOf, withModuleLock, withSystemContext } from '@kna/db';
import { chunkSymbols, clusterChunks, generateBlurbs, type Chunk } from '@kna/chunking';
import { estimateIndexCost } from '@kna/llm';
import { computeConfigVersion } from '@kna/retrieval';
import type { IrBundlePayload, IrModule, IrSymbol } from '@kna/ir';
import type { WorkerContext } from '../context.js';
import { resolveProjectIds } from './project-scope.js';

/**
 * Index one module.
 *
 * §15.1 fix 3 — "make the module, not the repo, the unit of atomicity and concurrency... a
 * monorepo reindexed as one atomic repo-level swap is a multi-hour single-threaded transaction
 * that bloats the table, blocks every subsequent push, and leaves HNSW churn nobody can vacuum.
 * Partition chunk storage by module so reindexing is a partition swap."
 *
 * The sequence, and why each step is where it is:
 *
 *  1. Load the bundle from object storage — the system of record, not a reconstruction.
 *  2. Take the module advisory lock. §15.6: BullMQ cannot enforce per-key concurrency, so
 *     Postgres does, and a re-dispatched stalled job blocks here rather than interleaving.
 *  3. Admit against the budget *before* doing work. §15.3: budget exhaustion halfway through
 *     leaves a partially reindexed corpus, which is worse than never starting.
 *  4. Chunk, blurb, embed, upsert.
 *  5. Sweep chunks whose `indexed_commit_sha` does not match. §15.5: "serving deleted code as
 *     current is indistinguishable from confabulation to the user."
 */

export interface IndexModuleInput {
  orgId: string;
  repoId: string;
  moduleId: string;
  commitSha: string;
  ref: string;
  bundleStorageKey: string;
}

export interface IndexModuleResult {
  moduleId: string;
  chunksUpserted: number;
  chunksDeleted: number;
  embeddingsComputed: number;
  embeddingsFromCache: number;
  blurbsGenerated: number;
  estimatedUsd: number;
  skipped: boolean;
  skipReason: string | null;
}

export async function indexModule(
  ctx: WorkerContext,
  input: IndexModuleInput,
): Promise<IndexModuleResult> {
  const empty: IndexModuleResult = {
    moduleId: input.moduleId,
    chunksUpserted: 0,
    chunksDeleted: 0,
    embeddingsComputed: 0,
    embeddingsFromCache: 0,
    blurbsGenerated: 0,
    estimatedUsd: 0,
    skipped: false,
    skipReason: null,
  };

  // ── 1. Load from the system of record ────────────────────────────────────────────────────
  const payload: IrBundlePayload = await ctx.bundleStore.getPayload(input.bundleStorageKey);
  const module = payload.modules.find((m) => m.id === input.moduleId);
  if (!module) {
    return { ...empty, skipped: true, skipReason: 'module not present in bundle' };
  }

  const symbolsAsPublished = payload.symbols.filter((s) => s.moduleId === input.moduleId);
  const versionId = await resolveVersionId(ctx, input, payload);

  // Project membership arrives from the repo in the repo's own vocabulary — the slugs written in
  // its kna.config.yaml — because a repository cannot be expected to know the platform's internal
  // project ids, any more than it knows its own orgId (which the CLI likewise sends as a slug).
  // Resolving here, once, means everything downstream — module_projects, chunks.project_ids, and
  // therefore the ACL filter's project overlap — speaks in resolved ids.
  //
  // Left unresolved, this fails silently in the worst way: membership rows simply never match, so
  // every project-scoped query returns an empty result that is indistinguishable from "nothing
  // indexed yet". Unknown slugs are dropped rather than invented, so a typo narrows visibility
  // instead of granting it.
  const projectIds = await resolveProjectIds(ctx, input.orgId, module.projectIds);
  const scopedModule: IrModule = { ...module, projectIds };
  const symbols: IrSymbol[] = symbolsAsPublished.map((s) => ({ ...s, projectIds }));

  // ── 2. Serialise on the module ───────────────────────────────────────────────────────────
  return withModuleLock(ctx.db, input.moduleId, async () => {
    // ── 3. Budget admission ────────────────────────────────────────────────────────────────
    const cachedBlurbs = await loadCachedBlurbs(ctx, input.orgId, symbols);
    const blurbMissRate =
      symbols.length === 0 ? 0 : 1 - cachedBlurbs.size / Math.max(symbols.length, 1);

    const estimate = estimateIndexCost({
      symbolCount: symbols.length,
      blurbMissRate,
      embeddingCacheHitRate: 0.3,
    });

    const admission = await ctx.budget.admit(input.orgId, estimate.totalUsd);
    if (!admission.admitted) {
      // Pause rather than fail: §15.3 is explicit that a partially reindexed corpus is worse
      // than one that was never started.
      await ctx.queue.pause('index-module', admission.reason);
      ctx.logger.warn(
        { orgId: input.orgId, moduleId: input.moduleId, estimate: estimate.breakdown },
        'index deferred: budget ceiling',
      );
      return { ...empty, skipped: true, skipReason: admission.reason };
    }

    let actualUsd = 0;
    try {
      // ── 4a. Chunk on AST boundaries ──────────────────────────────────────────────────────
      const retrievalConfigVersion = computeConfigVersion(ctx.retrievalConfig).version;

      let chunks = chunkSymbols(symbols, {
        module: scopedModule,
        versionId,
        commitSha: input.commitSha,
        retrievalConfigVersion,
        blurbsBySignatureHash: cachedBlurbs,
        maxTokens: ctx.retrievalConfig.chunkMaxTokens,
        overlapTokens: ctx.retrievalConfig.chunkOverlapTokens,
      });

      // ── 4b. Context blurbs for the misses only ───────────────────────────────────────────
      const missing = symbols.filter((s) => !cachedBlurbs.has(s.signatureHash));
      let blurbsGenerated = 0;

      if (missing.length > 0) {
        const results = await generateBlurbs(
          missing.map((symbol) => ({ symbol, module })),
          {
            client: ctx.llm,
            orgId: input.orgId,
            repoId: input.repoId,
            cachedSignatureHashes: new Set(cachedBlurbs.keys()),
            concurrency: 8,
          },
        );

        blurbsGenerated = results.length;
        for (const result of results) cachedBlurbs.set(result.signatureHash, result.blurb);
        await persistBlurbs(ctx, input.orgId, results);

        // Re-chunk with the blurbs present. The context header is part of what gets embedded,
        // so embedding the pre-blurb text would waste the whole point of contextual retrieval.
        chunks = chunkSymbols(symbols, {
          module: scopedModule,
          versionId,
          commitSha: input.commitSha,
          retrievalConfigVersion,
          blurbsBySignatureHash: cachedBlurbs,
          maxTokens: ctx.retrievalConfig.chunkMaxTokens,
          overlapTokens: ctx.retrievalConfig.chunkOverlapTokens,
        });
      }

      // ── 4c. Near-duplicate clustering (§15.5) ────────────────────────────────────────────
      const clusters = clusterChunks(chunks, { threshold: ctx.retrievalConfig.dedupeThreshold });

      // ── 4d. Embed, using the content-hash cache ──────────────────────────────────────────
      const { vectors, fromCache, computed, usd } = await embedChunks(ctx, input.orgId, chunks);
      actualUsd += usd;

      // ── 4e. The partition swap ───────────────────────────────────────────────────────────
      const { upserted, deleted } = await swapModulePartition(ctx, {
        orgId: input.orgId,
        moduleId: input.moduleId,
        versionId,
        commitSha: input.commitSha,
        chunks,
        vectors,
        clusters,
        symbols,
        module: scopedModule,
      });

      ctx.metrics.symbolsIndexed.add(symbols.length, { module: input.moduleId });

      return {
        moduleId: input.moduleId,
        chunksUpserted: upserted,
        chunksDeleted: deleted,
        embeddingsComputed: computed,
        embeddingsFromCache: fromCache,
        blurbsGenerated,
        estimatedUsd: actualUsd,
        skipped: false,
        skipReason: null,
      };
    } finally {
      await ctx.budget.settle(input.orgId, admission.reservationId, actualUsd);
    }
  });
}

/**
 * The swap.
 *
 * Chunks and embeddings for the module are written, then anything whose `indexed_commit_sha`
 * does not match this commit is deleted — inside one transaction. That sweep is §15.5's
 * garbage-collection fix: "'symbol removed → delete chunks' never fires for file moves, module
 * renames, archived repos, or crashed partial jobs. Stamp `indexed_commit_sha` on every chunk
 * and sweep-delete non-matching chunks after each full index."
 *
 * Deleting by "not this commit" rather than by "these ids" is what makes it robust to a crashed
 * previous run: whatever that run left behind does not carry this commit's sha, so it goes.
 */
async function swapModulePartition(
  ctx: WorkerContext,
  input: {
    orgId: string;
    moduleId: string;
    versionId: string;
    commitSha: string;
    chunks: Chunk[];
    vectors: Map<string, number[]>;
    clusters: ReturnType<typeof clusterChunks>;
    symbols: IrSymbol[];
    module: IrModule;
  },
): Promise<{ upserted: number; deleted: number }> {
  return withSystemContext(ctx.db, input.orgId, 'indexing', async (tx) => {
    // The module row first, because everything below is a child of it.
    //
    // Nothing upstream creates it. Ingest verifies the envelope, stores the bundle and queues a
    // job per module; the bundle is the system of record and Postgres is a derived cache
    // (§15.1 fix 1), so the cache is populated by the job that rebuilds it — not by the request
    // that accepted the bundle. Writing it here also keeps §15.1 fix 3 honest: the module is the
    // unit of reindex atomicity, so its own row belongs inside its own partition swap, under the
    // same advisory lock, rather than in a repo-wide pre-pass that would serialise a monorepo.
    //
    // This was previously a bare `UPDATE modules` at the end of the swap, which matched zero
    // rows and reported success. The symbols insert below is what surfaced it, via a foreign key.
    await tx.execute(sql`
      INSERT INTO modules (
        id, org_id, repo_id, key, path, name, ecosystem, package_name, package_version,
        languages, visibility, sensitivity, analysis_depth, analysis_notes, owners,
        dependencies, symbol_count, file_count, indexed_commit_sha, indexed_at
      ) VALUES (
        ${input.module.id}, ${input.orgId}, ${input.module.repoId}, ${input.module.key},
        ${input.module.path}, ${input.module.name}, ${input.module.ecosystem},
        ${input.module.packageName}, ${input.module.packageVersion},
        ${JSON.stringify(input.module.languages)}::jsonb,
        ${input.module.visibility}, ${input.module.sensitivity}, ${input.module.analysisDepth},
        ${JSON.stringify(input.module.analysisNotes)}::jsonb,
        ${JSON.stringify(input.module.owners)}::jsonb,
        ${JSON.stringify(input.module.dependencies)}::jsonb,
        ${input.symbols.length}, ${input.module.fileCount}, ${input.commitSha}, now()
      )
      ON CONFLICT (id) DO UPDATE SET
        key = EXCLUDED.key,
        path = EXCLUDED.path,
        name = EXCLUDED.name,
        ecosystem = EXCLUDED.ecosystem,
        package_name = EXCLUDED.package_name,
        package_version = EXCLUDED.package_version,
        languages = EXCLUDED.languages,
        visibility = EXCLUDED.visibility,
        sensitivity = EXCLUDED.sensitivity,
        analysis_depth = EXCLUDED.analysis_depth,
        analysis_notes = EXCLUDED.analysis_notes,
        owners = EXCLUDED.owners,
        dependencies = EXCLUDED.dependencies,
        symbol_count = EXCLUDED.symbol_count,
        file_count = EXCLUDED.file_count,
        indexed_commit_sha = EXCLUDED.indexed_commit_sha,
        indexed_at = EXCLUDED.indexed_at
    `);

    // §4.3 — project membership is a property of the module, not the repo. Declared ids that do
    // not resolve to a project are skipped rather than failing the index: a typo in a repo's
    // config should narrow what the module is visible under, not stop it being indexed at all.
    await tx.execute(sql`
      INSERT INTO module_projects (module_id, project_id, org_id)
      SELECT ${input.module.id}, p.id, ${input.orgId}
        FROM projects p
       WHERE p.org_id = ${input.orgId} AND p.id = ${anyOf(input.module.projectIds)}
      ON CONFLICT (module_id, project_id) DO NOTHING
    `);
    await tx.execute(sql`
      DELETE FROM module_projects
       WHERE org_id = ${input.orgId}
         AND module_id = ${input.module.id}
         AND NOT (project_id = ${anyOf(input.module.projectIds)})
    `);

    // Symbols next: chunks reference them, and the graph-expansion query joins through them.
    for (const symbol of input.symbols) {
      await tx.execute(sql`
        INSERT INTO symbols (
          id, org_id, repo_id, module_id, version_id, qualified_name, name, kind, language,
          visibility, signature, signature_hash, doc_hash, body_hash, parameters, return_type,
          type_parameters, type_refs, doc_comment, deprecated, modifiers, decorators, edges,
          http_binding, parent_id, source_path, source_start_line, source_end_line, commit_sha,
          analysis_depth, sensitivity, generated, source_text, written_by_ir_version
        ) VALUES (
          ${symbol.id}, ${symbol.orgId}, ${symbol.repoId}, ${symbol.moduleId}, ${input.versionId},
          ${symbol.qualifiedName}, ${symbol.name}, ${symbol.kind}, ${symbol.language},
          ${symbol.visibility}, ${symbol.signature}, ${symbol.signatureHash}, ${symbol.docHash},
          ${symbol.bodyHash},
          ${JSON.stringify(symbol.parameters)}::jsonb,
          ${JSON.stringify(symbol.returnType)}::jsonb,
          ${JSON.stringify(symbol.typeParameters)}::jsonb,
          ${JSON.stringify(symbol.typeRefs)}::jsonb,
          ${JSON.stringify(symbol.docComment)}::jsonb,
          ${JSON.stringify(symbol.deprecated)}::jsonb,
          ${JSON.stringify(symbol.modifiers)}::jsonb,
          ${JSON.stringify(symbol.decorators)}::jsonb,
          ${JSON.stringify(symbol.edges)}::jsonb,
          ${JSON.stringify(symbol.httpBinding)}::jsonb,
          ${symbol.parentId}, ${symbol.sourceRef.path}, ${symbol.sourceRef.startLine},
          ${symbol.sourceRef.endLine}, ${symbol.sourceRef.commitSha},
          ${symbol.analysisDepth}, ${symbol.sensitivity}, ${symbol.generated},
          ${symbol.sourceText}, ${'1.0.0'}
        )
        ON CONFLICT (id) DO UPDATE SET
          signature = EXCLUDED.signature,
          signature_hash = EXCLUDED.signature_hash,
          doc_hash = EXCLUDED.doc_hash,
          body_hash = EXCLUDED.body_hash,
          parameters = EXCLUDED.parameters,
          return_type = EXCLUDED.return_type,
          doc_comment = EXCLUDED.doc_comment,
          deprecated = EXCLUDED.deprecated,
          edges = EXCLUDED.edges,
          http_binding = EXCLUDED.http_binding,
          source_path = EXCLUDED.source_path,
          source_start_line = EXCLUDED.source_start_line,
          source_end_line = EXCLUDED.source_end_line,
          commit_sha = EXCLUDED.commit_sha,
          analysis_depth = EXCLUDED.analysis_depth,
          sensitivity = EXCLUDED.sensitivity,
          version_id = EXCLUDED.version_id,
          indexed_at = now()
      `);

      // Rename redirects, so provenance links in published documents keep resolving (§15.1).
      for (const previousId of symbol.previousIds) {
        await tx.execute(sql`
          INSERT INTO symbol_aliases (org_id, previous_id, current_id, reason)
          VALUES (${symbol.orgId}, ${previousId}, ${symbol.id}, 'rename')
          ON CONFLICT (org_id, previous_id) DO UPDATE SET current_id = EXCLUDED.current_id
        `);
      }
    }

    let upserted = 0;
    for (const chunk of input.chunks) {
      const vector = input.vectors.get(chunk.id);
      const clusterId = input.clusters.assignments.get(chunk.id) ?? null;
      const isRepresentative = input.clusters.representatives.has(chunk.id);

      await tx.execute(sql`
        INSERT INTO chunks (
          id, org_id, repo_id, module_id, project_ids, version_id, symbol_id, ordinal, corpus,
          content, context_header, content_hash, token_count, simhash, duplicate_cluster_id,
          is_cluster_representative, generated, sensitivity, analysis_depth,
          source_path, source_start_line, source_end_line, indexed_commit_sha,
          retrieval_config_version
        ) VALUES (
          ${chunk.id}, ${chunk.orgId}, ${chunk.repoId}, ${chunk.moduleId},
          ${JSON.stringify(chunk.projectIds)}::jsonb, ${chunk.versionId}, ${chunk.symbolId},
          ${chunk.ordinal}, ${chunk.corpus}, ${chunk.content}, ${chunk.contextHeader},
          ${chunk.contentHash}, ${chunk.tokenCount}, ${null}, ${clusterId},
          ${isRepresentative}, ${chunk.generated}, ${chunk.sensitivity}, ${chunk.analysisDepth},
          ${chunk.sourcePath}, ${chunk.sourceStartLine}, ${chunk.sourceEndLine},
          ${input.commitSha}, ${chunk.retrievalConfigVersion}
        )
        ON CONFLICT (org_id, symbol_id, ordinal, version_id) DO UPDATE SET
          -- Project membership moves: a module is reassigned, a repo's config changes, or — as
          -- here — the ids themselves are resolved differently. Leaving it out of the update
          -- meant a reindex rebuilt the content and the vectors but kept whatever scope the
          -- chunk was first written with, which is the one column the ACL filter reads.
          project_ids = EXCLUDED.project_ids,
          generated = EXCLUDED.generated,
          retrieval_config_version = EXCLUDED.retrieval_config_version,
          content = EXCLUDED.content,
          context_header = EXCLUDED.context_header,
          content_hash = EXCLUDED.content_hash,
          token_count = EXCLUDED.token_count,
          duplicate_cluster_id = EXCLUDED.duplicate_cluster_id,
          is_cluster_representative = EXCLUDED.is_cluster_representative,
          sensitivity = EXCLUDED.sensitivity,
          analysis_depth = EXCLUDED.analysis_depth,
          source_start_line = EXCLUDED.source_start_line,
          source_end_line = EXCLUDED.source_end_line,
          indexed_commit_sha = EXCLUDED.indexed_commit_sha
      `);

      if (vector) {
        await tx.execute(sql`
          INSERT INTO embeddings (chunk_id, org_id, module_id, version_id, corpus, model, dimensions, embedding)
          VALUES (
            ${chunk.id}, ${chunk.orgId}, ${chunk.moduleId}, ${chunk.versionId}, ${chunk.corpus},
            ${ctx.retrievalConfig.embeddingModel}, ${ctx.retrievalConfig.embeddingDimensions},
            ${`[${vector.join(',')}]`}::halfvec
          )
          ON CONFLICT (chunk_id, model) DO UPDATE SET embedding = EXCLUDED.embedding
        `);
      }

      upserted++;
    }

    // The sweep — everything in this partition that this run did not just write.
    //
    // This used to delete by `indexed_commit_sha <> commitSha`, on the reasoning that anything
    // not stamped with this commit belongs to a previous index. That is true for the common case
    // and silently wrong for two others, both of which stamp the *same* commit:
    //
    //   * A deliberate reindex. `/v1/admin/reindex` replays a stored bundle at the commit it was
    //     built from — that is the point of it, and the reasons for asking are exactly the ones
    //     that change the output: a new embedding model, different chunk sizes, a fixed indexer
    //     bug. The stale chunks carry the matching sha, so they survived and the corpus ended up
    //     holding both versions.
    //   * A crashed run, retried at the same commit. The docstring above claims robustness here;
    //     it did not have it, for the same reason.
    //
    // Comparing against the ids this run produced covers all three cases and needs no reasoning
    // about which commit anything came from. It is also what "partition swap" should mean: after
    // it, the module's partition is exactly what this run built.
    const chunkIds = input.chunks.map((c) => c.id);
    const deletedRows = await tx.execute<{ count: string }>(sql`
      WITH removed AS (
        DELETE FROM chunks
        WHERE org_id = ${input.orgId}
          AND module_id = ${input.moduleId}
          AND version_id = ${input.versionId}
          AND NOT (id = ${anyOf(chunkIds)})
        RETURNING id
      ), removed_embeddings AS (
        DELETE FROM embeddings
        WHERE chunk_id IN (SELECT id FROM removed)
      )
      SELECT count(*)::text AS count FROM removed
    `);

    // Symbols were never swept at all, so a deleted function stayed queryable forever through
    // `get_symbol` and `find_usages` — §15.5's "serving deleted code as current is
    // indistinguishable from confabulation" applied to the symbol surface rather than the chunk
    // one. Runs after the chunk sweep, because chunks reference symbols.
    await tx.execute(sql`
      DELETE FROM symbols
      WHERE org_id = ${input.orgId}
        AND module_id = ${input.moduleId}
        AND version_id = ${input.versionId}
        AND NOT (id = ${anyOf(input.symbols.map((s) => s.id))})
    `);

    return { upserted, deleted: Number(deletedRows[0]?.count ?? 0) };
  });
}

/**
 * Embedding with the content-hash cache.
 *
 * §15.6 — "add a content-hash-keyed embedding cache: vendored code and shared libraries produce
 * large volumes of byte-identical chunks across an org, and deduplicating them is the cheapest
 * cost lever available."
 */
/**
 * Exported because documentation regeneration embeds too, and the content-hash cache is the
 * whole cost model (§11): a second implementation would quietly halve the hit rate.
 */
export interface EmbeddableChunk {
  id: string;
  content: string;
  contentHash: string;
  sensitivity: Chunk['sensitivity'];
}

export async function embedChunks(
  ctx: WorkerContext,
  orgId: string,
  chunks: EmbeddableChunk[],
): Promise<{ vectors: Map<string, number[]>; fromCache: number; computed: number; usd: number }> {
  const vectors = new Map<string, number[]>();
  const model = ctx.retrievalConfig.embeddingModel;

  const cached = await withSystemContext(ctx.db, orgId, 'indexing', async (tx) =>
    tx.execute<{ content_hash: string; embedding: string }>(sql`
      SELECT content_hash, embedding::text AS embedding
      FROM embedding_cache
      WHERE org_id = ${orgId} AND model = ${model}
        AND content_hash = ${anyOf(chunks.map((c) => c.contentHash))}
    `),
  );

  const cacheByHash = new Map(
    cached.map((row) => [row.content_hash, parseVector(row.embedding)] as const),
  );

  const toCompute: EmbeddableChunk[] = [];
  for (const chunk of chunks) {
    const hit = cacheByHash.get(chunk.contentHash);
    if (hit) vectors.set(chunk.id, hit);
    else toCompute.push(chunk);
  }

  let usd = 0;
  const BATCH = 96;
  for (let i = 0; i < toCompute.length; i += BATCH) {
    const batch = toCompute.slice(i, i + BATCH);
    const result = await ctx.llm.embed({
      orgId,
      texts: batch.map((c) => c.content),
      dimensions: ctx.retrievalConfig.embeddingDimensions,
      // The highest tier present in the batch governs the route (§10 provider posture).
      contentSensitivity: batch.reduce<Chunk['sensitivity']>(
        (highest, c) => (rank(c.sensitivity) > rank(highest) ? c.sensitivity : highest),
        'public',
      ),
    });

    usd += result.usage.estimatedUsd;

    for (const [index, chunk] of batch.entries()) {
      const vector = result.vectors[index];
      if (!vector) continue;
      vectors.set(chunk.id, vector);

      await withSystemContext(ctx.db, orgId, 'indexing', async (tx) => {
        await tx.execute(sql`
          INSERT INTO embedding_cache (content_hash, model, org_id, embedding, hits)
          VALUES (${chunk.contentHash}, ${model}, ${orgId}, ${`[${vector.join(',')}]`}::halfvec, 0)
          ON CONFLICT (org_id, content_hash, model) DO UPDATE SET hits = embedding_cache.hits + 1
        `);
      });
    }
  }

  return { vectors, fromCache: cacheByHash.size, computed: toCompute.length, usd };
}

async function loadCachedBlurbs(
  ctx: WorkerContext,
  orgId: string,
  symbols: IrSymbol[],
): Promise<Map<string, string>> {
  if (symbols.length === 0) return new Map();

  const rows = await withSystemContext(ctx.db, orgId, 'indexing', async (tx) =>
    tx.execute<{ signature_hash: string; blurb: string }>(sql`
      SELECT signature_hash, blurb FROM context_blurbs
      WHERE org_id = ${orgId}
        AND prompt_version = ${ctx.retrievalConfig.blurbPromptVersion}
        AND signature_hash = ${anyOf(symbols.map((s) => s.signatureHash))}
    `),
  );

  return new Map(rows.map((r) => [r.signature_hash, r.blurb]));
}

async function persistBlurbs(
  ctx: WorkerContext,
  orgId: string,
  results: Array<{
    signatureHash: string;
    moduleId: string;
    blurb: string;
    model: string;
    promptVersion: string;
  }>,
): Promise<void> {
  if (results.length === 0) return;

  await withSystemContext(ctx.db, orgId, 'indexing', async (tx) => {
    for (const result of results) {
      await tx.execute(sql`
        INSERT INTO context_blurbs (org_id, signature_hash, module_id, blurb, model, prompt_version)
        VALUES (${orgId}, ${result.signatureHash}, ${result.moduleId}, ${result.blurb},
                ${result.model}, ${result.promptVersion})
        ON CONFLICT (org_id, signature_hash, prompt_version) DO UPDATE SET blurb = EXCLUDED.blurb
      `);
    }
  });
}

async function resolveVersionId(
  ctx: WorkerContext,
  input: IndexModuleInput,
  payload: IrBundlePayload,
): Promise<string> {
  // Stable per `(repo, ref)`, deliberately: a ref is a moving pointer, and the stale-chunk
  // sweep is scoped to `(module, version)`. Minting a new version per commit would mean the
  // sweep never matched anything it wrote last time, so every commit would accumulate a fresh
  // full copy of the corpus instead of replacing one.
  const versionId = `ver_${input.repoId.slice(5, 21)}_${input.ref.replace(/[^\w.-]/g, '-')}`;

  await withSystemContext(ctx.db, input.orgId, 'indexing', async (tx) => {
    // The conflict target has to be the primary key. It used to name the
    // `(repo_id, ref, commit_sha)` index, which is a *different* constraint and does not fire
    // when only the sha changes — so the row went on to collide with `versions_pkey`, unhandled.
    // The effect was that the first publish of a ref succeeded and every later one failed: the
    // CLI still reported "N indexing job(s) queued", and every one of those jobs then died in
    // the worker on a duplicate key.
    await tx.execute(sql`
      INSERT INTO versions (id, org_id, repo_id, ref, kind, commit_sha, committed_at, is_default)
      VALUES (
        ${versionId}, ${input.orgId}, ${input.repoId}, ${input.ref}, ${payload.version.kind},
        ${input.commitSha}, ${payload.version.committedAt},
        ${payload.version.kind === 'branch'}
      )
      ON CONFLICT (id) DO UPDATE SET
        commit_sha = EXCLUDED.commit_sha,
        committed_at = EXCLUDED.committed_at,
        is_default = EXCLUDED.is_default
    `);
  });

  return versionId;
}

export function parseVector(text: string): number[] {
  return text
    .slice(1, -1)
    .split(',')
    .map((v) => Number(v));
}

function rank(sensitivity: Chunk['sensitivity']): number {
  return ['public', 'internal', 'confidential', 'restricted'].indexOf(sensitivity);
}
