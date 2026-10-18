import { describe, expect, it } from "vitest";
import { aggregateScore, type ScoreSegment } from "./score";

function segment(
  label: ScoreSegment["label"],
  confidence = 1,
  hasValidSource = true,
): ScoreSegment {
  return { label, confidence, hasValidSource };
}

describe("aggregateScore", () => {
  it("scores fully supported claims at 100", () => {
    const score = aggregateScore(
      [segment("True"), segment("True"), segment("True")],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(score.overall).toBe(100);
    expect(score.factualAccuracy).toBe(100);
    expect(score.sourcing).toBe(100);
    expect(score.toneNeutrality).toBe(100);
    expect(score.logicalConsistency).toBe(100);
    expect(score.verdict).toContain("100/100");
    expect(score.verdict).toContain("3 of 3");
  });

  it("punishes contradicted claims", () => {
    const score = aggregateScore(
      [segment("False"), segment("False")],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(score.factualAccuracy).toBe(0);
    expect(score.overall).toBe(14);
    expect(score.verdict).toContain("2 of 2");
    expect(score.verdict).toContain("2 false");
  });

  it("weights a single false claim below a clean report", () => {
    const score = aggregateScore(
      [segment("True"), segment("True"), segment("False")],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(score.factualAccuracy).toBe(67);
    expect(score.overall).toBe(67);
    expect(score.verdict).toContain("3 of 3");
    expect(score.verdict).toContain("1 false");
  });

  it("caps commentary that has no checkable claims", () => {
    const score = aggregateScore(
      [segment("Opinion", 0.8, false), segment("Opinion", 0.8, false), segment("Opinion", 0.8, false)],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(score.factualBasis).toBe("commentary");
    expect(score.factualAccuracy).toBeNull();
    expect(score.overall).toBe(64);
    expect(score.verdict).toContain("opinion or commentary");
  });

  it("caps the score when live search is off and says so", () => {
    const score = aggregateScore(
      [segment("True"), segment("True")],
      { contradictionCount: 0, searchEnabled: false, uiLanguage: "en" },
    );
    expect(score.sourcing).toBe(30);
    expect(score.overall).toBe(68);
    expect(score.verdict).toContain("model-knowledge-only");
  });

  it("lowers logical consistency a little for one contradiction and keeps it high when unsure", () => {
    const none = aggregateScore(
      [segment("True"), segment("True")],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(none.logicalConsistency).toBe(100);
    const score = aggregateScore(
      [segment("True"), segment("True")],
      { contradictionCount: 1, searchEnabled: true, uiLanguage: "en" },
    );
    expect(score.logicalConsistency).toBe(85);
    expect(score.overall).toBe(98);
    const several = aggregateScore(
      [segment("True"), segment("True")],
      { contradictionCount: 3, searchEnabled: true, uiLanguage: "en" },
    );
    expect(several.logicalConsistency).toBe(70);
    expect(several.overall).toBe(96);
  });

  it("does not treat an all-unverifiable piece as confirmed", () => {
    const score = aggregateScore(
      [segment("Unverifiable", 0.4, false), segment("Unverifiable", 0.4, false)],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "el" },
    );
    expect(score.factualBasis).toBe("uncertain");
    expect(score.factualAccuracy).toBe(50);
    expect(score.sourcing).toBe(0);
    expect(score.overall).toBeLessThan(70);
    expect(score.overall).toBeGreaterThan(40);
    expect(score.verdict).toMatch(/[\u0370-\u03FF]/);
    expect(score.verdict).toContain("0 από 2");
  });

  it("does not let a cut-short run drag the score of the claims that were checked", () => {
    const checked = [
      ...Array.from({ length: 3 }, () => segment("True")),
      ...Array.from({ length: 9 }, () => ({ ...segment("Unverifiable", 0.3, false), countsTowardScore: false })),
    ];
    const score = aggregateScore(checked, {
      contradictionCount: 0,
      searchEnabled: true,
      searchDegraded: true,
      uiLanguage: "en",
      degraded: true,
      claimsVerified: 3,
      claimsTotal: 12,
    });
    expect(score.overall).toBe(100);
    expect(score.factualAccuracy).toBe(100);
    expect(score.sourcing).toBe(100);
    expect(score.verdict).toContain("Only 3 of 12 claims could be verified.");
    expect(score.counts.Unverifiable).toBe(9);
    const greek = aggregateScore(checked, {
      contradictionCount: 0,
      searchEnabled: true,
      searchDegraded: true,
      uiLanguage: "el",
      degraded: true,
      claimsVerified: 3,
      claimsTotal: 12,
    });
    expect(greek.verdict).toContain("Επαληθεύτηκαν μόνο 3 από 12 ισχυρισμούς.");
    expect(greek.overall).toBe(100);
  });

  it("scores a run where nothing could be verified as uncertain rather than a failed search pool", () => {
    const score = aggregateScore(
      Array.from({ length: 12 }, () => ({ ...segment("Unverifiable", 0.3, false), countsTowardScore: false })),
      {
        contradictionCount: 0,
        searchEnabled: true,
        searchDegraded: true,
        uiLanguage: "en",
        degraded: true,
        claimsVerified: 0,
        claimsTotal: 12,
      },
    );
    expect(score.factualAccuracy).toBeNull();
    expect(score.sourcing).toBeNull();
    expect(score.factualBasis).toBe("uncertain");
    expect(score.overall).toBeGreaterThanOrEqual(55);
    expect(score.verdict).toContain("Only 0 of 12 claims could be verified.");
    expect(score.verdict).toContain("live search failed");
    expect(score.verdict).not.toContain("mostly opinion");
    expect(score.verdict).not.toContain("opinion or commentary");
  });

  it("returns a zero score for an empty article", () => {
    const score = aggregateScore([], {
      contradictionCount: 0,
      searchEnabled: true,
      uiLanguage: "en",
    });
    expect(score.overall).toBe(0);
    expect(score.counts.True).toBe(0);
  });

  it("pulls a mostly unchecked article below a fully checked one", () => {
    const thin = aggregateScore(
      [
        ...Array.from({ length: 5 }, () => segment("True")),
        ...Array.from({ length: 15 }, () => segment("Unverifiable", 0.3, false)),
      ],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    const solid = aggregateScore(
      Array.from({ length: 8 }, () => segment("True")),
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(thin.factualAccuracy).toBeLessThan(80);
    expect(thin.overall).toBeLessThanOrEqual(70);
    expect(thin.verdict).toContain("5 of 20");
    expect(solid.overall).toBeGreaterThan(70);
    expect(thin.verdict).not.toBe(solid.verdict);
  });

  it("caps satire and low-credibility outlets under 50", () => {
    const supported = Array.from({ length: 6 }, () => segment("True"));
    const satire = aggregateScore(supported, {
      contradictionCount: 0,
      searchEnabled: true,
      uiLanguage: "en",
      outlet: "satire",
    });
    const low = aggregateScore(supported, {
      contradictionCount: 0,
      searchEnabled: true,
      uiLanguage: "en",
      outlet: "low-credibility",
    });
    expect(satire.overall).toBeLessThan(50);
    expect(satire.verdict).toContain("satire");
    expect(low.overall).toBeLessThan(50);
    expect(low.verdict).toContain("unreliable");
  });

  it("lets loaded language lower tone without erasing a true label", () => {
    const score = aggregateScore(
      [segment("True", 1, true), { ...segment("True"), tone: 20 }],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(score.toneNeutrality).toBeLessThan(90);
  });

  it("scores selected claims and ignores factual claims that were not searched", () => {
    const checked = aggregateScore(
      [
        ...Array.from({ length: 8 }, () => segment("True")),
        ...Array.from({ length: 12 }, () => ({ ...segment("Unverifiable", 0.3, false), inCoverage: false })),
      ],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(checked.overall).toBeGreaterThan(70);
    expect(checked.verdict).toContain("8 of 8");
    expect(checked.verdict).toContain("outside this search");
    expect(checked.verdict).toContain("do not count");
    expect(checked.counts.Unverifiable).toBe(12);
  });

  it("uses singular grammar when one claim was outside the search", () => {
    const score = aggregateScore(
      [segment("True"), { ...segment("Unverifiable", 0.3, false), inCoverage: false }],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(score.verdict).toContain("1 further claim was outside this search and does not count");
    expect(score.verdict).not.toContain("and do not count");
    const greek = aggregateScore(
      [segment("True"), { ...segment("Unverifiable", 0.3, false), inCoverage: false }],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "el" },
    );
    expect(greek.verdict).toContain("δεν μετρά");
    expect(greek.verdict).not.toContain("δεν μετρούν");
  });

  it("describes an opinion outlet as mostly opinion and caps the score", () => {
    const score = aggregateScore([segment("True"), segment("True")], {
      contradictionCount: 0,
      searchEnabled: true,
      uiLanguage: "en",
      outlet: "opinion",
    });
    expect(score.verdict).toContain("mostly opinion");
    expect(score.overall).toBeLessThanOrEqual(65);
  });

  it("caps coverage only when fewer than a quarter of the selected claims were decided", () => {
    const sparse = aggregateScore(
      [segment("True"), ...Array.from({ length: 7 }, () => segment("Unverifiable", 0.4, true))],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    const half = aggregateScore(
      [
        ...Array.from({ length: 4 }, () => segment("True")),
        ...Array.from({ length: 4 }, () => segment("Unverifiable", 0.4, true)),
      ],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(sparse.overall).toBeLessThanOrEqual(70);
    expect(half.overall).toBeGreaterThan(70);
  });

  it("labels a column with many opinion passages as mostly opinion and scores it below straight news", () => {
    const column = aggregateScore(
      [
        ...Array.from({ length: 4 }, () => segment("Opinion", 0.8, false)),
        segment("True"),
        segment("True"),
      ],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    const news = aggregateScore(
      Array.from({ length: 6 }, () => segment("True")),
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(column.verdict).toContain("mostly opinion");
    expect(column.overall).toBeLessThanOrEqual(65);
    expect(column.overall).toBeLessThan(news.overall);
    const greek = aggregateScore(
      [
        ...Array.from({ length: 4 }, () => segment("Opinion", 0.8, false)),
        segment("True"),
        segment("True"),
      ],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "el" },
    );
    expect(greek.verdict).toContain("κυρίως γνώμη");
  });

  it("caps a mostly-opinion column at 65, below an all-true news score", () => {
    const column = aggregateScore(
      Array.from({ length: 6 }, () => segment("True")),
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en", outlet: "opinion" },
    );
    expect(column.verdict).toContain("mostly opinion");
    expect(column.overall).toBe(65);
  });

  it("says a thin page had too little text instead of zero-of-one", () => {
    const score = aggregateScore([segment("Unverifiable", 0.3, false)], {
      contradictionCount: 0,
      searchEnabled: true,
      uiLanguage: "en",
    });
    expect(score.verdict).toContain("too little article text");
    expect(score.verdict).not.toContain("0 of 1");
  });

  it("says pasted text has an unknown outlet and does not add a reputation bonus", () => {
    const score = aggregateScore(
      [segment("True"), segment("True"), segment("True")],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en", outlet: "unknown" },
    );
    expect(score.overall).toBe(100);
    expect(score.verdict).toContain("outlet is unknown");
    expect(score.verdict).toContain("not a reputation judgement");
  });

  it("gives false claims more influence than a low confidence would erase", () => {
    const score = aggregateScore(
      [segment("True", 1), segment("False", 0.5)],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(score.factualAccuracy).toBe(67);
  });
});
