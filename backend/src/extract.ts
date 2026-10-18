import { cleanArticleText, proseScore } from "../../shared/articleText";
import { looksLikeOpinionSection, opinionCueFromHtml } from "../../shared/classify";
import type { UiLanguage } from "../../shared/labels";
import { pageUnreadMessage } from "../../shared/messages";
import { isBudgetExhausted } from "./budget";
import { isDeadline, raceAbort } from "./deadline";
import { scrapeArticle, type CacheCharge, type ProviderGate } from "./firecrawl";
import { LIMITS } from "./limits";
import { HttpError } from "./errors";
import { assertPublicHttpUrl } from "./ssrf";

const PAGE_TIMEOUT_MS = 10_000;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface ExtractedArticle {
  title: string | null;
  text: string;
  publishedAt: string | null;
  /** Author or byline when the page states one. */
  byline: string | null;
  /** Publisher name from og:site_name when present. */
  siteName: string | null;
  finalUrl: string;
  via: "firecrawl" | "local" | "direct";
  fromPreferred?: boolean;
  opinionSection?: boolean;
}

const SKIP_TAGS = new Set([
  "script",
  "style",
  "noscript",
  "svg",
  "iframe",
  "canvas",
  "template",
  "nav",
  "header",
  "footer",
  "form",
  "button",
  "aside",
  "figcaption",
]);

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "br",
  "blockquote",
  "section",
  "tr",
  "article",
  "main",
  "figcaption",
]);

const ARTICLE_CLASS =
  /article|story-body|post-content|entry-content|article-body|post-body|RichTextStoryBody|text-block/i;

const JUNK_REGION =
  /(?:^|[\s_-])(?:cookie|consent|newsletter|subscribe|paywall|modal|sharebar|share-bar|promo|related(?:-stories|-articles|-content|-posts)?|read-more|k-read-more|also-read|more-items|more-stories|sidebar|nx-sidebar|nx-popular|popular|nav|menu|banner)(?:$|[\s_-])/i;

export function extractArticle(
  html: string,
  pageUrl: string,
): Omit<ExtractedArticle, "finalUrl" | "via"> {
  const metas = collectMeta(html);
  const jsonLd = collectJsonLd(html);
  const walked = walkHtml(html, pageUrl);

  const title =
    cleanInline(metas["og:title"] || "") ||
    cleanInline(walked.title || "") ||
    cleanInline(jsonLd.headline || "") ||
    cleanInline(walked.h1 || "") ||
    null;
  const byline = readableName(metaAuthor(metas)) || readableName(jsonLd.author || "") || null;
  const siteName = readableName(metas["og:site_name"] || "") || readableName(jsonLd.publisher || "") || null;

  const publishedAt =
    normalizeDate(metas["article:published_time"]) ||
    normalizeDate(metas["pubdate"]) ||
    normalizeDate(jsonLd.datePublished) ||
    normalizeDate(walked.time) ||
    null;

  const preferredText = cleanArticleText(cleanupText(walked.preferred));
  const articleText = cleanArticleText(cleanupText(walked.article));
  const clusterText = cleanArticleText(cleanupText(walked.cluster));
  const bodyText = cleanArticleText(cleanupText(walked.body));
  const usable = (value: string) => value.length >= LIMITS.minArticleChars && proseScore(value) >= 12;
  const fromPreferred = usable(preferredText);
  const text = fromPreferred
    ? preferredText
    : usable(articleText)
      ? articleText
      : usable(clusterText)
        ? clusterText
        : bodyText;

  if (isInterstitial(html)) {
    throw new HttpError(422, "The page returned a browser check instead of the article. Paste the text instead.");
  }
  if (text.length < LIMITS.minArticleChars) {
    throw new HttpError(
      422,
      "Could not find enough article text on that page. Paste the text instead.",
    );
  }

  return {
    title,
    text: text.slice(0, LIMITS.maxArticleChars),
    publishedAt,
    byline,
    siteName,
    fromPreferred,
    opinionSection: looksLikeOpinionSection(pageUrl, title, text) || opinionCueFromHtml(html),
  };
}

/**
 * Prefer Firecrawl scrape (markdown, main content only). A failed or empty
 * scrape is read from the page itself. With no key, that direct read is the
 * only path and is marked local.
 */
export async function fetchArticle(
  rawUrl: string,
  fetchImpl: typeof fetch,
  apiKey?: string,
  signal?: AbortSignal,
  canSpend?: () => boolean,
  charge?: CacheCharge,
  uiLanguage: UiLanguage = "en",
  gate?: ProviderGate,
): Promise<ExtractedArticle> {
  assertPublicHttpUrl(rawUrl);
  const key = apiKey?.trim();
  let scrapeNote = "";
  if (key) {
    try {
      const scraped = await scrapeArticle({
        url: rawUrl,
        apiKey: key,
        fetchImpl,
        signal,
        timeoutMs: 20_000,
        canSpend,
        charge,
        gate,
      });
      const fromHtml = htmlBody(scraped.rawHtml, scraped.finalUrl);
      const text =
        fromHtml?.fromPreferred
          ? fromHtml.text
          : fromHtml &&
              proseScore(fromHtml.text) > proseScore(scraped.text) * 1.25 &&
              proseScore(fromHtml.text) > proseScore(scraped.text) + 40
            ? fromHtml.text
            : scraped.text;
      if (text.length >= LIMITS.minArticleChars) {
        return {
          title: scraped.title,
          text: text.slice(0, LIMITS.maxArticleChars),
          publishedAt: scraped.publishedAt,
          byline: scraped.byline,
          siteName: scraped.siteName,
          finalUrl: scraped.finalUrl,
          via: "firecrawl",
          fromPreferred: fromHtml?.fromPreferred,
          opinionSection:
            looksLikeOpinionSection(scraped.finalUrl, scraped.title, text) ||
            opinionCueFromHtml(scraped.rawHtml ?? ""),
        };
      }
      scrapeNote = "scrape returned no article text";
      console.error(scrapeNote);
    } catch (error) {
      if (isDeadline(error) || isBudgetExhausted(error)) throw error;
      scrapeNote = error instanceof Error ? error.message : "scrape failed";
      console.error(scrapeNote);
    }
  }

  try {
    const direct = await fetchArticleDirect(rawUrl, fetchImpl, signal);
    return { ...direct, via: key ? "direct" : "local" };
  } catch (error) {
    if (isDeadline(error) || isBudgetExhausted(error)) throw error;
    if (!key) throw error;
    if (error instanceof HttpError && (error.status === 400 || error.status === 413)) throw error;
    const reason = directFailureReason(error, scrapeNote);
    console.error(JSON.stringify({ extraction: "direct", directAttempted: true, reason }));
    throw new HttpError(422, pageUnreadMessage(uiLanguage), { extraction: "direct", reason });
  }
}

function directFailureReason(error: unknown, scrapeNote: string): string {
  const message = error instanceof Error ? error.message : "request failed";
  let why = message.replace(/\s+/g, " ").trim().slice(0, 120) || "request failed";
  if (/browser check|just a moment|cloudflare|enable javascript/i.test(message)) why = "cloudflare challenge";
  else {
    const status = message.match(/status (\d+)/i);
    if (status) why = `HTTP ${status[1]}`;
    else if (/not enough article text|could not find enough/i.test(message)) why = "not enough article text";
    else if (/timed out|aborted/i.test(message)) why = "timed out";
  }
  const scrapeStatus = scrapeNote.match(/\((\d{3})\)/)?.[1];
  const scrape = scrapeStatus ? `scrape HTTP ${scrapeStatus}` : "";
  const direct = `direct fetch failed: ${why}`;
  return scrape ? `${scrape}; ${direct}` : direct;
}

function htmlBody(
  html: string | null,
  pageUrl: string,
): { text: string; fromPreferred: boolean } | null {
  if (!html) return null;
  try {
    const extracted = extractArticle(html, pageUrl);
    return { text: extracted.text, fromPreferred: extracted.fromPreferred === true };
  } catch {
    return null;
  }
}

async function fetchArticleDirect(
  rawUrl: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<Omit<ExtractedArticle, "via">> {
  let current = assertPublicHttpUrl(rawUrl);
  let response: Response | null = null;

  for (let hop = 0; hop <= LIMITS.maxRedirects; hop++) {
    const timeoutSignal = AbortSignal.timeout(PAGE_TIMEOUT_MS);
    response = await raceAbort(
      fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en,el;q=0.8",
          "User-Agent": BROWSER_UA,
        },
        signal: timeoutSignal,
      }),
      signal,
    );

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new HttpError(422, "The page redirected without a destination.");
      current = assertPublicHttpUrl(new URL(location, current).toString());
      continue;
    }
    break;
  }

  if (!response) throw new HttpError(422, "The page could not be fetched.");
  if (response.status >= 300 && response.status < 400) {
    throw new HttpError(422, "The page redirected too many times.");
  }
  if (!response.ok) {
    throw new HttpError(422, `The page responded with status ${response.status}.`);
  }

  const type = response.headers.get("content-type") || "";
  if (type && !/html|xml|text\/plain/i.test(type)) {
    throw new HttpError(422, "Only HTML articles can be fetched. Paste the text instead.");
  }

  const html = await readLimited(response, LIMITS.maxPageBytes);
  const extracted = extractArticle(html, current.toString());
  return { ...extracted, finalUrl: current.toString() };
}

async function readLimited(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, "That page is too large to analyse.");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

interface Walked {
  article: string;
  body: string;
  preferred: string;
  cluster: string;
  title: string;
  h1: string;
  time: string;
}

interface Frame {
  tag: string;
  skip: boolean;
  article: boolean;
  preferred: boolean;
  title: boolean;
  h1: boolean;
  time: boolean;
  paragraph: boolean;
}

function walkHtml(html: string, pageUrl: string): Walked {
  const stack: Frame[] = [];
  let title = "";
  let h1 = "";
  let time = "";
  let article = "";
  let body = "";
  let preferred = "";
  let paragraphBuf = "";
  let currentCluster: string[] = [];
  const clusters: string[] = [];

  const closeCluster = () => {
    const pending = paragraphBuf.replace(/\s+/g, " ").trim();
    paragraphBuf = "";
    if (pending) currentCluster.push(pending);
    if (currentCluster.length === 0) return;
    clusters.push(currentCluster.join("\n"));
    currentCluster = [];
  };

  const token = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w:-]*)\b([^>]*)>|[^<]+/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html))) {
    const raw = match[0];
    if (raw.startsWith("<!--")) continue;
    if (raw.startsWith("<")) {
      const name = match[1].toLowerCase();
      const closing = raw.startsWith("</");
      const attributes = attrs(match[2] || "");
      const selfClosing = raw.endsWith("/>") || VOID_TAGS.has(name);

      if (!closing && name === "time" && attributes.datetime) {
        time = attributes.datetime;
      }

      if (closing || selfClosing) {
        if (name === "p" && !inSkip(stack)) {
          const line = paragraphBuf.replace(/\s+/g, " ").trim();
          paragraphBuf = "";
          if (line) currentCluster.push(line);
        }
        if (BLOCK_TAGS.has(name) && !inSkip(stack)) {
          if (inPreferred(stack)) preferred += "\n";
          if (inArticle(stack)) article += "\n";
          body += "\n";
        }
        if (!selfClosing || stack[stack.length - 1]?.tag === name) popTag(stack, name);
        continue;
      }

      const parent = stack[stack.length - 1];
      const marker = `${attributes.class || ""} ${attributes.id || ""} ${attributes.role || ""}`;
      const skip =
        SKIP_TAGS.has(name) ||
        parent?.skip === true ||
        attributes.role === "navigation" ||
        attributes.role === "banner" ||
        JUNK_REGION.test(marker);
      if (skip && !parent?.skip) closeCluster();
      const articleRegion =
        !skip &&
        (name === "article" ||
          name === "main" ||
          /articleBody/i.test(attributes.itemprop || "") ||
          isArticleContainer(name, attributes) ||
          parent?.article === true);
      const preferredRegion = !skip && (sitePrefers(pageUrl, name, attributes) || parent?.preferred === true);
      stack.push({
        tag: name,
        skip,
        article: articleRegion,
        preferred: preferredRegion,
        title: name === "title" && !skip,
        h1: name === "h1" && !skip,
        time: name === "time" && !skip,
        paragraph: name === "p" && !skip,
      });
      if (name === "p" && !skip) paragraphBuf = "";
      if (BLOCK_TAGS.has(name) && !skip) {
        if (preferredRegion) preferred += "\n";
        if (articleRegion) article += "\n";
        body += "\n";
      }
      continue;
    }

    if (inSkip(stack)) continue;
    const text = decodeEntities(raw);
    if (!text.trim()) continue;
    if (stack.some((frame) => frame.paragraph)) paragraphBuf += text;
    if (stack.some((frame) => frame.title)) title += text;
    if (stack.some((frame) => frame.h1)) h1 += text;
    if (!time && stack.some((frame) => frame.time)) time += text;
    if (inPreferred(stack)) preferred += text;
    if (inArticle(stack)) article += text;
    body += text;
  }

  closeCluster();
  const cluster = clusters.reduce((best, item) => (item.length > best.length ? item : best), "");
  return { article, body, preferred, cluster, title, h1, time };
}

function isInterstitial(html: string): boolean {
  return /just a moment/i.test(html) && /enable javascript|cf-browser-verification|challenge-platform|cf-challenge/i.test(html);
}

function inPreferred(stack: Frame[]): boolean {
  return stack.some((frame) => frame.preferred);
}

function sitePrefers(pageUrl: string, name: string, attributes: Record<string, string>): boolean {
  let host = "";
  try {
    host = new URL(pageUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return false;
  }
  const marker = `${attributes.class || ""} ${attributes.id || ""} ${attributes["data-component"] || ""} ${attributes["data-testid"] || ""} ${attributes.itemprop || ""}`;
  if (/articleBody/i.test(attributes.itemprop || "")) return true;
  if (
    /RichTextStoryBody|entry-content|post-content|td-post-content|article__body|article-body|story-body|story-content|c-article__content|hentry/i.test(
      marker,
    )
  ) {
    return true;
  }
  if (host.endsWith("apnews.com")) return /RichTextStoryBody|Article/i.test(marker);
  if (host.endsWith("theonion.com")) return /entry-content|article__body|post-content/i.test(marker);
  if (host.endsWith("bbc.com") || host.endsWith("bbc.co.uk")) {
    return attributes["data-component"] === "text-block" || /article__body|ssrcss/i.test(marker);
  }
  if (host.endsWith("theguardian.com")) {
    return /article-body|content__article-body|article-body-commercial|dcr-/i.test(marker);
  }
  if (host.endsWith("kathimerini.gr")) return name === "article" || /entry-content|article__body|story-body|post-content/i.test(marker);
  if (host.endsWith("ertnews.gr") || host === "ert.gr" || host.endsWith(".ert.gr")) {
    return name === "article" || /entry-content|article-content|post-content|story-body/i.test(marker);
  }
  return false;
}

function inSkip(stack: Frame[]): boolean {
  return stack.some((frame) => frame.skip);
}

function inArticle(stack: Frame[]): boolean {
  return stack.some((frame) => frame.article);
}

function popTag(stack: Frame[], name: string): void {
  for (let index = stack.length - 1; index >= 0; index--) {
    if (stack[index].tag === name) {
      stack.splice(index);
      return;
    }
  }
}

function isArticleContainer(name: string, attributes: Record<string, string>): boolean {
  if (name !== "div" && name !== "section") return false;
  const marker = `${attributes.class || ""} ${attributes.id || ""}`;
  return ARTICLE_CLASS.test(marker);
}

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pattern = /([:@\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw))) {
    out[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return out;
}

function collectMeta(html: string): Record<string, string> {
  const found: Record<string, string> = {};
  const pattern = /<meta\b([^>]+)>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const attributes = attrs(match[1]);
    const key = (attributes.property || attributes.name || attributes.itemprop || "").toLowerCase();
    const content = attributes.content || "";
    if (key && content && !found[key]) found[key] = decodeEntities(content);
  }
  return found;
}

function collectJsonLd(html: string): {
  headline?: string;
  datePublished?: string;
  author?: string;
  publisher?: string;
} {
  const pattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    try {
      const parsed = JSON.parse(match[1]);
      const found = findNewsNode(parsed);
      if (found) return found;
    } catch {
      continue;
    }
  }
  return {};
}

function findNewsNode(
  value: unknown,
): { headline?: string; datePublished?: string; author?: string; publisher?: string } | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNewsNode(item);
      if (found) return found;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const type = record["@type"];
  const types = Array.isArray(type) ? type.map(String) : [String(type || "")];
  if (types.some((item) => /Article|NewsArticle|ReportageNewsArticle/i.test(item))) {
    return {
      headline: typeof record.headline === "string" ? record.headline : undefined,
      datePublished: typeof record.datePublished === "string" ? record.datePublished : undefined,
      author: personName(record.author),
      publisher: personName(record.publisher),
    };
  }
  if (record["@graph"]) return findNewsNode(record["@graph"]);
  return null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => safeCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => safeCodePoint(parseInt(code, 16)));
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

function metaAuthor(metas: Record<string, string>): string {
  const direct = metas.author || metas["article:author"] || "";
  if (readableName(direct)) return direct;
  for (const [key, value] of Object.entries(metas)) {
    if (/author$/i.test(key) && readableName(value)) return value;
  }
  return "";
}

function personName(value: unknown): string | undefined {
  if (typeof value === "string") return readableName(value) ?? undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const name = personName(item);
      if (name) return name;
    }
    return undefined;
  }
  if (value && typeof value === "object" && "name" in value) {
    return personName((value as { name?: unknown }).name);
  }
  return undefined;
}

function readableName(value: string): string | null {
  const cleaned = cleanInline(value);
  if (!cleaned || /^https?:\/\//i.test(cleaned)) return null;
  return cleaned;
}

function cleanInline(value: string): string {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function cleanupText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeDate(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}
