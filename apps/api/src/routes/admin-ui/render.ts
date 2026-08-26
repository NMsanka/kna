/**
 * Markup for the administration console.
 *
 * Kept apart from the routes so the handlers read as what they do rather than as string
 * concatenation, and so there is exactly one place that escapes user-supplied text.
 */

/**
 * Escape before interpolation, always.
 *
 * Repository names, subjects and error messages all reach these pages, and all of them come from
 * somewhere a person typed. This console is the one surface that renders them as HTML rather
 * than returning them as JSON, so it is the one place where a stored `<script>` would matter.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLES = `
  /*
   * Palette taken from the Confirma Software deck.
   *
   * Its theme1.xml is stock Office, so the real colours are the ones the slides use: a warm
   * near-black ground (#2E2C2A), warm off-whites for text (#E7E3E2, #CFC8C5), a cool grey-purple
   * for secondary text on light (#717182), and a bright green (#66BE2B) as the one accent.
   *
   * Two colours are darkened rather than copied, because the deck uses them as fills and this
   * uses them as text. #66BE2B on a light ground is 2.15:1 — fine behind white type on a slide,
   * unreadable as a citation link. #3E7A1A is the same hue at 4.81:1. #717182 lands at 4.39:1,
   * just under the threshold, so it is darkened to #5F5F70. On the dark ground the deck's own
   * values are already strong (#66BE2B is 5.94:1) and are used unchanged.
   */
  :root {
    --ground: #f5f5f6; --card: #ffffff; --ink: #2e2c2a; --muted: #5f5f70;
    --rule: #d6d8db; --accent: #3e7a1a; --warn: #8c3f1d; --shade: #eceded;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #2e2c2a; --card: #3a3733; --ink: #e7e3e2; --muted: #cfc8c5;
      --rule: #4a4642; --accent: #66be2b; --warn: #d9915f; --shade: #45413c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--ground); color: var(--ink);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 900px; margin: 0 auto; padding: 2rem 1.25rem 5rem; }
  header.bar {
    display: flex; align-items: baseline; gap: 1.5rem;
    border-bottom: 1px solid var(--rule); padding: 1.25rem 0; margin-bottom: 2rem;
  }
  header.bar .brand { font-weight: 600; letter-spacing: -0.01em; }
  header.bar nav { display: flex; gap: 1rem; flex: 1; }
  header.bar a { color: var(--muted); text-decoration: none; }
  header.bar a:hover, header.bar a.on { color: var(--ink); }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  h2 { font-size: 1.05rem; margin: 0 0 0.75rem; }
  .card {
    background: var(--card); border: 1px solid var(--rule); border-radius: 4px;
    padding: 1.5rem; margin-bottom: 1.5rem;
  }
  .card.narrow { max-width: 420px; margin: 4rem auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
  th, td { text-align: left; padding: 0.6rem 0.75rem 0.6rem 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
  th { font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); font-weight: 600; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  td.actions { text-align: right; white-space: nowrap; }
  td.actions form { display: inline; }
  label { display: block; font-size: 0.85rem; color: var(--muted); margin: 1rem 0 0.3rem; }
  label.check { display: block; margin: 0.25rem 0; color: var(--ink); font-size: 0.9rem; }
  input[type=text], input[type=password], input:not([type]), select {
    width: 100%; padding: 0.55rem 0.7rem; border: 1px solid var(--rule);
    border-radius: 3px; background: var(--ground); color: var(--ink); font: inherit;
  }
  .checks { max-height: 12rem; overflow-y: auto; border: 1px solid var(--rule); border-radius: 3px; padding: 0.5rem 0.75rem; }
  button {
    margin-top: 1.25rem; padding: 0.55rem 1.1rem; border: 0; border-radius: 3px;
    background: var(--accent); color: #fff; font: inherit; font-weight: 500; cursor: pointer;
  }
  button.link {
    margin: 0 0 0 0.75rem; padding: 0; background: none; color: var(--accent);
    font-weight: 400; text-decoration: underline; cursor: pointer;
  }
  a.button { display: inline-block; margin-top: 1.25rem; color: var(--accent); }
  .muted { color: var(--muted); }
  .mono { font-family: ui-monospace, "Cascadia Mono", Menlo, monospace; }
  .small { font-size: 0.82rem; }
  .note { font-size: 0.85rem; color: var(--muted); margin-top: 1.25rem; }
  .warn { color: var(--warn); font-weight: 500; }
  .error { color: var(--warn); }
  .pill { font-size: 0.7rem; background: var(--shade); padding: 0.1rem 0.4rem; border-radius: 999px; color: var(--muted); }
  .secret { background: var(--shade); padding: 1rem; border-radius: 3px; overflow-x: auto; word-break: break-all; white-space: pre-wrap; }
  pre { overflow-x: auto; }
  .flash { background: var(--shade); border-left: 3px solid var(--accent); padding: 0.85rem 1.1rem; margin-bottom: 1.5rem; border-radius: 0 3px 3px 0; }
  .banner { background: var(--shade); border-left: 3px solid var(--warn); padding: 0.85rem 1.1rem; margin-bottom: 1.5rem; font-size: 0.88rem; border-radius: 0 3px 3px 0; }
`;

export function layout(title: string, body: string, options: { chrome?: boolean } = {}): string {
  const chrome = options.chrome !== false;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — KNA</title>
<style>${STYLES}</style>
</head><body><div class="wrap">
${
  chrome
    ? `<header class="bar">
         <span class="brand">KNA</span>
         <nav>
           <a href="/admin">Repositories</a>
           <a href="/admin/people">People</a>
           <a href="/chat">Chat</a>
         </nav>
         <form method="post" action="/admin/logout"><button class="link" type="submit">Sign out</button></form>
       </header>`
    : ''
}
${body}
</div></body></html>`;
}

export function page(title: string, flash: string | null | undefined, sections: string[]): string {
  const banner = `<div class="banner">
    Sessions here are an API token exchanged for a cookie, not single sign-on. Anyone reaching
    this console with an administrator token can act as one — put it behind your network, and
    replace this with SSO before it is generally available.
  </div>`;

  return layout(
    title,
    `${banner}${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ''}${sections.join('')}`,
  );
}
