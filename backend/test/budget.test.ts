import { describe, expect, it } from "vitest";
import {
  SUBREQUEST_LIMIT,
  BudgetExhausted,
  createSubrequestBudget,
  planEvidence,
  trackFetch,
} from "../src/budget";

describe("subrequest budget", () => {
  it("counts each fetch and stops before the worker limit", async () => {
    const budget = createSubrequestBudget(2);
    const fetchImpl = trackFetch(async () => new Response("ok"), budget);
    await fetchImpl("https://example.com/a");
    await fetchImpl("https://example.com/b");
    expect(budget.remaining()).toBe(0);
    await expect(fetchImpl("https://example.com/c")).rejects.toThrow(/Too many subrequests/);
    await expect(fetchImpl("https://example.com/c")).rejects.toBeInstanceOf(BudgetExhausted);
    expect(budget.used).toBe(2);
  });

  it("counts one extra subrequest when the response was redirected", async () => {
    const budget = createSubrequestBudget(4);
    const fetchImpl = trackFetch(async () => {
      const response = new Response("ok", { status: 200 });
      Object.defineProperty(response, "redirected", { value: true });
      return response;
    }, budget);
    await fetchImpl("https://example.com/a");
    expect(budget.used).toBe(2);
    const plain = createSubrequestBudget(4);
    await trackFetch(async () => new Response("ok"), plain)("https://example.com/b");
    expect(plain.used).toBe(1);
  });

  it("uses a hard budget under the free-plan limit and records the stage", () => {
    expect(SUBREQUEST_LIMIT).toBe(32);
    const budget = createSubrequestBudget();
    expect(budget.limit).toBe(32);
    budget.setStage("evidence");
    expect(budget.trySpend()).toBe(true);
    expect(budget.trySpend(100)).toBe(false);
    expect(budget.used).toBe(1);
    expect(budget.snapshot()).toEqual({
      ingest: 0,
      segment: 0,
      evidence: 1,
      verify: 0,
      score: 0,
      total: 1,
    });
  });

  it("reserves model calls before it spends the rest on searches", () => {
    const costs = { search: 2, verify: 2 };
    const searches = planEvidence(32, 12, costs);
    expect(searches).toBeGreaterThan(0);
    expect(searches).toBeLessThanOrEqual(12);
    const groups = Math.ceil(searches / 4);
    const reserved = 1 + 1 + groups * costs.verify + searches * costs.search;
    expect(reserved).toBeLessThanOrEqual(32);
    expect(planEvidence(2, 8)).toBe(0);
    expect(planEvidence(8, 3, { search: 2, verify: 1 })).toBe(2);
    expect(planEvidence(32, 0)).toBe(0);
    expect(planEvidence(30, 12, { search: 2, verify: 2 })).toBe(11);
    expect(planEvidence(30, 12, { search: 1, verify: 2 })).toBe(12);
  });
});
