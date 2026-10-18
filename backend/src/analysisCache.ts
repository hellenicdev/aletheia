import { canonicalUrl } from "../../shared/citations";
import type { AnalysisResult } from "../../shared/types";
import { PIPELINE_VERSION } from "./version";

const TTL_SECONDS = 24 * 60 * 60;

export interface AnalysisCache {
  get(pageUrl: string): Promise<AnalysisResult | null>;
  put(pageUrl: string, result: AnalysisResult): Promise<void>;
}

export function analysisCacheUrl(pageUrl: string): string {
  return `https://cache.aletheia.internal/analysis/v${PIPELINE_VERSION}/${encodeURIComponent(canonicalUrl(pageUrl))}`;
}

export function cacheApiAnalysisCache(): AnalysisCache {
  return {
    async get(pageUrl) {
      const cache = defaultCache();
      if (!cache) return null;
      const hit = await cache.match(new Request(analysisCacheUrl(pageUrl)));
      if (!hit) return null;
      try {
        return (await hit.json()) as AnalysisResult;
      } catch {
        return null;
      }
    },
    async put(pageUrl, result) {
      const cache = defaultCache();
      if (!cache) return;
      await cache.put(
        new Request(analysisCacheUrl(pageUrl)),
        new Response(JSON.stringify(result), {
          headers: { "Cache-Control": `public, max-age=${TTL_SECONDS}` },
        }),
      );
    },
  };
}

interface ResultCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function defaultCache(): ResultCache | null {
  const host = globalThis as unknown as { caches?: { default?: ResultCache } };
  return host.caches?.default ?? null;
}
