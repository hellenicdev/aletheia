import { describe, expect, it } from "vitest";
import { canonicalUrl } from "../../shared/citations";
import { analysisCacheUrl, normaliseAnalysisUrl, normaliseCachedText, textAnalysisCacheUrl } from "../src/analysisCache";
import { PIPELINE_VERSION } from "../src/version";

const clean = "https://www.reuters.com/world/europe/story";

describe("analysis cache key", () => {
  it("keeps a clean https URL on the existing pipeline key", () => {
    expect(normaliseAnalysisUrl(clean)).toBe(canonicalUrl(clean));
    expect(analysisCacheUrl(clean)).toBe(
      `https://cache.aletheia.internal/analysis/v${PIPELINE_VERSION}/${encodeURIComponent(canonicalUrl(clean))}`,
    );
  });

  it("folds tracking parameters, http, a trailing slash, and a fragment onto that key", () => {
    const variants = [
      "http://www.reuters.com/world/europe/story/",
      "https://WWW.Reuters.com/world/europe/story#section",
      "https://www.reuters.com/world/europe/story/?utm_source=newsletter&fbclid=abc&gclid=def",
      "https://www.reuters.com/world/europe/story?utm_medium=social&fbclid=zzz",
    ];
    for (const variant of variants) {
      expect(analysisCacheUrl(variant)).toBe(analysisCacheUrl(clean));
    }
  });

  it("keeps a non-tracking query and ignores parameter order", () => {
    const left = analysisCacheUrl("https://example.com/story?b=2&a=1");
    const right = analysisCacheUrl("http://example.com/story/?a=1&b=2&utm_campaign=demo");
    expect(left).toBe(right);
    expect(left).not.toBe(analysisCacheUrl("https://example.com/story"));
    expect(analysisCacheUrl("https://example.com/story")).not.toBe(analysisCacheUrl("https://www.example.com/story"));
  });

  it("collapses pasted-text whitespace without mixing languages", async () => {
    const text = "The council voted 7 to 2.";
    expect(normaliseCachedText(`  ${text.replace(" ", "   ")} `)).toBe(text);
    const english = await textAnalysisCacheUrl(`  ${text}  `, "en");
    const spaced = await textAnalysisCacheUrl(text.replace(" ", "\n"), "en");
    const greek = await textAnalysisCacheUrl(text, "el");
    expect(english).toBe(spaced);
    expect(greek).not.toBe(english);
    expect(english).toContain(`/v${PIPELINE_VERSION}/`);
  });
});
