import { describe, expect, it } from "vitest";
import { LABELS } from "../shared/labels";
import { buildSample } from "./sample";

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
});
