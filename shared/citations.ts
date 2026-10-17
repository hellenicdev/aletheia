import type { EvidenceMode, Label, UiLanguage } from "./labels";
import { unverifiableExplanation } from "./messages";
import { tokenOverlap } from "./rank";
import { hostOf, isSocialHost, isUnreliableHost, sameOutlet } from "./reputation";
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
  options: { articleDomain?: string | null; articleText?: string; claimText: string },
): EvidenceItem[] {
  return items.filter((item) => isIndependent(item, options));
}

export function isIndependent(
  item: EvidenceItem,
  options: { articleDomain?: string | null; articleText?: string; claimText: string },
): boolean {
  if (sameOutlet(item.url, options.articleDomain ?? null)) return false;
  if (isSocialHost(item.url)) return false;
  if (isUnreliableHost(item.url)) return false;
  if (isWireCopy(item.url)) return false;
  if (isEcho(item.snippet, options.claimText, options.articleText ?? "", item.url)) return false;
  return true;
}

const SYNDICATORS = ["yahoo.com", "inkl.com", "msn.com", "apple.news", "flipboard.com", "smartnews.com", "news.google.com"];

/** Local papers and wire hubs that reprint AP or Reuters rather than reporting the story themselves. */
const WIRE_REPRINT_HOSTS = ["usnews.com", "cbs17.com", "hjnews.com", "whio.com", "wkyc.com", "wfmz.com"];

export function isWireCopy(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
  const path = parsed.pathname.toLowerCase();
  if (/wirestory|\/wire\/|associated-press|associatedpress|\/ap-news\/|\/from-ap\/|\/ap-top-news\/|\/reuters-wire\/|\/from-reuters\//.test(path)) {
    return true;
  }
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
  /** When search ran and returned nothing, stable facts may keep a low-confidence model label. */
  allowModelKnowledge?: boolean;
}): AppliedEvidence {
  const confidence = clampConfidence(input.confidence);

  if (!input.searchEnabled) {
    const downgrade =
      DECIDED.has(input.label) && looksLikeNewsOrFigure(input.claimText);
    return {
      label: downgrade ? "Unverifiable" : input.label,
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

  if (input.label === "False" && sources.length > 0 && !sharesEntity(input.claimText, sources)) {
    return {
      label: "Unverifiable",
      confidence: Math.min(confidence, 0.45),
      explanation: unverifiableExplanation(input.uiLanguage, "entity-mismatch"),
      sources: [],
      evidenceMode: "web-search",
    };
  }

  if (DECIDED.has(input.label) && sources.length === 0) {
    if (
      input.evidence.length === 0 &&
      input.allowModelKnowledge &&
      !looksLikeNewsOrFigure(input.claimText)
    ) {
      return {
        label: input.label,
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

  return {
    label: input.label,
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
