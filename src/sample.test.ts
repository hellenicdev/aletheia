import { describe, expect, it } from "vitest";
import { LABELS } from "../shared/labels";
import { scoreBand } from "./share";
import { buildFixture, buildSample, fixtureFromSearch } from "./sample";

describe("buildSample", () => {
  it("covers every label and keeps highlights aligned", () => {
    for (const lang of ["en", "el"] as const) {
      const report = buildSample(lang);
      expect(new Set(report.segments.map((segment) => segment.label))).toEqual(new Set(LABELS));
      for (const segment of report.segments) {
        expect(report.article.text.slice(segment.start, segment.end)).toBe(segment.text);
      }
      expect(report.score.overall).toBeGreaterThan(0);
      expect(report.score.overall).toBeLessThan(100);
      expect(report.score.verdict).toContain(`${report.score.overall}/100`);
      if (lang === "el") {
        expect(report.score.verdict).toMatch(/[\u0370-\u03FF]/);
        expect(report.score.verdict).toContain("2 αληθείς");
        expect(report.score.verdict).toContain("1 ψευδής");
        expect(report.score.verdict).toContain("1 παραπλανητικός");
        expect(report.score.verdict).toContain("1 μη επαληθεύσιμος");
      }
      expect(report.contradictions).toHaveLength(1);
    }
  });

  it("builds local true, false, mixed, and unverifiable reports in both languages", () => {
    expect(fixtureFromSearch("?fixture=false")).toBe("false");
    expect(fixtureFromSearch("?demo=1")).toBe("mixed");
    expect(fixtureFromSearch("")).toBeNull();
    for (const lang of ["en", "el"] as const) {
      const high = buildFixture("true", lang);
      const low = buildFixture("false", lang);
      const thin = buildFixture("unverifiable", lang);
      const mixed = buildFixture("mixed", lang);
      expect(scoreBand(high.score.overall, high.provisional)).toBe("high");
      expect(high.segments.some((segment) => segment.label === "True")).toBe(true);
      expect(high.segments.some((segment) => segment.label === "Misleading")).toBe(true);
      expect(scoreBand(low.score.overall, low.provisional)).toBe("low");
      expect(low.segments.some((segment) => segment.label === "False")).toBe(true);
      expect(thin.provisional).toBe(true);
      expect(thin.segments.every((segment) => segment.label === "Unverifiable")).toBe(true);
      expect(thin.segments.every((segment) => segment.sources.length === 0)).toBe(true);
      expect(mixed.segments.map((segment) => segment.label).sort()).toEqual(buildSample(lang).segments.map((segment) => segment.label).sort());
      for (const report of [high, low, thin, mixed]) {
        for (const segment of report.segments) {
          expect(report.article.text.slice(segment.start, segment.end)).toBe(segment.text);
        }
        expect(report.article.sourceUrl).toMatch(/^https:\/\//);
        if (lang === "el") expect(report.score.verdict).toMatch(/[\u0370-\u03FF]/);
      }
    }
  });
});
