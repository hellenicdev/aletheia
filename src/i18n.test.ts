import { describe, expect, it } from "vitest";
import { STRINGS, t } from "./i18n";

describe("i18n", () => {
  it("translates every English string into Greek", () => {
    const english = Object.keys(STRINGS.en).sort();
    const greek = Object.keys(STRINGS.el).sort();
    expect(greek).toEqual(english);
    for (const key of english) {
      expect(STRINGS.el[key as keyof typeof STRINGS.en].length).toBeGreaterThan(0);
    }
  });

  it("returns Greek copy for the Greek interface", () => {
    expect(t("el", "analyze")).toBe("Ανάλυση");
    expect(t("el", "misleading")).toMatch(/[\u0370-\u03FF]/);
  });

  it("states a provider outage in both languages", () => {
    expect(t("en", "searchOutageCredits")).toBe(
      "Live web search is unavailable (provider credits exhausted); results are based on model knowledge only",
    );
    expect(t("el", "searchOutageCredits")).toContain("εξαντλήθηκαν οι μονάδες του παρόχου");
    expect(t("en", "provisional")).toBe("provisional");
    expect(t("el", "provisional")).toBe("προσωρινό");
  });
});
