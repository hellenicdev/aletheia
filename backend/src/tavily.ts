import { cleanupArticle } from "../../shared/articleText";
import type { EvidenceItem } from "../../shared/citations";
import { focusPassage, passageAddsFigure, passageMissesFigure } from "../../shared/passages";
import { isRecord } from "../../shared/json";
import { BudgetExhausted, isBudgetExhausted } from "./budget";
import { capOutbound, deadlineReached, fetchSignal, isDeadline, raceAbort, readBody } from "./deadline";
import { PIPELINE_VERSION } from "./version";
import { UpstreamError, redactSecret } from "./errors";

const TAVILY_API = "https://api.tavily.com";

export interface TavilyGate {
  block: { status: number; detail: string } | null;
}

const TAVILY_TTL_MS = 86_400_000;

interface StoredHit {
  url: string;
  title: string;
  content: string;
  raw: string;
  score: number;
  index: number;
  publishedAt?: string;
}

const searchCache = new Map<string, { at: number; hits: StoredHit[] }>();

export function tavilyCacheKey(topic: string, query: string, version = PIPELINE_VERSION): string {
  return `tavily:v${version}:${topic}:${query}`;
}

export function createTavilyGate(): TavilyGate {
  return { block: null };
}

export function clearTavilyCache(): void {
  searchCache.clear();
}

/** 432 and 402 are credit/plan limits. 429 is the rate limit. Stop for this request. */
export function rememberTavilyFailure(
  gate: TavilyGate | undefined,
  status: number,
  detail: string,
): void {
  if (!gate || gate.block) return;
  if (status !== 432 && status !== 402 && status !== 429) return;
  gate.block = { status, detail: detail.replace(/\s+/g, " ").trim().slice(0, 180) };
}

export async function searchTavily(options: {
  apiKey: string;
  query: string;
  fetchImpl: typeof fetch;
  limit?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  topic?: "news" | "general";
  includeRawContent?: boolean;
  /** When set, the first one or two hits keep a longer passage around this claim's figures. */
  claim?: string;
  gate?: TavilyGate;
  bypassCache?: boolean;
  /** Cache API reads and writes count as subrequests. Omit when the budget cannot spare them. */
  charge?: (op: "read" | "write") => boolean;
}): Promise<EvidenceItem[]> {
  const query = options.query.trim().slice(0, 360);
  if (!query) return [];
  if (options.gate?.block) {
    const block = options.gate.block;
    throw new UpstreamError("tavily", block.status, block.detail);
  }
  const topic = options.topic ?? "general";
  const includeRaw = options.includeRawContent === true;
  const cacheKey = tavilyCacheKey(topic, query);
  if (!options.bypassCache) {
    const cached = readMemory(cacheKey);
    if (cached) return expandHits(cached, options.claim, options.apiKey);
    const persisted = await readPersistedHits(cacheKey, options.charge);
    if (persisted) {
      searchCache.set(cacheKey, { at: Date.now(), hits: persisted });
      return expandHits(persisted, options.claim, options.apiKey);
    }
  }

  const limit = Math.min(5, Math.max(1, options.limit ?? 5));
  const payload = {
    query,
    search_depth: "basic",
    topic,
    max_results: limit,
    include_answer: false,
    include_raw_content: includeRaw,
  };
  const text = await postTavily(
    `${TAVILY_API}/search`,
    payload,
    options.apiKey,
    options.fetchImpl,
    capOutbound(options.timeoutMs),
    options.signal,
    options.gate,
  );
  const stored = sortHits(readStoredHits(text)).slice(0, limit);
  if (!options.bypassCache) {
    searchCache.set(cacheKey, { at: Date.now(), hits: stored });
    await writePersistedHits(cacheKey, stored, options.charge);
  }
  return expandHits(stored, options.claim, options.apiKey);
}

export async function extractTavily(options: {
  apiKey: string;
  url: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  gate?: TavilyGate;
}): Promise<{ title: string | null; text: string; finalUrl: string; ignoredLines: number; raw: string }> {
  if (options.gate?.block) {
    const block = options.gate.block;
    throw new UpstreamError("tavily", block.status, block.detail);
  }
  const text = await postTavily(
    `${TAVILY_API}/extract`,
    { urls: [options.url], extract_depth: "basic" },
    options.apiKey,
    options.fetchImpl,
    capOutbound(options.timeoutMs),
    options.signal,
    options.gate,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UpstreamError("tavily", 502, "Tavily extract returned invalid JSON.");
  }
  if (!isRecord(parsed)) throw new UpstreamError("tavily", 502, "Tavily extract returned an unreadable page.");
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const first = results.find((item) => isRecord(item) && typeof item.raw_content === "string");
  if (!isRecord(first) || typeof first.raw_content !== "string") {
    throw new UpstreamError("tavily", 422, "Tavily could not read that page.");
  }
  const original = first.raw_content.replace(/\r\n/g, "\n");
  const title = titleFromExtract(original);
  const withoutTitle = title && original.startsWith(title) ? original.slice(title.length) : original;
  const cleaned = cleanupArticle(withoutTitle);
  const fallback = cleaned.text.trim() ? cleaned : cleanupArticle(original);
  const finalUrl = typeof first.url === "string" && /^https?:\/\//i.test(first.url) ? first.url : options.url;
  return { title, text: fallback.text, finalUrl, ignoredLines: fallback.ignoredLines, raw: original };
}

async function postTavily(
  url: string,
  payload: Record<string, unknown>,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  gate: TavilyGate | undefined,
): Promise<string> {
  if (signal?.aborted) throw deadlineReached();
  const timeoutSignal = fetchSignal(timeoutMs);
  let response: Response;
  try {
    response = await raceAbort(
      fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: timeoutSignal,
      }),
      signal,
    );
  } catch (error) {
    if (isDeadline(error) || isBudgetExhausted(error)) throw error;
    if (error instanceof BudgetExhausted) throw error;
    const failure = new UpstreamError(
      "tavily",
      null,
      redactSecret(error instanceof Error ? error.message : "request failed", apiKey),
    );
    console.error(failure.message);
    throw failure;
  }
  if (!response.ok) {
    const body = await readFailureBody(response, signal);
    const detail = redactSecret(errorDetail(body) || body, apiKey);
    rememberTavilyFailure(gate, response.status, detail);
    const failure = new UpstreamError("tavily", response.status, detail);
    console.error(failure.message);
    throw failure;
  }
  return readBody(response, signal, timeoutMs);
}

function readStoredHits(text: string): StoredHit[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UpstreamError("tavily", 502, "Tavily search returned invalid JSON.");
  }
  if (!isRecord(parsed)) throw new UpstreamError("tavily", 502, "Tavily search did not succeed.");
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const hits: StoredHit[] = [];
  results.forEach((item, index) => {
    if (!isRecord(item) || typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)) return;
    const published = publishedAt(item.published_date);
    hits.push({
      url: item.url,
      title: (cleanText(item.title) || item.url).slice(0, 180),
      content: cleanText(item.content),
      raw: cleanText(item.raw_content),
      score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : 0,
      index,
      ...(published ? { publishedAt: published } : {}),
    });
  });
  return hits;
}

/** Higher score first, then URL, then the provider's original position. */
export function sortHits(items: StoredHit[]): StoredHit[] {
  return [...items].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (a.url !== b.url) return a.url < b.url ? -1 : 1;
    return a.index - b.index;
  });
}

function expandHits(items: StoredHit[], claim: string | undefined, apiKey: string): EvidenceItem[] {
  const hits: EvidenceItem[] = [];
  let expanded = 0;
  for (const item of items) {
    const shortSource = item.content.length >= 40 ? item.content : item.raw || item.content;
    let snippet = shortSource.slice(0, 400);
    if (claim && expanded < 2 && passageMissesFigure(claim, snippet)) {
      const focused = focusPassage(claim, item.raw.length > snippet.length ? item.raw : shortSource);
      if (focused && passageAddsFigure(claim, snippet, focused)) {
        snippet = focused.slice(0, 1500);
        expanded += 1;
      }
    }
    hits.push({
      url: item.url,
      title: item.title,
      snippet: snippet.replaceAll(apiKey, "[redacted]"),
      ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
    });
  }
  return hits;
}

function readMemory(key: string): StoredHit[] | null {
  const cached = searchCache.get(key);
  if (!cached || Date.now() - cached.at >= TAVILY_TTL_MS) return null;
  return cached.hits;
}

async function readPersistedHits(
  key: string,
  charge?: (op: "read" | "write") => boolean,
): Promise<StoredHit[] | null> {
  const cache = resultCache();
  if (!cache || !charge) return null;
  if (!charge("read")) return null;
  try {
    const hit = await cache.match(await cacheRequest(key));
    if (!hit) return null;
    const parsed = (await hit.json()) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.filter(isStoredHit);
  } catch {
    return null;
  }
}

async function writePersistedHits(
  key: string,
  hits: StoredHit[],
  charge?: (op: "read" | "write") => boolean,
): Promise<void> {
  const cache = resultCache();
  if (!cache || !charge) return;
  if (!charge("write")) return;
  try {
    await cache.put(
      await cacheRequest(key),
      new Response(JSON.stringify(hits), {
        headers: {
          "Cache-Control": "public, max-age=86400",
          "Content-Type": "application/json",
        },
      }),
    );
  } catch {
    /* The Cache API is best-effort and is absent outside the worker. */
  }
}

function isStoredHit(value: unknown): value is StoredHit {
  if (!isRecord(value) || typeof value.url !== "string" || typeof value.title !== "string") return false;
  return typeof value.content === "string" && typeof value.raw === "string";
}

interface ResultCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

function resultCache(): ResultCache | null {
  const host = globalThis as unknown as { caches?: { default?: ResultCache } };
  return host.caches?.default ?? null;
}

async function cacheRequest(key: string): Promise<Request> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request(`https://cache.aletheia.internal/v1/${hex}`);
}

function titleFromExtract(text: string): string | null {
  const heading = text.match(/^#{1,2}\s+(.+)$/m);
  if (heading) return heading[1].replace(/[*_`]/g, "").trim().slice(0, 180) || null;
  const line = text.split("\n").map((part) => part.trim()).find(Boolean);
  if (line && line.length <= 140 && line.length < Math.max(40, text.length * 0.5)) return line.slice(0, 180);
  return null;
}

function publishedAt(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!isRecord(parsed)) return "";
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.detail === "string") return parsed.detail;
    if (isRecord(parsed.detail) && typeof parsed.detail.error === "string") return parsed.detail.error;
  } catch {
    /* The body was not JSON. */
  }
  return "";
}

async function readFailureBody(response: Response, signal?: AbortSignal): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      void response.body?.cancel().catch(() => undefined);
      resolve("");
    }, 300);
  });
  try {
    return await raceAbort(Promise.race([response.text().catch(() => ""), capped]), signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
