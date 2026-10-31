import { describe, expect, it } from "vitest";
import type { Label } from "../shared/labels";
import { CLAIM_LIMIT, joinNotice, parseFilter, parseSort, presentLabels, sortClaims, visibleClaims } from "./resultsView";

const labels: Label[] = ["True", "False", "Misleading", "Unverifiable", "Opinion", "Rhetorical", "True"];

describe("results view", () => {
  it("shows six claims until the list is expanded", () => {
    const items = labels.map((label, index) => ({ id: index, label }));
    const page = visibleClaims(items, "all", false);
    expect(CLAIM_LIMIT).toBe(6);
    expect(page.total).toBe(7);
    expect(page.visible).toHaveLength(6);
    expect(visibleClaims(items, "all", true).visible).toHaveLength(7);
  });

  it("filters by label and lists only labels that appear", () => {
    const items = labels.map((label) => ({ label }));
    expect(presentLabels(items)).toEqual([
      "True",
      "False",
      "Misleading",
      "Unverifiable",
      "Opinion",
      "Rhetorical",
    ]);
    expect(visibleClaims(items, "False", false).visible).toEqual([{ label: "False" }]);
    expect(parseFilter("Opinion")).toBe("Opinion");
    expect(parseFilter("Not checked")).toBe("Not checked");
    expect(parseFilter("nope")).toBe("all");
  });

  it("sorts by verdict severity and by confidence without dropping claims", () => {
    const items = [
      { label: "True" as const, confidence: 0.4, start: 0 },
      { label: "False" as const, confidence: 0.9, start: 10 },
      { label: "Opinion" as const, confidence: 0.2, start: 20 },
      { label: "Misleading" as const, confidence: 0.5, start: 5 },
    ];
    expect(sortClaims(items, "reading").map((item) => item.start)).toEqual([0, 10, 20, 5].sort((a, b) => a - b));
    expect(sortClaims(items, "verdict").map((item) => item.label)).toEqual(["False", "Misleading", "True", "Opinion"]);
    const withSkipped = [...items, { label: "Not checked" as const, confidence: 1, start: 1 }];
    expect(sortClaims(withSkipped, "verdict").at(-1)?.label).toBe("Not checked");
    expect(sortClaims(items, "confidence").map((item) => item.confidence)).toEqual([0.9, 0.5, 0.4, 0.2]);
    expect(parseSort("verdict")).toBe("verdict");
    expect(parseSort("nope")).toBe("reading");
  });

  it("joins notices into one line and drops blanks", () => {
    expect(joinNotice(["Sample report.", "", "  Live search is unavailable.  "])).toBe(
      "Sample report. · Live search is unavailable.",
    );
    expect(joinNotice([null, " "])).toBe("");
  });
});
