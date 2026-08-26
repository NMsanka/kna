import { randomUUID } from 'node:crypto';

import { zSearchRequest, zSearchResponse, zFeedbackRequest } from '@kna/contracts';
import {
  renderAbstention,
  renderHedge,
  synthesiseAnswer,
  type RetrievalScope,
  uniformEmptyMessage,
} from '@kna/retrieval';
import { sql } from 'drizzle-orm';
import { anyOf, withSystemContext } from '@kna/db';
import type { ApiContext, KnaServer } from '../context.js';
import { BreadthMonitor } from '@kna/audit';

/**
 * Retrieval and feedback routes.
 *
 * The order of operations is the security design, not an implementation detail:
 *   1. Authenticate.
 *   2. Resolve permissions — including the deny path — *before* the query runs.
 *   3. Run retrieval with the ACL as a hard predicate inside the SQL (§10 Layer 4).
 *   4. Audit what was returned, by chunk id.
 *   5. Record the full replayable trace (§15.5).
 *
 * Step 4 is what makes "what was exposed?" answerable after an incident, and step 5 is what
 * makes a thumbs-down actionable rather than noise.
 */
export async function registerSearchRoutes(app: KnaServer, ctx: ApiContext): Promise<void> {
  const breadth = new BreadthMonitor(undefined, (alert) => {
    // §15.4 — breadth, not volume. An engineer touching 40 repos in an hour is the signal.
    ctx.metrics.breadthAnomalies.add(1, { surface: alert.surface });
    ctx.logger.warn(alert, 'access breadth anomaly');
    void ctx.audit.record({
      orgId: alert.orgId,
      action: 'security.breadth_anomaly',
      actorType: 'system',
      actorId: alert.principalId,
      outcome: 'success',
      detail: { ...alert },
    });
  });

  /**
   * What may this caller scope a question to?
   *
   * The chat surface needs a project picker, and a picker that offers a project the caller
   * cannot read is worse than no picker: they choose it, get nothing back, and conclude the
   * platform is broken rather than that they lack access.
   *
   * So both lists are derived from `permittedRepoIds` rather than from the org. A project
   * appears only when the caller can read at least one repository that has a module in it.
   */
  app.get('/v1/scope', async (request) => {
    const principal = await ctx.authenticate(request);
    const access = await ctx.permissions.resolve(principal, { corpus: 'internal' });

    if (access.permittedRepoIds.length === 0) {
      return { projects: [], repos: [] };
    }

    const rows = await withSystemContext(ctx.db, principal.orgId, 'maintenance', async (tx) => {
      const projects = await tx.execute<{ id: string; slug: string; name: string; repos: string }>(
        sql`
          SELECT p.id, p.slug, p.name, count(DISTINCT m.repo_id)::text AS repos
            FROM projects p
            JOIN module_projects mp ON mp.project_id = p.id
            JOIN modules m ON m.id = mp.module_id
           WHERE p.org_id = ${principal.orgId}
             AND m.repo_id = ${anyOf(access.permittedRepoIds)}
           GROUP BY p.id, p.slug, p.name
           ORDER BY p.name
        `,
      );
      // `indexed` rather than filtering: a registered repository with nothing published yet
      // should still appear, said plainly. Hiding it produces "where has my repository gone",
      // which is a worse question than "why is it greyed out".
      const repos = await tx.execute<{ id: string; name: string; modules: string }>(sql`
        SELECT r.id, r.name, count(m.id)::text AS modules
          FROM repos r
          LEFT JOIN modules m ON m.repo_id = r.id
         WHERE r.org_id = ${principal.orgId} AND r.id = ${anyOf(access.permittedRepoIds)}
         GROUP BY r.id, r.name
         ORDER BY r.name
      `);
      return { projects, repos };
    });

    return {
      projects: rows.projects.map((p) => ({
        id: String(p.id),
        slug: String(p.slug),
        name: String(p.name),
        repoCount: Number(p.repos),
      })),
      repos: rows.repos.map((r) => ({
        id: String(r.id),
        name: String(r.name),
        indexed: Number(r.modules) > 0,
      })),
    };
  });

  app.post('/v1/search', async (request, reply) => {
    const traceId = randomUUID();
    const body = zSearchRequest.parse(request.body);
    const principal = await ctx.authenticate(request);

    const scope = await resolveScope(ctx, principal.orgId, body.scope);
    const access = await ctx.permissions.resolve(principal, { corpus: 'internal' });

    if (access.permittedRepoIds.length === 0) {
      // Uniform response. §15.7 — differential responses turn the assistant into an oracle for
      // "does this repo exist", and the same applies internally to confidential repos.
      ctx.metrics.aclDenials.add(1, { org: principal.orgId });
      return reply.send(
        zSearchResponse.parse({
          hits: [],
          abstained: true,
          abstentionReason: uniformEmptyMessage(),
          hedging: null,
          intentClass: 'conceptual',
          rewrittenQuery: null,
          degradedModes: [],
          traceId,
          timings: {},
        }),
      );
    }

    const result = await ctx.retrieval.retrieve({
      query: body.query,
      scope,
      access,
      history: body.history,
      topN: body.topN,
      sessionId: body.sessionId,
    });

    // §10 Layer 6 — audit every retrieval, by chunk id, never chunk text.
    const reposTouched = [...new Set(result.chunks.map((c) => c.repoId))];
    await ctx.audit.record({
      orgId: principal.orgId,
      action: 'retrieval.search',
      actorType: principal.isServiceAccount ? 'system' : 'user',
      actorId: principal.id,
      actorSubject: principal.subject,
      outcome: 'success',
      detail: {
        intentClass: result.intentClass,
        abstained: result.abstain,
        resultCount: result.chunks.length,
        degradedModes: result.degradedModes,
      },
      chunkIds: result.chunks.map((c) => c.chunkId),
      reposTouched,
      traceId,
      sourceIp: request.ip,
      userAgent: request.headers['user-agent'] ?? null,
    });

    breadth.observe({
      orgId: principal.orgId,
      principalId: principal.id,
      surface: 'api',
      repoIds: reposTouched,
      moduleIds: [...new Set(result.chunks.map((c) => c.moduleId))],
    });

    // §15.5 — the full replayable trace. Without it a thumbs-down is unactionable.
    await ctx.store
      .recordQueryTrace({
        id: result.trace.traceId,
        orgId: principal.orgId,
        principalId: principal.id,
        sessionId: body.sessionId ?? null,
        surface: 'api',
        rawQuery: result.trace.rawQuery,
        rewrittenQuery: result.trace.rewrittenQuery,
        intentClass: result.trace.intentClass,
        scope,
        denseCandidates: result.trace.denseCandidates,
        lexicalCandidates: result.trace.lexicalCandidates,
        symbolCandidates: result.trace.symbolCandidates,
        fusedCandidates: result.trace.fusedCandidates,
        rerankedCandidates: result.trace.rerankedCandidates,
        servedChunkIds: result.trace.servedChunkIds,
        expansionChunkIds: result.trace.expansionChunkIds,
        stageTimingsMs: result.trace.stageTimingsMs,
        stageTokens: result.trace.stageTokens,
        topRerankScore: result.trace.topRerankScore,
        abstained: result.abstain,
        abstentionReason: result.abstentionReason,
        degradedModes: result.degradedModes,
        model: null,
        promptVersion: null,
        embeddingModel: result.trace.embeddingModel,
        retrievalConfigVersion: result.trace.retrievalConfigVersion,
        traceId,
      })
      .catch((error: unknown) => {
        // A trace-write failure must not fail the user's query, but it must be loud: without
        // traces the retrieval quality loop stops working.
        ctx.logger.error({ err: String(error) }, 'query trace write failed');
      });

    for (const [stage, ms] of Object.entries(result.trace.stageTimingsMs)) {
      ctx.metrics.retrievalStageMs.record(ms, { stage });
    }
    for (const [stage, tokens] of Object.entries(result.trace.stageTokens)) {
      ctx.metrics.retrievalTokensPerStage.record(tokens, { stage });
    }
    ctx.metrics.retrievalResults.record(result.chunks.length, { org: principal.orgId });
    if (result.abstain) {
      ctx.metrics.retrievalAbstentions.add(1, { intent: result.intentClass });
    }

    const symbolNames = await symbolNamesFor(
      ctx,
      principal.orgId,
      result.chunks.map((c) => c.symbolId),
    );

    // Synthesis happens after the ACL filter and the audit record, never before: an answer is
    // written from evidence the caller was already permitted to see.
    const answer = body.answer
      ? await synthesiseAnswer({
          query: body.query,
          result,
          client: ctx.llm,
          orgId: principal.orgId,
        }).catch((error: unknown) => {
          // A provider failure degrades to search results rather than failing the request. The
          // evidence is the part that was expensive to produce and is still useful without prose
          // wrapped around it.
          request.log.warn({ err: String(error) }, 'answer synthesis failed');
          return null;
        })
      : null;

    return reply.send(
      zSearchResponse.parse({
        answer: answer
          ? {
              text: answer.text,
              citations: answer.citations.map((c) => ({
                ...c,
                qualifiedName: c.symbolId ? (symbolNames.get(c.symbolId) ?? null) : null,
              })),
              abstained: answer.abstained,
              hedged: answer.hedged,
              hedgingReason: answer.hedgingReason,
              model: answer.model,
            }
          : null,
        hits: result.chunks.map((chunk) => ({
          chunkId: chunk.chunkId,
          symbolId: chunk.symbolId,
          qualifiedName: chunk.symbolId ? (symbolNames.get(chunk.symbolId) ?? null) : null,
          content: chunk.content,
          score: chunk.score,
          provenance: {
            repoId: chunk.repoId,
            moduleId: chunk.moduleId,
            path: chunk.sourcePath,
            startLine: chunk.sourceStartLine,
            endLine: chunk.sourceEndLine,
            commitSha: null,
          },
          analysisDepth: chunk.analysisDepth as 'shallow' | 'semantic' | 'artifact',
          viaExpansion: chunk.viaExpansion ?? false,
          expansionRelation: chunk.expansionRelation ?? null,
          alsoPresentInModules: chunk.alsoPresentInModules ?? [],
        })),
        abstained: result.abstain,
        abstentionReason: result.abstain
          ? renderAbstention(
              {
                abstain: true,
                reason: result.abstentionReason,
                requiresHedging: false,
                hedgingReason: null,
              },
              body.query,
            )
          : null,
        hedging:
          result.requiresHedging && result.hedgingReason ? renderHedge(result.hedgingReason) : null,
        intentClass: result.intentClass,
        rewrittenQuery: result.rewrittenQuery,
        degradedModes: result.degradedModes,
        traceId: result.trace.traceId,
        timings: result.trace.stageTimingsMs,
      }),
    );
  });

  /**
   * §15.5 — "capture the full replayable trace... then triage into retrieval miss / ranking miss
   * / context truncation / generation error / knowledge genuinely absent. That last bucket is a
   * documentation backlog ticket, and it is the one this platform is uniquely able to close."
   */
  app.post('/v1/feedback', async (request, reply) => {
    const body = zFeedbackRequest.parse(request.body);
    const principal = await ctx.authenticate(request);

    await withSystemContext(ctx.dbBatch, principal.orgId, 'maintenance', async (tx) => {
      await tx.execute(sql`
        INSERT INTO feedback (id, org_id, query_trace_id, principal_id, signal, triage, comment, implicit)
        VALUES (
          ${randomUUID()}, ${principal.orgId}, ${body.traceId}, ${principal.id},
          ${body.signal}, ${body.triage ?? null}, ${body.comment ?? null},
          ${body.signal === 'copied' || body.signal === 'rephrased' || body.signal === 'abandoned'}
        )
      `);
    });

    // The knowledge-absent bucket is the actionable one: it becomes a documentation ticket
    // rather than a retrieval-tuning task.
    if (body.triage === 'knowledge-absent') {
      await ctx.audit.record({
        orgId: principal.orgId,
        action: 'feedback.knowledge_gap',
        actorType: 'user',
        actorId: principal.id,
        resourceType: 'query_trace',
        resourceId: body.traceId,
        outcome: 'success',
        detail: { comment: body.comment ?? null },
      });
    }

    return reply.code(204).send();
  });
}

/**
 * §4.3 — "retrieval takes a scope, and the default is **project**, not repo and not everything."
 * Expanded scope adds projects linked by API contract or package dependency.
 */
async function resolveScope(
  ctx: ApiContext,
  orgId: string,
  input: {
    kind: string;
    projectIds?: string[];
    repoIds?: string[];
    moduleIds?: string[];
    version?: string;
  },
): Promise<RetrievalScope> {
  const scope: RetrievalScope = {
    kind: input.kind as RetrievalScope['kind'],
    orgId,
    projectIds: input.projectIds,
    repoIds: input.repoIds,
    moduleIds: input.moduleIds,
  };

  if (input.kind === 'expanded' && input.projectIds?.length) {
    const linked = await ctx.store.linkedProjects(orgId, input.projectIds);
    scope.projectIds = [...new Set([...input.projectIds, ...linked])];
  }

  return scope;
}

async function symbolNamesFor(
  ctx: ApiContext,
  orgId: string,
  symbolIds: Array<string | null>,
): Promise<Map<string, string>> {
  const ids = symbolIds.filter((id): id is string => id !== null);
  if (ids.length === 0) return new Map();

  const rows = await withSystemContext(ctx.db, orgId, 'maintenance', async (tx) =>
    tx.execute<{ id: string; qualified_name: string }>(sql`
      SELECT id, qualified_name FROM symbols WHERE org_id = ${orgId} AND id = ${anyOf(ids)}
    `),
  );

  return new Map(rows.map((r) => [r.id, r.qualified_name]));
}
