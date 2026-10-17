/** Raised when the analysis deadline aborts a wait that is independent of the in-flight fetch. */
export function deadlineReached(): Error {
  const error = new Error("The analysis deadline was reached.");
  error.name = "TimeoutError";
  return error;
}

export function isDeadline(error: unknown): boolean {
  return error instanceof Error && error.message === "The analysis deadline was reached.";
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
