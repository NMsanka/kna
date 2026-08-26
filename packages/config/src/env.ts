import { z } from 'zod';
import { loadDotEnv } from './dotenv.js';

/**
 * Platform environment configuration.
 *
 * Two findings shape this file. §15.3 — "environment promotion is undefined for a system that
 * writes to real repos": a staging deploy that opens documentation PRs on production repos
 * burns exactly the trust the project depends on. So `KNA_ENV` is required, `writeEnabled`
 * defaults to false everywhere except production, and the PR client asserts it rather than
 * trusting a config toggle. §15.7 — "provider fallback silently defeats data residency": the
 * region is pinned here and cross-region fallback fails closed.
 */

const bool = (defaultValue: boolean) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no'])
    .transform((v) => v === 'true' || v === '1' || v === 'yes')
    .default(defaultValue ? 'true' : 'false');

export const zPlatformEnv = z.object({
  KNA_ENV: z.enum(['development', 'test', 'staging', 'production']),
  KNA_REGION: z.string().default('local'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // ── Datastores ───────────────────────────────────────────────────────────────────────────
  DATABASE_URL: z.string().url(),
  /** Separate pool and DB role for batch traffic, so a reindex storm cannot exhaust the
   *  connections the chat path needs (§15.6 "logical isolation without resource isolation"). */
  DATABASE_URL_BATCH: z.string().url().optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  /** Mandatory on the retrieval path; an unbounded query stalls every assistant in the org. */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  REDIS_URL: z.string().url(),

  // ── Object storage: the system of record (§15.1 fix 1) ───────────────────────────────────
  BUNDLE_STORE_ENDPOINT: z.string().url(),
  BUNDLE_STORE_BUCKET: z.string().default('kna-ir-bundles'),
  BUNDLE_STORE_ACCESS_KEY: z.string(),
  BUNDLE_STORE_SECRET_KEY: z.string(),
  BUNDLE_STORE_REGION: z.string().default('us-east-1'),
  /** Object-lock retention for the audit sink; audit lives under separate credentials. */
  AUDIT_STORE_BUCKET: z.string().default('kna-audit'),

  // ── LLM routing ──────────────────────────────────────────────────────────────────────────
  /** Always the LiteLLM proxy, never a provider SDK directly — §11 "keep LiteLLM anyway". */
  LITELLM_BASE_URL: z.string().url(),
  /** Interactive traffic. Distinct virtual key so a backfill cannot 429 the chat path. */
  LITELLM_KEY_INTERACTIVE: z.string(),
  /** Batch/backfill traffic, lower priority, separate rate limit. */
  LITELLM_KEY_BATCH: z.string(),

  EMBEDDING_MODEL: z.string().default('text-embedding-3-large'),
  /** §11 "the dimension trap": pgvector's HNSW index caps at 2,000 dims and
   *  text-embedding-3-large is 3,072 native. Matryoshka truncation to 1536 is the default. */
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),
  /**
   * Names of **routes on the LiteLLM proxy** — the `model_name` entries in its config — not
   * provider model ids. §11 keeps the proxy so a vendor swap is a config change; naming
   * `gpt-4.1` here moves that decision back into a deploy.
   *
   * These are defaults rather than documentation: `WORKLOAD_POLICIES` also carries a
   * `defaultModel`, but it is only reached when the variable is unset, and a `.default()` here
   * means it never is. So these values are the ones that actually take effect, and they were
   * provider ids while the policy table said routes — which is why a deployment that did not
   * override them sent `gpt-5` to a proxy that has no such route and got a 400 on every
   * documentation prose call.
   */
  MODEL_BLURB: z.string().default('blurb'),
  MODEL_QUERY: z.string().default('query'),
  MODEL_CHAT: z.string().default('chat'),
  MODEL_DOCGEN: z.string().default('docgen'),

  /** Self-hosted cross-encoder. §11 — OpenAI has no reranker; option 1 for production. */
  RERANKER_URL: z.string().url().optional(),
  RERANKER_MODEL: z.string().default('bge-reranker-v2-m3'),
  RERANKER_TIMEOUT_MS: z.coerce.number().int().positive().default(800),

  // ── Git provider ─────────────────────────────────────────────────────────────────────────
  GIT_PROVIDER: z.enum(['github', 'azuredevops', 'gitlab', 'none']).default('none'),
  GIT_APP_ID: z.string().optional(),
  /** §15.7 — the App private key is the most valuable secret in the engineering estate. It is
   *  read from a KMS reference, never from an env var containing key material. */
  GIT_APP_PRIVATE_KEY_REF: z.string().optional(),
  GIT_WEBHOOK_SECRET: z.string().optional(),

  /**
   * §15.3 — a distinct Git provider App per environment, and write disabled by default outside
   * production. The PR client re-asserts this rather than trusting the flag alone.
   */
  WRITE_ENABLED: bool(false),

  // ── Ingest trust boundary (§15.2) ────────────────────────────────────────────────────────
  INGEST_SIGNATURE_MODE: z.enum(['sigstore', 'hmac', 'permissive-dev']).default('hmac'),
  INGEST_HMAC_SECRET: z.string().optional(),
  /** OIDC issuer whose tokens may be exchanged for a repo-scoped, ~10-minute ingest credential. */
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().default('kna-ingest'),
  INGEST_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  INGEST_MAX_BUNDLE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(256 * 1024 * 1024),

  // ── Auth ─────────────────────────────────────────────────────────────────────────────────
  OIDC_DISCOVERY_URL: z.string().url().optional(),
  JWT_AUDIENCE: z.string().default('kna-platform'),
  SESSION_SECRET: z.string().min(32),
  /** §15.4 — MCP access tokens are short-lived and audience-bound (RFC 8707). */
  MCP_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /** §15.6 — an explicit revocation SLO; the deny cache must be shorter than this. */
  ACL_REVOCATION_SLO_SECONDS: z.coerce.number().int().positive().default(300),

  // ── Budgets and breakers ─────────────────────────────────────────────────────────────────
  ORG_DAILY_SPEND_CEILING_USD: z.coerce.number().positive().default(500),
  CIRCUIT_MAX_CHURN_RATIO: z.coerce.number().positive().default(0.25),
  CIRCUIT_MAX_CHANGED_SYMBOLS: z.coerce.number().int().positive().default(2000),
  CIRCUIT_MAX_REGENERATIONS: z.coerce.number().int().positive().default(50),

  // ── Retrieval ────────────────────────────────────────────────────────────────────────────
  RETRIEVAL_TOP_K_DENSE: z.coerce.number().int().positive().default(50),
  RETRIEVAL_TOP_K_LEXICAL: z.coerce.number().int().positive().default(50),
  RETRIEVAL_TOP_K_SYMBOL: z.coerce.number().int().positive().default(10),
  RETRIEVAL_TOP_N_FINAL: z.coerce.number().int().positive().default(8),
  RETRIEVAL_RRF_K: z.coerce.number().int().positive().default(60),
  /** pgvector ef_search. §15.5 — "that one parameter usually buys more p99 than anything
   *  else"; tune against the eval set rather than defaulting it. */
  PGVECTOR_EF_SEARCH: z.coerce.number().int().positive().default(100),
  /** §15.5 — abstention threshold on calibrated cross-encoder scores. */
  ABSTENTION_THRESHOLD: z.coerce.number().default(0.35),

  // ── Observability ────────────────────────────────────────────────────────────────────────
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
  LANGFUSE_BASE_URL: z.string().url().optional(),
  LANGFUSE_PUBLIC_KEY: z.string().optional(),
  LANGFUSE_SECRET_KEY: z.string().optional(),

  PORT: z.coerce.number().int().positive().default(8080),
  MCP_PORT: z.coerce.number().int().positive().default(8081),
});

export type PlatformEnv = z.infer<typeof zPlatformEnv>;

let cached: PlatformEnv | null = null;

export function loadPlatformEnv(source: NodeJS.ProcessEnv = process.env): PlatformEnv {
  if (cached) return cached;

  // Local development reads `.env`; the real environment always wins, and production refuses to
  // read a file at all. See `loadDotEnv`.
  if (source === process.env) loadDotEnv();

  const parsed = zPlatformEnv.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid platform environment:\n${issues}`);
  }

  const env = parsed.data;

  // Cross-field invariants that a per-field schema cannot express. These are refusals, not
  // warnings: each one is a finding from §15 that only bites in production.
  if (env.KNA_ENV === 'production') {
    if (env.INGEST_SIGNATURE_MODE === 'permissive-dev') {
      throw new Error(
        'INGEST_SIGNATURE_MODE=permissive-dev is not permitted in production: unsigned bundles let any token holder assert another tenant orgId (§15.2).',
      );
    }
    if (env.INGEST_SIGNATURE_MODE === 'hmac' && !env.INGEST_HMAC_SECRET) {
      throw new Error('INGEST_SIGNATURE_MODE=hmac requires INGEST_HMAC_SECRET.');
    }
    if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) {
      throw new Error('OTEL_EXPORTER_OTLP_ENDPOINT is required in production.');
    }
  }

  if (env.WRITE_ENABLED && env.KNA_ENV !== 'production') {
    throw new Error(
      `WRITE_ENABLED=true with KNA_ENV=${env.KNA_ENV}. A non-production deployment must never open documentation PRs on real repos (§15.3). Use a separate Git App per environment.`,
    );
  }

  if (env.EMBEDDING_DIMENSIONS > 2000) {
    throw new Error(
      `EMBEDDING_DIMENSIONS=${env.EMBEDDING_DIMENSIONS} exceeds pgvector's 2,000-dimension HNSW limit for the vector type. Pass dimensions:1536 to the embeddings API, or switch the column to halfvec (§11 "the dimension trap").`,
    );
  }

  if (env.ACL_REVOCATION_SLO_SECONDS > 900) {
    throw new Error(
      'ACL_REVOCATION_SLO_SECONDS above 15 minutes leaves offboarded users with read access for too long (§15.4).',
    );
  }

  cached = env;
  return env;
}

/** Test-only. */
export function resetPlatformEnv(): void {
  cached = null;
}
