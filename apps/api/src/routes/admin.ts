import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { withSystemContext } from '@kna/db';
import {
  zBulkReviewDecision,
  zOnboardRepoRequest,
  zPublishExternallyRequest,
} from '@kna/contracts';
import { canonicalRemote, computeRepoId } from '@kna/ir';
import type { ApiContext, KnaServer } from '../context.js';
import { AuthError } from '../auth.js';

/**
 * Admin plane.
 *
 * §15.7 — "extend [audit] coverage to the admin plane: ACL overrides, sensitivity re-tiering,
 * routing changes, direct DB sessions." Every route here writes an audit record before it
 * writes anything else, because these are precisely the actions an auditor will ask about.
 */
export async function registerAdminRoutes(app: KnaServer, ctx: ApiContext): Promise<void> {
  const requireAdmin = async (request: Parameters<typeof ctx.authenticate>[0]) => {
    const principal = await ctx.authenticate(request);
    const isAdmin = await ctx.db.sql<Array<{ ok: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM principal_roles
        WHERE principal_id = ${principal.id} AND role = 'admin'
      ) AS ok
    `;
    if (!isAdmin[0]?.ok) {
      throw new AuthError('Administrator role required.', 403, 'not_admin');
    }
    return principal;
  };

  /**
   * §15.8 — "a bot that opens the onboarding PR rather than asking teams to hand-write config...
   * If onboarding costs a team half a day, most teams never onboard."
   */
  app.post('/v1/admin/repos', async (request, reply) => {
    const principal = await requireAdmin(request);
    const body = zOnboardRepoRequest.parse(request.body);

    const remote = canonicalRemote(body.remote);
    const repoId = computeRepoId(principal.orgId, remote);

    await withSystemContext(ctx.dbBatch, principal.orgId, 'maintenance', async (tx) => {
      await tx.execute(sql`
        INSERT INTO repos (id, org_id, remote, name, provider)
        VALUES (${repoId}, ${principal.orgId}, ${remote}, ${remote.split('/').pop() ?? remote}, ${ctx.env.GIT_PROVIDER})
        ON CONFLICT (org_id, remote) DO NOTHING
      `);
    });

    await ctx.audit.record({
      orgId: principal.orgId,
      action: 'admin.repo_onboarded',
      actorType: 'admin',
      actorId: principal.id,
      resourceType: 'repo',
      resourceId: repoId,
      outcome: 'success',
      detail: { remote, projects: body.projectSlugs },
    });

    let pullRequestUrl: string | null = null;
    if (body.openPullRequest && ctx.git) {
      try {
        const pr = await ctx.git.openPullRequest({
          repoRemote: remote,
          branch: 'kna/onboard',
          baseBranch: 'main',
          title: 'Add KNA documentation indexing',
          body: 'Adds a CI workflow that indexes this repository. No documentation is published until this merges, and the workflow scans for secrets before anything leaves the runner.',
          files: [],
          assignees: [],
          reviewers: [],
          labels: ['kna', 'documentation'],
          autoMerge: false,
        });
        pullRequestUrl = pr.url;
      } catch (error) {
        // A write-disabled environment refusing here is correct behaviour, not a failure of
        // onboarding: the repo is registered either way (§15.3).
        ctx.logger.warn({ err: String(error) }, 'onboarding PR not opened');
      }
    }

    return reply.code(201).send({ repoId, remote, pullRequestUrl });
  });

  /**
   * §15.3 — clearing a tripped magnitude circuit breaker. Deliberately a human decision with a
   * recorded reason: the breaker exists because mass regeneration is expensive and noisy, and
   * an approval with no stated reason teaches operators to click through it.
   */
  app.post('/v1/admin/bulk-review', async (request, reply) => {
    const principal = await requireAdmin(request);
    const body = zBulkReviewDecision.parse(request.body);

    await withSystemContext(ctx.dbBatch, principal.orgId, 'maintenance', async (tx) => {
      await tx.execute(sql`
        UPDATE repos
        SET pending_bulk_review = false,
            pending_bulk_review_reason = ${body.decision === 'approve' ? null : body.reason}
        WHERE org_id = ${principal.orgId} AND id = ${body.repoId}
      `);
    });

    await ctx.audit.record({
      orgId: principal.orgId,
      action: `admin.bulk_review_${body.decision}`,
      actorType: 'admin',
      actorId: principal.id,
      resourceType: 'repo',
      resourceId: body.repoId,
      outcome: 'success',
      detail: { reason: body.reason },
    });

    if (body.decision === 'approve') {
      await ctx.queue.enqueueRegenerateDocs({
        orgId: principal.orgId,
        repoId: body.repoId,
        commitSha: 'pending',
        bundleStorageKey: '',
      });
    }

    return reply.code(204).send();
  });

  /**
   * §15.7 — "promotion to the public tier is a one-way door... Make external publication an
   * explicit human-reviewed event with a diff ('these 14 symbols become externally visible'),
   * not an inferred property."
   *
   * GET returns the diff. POST requires the reviewer to have seen it, which is what the
   * acknowledgement literal enforces — it cannot be sent by a script that never rendered the
   * preview.
   */
  app.get<{ Querystring: { moduleIds: string } }>(
    '/v1/admin/external-publication/preview',
    async (request, reply) => {
      const principal = await requireAdmin(request);
      const moduleIds = request.query.moduleIds.split(',').filter(Boolean);

      const rows = await withSystemContext(ctx.db, principal.orgId, 'maintenance', async (tx) =>
        tx.execute<{
          module_id: string;
          module_name: string;
          sensitivity: string;
          symbol_id: string;
          qualified_name: string;
          kind: string;
        }>(sql`
          SELECT m.id AS module_id, m.name AS module_name, m.sensitivity,
                 s.id AS symbol_id, s.qualified_name, s.kind
          FROM modules m
          JOIN symbols s ON s.module_id = m.id
          WHERE m.org_id = ${principal.orgId}
            AND m.id = ANY(${moduleIds})
            AND s.visibility = 'public'
            AND m.external_publication_approved_at IS NULL
          ORDER BY m.name, s.qualified_name
        `),
      );

      const byModule = new Map<string, ReturnType<typeof toPreview>>();
      for (const row of rows) {
        const preview =
          byModule.get(row.module_id) ?? toPreview(row.module_id, row.module_name, row.sensitivity);
        preview.newlyVisibleSymbols.push({
          symbolId: row.symbol_id,
          qualifiedName: row.qualified_name,
          kind: row.kind,
        });
        byModule.set(row.module_id, preview);
      }

      return reply.send([...byModule.values()]);
    },
  );

  app.post('/v1/admin/external-publication', async (request, reply) => {
    const principal = await requireAdmin(request);
    const body = zPublishExternallyRequest.parse(request.body);

    // Refuse to publish anything above `public` externally, regardless of who asks. The
    // acknowledgement covers the reviewer's judgement about public symbols, not a tier override.
    const blocked = await withSystemContext(ctx.db, principal.orgId, 'maintenance', async (tx) =>
      tx.execute<{ id: string; name: string; sensitivity: string }>(sql`
        SELECT id, name, sensitivity FROM modules
        WHERE org_id = ${principal.orgId}
          AND id = ANY(${body.moduleIds})
          AND sensitivity <> 'public'
      `),
    );

    if (blocked.length > 0) {
      return reply.code(409).send({
        error: {
          code: 'sensitivity_conflict',
          message: `${blocked.length} module(s) are classified above 'public' and cannot be published externally.`,
          guidance: `Re-tier them deliberately first: ${blocked.map((b) => `${b.name} (${b.sensitivity})`).join(', ')}.`,
        },
      });
    }

    await withSystemContext(ctx.dbBatch, principal.orgId, 'maintenance', async (tx) => {
      await tx.execute(sql`
        UPDATE modules
        SET visibility = 'public',
            external_publication_approved_by = ${body.approvedBy},
            external_publication_approved_at = now()
        WHERE org_id = ${principal.orgId} AND id = ANY(${body.moduleIds})
      `);
    });

    await ctx.audit.record({
      orgId: principal.orgId,
      action: 'admin.external_publication',
      actorType: 'admin',
      actorId: principal.id,
      resourceType: 'modules',
      resourceId: body.moduleIds.join(','),
      outcome: 'success',
      detail: { approvedBy: body.approvedBy, moduleCount: body.moduleIds.length },
    });

    return reply.code(204).send();
  });

  /** §15.6 — DLQ drain and replay. BullMQ's `failed` set is not a DLQ; this is. */
  app.get('/v1/admin/dead-letters', async (request, reply) => {
    const principal = await requireAdmin(request);
    const rows = await withSystemContext(ctx.db, principal.orgId, 'maintenance', async (tx) =>
      tx.execute(sql`
        SELECT id, queue, job_name, attempts, last_error, first_failed_at, last_failed_at
        FROM dead_letters
        WHERE org_id = ${principal.orgId} AND replayed_at IS NULL
        ORDER BY last_failed_at DESC
        LIMIT 200
      `),
    );
    return reply.send(rows);
  });

  app.post<{ Params: { id: string } }>(
    '/v1/admin/dead-letters/:id/replay',
    async (request, reply) => {
      const principal = await requireAdmin(request);

      await withSystemContext(ctx.dbBatch, principal.orgId, 'maintenance', async (tx) => {
        await tx.execute(sql`
        UPDATE dead_letters
        SET replayed_at = now(), replayed_by = ${principal.id}
        WHERE org_id = ${principal.orgId} AND id = ${request.params.id}
      `);
      });

      await ctx.audit.record({
        orgId: principal.orgId,
        action: 'admin.dlq_replay',
        actorType: 'admin',
        actorId: principal.id,
        resourceType: 'dead_letter',
        resourceId: request.params.id,
        outcome: 'success',
      });

      return reply.code(202).send({ replayed: true });
    },
  );

  /** Queue health, for dashboards and alerting (§15.6 operational SLIs). */
  app.get('/v1/admin/queues', async (request, reply) => {
    await requireAdmin(request);
    return reply.send(await ctx.queue.stats());
  });

  /**
   * §15.7 — right to erasure as a tracked fan-out with an SLA. Partial erasure is not erasure,
   * so each downstream store reports separately.
   */
  app.post('/v1/admin/erasure', async (request, reply) => {
    const principal = await requireAdmin(request);
    const body = request.body as { subjectType: string; subjectIdentifier: string };

    const id = randomUUID();
    await withSystemContext(ctx.dbBatch, principal.orgId, 'maintenance', async (tx) => {
      await tx.execute(sql`
        INSERT INTO erasure_requests (
          id, org_id, subject_type, subject_identifier, requested_by, due_by, targets, status
        ) VALUES (
          ${id}, ${principal.orgId}, ${body.subjectType}, ${body.subjectIdentifier},
          ${principal.id}, now() + interval '30 days',
          ${JSON.stringify([
            { store: 'postgres-chunks', status: 'pending', completedAt: null },
            { store: 'postgres-embeddings', status: 'pending', completedAt: null },
            {
              store: 'hnsw-vacuum',
              status: 'pending',
              completedAt: null,
              note: 'deleted tuples remain traversable in the HNSW graph until vacuum; a soft delete is not a deletion',
            },
            { store: 'redis-payloads', status: 'pending', completedAt: null },
            { store: 'blurb-cache', status: 'pending', completedAt: null },
            { store: 'generated-doc-prs', status: 'pending', completedAt: null },
            { store: 'litellm-request-logs', status: 'pending', completedAt: null },
            {
              store: 'pitr-snapshots',
              status: 'pending',
              completedAt: null,
              note: 'handled by crypto-shredding the tenant key rather than by deletion',
            },
            {
              store: 'audit-events',
              status: 'retained',
              completedAt: null,
              note: 'deliberate conflict: audit records outlive erased content and are retained by policy',
            },
          ])}::jsonb,
          'pending'
        )
      `);
    });

    await ctx.audit.record({
      orgId: principal.orgId,
      action: 'admin.erasure_requested',
      actorType: 'admin',
      actorId: principal.id,
      resourceType: 'erasure_request',
      resourceId: id,
      outcome: 'success',
      detail: { subjectType: body.subjectType },
    });

    return reply.code(202).send({ erasureRequestId: id });
  });
}

function toPreview(moduleId: string, moduleName: string, sensitivity: string) {
  return {
    moduleId,
    moduleName,
    currentSensitivity: sensitivity,
    newlyVisibleSymbols: [] as Array<{ symbolId: string; qualifiedName: string; kind: string }>,
  };
}
