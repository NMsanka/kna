import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KnaServer } from '../context.js';

/**
 * Serve the built web application.
 *
 * Hand-rolled rather than @fastify/static, which would be a dependency for two routes: one
 * prefix of build output, and one shell for everything else. The application is a single page,
 * so every path it owns has to return the same HTML and let the browser route — the alternative
 * is a server route per client route, which drifts the moment either side changes.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = resolve(HERE, '../../../web/dist');

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/** Paths the application owns in the browser. Anything else is left to the API's own routes. */
const APP_PATHS = ['/chat', '/admin'];

export async function registerWebStaticRoutes(app: KnaServer): Promise<void> {
  const shell = join(DIST, 'index.html');
  const built = await stat(shell).then(
    () => true,
    () => false,
  );

  if (!built) {
    // Not an error worth refusing to start over: the API is perfectly useful without a UI, and
    // the CLI and MCP server do not need one. Say so once, clearly, instead.
    app.log.warn(
      { expected: DIST },
      'web application is not built; /chat and /admin will 404 until `pnpm build` runs',
    );
    return;
  }

  app.get('/assets/*', async (request, reply) => {
    const requested = (request.params as { '*': string })['*'];
    // Resolve, then confirm the result is still inside the build directory. A path like
    // `../../.env` is a traversal, and joining before checking is how it succeeds.
    const file = resolve(DIST, requested);
    if (!file.startsWith(DIST)) return reply.code(404).send();

    try {
      const body = await readFile(file);
      return (
        reply
          .type(TYPES[extname(file)] ?? 'application/octet-stream')
          // The filenames are stable rather than hashed, so this must not be immutable. A short
          // cache keeps a reload cheap without pinning a stale bundle after a deploy.
          .header('cache-control', 'public, max-age=300')
          .send(body)
      );
    } catch {
      return reply.code(404).send();
    }
  });

  const html = await readFile(shell, 'utf8');
  for (const path of APP_PATHS) {
    for (const route of [path, `${path}/*`]) {
      app.get(route, async (_request, reply) =>
        reply.type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html),
      );
    }
  }

  app.log.info({ paths: APP_PATHS }, 'web application mounted');
}
