/**
 * Spend budgets and backpressure.
 *
 * §15.3 BLOCKER — "add a per-org daily spend ceiling that **pauses the queue** rather than
 * failing mid-write — budget exhaustion halfway through a repo leaves a partially reindexed
 * corpus, which is worse than never starting."
 *
 * That sentence dictates the shape of this module. The check happens at *admission*, before a
 * unit of work starts, and it estimates the whole unit's cost. A job that cannot afford to
 * finish is never started.
 */

export interface BudgetState {
  orgId: string;
  spentTodayUsd: number;
  ceilingUsd: number;
  /** Reserved by admitted-but-unfinished work, so concurrent workers cannot each pass a check
   *  that they collectively fail. */
  reservedUsd: number;
}

export type BudgetVerdict =
  | { admitted: true; reservationId: string; estimatedUsd: number }
  | {
      admitted: false;
      reason: string;
      spentTodayUsd: number;
      ceilingUsd: number;
      retryAfterMs: number;
    };

export interface BudgetStore {
  get(orgId: string): Promise<BudgetState>;
  reserve(orgId: string, amountUsd: number, reservationId: string): Promise<boolean>;
  release(orgId: string, reservationId: string, actualUsd: number): Promise<void>;
}

export class BudgetManager {
  constructor(
    private readonly store: BudgetStore,
    private readonly options: {
      warnAtFraction?: number;
      onWarn?: (state: BudgetState) => void;
    } = {},
  ) {}

  /**
   * Admit a unit of work, reserving its estimated cost.
   *
   * `estimatedUsd` should be the cost of the *whole* unit — a full module reindex, not one
   * embedding call. Estimating per call and admitting greedily is exactly how a repo ends up
   * half-indexed when the ceiling hits.
   */
  async admit(orgId: string, estimatedUsd: number): Promise<BudgetVerdict> {
    const state = await this.store.get(orgId);
    const committed = state.spentTodayUsd + state.reservedUsd;

    if (committed + estimatedUsd > state.ceilingUsd) {
      return {
        admitted: false,
        reason:
          `Admitting this work would take org ${orgId} to $${(committed + estimatedUsd).toFixed(2)} ` +
          `against a daily ceiling of $${state.ceilingUsd.toFixed(2)}. The queue is paused rather than ` +
          `failing mid-write; a partially reindexed corpus is worse than one that was never started.`,
        spentTodayUsd: state.spentTodayUsd,
        ceilingUsd: state.ceilingUsd,
        retryAfterMs: msUntilMidnightUtc(),
      };
    }

    const warnAt = this.options.warnAtFraction ?? 0.8;
    if (committed + estimatedUsd > state.ceilingUsd * warnAt) {
      this.options.onWarn?.(state);
    }

    const reservationId = `res_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const reserved = await this.store.reserve(orgId, estimatedUsd, reservationId);
    if (!reserved) {
      return {
        admitted: false,
        reason: `Reservation lost a race against concurrent work for org ${orgId}; retry shortly.`,
        spentTodayUsd: state.spentTodayUsd,
        ceilingUsd: state.ceilingUsd,
        retryAfterMs: 5_000,
      };
    }

    return { admitted: true, reservationId, estimatedUsd };
  }

  /** Settle a reservation against what was actually spent. Always call, including on failure. */
  async settle(orgId: string, reservationId: string, actualUsd: number): Promise<void> {
    await this.store.release(orgId, reservationId, actualUsd);
  }
}

/**
 * Cost estimation for an indexing unit.
 *
 * §15.6 — "size the cold-start budget explicitly: first-index context blurbs are the single
 * largest one-time LLM spend in the system and are currently unestimated." This function is
 * that estimate, and it is deliberately conservative: under-estimating admits work that then
 * blows the ceiling mid-run, which is the failure mode the ceiling exists to prevent.
 */
export interface IndexCostEstimate {
  embeddingUsd: number;
  blurbUsd: number;
  totalUsd: number;
  breakdown: string;
}

export function estimateIndexCost(input: {
  symbolCount: number;
  /** Fraction needing a fresh context blurb — 1.0 for a first index, ~0.02 for a typical merge. */
  blurbMissRate: number;
  /** Fraction whose embedding is already in the content-hash cache. */
  embeddingCacheHitRate: number;
  avgChunkTokens?: number;
  embeddingPricePerMTok?: number;
  blurbInputPricePerMTok?: number;
  blurbOutputPricePerMTok?: number;
  batchDiscount?: boolean;
}): IndexCostEstimate {
  const avgChunkTokens = input.avgChunkTokens ?? 400;
  const embeddingPrice = input.embeddingPricePerMTok ?? 0.13;
  const blurbIn = input.blurbInputPricePerMTok ?? 0.4;
  const blurbOut = input.blurbOutputPricePerMTok ?? 1.6;
  const discount = input.batchDiscount === false ? 1 : 0.5;

  const embeddedChunks = input.symbolCount * (1 - input.embeddingCacheHitRate);
  const embeddingUsd = ((embeddedChunks * avgChunkTokens) / 1_000_000) * embeddingPrice * discount;

  // A blurb prompt carries the enclosing module context plus the symbol: call it 1.5x the
  // chunk, producing roughly 60 output tokens.
  const blurbedSymbols = input.symbolCount * input.blurbMissRate;
  const blurbUsd =
    (((blurbedSymbols * avgChunkTokens * 1.5) / 1_000_000) * blurbIn +
      ((blurbedSymbols * 60) / 1_000_000) * blurbOut) *
    discount;

  const totalUsd = embeddingUsd + blurbUsd;

  return {
    embeddingUsd,
    blurbUsd,
    totalUsd,
    breakdown:
      `${Math.round(embeddedChunks)} embeddings ($${embeddingUsd.toFixed(2)}) + ` +
      `${Math.round(blurbedSymbols)} context blurbs ($${blurbUsd.toFixed(2)}) = $${totalUsd.toFixed(2)}` +
      (discount === 0.5 ? ' (batch pricing)' : ''),
  };
}

function msUntilMidnightUtc(): number {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return midnight - now.getTime();
}

/** In-memory store — real deployments back this with Redis so workers share state. */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly states = new Map<string, BudgetState>();
  private readonly reservations = new Map<string, { orgId: string; amount: number }>();

  constructor(private readonly defaultCeilingUsd = 500) {}

  async get(orgId: string): Promise<BudgetState> {
    return (
      this.states.get(orgId) ?? {
        orgId,
        spentTodayUsd: 0,
        ceilingUsd: this.defaultCeilingUsd,
        reservedUsd: 0,
      }
    );
  }

  async reserve(orgId: string, amountUsd: number, reservationId: string): Promise<boolean> {
    const state = await this.get(orgId);
    state.reservedUsd += amountUsd;
    this.states.set(orgId, state);
    this.reservations.set(reservationId, { orgId, amount: amountUsd });
    return true;
  }

  async release(orgId: string, reservationId: string, actualUsd: number): Promise<void> {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return;
    const state = await this.get(orgId);
    state.reservedUsd = Math.max(state.reservedUsd - reservation.amount, 0);
    state.spentTodayUsd += actualUsd;
    this.states.set(orgId, state);
    this.reservations.delete(reservationId);
  }

  /** Test/ops helper. */
  setCeiling(orgId: string, ceilingUsd: number): void {
    const state = this.states.get(orgId) ?? {
      orgId,
      spentTodayUsd: 0,
      ceilingUsd,
      reservedUsd: 0,
    };
    state.ceilingUsd = ceilingUsd;
    this.states.set(orgId, state);
  }
}
