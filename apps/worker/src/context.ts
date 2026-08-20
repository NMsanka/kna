import { createDb, type DbHandle } from '@kna/db';
import { createLogger, KnaMetrics, HealthRegistry, type Logger } from '@kna/observability';
import { BudgetManager, InMemoryBudgetStore, LlmClient } from '@kna/llm';
import { DEFAULT_RETRIEVAL_CONFIG, type RetrievalConfig } from '@kna/retrieval';
import { loadPlatformEnv, type PlatformEnv } from '@kna/config';
import { BundleStore } from '@kna/contracts';
import { WorkerQueue } from './services/queue.js';
import { GitClient } from './services/git.js';

/**
 * Worker wiring.
 *
 * The worker uses the *batch* database role and the *batch* LiteLLM key throughout. §15.6 —
 * "interactive and batch share one provider quota... a backfill saturating the embedding
 * provider's TPM limit will 429 chat and rerank simultaneously: the most visible surface
 * degrades because of invisible background work."
 *
 * Every LLM call from this process is therefore on a key whose rate limit is separate from the
 * one the chat path uses, and 429s pause the queue rather than retrying into a saturated quota.
 */

export interface WorkerContext {
  env: PlatformEnv;
  logger: Logger;
  db: DbHandle;
  llm: LlmClient;
  budget: BudgetManager;
  bundleStore: BundleStore;
  queue: WorkerQueue;
  git: GitClient | null;
  health: HealthRegistry;
  metrics: typeof KnaMetrics;
  retrievalConfig: RetrievalConfig;
  shutdown: () => Promise<void>;
}

export async function createWorkerContext(env = loadPlatformEnv()): Promise<WorkerContext> {
  const logger = createLogger({
    service: 'kna-worker',
    level: env.LOG_LEVEL,
    environment: env.KNA_ENV,
    region: env.KNA_REGION,
    pretty: env.KNA_ENV === 'development',
  });

  const db = createDb({
    url: env.DATABASE_URL_BATCH ?? env.DATABASE_URL,
    role: 'batch',
    poolMax: 6,
    applicationName: 'kna-worker',
  });

  const queue = new WorkerQueue(env.REDIS_URL, logger);

  const llm = new LlmClient({
    baseUrl: env.LITELLM_BASE_URL,
    keys: {
      // Both mapped to the batch key deliberately: nothing this process does is interactive,
      // and a stray interactive call from a worker is exactly the cross-contamination §15.6
      // warns about.
      interactive: env.LITELLM_KEY_BATCH,
      batch: env.LITELLM_KEY_BATCH,
    },
    region: env.KNA_REGION,
    onRateLimited: ({ model, keyClass, retryAfterMs }) => {
      KnaMetrics.providerRateLimited.add(1, { model, keyClass });
      // §15.6 — "implement 429-aware backpressure that pauses the queue rather than burning
      // retries". Retrying into a saturated quota makes the outage longer, not shorter.
      void queue.pauseAll(`provider rate limited on ${model}`, retryAfterMs);
    },
    onUsage: (usage) => {
      KnaMetrics.tokenSpendUsd.add(usage.estimatedUsd, {
        org: usage.orgId,
        workload: usage.workload,
        model: usage.model,
      });
    },
  });

  const budgetStore = new InMemoryBudgetStore(env.ORG_DAILY_SPEND_CEILING_USD);
  const budget = new BudgetManager(budgetStore, {
    warnAtFraction: 0.8,
    onWarn: (state) => {
      logger.warn(
        { org: state.orgId, spent: state.spentTodayUsd, ceiling: state.ceilingUsd },
        'org approaching daily spend ceiling',
      );
    },
  });

  const bundleStore = new BundleStore({
    endpoint: env.BUNDLE_STORE_ENDPOINT,
    bucket: env.BUNDLE_STORE_BUCKET,
    accessKey: env.BUNDLE_STORE_ACCESS_KEY,
    secretKey: env.BUNDLE_STORE_SECRET_KEY,
    region: env.BUNDLE_STORE_REGION,
  });

  const git =
    env.GIT_PROVIDER === 'none'
      ? null
      : new GitClient({
          provider: env.GIT_PROVIDER,
          // §15.3 — enforced here as well as in the API. A staging worker must not open PRs on
          // production repositories, and one enforcement point is one place to get it wrong.
          writeEnabled: env.WRITE_ENABLED && env.KNA_ENV === 'production',
          logger,
        });

  const health = new HealthRegistry()
    .register({
      name: 'postgres',
      kind: 'critical',
      check: async () => {
        await db.sql`SELECT 1`;
        return { state: 'up' };
      },
    })
    .register({
      name: 'redis',
      kind: 'critical',
      check: async () => ({ state: (await queue.ping()) ? 'up' : 'down' }),
    });

  return {
    env,
    logger,
    db,
    llm,
    budget,
    bundleStore,
    queue,
    git,
    health,
    metrics: KnaMetrics,
    retrievalConfig: {
      ...DEFAULT_RETRIEVAL_CONFIG,
      embeddingModel: env.EMBEDDING_MODEL,
      embeddingDimensions: env.EMBEDDING_DIMENSIONS,
      blurbModel: env.MODEL_BLURB,
      chatModel: env.MODEL_CHAT,
      rerankerModel: env.RERANKER_URL ? env.RERANKER_MODEL : null,
    },
    shutdown: async () => {
      await queue.close();
      await db.close();
    },
  };
}
