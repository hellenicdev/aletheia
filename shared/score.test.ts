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
    expect(score.verdict).toContain("largely supported");
  });

  it("punishes contradicted claims", () => {
    const score = aggregateScore(
      [segment("False"), segment("False")],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(score.factualAccuracy).toBe(0);
    expect(score.overall).toBe(14);
    expect(score.verdict).toContain("contradicted");
  });

  it("weights a single false claim below a clean report", () => {
    const score = aggregateScore(
      [segment("True"), segment("True"), segment("False")],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(score.factualAccuracy).toBe(67);
    expect(score.overall).toBe(67);
    expect(score.verdict).toContain("mixed picture");
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
    expect(score.factualAccuracy).toBeNull();
    expect(score.sourcing).toBe(0);
    expect(score.overall).toBe(50);
    expect(score.verdict).toMatch(/[\u0370-\u03FF]/);
    expect(score.verdict).toContain("50/100");
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

  it("gives false claims more influence than a low confidence would erase", () => {
    const score = aggregateScore(
      [segment("True", 1), segment("False", 0.5)],
      { contradictionCount: 0, searchEnabled: true, uiLanguage: "en" },
    );
    expect(score.factualAccuracy).toBe(67);
  });
});
