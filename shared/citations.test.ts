import { describe, expect, it } from "vitest";
import { applyEvidence, canonicalUrl, isWireCopy } from "./citations";

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

describe("independent evidence", () => {
  it("rejects the article's own domain, social copies, and echoed snippets", () => {
    const claim = "Sixteen people were rescued off the coast before dawn.";
    const echo = applyEvidence({
      label: "True",
      confidence: 0.95,
      explanation: "The page repeats the sentence.",
      claimText: claim,
      sourceUrls: ["https://www.theonion.com/story"],
      evidence: [
        {
          url: "https://www.theonion.com/story",
          title: "Satire",
          snippet: "Sixteen people were rescued off the coast before dawn.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
      articleDomain: "theonion.com",
      articleText: claim,
    });
    expect(echo.label).toBe("Unverifiable");
    expect(echo.explanation).toContain("not independently verified");

    const wire = applyEvidence({
      label: "True",
      confidence: 0.9,
      explanation: "A separate newsroom reported the rescue.",
      claimText: claim,
      sourceUrls: ["https://www.reuters.com/world/rescue"],
      evidence: [
        {
          url: "https://www.reuters.com/world/rescue",
          title: "Reuters",
          snippet: "Coast guard crews brought sixteen people ashore after a night search.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
      articleDomain: "apnews.com",
      articleText: "A longer original article about the rescue operation and the crew.",
    });
    expect(wire.label).toBe("True");
    expect(wire.sources).toHaveLength(1);
  });
});

describe("wire reprints and entity match", () => {
  it("does not treat an AP wire copy as independent evidence", () => {
    const claim = "The coastal plant received a one billion dollar loan.";
    const wire = applyEvidence({
      label: "True",
      confidence: 0.9,
      explanation: "A partner site carried the same wire.",
      claimText: claim,
      sourceUrls: ["https://abcnews.go.com/US/wireStory/coastal-loan"],
      evidence: [
        {
          url: "https://abcnews.go.com/US/wireStory/coastal-loan",
          title: "ABC",
          snippet: "Congress discussed a separate energy loan during the hearing.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
      articleDomain: "apnews.com",
      articleText: "An original AP story about the coastal plant and its financing.",
    });
    expect(isWireCopy("https://abcnews.go.com/US/wireStory/coastal-loan")).toBe(true);
    expect(isWireCopy("https://www.usnews.com/news/national/articles/loan")).toBe(true);
    expect(isWireCopy("https://www.reuters.com/world/energy")).toBe(false);
    expect(wire.label).toBe("Unverifiable");
    expect(wire.explanation).toContain("not independently verified");
  });

  it("refuses False when the evidence names a different plant", () => {
    const claim = "The Palisades nuclear plant received a $1 billion loan.";
    const mismatch = applyEvidence({
      label: "False",
      confidence: 0.86,
      explanation: "Another plant received a larger loan.",
      claimText: claim,
      sourceUrls: ["https://www.reuters.com/business/energy/duane"],
      evidence: [
        {
          url: "https://www.reuters.com/business/energy/duane",
          title: "Duane Arnold loan",
          snippet: "The Duane Arnold plant received a $1.9 billion loan.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
    });
    expect(mismatch.label).toBe("Unverifiable");
    expect(mismatch.explanation).toContain("different person");

    const samePlant = applyEvidence({
      label: "False",
      confidence: 0.9,
      explanation: "Palisades received a larger loan.",
      claimText: claim,
      sourceUrls: ["https://www.reuters.com/business/energy/palisades"],
      evidence: [
        {
          url: "https://www.reuters.com/business/energy/palisades",
          title: "Palisades",
          snippet: "Palisades received a $1.9 billion loan, not $1 billion.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
    });
    expect(samePlant.label).toBe("False");
    expect(samePlant.sources).toHaveLength(1);
  });

  it("keeps a stable fact from model knowledge when search returns nothing", () => {
    const stable = applyEvidence({
      label: "True",
      confidence: 0.8,
      explanation: "Paris is the capital of France.",
      claimText: "Paris is the capital of France and has been for generations.",
      sourceUrls: [],
      evidence: [],
      searchEnabled: true,
      allowModelKnowledge: true,
      uiLanguage: "en",
    });
    expect(stable.label).toBe("True");
    expect(stable.confidence).toBeLessThanOrEqual(0.55);
    expect(stable.evidenceMode).toBe("model-knowledge-only");

    const news = applyEvidence({
      label: "True",
      confidence: 0.8,
      explanation: "The fee changed in 2024.",
      claimText: "The marina fee doubled in 2024.",
      sourceUrls: [],
      evidence: [],
      searchEnabled: true,
      allowModelKnowledge: true,
      uiLanguage: "en",
    });
    expect(news.label).toBe("Unverifiable");
  });
});

describe("canonicalUrl", () => {
  it("ignores a trailing slash and fragment", () => {
    expect(canonicalUrl("https://example.com/minutes/#vote")).toBe(
      "https://example.com/minutes",
    );
  });
});
