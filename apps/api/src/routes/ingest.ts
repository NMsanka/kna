import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import {
  contentHash,
  diffIr,
  evaluateCircuitBreaker,
  degradedPlan,
  upcastBundle,
  IrVersionError,
  type IrBundlePayload,
} from '@kna/ir';
import { verifyEnvelope, explainFailure, zIngestResponse } from '@kna/contracts';
import { withSystemContext } from '@kna/db';
import { verifyIngestToken, AuthError } from '../auth.js';
import type { ApiContext, KnaServer } from '../context.js';
import { OidcError } from '../services/oidc.js';

/**
 * The ingest endpoint — the trust boundary.
 *
 * §15.2 rates a forged bundle above prompt injection as a threat, "since forged IR bypasses all
 * CLI-side scanning in Layer 2 entirely". The order of operations here is therefore: verify the
 * credential, verify the envelope, store the bundle durably, *then* do anything derived.
 *
 * §15.1 fix 1 is why storage comes before indexing: "make the IR bundle store the system of
 * record... Postgres becomes an explicitly derived cache." If the bundle is not durably stored,
 * nothing downstream should have happened, because it could not be replayed.
 */
export async function registerIngestRoutes(app: KnaServer, ctx: ApiContext): Promise<void> {
  app.post('/v1/ingest', async (request, reply) => {
    const started = Date.now();
    const traceId = randomUUID();

    // ── 1. Credential ────────────────────────────────────────────────────────────────────────
    const token = bearerFrom(request.headers.authorization);
    if (!token) {
      throw new AuthError('Missing bearer token.', 401, 'missing_token');
    }
    const claims = verifyIngestToken(ctx.env.INGEST_HMAC_SECRET ?? ctx.env.SESSION_SECRET, token);

    // ── 2. Schema, with the N-2 upcast window (§15.3) ────────────────────────────────────────
    let upcast;
    try {
      upcast = upcastBundle(request.body);
    } catch (error) {
      if (error instanceof IrVersionError) {
        ctx.metrics.bundlesRejected.add(1, { reason: 'version' });
        return reply.code(400).send({
          error: {
            code: 'ir_version_unsupported',
            message: error.message,
            guidance: error.producerIsNewer
              ? 'Rebuild and restart the API and worker so they use the same IR schema as docs-cli.'
              : `This platform accepts IR schema ${error.minimum} through ${error.current}. Upgrade docs-cli.`,
            traceId,
          },
        });
      }
      throw error;
    }

    const { bundle, warnings } = upcast;

    // ── 3. Scope binding: the credential must match what the bundle asserts ──────────────────
    // A token scoped to one repo cannot publish for another, and cannot assert another
    // tenant's orgId. This is the check §15.2 is actually about.
    if (claims.orgId !== bundle.envelope.orgId || claims.repoId !== bundle.envelope.repoId) {
      ctx.metrics.bundlesRejected.add(1, { reason: 'scope' });
      await ctx.audit.record({
        orgId: claims.orgId,
        action: 'ingest.scope_violation',
        actorType: 'ci',
        actorId: claims.repoId,
        outcome: 'denied',
        detail: {
          tokenOrg: claims.orgId,
          tokenRepo: claims.repoId,
          assertedOrg: bundle.envelope.orgId,
          assertedRepo: bundle.envelope.repoId,
        },
        traceId,
      });
      return reply.code(403).send({
        error: {
          code: 'scope_violation',
          message: 'The ingest credential does not authorise the org and repo this bundle asserts.',
          guidance:
            'Ingest credentials are scoped to a single repository. Mint one per repo via the CI OIDC exchange.',
          traceId,
        },
      });
    }

    // ── 4. Envelope verification ─────────────────────────────────────────────────────────────
    const actualPayloadHash = contentHash(bundle.payload);
    const actualPayloadBytes = Buffer.byteLength(JSON.stringify(bundle.payload), 'utf8');

    const verification = await verifyEnvelope({
      envelope: bundle.envelope,
      actualPayloadHash,
      actualPayloadBytes,
      mode: ctx.env.INGEST_SIGNATURE_MODE,
      hmacSecret: ctx.env.INGEST_HMAC_SECRET,
      maxBundleBytes: ctx.env.INGEST_MAX_BUNDLE_BYTES,
      isNonceSeen: (orgId, nonce) => ctx.store.isNonceSeen(orgId, nonce),
      verifyCommit: ctx.git ? (input) => ctx.git!.commitExists(input) : undefined,
      resolveRepoRemote: (repoId) => ctx.store.repoRemote(repoId),
      scanPassed: bundle.payload.scan.passed,
      isProduction: ctx.env.KNA_ENV === 'production',
    });

    if (!verification.valid) {
      ctx.metrics.bundlesRejected.add(1, { reason: verification.failure ?? 'unknown' });
      await ctx.audit.record({
        orgId: bundle.envelope.orgId,
        action: 'ingest.rejected',
        actorType: 'ci',
        actorId: bundle.envelope.repoId,
        outcome: 'denied',
        detail: { failure: verification.failure, detail: verification.detail },
        traceId,
      });

      // A replay is not an error. §7 — "webhooks get replayed; replays must be no-ops."
      const status = verification.failure === 'replayed' ? 200 : 400;
      if (status === 200) {
        return reply.code(200).send(
          zIngestResponse.parse({
            accepted: false,
            bundleId: bundle.envelope.bundleId,
            storageKey: null,
            jobIds: [],
            warnings: ['This bundle was already ingested; treating the replay as a no-op.'],
          }),
        );
      }

      return reply.code(status).send({
        error: {
          code: verification.failure ?? 'verification_failed',
          message: verification.detail ?? 'Bundle verification failed.',
          guidance: explainFailure(verification),
          traceId,
        },
      });
    }

    // ── 5. Durable storage BEFORE anything derived (§15.1 fix 1) ─────────────────────────────
    const storageKey = await ctx.bundleStore.put(bundle);

    // ── 6. Diff and classify (§7) ────────────────────────────────────────────────────────────
    const previous: IrBundlePayload | null = await ctx.store.lastIndexedPayload(
      bundle.envelope.orgId,
      bundle.envelope.repoId,
      bundle.envelope.ref,
    );

    const diff = diffIr(previous, bundle.payload);

    // ── 7. Magnitude circuit breaker (§15.3) ─────────────────────────────────────────────────
    const verdict = evaluateCircuitBreaker(diff, {
      maxChurnRatio: ctx.env.CIRCUIT_MAX_CHURN_RATIO,
      maxChangedSymbols: ctx.env.CIRCUIT_MAX_CHANGED_SYMBOLS,
      maxRegenerations: ctx.env.CIRCUIT_MAX_REGENERATIONS,
      exemptFirstIndex: true,
      smallRepoFloor: 50,
    });
    const plan = degradedPlan(verdict);

    if (verdict.tripped) {
      ctx.metrics.circuitBreakerTrips.add(1, { rule: verdict.rule });
      await ctx.store.markPendingBulkReview(
        bundle.envelope.orgId,
        bundle.envelope.repoId,
        verdict.reason,
      );
    }

    // ── 8. Record the bundle, then fan out per module ────────────────────────────────────────
    await ctx.store.recordBundle({
      bundle,
      storageKey,
      upcastedFrom: upcast.upcasted ? upcast.fromVersion : null,
    });

    const jobIds: string[] = [];
    if (plan.reindex) {
      // §15.1 fix 3 — module, not repo, is the unit of atomicity and concurrency.
      for (const module of bundle.payload.modules) {
        const moduleChanges = diff.changes.filter(
          (c) => c.moduleId === module.id && (c.action.reindex || c.changeClass === 'removed'),
        );
        // A module with no changes at all is skipped entirely: this is where the "cents per
        // merge" cost model actually comes from.
        if (moduleChanges.length === 0 && previous !== null) continue;

        const jobId = await ctx.queue.enqueueIndexModule({
          orgId: bundle.envelope.orgId,
          repoId: bundle.envelope.repoId,
          moduleId: module.id,
          commitSha: bundle.envelope.commitSha,
          ref: bundle.envelope.ref,
          bundleStorageKey: storageKey,
          changeCount: moduleChanges.length,
        });
        jobIds.push(jobId);
      }
    }

    // Existing documentation has its own acquisition and indexing lifecycle. It is not tied to
    // symbol diffs and must run even when no code symbol changed.
    if (bundle.payload.documents.length > 0 || previous?.documents.length) {
      const jobId = await ctx.queue.enqueueIndexDocuments({
        orgId: bundle.envelope.orgId,
        repoId: bundle.envelope.repoId,
        commitSha: bundle.envelope.commitSha,
        ref: bundle.envelope.ref,
        bundleStorageKey: storageKey,
      });
      jobIds.push(jobId);
    }

    if (plan.regenerate && diff.totals.regenerateCount > 0) {
      const jobId = await ctx.queue.enqueueRegenerateDocs({
        orgId: bundle.envelope.orgId,
        repoId: bundle.envelope.repoId,
        commitSha: bundle.envelope.commitSha,
        ref: bundle.envelope.ref,
        bundleStorageKey: storageKey,
      });
      jobIds.push(jobId);
    }

    ctx.metrics.bundlesIngested.add(1, { repo: bundle.envelope.repoId });
    ctx.metrics.indexLagSeconds.record(
      bundle.payload.version.committedAt
        ? (Date.now() - new Date(bundle.payload.version.committedAt).getTime()) / 1000
        : 0,
      { repo: bundle.envelope.repoId },
    );
    ctx.metrics.secretsBlocked.add(bundle.payload.scan.secretsFound, {
      repo: bundle.envelope.repoId,
    });
    ctx.metrics.injectionFlagged.add(bundle.payload.scan.injectionPatternsFlagged, {
      repo: bundle.envelope.repoId,
    });

    await ctx.audit.record({
      orgId: bundle.envelope.orgId,
      action: 'ingest.accepted',
      actorType: 'ci',
      actorId: bundle.envelope.repoId,
      resourceType: 'bundle',
      resourceId: bundle.envelope.bundleId,
      outcome: 'success',
      detail: {
        commitSha: bundle.envelope.commitSha,
        symbols: bundle.payload.symbols.length,
        durationMs: Date.now() - started,
        breakerTripped: verdict.tripped,
      },
      traceId,
    });

    return reply.code(202).send(
      zIngestResponse.parse({
        accepted: true,
        bundleId: bundle.envelope.bundleId,
        storageKey,
        jobIds,
        warnings,
        circuitBreaker: verdict.tripped
          ? {
              tripped: true,
              rule: verdict.rule,
              reason: verdict.reason,
              requiresOperatorApproval: plan.requiresOperatorApproval,
            }
          : null,
        diff: {
          added: diff.totals.added,
          removed: diff.totals.removed,
          changed: diff.totals.changed,
          unchanged: diff.totals.unchanged,
          breaking: diff.totals.breaking,
          reindexCount: diff.totals.reindexCount,
          regenerateCount: diff.totals.regenerateCount,
        },
      }),
    );
  });

  /**
   * §15.2 — the OIDC exchange. The runner presents its workload identity and receives a
   * credential scoped to exactly one repository, valid for minutes.
   */
  app.post('/v1/auth/ci-exchange', async (request, reply) => {
    const body = request.body as { idToken?: string; repoRemote?: string; audience?: string };
    if (!body.idToken || !body.repoRemote) {
      return reply.code(400).send({
        error: { code: 'invalid_request', message: 'idToken and repoRemote are required.' },
      });
    }

    if (!ctx.oidc) {
      return reply.code(501).send({
        error: {
          code: 'oidc_not_configured',
          message: 'This deployment has no OIDC issuer configured.',
          guidance: 'Set OIDC_ISSUER to enable short-lived, repo-scoped ingest credentials.',
        },
      });
    }

    // Every message the verifier produces names exactly what is wrong: wrong audience,
    // expired, unknown issuer, no matching key. Letting them escape collapsed all of it into
    // one 500 reading 'The request could not be completed' — on the single endpoint whose
    // caller is a workflow that cannot read our logs and has no other way to find out.
    let identity;
    try {
      identity = await ctx.oidc.verify(body.idToken, body.audience ?? ctx.env.OIDC_AUDIENCE);
    } catch (error) {
      if (!(error instanceof OidcError)) throw error;

      if (error.failure === 'issuer') {
        request.log.error({ err: error.message }, 'oidc issuer unreachable');
        return reply.code(502).send({
          error: {
            code: 'oidc_issuer_unreachable',
            message: 'The configured OIDC issuer could not be reached.',
            guidance:
              'Nothing is wrong with the workflow. Retry, and if it persists check that this ' +
              'deployment has outbound access to the issuer.',
          },
        });
      }

      return reply.code(401).send({
        error: {
          code: 'invalid_oidc_token',
          message: error.message,
          guidance:
            'The job needs `permissions: id-token: write`, and must request the audience this ' +
            'deployment expects.',
        },
      });
    }
    const result = await ctx.store.resolveRepoForIdentity(identity, body.repoRemote);

    if (!result) {
      return reply.code(403).send({
        error: {
          code: 'repo_not_registered',
          message: `The workload identity '${identity.subject}' is not authorised for ${body.repoRemote}.`,
          guidance:
            'Register the repository with the platform first, then re-run. Onboarding is one command: `kna init`.',
        },
      });
    }

    const expiresAt = Date.now() + ctx.env.INGEST_TOKEN_TTL_SECONDS * 1000;
    return reply.send({
      token: mintFor(ctx, result.orgId, result.repoId, expiresAt),
      expiresAt: new Date(expiresAt).toISOString(),
      repoId: result.repoId,
      orgId: result.orgId,
    });
  });

  /** Repo status, for `kna doctor`. */
  app.get<{ Params: { repoId: string } }>('/v1/repos/:repoId/status', async (request, reply) => {
    const principal = await ctx.authenticate(request);
    const status = await withSystemContext(ctx.db, principal.orgId, 'maintenance', async (tx) => {
      const rows = await tx.execute<{
        last_indexed_sha: string | null;
        last_indexed_at: string | null;
        stale_since_sha: string | null;
        stale_reason: string | null;
        pending_bulk_review: boolean;
        pending_bulk_review_reason: string | null;
      }>(sql`
        SELECT last_indexed_sha, last_indexed_at, stale_since_sha, stale_reason,
               pending_bulk_review, pending_bulk_review_reason
        FROM repos WHERE org_id = ${principal.orgId} AND id = ${request.params.repoId}
      `);
      return rows[0] ?? null;
    });

    if (!status) {
      return reply.code(404).send({
        error: {
          code: 'repo_not_found',
          message: 'This repository is not registered.',
          guidance: 'Run `kna init` and ask an admin to onboard it.',
        },
      });
    }

    return reply.send({
      lastIndexedSha: status.last_indexed_sha,
      lastIndexedAt: status.last_indexed_at,
      staleSinceSha: status.stale_since_sha,
      staleReason: status.stale_reason,
      pendingBulkReview: status.pending_bulk_review,
      pendingBulkReviewReason: status.pending_bulk_review_reason,
    });
  });
}

function bearerFrom(header: string | undefined): string | null {
  if (!header?.startsWith('Bearer ')) return null;
  return header.slice(7).trim() || null;
}

function mintFor(ctx: ApiContext, orgId: string, repoId: string, expiresAt: number): string {
  return ctx.mintIngestToken({ orgId, repoId, issuedAt: Date.now(), expiresAt });
}
