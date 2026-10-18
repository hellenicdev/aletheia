/**
 * Shared cache for analysis results, scrapes, searches, and verdicts.
 * The Workers Cache API is a no-op on *.workers.dev, so production uses a
 * Durable Object. Tests leave this unset and keep the in-isolate maps.
 */
export interface ResultCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

let bound: ResultCache | null = null;

export function bindPipelineCache(cache: ResultCache | null): void {
  bound = cache;
}

export function currentPipelineCache(): ResultCache | null {
  return bound;
}

export async function cacheStorageKey(request: Request): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(request.url));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function durableResultCache(namespace: DurableObjectNamespace): ResultCache {
  const stub = namespace.get(namespace.idFromName("global"));
  return {
    async match(request) {
      const key = await cacheStorageKey(request);
      const response = await stub.fetch(`https://pipeline-cache.internal/get?key=${key}`);
      if (response.status === 404) return undefined;
      if (!response.ok) return undefined;
      return response;
    },
    async put(request, response) {
      const key = await cacheStorageKey(request);
      const body = await response.text();
      const ttlHeader = response.headers.get("cache-control") ?? "";
      const match = /max-age=(\d+)/.exec(ttlHeader);
      const ttl = match ? Number(match[1]) : 86_400;
      const saved = await stub.fetch("https://pipeline-cache.internal/put", {
        method: "POST",
        body: JSON.stringify({ key, body, ttl }),
      });
      if (!saved.ok) throw new Error("The pipeline cache could not be saved.");
    },
  };
}
