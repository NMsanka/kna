import { sql } from 'drizzle-orm';
import { anyOf, withOrgContext } from '@kna/db';
import type { ApiContext, KnaServer } from '../context.js';
import { createSessionTools, SESSION_TTL_MS, type WebSession } from './web-session.js';

/**
 * The web application, and the small JSON layer it talks to.
 *
 * The application never holds a token. Signing in exchanges one for an httpOnly cookie, and
 * every call here reads that cookie and forwards the request to the endpoint that already
 * existed. That is the point of the layer: a single-page application that kept a token in
 * `localStorage` would put a long-lived credential where any injected script could read it, and
 * §10 Layer 5 is explicit that the corpus is full of attacker-controllable text.
 *
 * Nothing here re-implements a rule. `ask` is `/v1/search`; the administrative routes are the
 * `/v1/admin/*` ones; the two listings are the queries the console already ran to draw its
 * tables. The ACL, the audit trail and the trace are all applied by those endpoints, exactly as
 * they are for the CLI and the editor.
 */

const COOKIE = 'kna_web';

export async function registerWebAppRoutes(app: KnaServer, ctx: ApiContext): Promise<void> {
  const sessions = createSessionTools(app, {
    secret: ctx.env.SESSION_SECRET,
    cookieName: COOKIE,
    path: '/',
    loginPath: '/',
  });

  /** 401 rather than a redirect: the caller is a script, and it decides what to show. */
  function requireSession(request: Parameters<typeof sessions.sessionOf>[0]): WebSession {
    const session = sessions.sessionOf(request);
    if (!session) {
      const error = new Error('Not signed in.') as Error & { statusCode?: number };
      error.statusCode = 401;
      throw error;
    }
    return session;
  }

  async function principalOf(session: WebSession): Promise<{ subject: string; isAdmin: boolean }> {
    const probe = await app.inject({
      method: 'GET',
      url: '/v1/scope',
      headers: { authorization: `Bearer ${session.token}` },
    });
    if (probe.statusCode >= 400) {
      const error = new Error('Not signed in.') as Error & { statusCode?: number };
      error.statusCode = 401;
      throw error;
    }
    // Whether the caller may administer is decided by trying an administrative read, not by
    // anything the browser claims. A non-administrator simply does not see those pages.
    const admin = await app.inject({
      method: 'GET',
      url: '/v1/admin/queues',
      headers: { authorization: `Bearer ${session.token}` },
    });
    const principal = await ctx.authenticateToken(session.token);
    return { subject: principal.subject, isAdmin: admin.statusCode < 400 };
  }

  // ── session ──────────────────────────────────────────────────────────────────────────────

  app.post('/app/api/login', async (request, reply) => {
    const token = String((request.body as { token?: string } | undefined)?.token ?? '').trim();
    if (!token) return reply.code(400).send({ error: { message: 'A token is required.' } });

    const session: WebSession = { token, expiresAt: Date.now() + SESSION_TTL_MS };
    let who: { subject: string; isAdmin: boolean };
    try {
      who = await principalOf(session);
    } catch {
      // Deliberately not "no such token" versus "expired": both are the same to someone who
      // does not already hold one.
      return reply.code(401).send({ error: { message: 'That token was not accepted.' } });
    }

    return sessions.setCookie(reply, session).send(who);
  });

  app.post('/app/api/logout', async (_request, reply) =>
    sessions.clearCookie(reply).send({ ok: true }),
  );

  app.get('/app/api/me', async (request) => principalOf(requireSession(request)));

  // ── chat ─────────────────────────────────────────────────────────────────────────────────

  app.get('/app/api/scope', async (request) => {
    const session = requireSession(request);
    const result = await sessions.call(session, 'GET', '/v1/scope');
    const projects = (result.data.projects ?? []) as Array<{ id: string; name: string }>;
    const repos = (result.data.repos ?? []) as Array<{
      id: string;
      name: string;
      indexed: boolean;
    }>;

    return {
      groups: [
        ...(projects.length
          ? [
              {
                label: 'Projects',
                options: projects.map((p) => ({ value: `project:${p.id}`, label: p.name })),
              },
            ]
          : []),
        ...(repos.length
          ? [
              {
                label: 'Repositories',
                options: repos.map((r) => ({
                  value: `repo:${r.id}`,
                  label: r.indexed ? r.name : `${r.name} — nothing indexed yet`,
                  disabled: !r.indexed,
                })),
              },
            ]
          : []),
        { label: null, options: [{ value: 'org', label: 'Everything I can read' }] },
      ],
    };
  });

  app.post('/app/api/ask', async (request, reply) => {
    const session = requireSession(request);
    const body = (request.body ?? {}) as {
      question?: string;
      scope?: string;
      everywhere?: boolean;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    };

    const question = String(body.question ?? '').trim();
    if (!question) return reply.code(400).send({ error: { message: 'A question is required.' } });

    const selected = String(body.scope ?? 'org');
    // The cross-repository view ignores the picker entirely: a stale value posted from the other
    // view would quietly narrow the one thing that exists to be wide.
    const scope = body.everywhere
      ? { kind: 'org' as const }
      : selected.startsWith('project:')
        ? { kind: 'project' as const, projectIds: [selected.slice('project:'.length)] }
        : selected.startsWith('repo:')
          ? { kind: 'repo' as const, repoIds: [selected.slice('repo:'.length)] }
          : { kind: 'org' as const };

    const result = await sessions.call(session, 'POST', '/v1/search', {
      query: question,
      scope,
      answer: true,
      // More evidence when the question is meant to span repositories: eight from one dense
      // ranking usually all come from whichever repository matched best.
      topN: body.everywhere ? 16 : 8,
      history: (body.history ?? []).slice(-16),
    });

    if (!result.ok) return reply.code(result.status).send(result.data);

    const answer = result.data.answer as {
      text: string;
      citations: Array<{ chunkId: string }>;
    } | null;
    const hits = (result.data.hits ?? []) as Array<{
      chunkId: string;
      provenance?: { repoId?: string };
    }>;
    const repoOfChunk = new Map(hits.map((h) => [h.chunkId, h.provenance?.repoId ?? null]));

    // Citations carry no repository, but hits do. Joined here because "which repositories did
    // this draw on" is the entire point of the cross-repository view.
    const names = await repoNames(session);
    return {
      answer: answer
        ? {
            ...answer,
            citations: answer.citations.map((c) => {
              const repoId = repoOfChunk.get(c.chunkId) ?? null;
              return { ...c, repo: repoId === null ? null : (names.get(repoId) ?? repoId) };
            }),
          }
        : {
            text: String(result.data.abstentionReason ?? 'No answer was produced.'),
            citations: [],
            abstained: true,
          },
    };
  });

  async function repoNames(session: WebSession): Promise<Map<string, string>> {
    const result = await sessions.call(session, 'GET', '/v1/scope');
    const repos = (result.data.repos ?? []) as Array<{ id: string; name: string }>;
    return new Map(repos.map((r) => [r.id, r.name]));
  }

  // ── administration ───────────────────────────────────────────────────────────────────────

  app.get('/app/api/repos', async (request) => {
    const session = requireSession(request);
    const principal = await ctx.authenticateToken(session.token);
    const access = await ctx.permissions.resolve(principal, { corpus: 'internal' });
    if (access.permittedRepoIds.length === 0) return { repos: [] };

    const rows = await withOrgContext(ctx.db, principal.orgId, async (tx) =>
      tx.execute<{
        id: string;
        name: string;
        remote: string;
        modules: string;
        symbols: string;
        documents: string;
      }>(sql`
        SELECT r.id, r.name, r.remote,
               (SELECT count(*)::text FROM modules m WHERE m.repo_id = r.id) AS modules,
               (SELECT count(*)::text FROM symbols s WHERE s.repo_id = r.id) AS symbols,
               (SELECT count(*)::text FROM documents d WHERE d.repo_id = r.id) AS documents
          FROM repos r
         WHERE r.org_id = ${principal.orgId} AND r.id = ${anyOf(access.permittedRepoIds)}
         ORDER BY r.name
      `),
    );

    return {
      repos: rows.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        remote: String(r.remote),
        modules: Number(r.modules),
        symbols: Number(r.symbols),
        documents: Number(r.documents),
      })),
    };
  });

  app.post('/app/api/repos', async (request, reply) => {
    const session = requireSession(request);
    const result = await sessions.call(session, 'POST', '/v1/admin/repos', request.body);
    return reply.code(result.ok ? 200 : result.status).send(result.data);
  });

  app.post<{ Params: { repoId: string } }>(
    '/app/api/repos/:repoId/credential',
    async (request, reply) => {
      const session = requireSession(request);
      const body = (request.body ?? {}) as { reason?: string };
      const result = await sessions.call(
        session,
        'POST',
        `/v1/admin/repos/${encodeURIComponent(request.params.repoId)}/ingest-credential`,
        { reason: body.reason ?? 'issued from the web application', ttlHours: 2 },
      );
      return reply.code(result.ok ? 200 : result.status).send(result.data);
    },
  );

  app.post('/app/api/reindex', async (request, reply) => {
    const session = requireSession(request);
    const body = (request.body ?? {}) as { repoId?: string; reason?: string };
    const result = await sessions.call(session, 'POST', '/v1/admin/reindex', {
      repoIds: [body.repoId],
      reason: body.reason ?? 'requested from the web application',
    });
    return reply.code(result.ok ? 200 : result.status).send(result.data);
  });

  app.get('/app/api/people', async (request) => {
    const session = requireSession(request);
    const principal = await ctx.authenticateToken(session.token);

    const rows = await withOrgContext(ctx.db, principal.orgId, async (tx) =>
      tx.execute<{
        id: string;
        subject: string;
        display_name: string | null;
        clearance: string;
        roles: string | null;
        repositories: string;
      }>(sql`
        SELECT p.id, p.subject, p.display_name, p.clearance,
               (SELECT string_agg(pr.role, ',') FROM principal_roles pr WHERE pr.principal_id = p.id) AS roles,
               (SELECT count(*)::text FROM repo_permissions rp WHERE rp.principal_id = p.id) AS repositories
          FROM principals p
         WHERE p.org_id = ${principal.orgId} AND p.disabled_at IS NULL
         ORDER BY p.subject
      `),
    );

    return {
      people: rows.map((p) => ({
        id: String(p.id),
        subject: String(p.subject),
        displayName: p.display_name === null ? null : String(p.display_name),
        clearance: String(p.clearance),
        roles: p.roles ? String(p.roles).split(',') : [],
        repositories: Number(p.repositories),
      })),
    };
  });

  app.post('/app/api/people', async (request, reply) => {
    const session = requireSession(request);
    const body = (request.body ?? {}) as {
      subject?: string;
      displayName?: string | null;
      clearance?: string;
      admin?: boolean;
      repoIds?: string[];
      reason?: string;
    };

    const result = await sessions.call(session, 'POST', '/v1/admin/principals', {
      subject: body.subject ?? '',
      displayName: body.displayName ?? null,
      clearance: body.clearance ?? 'internal',
      roles: body.admin ? ['admin'] : [],
      grantRepoIds: body.repoIds ?? [],
      reason: body.reason ?? '',
    });
    return reply.code(result.ok ? 200 : result.status).send(result.data);
  });
}
