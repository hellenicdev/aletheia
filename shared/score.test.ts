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

  it("lowers logical consistency for contradictions", () => {
    const score = aggregateScore(
      [segment("True"), segment("True")],
      { contradictionCount: 1, searchEnabled: true, uiLanguage: "en" },
    );
    expect(score.logicalConsistency).toBe(70);
    expect(score.overall).toBe(96);
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

  it("gives false claims more influence than a low confidence would erase", () => {
    const score = aggregateScore(
      [segment("True", 1), segment("False", 0.5)],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(score.factualAccuracy).toBe(67);
  });
});
