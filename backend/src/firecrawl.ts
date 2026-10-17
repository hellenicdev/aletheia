import type { EvidenceItem } from "../../shared/citations";
import { HttpError } from "./errors";
import { LIMITS } from "./limits";
import { assertPublicHttpUrl, isBlockedHost } from "./ssrf";

const FIRECRAWL_API = "https://api.firecrawl.dev";

export async function searchWeb(options: {
  apiKey: string;
  query: string;
  language: "en" | "el" | "other";
  fetchImpl: typeof fetch;
}): Promise<EvidenceItem[]> {
  const query = options.query.trim().slice(0, 240);
  if (!query) return [];

  const payload: Record<string, unknown> = {
    query,
    limit: 5,
    sources: ["web"],
    timeout: 10_000,
    highlights: false,
  };
  if (options.language === "el") payload.country = "GR";

  const response = await options.fetchImpl(`${FIRECRAWL_API}/v2/search`, {
    method: "POST",
    headers: firecrawlHeaders(options.apiKey),
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(failureMessage("search", response.status, text, options.apiKey));
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

  return readHits(parsed)
    .map((hit) => toEvidence(hit))
    .filter((item): item is EvidenceItem => item !== null)
    .slice(0, 4);
}

export interface ScrapedPage {
  title: string | null;
  text: string;
  publishedAt: string | null;
  finalUrl: string;
}

export async function scrapeArticle(options: {
  url: string;
  apiKey: string;
  fetchImpl: typeof fetch;
}): Promise<ScrapedPage> {
  const pageUrl = assertPublicHttpUrl(options.url);
  const response = await options.fetchImpl(`${FIRECRAWL_API}/v2/scrape`, {
    method: "POST",
    headers: firecrawlHeaders(options.apiKey),
    body: JSON.stringify({
      url: pageUrl.toString(),
      formats: ["markdown"],
      onlyMainContent: true,
      timeout: 20_000,
    }),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await response.text();
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
  const article = markdownToText(markdown);
  if (article.length < LIMITS.minArticleChars) {
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

  return {
    title,
    text: article.slice(0, LIMITS.maxArticleChars),
    publishedAt,
    finalUrl,
  };
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
    Authorization: `Bearer ${apiKey}`,
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
  const snippetSource =
    stringValue(hit.description) || stringValue(hit.snippet) || markdownToText(stringValue(hit.markdown));
  return {
    url: hit.url,
    title: (stringValue(hit.title) || hit.url).replace(/\s+/g, " ").trim().slice(0, 180),
    snippet: snippetSource.replace(/\s+/g, " ").trim().slice(0, 400),
  };
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
