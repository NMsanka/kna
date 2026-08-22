import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { withSystemContext, type DbHandle } from '@kna/db';
import type { Logger } from '@kna/observability';

/**
 * Audit recording.
 *
 * §10 Layer 6 — "audit every retrieval: identity, query, returned chunk IDs, repos touched,
 * timestamp. Retain it. After an incident, this is the only thing that lets you answer 'what
 * was exposed?'"
 *
 * §15.7 adds the structural requirement: "audit logs sit in the database they are meant to
 * police. Ship audit events to an append-only sink under separate credentials — object storage
 * with object-lock/WORM and hash-chained records."
 *
 * This class writes the queryable copy and maintains the hash chain. A separate worker ships
 * unshipped rows to the WORM sink; the chain is what makes tampering with the hot copy
 * detectable when the two are reconciled.
 */

export interface AuditEvent {
  orgId: string;
  action: string;
  actorType: 'user' | 'ci' | 'mcp' | 'system' | 'admin' | 'partner';
  actorId?: string | null;
  actorSubject?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  outcome?: 'success' | 'denied' | 'error';
  detail?: Record<string, unknown>;
  /** Chunk *ids*, never chunk text. The audit trail must not become a second copy of the corpus. */
  chunkIds?: string[];
  reposTouched?: string[];
  traceId?: string | null;
  llmTraceId?: string | null;
  sourceIp?: string | null;
  userAgent?: string | null;
}

export class AuditRecorder {
  /** Last hash per org, so the chain is per-tenant and one org's volume cannot stall another. */
  private readonly lastHash = new Map<string, string>();
  private readonly buffer: Array<
    AuditEvent & { id: string; hash: string; previousHash: string | null }
  > = [];
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: DbHandle,
    private readonly logger: Logger,
    private readonly options: { batchSize?: number; flushIntervalMs?: number } = {},
  ) {}

  /**
   * Record an event.
   *
   * Buffered, because this sits on the retrieval hot path and a synchronous insert per query
   * would put audit write latency into p99 search latency. The buffer is bounded and flushed on
   * a timer; `flush()` is called during graceful shutdown so a rolling deploy does not lose the
   * tail.
   */
  async record(event: AuditEvent): Promise<void> {
    const previousHash = await this.tailHash(event.orgId);
    const id = randomUUID();
    const hash = this.chainHash(previousHash, id, event);

    this.lastHash.set(event.orgId, hash);
    this.buffer.push({ ...event, id, hash, previousHash });

    if (this.buffer.length >= (this.options.batchSize ?? 50)) {
      await this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        void this.flush();
      }, this.options.flushIntervalMs ?? 2_000);
      this.flushTimer.unref();
    }
  }

  /**
   * The hash this org's chain currently ends on.
   *
   * Held in memory once known, but seeded from the database on first use, because the chain has
   * to survive process boundaries. Without this, every restart began a fresh chain with a null
   * `previous_hash`, and §15.7's guarantee — "hash-chained records" that make tampering with the
   * hot copy detectable — held only within one process lifetime. Every deploy left a seam an
   * auditor could not distinguish from a deletion.
   *
   * A read failure yields null rather than throwing: an unchained audit row is a real loss of
   * evidence quality, and a dropped audit row is a total one.
   */
  private async tailHash(orgId: string): Promise<string | null> {
    const cached = this.lastHash.get(orgId);
    if (cached !== undefined) return cached;

    try {
      const rows = await withSystemContext(this.db, orgId, 'maintenance', async (tx) =>
        tx.execute<{ hash: string }>(sql`
          SELECT hash FROM audit_events
           WHERE org_id = ${orgId}
           ORDER BY occurred_at DESC, id DESC
           LIMIT 1
        `),
      );
      const tail = rows[0] ? String(rows[0].hash) : null;
      if (tail !== null) this.lastHash.set(orgId, tail);
      return tail;
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error), orgId },
        'audit chain tail lookup failed; recording an unchained event',
      );
      return null;
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.buffer.length);
    const byOrg = new Map<string, typeof batch>();
    for (const event of batch) {
      const list = byOrg.get(event.orgId) ?? [];
      list.push(event);
      byOrg.set(event.orgId, list);
    }

    for (const [orgId, events] of byOrg) {
      try {
        await withSystemContext(this.db, orgId, 'maintenance', async (tx) => {
          for (const event of events) {
            await tx.execute(sql`
              INSERT INTO audit_events (
                id, org_id, previous_hash, hash, actor_type, actor_id, actor_subject,
                action, resource_type, resource_id, outcome, detail, repos_touched, chunk_ids,
                trace_id, llm_trace_id, source_ip, user_agent
              ) VALUES (
                ${event.id}, ${orgId}, ${event.previousHash}, ${event.hash},
                ${event.actorType}, ${event.actorId ?? null}, ${event.actorSubject ?? null},
                ${event.action}, ${event.resourceType ?? null}, ${event.resourceId ?? null},
                ${event.outcome ?? 'success'},
                ${JSON.stringify(event.detail ?? {})}::jsonb,
                ${JSON.stringify(event.reposTouched ?? [])}::jsonb,
                ${JSON.stringify(event.chunkIds ?? [])}::jsonb,
                ${event.traceId ?? null}, ${event.llmTraceId ?? null},
                ${event.sourceIp ?? null}, ${event.userAgent ?? null}
              )
            `);
          }
        });
      } catch (error) {
        // Losing audit rows silently is worse than the original failure. Log at error level
        // with the events' ids so they can be reconstructed from the WORM sink if it got them.
        this.logger.error(
          {
            err: error instanceof Error ? error.message : String(error),
            orgId,
            eventIds: events.map((e) => e.id),
          },
          'audit write failed',
        );
      }
    }
  }

  /**
   * Hash chain. Each row commits to its predecessor, so deleting or editing a row in the middle
   * of the chain is detectable by re-walking it — which is the property that makes the hot copy
   * worth reconciling against the WORM sink at all.
   */
  private chainHash(previousHash: string | null, id: string, event: AuditEvent): string {
    return createHash('sha256')
      .update(
        [
          previousHash ?? '',
          id,
          event.orgId,
          event.action,
          event.actorId ?? '',
          event.resourceId ?? '',
          event.outcome ?? 'success',
          JSON.stringify(event.detail ?? {}),
        ].join('\n'),
      )
      .digest('hex');
  }
}

/**
 * §15.4 — insider exfiltration detection.
 *
 * "`search_codebase` + `find_usages` + `get_symbol` in a loop is a *better* exfiltration tool
 * than `git clone`: it crosses repo boundaries on one credential, returns pre-digested
 * cross-repo architecture, and looks like ordinary IDE traffic. Add per-identity budgets on MCP
 * tools and alert on **breadth** rather than volume — an engineer touching 40 repos in an hour
 * is the signal."
 *
 * Breadth, not volume, is therefore what this tracks. A developer running two hundred searches
 * inside one service is working; one running forty searches across forty repositories is not.
 */
export interface BreadthPolicy {
  windowMs: number;
  /** Distinct repos in the window that trips an alert. */
  repoThreshold: number;
  /** Distinct modules — a secondary signal for monorepo-heavy orgs where repo count is low. */
  moduleThreshold: number;
}

export const DEFAULT_BREADTH_POLICY: BreadthPolicy = {
  windowMs: 60 * 60 * 1000,
  repoThreshold: 40,
  moduleThreshold: 150,
};

interface BreadthWindow {
  windowStart: number;
  repos: Set<string>;
  modules: Set<string>;
  toolCalls: number;
  alerted: boolean;
}

export class BreadthMonitor {
  private readonly windows = new Map<string, BreadthWindow>();

  constructor(
    private readonly policy: BreadthPolicy = DEFAULT_BREADTH_POLICY,
    private readonly onAlert?: (alert: {
      orgId: string;
      principalId: string;
      surface: string;
      repos: number;
      modules: number;
      toolCalls: number;
    }) => void,
  ) {}

  observe(input: {
    orgId: string;
    principalId: string;
    surface: string;
    repoIds: string[];
    moduleIds: string[];
  }): void {
    const key = `${input.orgId}:${input.principalId}:${input.surface}`;
    const now = Date.now();
    let window = this.windows.get(key);

    if (!window || now - window.windowStart > this.policy.windowMs) {
      window = {
        windowStart: now,
        repos: new Set(),
        modules: new Set(),
        toolCalls: 0,
        alerted: false,
      };
      this.windows.set(key, window);
    }

    for (const repoId of input.repoIds) window.repos.add(repoId);
    for (const moduleId of input.moduleIds) window.modules.add(moduleId);
    window.toolCalls++;

    const breached =
      window.repos.size >= this.policy.repoThreshold ||
      window.modules.size >= this.policy.moduleThreshold;

    if (breached && !window.alerted) {
      window.alerted = true;
      this.onAlert?.({
        orgId: input.orgId,
        principalId: input.principalId,
        surface: input.surface,
        repos: window.repos.size,
        modules: window.modules.size,
        toolCalls: window.toolCalls,
      });
    }
  }

  /** Current breadth, for the admin console. */
  snapshot(orgId: string, principalId: string, surface: string): BreadthWindow | null {
    return this.windows.get(`${orgId}:${principalId}:${surface}`) ?? null;
  }
}
