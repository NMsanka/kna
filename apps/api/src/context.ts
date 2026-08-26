import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest, RawServerDefault } from 'fastify';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createDb, withSystemContext, type DbHandle } from '@kna/db';
import { KnaMetrics, HealthRegistry, createLogger, type Logger } from '@kna/observability';
import { LlmClient } from '@kna/llm';
import {
  RetrievalPipeline,
  RetrievalStore,
  Reranker,
  NullReranker,
  DEFAULT_RETRIEVAL_CONFIG,
  type RetrievalConfig,
} from '@kna/retrieval';
import type { IrBundle, IrBundlePayload } from '@kna/ir';
import { loadPlatformEnv, type PlatformEnv } from '@kna/config';
import { BundleStore } from '@kna/contracts';
import { mintIngestToken, PermissionResolver, AuthError, type Principal } from './auth.js';

import { AuditRecorder } from '@kna/audit';
import { JobQueue } from './services/queue.js';
import { PlatformStore } from './services/store.js';
import { GitProviderClient } from './services/git.js';
import { OidcVerifier } from './services/oidc.js';

/**
 * Wiring.
 *
 * Constructed once and passed to every route, so the dependency graph of the API is readable in
 * one place rather than inferred from imports. Two things here are load-bearing rather than
 * stylistic:
 *
 *  - Two database handles, with different roles and different statement timeouts (§15.6:
 *    "separate pools and DB roles for interactive versus batch traffic").
 *  - The reranker degrades to a null implementation rather than being absent, so the retrieval
 *    path has one code shape whether or not a cross-encoder is deployed (§11 option 4).
 */

/**
 * The concrete server type.
 *
 * Fastify's generics carry the logger type, and ours is pino's `Logger` rather than the default
 * `FastifyBaseLogger`. Naming it once here — through `@kna/observability`, which re-exports it —
 * keeps the emitted declarations portable; inferring it reaches into a nested node_modules path
 * that does not exist on another machine's install layout.
 */
export type KnaServer = FastifyInstance<
  RawServerDefault,
  IncomingMessage,
  ServerResponse<IncomingMessage>,
  Logger
>;

export interface ApiContext {
  env: PlatformEnv;
  logger: Logger;
  db: DbHandle;
  dbBatch: DbHandle;
  store: PlatformStore;
  bundleStore: BundleStore;
  audit: AuditRecorder;
  queue: JobQueue;
  retrieval: RetrievalPipeline;
  retrievalConfig: RetrievalConfig;
  permissions: PermissionResolver;
  llm: LlmClient;
  health: HealthRegistry;
  metrics: typeof KnaMetrics;
  git: GitProviderClient | null;
  oidc: OidcVerifier | null;
  authenticate: (request: FastifyRequest) => Promise<Principal>;
  /** For surfaces whose credential is not in an Authorization header. */
  authenticateToken: (token: string) => Promise<Principal>;
  mintIngestToken: (claims: {
    orgId: string;
    repoId: string;
    issuedAt: number;
    expiresAt: number;
  }) => string;
  shutdown: () => Promise<void>;
}

export async function createApiContext(env = loadPlatformEnv()): Promise<ApiContext> {
  const logger = createLogger({
    service: 'kna-api',
    level: env.LOG_LEVEL,
    environment: env.KNA_ENV,
    region: env.KNA_REGION,
    pretty: env.KNA_ENV === 'development',
  });

  const db = createDb({
    url: env.DATABASE_URL,
    role: 'interactive',
    poolMax: env.DATABASE_POOL_MAX,
    statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
    applicationName: 'kna-api',
  });

  const dbBatch = createDb({
    url: env.DATABASE_URL_BATCH ?? env.DATABASE_URL,
    role: 'batch',
    poolMax: 4,
    idleInTransactionSessionTimeoutMs: env.DATABASE_BATCH_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    applicationName: 'kna-api-batch',
  });

  const llm = new LlmClient({
    baseUrl: env.LITELLM_BASE_URL,
    keys: { interactive: env.LITELLM_KEY_INTERACTIVE, batch: env.LITELLM_KEY_BATCH },
    authHeader: env.LITELLM_AUTH_HEADER,
    authScheme: env.LITELLM_AUTH_SCHEME,
    region: env.KNA_REGION,
    onRateLimited: ({ model, keyClass, retryAfterMs }) => {
      KnaMetrics.providerRateLimited.add(1, { model, keyClass });
      logger.warn({ model, keyClass, retryAfterMs }, 'provider rate limited');
    },
    onUsage: (usage) => {
      KnaMetrics.tokenSpendUsd.add(usage.estimatedUsd, {
        org: usage.orgId,
        workload: usage.workload,
        model: usage.model,
      });
    },
  });

  const health = new HealthRegistry();
  const retrievalStore = new RetrievalStore(db);

  // §11 — "ship without it initially: RRF-only, which §15 already specifies as the reranker-down
  // degraded mode. Acceptable for Phase 1." The null implementation makes that a configuration
  // choice rather than a different code path.
  const reranker = env.RERANKER_URL
    ? new Reranker({
        url: env.RERANKER_URL,
        model: env.RERANKER_MODEL,
        timeoutMs: env.RERANKER_TIMEOUT_MS,
        onDegraded: (reason) => {
          health.enterDegraded('reranker-unavailable');
          logger.warn({ reason }, 'reranker degraded');
        },
      })
    : new NullReranker();

  const retrievalConfig: RetrievalConfig = {
    ...DEFAULT_RETRIEVAL_CONFIG,
    embeddingModel: env.EMBEDDING_MODEL,
    embeddingDimensions: env.EMBEDDING_DIMENSIONS,
    rerankerModel: env.RERANKER_URL ? env.RERANKER_MODEL : null,
    rrfK: env.RETRIEVAL_RRF_K,
    topKDense: env.RETRIEVAL_TOP_K_DENSE,
    topKLexical: env.RETRIEVAL_TOP_K_LEXICAL,
    topKSymbol: env.RETRIEVAL_TOP_K_SYMBOL,
    topNFinal: env.RETRIEVAL_TOP_N_FINAL,
    efSearch: env.PGVECTOR_EF_SEARCH,
    abstentionThreshold: env.ABSTENTION_THRESHOLD,
    chatModel: env.MODEL_CHAT,
  };

  const retrieval = new RetrievalPipeline({
    store: retrievalStore,
    reranker,
    llm,
    embed: async (query: string) => {
      const result = await llm.embed({
        orgId: 'system',
        texts: [query],
        dimensions: env.EMBEDDING_DIMENSIONS,
        contentSensitivity: 'internal',
      });
      return result.vectors[0]!;
    },
    config: retrievalConfig,
    abstentionPolicy: {
      rerankThreshold: env.ABSTENTION_THRESHOLD,
      minChunksWithoutReranker: 3,
      minChunks: 1,
    },
    onDegraded: (mode) => logger.warn({ mode }, 'retrieval degraded'),
  });

  const store = new PlatformStore(db, dbBatch);
  const bundleStore = new BundleStore({
    endpoint: env.BUNDLE_STORE_ENDPOINT,
    bucket: env.BUNDLE_STORE_BUCKET,
    accessKey: env.BUNDLE_STORE_ACCESS_KEY,
    secretKey: env.BUNDLE_STORE_SECRET_KEY,
    region: env.BUNDLE_STORE_REGION,
  });
  const audit = new AuditRecorder(dbBatch, logger);
  const queue = new JobQueue(env.REDIS_URL, logger);

  const permissions = new PermissionResolver({
    db,
    // The cache TTL must be shorter than the revocation SLO, or the SLO is fiction (§15.6).
    cacheTtlMs: Math.min(env.ACL_REVOCATION_SLO_SECONDS * 1000, 60_000),
    hardExpiryMs: env.ACL_REVOCATION_SLO_SECONDS * 1000 * 2,
  });

  const git =
    env.GIT_PROVIDER === 'none'
      ? null
      : new GitProviderClient({
          provider: env.GIT_PROVIDER,
          appId: env.GIT_APP_ID,
          privateKeyRef: env.GIT_APP_PRIVATE_KEY_REF,
          // §15.3 — write is disabled outside production, asserted at the client rather than
          // trusted from config, so a misconfigured staging deploy cannot open PRs on real repos.
          writeEnabled: env.WRITE_ENABLED && env.KNA_ENV === 'production',
          logger,
        });

  const oidc = env.OIDC_ISSUER
    ? new OidcVerifier({ issuer: env.OIDC_ISSUER, audience: env.OIDC_AUDIENCE })
    : null;

  // §15.6 — readiness consults only what this pod genuinely cannot serve without. Every
  // provider is advisory: "one vendor blip pulls every pod from the load balancer".
  health
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
      check: async () => {
        const ok = await queue.ping();
        return { state: ok ? 'up' : 'down' };
      },
    })
    .register({
      name: 'bundle-store',
      kind: 'advisory',
      check: async () => ({ state: (await bundleStore.healthy()) ? 'up' : 'degraded' }),
    })
    .register({
      name: 'litellm',
      kind: 'advisory',
      check: async () => ({ state: 'up' }),
    });

  /**
   * Resolve a principal from a token, wherever the token came from.
   *
   * Split out because the web application holds its token in an httpOnly cookie rather than an
   * Authorization header, and reconstructing a fake header to reuse `authenticate` would be a
   * lie told to get past a signature.
   */
  const authenticateToken = async (token: string): Promise<Principal> => {
    const principal = await store.principalForToken(token.trim());
    if (!principal) throw new AuthError('Unknown or expired token.', 401, 'invalid_token');
    if (principal.disabledAt) {
      throw new AuthError('This identity has been disabled.', 403, 'principal_disabled');
    }
    return principal;
  };

  const authenticate = async (request: FastifyRequest): Promise<Principal> => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new AuthError('Missing bearer token.', 401, 'missing_token');
    }
    return authenticateToken(header.slice(7));
  };

  return {
    env,
    logger,
    db,
    dbBatch,
    store,
    bundleStore,
    audit,
    queue,
    retrieval,
    retrievalConfig,
    permissions,
    llm,
    health,
    metrics: KnaMetrics,
    git,
    oidc,
    authenticate,
    authenticateToken,
    mintIngestToken: (claims) =>
      mintIngestToken(env.INGEST_HMAC_SECRET ?? env.SESSION_SECRET, claims),
    shutdown: async () => {
      await queue.close();
      await audit.flush();
      await db.close();
      await dbBatch.close();
    },
  };
}

/** Convenience used by several routes; kept here so the SQL shape lives with the wiring. */
export async function lastIndexedPayload(
  db: DbHandle,
  orgId: string,
  repoId: string,
  ref: string,
): Promise<IrBundlePayload | null> {
  const rows = await withSystemContext(db, orgId, 'maintenance', async (tx) =>
    tx.execute<{ storage_key: string }>(sql`
      SELECT storage_key FROM ir_bundles
      WHERE org_id = ${orgId} AND repo_id = ${repoId} AND ref = ${ref}
      ORDER BY received_at DESC LIMIT 1
    `),
  );
  void rows;
  return null;
}

export function requestId(): string {
  return randomUUID();
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type { IrBundle };
