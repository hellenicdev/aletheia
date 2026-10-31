import type { Label } from "../../shared/labels";
import { KOFI_PAGE_URL } from "../../shared/kofiPage";
import type { AnalysisResult, SegmentResult } from "../../shared/types";

const SCALE = 100;
const URL_UNITS = 23 * SCALE;
const URL_PATTERN = /https?:\/\/[^\s]+/gi;

/** twitter-text v3: most BMP text is 1, the rest is 2, and each URL is 23. */
export function weightedLength(text: string): number {
  let units = 0;
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    units += textUnits(text.slice(cursor, index));
    units += URL_UNITS;
    cursor = index + match[0].length;
  }
  units += textUnits(text.slice(cursor));
  return Math.ceil(units / SCALE);
}

function textUnits(text: string): number {
  let units = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    units += codeWeight(code);
  }
  return units;
}

function codeWeight(code: number): number {
  if (code <= 4351) return 100;
  if (code >= 8192 && code <= 8205) return 100;
  if (code >= 8208 && code <= 8223) return 100;
  if (code >= 8242 && code <= 8247) return 100;
  return 200;
}

export function reportUrl(articleUrl: string, lang: "en" | "el"): string {
  const base = lang === "el" ? "https://hellenicdev.eu/aletheia/el/" : "https://hellenicdev.eu/aletheia/";
  return `${base}?url=${encodeURIComponent(articleUrl)}`;
}

/** Same first page of claims the site shows before "Show all". */
const MAX_CLAIMS = 6;

const CLAIM_MARK: Record<Label, string> = {
  True: "✅",
  False: "❌",
  Misleading: "⚠️",
  Unverifiable: "❔",
  "Not checked": "–",
  Opinion: "💬",
  Personal: "👤",
  Rhetorical: "📣",
};

const DISCLOSURE = {
  en: "AI bot · reply stop to opt out",
  el: "AI bot · απάντησε σταμάτα για εξαίρεση",
} as const;

export const MADE_BY_URL = "https://hellenicdev.eu?utm_source=aletheia_bot";

export function optOutFooter(lang: "en" | "el"): string {
  return DISCLOSURE[lang];
}

export function formatMentionReply(result: AnalysisResult, articleUrl: string, lang: "en" | "el"): string {
  const tail = replyTail(articleUrl, lang);
  const verdict = verdictLine(result, lang);
  const claims = topClaims(result);
  const room = 280 - weightedLength(`${verdict}\n`) - weightedLength(`\n${tail}`);
  let count = claims.length;
  while (count > 0) {
    const block = fitClaims(claims.slice(0, count), room);
    if (block) return `${verdict}\n${block}\n${tail}`;
    count -= 1;
  }
  return clipMentionText(verdict, tail);
}

/** Shortens the summary. The tail (report link, credits, and disclosure) is kept whole. */
export function clipMentionText(summary: string, tail: string, limit = 280): string {
  const fits = (body: string) => weightedLength(body) <= limit;
  if (fits(joinReply(summary, tail))) return joinReply(summary, tail);
  const chars = [...summary];
  let low = 0;
  let high = chars.length;
  let best = tail;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const cut = chars.slice(0, mid).join("").trimEnd();
    const candidate = cut ? `${cut}…\n${tail}` : tail;
    if (fits(candidate)) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export function stopReply(lang: "en" | "el"): string {
  return lang === "el"
    ? "Έγινε, δεν θα απαντήσω ξανά. Απάντησε start για αναίρεση."
    : "Done, I won't reply to you again. Reply start to undo.";
}

function replyTail(articleUrl: string, lang: "en" | "el"): string {
  const report = lang === "el" ? "Πλήρης αναφορά" : "Full report";
  return [
    `${report}: ${reportUrl(articleUrl, lang)}`,
    `Made by HellenicDev ${MADE_BY_URL}`,
    `Support me ${KOFI_PAGE_URL}`,
    DISCLOSURE[lang],
  ].join("\n");
}

function joinReply(summary: string, tail: string): string {
  return summary ? `${summary}\n${tail}` : tail;
}

function verdictLine(result: AnalysisResult, lang: "en" | "el"): string {
  return `${band(result.score.overall, lang)}, ${result.score.overall}/100`;
}

function band(score: number, lang: "en" | "el"): string {
  if (lang === "el") {
    if (score >= 60) return "Κυρίως αξιόπιστο";
    if (score >= 40) return "Μεικτό";
    return "Αδύναμο";
  }
  if (score >= 60) return "Mostly reliable";
  if (score >= 40) return "Mixed";
  return "Weak";
}

function topClaims(result: AnalysisResult): SegmentResult[] {
  return result.segments
    .map((segment, index) => ({ segment, index }))
    .filter(({ segment }) => segment.label !== "Not checked")
    .filter(({ segment }) => segment.text.replace(/\s+/g, " ").trim().length > 0)
    .sort((a, b) => a.segment.start - b.segment.start || a.index - b.index)
    .slice(0, MAX_CLAIMS)
    .map(({ segment }) => segment);
}

function fitClaims(claims: SegmentResult[], room: number): string | null {
  if (room < 0) return null;
  const longest = claims.reduce((max, claim) => Math.max(max, [...flatten(claim.text)].length), 1);
  let low = 0;
  let high = longest;
  let best: string | null = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const block = claims.map((claim) => claimLine(claim, mid)).join("\n");
    if (weightedLength(block) <= room) {
      best = block;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function claimLine(segment: SegmentResult, maxChars: number): string {
  return `${CLAIM_MARK[segment.label]} ${shorten(segment.text, maxChars)}`;
}

function shorten(text: string, maxChars: number): string {
  const flat = flatten(text);
  const chars = [...flat];
  if (chars.length <= maxChars) return flat;
  let end = Math.max(0, maxChars);
  if (end < chars.length && chars[end] !== " ") {
    const space = chars.slice(0, end).join("").lastIndexOf(" ");
    if (space > 0) end = space;
  }
  const cut = chars.slice(0, end).join("").trimEnd();
  return cut ? `${cut}…` : "…";
}

function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
