import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withOrgContext } from '@kna/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ApiContext, KnaServer } from '../context.js';
import { layout, page, escapeHtml } from './admin-ui/render.js';

/**
 * The administration console.
 *
 * Every action here already had an endpoint. What it did not have was a way to perform one
 * without composing a curl command with a bearer token and a JSON body — which is fine for the
 * person who wrote the endpoints and a wall for everyone else. Onboarding a repository or adding
 * a colleague should not require knowing the shape of a request.
 *
 * Server-rendered HTML, deliberately. This repository has no frontend build of any kind, and
 * adding a framework and a bundler for a handful of forms used by two or three people would
 * introduce a second deployable, a second dependency tree and a second thing to keep patched —
 * for pages that are a table and a form. Nothing here needs client-side state.
 *
 * **Authentication is interim and says so on the page.** It exchanges an existing API token for
 * a short-lived signed cookie. The destination is the company SSO login that §15.4 assumes and
 * that nothing has built yet; when it exists, this exchange is what it replaces. Until then, a
 * console reachable only by someone who already holds an admin token is a smaller risk than
 * administering the platform by hand-writing SQL, which is the alternative it removes.
 */

const COOKIE = 'kna_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

interface Session {
  token: string;
  expiresAt: number;
}

export async function registerAdminUiRoutes(app: KnaServer, ctx: ApiContext): Promise<void> {
  const secret = ctx.env.SESSION_SECRET;

  // HTML forms post `application/x-www-form-urlencoded`, which Fastify does not parse without
  // being told to. Done here rather than by adding @fastify/formbody: it is a dozen lines against
  // a dependency, and this is the only surface in the API that accepts a form at all.
  //
  // Repeated keys become an array, because a list of checkboxes — "which repositories may this
  // person read" — posts the same name several times, and collapsing that to the last value
  // would silently grant one repository instead of five.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, body, done) => {
      try {
        const params = new URLSearchParams(body as string);
        const parsed: Record<string, string | string[]> = {};
        for (const key of new Set(params.keys())) {
          const values = params.getAll(key);
          parsed[key] = values.length > 1 ? values : values[0]!;
        }
        done(null, parsed);
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  /**
   * A signed cookie carrying the caller's API token.
   *
   * The token itself is the credential — the cookie only saves retyping it, and is signed so a
   * forged one is rejected rather than trusted. `httpOnly` keeps it away from any script on the
   * page, and `sameSite: strict` means another site cannot cause a request that carries it,
   * which is what makes the state-changing forms below safe to post.
   */
  function sign(session: Session): string {
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    const mac = createHmac('sha256', secret).update(payload).digest('base64url');
    return `${payload}.${mac}`;
  }

  function verify(cookie: string | undefined): Session | null {
    if (!cookie) return null;
    const [payload, mac] = cookie.split('.');
    if (!payload || !mac) return null;

    const expected = createHmac('sha256', secret).update(payload).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session;
      return session.expiresAt > Date.now() ? session : null;
    } catch {
      return null;
    }
  }

  function sessionOf(request: FastifyRequest): Session | null {
    const header = request.headers.cookie ?? '';
    const match = header.split(';').find((c) => c.trim().startsWith(`${COOKIE}=`));
    return verify(match?.trim().slice(COOKIE.length + 1));
  }

  /** Call an endpoint of this same API, as the signed-in administrator. */
  async function call(
    session: Session,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
    const response = await app.inject({
      method: method as 'GET' | 'POST',
      url: path,
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
  }

  function redirect(reply: FastifyReply, to: string, flash?: string): FastifyReply {
    const query = flash ? `?flash=${encodeURIComponent(flash)}` : '';
    return reply.code(303).header('location', `${to}${query}`).send();
  }

  function requireSession(request: FastifyRequest, reply: FastifyReply): Session | null {
    const session = sessionOf(request);
    if (!session) {
      void redirect(reply, '/admin/login');
      return null;
    }
    return session;
  }

  // ── Sign in ──────────────────────────────────────────────────────────────────────────────

  app.get('/admin/login', async (_request, reply) =>
    reply.type('text/html').send(
      layout(
        'Sign in',
        `<form method="post" action="/admin/login" class="card narrow">
           <h1>KNA administration</h1>
           <p class="muted">Paste an API token that carries the administrator role.</p>
           <label for="token">API token</label>
           <input id="token" name="token" type="password" autocomplete="off" required
                  placeholder="kna_…">
           <button type="submit">Sign in</button>
           <p class="note">
             This exchanges your token for an eight-hour session cookie. It is a stand-in for the
             single sign-on that has not been built yet — which is the thing that should issue
             sessions here.
           </p>
         </form>`,
        { chrome: false },
      ),
    ),
  );

  app.post<{ Body: { token?: string } }>('/admin/login', async (request, reply) => {
    const token = String((request.body as { token?: string })?.token ?? '').trim();
    if (!token) return redirect(reply, '/admin/login');

    // Proven by use, not by inspection: the token has to actually work against an admin route.
    const probe = await app.inject({
      method: 'GET',
      url: '/v1/admin/queues',
      headers: { authorization: `Bearer ${token}` },
    });

    if (probe.statusCode >= 400) {
      return reply.type('text/html').send(
        layout(
          'Sign in',
          `<form method="post" action="/admin/login" class="card narrow">
             <h1>KNA administration</h1>
             <p class="error">That token is not valid, or does not carry the administrator role.</p>
             <label for="token">API token</label>
             <input id="token" name="token" type="password" autocomplete="off" required>
             <button type="submit">Sign in</button>
           </form>`,
          { chrome: false },
        ),
      );
    }

    const cookie = sign({ token, expiresAt: Date.now() + SESSION_TTL_MS });
    return reply
      .code(303)
      .header(
        'set-cookie',
        `${COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_TTL_MS / 1000}`,
      )
      .header('location', '/admin')
      .send();
  });

  app.post('/admin/logout', async (_request, reply) =>
    reply
      .code(303)
      .header('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0`)
      .header('location', '/admin/login')
      .send(),
  );

  // ── Overview ─────────────────────────────────────────────────────────────────────────────

  app.get<{ Querystring: { flash?: string } }>('/admin', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return reply;

    const principal = await ctx.authenticate({
      headers: { authorization: `Bearer ${session.token}` },
    } as FastifyRequest);

    const rows = await withOrgContext(ctx.db, principal.orgId, async (tx) =>
      tx.execute<{
        name: string;
        id: string;
        modules: number;
        symbols: number;
        documents: number;
      }>(sql`
        SELECT r.id, r.name,
               (SELECT count(*) FROM modules m WHERE m.repo_id = r.id) AS modules,
               (SELECT count(*) FROM symbols s WHERE s.repo_id = r.id) AS symbols,
               (SELECT count(*) FROM documents d WHERE d.repo_id = r.id) AS documents
          FROM repos r
         WHERE r.org_id = ${principal.orgId}
         ORDER BY r.name
      `),
    );

    const queues = await call(session, 'GET', '/v1/admin/queues');

    return reply.type('text/html').send(
      page('Overview', request.query.flash, [
        `<section class="card">
           <h2>Repositories</h2>
           ${
             rows.length === 0
               ? `<p class="muted">None registered yet.</p>`
               : `<table>
                    <thead><tr><th>Repository</th><th class="n">Modules</th><th class="n">Symbols</th><th class="n">Documents</th><th></th></tr></thead>
                    <tbody>${rows
                      .map(
                        (r) => `<tr>
                          <td><strong>${escapeHtml(String(r.name))}</strong><br><span class="mono muted">${escapeHtml(String(r.id))}</span></td>
                          <td class="n">${Number(r.modules)}</td>
                          <td class="n">${Number(r.symbols)}</td>
                          <td class="n">${Number(r.documents)}</td>
                          <td class="actions">
                            <form method="post" action="/admin/repos/credential">
                              <input type="hidden" name="repoId" value="${escapeHtml(String(r.id))}">
                              <button class="link" type="submit">Publish credential</button>
                            </form>
                            <form method="post" action="/admin/repos/reindex">
                              <input type="hidden" name="repoId" value="${escapeHtml(String(r.id))}">
                              <button class="link" type="submit">Reindex</button>
                            </form>
                          </td>
                        </tr>`,
                      )
                      .join('')}</tbody>
                  </table>`
           }
         </section>

         <section class="card">
           <h2>Register a repository</h2>
           <p class="muted">
             Grants you read access and checks the project slug exists. A slug that matches nothing
             is not an error — the repository still indexes — but it will answer nothing to
             project-scoped questions, so it is reported.
           </p>
           <form method="post" action="/admin/repos">
             <label for="remote">Git remote</label>
             <input id="remote" name="remote" required placeholder="https://github.com/you/service.git">
             <label for="projectSlugs">Project slugs, comma separated</label>
             <input id="projectSlugs" name="projectSlugs" placeholder="platform">
             <button type="submit">Register</button>
           </form>
         </section>

         <section class="card">
           <h2>Queues</h2>
           <pre class="mono small">${escapeHtml(JSON.stringify(queues.data, null, 2))}</pre>
         </section>`,
      ]),
    );
  });

  // ── Actions ──────────────────────────────────────────────────────────────────────────────

  app.post<{ Body: { remote?: string; projectSlugs?: string } }>(
    '/admin/repos',
    async (request, reply) => {
      const session = requireSession(request, reply);
      if (!session) return reply;

      const body = request.body as { remote?: string; projectSlugs?: string };
      const slugs = String(body.projectSlugs ?? '')
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean);

      const result = await call(session, 'POST', '/v1/admin/repos', {
        remote: String(body.remote ?? ''),
        projectSlugs: slugs,
        openPullRequest: false,
      });

      if (!result.ok) {
        return redirect(reply, '/admin', `Could not register: ${describe(result.data)}`);
      }

      const unknown = (result.data.unknownProjectSlugs as string[] | undefined) ?? [];
      const warning = unknown.length > 0 ? ` — unknown project slug: ${unknown.join(', ')}` : '';
      return redirect(reply, '/admin', `Registered ${String(result.data.repoId)}${warning}`);
    },
  );

  app.post<{ Body: { repoId?: string } }>('/admin/repos/reindex', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return reply;

    const repoId = String((request.body as { repoId?: string }).repoId ?? '');
    const result = await call(session, 'POST', '/v1/admin/reindex', {
      repoIds: [repoId],
      reason: 'requested from the administration console',
    });

    return redirect(
      reply,
      '/admin',
      result.ok
        ? `Queued ${String(result.data.moduleCount)} module(s) for reindexing`
        : `Reindex failed: ${describe(result.data)}`,
    );
  });

  /**
   * Minting a credential shows it once, on its own page.
   *
   * Not in a flash message: it is a secret, and a flash goes in the URL, which lands in browser
   * history and in any proxy log between here and the screen.
   */
  app.post<{ Body: { repoId?: string } }>('/admin/repos/credential', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return reply;

    const repoId = String((request.body as { repoId?: string }).repoId ?? '');
    const result = await call(session, 'POST', `/v1/admin/repos/${repoId}/ingest-credential`, {
      reason: 'issued from the administration console',
      ttlHours: 24,
    });

    if (!result.ok) {
      return redirect(reply, '/admin', `Could not mint a credential: ${describe(result.data)}`);
    }

    return reply.type('text/html').send(
      page('Publish credential', null, [
        `<section class="card">
           <h2>Publish credential for ${escapeHtml(repoId)}</h2>
           <p class="warn">
             Shown once. It is not stored anywhere it can be read back, so copy it now.
           </p>
           <pre class="secret mono">${escapeHtml(String(result.data.token))}</pre>
           <p class="muted">Expires ${escapeHtml(String(result.data.expiresAt))}.</p>
           <p class="note">
             Scoped to this one repository, and only able to publish. Where CI can reach an
             identity provider, prefer the OIDC exchange — a credential that outlives the job
             using it is the thing this replaces badly.
           </p>
           <a class="button" href="/admin">Back</a>
         </section>`,
      ]),
    );
  });

  // ── People ───────────────────────────────────────────────────────────────────────────────

  app.get<{ Querystring: { flash?: string } }>('/admin/people', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return reply;

    const principal = await ctx.authenticate({
      headers: { authorization: `Bearer ${session.token}` },
    } as FastifyRequest);

    const people = await withOrgContext(ctx.db, principal.orgId, async (tx) =>
      tx.execute<{
        subject: string;
        display_name: string | null;
        clearance: string;
        roles: string | null;
        repos: number;
        disabled_at: Date | null;
      }>(sql`
        SELECT p.subject, p.display_name, p.clearance, p.disabled_at,
               (SELECT string_agg(r.role, ', ') FROM principal_roles r WHERE r.principal_id = p.id) AS roles,
               (SELECT count(*) FROM repo_permissions rp WHERE rp.principal_id = p.id) AS repos
          FROM principals p
         WHERE p.org_id = ${principal.orgId}
         ORDER BY p.subject
      `),
    );

    const repos = await withOrgContext(ctx.db, principal.orgId, async (tx) =>
      tx.execute<{ id: string; name: string }>(sql`
        SELECT id, name FROM repos WHERE org_id = ${principal.orgId} ORDER BY name
      `),
    );

    return reply.type('text/html').send(
      page('People', request.query.flash, [
        `<section class="card">
           <h2>People</h2>
           <table>
             <thead><tr><th>Subject</th><th>Clearance</th><th>Roles</th><th class="n">Repositories</th></tr></thead>
             <tbody>${people
               .map(
                 (p) => `<tr>
                   <td><strong>${escapeHtml(String(p.subject))}</strong>${
                     p.disabled_at ? ' <span class="pill">disabled</span>' : ''
                   }${
                     p.display_name
                       ? `<br><span class="muted">${escapeHtml(String(p.display_name))}</span>`
                       : ''
                   }</td>
                   <td>${escapeHtml(String(p.clearance))}</td>
                   <td>${escapeHtml(String(p.roles ?? '—'))}</td>
                   <td class="n">${Number(p.repos)}</td>
                 </tr>`,
               )
               .join('')}</tbody>
           </table>
         </section>

         <section class="card">
           <h2>Add someone</h2>
           <p class="muted">
             Creates the person and issues one token, shown once. Use their single sign-on subject
             so that the same identity is found rather than duplicated when SSO login is built.
           </p>
           <form method="post" action="/admin/people">
             <label for="subject">Subject</label>
             <input id="subject" name="subject" required placeholder="alex@example.com">

             <label for="displayName">Display name</label>
             <input id="displayName" name="displayName" placeholder="Alex Smith">

             <label for="clearance">Clearance</label>
             <select id="clearance" name="clearance">
               <option value="public">public</option>
               <option value="internal" selected>internal</option>
               <option value="confidential">confidential</option>
             </select>

             <label><input type="checkbox" name="admin" value="1"> Administrator</label>

             <label>Repositories they may read</label>
             <div class="checks">
               ${repos
                 .map(
                   (r) =>
                     `<label class="check"><input type="checkbox" name="repoIds" value="${escapeHtml(String(r.id))}"> ${escapeHtml(String(r.name))}</label>`,
                 )
                 .join('')}
             </div>

             <label for="reason">Reason</label>
             <input id="reason" name="reason" required placeholder="joining the platform team">

             <button type="submit">Create and issue a token</button>
           </form>
         </section>`,
      ]),
    );
  });

  app.post('/admin/people', async (request, reply) => {
    const session = requireSession(request, reply);
    if (!session) return reply;

    const body = request.body as Record<string, string | string[] | undefined>;
    const repoIds = Array.isArray(body.repoIds) ? body.repoIds : body.repoIds ? [body.repoIds] : [];

    const result = await call(session, 'POST', '/v1/admin/principals', {
      subject: String(body.subject ?? ''),
      displayName: body.displayName ? String(body.displayName) : null,
      clearance: String(body.clearance ?? 'internal'),
      roles: body.admin ? ['admin'] : [],
      grantRepoIds: repoIds.map(String),
      reason: String(body.reason ?? ''),
    });

    if (!result.ok) {
      return redirect(reply, '/admin/people', `Could not create: ${describe(result.data)}`);
    }

    return reply.type('text/html').send(
      page('Token issued', null, [
        `<section class="card">
           <h2>Token for ${escapeHtml(String(result.data.subject))}</h2>
           <p class="warn">Shown once. It is stored only as a hash and cannot be recovered.</p>
           <pre class="secret mono">${escapeHtml(String(result.data.token))}</pre>
           <p class="muted">
             Granted read access to ${((result.data.grantedRepoIds as string[]) ?? []).length}
             repository(ies).
           </p>
           <a class="button" href="/admin/people">Back</a>
         </section>`,
      ]),
    );
  });
}

/** Pull something readable out of an error envelope. */
function describe(data: Record<string, unknown>): string {
  const error = data.error as { message?: string } | undefined;
  return error?.message ?? 'the request was refused';
}
