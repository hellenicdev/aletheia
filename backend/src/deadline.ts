import { LIMITS } from "./limits";

/** Raised when the analysis deadline aborts a wait that is independent of the in-flight fetch. */
export function deadlineReached(): Error {
  const error = new Error("The analysis deadline was reached.");
  error.name = "TimeoutError";
  return error;
}

export function isDeadline(error: unknown): boolean {
  return error instanceof Error && error.message === "The analysis deadline was reached.";
}

/** Clamp a per-request timeout into the 12–15s band unless the caller asked for less. */
export function capOutbound(ms?: number): number {
  const cap = LIMITS.outboundTimeoutMs;
  if (ms == null || !Number.isFinite(ms)) return cap;
  return Math.min(cap, Math.max(250, ms));
}

/**
 * A native timer. Pass this signal itself to fetch.
 * A signal built in JavaScript does not cancel a hung worker fetch.
 */
export function fetchSignal(ms?: number): AbortSignal {
  return AbortSignal.timeout(capOutbound(ms));
}

/** A hung response body must not outlive the fetch timeout. This is not the analysis deadline. */
export function readBody(response: Response, parent?: AbortSignal, ms?: number): Promise<string> {
  const signal = fetchSignal(ms);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onTimeout);
      parent?.removeEventListener("abort", onParent);
      run();
    };
    const onTimeout = () => finish(() => reject(new Error("The request timed out.")));
    const onParent = () => finish(() => reject(deadlineReached()));
    if (signal.aborted) {
      onTimeout();
      return;
    }
    if (parent?.aborted) {
      onParent();
      return;
    }
    signal.addEventListener("abort", onTimeout, { once: true });
    parent?.addEventListener("abort", onParent, { once: true });
    response.text().then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/** Abort when any input aborts. The fetch call may ignore its signal; callers still race this one. */
export function combineSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const pending = signals.filter((signal) => {
    if (signal.aborted) {
      controller.abort();
      return false;
    }
    return true;
  });
  if (controller.signal.aborted) return controller.signal;
  const onAbort = () => controller.abort();
  for (const signal of pending) signal.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

/**
 * Settles when `work` settles or when `signal` aborts, whichever is first.
 * A fetch that never reads its AbortSignal still loses this race.
 */
export function raceAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = reject;
  });
  if (signal.aborted) {
    void work.then(
      () => undefined,
      () => undefined,
    );
    return Promise.reject(deadlineReached());
  }
  const onAbort = () => rejectAbort(deadlineReached());
  signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([work, aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}
