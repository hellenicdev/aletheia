import type { AnalysisResult } from "../../shared/types";
import { currentPipelineCache, type ResultCache } from "./persistentCache";
import { PIPELINE_VERSION } from "./version";

const TTL_SECONDS = 24 * 60 * 60;

export interface AnalysisCache {
  get(pageUrl: string, language?: string): Promise<AnalysisResult | null>;
  put(pageUrl: string, result: AnalysisResult, language?: string): Promise<void>;
  getText?(text: string, language: string): Promise<AnalysisResult | null>;
  putText?(text: string, language: string, result: AnalysisResult): Promise<void>;
}

/**
 * A transient provider failure must not be replayed for a day. An ok search is
 * cached. A partial search is cached only when a cited source survived.
 * Unavailable and out-of-credits results are not.
 */
export function shouldCacheAnalysis(result: {
  segments: { sources: readonly unknown[] }[];
  meta: { searchStatus: { state: string; reason: string | null } };
}): boolean {
  const { state, reason } = result.meta.searchStatus;
  if (state === "unavailable" || reason === "out_of_credits") return false;
  if (state === "ok") return true;
  return result.segments.some((segment) => segment.sources.length > 0);
}

/** Writes a finished analysis when the search result is safe to replay. */
export function storeAnalysis(
  cache: AnalysisCache,
  input: { url?: string; text?: string },
  language: "en" | "el",
  result: AnalysisResult,
): Promise<void> | undefined {
  if (!shouldCacheAnalysis(result)) return undefined;
  const writes: Promise<void>[] = [];
  if (input.url) {
    writes.push(cache.put(input.url, result, language));
    const canonical = result.article?.sourceUrl;
    if (
      typeof canonical === "string" &&
      canonical.trim().length > 0 &&
      normaliseAnalysisUrl(canonical) !== normaliseAnalysisUrl(input.url)
    ) {
      // Share links use the article URL. A redirect must still hit this report.
      writes.push(cache.put(canonical, result, language));
    }
  } else if (input.text && cache.putText) {
    writes.push(cache.putText(input.text, language, result));
  }
  if (writes.length === 0) return undefined;
  return Promise.all(writes).then(() => undefined);
}

export function normaliseCachedText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "twclid",
  "ttclid",
  "igshid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "srsltid",
  "si",
  "spm",
  "_ga",
  "_gl",
]);

function isTrackingParam(key: string): boolean {
  const name = key.toLowerCase();
  return name.startsWith("utm_") || TRACKING_PARAMS.has(name);
}

/**
 * Stable cache identity for the same article. A clean https URL matches the
 * previous key, so an existing pipeline-version entry still hits. Tracking
 * parameters, a trailing slash, and http are folded onto that key.
 */
export function normaliseAnalysisUrl(pageUrl: string): string {
  try {
    const parsed = new URL(pageUrl.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return pageUrl.trim();
    if (parsed.protocol === "http:") parsed.protocol = "https:";
    if (parsed.port === "80" || parsed.port === "443") parsed.port = "";
    parsed.hash = "";
    parsed.hostname = parsed.hostname.replace(/\.$/, "").toLowerCase();
    if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    const kept = [...parsed.searchParams.entries()]
      .filter(([key]) => !isTrackingParam(key))
      .sort((left, right) => (left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0])));
    parsed.search = "";
    for (const [key, value] of kept) parsed.searchParams.append(key, value);
    let serialized = parsed.toString();
    if (serialized.endsWith("/")) serialized = serialized.slice(0, -1);
    return serialized;
  } catch {
    return pageUrl.trim();
  }
}

export function analysisCacheUrl(pageUrl: string, language = "en"): string {
  const key = `https://cache.aletheia.internal/analysis/v${PIPELINE_VERSION}/${encodeURIComponent(normaliseAnalysisUrl(pageUrl))}`;
  // English keeps the existing key so a pre-warm still hits. Greek is a suffix.
  return language === "el" ? `${key}/el` : key;
}

export async function textAnalysisCacheUrl(text: string, language: string): Promise<string> {
  const lang = language === "el" ? "el" : "en";
  const material = `v${PIPELINE_VERSION}\n${lang}\n${normaliseCachedText(text)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `https://cache.aletheia.internal/analysis/v${PIPELINE_VERSION}/text/${lang}/${hex}`;
}

export function cacheApiAnalysisCache(): AnalysisCache {
  return {
    async get(pageUrl, language = "en") {
      const cache = workerCache();
      if (!cache) return null;
      try {
        const hit = await cache.match(new Request(analysisCacheUrl(pageUrl, language)));
        if (!hit) return null;
        return (await hit.json()) as AnalysisResult;
      } catch {
        return null;
      }
    },
    async put(pageUrl, result, language = "en") {
      const cache = workerCache();
      if (!cache) return;
      await cache.put(
        new Request(analysisCacheUrl(pageUrl, language)),
        new Response(JSON.stringify(result), {
          headers: { "Cache-Control": `public, max-age=${TTL_SECONDS}` },
        }),
      );
    },
    async getText(text, language) {
      const cache = workerCache();
      if (!cache) return null;
      try {
        const hit = await cache.match(new Request(await textAnalysisCacheUrl(text, language)));
        if (!hit) return null;
        return (await hit.json()) as AnalysisResult;
      } catch {
        return null;
      }
    },
    async putText(text, language, result) {
      const cache = workerCache();
      if (!cache) return;
      await cache.put(
        new Request(await textAnalysisCacheUrl(text, language)),
        new Response(JSON.stringify(result), {
          headers: { "Cache-Control": `public, max-age=${TTL_SECONDS}` },
        }),
      );
    },
  };
}

export function workerCache(): ResultCache | null {
  return currentPipelineCache();
}
