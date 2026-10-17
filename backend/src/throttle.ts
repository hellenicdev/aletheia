/**
 * Per-isolate token bucket for outbound Firecrawl calls.
 * Capacity 10, refilled smoothly over one minute. Cache hits do not call this.
 */
export interface TokenBucket {
  take(now: number): number;
  reset(now?: number): void;
}

export function createTokenBucket(capacity = 10, windowMs = 60_000): TokenBucket {
  let tokens = capacity;
  let updated = 0;

  return {
    take(now: number): number {
      if (updated === 0) updated = now;
      const elapsed = Math.max(0, now - updated);
      tokens = Math.min(capacity, tokens + (elapsed * capacity) / windowMs);
      updated = now;
      if (tokens >= 1) {
        tokens -= 1;
        return 0;
      }
      return Math.ceil(((1 - tokens) * windowMs) / capacity);
    },
    reset(now = Date.now()) {
      tokens = capacity;
      updated = now;
    },
  };
}

export const outboundBudget = createTokenBucket(10, 60_000);

export function resetOutboundBudget(now = Date.now()): void {
  outboundBudget.reset(now);
}

function testsSkipWait(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.VITEST === "true";
}

/** Wait until a token is free. Tests do not sleep; production waits, capped so a run can still finish. */
export async function acquireOutbound(pause: (ms: number) => Promise<void>): Promise<void> {
  const started = Date.now();
  for (;;) {
    const waitMs = outboundBudget.take(Date.now());
    if (waitMs <= 0) return;
    if (testsSkipWait()) return;
    if (Date.now() - started > 12_000) return;
    await pause(waitMs);
  }
}
