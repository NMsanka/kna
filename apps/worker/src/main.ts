import { installGracefulShutdown } from '@kna/observability';
import { assertRlsEffective } from '@kna/db';
import { createWorkerContext, type WorkerContext } from './context.js';
import { QUEUE_NAMES } from './services/queue.js';
import { indexModule, type IndexModuleInput } from './jobs/index-module.js';
import { resolveCrossRepoEdges, type CrossRepoInput } from './jobs/cross-repo.js';
import { runNightlyMaintenance } from './jobs/maintenance.js';
import { regenerateDocs, type RegenerateDocsInput } from './jobs/regenerate-docs.js';
import { indexDocuments, type IndexDocumentsInput } from './jobs/index-documents.js';

/**
 * The worker process.
 *
 * §3.1 — chunk, contextualise, embed, upsert, cross-repo link. Plus the two jobs the reviews
 * added: nightly maintenance (§7 reconciliation, §15.5 invariants) and documentation
 * regeneration (§6, §7).
 *
 * Concurrency is set per queue rather than globally, because the jobs have very different
 * shapes. Indexing is provider-bound and benefits from parallelism; cross-repo resolution is
 * effectively single-threaded per project and running several at once only causes lock
 * contention (§15.6 "the real scaling wall").
 */

async function main(): Promise<void> {
  const ctx = await createWorkerContext();

  // Fatal by design (§15.4). The worker writes across every tenant's data; connecting as a role
  // that bypasses RLS removes the last containment layer under a bug in the scope filters.
  await assertRlsEffective(ctx.db);

  ctx.queue.register<IndexModuleInput>(
    QUEUE_NAMES.indexModule,
    async (job) => {
      const result = await indexModule(ctx, job.data);
      ctx.logger.info(
        {
          moduleId: result.moduleId,
          upserted: result.chunksUpserted,
          deleted: result.chunksDeleted,
          embeddingsComputed: result.embeddingsComputed,
          embeddingsFromCache: result.embeddingsFromCache,
          blurbs: result.blurbsGenerated,
          usd: result.estimatedUsd.toFixed(4),
        },
        result.skipped ? 'module index skipped' : 'module indexed',
      );
      return result;
    },
    { concurrency: 4, db: ctx.db },
  );

  ctx.queue.register<CrossRepoInput>(
    QUEUE_NAMES.crossRepo,
    async (job) => {
      const result = await resolveCrossRepoEdges(ctx, job.data);
      ctx.logger.info(result, 'cross-repo resolution complete');
      return result;
    },
    // Deliberately 1: the pass takes a per-project lock, so extra concurrency buys nothing
    // except contention.
    { concurrency: 1, db: ctx.db },
  );

  ctx.queue.register<IndexDocumentsInput>(
    QUEUE_NAMES.indexDocuments,
    async (job) => {
      const result = await indexDocuments(ctx, job.data);
      ctx.logger.info(result, 'existing documentation indexed');
      return result;
    },
    { concurrency: 2, db: ctx.db, lockDurationMs: 300_000 },
  );

  ctx.queue.register<RegenerateDocsInput>(
    QUEUE_NAMES.regenerateDocs,
    async (job) => {
      const result = await regenerateDocs(ctx, job.data);
      ctx.logger.info(
        {
          documents: result.documentsWritten,
          chunks: result.chunksUpserted,
          proseSections: result.proseSections,
          proseRejected: result.proseRejected,
          proseFailed: result.proseFailed,
          usd: result.estimatedUsd.toFixed(4),
        },
        result.skipped ? 'documentation regeneration skipped' : 'documentation regenerated',
      );
      return result;
    },
    // One at a time per worker: regeneration reads the whole bundle and rewrites a repo's
    // documentation corpus, so parallelism buys latency on a job nobody is waiting on while
    // competing with indexing for the same provider quota (§15.6).
    //
    // The long lock is the honest cost of doing a repo's modules in one job. Fanning out to one
    // job per module would bound it properly and is the answer at organisation scale; until
    // then, the lock is sized so a repo of a few hundred modules cannot be declared stalled
    // while it is still working.
    { concurrency: 1, db: ctx.db, lockDurationMs: 900_000 },
  );

  ctx.queue.register<{ orgId: string }>(
    QUEUE_NAMES.maintenance,
    async (job) => {
      const report = await runNightlyMaintenance(ctx, job.data.orgId);
      ctx.logger.info(
        {
          reconciled: report.reconciliation,
          invariantViolations: report.invariants.length,
          evalQuarantine: report.evalQuarantine,
        },
        'nightly maintenance complete',
      );
      return report;
    },
    { concurrency: 1, db: ctx.db },
  );

  installGracefulShutdown(
    [
      // Queues first: stop accepting new work and let in-flight indexing finish, so a rolling
      // deploy never orphans a half-written module partition.
      { name: 'queues', drain: () => ctx.queue.close() },
      { name: 'database', drain: () => ctx.shutdown() },
    ],
    { timeoutMs: 60_000, onLog: (message) => ctx.logger.info(message) },
  );

  ctx.logger.info(
    {
      env: ctx.env.KNA_ENV,
      region: ctx.env.KNA_REGION,
      embeddingModel: ctx.retrievalConfig.embeddingModel,
      dimensions: ctx.retrievalConfig.embeddingDimensions,
      writeEnabled: ctx.env.WRITE_ENABLED,
    },
    'kna-worker started',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});

export type { WorkerContext };
