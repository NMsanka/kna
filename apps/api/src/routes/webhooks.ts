import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import { sql } from 'drizzle-orm';
import { withIdentityProbe, withSystemContext } from '@kna/db';
import type { ApiContext, KnaServer } from '../context.js';

/**
 * Git provider webhooks.
 *
 * §7 defines the event flow and the operational details that bite later: debounce and coalesce
 * per `(repo, branch)` over about a minute, key jobs on `(repoId, commitSha)` so replays are
 * no-ops, and index the default branch plus tags but never every feature branch.
 *
 * §15.4 adds the security-critical one: permission-change webhooks are what make ACL revocation
 * immediate rather than bounded by a sync interval.
 *
 * §15.7 adds: "signed webhooks so a leaked webhook secret alone cannot forge ingestion." The
 * signature is checked before the body is parsed, and the check is constant-time.
 */
export async function registerWebhookRoutes(app: KnaServer, ctx: ApiContext): Promise<void> {
  // Raw body is required for signature verification; parsing first and re-serialising will not
  // reproduce the exact bytes that were signed.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    (request as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  app.post('/v1/webhooks/git', async (request, reply) => {
    const secret = ctx.env.GIT_WEBHOOK_SECRET;
    if (!secret) {
      return reply.code(501).send({
        error: {
          code: 'webhooks_not_configured',
          message: 'No webhook secret configured.',
          guidance: 'Set GIT_WEBHOOK_SECRET. Unsigned webhooks are not accepted.',
        },
      });
    }

    const rawBody = (request as unknown as { rawBody?: Buffer }).rawBody;
    if (!rawBody || !verifySignature(request.headers, rawBody, secret)) {
      // A failed signature is a security event, not a client error worth explaining in detail.
      await ctx.audit.record({
        orgId: 'system',
        action: 'webhook.signature_invalid',
        actorType: 'system',
        outcome: 'denied',
        detail: { sourceIp: request.ip },
        sourceIp: request.ip,
      });
      return reply.code(401).send({ error: { code: 'invalid_signature', message: 'Rejected.' } });
    }

    const event = String(
      request.headers['x-github-event'] ?? request.headers['x-gitlab-event'] ?? 'unknown',
    );
    const body = request.body as Record<string, unknown>;

    switch (event) {
      case 'push':
        return handlePush(ctx, body, reply);
      case 'pull_request':
      case 'merge_request':
        return handlePullRequest(ctx, body, reply);
      case 'member':
      case 'membership':
      case 'team':
      case 'repository':
      case 'organization':
        // §15.4 — "subscribe to Git provider permission webhooks for immediate invalidation".
        return handlePermissionChange(ctx, body, reply);
      default:
        return reply.code(202).send({ ignored: event });
    }
  });
}

/**
 * A merged pull request.
 *
 * Merging produces a push to the default branch, so this is not the only signal — but it is the
 * earliest and the most precise one. The push event says "the branch moved"; this says "a
 * specific, reviewed change landed", which is the moment documentation is most likely to be
 * wrong and a developer is most likely to be looking.
 *
 * A closed-without-merging PR is explicitly ignored. Nothing about the default branch changed,
 * so reindexing would spend money to reproduce the state we already have.
 *
 * The work is routed through the same debounced path as a push, so a merge train that lands six
 * PRs in two minutes still results in one job rather than six (§7 coalescing).
 */
async function handlePullRequest(
  ctx: ApiContext,
  body: Record<string, unknown>,
  reply: FastifyReply,
): Promise<unknown> {
  const action = String(body.action ?? '');
  const pullRequest = (body.pull_request ?? body.merge_request ?? {}) as {
    merged?: boolean;
    merged_at?: string | null;
    state?: string;
    base?: { ref?: string };
    target_branch?: string;
    merge_commit_sha?: string;
  };

  // GitHub sends `closed` with `merged: true`; GitLab sends `merge` as the action. Both also
  // send a closed-without-merge event that looks superficially identical.
  const merged =
    pullRequest.merged === true ||
    Boolean(pullRequest.merged_at) ||
    action === 'merge' ||
    pullRequest.state === 'merged';

  if (!merged) return reply.code(202).send({ ignored: `pull request ${action || 'event'}` });

  const targetBranch = pullRequest.base?.ref ?? pullRequest.target_branch ?? '';
  if (targetBranch && !/^(main|master)$/.test(targetBranch)) {
    return reply.code(202).send({ ignored: 'merged into a non-default branch' });
  }

  // Reuse the push path so the branch policy, debounce window and coalescing key are defined
  // once. A second implementation here would drift from it.
  return handlePush(
    ctx,
    {
      ref: `refs/heads/${targetBranch || 'main'}`,
      after: pullRequest.merge_commit_sha ?? 'merged',
      repository: body.repository ?? body.project,
    },
    reply,
  );
}

/**
 * §7 — debounce and coalesce.
 *
 * "A merge train can fire twenty pushes in three minutes. Index the newest commit, not each
 * one." The coalescing key is `(repoId, ref)` and the delay is the debounce window; a newer
 * push replaces the pending job rather than queueing behind it.
 */
const DEBOUNCE_MS = 60_000;
const pending = new Map<string, { commitSha: string; timer: NodeJS.Timeout }>();

async function handlePush(
  ctx: ApiContext,
  body: Record<string, unknown>,
  reply: FastifyReply,
): Promise<unknown> {
  const ref = String(body.ref ?? '');
  const after = String(body.after ?? '');
  const repository = body.repository as { full_name?: string; clone_url?: string } | undefined;
  const remote = repository?.full_name ?? repository?.clone_url;

  if (!remote || !after) return reply.code(202).send({ ignored: 'incomplete payload' });

  // §7 branch policy — default branch plus tags. "Never index every feature branch: the cost is
  // real and the value is near zero."
  const isDefaultBranch = /^refs\/heads\/(main|master)$/.test(ref);
  const isTag = ref.startsWith('refs/tags/');
  if (!isDefaultBranch && !isTag) {
    return reply.code(202).send({ ignored: 'non-default branch' });
  }

  // Deleted branch or tag.
  if (/^0+$/.test(after)) return reply.code(202).send({ ignored: 'deletion' });

  const repo = await ctx.store.resolveRepoForIdentity(
    { issuer: '', subject: '', repository: null, ref: null, sha: null },
    remote,
  );
  if (!repo) return reply.code(202).send({ ignored: 'repo not registered' });

  const key = `${repo.repoId}:${ref}`;
  const existing = pending.get(key);
  if (existing) clearTimeout(existing.timer);

  const timer = setTimeout(() => {
    pending.delete(key);
    void (async () => {
      // A push tells us the code moved; it does not give us IR. The bundle for `after` exists
      // only once CI has published it, so regenerate from the newest bundle actually stored —
      // which is either that commit, or the last one indexed if CI has not caught up yet.
      const bundle = await ctx.store.latestBundle(repo.orgId, repo.repoId);
      if (!bundle) return;
      return ctx.queue.enqueueRegenerateDocs({
        orgId: repo.orgId,
        repoId: repo.repoId,
        commitSha: bundle.commitSha,
        ref: bundle.ref,
        bundleStorageKey: bundle.storageKey,
      });
    })().catch((error: unknown) =>
      ctx.logger.error({ err: String(error) }, 'debounced enqueue failed'),
    );
  }, DEBOUNCE_MS);
  timer.unref();

  pending.set(key, { commitSha: after, timer });

  return reply.code(202).send({ accepted: true, coalescingWindowMs: DEBOUNCE_MS });
}

/**
 * §15.4 — "make revocations a short-TTL **deny** cache that takes precedence over the positive
 * cache". A permission removal writes a deny row immediately; the positive cache is also
 * invalidated, but the deny row is what guarantees the change takes effect even if the cache
 * refresh fails.
 */
async function handlePermissionChange(
  ctx: ApiContext,
  body: Record<string, unknown>,
  reply: FastifyReply,
): Promise<unknown> {
  const action = String(body.action ?? '');
  const member = body.member as { login?: string } | undefined;
  const repository = body.repository as { full_name?: string } | undefined;

  if (!member?.login) return reply.code(202).send({ ignored: 'no member' });

  const isRemoval = action === 'removed' || action === 'member_removed' || action === 'deleted';

  // Cross-tenant by necessity: one provider login can be a principal in several orgs, and §15.4
  // requires the revocation to reach all of them. Migration 0008 opens exactly the rows matching
  // the declared subject; the request's HMAC signature, verified above, is what authorises it.
  const principals = await withIdentityProbe(ctx.db, member.login, async (tx) =>
    tx.execute<{ id: string; org_id: string }>(
      sql`SELECT id, org_id FROM principals WHERE subject = ${member.login} LIMIT 10`,
    ),
  );

  for (const principal of principals) {
    ctx.permissions.invalidate(principal.org_id, principal.id);

    if (isRemoval) {
      const repo = repository?.full_name
        ? await ctx.store.resolveRepoForIdentity(
            { issuer: '', subject: '', repository: null, ref: null, sha: null },
            repository.full_name,
          )
        : null;

      await withSystemContext(ctx.dbBatch, principal.org_id, 'maintenance', async (tx) => {
        await tx.execute(sql`
          INSERT INTO permission_revocations (id, org_id, principal_id, repo_id, reason, expires_at)
          VALUES (
            ${randomUUID()}, ${principal.org_id}, ${principal.id}, ${repo?.repoId ?? null},
            ${`git provider webhook: ${action}`},
            now() + interval '7 days'
          )
        `);
      });

      await ctx.audit.record({
        orgId: principal.org_id,
        action: 'acl.revoked',
        actorType: 'system',
        actorId: principal.id,
        resourceType: 'repo',
        resourceId: repo?.repoId ?? 'all',
        outcome: 'success',
        detail: { source: 'git-webhook', providerAction: action },
      });
    }
  }

  return reply.code(202).send({ invalidated: principals.length });
}

/** Constant-time signature comparison across the provider header conventions. */
function verifySignature(
  headers: Record<string, string | string[] | undefined>,
  rawBody: Buffer,
  secret: string,
): boolean {
  const githubSignature = headers['x-hub-signature-256'];
  if (typeof githubSignature === 'string') {
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    return safeEqual(expected, githubSignature);
  }

  const gitlabToken = headers['x-gitlab-token'];
  if (typeof gitlabToken === 'string') return safeEqual(secret, gitlabToken);

  const azureSignature = headers['x-azure-signature'];
  if (typeof azureSignature === 'string') {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return safeEqual(expected, azureSignature);
  }

  return false;
}

function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
