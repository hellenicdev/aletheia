import { describe, expect, it } from "vitest";
import { applyEvidence, canonicalUrl } from "./citations";

const minutes = {
  url: "https://example.com/minutes/",
  title: "Minutes",
  snippet: "The council voted 7 to 2.",
};

describe("applyEvidence", () => {
  it("drops citations that were not retrieved and keeps the rest", () => {
    const applied = applyEvidence({
      label: "True",
      confidence: 0.91,
      explanation: "The minutes record the vote.",
      claimText: "The council voted 7 to 2.",
      sourceUrls: ["https://evil.example/phish", "https://example.com/minutes"],
      evidence: [minutes],
      searchEnabled: true,
      uiLanguage: "en",
    });
    expect(applied.label).toBe("True");
    expect(applied.sources.map((source) => source.url)).toEqual([minutes.url]);
    expect(applied.evidenceMode).toBe("web-search");
  });

  it("downgrades a firm label that cites nothing we retrieved", () => {
    const applied = applyEvidence({
      label: "False",
      confidence: 0.8,
      explanation: "A blog I imagined says otherwise.",
      claimText: "The fee doubled.",
      sourceUrls: ["https://evil.example/phish"],
      evidence: [minutes],
      searchEnabled: true,
      uiLanguage: "en",
    });
    expect(applied.label).toBe("Unverifiable");
    expect(applied.sources).toEqual([]);
    expect(applied.explanation).toContain("unverified");
    expect(applied.explanation).not.toContain("imagined");
  });

  it("keeps a stable model-only fact and strips every source", () => {
    const applied = applyEvidence({
      label: "True",
      confidence: 0.99,
      explanation: "Paris is the capital of France.",
      claimText: "Paris is the capital of France and has been for generations.",
      sourceUrls: ["https://example.com/paris"],
      evidence: [],
      searchEnabled: false,
      uiLanguage: "en",
    });
    expect(applied.label).toBe("True");
    expect(applied.sources).toEqual([]);
    expect(applied.confidence).toBeLessThanOrEqual(0.55);
    expect(applied.evidenceMode).toBe("model-knowledge-only");
  });

  it("refuses to verify numeric news from model memory", () => {
    const applied = applyEvidence({
      label: "True",
      confidence: 0.9,
      explanation: "The fee changed in 2024.",
      claimText: "The marina fee doubled in 2024.",
      sourceUrls: [],
      evidence: [],
      searchEnabled: false,
      uiLanguage: "el",
    });
    expect(applied.label).toBe("Unverifiable");
    expect(applied.sources).toEqual([]);
    expect(applied.explanation).toMatch(/[\u0370-\u03FF]/);
  });
});

describe("canonicalUrl", () => {
  it("ignores a trailing slash and fragment", () => {
    expect(canonicalUrl("https://example.com/minutes/#vote")).toBe(
      "https://example.com/minutes",
    );
  });
});
