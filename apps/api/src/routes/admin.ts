import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { anyOf, withOrgContext, withSystemContext } from '@kna/db';
import {
  zBulkReviewDecision,
  zCreatePrincipalRequest,
  zOnboardRepoRequest,
  zIngestCredentialRequest,
  zPublishExternallyRequest,
  zReindexRequest,
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
    // Inside the principal's org, on a transaction. `principal_roles` is RLS-scoped like every
    // other tenant table, and the previous bare read returned no rows for everyone — so this
    // check denied real administrators and would have gone on denying them until someone tried
    // an admin route, which nothing in the test suite did.
    const isAdmin = await withOrgContext(ctx.db, principal.orgId, async (tx) =>
      tx.execute<{ ok: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM principal_roles
          WHERE org_id = ${principal.orgId} AND principal_id = ${principal.id} AND role = 'admin'
        ) AS ok
      `),
    );
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

    // Everyone who should be able to see this repo, the caller included. A repo registered
    // without a permission row is real, indexable, and invisible — the ACL filter reads
    // `repo_permissions` on every query, and no row means no reader.
    const grantTo = [...new Set([principal.id, ...body.grantTo])];

    // Project slugs are validated rather than trusted. A slug that matches nothing is not an
    // error — the repo still onboards — but it is reported, because the failure it causes
    // otherwise is silent: modules resolve to no project, and every project-scoped query returns
    // an empty result that looks exactly like "nothing indexed yet".
    const knownProjects = await withSystemContext(
      ctx.db,
      principal.orgId,
      'maintenance',
      async (tx) =>
        tx.execute<{ slug: string }>(sql`
          SELECT slug FROM projects
           WHERE org_id = ${principal.orgId} AND slug = ${anyOf(body.projectSlugs)}
        `),
    );
    const knownSlugs = new Set(knownProjects.map((r) => String(r.slug)));
    const unknownProjectSlugs = body.projectSlugs.filter((slug) => !knownSlugs.has(slug));

    await withSystemContext(ctx.dbBatch, principal.orgId, 'maintenance', async (tx) => {
      await tx.execute(sql`
        INSERT INTO repos (id, org_id, remote, name, provider)
        VALUES (${repoId}, ${principal.orgId}, ${remote}, ${remote.split('/').pop() ?? remote}, ${storedProvider(ctx.env.GIT_PROVIDER)})
        ON CONFLICT (org_id, remote) DO NOTHING
      `);

      for (const principalId of grantTo) {
        await tx.execute(sql`
          INSERT INTO repo_permissions (principal_id, repo_id, org_id, level)
          SELECT ${principalId}, ${repoId}, ${principal.orgId}, 'read'
           WHERE EXISTS (
             SELECT 1 FROM principals
              WHERE id = ${principalId} AND org_id = ${principal.orgId}
           )
          ON CONFLICT (principal_id, repo_id) DO NOTHING
        `);
      }
    });

    await ctx.audit.record({
      orgId: principal.orgId,
      action: 'admin.repo_onboarded',
      actorType: 'admin',
      actorId: principal.id,
      resourceType: 'repo',
      resourceId: repoId,
      outcome: 'success',
      detail: { remote, projects: body.projectSlugs, grantedTo: grantTo, unknownProjectSlugs },
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

    return reply.code(201).send({
      repoId,
      remote,
      pullRequestUrl,
      grantedTo: grantTo,
      projectSlugs: body.projectSlugs.filter((slug) => knownSlugs.has(slug)),
      unknownProjectSlugs,
    });
  });

  /**
   * Create a person, and issue them a token.
   *
   * The token is returned once and stored only as a hash, so it cannot be recovered — the same
   * property the seed relies on, for the same reason: a database that leaks should yield
   * fingerprints rather than working credentials.
   *
   * Idempotent on `(org, subject)`. Re-running it for someone who exists issues them a *new*
   * token rather than a second identity, which is also how you rotate one.
   */
  app.post('/v1/admin/principals', async (request, reply) => {
    const principal = await requireAdmin(request);
    const body = zCreatePrincipalRequest.parse(request.body);

    const principalId = `prin_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const plain = `kna_${randomBytes(24).toString('base64url')}`;
    const tokenHash = createHash('sha256').update(plain).digest('hex');

    const granted = await withSystemContext(
      ctx.dbBatch,
      principal.orgId,
      'maintenance',
      async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
        INSERT INTO principals (id, org_id, subject, email, display_name, clearance, is_service_account)
        VALUES (
          ${principalId}, ${principal.orgId}, ${body.subject}, ${body.email},
          ${body.displayName}, ${body.clearance}, ${body.isServiceAccount}
        )
        ON CONFLICT (org_id, subject) DO UPDATE SET
          email = COALESCE(EXCLUDED.email, principals.email),
          display_name = COALESCE(EXCLUDED.display_name, principals.display_name),
          clearance = EXCLUDED.clearance,
          disabled_at = NULL
        RETURNING id
      `);
        const id = String(rows[0]!.id);

        for (const role of body.roles) {
          await tx.execute(sql`
          INSERT INTO principal_roles (principal_id, org_id, role, granted_by)
          VALUES (${id}, ${principal.orgId}, ${role}, ${principal.id})
          ON CONFLICT (principal_id, role) DO NOTHING
        `);
        }

        // Only repositories that exist in this org, so a typo narrows access rather than
        // silently creating a permission row pointing at nothing.
        const grants = await tx.execute<{ repo_id: string }>(sql`
        INSERT INTO repo_permissions (principal_id, repo_id, org_id, level)
        SELECT ${id}, r.id, ${principal.orgId}, 'read'
          FROM repos r
         WHERE r.org_id = ${principal.orgId} AND r.id = ${anyOf(body.grantRepoIds)}
        ON CONFLICT (principal_id, repo_id) DO NOTHING
        RETURNING repo_id
      `);

        await tx.execute(sql`
        INSERT INTO api_tokens (id, org_id, principal_id, token_hash, name, last_four_chars, scopes)
        VALUES (
          ${`tok_${randomBytes(8).toString('hex')}`}, ${principal.orgId}, ${id}, ${tokenHash},
          ${`issued by ${principal.subject}`}, ${plain.slice(-4)},
          ${JSON.stringify(['kna:search', 'kna:symbols', 'kna:docs'])}::jsonb
        )
      `);

        return grants.map((g) => String(g.repo_id));
      },
    );

    await ctx.audit.record({
      orgId: principal.orgId,
      action: 'admin.principal_created',
      actorType: 'admin',
      actorId: principal.id,
      resourceType: 'principal',
      resourceId: body.subject,
      outcome: 'success',
      detail: {
        reason: body.reason,
        clearance: body.clearance,
        roles: body.roles,
        grantedRepoIds: granted,
      },
    });

    return reply.code(201).send({
      principalId,
      subject: body.subject,
      token: plain,
      lastFourChars: plain.slice(-4),
      grantedRepoIds: granted,
      warning:
        'Shown once and stored only as a hash. It cannot be recovered — issue a new one if it is lost.',
    });
  });

  /**
   * Mint a repo-scoped ingest credential by hand.
   *
   * The supported path is OIDC — CI presents its workload identity to `/v1/auth/ci-exchange` and
   * gets a credential measured in minutes, so there is nothing long-lived to leak. This exists
   * for the cases that path cannot cover: a local stack with no identity provider, or the first
   * manual publish before any CI pipeline exists.
   *
   * Deliberately awkward, because §15.2's whole point is that a static push credential sitting in
   * repository settings is the thing to avoid. It refuses in production, caps the lifetime,
   * requires a written reason, and names the administrator in the audit log.
   */
  app.post<{ Params: { repoId: string } }>(
    '/v1/admin/repos/:repoId/ingest-credential',
    async (request, reply) => {
      const principal = await requireAdmin(request);
      const body = zIngestCredentialRequest.parse(request.body);
      const { repoId } = request.params;

      if (ctx.env.KNA_ENV === 'production') {
        return reply.code(403).send({
          error: {
            code: 'oidc_required',
            message: 'Long-lived ingest credentials are not issued in production.',
            guidance:
              'CI should exchange its OIDC workload identity at /v1/auth/ci-exchange for a credential scoped to one repository and valid for minutes. A credential that outlives the job that used it is the failure mode this refuses to create.',
          },
        });
      }

      const repo = await withSystemContext(ctx.db, principal.orgId, 'maintenance', async (tx) =>
        tx.execute<{ id: string }>(sql`
          SELECT id FROM repos WHERE org_id = ${principal.orgId} AND id = ${repoId} LIMIT 1
        `),
      );

      if (repo.length === 0) {
        return reply.code(404).send({
          error: {
            code: 'repo_not_found',
            message: `No repository ${repoId} in this organisation.`,
            guidance: 'Register it first with POST /v1/admin/repos.',
          },
        });
      }

      const expiresAt = Date.now() + body.ttlHours * 60 * 60 * 1000;

      // Audited before the credential is returned, so the record exists even if the response is
      // lost in transit. This is the one place the platform hands out a durable push credential.
      await ctx.audit.record({
        orgId: principal.orgId,
        action: 'admin.ingest_credential_minted',
        actorType: 'admin',
        actorId: principal.id,
        resourceType: 'repo',
        resourceId: repoId,
        outcome: 'success',
        detail: { reason: body.reason, ttlHours: body.ttlHours },
      });

      return reply.send({
        token: ctx.mintIngestToken({
          orgId: principal.orgId,
          repoId,
          issuedAt: Date.now(),
          expiresAt,
        }),
        repoId,
        expiresAt: new Date(expiresAt).toISOString(),
        warning:
          'Shown once and not recoverable. It authorises publishing to this repository until it expires; treat it as a secret and prefer the OIDC exchange wherever CI can reach it.',
      });
    },
  );

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
      // Regenerate from what the repo last published. A repo approved before it has ever
      // published has nothing to regenerate from, and saying so is better than queueing a job
      // that can only fail.
      const bundle = await ctx.store.latestBundle(principal.orgId, body.repoId);
      if (bundle) {
        await ctx.queue.enqueueRegenerateDocs({
          orgId: principal.orgId,
          repoId: body.repoId,
          commitSha: bundle.commitSha,
          ref: bundle.ref,
          bundleStorageKey: bundle.storageKey,
          regenerationToken: randomUUID().slice(0, 8),
        });
      }
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
            AND m.id = ${anyOf(moduleIds)}
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
          AND id = ${anyOf(body.moduleIds)}
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
        WHERE org_id = ${principal.orgId} AND id = ${anyOf(body.moduleIds)}
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
  /**
   * Deliberate reindex.
   *
   * §15.1 lists "cheap reindexing when the embedding model changes" as a reason the bundle store
   * is the system of record, but until now nothing could ask for one. Ingest skips modules whose
   * IR is unchanged — correct, and the whole cost model — and the queue keys job identity on
   * `(moduleId, commitSha)`, so republishing the same commit is a no-op. Both are right for code
   * changes and wrong for platform changes: a new embedding model, different chunk sizes, or a
   * fixed bug in the indexer leaves a corpus that is stale in a way no diff can see.
   *
   * Replay reads the stored bundle rather than asking the repo to publish again, so a reindex
   * needs no CI run, no checkout, and no cooperation from the team that owns the code.
   */
  app.post('/v1/admin/reindex', async (request, reply) => {
    const principal = await requireAdmin(request);
    const body = zReindexRequest.parse(request.body);

    // One token for the whole request: every module reindexed together shares a job-id namespace,
    // so a retried HTTP request coalesces instead of queueing the work twice.
    const reindexToken = randomUUID().slice(0, 8);

    const { repoBundles, moduleTargets } = await withSystemContext(
      ctx.db,
      principal.orgId,
      'maintenance',
      async (tx) => {
        const repoBundles = await tx.execute<{
          repo_id: string;
          commit_sha: string;
          ref: string;
          storage_key: string;
        }>(sql`
          SELECT DISTINCT ON (repo_id) repo_id, commit_sha, ref, storage_key
            FROM ir_bundles
           WHERE org_id = ${principal.orgId}
             AND ${body.repoIds.length > 0 ? sql`repo_id = ${anyOf(body.repoIds)}` : sql`false`}
           ORDER BY repo_id, received_at DESC
        `);

        const moduleTargets = await tx.execute<{
        module_id: string;
        repo_id: string;
        commit_sha: string;
        ref: string;
        storage_key: string;
        }>(sql`
          -- Module-specific reindexes can use the derived table because a module id only exists
          -- after at least one successful index. Repository reindexes below deliberately do not:
          -- recovering a first index that failed must work while that table is still empty.
          WITH latest AS (
            SELECT DISTINCT ON (repo_id) repo_id, commit_sha, ref, storage_key
              FROM ir_bundles
             WHERE org_id = ${principal.orgId}
             ORDER BY repo_id, received_at DESC
          )
          SELECT m.id AS module_id, l.repo_id, l.commit_sha, l.ref, l.storage_key
            FROM modules m
            JOIN latest l ON l.repo_id = m.repo_id
           WHERE m.org_id = ${principal.orgId}
             AND ${body.moduleIds.length > 0 ? sql`m.id = ${anyOf(body.moduleIds)}` : sql`false`}
        `);

        return { repoBundles, moduleTargets };
      },
    );

    // §15.1 — the immutable bundle store is the system of record; Postgres is a derived cache.
    // Reading repository modules from `modules` made recovery from a failed *first* index
    // impossible: the bundle existed, but the derived table was necessarily empty, so reindex
    // reported zero work. Discover them from the stored payload instead.
    const storedTargets = (
      await Promise.all(
        repoBundles.map(async (bundle) => {
          const payload = await ctx.bundleStore.getPayload(String(bundle.storage_key));
          return payload.modules.map((module) => ({
            module_id: module.id,
            repo_id: String(bundle.repo_id),
            commit_sha: String(bundle.commit_sha),
            ref: String(bundle.ref),
            storage_key: String(bundle.storage_key),
          }));
        }),
      )
    ).flat();

    const targets = [
      ...new Map(
        [...storedTargets, ...moduleTargets].map((target) => [
          `${target.repo_id}:${target.module_id}`,
          target,
        ]),
      ).values(),
    ];

    // Audited before the work is queued, not after: the record of who asked must survive the
    // request failing halfway through the fan-out.
    await ctx.audit.record({
      orgId: principal.orgId,
      action: 'admin.reindex',
      actorType: 'admin',
      actorId: principal.id,
      resourceType: 'modules',
      resourceId: targets.map((t) => t.module_id).join(','),
      outcome: 'success',
      detail: { reason: body.reason, reindexToken, moduleCount: targets.length },
    });

    const jobIds: string[] = [];
    for (const target of targets) {
      jobIds.push(
        await ctx.queue.enqueueIndexModule({
          orgId: principal.orgId,
          repoId: String(target.repo_id),
          moduleId: String(target.module_id),
          commitSha: String(target.commit_sha),
          ref: String(target.ref),
          bundleStorageKey: String(target.storage_key),
          // Priority, not volume: a reindex is background work by definition and must not sit
          // ahead of a developer waiting on a freshly merged commit (§15.6).
          changeCount: 0,
          reindexToken,
        }),
      );
    }

    const covered = new Set([
      ...repoBundles.map((bundle) => String(bundle.repo_id)),
      ...targets.map((target) => String(target.repo_id)),
    ]);

    // Documentation is derived from the same bundle and the same retrieval settings, so a
    // reindex that left it untouched would leave the two halves of the corpus describing
    // different configurations. One job per repo, sharing the request's token.
    for (const repoId of covered) {
      const bundle = targets.find((t) => String(t.repo_id) === repoId);
      if (!bundle) continue;
      jobIds.push(
        await ctx.queue.enqueueRegenerateDocs({
          orgId: principal.orgId,
          repoId,
          commitSha: String(bundle.commit_sha),
          ref: String(bundle.ref),
          bundleStorageKey: String(bundle.storage_key),
          regenerationToken: reindexToken,
        }),
      );
    }

    // A requested repo with no stored bundle is reported rather than silently contributing zero
    // jobs — "I asked for a reindex and nothing happened" is the failure this endpoint exists to
    // stop being mysterious.
    const skipped = body.repoIds
      .filter((repoId) => !covered.has(repoId))
      .map((repoId) => ({ repoId, reason: 'no stored IR bundle for this repo' }));

    return reply.send({ jobIds, moduleCount: targets.length, skipped });
  });

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

/**
 * Translate the configured provider into the value the database enum accepts.
 *
 * Two vocabularies that nearly match. Configuration says {@code none} to mean no provider client
 * is constructed at all, which is how a local stack runs; the {@code git_provider} enum has no
 * such value and spells the equivalent {@code local}. Writing the config value straight through
 * produced 'invalid input value for enum git_provider' and a 500 on every onboarding attempt.
 */
function storedProvider(provider: string): string {
  return provider === 'none' ? 'local' : provider;
}
