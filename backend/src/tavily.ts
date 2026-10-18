import { cleanArticleText } from "../../shared/articleText";
import type { EvidenceItem } from "../../shared/citations";
import { isRecord } from "../../shared/json";
import { BudgetExhausted, isBudgetExhausted } from "./budget";
import { deadlineReached, isDeadline, raceAbort } from "./deadline";
import { UpstreamError, redactSecret } from "./errors";

const TAVILY_API = "https://api.tavily.com";

export interface TavilyGate {
  block: { status: number; detail: string } | null;
}

const searchCache = new Map<string, { at: number; hits: EvidenceItem[] }>();

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
  gate?: TavilyGate;
  bypassCache?: boolean;
}): Promise<EvidenceItem[]> {
  const query = options.query.trim().slice(0, 360);
  if (!query) return [];
  if (options.gate?.block) {
    const block = options.gate.block;
    throw new UpstreamError("tavily", block.status, block.detail);
  }
  const topic = options.topic ?? "general";
  const includeRaw = options.includeRawContent === true;
  const cacheKey = `${topic}:${includeRaw ? "raw" : "snip"}:${query}`;
  if (!options.bypassCache) {
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.hits;
  }

  const payload = {
    query,
    search_depth: "basic",
    topic,
    max_results: Math.min(5, Math.max(1, options.limit ?? 5)),
    include_answer: false,
    include_raw_content: includeRaw,
  };
  const text = await postTavily(
    `${TAVILY_API}/search`,
    payload,
    options.apiKey,
    options.fetchImpl,
    options.timeoutMs ?? 10_000,
    options.signal,
    options.gate,
  );
  const hits = readSearchHits(text, options.apiKey);
  if (!options.bypassCache) searchCache.set(cacheKey, { at: Date.now(), hits });
  return hits;
}

export async function extractTavily(options: {
  apiKey: string;
  url: string;
  fetchImpl: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  gate?: TavilyGate;
}): Promise<{ title: string | null; text: string; finalUrl: string }> {
  if (options.gate?.block) {
    const block = options.gate.block;
    throw new UpstreamError("tavily", block.status, block.detail);
  }
  const text = await postTavily(
    `${TAVILY_API}/extract`,
    { urls: [options.url], extract_depth: "basic" },
    options.apiKey,
    options.fetchImpl,
    options.timeoutMs ?? 20_000,
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
  const articleText = cleanArticleText(withoutTitle).trim() || cleanArticleText(original);
  const finalUrl = typeof first.url === "string" && /^https?:\/\//i.test(first.url) ? first.url : options.url;
  return { title, text: articleText, finalUrl };
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
  const timeoutSignal = AbortSignal.timeout(Math.max(1_000, timeoutMs));
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
  return raceAbort(response.text(), signal);
}

function readSearchHits(text: string, apiKey: string): EvidenceItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new UpstreamError("tavily", 502, "Tavily search returned invalid JSON.");
  }
  if (!isRecord(parsed)) throw new UpstreamError("tavily", 502, "Tavily search did not succeed.");
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const hits: EvidenceItem[] = [];
  for (const item of results) {
    if (!isRecord(item) || typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)) continue;
    const content = cleanText(item.content);
    const raw = cleanText(item.raw_content);
    const snippet = (content.length >= 40 ? content : raw || content).slice(0, 400);
    const published = publishedAt(item.published_date);
    hits.push({
      url: item.url,
      title: (cleanText(item.title) || item.url).slice(0, 180),
      snippet: redactSecret(snippet, apiKey),
      ...(published ? { publishedAt: published } : {}),
    });
  }
  return hits.slice(0, 5);
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
