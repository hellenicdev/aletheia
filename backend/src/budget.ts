/**
 * Cloudflare's free plan allows 50 subrequests in one worker invocation.
 * Leave a little headroom for the runtime, and stop search before verify is starved.
 */
export const SUBREQUEST_LIMIT = 46;
export const SUBREQUEST_RESERVE = 8;

export interface SubrequestBudget {
  limit: number;
  used: number;
  remaining(): number;
  canSpend(reserve?: number): boolean;
  note(): void;
}

export function createSubrequestBudget(limit = SUBREQUEST_LIMIT): SubrequestBudget {
  const budget: SubrequestBudget = {
    limit,
    used: 0,
    remaining() {
      return this.limit - this.used;
    },
    canSpend(reserve = 1) {
      return this.remaining() >= reserve;
    },
    note() {
      this.used += 1;
    },
  };
  return budget;
}

export function trackFetch(fetchImpl: typeof fetch, budget: SubrequestBudget): typeof fetch {
  return async (input, init) => {
    if (!budget.canSpend(1)) {
      throw new Error("Too many subrequests by single Worker invocation");
    }
    budget.note();
    return fetchImpl(input, init);
  };
}
