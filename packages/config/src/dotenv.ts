import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Load a `.env` file into `process.env`, for local development.
 *
 * Deliberately hand-rolled rather than pulling in `dotenv`: the parsing is thirty lines, and the
 * two behaviours that matter here are ones the popular libraries get wrong by default.
 *
 * **Real environment always wins.** A value already present in `process.env` is never
 * overwritten. In CI and in a container, configuration comes from the orchestrator or a secrets
 * manager; a `.env` that shadowed those would mean a developer's stale local file could quietly
 * override a production setting if it ever got baked into an image.
 *
 * **Production does not read files.** §15.7 requires KMS/HSM-backed secret storage with "no key
 * material in environment variables or images". A `.env` on disk in production is the opposite
 * of that, so it is refused rather than merely discouraged.
 */

export interface LoadDotEnvOptions {
  /** Directory to start searching from. Defaults to the current working directory. */
  cwd?: string;
  /** File name to look for. */
  filename?: string;
  /** How many parent directories to search. Covers running from a package inside the monorepo. */
  maxDepth?: number;
  env?: NodeJS.ProcessEnv;
}

export interface LoadDotEnvResult {
  /** Absolute path of the file that was read, or null when none was found. */
  path: string | null;
  /** Keys applied to `process.env`. Excludes keys that were already set. */
  applied: string[];
  /** Keys present in the file but skipped because the real environment already had them. */
  skipped: string[];
}

export function loadDotEnv(options: LoadDotEnvOptions = {}): LoadDotEnvResult {
  const env = options.env ?? process.env;
  const empty: LoadDotEnvResult = { path: null, applied: [], skipped: [] };

  // Production configuration comes from the orchestrator and a secrets manager, never a file
  // committed alongside the code or left in an image layer.
  if (env.KNA_ENV === 'production') return empty;
  if (env.KNA_DISABLE_DOTENV) return empty;

  const path = findUp(
    options.filename ?? '.env',
    options.cwd ?? process.cwd(),
    options.maxDepth ?? 5,
  );
  if (!path) return empty;

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const [key, value] of Object.entries(parseDotEnv(readFileSync(path, 'utf8')))) {
    if (env[key] !== undefined) {
      skipped.push(key);
      continue;
    }
    env[key] = value;
    applied.push(key);
  }

  return { path, applied, skipped };
}

/** Walk upwards so `pnpm --filter @kna/api dev` finds the monorepo-root `.env`. */
function findUp(filename: string, from: string, maxDepth: number): string | null {
  let current = resolve(from);

  for (let depth = 0; depth <= maxDepth; depth++) {
    const candidate = join(current, filename);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

/**
 * Parse `KEY=value` lines.
 *
 * Supports comments, blank lines, `export ` prefixes, single and double quotes, and escape
 * sequences inside double quotes only — matching shell semantics, where a single-quoted string
 * is literal. Values are not interpolated: `${OTHER}` stays as written, because a config file
 * that silently expands variables makes a missing one look like an empty string.
 */
export function parseDotEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1]!;
    let value = match[2] ?? '';

    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value
        .slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\');
    } else if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1);
    } else {
      // Unquoted: an inline comment ends the value, as in a shell.
      const comment = value.indexOf(' #');
      if (comment >= 0) value = value.slice(0, comment);
      value = value.trim();
    }

    out[key] = value;
  }

  return out;
}
