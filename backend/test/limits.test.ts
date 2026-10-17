import { describe, expect, it } from "vitest";
import { allowRequest, type RateState } from "../src/limits";

describe("allowRequest", () => {
  it("enforces a sliding window per key", () => {
    const state: RateState = { buckets: new Map(), inFlight: { count: 0 } };
    for (let i = 0; i < 3; i++) expect(allowRequest(state, "a", 1_000 + i, 3, 10_000)).toBe(true);
    expect(allowRequest(state, "a", 1_004, 3, 10_000)).toBe(false);
    expect(allowRequest(state, "b", 1_004, 3, 10_000)).toBe(true);
    expect(allowRequest(state, "a", 12_000, 3, 10_000)).toBe(true);
  });
});
