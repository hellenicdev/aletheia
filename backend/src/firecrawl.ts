import { cleanupArticle } from "../../shared/articleText";
import type { EvidenceItem } from "../../shared/citations";
import { focusPassage, passageAddsFigure, passageMissesFigure } from "../../shared/passages";
import { queryCacheKey } from "../../shared/query";
import { BudgetExhausted, isBudgetExhausted } from "./budget";
import { capOutbound, combineSignals, deadlineReached, fetchSignal, isDeadline, raceAbort, readBody } from "./deadline";
import { currentPipelineCache, type ResultCache } from "./persistentCache";
import { PIPELINE_VERSION } from "./version";
import { HttpError, UpstreamError, redactSecret } from "./errors";
import { logEvent } from "./log";
import { LIMITS } from "./limits";
import { assertPublicHttpUrl, isBlockedHost } from "./ssrf";
import { clearTavilyCache } from "./tavily";
import { acquireOutbound, resetOutboundBudget } from "./throttle";

const FIRECRAWL_API = "https://api.firecrawl.dev";
const CACHE_TTL_SECONDS = 86_400;
const searchCache = new Map<string, { at: number; hits: EvidenceItem[] }>();
const scrapeCache = new Map<string, { at: number; page: ScrapedPage }>();
const verifyCache = new Map<string, { at: number; verdict: CachedVerdict }>();
const queryMemory = new Map<string, { at: number; query: string }>();
let queue: Promise<void> = Promise.resolve();

/** Request-scoped note that Firecrawl rejected the call, so later searches do not wait. */
export interface ProviderGate {
  block: { status: number; detail: string } | null;
}

export function createProviderGate(): ProviderGate {
  return { block: null };
}

export function rememberProviderFailure(
  gate: ProviderGate | undefined,
  status: number,
  detail: string,
): void {
  if (!gate || gate.block) return;
  if (!(status === 402 || status === 401 || status === 403 || status === 429 || status >= 500)) return;
  const clean = detail.replace(/\s+/g, " ").trim().slice(0, 180);
  gate.block = {
    status,
    detail: status === 402 ? clean || "Insufficient credits" : clean,
  };
}

export interface CachedVerdict {
  label: string;
  confidence: number;
  explanation: string;
  sourceUrls: string[];
  /** Verifier relevance flags from the run that stored this verdict. */
  relevance?: Record<string, boolean>;
}

export function clearSearchCache(): void {
  searchCache.clear();
  scrapeCache.clear();
  verifyCache.clear();
  queryMemory.clear();
  clearTavilyCache();
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
  const timeout = fetchSignal(timeoutMs);
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

export type CacheCharge = (op: "read" | "write") => boolean;

export function cacheCountsAsSubrequest(): boolean {
  return currentPipelineCache() !== null;
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
  charge?: CacheCharge;
  gate?: ProviderGate;
  /** When set, the first one or two hits keep a longer passage around this claim's figures. */
  claim?: string;
  /** Health checks must hit Firecrawl. A cached hit is not evidence the provider is up. */
  bypassCache?: boolean;
}): Promise<EvidenceItem[]> {
  const query = options.query.trim().slice(0, 240);
  if (!query) return [];
  const cacheKey = searchCacheKey(options.language, query, options.claim ?? "");
  if (!options.bypassCache) {
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.hits;
    const persisted = await readPersisted<EvidenceItem[]>(cacheKey, options.charge);
    if (persisted) {
      searchCache.set(cacheKey, { at: Date.now(), hits: persisted });
      return persisted;
    }
  }
  if (options.gate?.block) {
    const block = options.gate.block;
    throw new UpstreamError("search", block.status, block.detail);
  }

  const timeoutMs = capOutbound(options.timeoutMs);
  const payload: Record<string, unknown> = {
    query,
    limit: options.limit ?? 5,
    sources: ["web"],
    timeout: timeoutMs,
    // Highlights replace the site's meta description with a passage about the
    // query. They are included in the search price. Leaving them off fed the
    // verifier taglines, so a checkable claim came back unverifiable even when
    // a page stated the fact. Do not add scrapeOptions: that bills a scrape
    // for every result on top of the search.
    highlights: true,
  };
  if (options.language === "el") payload.country = "GR";

  if (options.canSpend && !options.canSpend()) {
    throw new BudgetExhausted();
  }
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
  const text = response.ok
    ? await readBody(response, signal, capOutbound(options.timeoutMs))
    : await readFailureBody(response, signal);
  if (!response.ok) {
    rememberProviderFailure(options.gate, response.status, text);
    const detail = options.gate?.block?.detail || text;
    const failure = new UpstreamError("search", response.status, redactSecret(detail, options.apiKey));
    logEvent("search_failed", { provider: "firecrawl", status: response.status });
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

  const expand = { used: 0 };
  const hits = readHits(parsed)
    .map((hit) => toEvidence(hit, options.claim, expand))
    .filter((item): item is EvidenceItem => item !== null)
    .slice(0, 4);
  if (!options.bypassCache) {
    searchCache.set(cacheKey, { at: Date.now(), hits });
    await writePersisted(cacheKey, hits, options.charge);
  }
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
      throw new BudgetExhausted();
    }
    try {
      const timeoutSignal = fetchSignal(timeoutMs);
      const response = await raceAbort(
        fetchImpl(url, {
          method: "POST",
          headers: firecrawlHeaders(apiKey.trim()),
          body: JSON.stringify(payload),
          signal: timeoutSignal,
        }),
        signal,
      );
      if (response.status === 429 && attempt < 1) {
        const wait = retryAfterMs(response, retryDelayMs);
        await raceAbort(response.text().catch(() => ""), signal);
        await pause(testsSkipWait() ? 0 : wait, signal);
        continue;
      }
      return response;
    } catch (error) {
      lastError = error;
      if (isDeadline(error) || isBudgetExhausted(error)) throw error;
      break;
    }
  }
  if (lastError instanceof Error && /subrequest limit/.test(lastError.message)) throw lastError;
  const failure = new UpstreamError(
    "search",
    null,
    redactSecret(lastError instanceof Error ? lastError.message : "request failed", apiKey),
  );
  logEvent("search_failed", { provider: "firecrawl", status: 0 });
  throw failure;
}

export interface ScrapedPage {
  title: string | null;
  text: string;
  publishedAt: string | null;
  byline: string | null;
  siteName: string | null;
  finalUrl: string;
  rawHtml: string | null;
  ignoredLines: number;
}

export async function scrapeArticle(options: {
  url: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
  canSpend?: () => boolean;
  charge?: CacheCharge;
  gate?: ProviderGate;
}): Promise<ScrapedPage> {
  const pageUrl = assertPublicHttpUrl(options.url);
  const cacheKey = scrapeCacheKey(pageUrl.toString());
  const memo = scrapeCache.get(cacheKey);
  if (memo && Date.now() - memo.at < 10 * 60_000) return memo.page;
  const persisted = await readPersisted<ScrapedPage>(cacheKey, options.charge);
  if (persisted && persisted.text) {
    const page = {
      ...persisted,
      byline: persisted.byline ?? null,
      siteName: persisted.siteName ?? null,
      ignoredLines: persisted.ignoredLines ?? 0,
    };
    scrapeCache.set(cacheKey, { at: Date.now(), page });
    return page;
  }
  const timeoutMs = capOutbound(options.timeoutMs);
  const signal = operationSignal(timeoutMs, options.signal);
  const response = await enqueue(async () => {
    await acquireOutbound(pause, signal);
    return firecrawlPost(
      `${FIRECRAWL_API}/v2/scrape`,
      {
        url: pageUrl.toString(),
        formats: ["markdown", "html"],
        onlyMainContent: true,
        excludeTags: [
          "nav",
          "header",
          "footer",
          "aside",
          "form",
          "script",
          "style",
          "noscript",
          ".related",
          ".related-stories",
          ".related-content",
          ".most-read",
          ".most-popular",
          ".top-stories",
          ".recommendations",
          ".recirc",
          ".newsletter",
          ".app-promo",
        ],
        timeout: timeoutMs,
      },
      options.apiKey,
      options.fetchImpl,
      timeoutMs,
      500,
      options.canSpend,
      signal,
    );
  }, signal);
  const text = response.ok
    ? await readBody(response, signal, capOutbound(options.timeoutMs))
    : await readFailureBody(response, signal);
  if (!response.ok) {
    rememberProviderFailure(options.gate, response.status, text);
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
  const cleaned = cleanupArticle(markdownToText(markdown));
  const article = cleaned.text;
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
    byline: metaString(metadata, ["author", "article:author", "og:author"]),
    siteName: metaString(metadata, ["og:site_name", "ogSiteName", "siteName", "site_name"]),
    finalUrl,
    rawHtml: html,
    ignoredLines: cleaned.ignoredLines,
  };
  scrapeCache.set(cacheKey, { at: Date.now(), page });
  await writePersisted(cacheKey, page, options.charge);
  return page;
}

function resultCache(): ResultCache | null {
  return currentPipelineCache();
}

async function cacheRequest(key: string): Promise<Request> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return new Request(`https://cache.aletheia.internal/v1/${hex}`);
}

async function readPersisted<T>(key: string, charge?: CacheCharge): Promise<T | null> {
  const cache = resultCache();
  if (!cache) return null;
  if (charge && !charge("read")) return null;
  try {
    const hit = await cache.match(await cacheRequest(key));
    if (!hit) return null;
    return (await hit.json()) as T;
  } catch {
    return null;
  }
}

export { PIPELINE_VERSION };

/** The scrape cache includes the pipeline version so an extraction change is not served stale. */
export function scrapeCacheKey(url: string): string {
  return `scrape:v${PIPELINE_VERSION}:${url}`;
}

/**
 * Search hits are cached with the pipeline version. A pass that stored meta
 * descriptions must not be reused after retrieval starts keeping the passage.
 */
export function searchCacheKey(language: string, query: string, claim = ""): string {
  const claimKey = claim.replace(/\s+/g, " ").trim().slice(0, 180);
  const base = `search:v${PIPELINE_VERSION}:${language}:${query}`;
  return claimKey ? `${base}:${claimKey}` : base;
}

export function peekQuery(claim: string): string | null {
  const hit = queryMemory.get(queryCacheKey(claim, PIPELINE_VERSION));
  if (!hit || Date.now() - hit.at > CACHE_TTL_SECONDS * 1000) return null;
  return hit.query;
}

export async function readCachedQuery(claim: string, charge?: CacheCharge): Promise<string | null> {
  const memo = peekQuery(claim);
  if (memo) return memo;
  const key = queryCacheKey(claim, PIPELINE_VERSION);
  const persisted = await readPersisted<{ query: string }>(key, charge);
  if (!persisted || typeof persisted.query !== "string") return null;
  const query = persisted.query.replace(/\s+/g, " ").trim();
  if (!query) return null;
  queryMemory.set(key, { at: Date.now(), query });
  return query;
}

export async function writeCachedQuery(claim: string, query: string, charge?: CacheCharge): Promise<void> {
  const clean = query.replace(/\s+/g, " ").trim();
  if (!clean) return;
  const key = queryCacheKey(claim, PIPELINE_VERSION);
  queryMemory.set(key, { at: Date.now(), query: clean });
  await writePersisted(key, { query: clean }, charge);
}

export function verificationCacheKey(claim: string, urls: string[], language: string): string {
  const list = [...urls]
    .map((url) => url.trim())
    .filter(Boolean)
    .sort();
  return `verify:v${PIPELINE_VERSION}:${language}:${claim.replace(/\s+/g, " ").trim()}\n${list.join("\n")}`;
}

export async function readVerification(key: string, charge?: CacheCharge): Promise<CachedVerdict | null> {
  const memo = verifyCache.get(key);
  if (memo && Date.now() - memo.at < CACHE_TTL_SECONDS * 1000) return memo.verdict;
  const persisted = await readPersisted<CachedVerdict>(key, charge);
  if (!persisted || typeof persisted.label !== "string") return null;
  verifyCache.set(key, { at: Date.now(), verdict: persisted });
  return persisted;
}

export async function writeVerification(
  key: string,
  verdict: CachedVerdict,
  charge?: CacheCharge,
): Promise<void> {
  verifyCache.set(key, { at: Date.now(), verdict });
  await writePersisted(key, verdict, charge);
}

async function writePersisted(key: string, value: unknown, charge?: CacheCharge): Promise<void> {
  const cache = resultCache();
  if (!cache) return;
  if (charge && !charge("write")) return;
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

/** A rejected response body must not hold the request. Status is already known. */
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

function toEvidence(hit: Hit, claim?: string, expand?: { used: number }): EvidenceItem | null {
  if (typeof hit.url !== "string" || !/^https?:\/\//i.test(hit.url)) return null;
  const markdown = markdownToText(stringValue(hit.markdown));
  const description = markdownToText(stringValue(hit.description));
  const snippetField = markdownToText(stringValue(hit.snippet));
  const passage = choosePassage([description, snippetField, markdown], claim);
  const byline = apByline(markdown) || apByline(description) || apByline(stringValue(hit.title));
  const credit = byline && !apByline(passage) ? byline : "";
  const full = passage.replace(/\s+/g, " ").trim();
  let body = full.slice(0, 400);
  if (claim && expand && expand.used < 2 && passageMissesFigure(claim, body)) {
    const focused = focusPassage(claim, full);
    if (focused && passageAddsFigure(claim, body, focused)) {
      body = focused.slice(0, credit ? 1400 : 1500);
      expand.used += 1;
    }
  }
  const snippet = [body, credit].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 1500);
  return {
    url: hit.url,
    title: (stringValue(hit.title) || hit.url).replace(/\s+/g, " ").trim().slice(0, 180),
    snippet,
  };
}

/**
 * Web highlights arrive in description and news highlights in snippet.
 * Prefer a passage that actually states the claim's figures. A scraped page
 * is only the fallback when the highlight does not.
 */
function choosePassage(candidates: string[], claim?: string): string {
  const texts = candidates.map((text) => text.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (texts.length === 0) return "";
  if (claim) {
    const stated = texts.find((text) => !passageMissesFigure(claim, text));
    if (stated) return stated;
  }
  return texts.reduce((best, text) => (text.length > best.length ? text : best));
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
