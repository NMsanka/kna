import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Logger } from '@kna/observability';
import type { McpIdentity } from './context.js';

/**
 * Session tracking and drain.
 *
 * §15.6 — "add MCP drain semantics: Streamable HTTP sessions in IDEs break on every rolling
 * deploy without graceful drain." An engineer whose editor loses its knowledge connection on
 * every deploy stops relying on it, which is the adoption failure §16 describes by a different
 * route.
 *
 * §15.4 — "cap absolute session lifetime". A session that lives for weeks accumulates a
 * permission grant that was correct when it started and may not be now, so there is a hard
 * ceiling regardless of activity.
 */

export interface Session {
  id: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  identity: McpIdentity;
  createdAt: number;
  lastActiveAt: number;
}

export interface SessionPolicy {
  /** Idle timeout. An editor left open overnight should not hold a session forever. */
  idleTimeoutMs: number;
  /** Absolute ceiling regardless of activity (§15.4). */
  maxLifetimeMs: number;
  /** Per-identity concurrent sessions, so one client cannot exhaust the server. */
  maxPerPrincipal: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  idleTimeoutMs: 30 * 60 * 1000,
  maxLifetimeMs: 8 * 60 * 60 * 1000,
  maxPerPrincipal: 5,
};

export class SessionRegistry {
  private readonly sessions = new Map<string, Session>();
  private draining = false;
  private readonly sweeper: NodeJS.Timeout;

  constructor(
    private readonly logger: Logger,
    private readonly policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  ) {
    this.sweeper = setInterval(() => this.sweep(), 60_000);
    this.sweeper.unref();
  }

  add(id: string, session: Omit<Session, 'id' | 'createdAt' | 'lastActiveAt'>): Session {
    const principalSessions = [...this.sessions.values()].filter(
      (s) => s.identity.principal.id === session.identity.principal.id,
    );

    if (principalSessions.length >= this.policy.maxPerPrincipal) {
      // Evict the oldest rather than refusing: a developer who restarts their editor several
      // times should not find themselves locked out by their own stale sessions.
      const oldest = principalSessions.sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0]!;
      this.close(oldest.id, 'evicted: per-principal session limit');
    }

    const now = Date.now();
    const full: Session = { ...session, id, createdAt: now, lastActiveAt: now };
    this.sessions.set(id, full);
    return full;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;

    if (Date.now() - session.createdAt > this.policy.maxLifetimeMs) {
      this.close(id, 'absolute session lifetime reached; re-authenticate');
      return undefined;
    }

    return session;
  }

  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.lastActiveAt = Date.now();
  }

  count(): number {
    return this.sessions.size;
  }

  isDraining(): boolean {
    return this.draining;
  }

  /** Stop accepting new sessions. Existing ones continue until they finish or time out. */
  startDraining(): void {
    this.draining = true;
    this.logger.info({ sessions: this.sessions.size }, 'mcp draining: refusing new sessions');
  }

  /**
   * Wait for in-flight sessions, then close what remains.
   *
   * A bounded wait rather than an unbounded one: an editor session that is simply idle would
   * otherwise hold up the deploy indefinitely.
   */
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (this.sessions.size > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    for (const id of [...this.sessions.keys()]) {
      this.close(id, 'server shutting down');
    }

    clearInterval(this.sweeper);
  }

  private close(id: string, reason: string): void {
    const session = this.sessions.get(id);
    if (!session) return;

    this.logger.info({ sessionId: id, reason }, 'closing mcp session');
    void session.transport.close().catch(() => undefined);
    void session.server.close().catch(() => undefined);
    this.sessions.delete(id);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastActiveAt > this.policy.idleTimeoutMs) {
        this.close(id, 'idle timeout');
      } else if (now - session.createdAt > this.policy.maxLifetimeMs) {
        this.close(id, 'absolute session lifetime reached');
      }
    }
  }
}
