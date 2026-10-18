import { describe, expect, it } from "vitest";
import { trackAnalyzeStarted } from "./analytics";

describe("analytics", () => {
  it("sends a content-free analyze_started event", () => {
    const calls: unknown[][] = [];
    trackAnalyzeStarted((...args) => {
      calls.push(args);
    });
    expect(calls).toEqual([["event", "analyze_started"]]);
    trackAnalyzeStarted(undefined);
    expect(calls).toHaveLength(1);
  });
});
