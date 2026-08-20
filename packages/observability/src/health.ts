/**
 * Health, readiness and degraded modes (§15.6).
 *
 * Two findings drive the shape of this file.
 *
 * "Readiness probes must not depend on any external provider, or one vendor blip pulls every
 * pod from the load balancer and Kubernetes restarts your fleet." So `readiness()` consults
 * only dependencies the pod genuinely cannot serve without — its database and its queue — and
 * every provider is `advisory`, reported but never fatal.
 *
 * "Define per-dependency circuit breakers and named degraded modes: reranker down ⇒ serve RRF
 * order with a banner, not a 500; embeddings down ⇒ hold jobs, keep serving the existing
 * index; LLM down ⇒ MCP search_codebase and get_symbol still work."
 */

export type DependencyKind = 'critical' | 'advisory';
export type DependencyState = 'up' | 'degraded' | 'down';

export interface DependencyCheck {
  name: string;
  kind: DependencyKind;
  check: () => Promise<{ state: DependencyState; detail?: string }>;
  /** Consecutive failures before the breaker opens. */
  failureThreshold?: number;
  /** How long the breaker stays open before a probe is allowed through. */
  cooldownMs?: number;
}

export type DegradedMode =
  | 'reranker-unavailable'
  | 'embeddings-unavailable'
  | 'generation-unavailable'
  | 'git-provider-unavailable'
  | 'bundle-store-unavailable';

/** What a user is told when a mode is active. Named, not improvised at the call site. */
export const DEGRADED_MODE_BANNERS: Record<DegradedMode, string> = {
  'reranker-unavailable':
    'Results are ranked by fusion score only — the reranker is unavailable, so ordering is less precise than usual.',
  'embeddings-unavailable':
    'New code is not being indexed right now. Answers reflect the index as of the last successful update.',
  'generation-unavailable':
    'Answer generation is unavailable. Search and symbol lookup still work and will return sources directly.',
  'git-provider-unavailable':
    'Permission data could not be refreshed. Access is limited to your last confirmed permissions.',
  'bundle-store-unavailable':
    'Ingestion is paused: the IR bundle store is unreachable and bundles must be durably stored before indexing.',
};

interface BreakerState {
  consecutiveFailures: number;
  openedAt: number | null;
  lastState: DependencyState;
  lastDetail: string | undefined;
}

export class HealthRegistry {
  private readonly checks = new Map<string, DependencyCheck>();
  private readonly breakers = new Map<string, BreakerState>();
  private readonly degraded = new Set<DegradedMode>();

  register(check: DependencyCheck): this {
    this.checks.set(check.name, check);
    this.breakers.set(check.name, {
      consecutiveFailures: 0,
      openedAt: null,
      lastState: 'up',
      lastDetail: undefined,
    });
    return this;
  }

  /**
   * Liveness: is this process itself healthy? Never touches a dependency. A liveness probe
   * that calls the database turns a slow query into a pod restart loop.
   */
  liveness(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /** Readiness: can this pod serve traffic? Critical dependencies only. */
  async readiness(): Promise<{
    status: 'ready' | 'not-ready';
    dependencies: Array<{
      name: string;
      kind: DependencyKind;
      state: DependencyState;
      detail?: string;
    }>;
    degradedModes: DegradedMode[];
  }> {
    const results = await Promise.all(
      [...this.checks.values()].map(async (check) => {
        const breaker = this.breakers.get(check.name)!;
        const cooldown = check.cooldownMs ?? 30_000;

        // Breaker open and still cooling: report last state without probing.
        if (breaker.openedAt && Date.now() - breaker.openedAt < cooldown) {
          return {
            name: check.name,
            kind: check.kind,
            state: 'down' as const,
            detail: breaker.lastDetail,
          };
        }

        try {
          const result = await check.check();
          if (result.state === 'up') {
            breaker.consecutiveFailures = 0;
            breaker.openedAt = null;
          } else {
            breaker.consecutiveFailures++;
            if (breaker.consecutiveFailures >= (check.failureThreshold ?? 3)) {
              breaker.openedAt = Date.now();
            }
          }
          breaker.lastState = result.state;
          breaker.lastDetail = result.detail;
          return { name: check.name, kind: check.kind, state: result.state, detail: result.detail };
        } catch (error) {
          breaker.consecutiveFailures++;
          breaker.lastDetail = error instanceof Error ? error.message : String(error);
          if (breaker.consecutiveFailures >= (check.failureThreshold ?? 3)) {
            breaker.openedAt = Date.now();
          }
          breaker.lastState = 'down';
          return {
            name: check.name,
            kind: check.kind,
            state: 'down' as const,
            detail: breaker.lastDetail,
          };
        }
      }),
    );

    const criticalDown = results.some((r) => r.kind === 'critical' && r.state === 'down');

    return {
      status: criticalDown ? 'not-ready' : 'ready',
      dependencies: results,
      degradedModes: [...this.degraded],
    };
  }

  enterDegraded(mode: DegradedMode): void {
    this.degraded.add(mode);
  }

  exitDegraded(mode: DegradedMode): void {
    this.degraded.delete(mode);
  }

  isDegraded(mode: DegradedMode): boolean {
    return this.degraded.has(mode);
  }

  activeBanners(): string[] {
    return [...this.degraded].map((m) => DEGRADED_MODE_BANNERS[m]);
  }
}

/**
 * Graceful drain. §15.6 — "add MCP drain semantics: Streamable HTTP sessions in IDEs break on
 * every rolling deploy without graceful drain." Call on SIGTERM, stop accepting new sessions,
 * let in-flight ones finish, then exit.
 */
export function installGracefulShutdown(
  handlers: Array<{ name: string; drain: () => Promise<void> }>,
  options: { timeoutMs?: number; onLog?: (message: string) => void } = {},
): void {
  const timeoutMs = options.timeoutMs ?? 25_000;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    options.onLog?.(`${signal} received; draining ${handlers.length} subsystem(s)`);

    const timer = setTimeout(() => {
      options.onLog?.(`drain exceeded ${timeoutMs}ms; exiting anyway`);
      process.exit(1);
    }, timeoutMs);
    timer.unref();

    for (const handler of handlers) {
      try {
        await handler.drain();
        options.onLog?.(`drained ${handler.name}`);
      } catch (error) {
        options.onLog?.(
          `drain failed for ${handler.name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    clearTimeout(timer);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
