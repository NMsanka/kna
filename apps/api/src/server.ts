import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { IR_SCHEMA_VERSION } from '@kna/ir';
import { computeConfigVersion, DEFAULT_RETRIEVAL_CONFIG, AccessDeniedError } from '@kna/retrieval';
import { installGracefulShutdown } from '@kna/observability';
import { assertRlsEffective } from '@kna/db';
import { createApiContext, type ApiContext, type KnaServer } from './context.js';
import { AuthError } from './auth.js';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerWebhookRoutes } from './routes/webhooks.js';

/**
 * The platform API.
 *
 * §3.2 — "the platform is a conventional web service, deliberately. There is nothing exotic
 * here — a queue, workers, Postgres, an API. Resist the urge to make the infrastructure
 * interesting; the interesting part is the IR and the retrieval quality."
 *
 * So this file is short and boring on purpose. What is not boring, and is therefore explicit:
 * error mapping that never leaks whether a resource exists, health endpoints that do not depend
 * on external providers, and drain semantics that let a rolling deploy finish in-flight work.
 */

export async function buildServer(ctx: ApiContext): Promise<KnaServer> {
  const app = Fastify({
    // `loggerInstance`, not `logger`: Fastify 5 takes a *configuration object* under `logger`
    // and an already-constructed instance under `loggerInstance`. Passing a pino instance to
    // the former throws at construction.
    loggerInstance: ctx.logger,
    // Bounded so a hostile or misconfigured client cannot force a large allocation before the
    // signature check. Bundles are large; everything else is not.
    bodyLimit: ctx.env.INGEST_MAX_BUNDLE_BYTES,
    trustProxy: true,
    genReqId: () => crypto.randomUUID(),
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: ctx.env.KNA_ENV === 'development' ? true : false,
    credentials: true,
  });

  /**
   * §10 Layer 6 — "rate-limit the external assistant per API key, and alert on anomalous
   * enumeration patterns." §15.6 adds per-tenant QPS limits on MCP, because "agents retry far
   * more aggressively than humans".
   */
  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (request) => {
      const auth = request.headers.authorization;
      return auth ? `t:${auth.slice(-16)}` : `ip:${request.ip}`;
    },
    errorResponseBuilder: () => ({
      error: {
        code: 'rate_limited',
        message: 'Too many requests.',
        guidance: 'Back off and retry. Automated clients should respect Retry-After.',
      },
    }),
  });

  // ── Health. Liveness never touches a dependency; readiness never touches a provider. ───────
  app.get('/health/live', async () => ctx.health.liveness());

  app.get('/health/ready', async (_request, reply) => {
    const readiness = await ctx.health.readiness();
    return reply.code(readiness.status === 'ready' ? 200 : 503).send({
      status:
        readiness.status === 'ready'
          ? readiness.degradedModes.length
            ? 'degraded'
            : 'ok'
          : 'not-ready',
      version: '1.0.0',
      irSchemaVersion: IR_SCHEMA_VERSION,
      retrievalConfigVersion: computeConfigVersion(DEFAULT_RETRIEVAL_CONFIG).version,
      degradedModes: readiness.degradedModes,
      dependencies: readiness.dependencies.map((d) => ({
        name: d.name,
        kind: d.kind,
        state: d.state,
      })),
    });
  });

  // ── Routes ────────────────────────────────────────────────────────────────────────────────
  await registerIngestRoutes(app, ctx);
  await registerSearchRoutes(app, ctx);
  await registerAdminRoutes(app, ctx);
  await registerWebhookRoutes(app, ctx);

  /**
   * Error mapping.
   *
   * The rule: never let the shape of an error reveal whether something exists. §15.7 — "return
   * uniformly shaped refusals" — is written about the external assistant, but a 404 that
   * distinguishes "no such repo" from "no access to that repo" is the same oracle internally.
   */
  app.setErrorHandler((error, request, reply) => {
    const traceId = String(request.id);

    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'Request body failed validation.',
          guidance: error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          traceId,
        },
      });
    }

    if (error instanceof AuthError) {
      return reply.code(error.status).send({
        error: { code: error.code, message: error.message, guidance: null, traceId },
      });
    }

    if (error instanceof AccessDeniedError) {
      // Deliberately identical in shape to an empty result set.
      return reply.code(403).send({
        error: {
          code: 'access_denied',
          message: 'No results matched that query in the current scope.',
          guidance: null,
          traceId,
        },
      });
    }

    const fastifyError = error as { message: string; stack?: string; statusCode?: number };
    ctx.logger.error(
      { err: fastifyError.message, stack: fastifyError.stack, traceId },
      'unhandled error',
    );

    return reply.code(fastifyError.statusCode ?? 500).send({
      error: {
        code: 'internal_error',
        message: 'The request could not be completed.',
        guidance: null,
        traceId,
      },
    });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: {
        code: 'not_found',
        message: 'No such endpoint.',
        guidance: null,
        traceId: String(request.id),
      },
    }),
  );

  return app;
}

async function main(): Promise<void> {
  const ctx = await createApiContext();

  // Two startup assertions, both deliberately fatal. A deployment that silently lost tenant
  // isolation, or that will silently drop queued work, should not start.
  await assertRlsEffective(ctx.db);
  await assertRlsEffective(ctx.dbBatch);
  await ctx.queue.assertConfiguration();

  const app = await buildServer(ctx);

  installGracefulShutdown(
    [
      { name: 'http', drain: async () => void (await app.close()) },
      { name: 'platform', drain: () => ctx.shutdown() },
    ],
    { timeoutMs: 25_000, onLog: (message) => ctx.logger.info(message) },
  );

  await app.listen({ port: ctx.env.PORT, host: '0.0.0.0' });
  ctx.logger.info(
    {
      port: ctx.env.PORT,
      env: ctx.env.KNA_ENV,
      region: ctx.env.KNA_REGION,
      writeEnabled: ctx.env.WRITE_ENABLED,
      irSchemaVersion: IR_SCHEMA_VERSION,
    },
    'kna-api listening',
  );
}

if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
}
