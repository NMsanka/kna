import type { Sensitivity } from '@kna/ir';

/**
 * Model and provider policy.
 *
 * §11 "model assignment per task": "Do not use one model for everything; the cost difference
 * across these workloads is an order of magnitude." And §10 "provider posture": "pin which
 * sensitivity tiers may reach which providers."
 *
 * This module is the single place where both rules live, so a new call site cannot pick a model
 * by accident or route confidential content to the wrong endpoint.
 */

export type Workload =
  | 'context-blurb'
  | 'query-rewrite'
  | 'intent-classify'
  | 'chat'
  | 'docgen'
  | 'embedding'
  | 'rerank'
  | 'grounding-judge';

/** §15.6 — interactive and batch must not share a provider quota. */
export type KeyClass = 'interactive' | 'batch';

export interface WorkloadPolicy {
  workload: Workload;
  keyClass: KeyClass;
  /** Env var name holding the model id, so operators retune without a deploy. */
  modelEnv: string;
  /**
   * The **proxy route name**, not a provider model id.
   *
   * §11 keeps LiteLLM specifically so that "a vendor-swap is a config change rather than a
   * refactor". That only holds if the application names a route the proxy owns — `docgen`,
   * `chat`, `query`, `blurb` — and the proxy decides which vendor and model serves it. Naming
   * `gpt-5` here put the vendor's model id in application code, which meant the routes in
   * `deploy/litellm/config.yaml` were never used by anything, changing a model meant a deploy,
   * and a model the deployment's key could not reach failed at runtime with a 400 the proxy was
   * there to prevent.
   *
   * Keep these in step with the `model_name` entries in the proxy config. A route the proxy does
   * not define fails closed and loudly, which is the intended failure mode.
   */
  defaultModel: string;
  /** Highest sensitivity tier this workload's default route may handle. */
  maxSensitivity: Sensitivity;
  /** Latency expectation, used to pick timeouts and to alert meaningfully. */
  latencyBudgetMs: number;
  /** Whether the request is eligible for the 50%-discount async batch path (§11). */
  batchEligible: boolean;
  /** Whether the prompt has a long stable prefix worth prompt-caching. */
  cacheablePrefix: boolean;
}

export const WORKLOAD_POLICIES: Record<Workload, WorkloadPolicy> = {
  // The highest-volume job in the system. Batch API + prompt caching apply directly, and the
  // result is cached by signatureHash so it only re-runs when code actually changes.
  'context-blurb': {
    workload: 'context-blurb',
    keyClass: 'batch',
    modelEnv: 'MODEL_BLURB',
    defaultModel: 'blurb',
    maxSensitivity: 'confidential',
    latencyBudgetMs: 30_000,
    batchEligible: true,
    cacheablePrefix: true,
  },
  // Sits in the hot path before retrieval — cheapest capable model, tight budget.
  'query-rewrite': {
    workload: 'query-rewrite',
    keyClass: 'interactive',
    modelEnv: 'MODEL_QUERY',
    defaultModel: 'query',
    maxSensitivity: 'confidential',
    latencyBudgetMs: 600,
    batchEligible: false,
    cacheablePrefix: true,
  },
  'intent-classify': {
    workload: 'intent-classify',
    keyClass: 'interactive',
    modelEnv: 'MODEL_QUERY',
    defaultModel: 'query',
    maxSensitivity: 'confidential',
    latencyBudgetMs: 400,
    batchEligible: false,
    cacheablePrefix: true,
  },
  // Where quality is most visible to users.
  chat: {
    workload: 'chat',
    keyClass: 'interactive',
    modelEnv: 'MODEL_CHAT',
    defaultModel: 'chat',
    maxSensitivity: 'confidential',
    latencyBudgetMs: 20_000,
    batchEligible: false,
    cacheablePrefix: true,
  },
  // Low volume, high stakes, human-reviewed. Worth the strongest model.
  docgen: {
    workload: 'docgen',
    keyClass: 'batch',
    modelEnv: 'MODEL_DOCGEN',
    defaultModel: 'docgen',
    maxSensitivity: 'internal',
    latencyBudgetMs: 120_000,
    batchEligible: true,
    cacheablePrefix: true,
  },
  embedding: {
    workload: 'embedding',
    keyClass: 'batch',
    modelEnv: 'EMBEDDING_MODEL',
    defaultModel: 'text-embedding-3-large',
    maxSensitivity: 'confidential',
    latencyBudgetMs: 30_000,
    batchEligible: true,
    cacheablePrefix: false,
  },
  /**
   * §15.7 — "the reranker receives the full text of the top-50 chunks — the highest-sensitivity
   * payload in the pipeline — and is currently treated as infrastructure rather than a
   * subprocessor requiring a DPA and tier-based routing." Hence the self-hosted default and a
   * tight latency budget: §15.5 gives the reranker a hard timeout with fallback to RRF order.
   */
  rerank: {
    workload: 'rerank',
    keyClass: 'interactive',
    modelEnv: 'RERANKER_MODEL',
    defaultModel: 'bge-reranker-v2-m3',
    maxSensitivity: 'restricted',
    latencyBudgetMs: 800,
    batchEligible: false,
    cacheablePrefix: false,
  },
  /** §15.5 — an NLI/LLM judge verifying each generated claim is entailed by its cited facts. */
  'grounding-judge': {
    workload: 'grounding-judge',
    keyClass: 'batch',
    modelEnv: 'MODEL_QUERY',
    defaultModel: 'query',
    maxSensitivity: 'internal',
    latencyBudgetMs: 30_000,
    batchEligible: true,
    cacheablePrefix: true,
  },
};

const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export interface RouteDecision {
  model: string;
  keyClass: KeyClass;
  timeoutMs: number;
  /** Null when the route is permitted. A string here is a refusal, not a warning. */
  refusal: string | null;
}

export interface RouteRequest {
  workload: Workload;
  /** Highest sensitivity tier present in the payload. */
  contentSensitivity: Sensitivity;
  /** Region this deployment is pinned to. */
  region: string;
  /** Region the chosen route would execute in. */
  routeRegion?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Decide the route, or refuse.
 *
 * Two refusals are non-negotiable:
 *
 *  - `restricted` content never leaves for a commercial API. §10 Layer 3 already excludes it
 *    from embedding entirely; this catches every other path.
 *  - Cross-region execution fails closed rather than rerouting. §15.7 — "the EU endpoint
 *    rate-limits and the request lands in us-east-1, unlogged as a transfer." LiteLLM's
 *    headline feature is exactly the thing that causes this, so the guard lives here, above
 *    the proxy, where it cannot be configured away.
 */
export function route(request: RouteRequest): RouteDecision {
  const policy = WORKLOAD_POLICIES[request.workload];
  const env = request.env ?? process.env;
  const model = env[policy.modelEnv] ?? policy.defaultModel;

  const base: RouteDecision = {
    model,
    keyClass: policy.keyClass,
    timeoutMs: policy.latencyBudgetMs,
    refusal: null,
  };

  if (SENSITIVITY_RANK[request.contentSensitivity] > SENSITIVITY_RANK[policy.maxSensitivity]) {
    return {
      ...base,
      refusal: `Content classified '${request.contentSensitivity}' may not be sent to the '${request.workload}' route, which is approved only up to '${policy.maxSensitivity}'. Route this tier to an in-VPC or in-tenant endpoint, or exclude it.`,
    };
  }

  if (request.routeRegion && request.routeRegion !== request.region) {
    return {
      ...base,
      refusal: `Route would execute in '${request.routeRegion}' but this deployment is pinned to '${request.region}'. Cross-region fallback fails closed rather than rerouting; an unlogged transfer is worse than a failed request.`,
    };
  }

  return base;
}

/** Rough token pricing for the spend ledger. Approximate by design — it drives chargeback
 *  conversations and budget alarms, not invoices. Override per deployment. */
export const MODEL_PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; output: number; cachedInput: number }
> = {
  // Proxy routes, priced as whatever they currently resolve to. These are what the application
  // asks for, so these are what the spend ledger sees; the concrete model ids below remain for
  // deployments that override a route via its env var.
  chat: { input: 2, output: 8, cachedInput: 0.5 },
  query: { input: 0.4, output: 1.6, cachedInput: 0.1 },
  blurb: { input: 0.4, output: 1.6, cachedInput: 0.1 },
  docgen: { input: 2, output: 8, cachedInput: 0.5 },

  'gpt-5': { input: 1.25, output: 10, cachedInput: 0.125 },
  'gpt-4.1': { input: 2, output: 8, cachedInput: 0.5 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cachedInput: 0.1 },
  'text-embedding-3-large': { input: 0.13, output: 0, cachedInput: 0 },
  'text-embedding-3-small': { input: 0.02, output: 0, cachedInput: 0 },
  'bge-reranker-v2-m3': { input: 0, output: 0, cachedInput: 0 },
};

export function estimateCostUsd(
  model: string,
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens?: number },
  batchDiscount = false,
): number {
  const pricing = MODEL_PRICING_USD_PER_MTOK[model];
  if (!pricing) return 0;

  const cached = usage.cachedInputTokens ?? 0;
  const fresh = Math.max(usage.inputTokens - cached, 0);
  const raw =
    (fresh / 1_000_000) * pricing.input +
    (cached / 1_000_000) * pricing.cachedInput +
    (usage.outputTokens / 1_000_000) * pricing.output;

  // §11 — the Batch API is a 50% discount on asynchronous work with a 24-hour window, and the
  // initial full-corpus index is perfectly batch-shaped.
  return batchDiscount ? raw * 0.5 : raw;
}
