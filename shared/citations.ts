import type { EvidenceMode, Label, UiLanguage } from "./labels";
import { inferClaimType, isAttributedClaim, isPersonalAccount } from "./classify";
import { anecdoteExplanation, opinionExplanation, rhetoricalExplanation, unverifiableExplanation } from "./messages";
import { tokenOverlap } from "./rank";
import { hostOf, isBlockedEvidenceHost, isSocialHost, sameOutlet } from "./reputation";
import type { SourceCitation } from "./types";

export interface EvidenceItem {
  url: string;
  title: string;
  snippet: string;
  /** Present when the search provider returned one. Citation checks ignore it. */
  publishedAt?: string | null;
}

export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    let serialized = parsed.toString();
    if (serialized.endsWith("/")) serialized = serialized.slice(0, -1);
    return serialized;
  } catch {
    return url.trim();
  }
}

export interface AppliedEvidence {
  label: Label;
  confidence: number;
  explanation: string;
  sources: SourceCitation[];
  evidenceMode: EvidenceMode;
}

const DECIDED = new Set<Label>(["True", "False", "Misleading"]);

/**
 * Keep only URLs that were actually retrieved. A firm factual label without
 * a surviving citation is downgraded to Unverifiable. With search disabled,
 * sources are always empty and recent or numeric claims are not treated as verified.
 */
export function independentEvidence(
  items: EvidenceItem[],
  options: {
    articleDomain?: string | null;
    articleText?: string;
    articleTitle?: string | null;
    claimText: string;
  },
): EvidenceItem[] {
  return items.filter((item) => isIndependent(item, options));
}

export function isIndependent(
  item: EvidenceItem,
  options: {
    articleDomain?: string | null;
    articleText?: string;
    articleTitle?: string | null;
    claimText: string;
  },
): boolean {
  if (sameOutlet(item.url, options.articleDomain ?? null)) return false;
  if (isSocialHost(item.url)) return false;
  if (isBlockedEvidenceHost(item.url)) return false;
  if (isWireCopy(item.url)) return false;
  if (
    isSyndicatedCopy(
      item,
      options.articleTitle ?? null,
      options.articleText ?? "",
      options.articleDomain ?? null,
      options.claimText,
    )
  ) {
    return false;
  }
  if (isEcho(item.snippet, options.claimText, options.articleText ?? "", item.url)) return false;
  return true;
}

const WIRE_BYLINE =
  /\bassociated press\b|\(\s*ap\s*\)|(?:^|[\s—–|])ap\s*[—–|-]|[—–|-]\s*ap\s*$|\bvia the associated press\b/i;

const AP_CREDIT = /\bassociated press\b|\(\s*ap\s*\)/i;

/** A byline credit for a wire, ignored when the page is that wire's own site. */
const FOREIGN_WIRE_CREDITS: { pattern: RegExp; origins: string[] }[] = [
  { pattern: WIRE_BYLINE, origins: ["apnews.com"] },
  {
    pattern: /\bagence france-presse\b|\(\s*afp\s*\)|(?:^|[\s—–|])afp\s*[—–|-]|[—–|-]\s*afp\b/i,
    origins: ["afp.com"],
  },
  {
    pattern: /\(\s*reuters\s*\)|(?:^|[\s—–|])reuters\s*[—–:-]|[—–|-]\s*reuters\b|\bvia reuters\b/i,
    origins: ["reuters.com"],
  },
];

function articleIsAp(domain: string | null | undefined, title: string | null, text: string): boolean {
  const host = (domain ?? "").replace(/^www\./, "").toLowerCase();
  if (host === "apnews.com" || host.endsWith(".apnews.com")) return true;
  return WIRE_BYLINE.test(`${title ?? ""} ${text.slice(0, 700)}`);
}

/** A reprint of this article, or a page that credits a wire, is not a second source. */
export function isSyndicatedCopy(
  item: { url?: string; title?: string; snippet?: string },
  articleTitle: string | null,
  articleText: string,
  articleDomain?: string | null,
  claimText = "",
): boolean {
  const title = (item.title ?? "").replace(/\s+/g, " ").trim();
  const snippet = (item.snippet ?? "").replace(/\s+/g, " ").trim();
  const surface = `${title} ${snippet}`;
  if (creditsForeignWire(surface, item.url)) return true;
  if (articleIsAp(articleDomain, articleTitle, articleText) && AP_CREDIT.test(surface)) return true;
  const ours = (articleTitle ?? "").replace(/\s+/g, " ").trim();
  const lead = articleText.replace(/\s+/g, " ").trim().slice(0, 500);
  if (nearlyIdenticalTitle(ours, title)) return true;
  if (looseReprint(ours, title)) return true;
  if (nearCopy(ours, snippet, 24, 40)) return true;
  if (looseReprint(ours, snippet)) return true;
  if (nearCopy(lead, title, 40, 24)) return true;
  if (looseReprint(lead, title)) return true;
  if (snippet.length >= 48 && lead.length >= 48) {
    const window = snippet.slice(0, 64).toLowerCase();
    if (lead.toLowerCase().includes(window.slice(0, 48))) return true;
  }
  if (nearCopy(lead, snippet, 40, 40)) return true;
  if (looseReprint(lead, snippet)) return true;
  if (repeatsArticle(snippet, articleText, 8, claimText)) return true;
  if (repeatsArticle(title, articleText, 8, claimText)) return true;
  if (
    isKnownSyndicator(item.url) &&
    (repeatsArticle(snippet, articleText, 5, claimText) ||
      repeatsArticle(title, articleText, 5, claimText) ||
      AP_CREDIT.test(surface) ||
      creditsForeignWire(surface, item.url))
  ) {
    return true;
  }
  if (creditsSharedAgency(surface, articleDomain, articleText)) return true;
  return false;
}

const SYNDICATOR_HOSTS = ["mymotherlode.com", "alfavita.gr", "liberal.gr"];

function isKnownSyndicator(url?: string): boolean {
  if (!url) return false;
  const host = hostOf(url) ?? "";
  return SYNDICATOR_HOSTS.some((item) => host === item || host.endsWith(`.${item}`));
}

/**
 * A long verbatim stretch of the snippet already appears in the source article.
 * A short shared fact is not enough. A copied quote or paragraph is.
 */
export function repeatsArticle(
  snippet: string,
  articleText: string,
  minWords = 8,
  claimText = "",
): boolean {
  const article = normalizeCopy(articleText);
  const source = normalizeCopy(snippet);
  const claim = normalizeCopy(claimText);
  if (!article || !source) return false;
  const words = source.split(" ").filter(Boolean);
  const need = Math.max(4, minWords);
  const minChars = minWords >= 8 ? 36 : 24;
  if (words.length < need) {
    return source.length >= 42 && article.includes(source) && !coveredByClaim(claim, source);
  }
  for (let size = Math.min(words.length, 16); size >= need; size -= 1) {
    for (let index = 0; index + size <= words.length; index += 1) {
      const window = words.slice(index, index + size).join(" ");
      if (window.length < minChars || !article.includes(window)) continue;
      // The same sentence in an independent report is corroboration.
      // A copy is a stretch of the article that is not just this claim.
      if (coveredByClaim(claim, window)) continue;
      return true;
    }
  }
  return false;
}

function coveredByClaim(claim: string, window: string): boolean {
  return claim.length > 0 && claim.includes(window);
}

const GREEK_AGENCY =
  /απε[-\s]?μπε|ana[-\s]?mpa|αθηναϊκ\p{L}*\s+πρακτορε\p{L}*|καθημερινή|kathimerini/iu;

function creditsSharedAgency(
  surface: string,
  articleDomain: string | null | undefined,
  articleText: string,
): boolean {
  if (!GREEK_AGENCY.test(surface)) return false;
  const host = (articleDomain ?? "").replace(/^www\./, "").toLowerCase();
  if (host.includes("kathimerini") || host.includes("amna")) return true;
  return GREEK_AGENCY.test(articleText.slice(0, 900));
}

function normalizeCopy(text: string): string {
  return text
    .toLowerCase()
    .replace(/[«»“”„"'’]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function creditsForeignWire(surface: string, url?: string): boolean {
  const host = url ? (hostOf(url) ?? "") : "";
  return FOREIGN_WIRE_CREDITS.some((wire) => {
    if (!wire.pattern.test(surface)) return false;
    if (!host) return true;
    return !wire.origins.some((origin) => host === origin || host.endsWith(`.${origin}`));
  });
}

/**
 * A shorter headline that repeats the article title is the same story.
 * One-sided overlap counts: the reprint often adds only a site suffix.
 */
function nearlyIdenticalTitle(articleTitle: string, resultTitle: string): boolean {
  if (articleTitle.length < 24 || resultTitle.length < 24) return false;
  const forward = tokenOverlap(articleTitle, resultTitle);
  const backward = tokenOverlap(resultTitle, articleTitle);
  const min = Math.min(forward, backward);
  const max = Math.max(forward, backward);
  if (min < 0.4) return false;
  return min >= 0.55 || max >= 0.85;
}

/** Token overlap above ~0.6 in both directions means the result repeats this article. */
function nearCopy(articlePart: string, resultPart: string, minArticle: number, minResult: number): boolean {
  if (articlePart.length < minArticle || resultPart.length < minResult) return false;
  const overlap = Math.min(tokenOverlap(articlePart, resultPart), tokenOverlap(resultPart, articlePart));
  return overlap >= 0.6;
}

/**
 * A reprint headline or snippet is often shorter than the original and has no byline.
 * High overlap in either direction, on a different domain, is the same story.
 */
function looseReprint(articlePart: string, resultPart: string): boolean {
  const article = articlePart.replace(/\s+/g, " ").trim();
  const result = resultPart.replace(/\s+/g, " ").trim();
  if (article.length < 24 || result.length < 24) return false;
  // A two- or three-word confirmation is a source, not a reprint of the article.
  if (contentTokenCount(result) < 5) return false;
  const forward = tokenOverlap(article, result);
  const backward = tokenOverlap(result, article);
  const min = Math.min(forward, backward);
  const max = Math.max(forward, backward);
  if (min >= 0.45) return true;
  return max >= 0.75 && min >= 0.28;
}

function contentTokenCount(text: string): number {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length > 3),
  ).size;
}

const SYNDICATORS = ["yahoo.com", "inkl.com", "msn.com", "apple.news", "flipboard.com", "smartnews.com", "news.google.com"];

/** Local papers and wire hubs that reprint AP or Reuters rather than reporting the story themselves. */
const WIRE_REPRINT_HOSTS = [
  "usnews.com",
  "cbs17.com",
  "hjnews.com",
  "whio.com",
  "wkyc.com",
  "wfmz.com",
  "clickondetroit.com",
  "manisteenews.com",
];

export function isWireCopy(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (
    /wirestory|\/wire\/|associated-press|associatedpress|\/ap-news\/|\/from-ap\/|\/ap-top-news\/|\/reuters-wire\/|\/from-reuters\/|(?:^|\/)ap(?:\/|$)/.test(
      path,
    )
  ) {
    return true;
  }
  if (host === "aol.com" || host.endsWith(".aol.com") || host.startsWith("aol.")) return true;
  return WIRE_REPRINT_HOSTS.some((item) => host === item || host.endsWith(`.${item}`));
}

const ENTITY_STOP = new Set([
  "the", "this", "that", "these", "those",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "mayor", "president", "minister", "governor", "senator", "representative", "secretary", "chief", "officer", "director",
  "said", "says", "according", "mister", "after", "before", "during", "however", "meanwhile",
  "new", "north", "south", "east", "west",
]);

/** Capitalised names that identify a person, place, or event. Empty means there is nothing to mismatch. */
export function namedEntities(text: string): string[] {
  const found: string[] = [];
  const pattern = /[\p{Lu}][\p{L}\p{M}'’-]{2,}(?:\s+[\p{Lu}][\p{L}\p{M}'’-]{2,})*/gu;
  for (const match of text.matchAll(pattern)) {
    const tokens = match[0]
      .split(/\s+/)
      .map((token) => token.toLowerCase())
      .filter((token) => token.length >= 4 && !ENTITY_STOP.has(token));
    if (tokens.length === 0) continue;
    found.push(tokens.join(" "));
  }
  return found;
}

const RELEVANCE_STOP = new Set([
  "this", "that", "with", "from", "have", "been", "were", "they", "their", "about", "after",
  "before", "which", "would", "could", "should", "there", "these", "those", "into", "over",
  "under", "than", "then", "also", "just", "only", "more", "most", "some", "such", "when",
  "where", "what", "while", "check", "calendar", "today", "year", "date", "time", "says",
  "said", "will", "been", "αλλά", "είναι", "έτος", "σήμερα", "ημερολόγιο",
]);

const WORD_NUMBER: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7",
  eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14",
  fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19", twenty: "20",
  thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70", eighty: "80", ninety: "90",
  hundred: "100",
  μηδέν: "0", ένα: "1", μία: "1", δυο: "2", δύο: "2", τρία: "3", τέσσερα: "4", πέντε: "5",
  δεκαέξι: "16", είκοσι: "20",
};

const NEGATION =
  /\b(?:not|no|never|denied|denies|incorrect|wrong|false|instead|rather|wasn't|isn't|aren't|didn't|don't|cannot|can't|without|unlike)\b|δεν|όχι|αντί|ούτε/iu;

function tokenOverlaps(token: string, others: Set<string>): boolean {
  if (others.has(token)) return true;
  if (token.length < 5) return false;
  for (const other of others) {
    if (other.length < 5) continue;
    if (other.startsWith(token) || token.startsWith(other)) return true;
  }
  return false;
}

function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\b(?:19|20)\d{2}\b/g, " ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length > 3 && !RELEVANCE_STOP.has(token)),
  );
}

const STATISTIC =
  /(?:%|€|\$|£|\b(?:million|billion|thousand|percent|per cent|εκατομμ\p{L}*|δισ\p{L}*|χιλιάδ\p{L}*)\b)/iu;

/** A count, rate, or percentage. "4.9 million adults smoke" is one of these. */
export function isStatisticalClaim(text: string): boolean {
  return /\d/.test(text) && STATISTIC.test(text);
}

function statisticTokens(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/\d+(?:[.,]\d+)?/g)) found.add(match[0].replace(",", "."));
  return found;
}

/**
 * A page is relevant when it shares a distinctive word or a named entity with
 * the claim. A shared year, or the word "calendar", is not enough. A statistical
 * claim also matches a page that states a rate for the same subject.
 */
export function isRelevantEvidence(
  claim: string,
  item: { title?: string; snippet?: string },
): boolean {
  const surface = `${item.title ?? ""} ${item.snippet ?? ""}`;
  const claimTokens = contentTokens(claim);
  const evidenceTokens = contentTokens(surface);
  if (claimTokens.size === 0) return false;
  const shared = [...claimTokens].filter((token) => tokenOverlaps(token, evidenceTokens));
  const entities = namedEntities(claim);
  if (entities.length > 0) {
    const haystack = surface.toLowerCase();
    const entityHit = entities.some((entity) =>
      entity.split(" ").some((token) => token.length >= 4 && haystack.includes(token)),
    );
    if (entityHit && shared.length > 0) return true;
    if (!entityHit && shared.length === 0 && !statisticalOverlap(claim, surface, shared)) return false;
  }
  const strong = shared.filter((token) => token.length >= 5);
  if (strong.length >= 2) return true;
  if (strong.length === 1 && (claimTokens.size <= 6 || shared.length / claimTokens.size >= 0.2)) return true;
  if (statisticalOverlap(claim, surface, shared)) return true;
  return false;
}

function statisticalOverlap(claim: string, surface: string, shared: string[]): boolean {
  if (!isStatisticalClaim(claim)) return false;
  const strong = shared.filter((token) => token.length >= 5);
  if (strong.length === 0) return false;
  const claimFigures = statisticTokens(claim);
  const evidenceFigures = statisticTokens(surface);
  if ([...claimFigures].some((figure) => evidenceFigures.has(figure))) return true;
  return STATISTIC.test(surface);
}

function normalizeSpan(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function quotedSpans(explanation: string): string[] {
  const spans: string[] = [];
  for (const match of explanation.matchAll(/["“«]([^"”»]{12,})["”»]/g)) {
    spans.push(match[1]);
  }
  return spans;
}

function quantityTokens(text: string): Set<string> {
  const found = new Set<string>();
  for (const match of text.matchAll(/\d+(?:[.,]\d+)?/g)) found.add(match[0].replace(",", "."));
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  for (const word of words) {
    const mapped = WORD_NUMBER[word];
    if (mapped) found.add(mapped);
  }
  return found;
}

const MATERIAL_CONDITION =
  /\b(?:critical|died|dead|killed|injured|wounded|hospitali[sz]ed|arrested|missing|drowned)\b|κρίσιμ\p{L}*|πέθαν\p{L}*|νεκρ\p{L}*|σκοτώ\p{L}*|τραυματ\p{L}*|νοσηλεύ\p{L}*|συνελήφ\p{L}*|αγνοούμ\p{L}*|πνίγηκ\p{L}*/giu;

const MAGNITUDE_UNIT =
  /(?:%|percent|per cent|million|billion|thousand|miles?|kilomet(?:er|re)s?|χλμ|εκατομμ\p{L}*|δισ\p{L}*)/iu;

interface QuantitySpan {
  token: string;
  index: number;
  raw: string;
}

/**
 * True needs the claim's main figure, name, or event. A missing secondary
 * detail does not block it. An unsupported or contradicted core quantity, or a
 * missing material condition such as "critical", does.
 * A statistical claim may still match a rate for the same population.
 */
export function missingSpecificDetail(
  claim: string,
  sources: { title?: string; snippet?: string }[],
): boolean {
  const surface = sources.map((source) => `${source.title ?? ""} ${source.snippet ?? ""}`).join("\n");
  const surfaceQty = quantityTokens(surface);
  const rateBacked = isStatisticalClaim(claim) && /(?:%|percent|per cent)/i.test(surface);
  if (!rateBacked) {
    for (const quantity of coreQuantityTokens(claim)) {
      if (!surfaceQty.has(quantity)) return true;
    }
  }
  if (contradictedCore(claim, surface)) return true;
  const surfaceLower = surface.toLowerCase();
  for (const match of claim.matchAll(MATERIAL_CONDITION)) {
    if (!surfaceLower.includes(match[0].toLowerCase())) return true;
  }
  return false;
}

function quantitySpans(text: string): QuantitySpan[] {
  const spans: QuantitySpan[] = [];
  for (const match of text.matchAll(/\d+(?:[.,]\d+)?/g)) {
    spans.push({ token: match[0].replace(",", "."), index: match.index ?? 0, raw: match[0] });
  }
  for (const match of text.matchAll(/[\p{L}]+/gu)) {
    const mapped = WORD_NUMBER[match[0].toLowerCase()];
    if (!mapped) continue;
    spans.push({ token: mapped, index: match.index ?? 0, raw: match[0] });
  }
  return spans;
}

function isYearToken(token: string): boolean {
  return /^(?:19|20)\d{2}$/.test(token);
}

function nearby(text: string, index: number, before: number, after: number): string {
  return text.slice(Math.max(0, index - before), index + after).toLowerCase();
}

function isTimeQuantity(text: string, index: number): boolean {
  return /\b(?:a\.?m\.?|p\.?m\.?|o'clock)\b/.test(nearby(text, index, 8, 18));
}

function isAgeQuantity(text: string, index: number): boolean {
  return /\b(?:aged|age|year-old|years old|and over|or older|or over)\b/.test(nearby(text, index, 18, 22));
}

/** The main count, distance, or statistic. Years, clock times, and age bounds are secondary when a main figure exists. */
function coreQuantityTokens(claim: string): Set<string> {
  const spans = quantitySpans(claim);
  const cores = new Set<string>();
  const pair = claim.match(/(\d+(?:[.,]\d+)?)\s+to\s+(\d+(?:[.,]\d+)?)/i);
  if (pair) {
    cores.add(pair[1].replace(",", "."));
    cores.add(pair[2].replace(",", "."));
  }
  for (const span of spans) {
    const window = nearby(claim, span.index, 18, span.raw.length + 28);
    if (MAGNITUDE_UNIT.test(window)) cores.add(span.token);
  }
  if (cores.size > 0) return cores;
  const primary = spans.filter(
    (span) => !isYearToken(span.token) && !isTimeQuantity(claim, span.index) && !isAgeQuantity(claim, span.index),
  );
  const pool = primary.length > 0 ? primary : spans;
  if (pool.length === 0) return cores;
  let best = pool[0];
  for (const span of pool) {
    if (Number(span.token) > Number(best.token)) best = span;
  }
  cores.add(best.token);
  return cores;
}

function contradictedCore(claim: string, surface: string): boolean {
  const claimLower = claim.toLowerCase();
  const surfaceLower = surface.toLowerCase();
  const claimsRescue = /\brescued\b|διασώ/u.test(claimLower);
  const surfaceRescue = /\brescued\b|διασώ/u.test(surfaceLower);
  if (claimsRescue && /\b(?:died|dead|killed|drowned)\b/.test(surfaceLower) && !surfaceRescue) return true;
  for (const match of claim.matchAll(/(\d+(?:[.,]\d+)?)\s*(miles?|million|billion|percent|%)/gi)) {
    const number = match[1].replace(",", ".");
    const escaped = number.replace(".", "\\.");
    const denied = new RegExp(`\\b(?:not|no|never|only|instead(?:\\s+of)?)\\s+(?:\\w+\\s+){0,4}${escaped}\\b`, "i");
    if (denied.test(surface)) return true;
  }
  return false;
}

function spanContradicts(claim: string, span: string): boolean {
  if (NEGATION.test(span)) return true;
  const claimQuantities = quantityTokens(claim);
  if (claimQuantities.size === 0) return false;
  for (const quantity of quantityTokens(span)) {
    if (!claimQuantities.has(quantity)) return true;
  }
  return false;
}

/**
 * False requires a quote, copied from a cited page, that cannot be true
 * together with the claim. A different detail with no denial and no
 * conflicting figure does not count.
 */
export function hasContradictingSpan(
  claim: string,
  explanation: string,
  sources: { title?: string; snippet?: string }[],
): boolean {
  const surfaces = sources.map((source) => normalizeSpan(`${source.title ?? ""} ${source.snippet ?? ""}`));
  for (const span of quotedSpans(explanation)) {
    const normalized = normalizeSpan(span);
    if (normalized.length < 12) continue;
    if (!surfaces.some((surface) => surface.includes(normalized))) continue;
    if (spanContradicts(claim, span)) return true;
  }
  return false;
}

/** False is only allowed when the evidence is about the same named entity, or the claim names nobody. */
export function sharesEntity(claim: string, evidence: { title?: string; snippet?: string }[]): boolean {
  const entities = namedEntities(claim);
  if (entities.length === 0) return true;
  const haystack = evidence
    .map((item) => `${item.title ?? ""} ${item.snippet ?? ""}`)
    .join("\n")
    .toLowerCase();
  return entities.some((entity) => entity.split(" ").some((token) => haystack.includes(token)));
}

/** A snippet copied from this article, or a social/wire repost of the claim, is not independent. */
export function isEcho(snippet: string, claim: string, articleText: string, url = ""): boolean {
  const compact = snippet.replace(/\s+/g, " ").trim();
  if (compact.length >= 48 && articleText.includes(compact.slice(0, 48))) return true;
  const repeatsClaim = tokenOverlap(claim, compact) >= 0.8 && compact.length <= claim.length + 40;
  if (!repeatsClaim || !url) return false;
  return isSocialHost(url) || SYNDICATORS.some((host) => (hostOf(url) ?? "") === host || (hostOf(url) ?? "").endsWith(`.${host}`));
}

export function applyEvidence(input: {
  label: Label;
  confidence: number;
  explanation: string;
  claimText: string;
  sourceUrls: string[];
  evidence: EvidenceItem[];
  searchEnabled: boolean;
  uiLanguage: UiLanguage;
  articleDomain?: string | null;
  articleText?: string;
  articleTitle?: string | null;
  /** When search ran and returned nothing, stable facts may keep a low-confidence model label. */
  allowModelKnowledge?: boolean;
  /**
   * The verifier's relevance flag, keyed by canonical URL. Absent means the
   * model did not say. A false flag drops the citation even when words overlap.
   */
  relevance?: Record<string, boolean> | null;
}): AppliedEvidence {
  const confidence = clampConfidence(input.confidence);
  const local = inferClaimType(input.claimText);
  if (local === "personal" || isPersonalAccount(input.claimText)) {
    return {
      label: "Personal",
      confidence: Math.min(confidence, 0.75),
      explanation: anecdoteExplanation(input.uiLanguage),
      sources: [],
      evidenceMode: "not-applicable",
    };
  }
  const label = isAttributedClaim(input.claimText) && input.label === "Opinion" ? "Unverifiable" : input.label;
  if (!isAttributedClaim(input.claimText) && (local === "opinion" || local === "rhetorical")) {
    const opinion = local === "opinion";
    return {
      label: opinion ? "Opinion" : "Rhetorical",
      confidence: Math.min(confidence, 0.75),
      explanation: opinion
        ? opinionExplanation(input.uiLanguage)
        : rhetoricalExplanation(input.uiLanguage),
      sources: [],
      evidenceMode: "not-applicable",
    };
  }

  if (!input.searchEnabled) {
    const downgrade =
      DECIDED.has(label) && looksLikeNewsOrFigure(input.claimText);
    return {
      label: downgrade ? "Unverifiable" : label,
      confidence: Math.min(confidence, 0.55),
      explanation: downgrade
        ? unverifiableExplanation(input.uiLanguage, "model-only")
        : input.explanation,
      sources: [],
      evidenceMode: "model-knowledge-only",
    };
  }

  const independent = independentEvidence(input.evidence, {
    articleDomain: input.articleDomain,
    articleText: input.articleText,
    articleTitle: input.articleTitle,
    claimText: input.claimText,
  });
  const usable = independent.filter((item) => isRelevantEvidence(input.claimText, item));
  const byUrl = new Map(usable.map((item) => [canonicalUrl(item.url), item]));
  const sources: SourceCitation[] = [];
  const seen = new Set<string>();
  for (const url of input.sourceUrls) {
    const key = canonicalUrl(url);
    const item = byUrl.get(key);
    if (!item || seen.has(key)) continue;
    if (
      input.relevance &&
      input.relevance[key] === false &&
      !(isStatisticalClaim(input.claimText) && isRelevantEvidence(input.claimText, item))
    ) {
      continue;
    }
    seen.add(key);
    sources.push({
      url: item.url,
      title: item.title,
      snippet: item.snippet,
    });
  }

  if (label === "False" && sources.length > 0 && !sharesEntity(input.claimText, sources)) {
    return {
      label: "Unverifiable",
      confidence: Math.min(confidence, 0.45),
      explanation: unverifiableExplanation(input.uiLanguage, "entity-mismatch"),
      sources: [],
      evidenceMode: "web-search",
    };
  }

  if (label === "False" && sources.length > 0 && !hasContradictingSpan(input.claimText, input.explanation, sources)) {
    return {
      label: "Unverifiable",
      confidence: Math.min(confidence, 0.45),
      explanation: unverifiableExplanation(input.uiLanguage, "not-contradiction"),
      sources: [],
      evidenceMode: "web-search",
    };
  }

  if (DECIDED.has(label) && sources.length === 0) {
    if (
      input.evidence.length === 0 &&
      input.allowModelKnowledge &&
      !looksLikeNewsOrFigure(input.claimText)
    ) {
      return {
        label,
        confidence: Math.min(confidence, 0.55),
        explanation: input.explanation,
        sources: [],
        evidenceMode: "model-knowledge-only",
      };
    }
    const reason =
      input.evidence.length === 0
        ? "no-evidence"
        : usable.length > 0
          ? "uncited"
          : independent.length > 0
            ? "no-evidence"
            : "not-independent";
    return {
      label: "Unverifiable",
      confidence: Math.min(confidence, 0.45),
      explanation: unverifiableExplanation(input.uiLanguage, reason),
      sources: [],
      evidenceMode: "web-search",
    };
  }

  if (label === "True" && sources.length > 0 && missingSpecificDetail(input.claimText, sources)) {
    return {
      label: "Unverifiable",
      confidence: Math.min(confidence, 0.45),
      explanation: unverifiableExplanation(input.uiLanguage, "detail-missing"),
      sources,
      evidenceMode: "web-search",
    };
  }

  if (label === "Unverifiable" && input.label === "Opinion") {
    return {
      label: "Unverifiable",
      confidence: Math.min(confidence, 0.45),
      explanation: unverifiableExplanation(input.uiLanguage, "no-evidence"),
      sources: [],
      evidenceMode: input.searchEnabled ? "web-search" : "model-knowledge-only",
    };
  }

  return {
    label,
    confidence,
    explanation: input.explanation,
    sources,
    evidenceMode: "web-search",
  };
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.4;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

export function looksLikeNewsOrFigure(text: string): boolean {
  if (/\b20(?:1[5-9]|2\d)\b/.test(text)) return true;
  if (/(?:%|€|\$|£)/.test(text)) return true;
  if (/\b\d+(?:[.,]\d+)?\b/.test(text)) return true;
  return false;
}
