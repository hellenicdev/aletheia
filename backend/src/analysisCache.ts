import { canonicalUrl } from "../../shared/citations";
import type { AnalysisResult } from "../../shared/types";
import { currentPipelineCache, type ResultCache } from "./persistentCache";
import { PIPELINE_VERSION } from "./version";

const TTL_SECONDS = 24 * 60 * 60;

export interface AnalysisCache {
  get(pageUrl: string): Promise<AnalysisResult | null>;
  put(pageUrl: string, result: AnalysisResult): Promise<void>;
  getText?(text: string, language: string): Promise<AnalysisResult | null>;
  putText?(text: string, language: string, result: AnalysisResult): Promise<void>;
}

export function normaliseCachedText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function analysisCacheUrl(pageUrl: string): string {
  return `https://cache.aletheia.internal/analysis/v${PIPELINE_VERSION}/${encodeURIComponent(canonicalUrl(pageUrl))}`;
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
    async get(pageUrl) {
      const cache = workerCache();
      if (!cache) return null;
      try {
        const hit = await cache.match(new Request(analysisCacheUrl(pageUrl)));
        if (!hit) return null;
        return (await hit.json()) as AnalysisResult;
      } catch {
        return null;
      }
    },
    async put(pageUrl, result) {
      const cache = workerCache();
      if (!cache) return;
      await cache.put(
        new Request(analysisCacheUrl(pageUrl)),
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
