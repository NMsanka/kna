import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { KnaServer } from '../context.js';

/**
 * Browser sessions.
 *
 * The web application signs in by exchanging a token for one of these, so the token itself is
 * never in `localStorage` where an injected script could read it — and §10 Layer 5 is explicit
 * that the corpus is full of attacker-controllable text.
 *
 * **Authentication is interim and every page that uses it says so.** It exchanges an existing API
 * token for a short-lived signed cookie. The destination is the company SSO login that §15.4
 * assumes and that nothing has built yet; when it exists, this exchange is what it replaces.
 */

export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface WebSession {
  /** The caller's API token. The cookie only saves retyping it. */
  token: string;
  expiresAt: number;
}

export interface SessionTools {
  sign: (session: WebSession) => string;
  sessionOf: (request: FastifyRequest) => WebSession | null;
  /** Redirects to the surface's login page and returns null when there is no valid session. */
  requireSession: (request: FastifyRequest, reply: FastifyReply) => WebSession | null;
  setCookie: (reply: FastifyReply, session: WebSession) => FastifyReply;
  clearCookie: (reply: FastifyReply) => FastifyReply;
  redirect: (reply: FastifyReply, to: string, flash?: string) => FastifyReply;
  /** Call an endpoint of this same API as the signed-in caller. */
  call: (
    session: WebSession,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ) => Promise<{ ok: boolean; status: number; data: Record<string, unknown> }>;
}

export function createSessionTools(
  app: KnaServer,
  options: { secret: string; cookieName: string; path: string; loginPath: string },
): SessionTools {
  const { secret, cookieName, path, loginPath } = options;

  /**
   * The token is the credential; the cookie is signed so a forged one is rejected rather than
   * trusted. `httpOnly` keeps it away from any script on the page, and `sameSite=strict` means
   * another site cannot cause a request that carries it — which is what makes the
   * state-changing forms safe to post.
   */
  function sign(session: WebSession): string {
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    const mac = createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  function verify(cookie: string | undefined): WebSession | null {
    if (!cookie) return null;
    const [payload, mac] = cookie.split('.');
    if (!payload || !mac) return null;

    const expected = createHmac('sha256', secret).update(payload).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as WebSession;
      return session.expiresAt > Date.now() ? session : null;
    } catch {
      return null;
    }
  }

  function sessionOf(request: FastifyRequest): WebSession | null {
    const header = request.headers.cookie ?? '';
    const match = header.split(';').find((c) => c.trim().startsWith(`${cookieName}=`));
    return verify(match?.trim().slice(cookieName.length + 1));
  }

  function redirect(reply: FastifyReply, to: string, flash?: string): FastifyReply {
    const query = flash ? `?flash=${encodeURIComponent(flash)}` : '';
    return reply.code(303).header('location', `${to}${query}`).send();
  }

  return {
    sign,
    sessionOf,
    redirect,

    setCookie: (reply, session) =>
      reply.header(
        'set-cookie',
        `${cookieName}=${sign(session)}; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=${
          SESSION_TTL_MS / 1000
        }`,
      ),

    clearCookie: (reply) =>
      reply.header(
        'set-cookie',
        `${cookieName}=; HttpOnly; SameSite=Strict; Path=${path}; Max-Age=0`,
      ),

    requireSession: (request, reply) => {
      const session = sessionOf(request);
      if (!session) {
        void redirect(reply, loginPath);
        return null;
      }
      return session;
    },

    call: async (session, method, requestPath, body) => {
      const response = await app.inject({
        method,
        url: requestPath,
        headers: {
          authorization: `Bearer ${session.token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });

      let data: Record<string, unknown> = {};
      try {
        data = response.json() as Record<string, unknown>;
      } catch {
        data = {};
      }
      return { ok: response.statusCode < 400, status: response.statusCode, data };
    },
  };
}
