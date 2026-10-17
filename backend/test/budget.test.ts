import { describe, expect, it } from "vitest";
import { createSubrequestBudget, trackFetch } from "../src/budget";

describe("subrequest budget", () => {
  it("counts each fetch and stops before the worker limit", async () => {
    const budget = createSubrequestBudget(2);
    const fetchImpl = trackFetch(async () => new Response("ok"), budget);
    await fetchImpl("https://example.com/a");
    await fetchImpl("https://example.com/b");
    expect(budget.remaining()).toBe(0);
    await expect(fetchImpl("https://example.com/c")).rejects.toThrow(/Too many subrequests/);
    expect(budget.used).toBe(2);
  });
});
