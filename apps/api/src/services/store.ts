import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { anyOf, withAuthProbe, withSystemContext, withOrgContext, type DbHandle } from '@kna/db';
import { canonicalRemote, type IrBundle, type IrBundlePayload } from '@kna/ir';
import type { Principal } from '../auth.js';

/**
 * Platform data access for the API.
 *
 * Read paths run under `withOrgContext` so RLS applies; the two paths §15.4 names as
 * legitimately outside user context — indexing and cross-repo resolution — use
 * `withSystemContext`, which makes that choice visible at the call site rather than implicit in
 * a missing wrapper.
 */

export interface OidcIdentity {
  issuer: string;
  subject: string;
  /** Provider-specific repository claim, e.g. `acme/billing-api`. */
  repository: string | null;
  ref: string | null;
  sha: string | null;
}

export class PlatformStore {
  constructor(
    private readonly db: DbHandle,
    private readonly dbBatch: DbHandle,
  ) {}

  /** Tokens are stored hashed. A database dump must not hand over live credentials. */
  /**
   * Resolve a bearer token to its principal.
   *
   * Two steps, because they run under two different security contexts. The token row is read
   * through the auth probe (migration 0006) — the only read the platform performs without a
   * tenant scope, permitted for exactly the row whose hash the caller names. The principal is
   * then read normally, inside the org that token resolved to, so a token can never reach a
   * principal outside its own tenant even if the token table were somehow wrong.
   *
   * `revoked_at` is checked here and not only at issue time. Revocation that is not enforced on
   * the read path is not revocation.
   */
  /**
   * The most recent IR bundle stored for a repo, or null if it has never published one.
   *
   * Documentation regeneration replays a stored bundle (§15.1), so anything that wants to
   * trigger it needs a real storage key. Three callers previously passed the empty string —
   * which cost nothing while no worker consumed that queue, and would now fail every job.
   */
  async latestBundle(
    orgId: string,
    repoId: string,
  ): Promise<{ commitSha: string; ref: string; storageKey: string } | null> {
    return withSystemContext(this.db, orgId, 'maintenance', async (tx) => {
      const rows = await tx.execute<{ commit_sha: string; ref: string; storage_key: string }>(sql`
        SELECT commit_sha, ref, storage_key
          FROM ir_bundles
         WHERE org_id = ${orgId} AND repo_id = ${repoId}
         ORDER BY received_at DESC
         LIMIT 1
      `);
      const row = rows[0];
      if (!row) return null;
      return {
        commitSha: String(row.commit_sha),
        ref: String(row.ref),
        storageKey: String(row.storage_key),
      };
    });
  }

  async principalForToken(
    token: string,
  ): Promise<(Principal & { disabledAt: Date | null }) | null> {
    const hash = createHash('sha256').update(token).digest('hex');

    const claim = await withAuthProbe(this.db, hash, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT org_id, principal_id
          FROM api_tokens
         WHERE token_hash = ${hash}
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > now())
         LIMIT 1
      `);
      const row = rows[0];
      if (!row) return null;
      // No last-used stamp here. See migration 0007: writing it would mean granting the
      // internet-facing role UPDATE on the credential table, and credential telemetry belongs on
      // the audit path, which has its own writer.
      return { orgId: String(row.org_id), principalId: String(row.principal_id) };
    });

    if (!claim) return null;

    return withOrgContext(this.db, claim.orgId, async (tx) => {
      const rows = await tx.execute(sql`
        SELECT id, org_id, subject, email, clearance, is_service_account, disabled_at
          FROM principals
         WHERE id = ${claim.principalId} AND org_id = ${claim.orgId}
         LIMIT 1
      `);
      const row = rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        orgId: String(row.org_id),
        subject: String(row.subject),
        email: row.email === null ? null : String(row.email),
        clearance: row.clearance as Principal['clearance'],
        isServiceAccount: Boolean(row.is_service_account),
        disabledAt: row.disabled_at === null ? null : new Date(String(row.disabled_at)),
      };
    });
  }

  /** §15.2 — replay protection, backed by the unique index on `(org_id, nonce)`. */
  async isNonceSeen(orgId: string, nonce: string): Promise<boolean> {
    const rows = await withSystemContext(this.dbBatch, orgId, 'maintenance', async (tx) =>
      tx.execute<{ exists: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM ir_bundles WHERE org_id = ${orgId} AND nonce = ${nonce}
        ) AS exists
      `),
    );
    return rows[0]?.exists ?? false;
  }

  /** Used by envelope verification to check the signer's repository claim against the scope. */
  async repoRemote(repoId: string): Promise<string | null> {
    const rows = await this.dbBatch.sql<Array<{ remote: string }>>`
      SELECT remote FROM repos WHERE id = ${repoId} LIMIT 1
    `;
    return rows[0]?.remote ?? null;
  }

  async recordBundle(input: {
    bundle: IrBundle;
    storageKey: string;
    upcastedFrom: string | null;
  }): Promise<void> {
    const { envelope, payload } = input.bundle;

    await withSystemContext(this.dbBatch, envelope.orgId, 'indexing', async (tx) => {
      await tx.execute(sql`
        INSERT INTO ir_bundles (
          bundle_id, org_id, repo_id, commit_sha, ref, ir_schema_version,
          producer_name, producer_version, environment, payload_hash, payload_bytes,
          storage_key, signature_algorithm, signer_claims, nonce, upcasted_from, scan_report
        ) VALUES (
          ${envelope.bundleId}, ${envelope.orgId}, ${envelope.repoId}, ${envelope.commitSha},
          ${envelope.ref}, ${envelope.irSchemaVersion},
          ${envelope.producer.name}, ${envelope.producer.version}, ${envelope.producer.environment},
          ${envelope.payloadHash}, ${envelope.payloadBytes},
          ${input.storageKey}, ${envelope.signature.algorithm},
          ${JSON.stringify(envelope.signature.signerClaims)}::jsonb,
          ${envelope.nonce}, ${input.upcastedFrom},
          ${JSON.stringify(payload.scan)}::jsonb
        )
        ON CONFLICT (org_id, nonce) DO NOTHING
      `);
    });
  }

  /**
   * The previous payload for this ref, fetched from object storage.
   *
   * Reading the *bundle* rather than reconstructing the IR from Postgres is deliberate: §15.1
   * makes the bundle store the system of record, and diffing against a reconstruction would
   * mean diffing against a derived cache that could itself be stale or partially written.
   */
  async lastIndexedPayload(
    orgId: string,
    repoId: string,
    ref: string,
    fetchPayload?: (key: string) => Promise<IrBundlePayload>,
  ): Promise<IrBundlePayload | null> {
    const rows = await withSystemContext(this.dbBatch, orgId, 'indexing', async (tx) =>
      tx.execute<{ storage_key: string }>(sql`
        SELECT storage_key FROM ir_bundles
        WHERE org_id = ${orgId} AND repo_id = ${repoId} AND ref = ${ref}
        ORDER BY received_at DESC
        LIMIT 1
      `),
    );

    const key = rows[0]?.storage_key;
    if (!key || !fetchPayload) return null;

    try {
      return await fetchPayload(key);
    } catch {
      // A missing prior bundle degrades to "treat this as a first index", which over-indexes
      // rather than under-indexes. That is the right direction to fail.
      return null;
    }
  }

  async markPendingBulkReview(orgId: string, repoId: string, reason: string): Promise<void> {
    await withSystemContext(this.dbBatch, orgId, 'indexing', async (tx) => {
      await tx.execute(sql`
        UPDATE repos
        SET pending_bulk_review = true, pending_bulk_review_reason = ${reason}
        WHERE org_id = ${orgId} AND id = ${repoId}
      `);
    });
  }

  /**
   * §15.2 — resolve a CI workload identity to a registered repo.
   *
   * The identity's repository claim must match the repo being published for. This is what stops
   * a workflow in one repository minting a credential for another.
   */
  async resolveRepoForIdentity(
    identity: OidcIdentity,
    repoRemote: string,
  ): Promise<{ orgId: string; repoId: string } | null> {
    const canonical = canonicalRemote(repoRemote);

    if (identity.repository && !canonical.endsWith(identity.repository.toLowerCase())) {
      return null;
    }

    const rows = await this.dbBatch.sql<Array<{ id: string; org_id: string }>>`
      SELECT id, org_id FROM repos WHERE remote = ${canonical} LIMIT 1
    `;

    const row = rows[0];
    return row ? { orgId: row.org_id, repoId: row.id } : null;
  }

  /** Repos in scope for a project, for scope resolution at query time (§4.3). */
  async reposForProjects(orgId: string, projectIds: string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];
    const rows = await withOrgContext(this.db, orgId, async (tx) =>
      tx.execute<{ repo_id: string }>(sql`
        SELECT DISTINCT m.repo_id
        FROM modules m
        JOIN module_projects mp ON mp.module_id = m.id
        WHERE m.org_id = ${orgId} AND mp.project_id = ${anyOf(projectIds)}
      `),
    );
    return rows.map((r) => r.repo_id);
  }

  /**
   * §4.3 "expanded scope" — projects linked by API contract or package dependency. Used when
   * the query mentions an external system, or when project-scoped retrieval returns weak scores.
   */
  async linkedProjects(orgId: string, projectIds: string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];
    const rows = await withOrgContext(this.db, orgId, async (tx) =>
      tx.execute<{ project_id: string }>(sql`
        SELECT DISTINCT e.project_id
        FROM cross_repo_edges e
        WHERE e.org_id = ${orgId}
          AND e.status = 'resolved'
          AND e.project_id <> ALL(${projectIds})
          AND e.from_symbol_id IN (
            SELECT s.id FROM symbols s
            JOIN module_projects mp ON mp.module_id = s.module_id
            WHERE mp.project_id = ${anyOf(projectIds)}
          )
        LIMIT 20
      `),
    );
    return rows.map((r) => r.project_id);
  }

  async recordQueryTrace(trace: Record<string, unknown>): Promise<void> {
    const orgId = String(trace.orgId);
    await withSystemContext(this.dbBatch, orgId, 'maintenance', async (tx) => {
      await tx.execute(sql`
        INSERT INTO query_traces (
          id, org_id, principal_id, session_id, surface, raw_query, rewritten_query,
          intent_class, scope, dense_candidates, lexical_candidates, symbol_candidates,
          fused_candidates, reranked_candidates, served_chunk_ids, expansion_chunk_ids,
          stage_timings_ms, stage_tokens, top_rerank_score, abstained, abstention_reason,
          degraded_modes, model, prompt_version, embedding_model, retrieval_config_version,
          trace_id
        ) VALUES (
          ${trace.id}, ${orgId}, ${trace.principalId}, ${trace.sessionId}, ${trace.surface},
          ${trace.rawQuery}, ${trace.rewrittenQuery}, ${trace.intentClass},
          ${JSON.stringify(trace.scope ?? {})}::jsonb,
          ${JSON.stringify(trace.denseCandidates ?? [])}::jsonb,
          ${JSON.stringify(trace.lexicalCandidates ?? [])}::jsonb,
          ${JSON.stringify(trace.symbolCandidates ?? [])}::jsonb,
          ${JSON.stringify(trace.fusedCandidates ?? [])}::jsonb,
          ${JSON.stringify(trace.rerankedCandidates ?? [])}::jsonb,
          ${JSON.stringify(trace.servedChunkIds ?? [])}::jsonb,
          ${JSON.stringify(trace.expansionChunkIds ?? [])}::jsonb,
          ${JSON.stringify(trace.stageTimingsMs ?? {})}::jsonb,
          ${JSON.stringify(trace.stageTokens ?? {})}::jsonb,
          ${trace.topRerankScore}, ${trace.abstained}, ${trace.abstentionReason},
          ${JSON.stringify(trace.degradedModes ?? [])}::jsonb,
          ${trace.model}, ${trace.promptVersion}, ${trace.embeddingModel},
          ${trace.retrievalConfigVersion}, ${trace.traceId}
        )
      `);
    });
  }
}
