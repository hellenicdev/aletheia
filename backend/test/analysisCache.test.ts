import { describe, expect, it } from "vitest";
import { canonicalUrl } from "../../shared/citations";
import {
  analysisCacheUrl,
  normaliseAnalysisUrl,
  normaliseCachedText,
  shouldCacheAnalysis,
  storeAnalysis,
  textAnalysisCacheUrl,
  type AnalysisCache,
} from "../src/analysisCache";
import type { AnalysisResult } from "../../shared/types";
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
    expect(english).toContain(`/text/en/`);
    expect(greek).toContain(`/text/el/`);
  });

  it("keeps the English URL key and suffixes Greek", () => {
    const english = analysisCacheUrl(clean, "en");
    const greek = analysisCacheUrl(clean, "el");
    expect(english).toBe(analysisCacheUrl(clean));
    expect(english).toBe(
      `https://cache.aletheia.internal/analysis/v${PIPELINE_VERSION}/${encodeURIComponent(clean)}`,
    );
    expect(greek).toBe(`${english}/el`);
    expect(greek).not.toBe(english);
  });
});

describe("analysis cache writes", () => {
  const page = "https://example.com/story";

  function recorded(): { cache: AnalysisCache; puts: string[] } {
    const puts: string[] = [];
    return {
      puts,
      cache: {
        async get() {
          return null;
        },
        async put(url, _result, language) {
          puts.push(analysisCacheUrl(url, language));
        },
      },
    };
  }

  function verdict(
    status: { state: "ok" | "partial" | "unavailable"; reason: "out_of_credits" | "failed" | null },
    sourced: boolean,
  ): AnalysisResult {
    return {
      segments: [{ sources: sourced ? [{ url: "https://www.reuters.com/world/source" }] : [] }],
      meta: { searchStatus: { ...status, provider: sourced ? ("tavily" as const) : null } },
    } as AnalysisResult;
  }

  it("caches an ok result", async () => {
    const { cache, puts } = recorded();
    const result = verdict({ state: "ok", reason: null }, true);
    expect(shouldCacheAnalysis(result)).toBe(true);
    await storeAnalysis(cache, { url: page }, "en", result);
    expect(puts).toEqual([analysisCacheUrl(page, "en")]);
  });

  it("does not cache an unavailable result", async () => {
    const { cache, puts } = recorded();
    const result = verdict({ state: "unavailable", reason: "failed" }, false);
    expect(shouldCacheAnalysis(result)).toBe(false);
    await storeAnalysis(cache, { url: page }, "en", result);
    expect(puts).toEqual([]);
  });

  it("does not cache an out_of_credits result", async () => {
    const { cache, puts } = recorded();
    const missed = verdict({ state: "unavailable", reason: "out_of_credits" }, false);
    const partial = verdict({ state: "partial", reason: "out_of_credits" }, true);
    expect(shouldCacheAnalysis(missed)).toBe(false);
    expect(shouldCacheAnalysis(partial)).toBe(false);
    await storeAnalysis(cache, { url: page }, "en", missed);
    await storeAnalysis(cache, { url: page }, "en", partial);
    expect(puts).toEqual([]);
  });

  it("also stores the canonical article URL when a redirect changed it", async () => {
    const { cache, puts } = recorded();
    const result = verdict({ state: "ok", reason: null }, true);
    result.article = { sourceUrl: "https://example.com/story/canonical" } as AnalysisResult["article"];
    await storeAnalysis(cache, { url: page }, "el", result);
    expect(puts).toEqual([
      analysisCacheUrl(page, "el"),
      analysisCacheUrl("https://example.com/story/canonical", "el"),
    ]);
  });

  it("does not write a second key when the article URL normalises to the same cache entry", async () => {
    const { cache, puts } = recorded();
    const result = verdict({ state: "ok", reason: null }, true);
    result.article = { sourceUrl: "http://example.com/story/" } as AnalysisResult["article"];
    await storeAnalysis(cache, { url: page }, "en", result);
    expect(puts).toEqual([analysisCacheUrl(page, "en")]);
  });

  it("matches a share permalink to the cache key after the url query is decoded", () => {
    const article = "https://www.reuters.com/world/europe/story?id=1";
    const permalink = `https://hellenicdev.eu/aletheia/?url=${encodeURIComponent(article)}`;
    const parsed = new URL(permalink).searchParams.get("url");
    expect(parsed).toBe(article);
    expect(analysisCacheUrl(parsed ?? "", "en")).toBe(analysisCacheUrl(article, "en"));
    const greek = `https://hellenicdev.eu/aletheia/el/?url=${encodeURIComponent(article)}`;
    const greekUrl = new URL(greek).searchParams.get("url") ?? "";
    expect(analysisCacheUrl(greekUrl, "el")).toBe(analysisCacheUrl(article, "el"));
    expect(analysisCacheUrl(greekUrl, "el")).not.toBe(analysisCacheUrl(article, "en"));
  });

  it("caches a partial search that still cites a source", async () => {
    const { cache, puts } = recorded();
    const result = verdict({ state: "partial", reason: "failed" }, true);
    expect(shouldCacheAnalysis(result)).toBe(true);
    await storeAnalysis(cache, { url: page }, "en", result);
    expect(puts).toEqual([analysisCacheUrl(page)]);
    expect(shouldCacheAnalysis(verdict({ state: "partial", reason: "failed" }, false))).toBe(false);
  });
});
