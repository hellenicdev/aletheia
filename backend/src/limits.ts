export const LIMITS = {
  maxBodyBytes: 80_000,
  maxArticleChars: 12_000,
  minArticleChars: 40,
  maxUrlChars: 2_000,
  maxSegments: 24,
  maxSearches: 8,
  analysisDeadlineMs: 140_000,
  maxInFlight: 4,
  maxPageBytes: 1_000_000,
  maxRedirects: 4,
} as const;

export interface RateState {
  buckets: Map<string, number[]>;
  inFlight: { count: number };
}

export function allowRequest(
  state: RateState,
  key: string,
  now: number,
  limit: number,
  windowMs: number,
): boolean {
  const recent = (state.buckets.get(key) ?? []).filter((hit) => now - hit < windowMs);
  if (recent.length >= limit) {
    state.buckets.set(key, recent);
    return false;
  }
  recent.push(now);
  state.buckets.set(key, recent);
  return true;
}
