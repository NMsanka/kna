import { escapeHtml } from '../admin-ui/render.js';

export { escapeHtml };

/**
 * Markup for the chat surface.
 *
 * Kept apart from the routes for the same reason the console's is: so the handlers read as what
 * they do rather than as string concatenation, and so there is one place that escapes text.
 *
 * Escaping matters more here than anywhere else in the platform. Everything on this page —
 * the question, the answer, the evidence behind it — is either typed by a person or extracted
 * from a repository, and §10 Layer 5 is explicit that retrieved content is attacker-controllable.
 * Every interpolation below goes through `escapeHtml`, without exception.
 */

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
    --ground: #f5f5f6; --panel: #ffffff; --ink: #2e2c2a; --muted: #5f5f70;
    --rule: #d6d8db; --accent: #3e7a1a; --accent-soft: #e9f3e1; --warn: #8c3f1d;
    --mine: #e7e3e2;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --ground: #2e2c2a; --panel: #3a3733; --ink: #e7e3e2; --muted: #cfc8c5;
      --rule: #4a4642; --accent: #66be2b; --accent-soft: #2c3a22; --warn: #d9915f;
      --mine: #45413c;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--ground); color: var(--ink);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  /* Clears the fixed composer, which is about 150px tall with its scope row. */
  .shell { max-width: 900px; margin: 0 auto; padding: 0 1.25rem 12rem; }
  header.bar {
    display: flex; align-items: baseline; gap: 1.25rem; flex-wrap: wrap;
    border-bottom: 1px solid var(--rule); padding: 1.1rem 0; margin-bottom: 1.75rem;
  }
  header.bar .brand { font-weight: 600; letter-spacing: -0.01em; }
  header.bar .who { color: var(--muted); font-size: 0.85rem; flex: 1; }
  header.bar a { color: var(--muted); text-decoration: none; font-size: 0.88rem; }
  header.bar a:hover { color: var(--ink); }
  h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
  .card { background: var(--panel); border: 1px solid var(--rule); border-radius: 4px; padding: 1.5rem; }
  .card.narrow { max-width: 430px; margin: 4rem auto; }
  label { display: block; font-size: 0.85rem; color: var(--muted); margin: 1rem 0 0.3rem; }
  input[type=text], input[type=password], select, textarea {
    width: 100%; padding: 0.6rem 0.7rem; border: 1px solid var(--rule);
    border-radius: 3px; background: var(--ground); color: var(--ink); font: inherit;
  }
  textarea { resize: vertical; min-height: 3.2rem; }
  button {
    padding: 0.6rem 1.15rem; border: 0; border-radius: 3px;
    background: var(--accent); color: #fff; font: inherit; font-weight: 500; cursor: pointer;
  }
  button.link {
    padding: 0; background: none; color: var(--muted); font-weight: 400;
    text-decoration: underline; cursor: pointer; font-size: 0.88rem;
  }
  .muted { color: var(--muted); }
  .small { font-size: 0.85rem; }
  .mono { font-family: ui-monospace, "Cascadia Mono", Menlo, monospace; }

  .turn { margin-bottom: 1.75rem; }
  .turn .said {
    background: var(--mine); border-radius: 4px; padding: 0.85rem 1.1rem;
    margin-left: auto; max-width: 80%; width: fit-content;
  }
  .turn .replied { background: var(--panel); border: 1px solid var(--rule); border-radius: 4px; padding: 1.25rem 1.35rem; }
  .turn .replied p { margin: 0 0 0.85rem; }
  .turn .replied p:last-child { margin-bottom: 0; }

  .cite {
    display: inline-block; min-width: 1.35rem; text-align: center;
    font-size: 0.72rem; font-weight: 600; vertical-align: super;
    color: var(--accent); text-decoration: none;
  }
  .sources { margin-top: 1.25rem; border-top: 1px solid var(--rule); padding-top: 1rem; }
  .sources ol { margin: 0; padding-left: 1.3rem; }
  .sources .heading { font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 0.5rem; }
  .sources li { font-size: 0.86rem; margin-bottom: 0.35rem; color: var(--muted); }
  .sources .where { font-family: ui-monospace, Menlo, monospace; font-size: 0.8rem; color: var(--accent); }
  .depth { font-size: 0.72rem; background: var(--accent-soft); color: var(--accent); padding: 0.05rem 0.35rem; border-radius: 999px; }

  .note { font-size: 0.85rem; color: var(--warn); margin-bottom: 0.9rem; }
  .abstained { border-left: 3px solid var(--warn); padding-left: 1rem; }

  .ask {
    position: fixed; left: 0; right: 0; bottom: 0; background: var(--ground);
    border-top: 1px solid var(--rule); padding: 1rem 1.25rem;
  }
  .ask .inner { max-width: 900px; margin: 0 auto; display: flex; gap: 0.7rem; align-items: flex-end; }
  .ask textarea { flex: 1; }
  .scoped { display: flex; gap: 0.6rem; align-items: center; margin-bottom: 0.6rem; font-size: 0.85rem; color: var(--muted); }
  .scoped select { width: auto; padding: 0.3rem 0.5rem; font-size: 0.85rem; }
  .banner {
    background: var(--panel); border-left: 3px solid var(--warn); padding: 0.8rem 1.05rem;
    margin-bottom: 1.5rem; font-size: 0.86rem; border-radius: 0 3px 3px 0;
  }
  .empty { color: var(--muted); text-align: center; padding: 4rem 1rem; }

  .tabs { display: flex; gap: 1.5rem; margin: -0.25rem 0 1.5rem; }
  .tabs a {
    color: var(--muted); text-decoration: none; font-size: 0.9rem;
    padding-bottom: 0.4rem; border-bottom: 2px solid transparent;
  }
  .tabs a.on { color: var(--ink); border-bottom-color: var(--accent); }
  .tabs a:hover { color: var(--ink); }

  .repo-group { margin-bottom: 0.9rem; }
  .repo-group:last-child { margin-bottom: 0; }
  .repo-name {
    font-family: ui-monospace, Menlo, monospace; font-size: 0.8rem;
    color: var(--ink); margin-bottom: 0.3rem;
  }
`;

export function chatLayout(title: string, body: string, chrome = true): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — KNA</title>
<style>${STYLES}</style>
</head><body><div class="shell">
${
  chrome
    ? `<header class="bar">
         <span class="brand">KNA</span>
         <span class="who"></span>
         <form method="post" action="/chat/logout"><button class="link" type="submit">Sign out</button></form>
       </header>`
    : ''
}
${body}
</div></body></html>`;
}
