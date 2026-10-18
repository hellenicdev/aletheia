import { describe, expect, it } from "vitest";
import {
  applyEvidence,
  missingSpecificDetail,
  canonicalUrl,
  hasContradictingSpan,
  isRelevantEvidence,
  isStatisticalClaim,
  isSyndicatedCopy,
  isWireCopy,
} from "./citations";

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
          snippet: "Officials described a one billion dollar federal loan for the coastal plant after a separate review.",
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

    const articleTitle = "Coast Guard intercepts vessel off the California coast after a late night chase involving agencies";
    const opb = applyEvidence({
      label: "True",
      confidence: 0.9,
      explanation: "A local station reported the same intercept.",
      claimText: claim,
      sourceUrls: ["https://www.opb.org/article/coast-guard"],
      evidence: [
        {
          url: "https://www.opb.org/article/coast-guard",
          title: "Coast Guard intercepts vessel off California",
          snippet: "The station posted the story without a fresh byline.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
      articleDomain: "apnews.com",
      articleTitle,
      articleText: "An original AP story about the intercept and the crew that stayed out overnight.",
    });
    expect(opb.label).toBe("Unverifiable");
    const arabnews = applyEvidence({
      label: "True",
      confidence: 0.9,
      explanation: "A partner site carried the wire.",
      claimText: claim,
      sourceUrls: ["https://www.arabnews.com/node/coast-guard"],
      evidence: [
        {
          url: "https://www.arabnews.com/node/coast-guard",
          title: "Rescue at sea",
          snippet: "WASHINGTON (Reuters) — Crews stopped the boat off the California coast.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
      articleDomain: "apnews.com",
      articleTitle,
      articleText: "An original AP story about the intercept and the crew that stayed out overnight.",
    });
    expect(arabnews.label).toBe("Unverifiable");
    const ownWire = applyEvidence({
      label: "True",
      confidence: 0.9,
      explanation: "Reuters reported the intercept itself.",
      claimText: claim,
      sourceUrls: ["https://www.reuters.com/world/us/coast-guard"],
      evidence: [
        {
          url: "https://www.reuters.com/world/us/coast-guard",
          title: "Coast Guard intercepts vessel off California",
          snippet: "Reuters — The coastal plant received a one billion dollar loan after a separate review.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
      articleDomain: "apnews.com",
      articleTitle: "Energy ministers debate a separate grid plan",
      articleText: "An original AP story about a different financing vote.",
    });
    expect(ownWire.label).toBe("True");
    const shortened = "Coast Guard rescues sailors after Baja storm warning";
    const originalTitle = "Coast Guard rescues sailors after a storm warning delayed the Baja crossing";
    const originalLede =
      "The Coast Guard rescued sixteen sailors off Baja California on Monday after a storm warning delayed their crossing and the crew stayed out overnight.";
    expect(
      isSyndicatedCopy(
        {
          url: "https://www.opb.org/article/coast-guard-baja",
          title: shortened,
          snippet: "The station posted the story without a byline or wire credit.",
        },
        originalTitle,
        originalLede,
        "apnews.com",
      ),
    ).toBe(true);
    expect(
      isSyndicatedCopy(
        {
          url: "https://www.arabnews.com/node/coast-guard-baja",
          title: "Rescue at sea",
          snippet: originalLede,
        },
        originalTitle,
        originalLede,
        "apnews.com",
      ),
    ).toBe(true);
    const shortenedCopy = applyEvidence({
      label: "True",
      confidence: 0.9,
      explanation: "A partner site carried the same rescue.",
      claimText: claim,
      sourceUrls: ["https://www.opb.org/article/coast-guard-baja"],
      evidence: [
        {
          url: "https://www.opb.org/article/coast-guard-baja",
          title: shortened,
          snippet: "The station posted the story without a byline or wire credit.",
        },
      ],
      searchEnabled: true,
      uiLanguage: "en",
      articleDomain: "apnews.com",
      articleTitle: originalTitle,
      articleText: originalLede,
    });
    expect(shortenedCopy.label).toBe("Unverifiable");
    expect(shortenedCopy.sources).toEqual([]);
    expect(
      isSyndicatedCopy(
        { url: "https://example.com/minutes", title: "The council voted 7 to 2.", snippet: "Residents can read the minutes." },
        "Harbour lights council publishes the berth fee vote",
        "The council voted 7 to 2 on Monday and published the full minutes for residents of the harbour district.",
        "example.com",
      ),
    ).toBe(false);

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
      explanation: 'The report says "Palisades received a $1.9 billion loan, not $1 billion."',
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

describe("relevance and contradiction", () => {
  it("does not mark False from a different detail that does not deny the claim", () => {
    const claim = "Two were in critical condition.";
    const quote = "the survivors were treated for cold exposure";
    const evidence = [
      {
        url: "https://www.cbc.ca/news/coast-guard",
        title: "Coast Guard survivors",
        snippet: `Two survivors were ${quote} and their condition was monitored.`,
      },
    ];
    expect(hasContradictingSpan(claim, `The CBC report says "${quote}".`, evidence)).toBe(false);
    const applied = applyEvidence({
      label: "False",
      confidence: 0.9,
      explanation: `The CBC report says "${quote}".`,
      claimText: claim,
      sourceUrls: [evidence[0].url],
      evidence,
      searchEnabled: true,
      uiLanguage: "en",
    });
    expect(applied.label).toBe("Unverifiable");
    expect(applied.explanation.toLowerCase()).toContain("does not");
    expect(applied.sources).toEqual([]);
  });

  it("drops an off-topic page and a page the verifier marked irrelevant", () => {
    const claim = "Disposable vapes will be banned across Britain next year.";
    expect(
      isRelevantEvidence(claim, {
        title: "Cosmetology catalogue",
        snippet: "Grayson College lists courses in colour and salon management.",
      }),
    ).toBe(false);
    const minutes = "https://example.com/minutes";
    const shop = "https://shopping.example/advent";
    const applied = applyEvidence({
      label: "True",
      confidence: 0.8,
      explanation: "The minutes record the vote.",
      claimText: "The council voted 7 to 2 on Monday.",
      sourceUrls: [minutes, shop],
      evidence: [
        {
          url: minutes,
          title: "Council minutes",
          snippet: "The council voted 7 to 2 on Monday.",
        },
        {
          url: shop,
          title: "Council Bluffs advent calendar",
          snippet: "The council gift shop lists an advent calendar for the holiday.",
        },
      ],
      relevance: { [canonicalUrl(shop)]: false, [canonicalUrl(minutes)]: true },
      searchEnabled: true,
      uiLanguage: "en",
    });
    expect(applied.sources.map((source) => source.url)).toEqual([minutes]);
  });

  it("keeps a rate for the same population even when the verifier marked it irrelevant", () => {
    const claim = "4.9 million adults in the UK smoke.";
    const page = {
      url: "https://www.ons.gov.uk/peoplepopulationandcommunity/healthandsocialcare/drugusealcoholandsmoking",
      title: "Adult smoking habits in the UK",
      snippet: "ONS figures show 9.8% of adults in the UK smoke.",
    };
    expect(isStatisticalClaim(claim)).toBe(true);
    expect(isRelevantEvidence(claim, page)).toBe(true);
    const applied = applyEvidence({
      label: "True",
      confidence: 0.8,
      explanation: "The survey reports the same adult smoking rate.",
      claimText: claim,
      sourceUrls: [page.url],
      evidence: [page],
      relevance: { [canonicalUrl(page.url)]: false },
      searchEnabled: true,
      uiLanguage: "en",
    });
    expect(applied.label).toBe("True");
    expect(applied.sources.map((source) => source.url)).toEqual([page.url]);
  });

  it("does not mark True when the citation misses the claim's specific condition", () => {
    const claim = "Two people were bitten and two were in critical condition.";
    const page = {
      url: "https://apnews.com/article/shark-bite",
      title: "Shark bite",
      snippet: "A shark bit two people near the beach.",
    };
    expect(missingSpecificDetail(claim, [page])).toBe(true);
    const applied = applyEvidence({
      label: "True",
      confidence: 0.86,
      explanation: "Reports confirm the shark bite.",
      claimText: claim,
      sourceUrls: [page.url],
      evidence: [page],
      searchEnabled: true,
      uiLanguage: "en",
    });
    expect(applied.label).toBe("Unverifiable");
    expect(applied.explanation.toLowerCase()).toContain("specific detail");
    expect(applied.sources.map((source) => source.url)).toEqual([page.url]);
    const greek = applyEvidence({
      ...{
        label: "True" as const,
        confidence: 0.86,
        explanation: "Reports confirm the shark bite.",
        claimText: claim,
        sourceUrls: [page.url],
        evidence: [page],
        searchEnabled: true,
        uiLanguage: "el" as const,
      },
    });
    expect(greek.explanation).toContain("συγκεκριμένη λεπτομέρεια");
  });

  it("keeps True when the cited snippet contains the council figures", () => {
    const applied = applyEvidence({
      label: "True",
      confidence: 0.9,
      explanation: "The minutes record the vote.",
      claimText: "The council voted 7 to 2 on Monday.",
      sourceUrls: [minutes.url],
      evidence: [minutes],
      searchEnabled: true,
      uiLanguage: "en",
    });
    expect(applied.label).toBe("True");
  });
});

describe("canonicalUrl", () => {
  it("ignores a trailing slash and fragment", () => {
    expect(canonicalUrl("https://example.com/minutes/#vote")).toBe(
      "https://example.com/minutes",
    );
  });
});
