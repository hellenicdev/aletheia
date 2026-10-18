import { describe, expect, it } from "vitest";
import type { Label } from "../shared/labels";
import { CLAIM_LIMIT, joinNotice, parseFilter, presentLabels, visibleClaims } from "./resultsView";

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
    expect(parseFilter("nope")).toBe("all");
  });

  it("joins notices into one line and drops blanks", () => {
    expect(joinNotice(["Sample report.", "", "  Live search is unavailable.  "])).toBe(
      "Sample report. · Live search is unavailable.",
    );
    expect(joinNotice([null, " "])).toBe("");
  });
});
