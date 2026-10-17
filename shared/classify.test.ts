import { describe, expect, it } from "vitest";
import { inferClaimType } from "./classify";

describe("inferClaimType", () => {
  it("keeps a dated place claim checkable and a slogan rhetorical", () => {
    expect(
      inferClaimType("The Eiffel Tower is located in Berlin and was completed in 1889."),
    ).toBe("checkable_factual");
    expect(
      inferClaimType(
        "It is, without doubt, the most breathtaking structure humanity has ever built.",
      ),
    ).toBe("rhetorical");
  });

  it("treats a value judgement as opinion and a dated opinion as mixed", () => {
    expect(inferClaimType("I think the waterfront deserves better lighting.")).toBe("opinion");
    expect(inferClaimType("I think the fee doubled in 2024.")).toBe("mixed");
  });
});
