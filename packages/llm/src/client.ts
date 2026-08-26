import { z } from 'zod';
import type { Sensitivity } from '@kna/ir';
import {
  estimateCostUsd,
  route,
  WORKLOAD_POLICIES,
  type KeyClass,
  type Workload,
} from './policy.js';

/**
 * LiteLLM client.
 *
 * §11 "keep LiteLLM anyway" — every call goes through the proxy, never a provider SDK, because
 * three named blockers are solved by the proxy rather than by application code: per-team cost
 * attribution and budget caps, separate virtual keys for interactive versus batch traffic, and
 * a vendor swap that is a config change rather than a refactor.
 *
 * The proxy speaks the OpenAI-compatible protocol, so this file is deliberately thin: routing
 * policy lives in `policy.ts`, budget enforcement in `budget.ts`, and this handles transport,
 * retries and backpressure.
 */

export interface LlmClientOptions {
  baseUrl: string;
  keys: Record<KeyClass, string>;
  /** Header used to authenticate to the OpenAI-compatible endpoint. */
  authHeader?: string;
  /** Bearer is the OpenAI/LiteLLM default; raw supports API-key headers. */
  authScheme?: 'bearer' | 'raw';
  region: string;
  /** Called after every request with the usage record, for the spend ledger. */
  onUsage?: (usage: UsageRecord) => void | Promise<void>;
  /** §15.6 — 429-aware backpressure pauses the queue rather than burning retries. */
  onRateLimited?: (info: { model: string; keyClass: KeyClass; retryAfterMs: number }) => void;
  fetchImpl?: typeof fetch;
}

export interface UsageRecord {
  workload: Workload;
  model: string;
  provider: string;
  region: string;
  keyClass: KeyClass;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estimatedUsd: number;
  latencyMs: number;
  orgId: string;
  repoId?: string;
}

export class LlmPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmPolicyError';
  }
}

export class LlmRateLimitError extends Error {
  constructor(
    message: string,
    readonly retryAfterMs: number,
    readonly keyClass: KeyClass,
  ) {
    super(message);
    this.name = 'LlmRateLimitError';
  }
}

const zChatResponse = z.object({
  id: z.string().optional(),
  model: z.string().optional(),
  choices: z.array(
    z.object({
      message: z.object({ role: z.string(), content: z.string().nullable() }),
      finish_reason: z.string().nullable().optional(),
    }),
  ),
  usage: z
    .object({
      prompt_tokens: z.number().default(0),
      completion_tokens: z.number().default(0),
      prompt_tokens_details: z
        .object({ cached_tokens: z.number().default(0) })
        .partial()
        .optional(),
    })
    .optional(),
});

const zEmbeddingResponse = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()), index: z.number() })),
  model: z.string().optional(),
  usage: z.object({ prompt_tokens: z.number().default(0) }).optional(),
});

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteRequest {
  workload: Workload;
  orgId: string;
  repoId?: string;
  messages: ChatMessage[];
  contentSensitivity: Sensitivity;
  temperature?: number;
  maxTokens?: number;
  /** Overrides the policy's timeout — use sparingly; the budget exists for a reason. */
  timeoutMs?: number;
  responseFormat?: 'text' | 'json_object';
}

export interface CompleteResult {
  text: string;
  model: string;
  finishReason: string | null;
  usage: UsageRecord;
}

export class LlmClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: LlmClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    // Call sites pass paths beginning with `/`; accepting a trailing slash in configuration
    // without normalising it produces `//v1/...`, which some compatible gateways reject.
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const decision = route({
      workload: request.workload,
      contentSensitivity: request.contentSensitivity,
      region: this.options.region,
    });
    if (decision.refusal) throw new LlmPolicyError(decision.refusal);

    const started = performance.now();
    const body = {
      model: decision.model,
      messages: request.messages,
      temperature: request.temperature ?? 0,
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...(request.responseFormat === 'json_object'
        ? { response_format: { type: 'json_object' } }
        : {}),
      // LiteLLM propagates these for per-team cost attribution (§15.8 chargeback).
      metadata: {
        org_id: request.orgId,
        repo_id: request.repoId ?? null,
        workload: request.workload,
      },
    };

    const response = await this.send('/v1/chat/completions', body, decision.keyClass, {
      timeoutMs: request.timeoutMs ?? decision.timeoutMs,
      model: decision.model,
    });

    const parsed = zChatResponse.parse(response);
    const model = parsed.model ?? decision.model;
    const usage: UsageRecord = {
      workload: request.workload,
      model,
      provider: providerOf(model),
      region: this.options.region,
      keyClass: decision.keyClass,
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.usage?.completion_tokens ?? 0,
      cachedInputTokens: parsed.usage?.prompt_tokens_details?.cached_tokens ?? 0,
      estimatedUsd: 0,
      latencyMs: Math.round(performance.now() - started),
      orgId: request.orgId,
      ...(request.repoId ? { repoId: request.repoId } : {}),
    };
    usage.estimatedUsd = estimateCostUsd(
      model,
      usage,
      WORKLOAD_POLICIES[request.workload].batchEligible,
    );
    await this.options.onUsage?.(usage);

    return {
      text: parsed.choices[0]?.message.content ?? '',
      model,
      finishReason: parsed.choices[0]?.finish_reason ?? null,
      usage,
    };
  }

  /**
   * Embed a batch of texts.
   *
   * `dimensions` is passed explicitly rather than left to the provider default. §11 — the
   * models are Matryoshka-trained, so truncation is graceful, and 1024 both fits pgvector's
   * index ceiling and halves index RAM. Leaving this off is how a corpus ends up unindexable.
   */
  async embed(request: {
    orgId: string;
    repoId?: string;
    texts: string[];
    dimensions: number;
    contentSensitivity: Sensitivity;
    timeoutMs?: number;
  }): Promise<{ vectors: number[][]; model: string; usage: UsageRecord }> {
    const decision = route({
      workload: 'embedding',
      contentSensitivity: request.contentSensitivity,
      region: this.options.region,
    });
    if (decision.refusal) throw new LlmPolicyError(decision.refusal);

    const started = performance.now();
    const response = await this.send(
      '/v1/embeddings',
      {
        model: decision.model,
        input: request.texts,
        dimensions: request.dimensions,
        metadata: { org_id: request.orgId, workload: 'embedding' },
      },
      decision.keyClass,
      { timeoutMs: request.timeoutMs ?? decision.timeoutMs, model: decision.model },
    );

    const parsed = zEmbeddingResponse.parse(response);
    const model = parsed.model ?? decision.model;

    for (const item of parsed.data) {
      if (item.embedding.length !== request.dimensions) {
        // Silent dimension drift corrupts an index in a way that is very hard to diagnose
        // later, because cosine distance still returns numbers.
        throw new LlmPolicyError(
          `Embedding provider returned ${item.embedding.length} dimensions but ${request.dimensions} were requested. Refusing to write a mixed-dimension index.`,
        );
      }
    }

    const usage: UsageRecord = {
      workload: 'embedding',
      model,
      provider: providerOf(model),
      region: this.options.region,
      keyClass: decision.keyClass,
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      estimatedUsd: 0,
      latencyMs: Math.round(performance.now() - started),
      orgId: request.orgId,
      ...(request.repoId ? { repoId: request.repoId } : {}),
    };
    usage.estimatedUsd = estimateCostUsd(model, usage, true);
    await this.options.onUsage?.(usage);

    return {
      vectors: parsed.data.sort((a, b) => a.index - b.index).map((d) => d.embedding),
      model,
      usage,
    };
  }

  private async send(
    path: string,
    body: unknown,
    keyClass: KeyClass,
    context: { timeoutMs: number; model: string },
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), context.timeoutMs);

    try {
      const authHeader = this.options.authHeader ?? 'authorization';
      const key = this.options.keys[keyClass];
      const credential = this.options.authScheme === 'raw' ? key : `Bearer ${key}`;

      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [authHeader]: credential,
          // Region is asserted on every request so the proxy can refuse a cross-region route
          // rather than silently falling back (§15.7).
          'x-kna-region': this.options.region,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after')) ?? 5_000;
        this.options.onRateLimited?.({ model: context.model, keyClass, retryAfterMs });
        throw new LlmRateLimitError(
          `Rate limited on ${context.model} (${keyClass} key). Pausing rather than retrying: burning retries against a saturated quota degrades the interactive path too.`,
          retryAfterMs,
          keyClass,
        );
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`LiteLLM ${path} returned ${response.status}: ${text.slice(0, 500)}`);
      }

      return await response.json();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `LiteLLM ${path} exceeded its ${context.timeoutMs}ms budget for ${context.model}.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(date - Date.now(), 0) : null;
}

function providerOf(model: string): string {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('text-embedding')) {
    return 'openai';
  }
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('azure/')) return 'azure-openai';
  if (model.startsWith('bedrock/')) return 'bedrock';
  return 'self-hosted';
}
