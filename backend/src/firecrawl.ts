import { cleanArticleText } from "../../shared/articleText";
import type { EvidenceItem } from "../../shared/citations";
import { combineSignals, deadlineReached, isDeadline, raceAbort } from "./deadline";
import { HttpError, UpstreamError, redactSecret } from "./errors";
import { LIMITS } from "./limits";
import { assertPublicHttpUrl, isBlockedHost } from "./ssrf";
import { acquireOutbound, resetOutboundBudget } from "./throttle";

const FIRECRAWL_API = "https://api.firecrawl.dev";
const CACHE_TTL_SECONDS = 86_400;
const searchCache = new Map<string, { at: number; hits: EvidenceItem[] }>();
const scrapeCache = new Map<string, { at: number; page: ScrapedPage }>();
const verifyCache = new Map<string, { at: number; verdict: CachedVerdict }>();
let queue: Promise<void> = Promise.resolve();

export interface CachedVerdict {
  label: string;
  confidence: number;
  explanation: string;
  sourceUrls: string[];
}

export function clearSearchCache(): void {
  searchCache.clear();
  scrapeCache.clear();
  verifyCache.clear();
  resetOutboundBudget();
}

/**
 * One Firecrawl call at a time. The slot is released when the job finishes or
 * when `signal` aborts, so a fetch that never resolves cannot pin later calls.
 */
function enqueue<T>(job: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = queue;
  let release: () => void = () => {};
  const slot = new Promise<void>((resolve) => {
    release = resolve;
  });
  queue = slot;
  return (async () => {
    try {
      await raceAbort(previous, signal);
      if (signal?.aborted) throw deadlineReached();
      return await raceAbort(job(), signal);
    } finally {
      release();
    }
  })();
}

async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw deadlineReached();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await raceAbort(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
      signal,
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function operationSignal(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1_000, timeoutMs));
  if (!parent) return timeout;
  return combineSignals([timeout, parent]);
}

function testsSkipWait(): boolean {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
  return env?.VITEST === "true";
}

/** Honour Retry-After, but never sleep so long that the analysis deadline is lost. */
function retryAfterMs(response: Response, fallback: number): number {
  const header = response.headers.get("retry-after");
  const cap = 8_000;
  if (!header) return Math.min(cap, Math.max(0, fallback));
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(cap, Math.max(0, Math.round(seconds * 1000)));
  const when = Date.parse(header);
  if (Number.isFinite(when)) return Math.min(cap, Math.max(0, when - Date.now()));
  return Math.min(cap, Math.max(0, fallback));
}

export async function searchWeb(options: {
  apiKey: string;
  query: string;
  language: "en" | "el" | "other";
  fetchImpl: typeof fetch;
  limit?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  canSpend?: () => boolean;
  signal?: AbortSignal;
}): Promise<EvidenceItem[]> {
  const query = options.query.trim().slice(0, 240);
  if (!query) return [];
  const cacheKey = `${options.language}:${query}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 10 * 60_000) return cached.hits;
  const persisted = await readPersisted<EvidenceItem[]>(`search:${cacheKey}`);
  if (persisted) {
    searchCache.set(cacheKey, { at: Date.now(), hits: persisted });
    return persisted;
  }

  const payload: Record<string, unknown> = {
    query,
    limit: options.limit ?? 5,
    sources: ["web"],
    timeout: 10_000,
    highlights: false,
  };
  if (options.language === "el") payload.country = "GR";

  if (options.canSpend && !options.canSpend()) {
    throw new Error("search skipped to stay within the worker subrequest limit");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  const signal = operationSignal(timeoutMs, options.signal);
  const response = await enqueue(async () => {
    await acquireOutbound(pause, signal);
    return firecrawlPost(
      `${FIRECRAWL_API}/v2/search`,
      payload,
      options.apiKey,
      options.fetchImpl,
      timeoutMs,
      options.retryDelayMs ?? 500,
      options.canSpend,
      signal,
    );
  }, signal);
  const text = await raceAbort(response.text(), signal);
  if (!response.ok) {
    const failure = new UpstreamError("search", response.status, redactSecret(text, options.apiKey));
    console.error(failure.message);
    throw failure;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Firecrawl search returned invalid JSON.");
  }
  if (!isRecord(parsed) || parsed.success === false) {
    throw new Error("Firecrawl search did not succeed.");
  }

  const hits = readHits(parsed)
    .map((hit) => toEvidence(hit))
    .filter((item): item is EvidenceItem => item !== null)
    .slice(0, 4);
  searchCache.set(cacheKey, { at: Date.now(), hits });
  await writePersisted(`search:${cacheKey}`, hits);
  return hits;
}

async function firecrawlPost(
  url: string,
  payload: Record<string, unknown>,
  apiKey: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  retryDelayMs: number,
  canSpend?: () => boolean,
  signal?: AbortSignal,
): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) throw deadlineReached();
    if (attempt > 0 && canSpend && !canSpend()) {
      throw new Error("search skipped to stay within the worker subrequest limit");
    }
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: firecrawlHeaders(apiKey.trim()),
        body: JSON.stringify(payload),
        signal,
      });
      if (response.status === 429 && attempt < 1) {
        const wait = retryAfterMs(response, retryDelayMs);
        await raceAbort(response.text().catch(() => ""), signal);
        await pause(testsSkipWait() ? 0 : wait, signal);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (isDeadline(error)) throw error;
      break;
    }
  }
  if (lastError instanceof Error && /subrequest limit/.test(lastError.message)) throw lastError;
  const failure = new UpstreamError(
    "search",
    null,
    redactSecret(lastError instanceof Error ? lastError.message : "request failed", apiKey),
  );
  console.error(failure.message);
  throw failure;
}

export interface ScrapedPage {
  title: string | null;
  text: string;
  publishedAt: string | null;
  finalUrl: string;
  rawHtml: string | null;
}

export async function scrapeArticle(options: {
  url: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<ScrapedPage> {
  const pageUrl = assertPublicHttpUrl(options.url);
  const cacheKey = pageUrl.toString();
  const memo = scrapeCache.get(cacheKey);
  if (memo && Date.now() - memo.at < 10 * 60_000) return memo.page;
  const persisted = await readPersisted<ScrapedPage>(`scrape:${cacheKey}`);
  if (persisted && persisted.text) {
    scrapeCache.set(cacheKey, { at: Date.now(), page: persisted });
    return persisted;
  }
  const timeoutMs = options.timeoutMs ?? 20_000;
  const signal = operationSignal(timeoutMs, options.signal);
  const response = await enqueue(async () => {
    await acquireOutbound(pause, signal);
    return firecrawlPost(
      `${FIRECRAWL_API}/v2/scrape`,
      {
        url: pageUrl.toString(),
        formats: ["markdown", "html"],
        onlyMainContent: true,
        excludeTags: ["nav", "header", "footer", "aside", "form", "script", "style", "noscript"],
        timeout: timeoutMs,
      },
      options.apiKey,
      options.fetchImpl,
      timeoutMs,
      500,
      undefined,
      signal,
    );
  }, signal);
  const text = await raceAbort(response.text(), signal);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(502, "The Firecrawl API key was rejected.");
    }
    throw new HttpError(422, failureMessage("scrape", response.status, text, options.apiKey));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(422, "Firecrawl returned an unreadable page.");
  }
  if (!isRecord(parsed) || parsed.success === false || !isRecord(parsed.data)) {
    throw new HttpError(422, "Firecrawl could not read that page. Paste the text instead.");
  }

  const data = parsed.data;
  const markdown = typeof data.markdown === "string" ? data.markdown : "";
  const metadata = isRecord(data.metadata) ? data.metadata : {};
  const html = typeof data.html === "string" ? data.html : null;
  const article = cleanArticleText(markdownToText(markdown));
  if (article.length < LIMITS.minArticleChars && !html) {
    throw new HttpError(
      422,
      "Could not find enough article text on that page. Paste the text instead.",
    );
  }

  const title =
    metaString(metadata, ["title", "og:title", "ogTitle"]) || headingFromMarkdown(markdown);
  const publishedAt = normalizeDate(
    metaString(metadata, [
      "publishedTime",
      "article:published_time",
      "article:publishedTime",
      "datePublished",
      "publishedDate",
    ]),
  );
  const finalUrl = publicPageUrl(
    metaString(metadata, ["sourceURL", "sourceUrl", "url"]) || pageUrl.toString(),
    pageUrl.toString(),
  );

  const page: ScrapedPage = {
    title,
    text: article.slice(0, LIMITS.maxArticleChars),
    publishedAt,
    finalUrl,
    rawHtml: html,
  };
  scrapeCache.set(cacheKey, { at: Date.now(), page });
  await writePersisted(`scrape:${cacheKey}`, page);
  return page;
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

async function readPersisted<T>(key: string): Promise<T | null> {
  const cache = resultCache();
  if (!cache) return null;
  try {
    const hit = await cache.match(await cacheRequest(key));
    if (!hit) return null;
    return (await hit.json()) as T;
  } catch {
    return null;
  }
}

export function verificationCacheKey(claim: string, urls: string[], language: string): string {
  const list = [...urls]
    .map((url) => url.trim())
    .filter(Boolean)
    .sort();
  return `verify:${language}:${claim.replace(/\s+/g, " ").trim()}\n${list.join("\n")}`;
}

export async function readVerification(key: string): Promise<CachedVerdict | null> {
  const memo = verifyCache.get(key);
  if (memo && Date.now() - memo.at < CACHE_TTL_SECONDS * 1000) return memo.verdict;
  const persisted = await readPersisted<CachedVerdict>(key);
  if (!persisted || typeof persisted.label !== "string") return null;
  verifyCache.set(key, { at: Date.now(), verdict: persisted });
  return persisted;
}

export async function writeVerification(key: string, verdict: CachedVerdict): Promise<void> {
  verifyCache.set(key, { at: Date.now(), verdict });
  await writePersisted(key, verdict);
}

async function writePersisted(key: string, value: unknown): Promise<void> {
  const cache = resultCache();
  if (!cache) return;
  try {
    await cache.put(
      await cacheRequest(key),
      new Response(JSON.stringify(value), {
        headers: {
          "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
          "Content-Type": "application/json",
        },
      }),
    );
  } catch {
    /* The Cache API is best-effort and is absent outside the worker. */
  }
}

export function markdownToText(markdown: string): string {
  let text = markdown.replace(/\r\n/g, "\n");
  text = text.replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""));
  text = text.replace(/!\[[^\]]*]\([^)]*\)/g, "");
  text = text.replace(/\[([^\]]+)]\([^)]*\)/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s{0,3}>\s?/gm, "");
  text = text.replace(/(\*\*|__)(.*?)\1/g, "$2");
  text = text.replace(/(^|[\s(])[*_]([^*_\n]+)[*_]/g, "$1$2");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  text = text.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function firecrawlHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey.trim()}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function failureMessage(action: string, status: number, body: string, apiKey: string): string {
  const safe = body.replaceAll(apiKey, "[redacted]").slice(0, 160);
  if (status === 401 || status === 403) return `Firecrawl ${action} rejected the API key.`;
  if (/timeout/i.test(safe)) return `Firecrawl ${action} timed out.`;
  return `Firecrawl ${action} failed (${status}).`;
}

interface Hit {
  url?: unknown;
  title?: unknown;
  description?: unknown;
  snippet?: unknown;
  markdown?: unknown;
}

function readHits(payload: Record<string, unknown>): Hit[] {
  const data = payload.data;
  if (Array.isArray(data)) return data as Hit[];
  if (isRecord(data) && Array.isArray(data.web)) return data.web as Hit[];
  return [];
}

function toEvidence(hit: Hit): EvidenceItem | null {
  if (typeof hit.url !== "string" || !/^https?:\/\//i.test(hit.url)) return null;
  const markdown = markdownToText(stringValue(hit.markdown));
  const snippetSource =
    stringValue(hit.description) || stringValue(hit.snippet) || markdown;
  const byline = apByline(markdown) || apByline(stringValue(hit.title));
  const snippet = [snippetSource, byline && !apByline(snippetSource) ? byline : ""]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  return {
    url: hit.url,
    title: (stringValue(hit.title) || hit.url).replace(/\s+/g, " ").trim().slice(0, 180),
    snippet,
  };
}

/** Keep an Associated Press credit that arrived only in markdown, so a reprint is not scored as a second source. */
function apByline(text: string): string {
  const match = text.match(/.{0,60}\bassociated press\b.{0,40}|.{0,40}\(\s*ap\s*\).{0,40}/i);
  return match ? match[0].replace(/\s+/g, " ").trim() : "";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function metaString(metadata: Record<string, unknown>, keys: string[]): string | null {
  const lowered = new Map(
    Object.entries(metadata).map(([key, value]) => [key.toLowerCase(), value]),
  );
  for (const key of keys) {
    const value = lowered.get(key.toLowerCase());
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function headingFromMarkdown(markdown: string): string | null {
  const match = markdown.match(/^#{1,2}\s+(.+)$/m);
  if (!match) return null;
  const title = match[1].replace(/[*_`]/g, "").trim();
  return title.slice(0, 180) || null;
}

function publicPageUrl(candidate: string, fallback: string): string {
  try {
    const url = new URL(candidate);
    if ((url.protocol === "http:" || url.protocol === "https:") && !isBlockedHost(url.hostname)) {
      return url.toString();
    }
  } catch {
    /* Keep the URL we already checked. */
  }
  return fallback;
}

function normalizeDate(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
