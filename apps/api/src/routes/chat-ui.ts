import type { ApiContext, KnaServer } from '../context.js';
import { createSessionTools, SESSION_TTL_MS, type WebSession } from './web-session.js';
import { chatLayout, escapeHtml } from './chat-ui/render.js';

/**
 * The chat surface.
 *
 * ADR 0001 defers the documentation *site* and the *external* assistant. The internal assistant
 * is on its build list, and this is it: a place a developer on any team can ask a question about
 * code they are allowed to read, and get an answer that cites the lines it came from.
 *
 * It adds no retrieval logic. `/v1/search` already takes a scope, a conversation history and an
 * `answer` flag, and already applies the ACL as a hard SQL predicate, audits by chunk id and
 * records a replayable trace. This surface composes those; if it were doing anything clever with
 * retrieval, that would be a bug rather than a feature.
 *
 * Server-rendered, and it works with JavaScript switched off. The whole conversation is a form
 * post that re-renders the page. That is not a limitation to apologise for — it means no bundler,
 * no second deployable, and no client-side state to get out of step with the server's idea of
 * who you are.
 */

const COOKIE = 'kna_chat';

/** Bounded so the payload cannot grow without limit; the contract caps history at 20 entries. */
const MAX_TURNS = 8;

interface Turn {
  question: string;
  answer: string;
  citations: Citation[];
  abstained: boolean;
  note: string | null;
}

interface Citation {
  marker: number;
  qualifiedName: string | null;
  path: string | null;
  startLine: number | null;
  analysisDepth: string;
}

interface ScopeChoice {
  value: string;
  label: string;
}

export async function registerChatUiRoutes(app: KnaServer, ctx: ApiContext): Promise<void> {
  const sessions = createSessionTools(app, {
    secret: ctx.env.SESSION_SECRET,
    cookieName: COOKIE,
    path: '/chat',
    loginPath: '/chat/login',
  });

  // ── Sign in ──────────────────────────────────────────────────────────────────────────────

  app.get('/chat/login', async (request, reply) => {
    const failed = (request.query as { failed?: string } | undefined)?.failed;
    return reply.type('text/html').send(
      chatLayout(
        'Sign in',
        `<form method="post" action="/chat/login" class="card narrow">
           <h1>Ask about our code</h1>
           <p class="muted small">
             Paste your KNA token. You will only ever be shown code you already have permission
             to read.
           </p>
           ${failed ? '<p class="note">That token was not accepted.</p>' : ''}
           <label for="token">API token</label>
           <input id="token" name="token" type="password" required autocomplete="off"
                  placeholder="kna_…">
           <button type="submit">Sign in</button>
           <p class="muted small" style="margin-top:1.25rem">
             A stand-in for single sign-on, which is not built yet. The token is exchanged for an
             eight-hour cookie so you do not retype it.
           </p>
         </form>`,
        false,
      ),
    );
  });

  app.post('/chat/login', async (request, reply) => {
    const token = String((request.body as { token?: string } | undefined)?.token ?? '').trim();
    if (!token) return sessions.redirect(reply, '/chat/login', undefined);

    // Prove the token works before handing out a cookie for it, so a bad token fails here
    // rather than on the first question.
    const probe = await sessions.call(
      { token, expiresAt: Date.now() + 60_000 },
      'GET',
      '/v1/scope',
    );
    if (!probe.ok) {
      return reply.code(303).header('location', '/chat/login?failed=1').send();
    }

    const session: WebSession = { token, expiresAt: Date.now() + SESSION_TTL_MS };
    return sessions.setCookie(reply, session).code(303).header('location', '/chat').send();
  });

  app.post('/chat/logout', async (_request, reply) =>
    sessions.clearCookie(reply).code(303).header('location', '/chat/login').send(),
  );

  // ── The conversation ─────────────────────────────────────────────────────────────────────

  app.get('/chat', async (request, reply) => {
    const session = sessions.requireSession(request, reply);
    if (!session) return reply;

    const choices = await scopeChoices(session);
    return reply
      .type('text/html')
      .send(renderPage({ turns: [], choices, selected: choices[0]?.value ?? 'org' }));
  });

  app.post('/chat', async (request, reply) => {
    const session = sessions.requireSession(request, reply);
    if (!session) return reply;

    const body = (request.body ?? {}) as Record<string, string | string[]>;
    const question = String(body.question ?? '').trim();
    const selected = String(body.scope ?? 'org');
    const turns = decodeTurns(String(body.turns ?? ''));
    const choices = await scopeChoices(session);

    if (!question) {
      return reply.type('text/html').send(renderPage({ turns, choices, selected }));
    }

    // The history is a hidden field, so a caller can edit it. That is deliberate and safe: it
    // only steers the query rewrite, exactly as retyping the question would. What a caller may
    // read is resolved from the token on the server and cannot be influenced from this page.
    const history = turns
      .flatMap((t) => [
        { role: 'user' as const, content: t.question },
        { role: 'assistant' as const, content: t.answer },
      ])
      .slice(-(MAX_TURNS * 2));

    const scope = selected.startsWith('project:')
      ? { kind: 'project' as const, projectIds: [selected.slice('project:'.length)] }
      : { kind: 'org' as const };

    const result = await sessions.call(session, 'POST', '/v1/search', {
      query: question,
      scope,
      answer: true,
      topN: 8,
      history,
    });

    turns.push(turnFrom(question, result));
    return reply
      .type('text/html')
      .send(renderPage({ turns: turns.slice(-MAX_TURNS), choices, selected }));
  });

  // ── helpers ──────────────────────────────────────────────────────────────────────────────

  /** Only projects this caller can actually read; see the comment on `GET /v1/scope`. */
  async function scopeChoices(session: WebSession): Promise<ScopeChoice[]> {
    const result = await sessions.call(session, 'GET', '/v1/scope');
    const projects = (result.data.projects ?? []) as Array<{ id: string; name: string }>;
    return [
      ...projects.map((p) => ({ value: `project:${p.id}`, label: p.name })),
      { value: 'org', label: 'Everything I can read' },
    ];
  }
}

function turnFrom(question: string, result: { ok: boolean; data: Record<string, unknown> }): Turn {
  if (!result.ok) {
    return {
      question,
      answer:
        'Something went wrong asking that. If it keeps happening, the trace id in the server log will say why.',
      citations: [],
      abstained: true,
      note: null,
    };
  }

  const answer = result.data.answer as {
    text: string;
    citations: Citation[];
    abstained: boolean;
    hedged: boolean;
    hedgingReason: string | null;
  } | null;

  if (!answer) {
    return {
      question,
      answer: String(result.data.abstentionReason ?? 'No answer was produced.'),
      citations: [],
      abstained: true,
      note: null,
    };
  }

  return {
    question,
    answer: answer.text,
    citations: answer.citations ?? [],
    abstained: answer.abstained,
    note: answer.hedged ? answer.hedgingReason : null,
  };
}

/**
 * Turn `[1]` in the answer into a link to the matching source.
 *
 * Escaping happens first and the markers are matched in the escaped string, so nothing the model
 * or the corpus produced can introduce markup here.
 */
function withCitationLinks(text: string, index: number): string {
  return escapeHtml(text)
    .replace(/\[(\d+)\]/g, (_m, n: string) => `<a class="cite" href="#s${index}-${n}">${n}</a>`)
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function renderPage(input: { turns: Turn[]; choices: ScopeChoice[]; selected: string }): string {
  const { turns, choices, selected } = input;

  const banner = `<div class="banner">
    Answers come from the code you are allowed to read, and cite the lines they came from.
    Check anything you are about to act on — a citation is there so you can.
  </div>`;

  const conversation = turns.length
    ? turns.map((turn, i) => renderTurn(turn, i)).join('')
    : `<div class="empty">
         <p>Ask about how something works, where it is implemented, or why it was built that way.</p>
         <p class="small">“How does billing retry a failed charge?”</p>
       </div>`;

  const options = choices
    .map(
      (c) =>
        `<option value="${escapeHtml(c.value)}"${c.value === selected ? ' selected' : ''}>${escapeHtml(
          c.label,
        )}</option>`,
    )
    .join('');

  const composer = `<form method="post" action="/chat" class="ask">
      <div class="inner">
        <div style="flex:1">
          <div class="scoped">
            <label for="scope" style="margin:0">Ask about</label>
            <select id="scope" name="scope">${options}</select>
          </div>
          <textarea name="question" rows="2" required autofocus
                    placeholder="How does …?"></textarea>
        </div>
        <button type="submit">Ask</button>
      </div>
      <input type="hidden" name="turns" value="${escapeHtml(encodeTurns(input.turns))}">
    </form>`;

  return chatLayout('Chat', `${banner}${conversation}${composer}`);
}

function renderTurn(turn: Turn, index: number): string {
  // No hedging note here on purpose. `synthesiseAnswer` forces the caveat into the answer text
  // itself, so repeating it above the answer said the same thing twice.

  // Only the evidence the answer actually cites. The response carries everything that was put
  // in front of the model; numbering all of it under "sources" claims eight citations for an
  // answer that made one, which is the opposite of what the citations are for.
  const referenced = new Set([...turn.answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])));
  const cited = turn.citations.filter((c) => referenced.has(c.marker));

  const sources = cited.length
    ? `<div class="sources">
         <div class="heading">${cited.length === 1 ? 'Source' : 'Sources'}</div>
         <ol>
           ${cited
             .map(
               (c) =>
                 `<li id="s${index}-${c.marker}">
                    ${escapeHtml(c.qualifiedName ?? 'evidence')}
                    <span class="where">${escapeHtml(c.path ?? 'unknown')}${
                      c.startLine === null ? '' : `:${c.startLine}`
                    }</span>
                    ${c.analysisDepth === 'shallow' ? '<span class="depth">shallow</span>' : ''}
                  </li>`,
             )
             .join('')}
         </ol>
       </div>`
    : '';

  return `<div class="turn">
      <div class="said">${escapeHtml(turn.question)}</div>
      <div class="replied${turn.abstained ? ' abstained' : ''}">
        ${withCitationLinks(turn.answer, index)}${sources}
      </div>
    </div>`;
}

/**
 * The conversation travels in the page rather than in server-side state.
 *
 * A session store would be a second thing to expire, size and clear down, for a surface where
 * the whole conversation is a few kilobytes and losing it costs a reload.
 */
function encodeTurns(turns: Turn[]): string {
  return Buffer.from(JSON.stringify(turns.slice(-MAX_TURNS))).toString('base64url');
}

function decodeTurns(encoded: string): Turn[] {
  if (!encoded) return [];
  try {
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Turn[];
    return Array.isArray(parsed) ? parsed.slice(-MAX_TURNS) : [];
  } catch {
    return [];
  }
}
