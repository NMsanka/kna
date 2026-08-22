import { Worker, Queue, type Job, type Processor } from 'bullmq';
import IORedisModule, { type Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withSystemContext, type DbHandle } from '@kna/db';
import type { Logger } from '@kna/observability';

/** `ioredis` is CommonJS with an ESM-shaped default export; NodeNext needs the cast. */
const IORedis = IORedisModule as unknown as new (
  url: string,
  options?: { maxRetriesPerRequest?: number | null; enableReadyCheck?: boolean },
) => Redis;

export const QUEUE_NAMES = {
  indexModule: 'index-module',
  crossRepo: 'cross-repo-resolve',
  regenerateDocs: 'regenerate-docs',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

/**
 * The worker side of the queue.
 *
 * §15.6 requires four things stock BullMQ does not give you, and each is implemented here:
 *
 *  - **A real dead-letter queue.** "BullMQ's `failed` set is not a DLQ" — it has no operator
 *    drain, no replay, and no record of the payload once the retention window passes. Exhausted
 *    jobs are written to `dead_letters` with a pointer to their payload.
 *  - **Backpressure that pauses.** A 429 pauses every queue for the provider's retry window
 *    rather than burning retries against a saturated quota.
 *  - **Per-org fairness.** BullMQ is FIFO, so one tenant onboarding a monolith starves the
 *    rest. In-flight jobs per org are capped.
 *  - **Graceful drain.** A rolling deploy must let in-flight indexing finish rather than
 *    orphaning a half-written module partition.
 */
/**
 * Build a BullMQ job id.
 *
 * BullMQ rejects a custom id containing `:` — it is the Redis key separator, and the failure is
 * a 500 at enqueue time rather than anything the type system can catch. The ids here are
 * deliberately deterministic, because that is what makes a replayed webhook a no-op at the
 * queue instead of something the worker has to detect (§7 idempotency).
 */
function jobId(...parts: string[]): string {
  return parts.join('-').replace(/:/g, '-');
}

export class WorkerQueue {
  private readonly connection: Redis;
  private readonly workers = new Map<QueueName, Worker>();
  private readonly queues = new Map<QueueName, Queue>();
  private readonly inFlightByOrg = new Map<string, number>();
  private pausedUntil = 0;

  constructor(
    redisUrl: string,
    private readonly logger: Logger,
    private readonly options: { maxInFlightPerOrg?: number } = {},
  ) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: true });
  }

  private queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /**
   * Register a processor.
   *
   * `concurrency` is per worker process, and horizontal scaling multiplies it — which is fine
   * for throughput because serialisation is enforced by the per-module advisory lock rather
   * than by the queue (§15.6).
   */
  register<T>(
    name: QueueName,
    processor: (job: Job<T>) => Promise<unknown>,
    options: { concurrency?: number; db?: DbHandle; lockDurationMs?: number } = {},
  ): void {
    const wrapped: Processor<T> = async (job) => {
      // Provider backpressure. Throwing here returns the job to the queue with its backoff
      // rather than consuming an attempt on a call that would certainly 429.
      if (Date.now() < this.pausedUntil) {
        throw new Error('Queue is paused for provider backpressure; job returned to the queue.');
      }

      const orgId = (job.data as { orgId?: string }).orgId;
      if (orgId) {
        const inFlight = this.inFlightByOrg.get(orgId) ?? 0;
        const cap = this.options.maxInFlightPerOrg ?? 8;
        if (inFlight >= cap) {
          // Fairness, not a failure: delay and let another tenant's work through.
          await job.moveToDelayed(Date.now() + 5_000, job.token);
          throw new Error(`Org ${orgId} is at its in-flight cap; deferred for fairness.`);
        }
        this.inFlightByOrg.set(orgId, inFlight + 1);
      }

      const started = Date.now();
      try {
        const result = await processor(job);
        this.logger.info(
          { queue: name, jobId: job.id, durationMs: Date.now() - started },
          'job complete',
        );
        return result;
      } finally {
        if (orgId) {
          this.inFlightByOrg.set(orgId, Math.max((this.inFlightByOrg.get(orgId) ?? 1) - 1, 0));
        }
      }
    };

    const worker = new Worker<T>(name, wrapped, {
      connection: this.connection,
      concurrency: options.concurrency ?? 4,
      // A stalled job is re-dispatched; the module advisory lock is what stops the re-dispatch
      // interleaving with the original run (§15.6).
      stalledInterval: 60_000,
      maxStalledCount: 2,
      // BullMQ's 30-second default assumes short jobs. It renews on a timer while the processor
      // runs, so the default is fine for indexing — but a job that is still holding the lock
      // when its process is replaced loses it, and one long enough to span a deploy will be
      // re-dispatched mid-flight. Documentation regeneration makes one model call per module in
      // sequence and runs for minutes; it asks for a lock that matches.
      lockDuration: options.lockDurationMs ?? 30_000,
    });

    worker.on('failed', (job, error) => {
      if (!job) return;
      this.logger.error(
        { queue: name, jobId: job.id, attempts: job.attemptsMade, err: error.message },
        'job failed',
      );

      // Exhausted attempts go to the real DLQ, with the payload pointer preserved so an
      // operator can inspect and replay it.
      if (job.attemptsMade >= (job.opts.attempts ?? 5) && options.db) {
        void this.deadLetter(options.db, name, job, error);
      }
    });

    worker.on('error', (error) => {
      this.logger.error({ queue: name, err: error.message }, 'worker error');
    });

    this.workers.set(name, worker);
  }

  private async deadLetter(db: DbHandle, queue: QueueName, job: Job, error: Error): Promise<void> {
    const data = job.data as { orgId?: string; bundleStorageKey?: string };
    const orgId = data.orgId ?? 'system';

    try {
      await withSystemContext(db, orgId, 'maintenance', async (tx) => {
        await tx.execute(sql`
          INSERT INTO dead_letters (
            id, org_id, queue, job_name, payload_ref, payload_summary,
            attempts, last_error, first_failed_at, last_failed_at
          ) VALUES (
            ${randomUUID()}, ${orgId}, ${queue}, ${job.name},
            ${data.bundleStorageKey ?? null},
            ${JSON.stringify(summarise(job.data))}::jsonb,
            ${job.attemptsMade}, ${error.message.slice(0, 2000)},
            ${new Date(job.timestamp).toISOString()}, now()
          )
        `);
      });
    } catch (dlqError) {
      this.logger.error(
        { err: String(dlqError), jobId: job.id },
        'dead-letter write failed; job is lost',
      );
    }
  }

  /** §15.6 — 429-aware backpressure across every queue, for the provider's retry window. */
  async pauseAll(reason: string, durationMs: number): Promise<void> {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + durationMs);
    this.logger.warn({ reason, resumesInMs: durationMs }, 'pausing all queues');
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.connection.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  /** Graceful drain: stop accepting, let in-flight finish, then close. */
  async close(): Promise<void> {
    await Promise.all([...this.workers.values()].map((w) => w.close()));
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.connection.disconnect();
  }

  async enqueueRegenerateDocs(job: {
    orgId: string;
    repoId: string;
    commitSha: string;
    ref: string;
    bundleStorageKey: string;
  }): Promise<string> {
    const id = jobId('docs', job.repoId, job.commitSha);
    await this.queue(QUEUE_NAMES.regenerateDocs).add(QUEUE_NAMES.regenerateDocs, job, {
      jobId: id,
    });
    return id;
  }

  async pause(name: QueueName, reason: string): Promise<void> {
    this.logger.warn({ queue: name, reason }, 'pausing queue');
    await this.queue(name).pause();
  }
}

/** Payload summaries never carry content — only identifiers and counts. */
function summarise(data: unknown): Record<string, unknown> {
  if (!data || typeof data !== 'object') return {};
  const source = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of [
    'orgId',
    'repoId',
    'moduleId',
    'commitSha',
    'ref',
    'projectId',
    'changeCount',
  ]) {
    if (key in source) out[key] = source[key];
  }
  return out;
}
