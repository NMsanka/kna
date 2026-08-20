import { trace, context, SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';

/**
 * Tracing helpers.
 *
 * §15.6 — "correlate the Langfuse trace ID with the OTel span ID at the API edge, or you will
 * have two disjoint views of the same request mid-incident." `withSpan` puts both ids on the
 * span so a Langfuse trace and an OTel trace are joinable from either side.
 */

const tracer: Tracer = trace.getTracer('kna-platform', '1.0.0');

export interface SpanOptions {
  attributes?: Record<string, string | number | boolean>;
  /** Langfuse trace id, so LLM observability and distributed tracing reconcile. */
  llmTraceId?: string;
}

export async function withSpan<T>(
  name: string,
  options: SpanOptions,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer.startActiveSpan(name, async (span) => {
    if (options.attributes) span.setAttributes(options.attributes);
    if (options.llmTraceId) span.setAttribute('llm.trace_id', options.llmTraceId);

    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      if (error instanceof Error) span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Current trace id, for stamping onto audit records and query traces. */
export function currentTraceId(): string | null {
  return trace.getSpan(context.active())?.spanContext().traceId ?? null;
}

export { tracer, trace, context, SpanStatusCode };
export type { Span };
