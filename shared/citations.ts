import type { EvidenceMode, Label, UiLanguage } from "./labels";
import { inferClaimType, isAttributedClaim } from "./classify";
import { opinionExplanation, rhetoricalExplanation, unverifiableExplanation } from "./messages";
import { tokenOverlap } from "./rank";
import { hostOf, isBlockedEvidenceHost, isSocialHost, sameOutlet } from "./reputation";
import type { SourceCitation } from "./types";

export interface EvidenceItem {
  url: string;
  title: string;
  snippet: string;
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
    isSyndicatedCopy(item, options.articleTitle ?? null, options.articleText ?? "", options.articleDomain ?? null)
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
  return false;
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
}): AppliedEvidence {
  const confidence = clampConfidence(input.confidence);
  const local = inferClaimType(input.claimText);
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

  const usable = independentEvidence(input.evidence, {
    articleDomain: input.articleDomain,
    articleText: input.articleText,
    articleTitle: input.articleTitle,
    claimText: input.claimText,
  });
  const byUrl = new Map(usable.map((item) => [canonicalUrl(item.url), item]));
  const sources: SourceCitation[] = [];
  const seen = new Set<string>();
  for (const url of input.sourceUrls) {
    const key = canonicalUrl(url);
    const item = byUrl.get(key);
    if (!item || seen.has(key)) continue;
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
      input.evidence.length === 0 ? "no-evidence" : usable.length > 0 ? "uncited" : "not-independent";
    return {
      label: "Unverifiable",
      confidence: Math.min(confidence, 0.45),
      explanation: unverifiableExplanation(input.uiLanguage, reason),
      sources: [],
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
