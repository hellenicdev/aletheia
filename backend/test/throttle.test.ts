import { describe, expect, it } from "vitest";
import { createTokenBucket } from "../src/throttle";

describe("outbound token bucket", () => {
  it("allows a burst of ten calls and then waits about six seconds", () => {
    const bucket = createTokenBucket(10, 60_000);
    const start = 1_000_000;
    for (let index = 0; index < 10; index += 1) expect(bucket.take(start)).toBe(0);
    expect(bucket.take(start)).toBeGreaterThanOrEqual(6_000);
    expect(bucket.take(start + 6_000)).toBe(0);
  });

  it("starts a fresh isolate with two tokens and then waits", () => {
    const bucket = createTokenBucket(10, 60_000, 2);
    const start = 1_000_000;
    expect(bucket.take(start)).toBe(0);
    expect(bucket.take(start)).toBe(0);
    expect(bucket.take(start)).toBeGreaterThanOrEqual(6_000);
  });
});
