import { describe, expect, it } from "vitest";
import { evaluativeDensity, inferClaimType, looksLikeOpinionSection, reconcileClaimType } from "./classify";

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
    expect(inferClaimType("Savor that nectar now, you sniveling moth pricks.")).toBe("rhetorical");
    expect(
      inferClaimType("the White House's willingness to dump a client at a time of weakness"),
    ).toBe("opinion");
    expect(inferClaimType("Disabled people face a debilitating mess of bureaucracy.")).toBe("opinion");
  });

  it("keeps a local opinion label when the model called the sentence factual", () => {
    expect(
      reconcileClaimType("Savor that nectar now, you sniveling moth pricks.", "checkable_factual"),
    ).toBe("rhetorical");
    expect(reconcileClaimType("I think the fee doubled in 2024.", "checkable_factual")).toBe("mixed");
    expect(reconcileClaimType("The council voted 7 to 2.", "checkable_factual")).toBe("checkable_factual");
  });
});

describe("opinion section cues", () => {
  it("reads opinion paths and section kickers without flagging a news lead", () => {
    expect(looksLikeOpinionSection("https://www.ertnews.gr/apopseis/dimosio-vima/column", null, "Κείμενο.")).toBe(
      true,
    );
    expect(looksLikeOpinionSection("https://www.theguardian.com/commentisfree/2026/oct/fees", null, "Fees rose.")).toBe(
      true,
    );
    expect(looksLikeOpinionSection(null, "Δημόσιο Βήμα: η συμφωνία", "Η κυβέρνηση ανακοίνωσε μέτρα.")).toBe(true);
    expect(
      looksLikeOpinionSection(
        "https://www.bbc.com/news/articles/vaping",
        "A million people vape",
        "Public opinion is divided, but the study counted a million people.",
      ),
    ).toBe(false);
  });

  it("needs several evaluative sentences before a news story becomes a column", () => {
    const column = [
      "I think the fee vote is a failure of compassion.",
      "We should freeze the charges until wages catch up.",
      "In my view the majority ignores the people on those boats.",
      "The harbour deserves a quieter season.",
      "The minutes do record a 7 to 2 vote on Monday.",
    ];
    expect(evaluativeDensity(column)).toBe(true);
    expect(
      evaluativeDensity([
        "The council voted 7 to 2.",
        "I think the fee is high.",
        "Twelve boats remain on the list.",
        "The change takes effect in May.",
      ]),
    ).toBe(false);
  });
});
