import { describe, expect, it } from "vitest";
import { verifySystem, verifyUser } from "../src/prompts";

describe("verify prompt", () => {
  it("judges the core claim, partial truths, and entity mismatches", () => {
    const system = verifySystem("en", true);
    expect(system.startsWith("TASK:verify")).toBe(true);
    expect(system).toContain("core assertion");
    expect(system).toContain("Misleading");
    expect(system).toContain("same plant, person, or event");
    expect(system).toContain("widely established facts");
    const user = verifyUser(
      [{ id: "s1", claim: "The loan was approved.", context: "Earlier context. The loan was approved.", evidence: [] }],
      "2026-10-01T00:00:00.000Z",
    );
    expect(user).toContain("context");
    expect(user).toContain("Photo credits");
  });
});