import { Queue, type QueueEvents } from 'bullmq';
import IORedisModule, { type Redis } from 'ioredis';

import type { Logger } from '@kna/observability';

/**
 * `ioredis` is CommonJS with an ESM-shaped `export default`, which NodeNext types as the module
 * namespace rather than the constructor it is at runtime.
 */
const IORedis = IORedisModule as unknown as new (
  url: string,
  options?: { maxRetriesPerRequest?: number | null; enableReadyCheck?: boolean },
) => Redis;

/**
 * Job queues.
 *
 * §15.6 HIGH — "Queue design asserts invariants BullMQ cannot enforce. Per-repo concurrency of 1
 * is not achievable with stock BullMQ (group concurrency is a Pro feature), and stalled-job
 * recovery will re-dispatch a long-running embed job whose lock expired — producing exactly the
 * interleaving §7 says corrupts state."
 *
 * The decision, made here rather than deferred: serialisation is enforced by a **Postgres
 * advisory lock keyed on moduleId** (see `withModuleLock` in @kna/db), taken inside the same
 * transaction as the write it protects. BullMQ schedules; Postgres serialises. A re-dispatched
 * stalled job then blocks on the lock instead of interleaving with the original.
 *
 * The same finding also requires: an explicit attempts/backoff policy, a real DLQ (BullMQ's
 * `failed` set is not one), bundles in object storage with only a pointer in Redis, and a Redis
 * configuration assertion — "an LRU-evicting Redis silently deletes queued work with no error
 * anywhere."
 */

export const QUEUE_NAMES = {
  indexModule: 'index-module',
  indexDocuments: 'index-documents',
  crossRepo: 'cross-repo-resolve',
  regenerateDocs: 'regenerate-docs',
  maintenance: 'maintenance',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface IndexModuleJob {
  orgId: string;
  repoId: string;
  moduleId: string;
  commitSha: string;
  ref: string;
  /** A pointer, never the bundle. §15.6 — "bundles in object storage with only a pointer in Redis." */
  bundleStorageKey: string;
  changeCount: number;
  /**
   * Set only by an explicit reindex. It joins the job id, which is what makes a deliberate
   * re-run possible at all: without it the id collides with the completed job for the same
   * `(moduleId, commitSha)` and BullMQ silently drops the request.
   */
  reindexToken?: string;
}

export interface RegenerateDocsJob {
  orgId: string;
  repoId: string;
  commitSha: string;
  /** The version the documents belong to. Documentation is versioned with the code it describes. */
  ref: string;
  /**
   * Set only by a deliberate trigger — an operator approving a repo, or an explicit reindex.
   *
   * Without it the job id is `(repo, commit)`, which is exactly right for ingest: a replayed
   * webhook must not regenerate twice. It is exactly wrong for a human asking for regeneration
   * after a completed run, because BullMQ answers a duplicate id by doing nothing and returning
   * the old id — so the request succeeds, the operator sees 204, and nothing happens.
   */
  regenerationToken?: string;
  bundleStorageKey: string;
}

export interface IndexDocumentsJob {
  orgId: string;
  repoId: string;
  commitSha: string;
  ref: string;
  bundleStorageKey: string;
}

export interface CrossRepoJob {
  orgId: string;
  projectId: string;
  triggeredByRepoId: string;
}

export class RedisConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedisConfigurationError';
  }
}

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

export class JobQueue {
  private readonly connection: Redis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly events = new Map<QueueName, QueueEvents>();

  constructor(
    redisUrl: string,
    private readonly logger: Logger,
  ) {
    this.connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }

  /**
   * §15.6 — "a Redis config assertion that `maxmemory-policy` is `noeviction` with AOF on."
   *
   * This is checked at startup and refuses to proceed rather than warning, because the failure
   * it prevents is invisible: an LRU-evicting Redis drops queued jobs with no error anywhere,
   * and the symptom is repos that quietly never get indexed.
   */
  async assertConfiguration(): Promise<void> {
    const [[, maxmemoryPolicy], [, appendonly]] = (await Promise.all([
      this.connection.config('GET', 'maxmemory-policy'),
      this.connection.config('GET', 'appendonly'),
    ])) as [string[], string[]];

    if (maxmemoryPolicy !== 'noeviction') {
      throw new RedisConfigurationError(
        `Redis maxmemory-policy is '${maxmemoryPolicy}', not 'noeviction'. An evicting Redis silently deletes queued jobs with no error anywhere, and the only symptom is repositories that quietly never get indexed.`,
      );
    }

    if (appendonly !== 'yes') {
      this.logger.warn(
        'Redis appendonly is off. A restart will lose queued jobs; the nightly reconciliation sweep will recover repo indexing, but in-flight doc regeneration will be lost.',
      );
    }
  }

  private queue(name: QueueName): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: {
          // Explicit, because the default is one attempt and no backoff (§15.6).
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
          // Keep enough history to diagnose, not enough to fill Redis.
          removeOnComplete: { count: 1_000, age: 24 * 3_600 },
          // Failures are moved to the real DLQ table by the worker; this is just a short buffer.
          removeOnFail: { count: 5_000, age: 7 * 24 * 3_600 },
        },
      });
      this.queues.set(name, queue);
    }
    return queue;
  }

  /**
   * Enqueue a module index job.
   *
   * `jobId` is `(moduleId, commitSha)`, which gives idempotency for free: BullMQ refuses a
   * duplicate job id, so a replayed webhook is a no-op at the queue rather than needing to be
   * detected in the worker (§7 idempotency and coalescing).
   */
  async enqueueIndexModule(job: IndexModuleJob): Promise<string> {
    const id = job.reindexToken
      ? jobId(job.moduleId, job.commitSha, job.reindexToken)
      : jobId(job.moduleId, job.commitSha);
    await this.queue(QUEUE_NAMES.indexModule).add(QUEUE_NAMES.indexModule, job, {
      jobId: id,
      // Per-org priority partitioning: one tenant onboarding a 3M-LOC monolith must not starve
      // every other tenant for hours (§15.6 "logical isolation without resource isolation").
      priority: job.changeCount > 1_000 ? 10 : 1,
    });
    return id;
  }

  async enqueueRegenerateDocs(job: RegenerateDocsJob): Promise<string> {
    const id = job.regenerationToken
      ? jobId('docs', job.repoId, job.commitSha, job.regenerationToken)
      : jobId('docs', job.repoId, job.commitSha);
    await this.queue(QUEUE_NAMES.regenerateDocs).add(QUEUE_NAMES.regenerateDocs, job, {
      jobId: id,
    });
    return id;
  }

  async enqueueIndexDocuments(job: IndexDocumentsJob): Promise<string> {
    const id = jobId('source-docs', job.repoId, job.commitSha);
    await this.queue(QUEUE_NAMES.indexDocuments).add(QUEUE_NAMES.indexDocuments, job, {
      jobId: id,
    });
    return id;
  }

  async enqueueCrossRepo(job: CrossRepoJob): Promise<string> {
    // Coalesced per project: the resolution pass needs the whole project's IR present, so
    // queuing one per repo would run it N times for one meaningful change (§15.6).
    const id = jobId('cross', job.projectId);
    await this.queue(QUEUE_NAMES.crossRepo).add(QUEUE_NAMES.crossRepo, job, {
      jobId: id,
      delay: 60_000,
    });
    return id;
  }

  /**
   * §15.6 — "queue depth *and oldest-job age* per queue (the best staleness alarm)".
   * Oldest-job age is the one that catches a stuck worker; depth alone looks fine while
   * nothing is progressing.
   */
  async stats(): Promise<
    Array<{
      queue: QueueName;
      waiting: number;
      active: number;
      failed: number;
      oldestJobAgeSeconds: number;
    }>
  > {
    const out = [];
    for (const name of Object.values(QUEUE_NAMES)) {
      const queue = this.queue(name);
      const [waiting, active, failed] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getFailedCount(),
      ]);

      const oldest = await queue.getJobs(['wait'], 0, 0, true);
      const oldestJobAgeSeconds = oldest[0]?.timestamp
        ? Math.round((Date.now() - oldest[0].timestamp) / 1000)
        : 0;

      out.push({ queue: name, waiting, active, failed, oldestJobAgeSeconds });
    }
    return out;
  }

  /**
   * §15.6 — pause rather than fail. Used by the budget ceiling and by 429 backpressure:
   * "implement 429-aware backpressure that pauses the queue rather than burning retries", and
   * "a per-org daily spend ceiling that pauses the queue rather than failing mid-write".
   */
  async pause(name: QueueName, reason: string): Promise<void> {
    this.logger.warn({ queue: name, reason }, 'pausing queue');
    await this.queue(name).pause();
  }

  async resume(name: QueueName): Promise<void> {
    this.logger.info({ queue: name }, 'resuming queue');
    await this.queue(name).resume();
  }

  async isPaused(name: QueueName): Promise<boolean> {
    return this.queue(name).isPaused();
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.connection.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    for (const events of this.events.values()) await events.close();
    for (const queue of this.queues.values()) await queue.close();
    this.connection.disconnect();
  }

  get redis(): Redis {
    return this.connection;
  }
}
