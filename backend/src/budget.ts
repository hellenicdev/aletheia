/**
 * Cloudflare's free plan allows 50 subrequests in one worker invocation.
 * Cache reads and writes are counted when the Cache API is present. The article
 * scrape, searches, and model calls are fetches on this counter. Keepalive
 * comments are not fetches. `response.redirected` hides the extra hops, so a
 * redirected call spends one more. The cap stays at 32 so those hops still fit
 * under 50. The counter never throws out of the analysis: callers stop and finish.
 */
export const SUBREQUEST_LIMIT = 32;

export class BudgetExhausted extends Error {
  readonly name = "BudgetExhausted";

  constructor() {
    super("Too many subrequests by single Worker invocation");
  }
}

export function isBudgetExhausted(error: unknown): boolean {
  if (error instanceof BudgetExhausted) return true;
  const message = error instanceof Error ? error.message : "";
  return /too many subrequests/i.test(message);
}

export type BudgetStage = "ingest" | "segment" | "evidence" | "verify" | "score";

export interface SubrequestSnapshot {
  ingest: number;
  segment: number;
  evidence: number;
  verify: number;
  score: number;
  total: number;
}

export interface EvidencePlanCosts {
  /** Cache read plus the search request when the Cache API is present. */
  search: number;
  /** Cache read plus the verifier call, per group of claims. */
  verify: number;
}

export interface SubrequestBudget {
  limit: number;
  used: number;
  stage: BudgetStage;
  byStage: Record<BudgetStage, number>;
  remaining(): number;
  canSpend(reserve?: number): boolean;
  /** Increments when the budget allows. Returns false and does not increment otherwise. */
  trySpend(cost?: number): boolean;
  note(): void;
  setStage(stage: BudgetStage): void;
  snapshot(): SubrequestSnapshot;
}

export function createSubrequestBudget(limit = SUBREQUEST_LIMIT): SubrequestBudget {
  const byStage: Record<BudgetStage, number> = {
    ingest: 0,
    segment: 0,
    evidence: 0,
    verify: 0,
    score: 0,
  };
  const budget: SubrequestBudget = {
    limit,
    used: 0,
    stage: "ingest",
    byStage,
    remaining() {
      return this.limit - this.used;
    },
    canSpend(reserve = 1) {
      return this.remaining() >= reserve;
    },
    trySpend(cost = 1) {
      if (cost < 1 || this.used + cost > this.limit) return false;
      this.used += cost;
      this.byStage[this.stage] += cost;
      return true;
    },
    note() {
      if (!this.trySpend(1)) throw new BudgetExhausted();
    },
    setStage(stage) {
      this.stage = stage;
    },
    snapshot() {
      return {
        ingest: this.byStage.ingest,
        segment: this.byStage.segment,
        evidence: this.byStage.evidence,
        verify: this.byStage.verify,
        score: this.byStage.score,
        total: this.used,
      };
    },
  };
  return budget;
}

/**
 * How many of the most important claims can be searched after model calls are reserved.
 * Query generation, the consistency check, and one verifier call per group of four
 * are held back first. A search that does not fit is not started.
 */
export function planEvidence(
  remaining: number,
  claimCount: number,
  costs: EvidencePlanCosts = { search: 2, verify: 1 },
): number {
  if (claimCount <= 0 || remaining < 1) return 0;
  const cap = Math.min(claimCount, 12);
  const searchCost = Math.max(1, costs.search);
  const verifyCost = Math.max(1, costs.verify);
  for (let searches = cap; searches >= 1; searches -= 1) {
    const groups = Math.ceil(searches / 4);
    const cost = 1 + 1 + groups * verifyCost + searches * searchCost;
    if (cost <= remaining) return searches;
  }
  return 0;
}

export function trackFetch(fetchImpl: typeof fetch, budget: SubrequestBudget): typeof fetch {
  return async (input, init) => {
    budget.note();
    const response = await fetchImpl(input, init);
    // Each redirect hop is a subrequest. The platform only exposes a boolean,
    // so count one extra and keep the response even if the budget is already spent.
    if (response.redirected) budget.trySpend(1);
    return response;
  };
}
