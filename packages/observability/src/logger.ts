import pino, { type Logger } from 'pino';

/**
 * Structured logging with mandatory redaction.
 *
 * The redaction list is not cosmetic. §15.7 notes that "the LiteLLM proxy sees every prompt and
 * every retrieved chunk in cleartext — it is a tier-1 asset, not a sidecar", and the same is
 * true of anything that logs request bodies. Retrieved chunks are source-code-equivalent, so
 * they never reach a log line by default.
 */

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-kna-ingest-token"]',
  'headers.authorization',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'password',
  'secret',
  'privateKey',
  '*.token',
  '*.apiKey',
  '*.password',
  // Retrieved content and prompts: logged as ids and counts, never as text.
  'chunks',
  'chunkText',
  'sourceText',
  'prompt',
  'messages',
  '*.sourceText',
];

export interface LoggerOptions {
  service: string;
  level?: string;
  environment?: string;
  region?: string;
  pretty?: boolean;
}

export function createLogger(options: LoggerOptions): Logger {
  const base = {
    service: options.service,
    env: options.environment ?? process.env.KNA_ENV ?? 'development',
    region: options.region ?? process.env.KNA_REGION ?? 'local',
  };

  return pino({
    level: options.level ?? process.env.LOG_LEVEL ?? 'info',
    base,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(options.pretty
      ? { transport: { target: 'pino-pretty', options: { colorize: true, singleLine: false } } }
      : {}),
  });
}

export type { Logger };
