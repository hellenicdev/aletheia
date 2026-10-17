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
});
