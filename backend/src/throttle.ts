import { deadlineReached } from "./deadline";

/**
 * Per-isolate token bucket for outbound Firecrawl calls.
 * Capacity 10, refilled smoothly over one minute. Cache hits do not call this.
 */
export interface TokenBucket {
  take(now: number): number;
  reset(now?: number): void;
}

export function createTokenBucket(capacity = 10, windowMs = 60_000, initial = capacity): TokenBucket {
  let tokens = initial;
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
      tokens = initial;
      updated = now;
    },
  };
}

/**
 * A fresh isolate starts with two tokens, then refills at about 10/minute.
 * That stops a new request from firing its whole search budget at once.
 * The bucket does not survive across isolates. A shared limit would need a
 * Durable Object or KV binding, which this worker does not add.
 */
export const outboundBudget = createTokenBucket(10, 60_000, 2);

export function resetOutboundBudget(now = Date.now()): void {
  outboundBudget.reset(now);
}

function testsSkipWait(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.VITEST === "true";
}

/** Wait until a token is free. Tests do not sleep; production waits, and an aborted deadline ends the wait. */
export async function acquireOutbound(
  pause: (ms: number, signal?: AbortSignal) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (signal?.aborted) throw deadlineReached();
    const waitMs = outboundBudget.take(Date.now());
    if (waitMs <= 0) return;
    if (testsSkipWait()) return;
    const elapsed = Date.now() - started;
    if (elapsed > 12_000) return;
    await pause(Math.min(waitMs, 12_000 - elapsed), signal);
  }
}
