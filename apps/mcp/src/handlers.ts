import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sql } from 'drizzle-orm';
import { anyOf, withOrgContext } from '@kna/db';
import { TOOL_DEFINITIONS, wrapUntrusted } from './tools.js';
import type { McpContext, McpIdentity } from './context.js';
import { scopeNarrowing } from './scope.js';

/**
 * Tool handlers.
 *
 * Every handler follows the same four steps, and the order is the security design:
 *
 *   1. Resolve access from the *caller's identity*, never from anything in the request or in
 *      retrieved content. §10 Layer 5 — "authorisation is computed from the caller's identity,
 *      upstream of retrieval, and is not re-derivable from context."
 *   2. Run the query with the ACL as a hard predicate in SQL.
 *   3. Audit by chunk id, and feed the breadth monitor (§15.4 insider exfiltration).
 *   4. Wrap the response as untrusted data before it reaches the model.
 *
 * Responses are also shaped for an agent rather than for a human: file path and line first,
 * analysis depth stated, and an explicit note when results were truncated. An agent that cannot
 * tell it received a partial answer will confidently act on it.
 */

export function registerTools(
  server: McpServer,
  ctx: McpContext,
  identity: McpIdentity,
  sessionId: string,
): void {
  // ── search_codebase ──────────────────────────────────────────────────────────────────────
  server.registerTool(
    'search_codebase',
    {
      title: TOOL_DEFINITIONS.search_codebase.title,
      description: TOOL_DEFINITIONS.search_codebase.description,
      inputSchema: TOOL_DEFINITIONS.search_codebase.inputSchema,
    },
    async (args) => {
      const access = await ctx.permissions.resolve(identity.principal, { corpus: 'internal' });
      const scope = await ctx.resolveScope(identity, args.scope);

      const result = await ctx.retrieval.retrieve({
        query: args.query,
        scope: {
          ...scope,
          languages: args.language ? [args.language] : undefined,
          kinds: args.kind ? [args.kind] : undefined,
        },
        access,
        topN: args.limit ?? 8,
        sessionId,
      });

      await ctx.recordAccess({
        identity,
        action: 'mcp.search_codebase',
        chunkIds: result.chunks.map((c) => c.chunkId),
        repoIds: [...new Set(result.chunks.map((c) => c.repoId))],
        moduleIds: [...new Set(result.chunks.map((c) => c.moduleId))],
        sessionId,
      });

      if (result.abstain) {
        return {
          content: [
            {
              type: 'text',
              text: [
                'No sufficiently relevant results.',
                '',
                result.abstentionReason ?? '',
                '',
                'This is a genuine "not found", not a permissions message — but note that results',
                'are filtered to what this identity may read, so absence here is not proof of',
                'absence in the codebase.',
              ].join('\n'),
            },
          ],
        };
      }

      const body = result.chunks
        .map((chunk, index) => {
          const location = chunk.sourcePath
            ? `${chunk.sourcePath}:${chunk.sourceStartLine ?? '?'}`
            : '(no source location)';
          const depth =
            chunk.analysisDepth === 'shallow'
              ? ' [shallow analysis: signature as written, types not resolved]'
              : '';
          const via = chunk.viaExpansion ? ` [included as ${chunk.expansionRelation}]` : '';
          const duplicates = chunk.alsoPresentInModules?.length
            ? `\n(also present in ${chunk.alsoPresentInModules.length} other module(s))`
            : '';
          return `## ${index + 1}. ${location}${depth}${via}${duplicates}\n\n${chunk.content}`;
        })
        .join('\n\n');

      const preamble = [
        result.requiresHedging && result.hedgingReason
          ? `Confidence note: ${result.hedgingReason}.`
          : null,
        result.degradedModes.length
          ? `Degraded: ${result.degradedModes.join(', ')}. Ordering may be less precise than usual.`
          : null,
      ]
        .filter(Boolean)
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: `${preamble ? `${preamble}\n\n` : ''}${wrapUntrusted(body, `${result.chunks.length} indexed code chunk(s)`)}`,
          },
        ],
      };
    },
  );

  // ── get_symbol ───────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'get_symbol',
    {
      title: TOOL_DEFINITIONS.get_symbol.title,
      description: TOOL_DEFINITIONS.get_symbol.description,
      inputSchema: TOOL_DEFINITIONS.get_symbol.inputSchema,
    },
    async (args) => {
      const access = await ctx.permissions.resolve(identity.principal, { corpus: 'internal' });
      const scope = await ctx.resolveScope(identity, args.scope);

      const rows = await withOrgContext(ctx.db, access.orgId, async (tx) =>
        tx.execute<{
          id: string;
          qualified_name: string;
          kind: string;
          language: string;
          visibility: string;
          signature: string;
          doc_comment: { summary?: string; description?: string } | null;
          deprecated: { reason?: string; replacement?: string } | null;
          parameters: Array<{ name: string; type: { text: string } | null; optional: boolean }>;
          return_type: { text: string } | null;
          source_path: string;
          source_start_line: number;
          analysis_depth: string;
          source_text: string | null;
          repo_id: string;
          module_id: string;
        }>(sql`
          SELECT s.* FROM symbols s
          WHERE s.org_id = ${access.orgId}
            AND s.repo_id = ${anyOf(access.permittedRepoIds)}
            AND s.sensitivity <> 'restricted'
            ${scopeNarrowing(scope, { moduleId: sql`s.module_id`, repoId: sql`s.repo_id` })}
            AND (
              s.id = ${args.symbol}
              OR s.qualified_name = ${args.symbol}
              -- Renamed symbols resolve through their old ids, so a stale reference in an
              -- agent's context still works (§15.1 fix 2).
              OR s.id = (
                SELECT current_id FROM symbol_aliases
                WHERE org_id = ${access.orgId} AND previous_id = ${args.symbol}
              )
            )
          LIMIT 1
        `),
      );

      const symbol = rows[0];
      if (!symbol) {
        return {
          content: [
            {
              type: 'text',
              // Deliberately does not distinguish "does not exist" from "not permitted".
              text: `No symbol '${args.symbol}' is available in this scope.`,
            },
          ],
        };
      }

      await ctx.recordAccess({
        identity,
        action: 'mcp.get_symbol',
        chunkIds: [],
        repoIds: [symbol.repo_id],
        moduleIds: [symbol.module_id],
        sessionId,
      });

      const lines = [
        `# ${symbol.qualified_name}`,
        '',
        `${symbol.visibility} ${symbol.kind} in ${symbol.language}`,
        `${symbol.source_path}:${symbol.source_start_line}`,
        symbol.analysis_depth === 'shallow'
          ? 'Analysis depth: shallow — the signature is as written; types were not resolved.'
          : `Analysis depth: ${symbol.analysis_depth}`,
        '',
        '```',
        symbol.signature,
        '```',
      ];

      if (symbol.deprecated) {
        lines.push('', `**Deprecated.** ${symbol.deprecated.reason ?? ''}`);
        if (symbol.deprecated.replacement) lines.push(`Use \`${symbol.deprecated.replacement}\`.`);
      }
      if (symbol.doc_comment?.summary) lines.push('', symbol.doc_comment.summary);
      if (symbol.parameters.length > 0) {
        lines.push('', '## Parameters', '');
        for (const p of symbol.parameters) {
          lines.push(`- \`${p.name}\`${p.optional ? '?' : ''}: ${p.type?.text ?? 'unknown'}`);
        }
      }
      if (symbol.return_type) lines.push('', `Returns \`${symbol.return_type.text}\``);
      if (args.includeSource && symbol.source_text) {
        lines.push('', '## Implementation', '', '```', symbol.source_text, '```');
      } else if (args.includeSource) {
        lines.push(
          '',
          'Implementation not available: this repository has not opted in to sharing source with the platform.',
        );
      }

      return {
        content: [{ type: 'text', text: wrapUntrusted(lines.join('\n'), symbol.source_path) }],
      };
    },
  );

  // ── find_usages ──────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'find_usages',
    {
      title: TOOL_DEFINITIONS.find_usages.title,
      description: TOOL_DEFINITIONS.find_usages.description,
      inputSchema: TOOL_DEFINITIONS.find_usages.inputSchema,
    },
    async (args) => {
      const access = await ctx.permissions.resolve(identity.principal, { corpus: 'internal' });
      const scope = await ctx.resolveScope(identity, args.scope);

      const rows = await withOrgContext(ctx.db, access.orgId, async (tx) =>
        tx.execute<{
          qualified_name: string;
          source_path: string;
          source_start_line: number;
          repo_id: string;
          module_id: string;
          relation: string;
          total: string;
        }>(sql`
          -- Scope narrows two of the three parts, and deliberately not the third. The target
          -- is narrowed because a qualified name can exist in several repositories and scope
          -- is what says which one you meant. Direct usages are narrowed because that is the
          -- question being asked. Cross-repo usages are *not*: they are by definition outside
          -- the current scope, and finding them is the whole point of the arm — narrowing them
          -- to the caller's project would silently turn the feature off. includeCrossRepo is
          -- the control for that, and it stays the control.
          WITH target AS (
            SELECT id FROM symbols s
            WHERE s.org_id = ${access.orgId}
              AND (s.id = ${args.symbol} OR s.qualified_name = ${args.symbol})
              ${scopeNarrowing(scope, { moduleId: sql`s.module_id`, repoId: sql`s.repo_id` })}
            LIMIT 1
          ),
          direct AS (
            SELECT s.qualified_name, s.source_path, s.source_start_line, s.repo_id, s.module_id,
                   'call' AS relation
            FROM symbols s, target
            WHERE s.org_id = ${access.orgId}
              AND s.repo_id = ${anyOf(access.permittedRepoIds)}
              AND s.sensitivity <> 'restricted'
              ${scopeNarrowing(scope, { moduleId: sql`s.module_id`, repoId: sql`s.repo_id` })}
              AND s.edges -> 'calls' @> to_jsonb(target.id)
          ),
          cross_repo AS (
            SELECT s.qualified_name, s.source_path, s.source_start_line, s.repo_id, s.module_id,
                   e.kind AS relation
            FROM cross_repo_edges e
            JOIN symbols s ON s.id = e.from_symbol_id, target
            WHERE ${args.includeCrossRepo !== false}
              AND e.org_id = ${access.orgId}
              AND e.to_symbol_id = target.id
              AND e.status = 'resolved'
              AND s.repo_id = ${anyOf(access.permittedRepoIds)}
          ),
          combined AS (SELECT * FROM direct UNION ALL SELECT * FROM cross_repo)
          SELECT *, (SELECT count(*)::text FROM combined) AS total
          FROM combined
          LIMIT ${args.limit ?? 20}
        `),
      );

      await ctx.recordAccess({
        identity,
        action: 'mcp.find_usages',
        chunkIds: [],
        repoIds: [...new Set(rows.map((r) => r.repo_id))],
        moduleIds: [...new Set(rows.map((r) => r.module_id))],
        sessionId,
      });

      if (rows.length === 0) {
        return {
          content: [{ type: 'text', text: `No usages of '${args.symbol}' found in this scope.` }],
        };
      }

      const total = Number(rows[0]!.total);
      const truncated =
        total > rows.length
          ? `\n\n(${total - rows.length} further usage(s) not shown. This symbol is widely used; a change to it has broad impact.)`
          : '';

      const body = rows
        .map(
          (r) => `- ${r.qualified_name} — ${r.source_path}:${r.source_start_line} (${r.relation})`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text', text: wrapUntrusted(`${body}${truncated}`, `${total} usage(s)`) },
        ],
      };
    },
  );

  // ── get_api_spec ─────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'get_api_spec',
    {
      title: TOOL_DEFINITIONS.get_api_spec.title,
      description: TOOL_DEFINITIONS.get_api_spec.description,
      inputSchema: TOOL_DEFINITIONS.get_api_spec.inputSchema,
    },
    async (args) => {
      const access = await ctx.permissions.resolve(identity.principal, { corpus: 'internal' });

      const rows = await withOrgContext(ctx.db, access.orgId, async (tx) =>
        tx.execute<{ title: string; spec_version: string; document: unknown; repo_id: string }>(sql`
          SELECT title, spec_version, document, repo_id FROM api_specs
          WHERE org_id = ${access.orgId}
            AND repo_id = ${anyOf(access.permittedRepoIds)}
            AND (spec_id = ${args.service} OR title ILIKE ${`%${args.service}%`})
            ${args.version ? sql`AND spec_version = ${args.version}` : sql``}
          ORDER BY created_at DESC
          LIMIT 1
        `),
      );

      const spec = rows[0];
      if (!spec) {
        return {
          content: [
            { type: 'text', text: `No API specification available for '${args.service}'.` },
          ],
        };
      }

      await ctx.recordAccess({
        identity,
        action: 'mcp.get_api_spec',
        chunkIds: [],
        repoIds: [spec.repo_id],
        moduleIds: [],
        sessionId,
      });

      const document = args.operationId
        ? extractOperation(spec.document, args.operationId)
        : spec.document;

      return {
        content: [
          {
            type: 'text',
            text: wrapUntrusted(
              JSON.stringify(document, null, 2),
              `${spec.title} v${spec.spec_version} (build-generated OpenAPI)`,
            ),
          },
        ],
      };
    },
  );

  // ── search_docs ──────────────────────────────────────────────────────────────────────────
  server.registerTool(
    'search_docs',
    {
      title: TOOL_DEFINITIONS.search_docs.title,
      description: TOOL_DEFINITIONS.search_docs.description,
      inputSchema: TOOL_DEFINITIONS.search_docs.inputSchema,
    },
    async (args) => {
      const access = await ctx.permissions.resolve(identity.principal, { corpus: 'internal' });
      const scope = await ctx.resolveScope(identity, args.scope);

      const result = await ctx.retrieval.retrieve({
        query: args.query,
        // Documentation only. A "how do I" question answered from a function body is usually
        // worse than one answered from prose written for that purpose.
        scope: { ...scope, kinds: undefined },
        access,
        topN: args.limit ?? 8,
        sessionId,
      });

      const docs = result.chunks.filter((c) => c.corpus === 'docs' || c.corpus === 'adr');

      await ctx.recordAccess({
        identity,
        action: 'mcp.search_docs',
        chunkIds: docs.map((c) => c.chunkId),
        repoIds: [...new Set(docs.map((c) => c.repoId))],
        moduleIds: [...new Set(docs.map((c) => c.moduleId))],
        sessionId,
      });

      if (docs.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'No documentation matched. If the answer is not written down anywhere, that is worth flagging — it becomes a documentation backlog item.',
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: wrapUntrusted(
              docs.map((c) => `## ${c.sourcePath ?? c.chunkId}\n\n${c.content}`).join('\n\n'),
              'published documentation',
            ),
          },
        ],
      };
    },
  );

  // ── get_architecture ─────────────────────────────────────────────────────────────────────
  server.registerTool(
    'get_architecture',
    {
      title: TOOL_DEFINITIONS.get_architecture.title,
      description: TOOL_DEFINITIONS.get_architecture.description,
      inputSchema: TOOL_DEFINITIONS.get_architecture.inputSchema,
    },
    async (args) => {
      const access = await ctx.permissions.resolve(identity.principal, { corpus: 'internal' });
      const scope = await ctx.resolveScope(identity, args.scope);
      const graph = await ctx.architecture(access, scope, args.service ?? null);

      await ctx.recordAccess({
        identity,
        action: 'mcp.get_architecture',
        chunkIds: [],
        repoIds: graph.repoIds,
        moduleIds: graph.moduleIds,
        sessionId,
      });

      return {
        content: [
          {
            type: 'text',
            // The text description is the complete edge list, not a summary — §15.8 requires a
            // text alternative for every generated diagram, and a lossy one is not an alternative.
            text: `${graph.mermaid}\n\n${graph.textAlternative}`,
          },
        ],
      };
    },
  );

  // ── get_changes_since ────────────────────────────────────────────────────────────────────
  server.registerTool(
    'get_changes_since',
    {
      title: TOOL_DEFINITIONS.get_changes_since.title,
      description: TOOL_DEFINITIONS.get_changes_since.description,
      inputSchema: TOOL_DEFINITIONS.get_changes_since.inputSchema,
    },
    async (args) => {
      const access = await ctx.permissions.resolve(identity.principal, { corpus: 'internal' });
      const scope = await ctx.resolveScope(identity, args.scope);
      const diff = await ctx.changesSince(access, scope, args.since, {
        breakingOnly: args.breakingOnly ?? false,
        limit: args.limit ?? 50,
      });

      await ctx.recordAccess({
        identity,
        action: 'mcp.get_changes_since',
        chunkIds: [],
        repoIds: diff.repoIds,
        moduleIds: [],
        sessionId,
      });

      return { content: [{ type: 'text', text: diff.rendered }] };
    },
  );
}

/** Narrow an OpenAPI document to a single operation, keeping its component references usable. */
function extractOperation(document: unknown, operationId: string): unknown {
  const doc = document as {
    paths?: Record<string, Record<string, { operationId?: string }>>;
    components?: unknown;
    info?: unknown;
  };

  for (const [route, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (operation?.operationId === operationId) {
        return {
          info: doc.info,
          paths: { [route]: { [method]: operation } },
          // Components come along: an operation whose schema references are dangling is not
          // usable for writing a client, which is the whole point of asking for it.
          components: doc.components,
        };
      }
    }
  }

  return { error: `No operation '${operationId}' in this specification.` };
}

export const _schemaProbe = z.object({});
