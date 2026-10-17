import { describe, expect, it } from "vitest";
import { applyEvidence, canonicalUrl, isSyndicatedCopy, isWireCopy } from "./citations";

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
    expect(isWireCopy("https://www.clickondetroit.com/news/story")).toBe(true);
    expect(isWireCopy("https://www.wral.com/news/ap/story")).toBe(true);
    expect(isWireCopy("https://www.manisteenews.com/news/article")).toBe(true);
    expect(isWireCopy("https://www.aol.co.uk/articles/story")).toBe(true);
    expect(isWireCopy("https://apnews.com/article/coastal-loan")).toBe(false);
    expect(isWireCopy("https://www.reuters.com/world/energy")).toBe(false);
    expect(wire.label).toBe("Unverifiable");
    expect(wire.explanation).toContain("not independently verified");

    const titled = "Coast Guard rescues sixteen people off the Baja coast";
    expect(
      isSyndicatedCopy(
        {
          title: titled,
          snippet: "Stations carried the same wire story about the rescue.",
        },
        titled,
        "An original report about the rescue and the crew that stayed out overnight.",
      ),
    ).toBe(true);
    const copy = applyEvidence({
      label: "True",
      confidence: 0.8,
      explanation: "A local station carried the wire.",
      claimText: claim,
      sourceUrls: ["https://www.opb.org/article/rescue"],
      evidence: [
        {
          url: "https://www.opb.org/article/rescue",
          title: titled,
          snippet: "WASHINGTON (AP) — The coastal plant received financing for the restart.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
      articleDomain: "apnews.com",
      articleTitle: titled,
      articleText: "An original AP story about the coastal plant and its financing.",
    });
    expect(copy.label).toBe("Unverifiable");
    const reuters = applyEvidence({
      label: "True",
      confidence: 0.9,
      explanation: "A separate newsroom reported the loan.",
      claimText: claim,
      sourceUrls: ["https://www.reuters.com/world/energy"],
      evidence: [
        {
          url: "https://www.reuters.com/world/energy",
          title: "Energy loan",
          snippet: "Officials described a federal loan for the coastal plant after a separate review.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
      articleDomain: "apnews.com",
      articleTitle: titled,
      articleText: "An original AP story about the coastal plant and its financing.",
    });
    expect(reuters.label).toBe("True");

    expect(
      isSyndicatedCopy(
        {
          title: "Federal coast guard rescues sailors after baja delay notice extra",
          snippet: "A local station carried a shortened version of the same rescue report.",
        },
        "Federal coast guard rescues sailors after baja storm warning",
        "An original report about the rescue and the crew that stayed out overnight.",
        "apnews.com",
      ),
    ).toBe(true);
    expect(
      isSyndicatedCopy(
        {
          title: "Energy ministers debate a separate grid plan",
          snippet: "Officials described a federal loan for the coastal plant after a separate review.",
        },
        "Federal coast guard rescues sailors after baja storm warning",
        "An original report about the rescue and the crew that stayed out overnight.",
        "apnews.com",
      ),
    ).toBe(false);
    const credited = applyEvidence({
      label: "True",
      confidence: 0.8,
      explanation: "A partner site carried the wire.",
      claimText: claim,
      sourceUrls: ["https://www.newsday.com/news/nation/coast-guard"],
      evidence: [
        {
          url: "https://www.newsday.com/news/nation/coast-guard",
          title: "Coast Guard stop",
          snippet: "Editors appended a note that the dispatch came via the Associated Press.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
      articleDomain: "apnews.com",
      articleTitle: "Federal coast guard rescues sailors after baja storm warning",
      articleText: "An original AP story about the coastal plant and its financing.",
    });
    expect(credited.label).toBe("Unverifiable");

    const sameFamily = applyEvidence({
      label: "True",
      confidence: 0.8,
      explanation: "The UK edition repeated the BBC story.",
      claimText: claim,
      sourceUrls: ["https://www.bbc.co.uk/news/vaping"],
      evidence: [
        {
          url: "https://www.bbc.co.uk/news/vaping",
          title: "BBC",
          snippet: "A separate count of vaping among people who do not smoke.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
      articleDomain: "bbc.com",
      articleText: "An original BBC story about vaping rates.",
    });
    expect(sameFamily.label).toBe("Unverifiable");

    const weak = applyEvidence({
      label: "True",
      confidence: 0.7,
      explanation: "A newsletter and a policy journal agreed.",
      claimText: claim,
      sourceUrls: ["https://foo.substack.com/p/x", "https://publichealthpolicyjournal.com/story"],
      evidence: [
        {
          url: "https://foo.substack.com/p/x",
          title: "Newsletter",
          snippet: "The coastal plant received financing for the restart.",
        },
        {
          url: "https://publichealthpolicyjournal.com/story",
          title: "Journal",
          snippet: "The coastal plant received financing for the restart.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
      articleDomain: "naturalnews.com",
      articleText: "A long original post about the plant.",
    });
    expect(weak.label).toBe("Unverifiable");
  });

  it("does not fact-check a value judgement as True", () => {
    const applied = applyEvidence({
      label: "True",
      confidence: 0.7,
      explanation: "The record shows a change of policy.",
      claimText: "the White House's willingness to dump a client at a time of weakness",
      sourceUrls: ["https://www.reuters.com/world/policy"],
      evidence: [
        {
          url: "https://www.reuters.com/world/policy",
          title: "Reuters",
          snippet: "Washington changed its public line on the partnership during the talks.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
      articleDomain: "aljazeera.com",
      articleText: "A column about the partnership and the talks that followed.",
    });
    expect(applied.label).toBe("Opinion");
    expect(applied.sources).toEqual([]);
    expect(applied.evidenceMode).toBe("not-applicable");
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
