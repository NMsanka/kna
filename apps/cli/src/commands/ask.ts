import { createInterface } from 'node:readline/promises';
import type { SearchResponse } from '@kna/contracts';
import type { CliContext } from '../context.js';
import { ui } from '../ui.js';

/**
 * `kna ask` — the Developer Assistant from the terminal (§9).
 *
 * Two behaviours here are not cosmetic.
 *
 * Provenance is printed on every answer, always. §6 rule 2 and §16's first risk both come down
 * to the same thing: "two bad answers loses a team permanently", and the defence is that every
 * claim is traceable to a file and a line the developer can open.
 *
 * Abstention is rendered as a first-class outcome rather than an error. §15.5's whole point is
 * that "I don't know" must be a normal, well-presented response — if refusing looks like a
 * failure, the pressure to lower the threshold becomes irresistible.
 */

export interface AskOptions {
  platformUrl?: string;
  token?: string;
  scope: 'project' | 'repo' | 'org' | 'expanded';
  topN: number;
  json: boolean;
  interactive: boolean;
}

export async function askCommand(
  ctx: CliContext,
  question: string | undefined,
  options: AskOptions,
): Promise<number> {
  const platformUrl = options.platformUrl ?? ctx.config.platform.url;
  const token = options.token ?? process.env[ctx.config.platform.tokenEnv];

  if (!token) {
    ui.error(`No platform token. Set ${ctx.config.platform.tokenEnv}, or pass --token.`);
    return 1;
  }

  const context: AskContext = { ...options, ctx, platformUrl, token };

  if (options.interactive || !question) {
    return interactiveSession(ctx, context);
  }

  const response = await ask(question, [], context);
  render(response, options);
  return response.abstained ? 2 : 0;
}

interface AskContext extends AskOptions {
  ctx: CliContext;
  platformUrl: string;
  token: string;
}

async function ask(
  question: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  context: AskContext,
): Promise<SearchResponse> {
  const response = await fetch(`${context.platformUrl}/v1/search`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${context.token}`,
    },
    body: JSON.stringify({
      query: question,
      scope: {
        kind: context.scope,
        // The MCP server infers scope from the working directory's git remote (§4.3); the CLI
        // is in the same position and does the same thing.
        repoIds: context.scope === 'repo' ? [context.ctx.repo.id] : undefined,
      },
      topN: context.topN,
      history: history.length > 0 ? history.slice(-8) : undefined,
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Search failed (${response.status}): ${text.slice(0, 300)}`);
  }

  return (await response.json()) as SearchResponse;
}

function render(response: SearchResponse, options: AskOptions): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
    return;
  }

  // §15.6 — degraded modes are a banner, not a silent quality drop.
  for (const mode of response.degradedModes) {
    ui.warn(degradedBanner(mode));
  }

  if (response.abstained) {
    ui.log();
    ui.log(ui.yellow("I don't have enough in the index to answer that reliably."));
    if (response.abstentionReason) {
      ui.log();
      ui.detail(response.abstentionReason);
    }
    ui.log();
    ui.detail('If the answer genuinely is not written down anywhere, that is worth flagging —');
    ui.detail('it becomes a documentation backlog item rather than a dead end.');
    return;
  }

  if (response.hedging) {
    ui.log();
    ui.warn(`Confidence: ${response.hedging}`);
  }

  if (response.rewrittenQuery) {
    ui.detail(`Interpreted as: ${response.rewrittenQuery}`);
  }

  ui.heading(`${response.hits.length} result(s)`);

  for (const [index, hit] of response.hits.entries()) {
    const location = hit.provenance.path
      ? `${hit.provenance.path}:${hit.provenance.startLine ?? '?'}`
      : '(no source location)';
    const depth =
      hit.analysisDepth === 'shallow' ? ui.yellow('shallow') : ui.dim(hit.analysisDepth);
    const via = hit.viaExpansion ? ui.dim(` via ${hit.expansionRelation}`) : '';

    ui.log(
      `\n${ui.bold(`${index + 1}. ${hit.qualifiedName ?? hit.chunkId}`)}${via}  ${ui.dim(
        `[${depth}] ${hit.score.toFixed(3)}`,
      )}`,
    );
    ui.detail(location);

    if (hit.alsoPresentInModules.length > 0) {
      ui.detail(`also present in ${hit.alsoPresentInModules.length} other module(s)`);
    }

    const preview = hit.content.split('\n').slice(0, 12).join('\n');
    ui.log(indent(preview, '     '));
  }

  ui.log();
  ui.detail(`trace ${response.traceId}`);
}

async function interactiveSession(ctx: CliContext, context: AskContext): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  ui.log(`Asking about ${ui.cyan(ctx.repo.name)} (${context.scope} scope). Ctrl-C to exit.`);

  try {
    for (;;) {
      const question = (await rl.question('\n> ')).trim();
      if (!question) continue;
      if (question === 'exit' || question === 'quit') break;

      try {
        const response = await ask(question, history, context);
        render(response, context);

        history.push({ role: 'user', content: question });
        if (!response.abstained && response.hits[0]) {
          // Keeping a short assistant turn in history is what lets the rewrite resolve "what
          // about the async version?" on the next turn (§15.5 multi-turn).
          history.push({
            role: 'assistant',
            content: response.hits
              .slice(0, 3)
              .map((h) => h.qualifiedName ?? h.chunkId)
              .join(', '),
          });
        }
      } catch (error) {
        ui.error(error instanceof Error ? error.message : String(error));
      }
    }
  } finally {
    rl.close();
  }

  return 0;
}

function degradedBanner(mode: string): string {
  switch (mode) {
    case 'reranker-unavailable':
      return 'Results are ordered by fusion score only — the reranker is unavailable, so ordering is less precise than usual.';
    case 'embeddings-unavailable':
      return 'Semantic search is unavailable; these results come from lexical and symbol matching only.';
    case 'generation-unavailable':
      return 'Answer generation is unavailable. Search results are shown directly.';
    default:
      return `Degraded: ${mode}`;
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n');
}
