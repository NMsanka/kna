/**
 * Operational SLIs (§15.6 — "product metrics are not operational SLIs").
 *
 * The document names the alertable signals precisely, so they are enumerated here as a typed
 * registry rather than left to whatever each service happens to emit:
 *
 *   - queue depth AND oldest-job age per queue — "the best staleness alarm"
 *   - per-repo index lag as a gauge
 *   - retrieval latency decomposed by stage
 *   - provider 429 and error rates
 *   - token spend rate per tenant per hour, with anomaly detection
 *   - DLQ depth
 *
 * Backed by OpenTelemetry metrics so it exports anywhere; the names are fixed here so
 * dashboards and alert rules do not drift per service.
 */
import { metrics, type Counter, type Histogram, type ObservableGauge } from '@opentelemetry/api';

const meter = metrics.getMeter('kna-platform', '1.0.0');

export const KnaMetrics = {
  // ── Ingest and indexing ──────────────────────────────────────────────────────────────────
  bundlesIngested: meter.createCounter('kna.ingest.bundles', {
    description: 'IR bundles accepted, by result',
  }) as Counter,
  bundlesRejected: meter.createCounter('kna.ingest.rejected', {
    description: 'IR bundles rejected, by reason (signature, replay, version, scan, breaker)',
  }) as Counter,
  indexLagSeconds: meter.createHistogram('kna.index.lag_seconds', {
    description: 'Seconds between commit timestamp and completed index for that commit',
    unit: 's',
  }) as Histogram,
  symbolsIndexed: meter.createCounter('kna.index.symbols', {
    description: 'Symbols upserted, by change class',
  }) as Counter,

  // ── Queue health ─────────────────────────────────────────────────────────────────────────
  queueDepth: meter.createObservableGauge('kna.queue.depth', {
    description: 'Jobs waiting, by queue',
  }) as ObservableGauge,
  queueOldestJobAgeSeconds: meter.createObservableGauge('kna.queue.oldest_job_age_seconds', {
    description: 'Age of the oldest waiting job — the primary staleness alarm',
    unit: 's',
  }) as ObservableGauge,
  dlqDepth: meter.createObservableGauge('kna.queue.dlq_depth', {
    description: 'Jobs in the dead-letter queue awaiting operator drain',
  }) as ObservableGauge,
  jobDurationMs: meter.createHistogram('kna.job.duration_ms', {
    description: 'Job wall time, by queue and result',
    unit: 'ms',
  }) as Histogram,

  // ── Retrieval, decomposed by stage ───────────────────────────────────────────────────────
  retrievalStageMs: meter.createHistogram('kna.retrieval.stage_ms', {
    description:
      'Latency per retrieval stage: rewrite, dense, lexical, symbol, fuse, rerank, expand',
    unit: 'ms',
  }) as Histogram,
  retrievalTokensPerStage: meter.createHistogram('kna.retrieval.tokens', {
    description: 'Tokens contributed per stage — the context-budget instrument (§15.5)',
  }) as Histogram,
  retrievalAbstentions: meter.createCounter('kna.retrieval.abstentions', {
    description: 'Queries where evidence fell below the calibrated refusal threshold',
  }) as Counter,
  retrievalResults: meter.createHistogram('kna.retrieval.results', {
    description: 'Results returned after ACL filtering — zero results may be a permissions signal',
  }) as Histogram,

  // ── Provider health ──────────────────────────────────────────────────────────────────────
  providerRequests: meter.createCounter('kna.provider.requests', {
    description: 'LLM/embedding/rerank calls, by model, key class and status',
  }) as Counter,
  providerRateLimited: meter.createCounter('kna.provider.rate_limited', {
    description: '429s, by model and key class — batch must never starve interactive',
  }) as Counter,
  providerLatencyMs: meter.createHistogram('kna.provider.latency_ms', {
    description: 'Provider round-trip latency',
    unit: 'ms',
  }) as Histogram,

  // ── Cost ─────────────────────────────────────────────────────────────────────────────────
  tokenSpendUsd: meter.createCounter('kna.cost.usd', {
    description: 'Estimated spend, by org, workload and model — feeds chargeback (§15.8)',
  }) as Counter,

  // ── Guardrails ───────────────────────────────────────────────────────────────────────────
  secretsBlocked: meter.createCounter('kna.guardrail.secrets_blocked', {
    description: 'Secrets blocked pre-publish. Zero means the scanner is not working',
  }) as Counter,
  injectionFlagged: meter.createCounter('kna.guardrail.injection_flagged', {
    description: 'Injection patterns flagged at index time',
  }) as Counter,
  aclDenials: meter.createCounter('kna.guardrail.acl_denials', {
    description: 'Retrieval requests denied by the ACL filter',
  }) as Counter,
  breadthAnomalies: meter.createCounter('kna.guardrail.breadth_anomalies', {
    description: 'Identities touching an anomalous number of repos per hour (§15.4 exfiltration)',
  }) as Counter,
  circuitBreakerTrips: meter.createCounter('kna.guardrail.circuit_breaker_trips', {
    description: 'Magnitude circuit breaker trips, by rule',
  }) as Counter,
} as const;

/** Convenience wrapper that always records duration, including on the failure path. */
export async function timed<T>(
  histogram: Histogram,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    const result = await fn();
    histogram.record(performance.now() - started, { ...attributes, result: 'ok' });
    return result;
  } catch (error) {
    histogram.record(performance.now() - started, { ...attributes, result: 'error' });
    throw error;
  }
}
