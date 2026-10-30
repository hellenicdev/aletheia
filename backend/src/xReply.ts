import { LABELS, type Label } from "../../shared/labels";
import type { AnalysisResult } from "../../shared/types";

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

const EN_LABEL: Record<Label, string> = {
  True: "true",
  False: "false",
  Misleading: "misleading",
  Unverifiable: "unverifiable",
  Opinion: "opinion",
  Personal: "personal",
  Rhetorical: "rhetorical",
};

const EL_LABEL: Record<Label, string> = {
  True: "αληθή",
  False: "ψευδή",
  Misleading: "παραπλανητικά",
  Unverifiable: "μη επαληθεύσιμα",
  Opinion: "γνώμες",
  Personal: "προσωπικές",
  Rhetorical: "ρητορικά",
};

export function reportUrl(articleUrl: string, lang: "en" | "el"): string {
  const base = lang === "el" ? "https://hellenicdev.eu/aletheia/el/" : "https://hellenicdev.eu/aletheia/";
  return `${base}?url=${encodeURIComponent(articleUrl)}`;
}

const FOOTER = {
  en: "Automated AI fact-check · reply stop to opt out",
  el: "Αυτόματος έλεγχος AI · απάντησε σταμάτα για εξαίρεση",
} as const;

export function optOutFooter(lang: "en" | "el"): string {
  return FOOTER[lang];
}

export function formatMentionReply(result: AnalysisResult, articleUrl: string, lang: "en" | "el"): string {
  const present = LABELS.filter((label) => (result.score.counts[label] ?? 0) > 0);
  const note = needsNote(result);
  const tail = replyTail(articleUrl, lang);
  let shown = present;
  let withNote = note;
  let withAuto = true;
  let summary = summaryText(result, lang, shown, withNote, withAuto);
  let text = joinReply(summary, tail);
  while (weightedLength(text) > 280 && shown.length > 0) {
    shown = shown.slice(0, -1);
    summary = summaryText(result, lang, shown, withNote, withAuto);
    text = joinReply(summary, tail);
  }
  if (weightedLength(text) > 280 && withNote) {
    withNote = false;
    summary = summaryText(result, lang, shown, withNote, withAuto);
    text = joinReply(summary, tail);
  }
  if (weightedLength(text) > 280 && withAuto) {
    withAuto = false;
    summary = summaryText(result, lang, shown, withNote, withAuto);
    text = joinReply(summary, tail);
  }
  if (weightedLength(text) > 280) text = clipMentionText(summary, tail);
  return text;
}

/** Shortens the summary. The tail (report link and footer) is kept whole. */
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

function needsNote(result: AnalysisResult): boolean {
  return result.degraded || result.provisional || result.meta.searchStatus.state !== "ok";
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

function replyTail(articleUrl: string, lang: "en" | "el"): string {
  const report = lang === "el" ? "Πλήρης αναφορά" : "Full report";
  return `${report}: ${reportUrl(articleUrl, lang)}\n${FOOTER[lang]}`;
}

function joinReply(summary: string, tail: string): string {
  return summary ? `${summary}\n${tail}` : tail;
}

function summaryText(
  result: AnalysisResult,
  lang: "en" | "el",
  labels: Label[],
  note: boolean,
  auto: boolean,
): string {
  const names = lang === "el" ? EL_LABEL : EN_LABEL;
  const total = LABELS.reduce((sum, label) => sum + (result.score.counts[label] ?? 0), 0);
  const parts = labels.map((label) => `${result.score.counts[label]} ${names[label]}`);
  const claims =
    lang === "el"
      ? `${total} ισχυρισμοί${parts.length ? `: ${parts.join(", ")}` : ""}`
      : `${total} claims${parts.length ? `: ${parts.join(", ")}` : ""}`;
  const caution = lang === "el" ? "Προσωρινό." : "Provisional.";
  const autoLine = lang === "el" ? "Αυτόματος έλεγχος, μπορεί να πέσει έξω." : "Automated check, may be wrong.";
  const head = `Aletheia: ${result.score.overall}/100, ${band(result.score.overall, lang)}. ${claims}.`;
  const middle = note ? ` ${caution}` : "";
  const end = auto ? ` ${autoLine}` : "";
  return `${head}${middle}${end}`.trim();
}
