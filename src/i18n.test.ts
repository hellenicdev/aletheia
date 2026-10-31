import { describe, expect, it } from "vitest";
import { labelHelp, labelName, STRINGS, t } from "./i18n";

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
    expect(labelName("en", "Not checked")).toBe("Not checked");
    expect(labelName("el", "Not checked")).toBe("Δεν ελέγχθηκε");
    expect(labelHelp("en", "Not checked")).toBe("Not checked in this analysis to save search credits.");
    expect(labelHelp("el", "Not checked")).toContain("Δεν ελέγχθηκε");
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
    expect(t("en", "scrapeFailed")).toBe(
      "This page could not be read. Paste the article text instead.",
    );
    expect(t("el", "scrapeFailed")).toContain("Επικολλήστε το κείμενο του άρθρου");
    expect(t("en", "searchViaTavily")).toBe("Search: Tavily");
    expect(t("el", "searchViaTavily")).toBe("Αναζήτηση: Tavily");
    expect(t("en", "ignoredNav")).toBe("Ignored {n} lines of page navigation / related headlines");
    expect(t("el", "ignoredNav")).toContain("Αγνοήθηκαν");
    expect(t("en", "github")).toBe("View source on GitHub");
    expect(t("el", "github")).toBe("Πηγαίος κώδικας στο GitHub");
    expect(t("en", "shareText")).toBe("Aletheia rated this article {score}/100: {band}");
    expect(t("el", "shareText")).toContain("{score}/100");
    expect(t("el", "share")).toBe("Κοινοποίηση");
    expect(t("en", "shareCopied")).toBe("Copied!");
    expect(t("el", "shareCopied")).toBe("Αντιγράφηκε!");
  });
});
