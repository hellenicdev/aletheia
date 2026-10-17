export interface TextSpan {
  text: string;
  start: number;
  end: number;
}

const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "gen",
  "sen",
  "rep",
  "vs",
  "etc",
  "e.g",
  "i.e",
  "u.s",
  "u.k",
  "κ",
  "π.χ",
  "κ.λπ",
  "δηλ",
  "βλ",
  "αρ",
]);

function isAbbreviation(text: string, periodIndex: number): boolean {
  const before = text.slice(0, periodIndex);
  const token = before.match(/[\p{L}.]+$/u)?.[0]?.toLowerCase() ?? "";
  if (!token) return false;
  if (token.replace(/\./g, "").length === 1) return true;
  if (ABBREVIATIONS.has(token.replace(/\.$/, ""))) return true;
  if (/^([a-zα-ω]\.)+[a-zα-ω]$/i.test(token)) return true;
  return false;
}

/** Deterministic sentence spans used when the model cannot be aligned. */
export function splitSentences(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "." && text[i + 1] === ".") {
      while (text[i + 1] === ".") i += 1;
    }
    const decimal = ch === "." && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "");
    const boundary =
      !decimal &&
      (ch === "!" ||
        ch === "?" ||
        ch === "…" ||
        (ch === "." && !isAbbreviation(text, i)) ||
        (ch === ";" && looksLikeGreekQuestion(text, i)));

    if (!boundary) continue;
    const end = i + 1;
    pushSpan(text, spans, start, end);
    start = end;
  }

  pushSpan(text, spans, start, text.length);
  return spans.filter((span) => span.text.trim().length > 0);
}

function looksLikeGreekQuestion(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - 40), index);
  return /[\u0370-\u03FF]/.test(window);
}

function pushSpan(text: string, spans: TextSpan[], start: number, end: number) {
  const raw = text.slice(start, end);
  const leading = raw.match(/^\s*/)?.[0].length ?? 0;
  const trailing = raw.match(/\s*$/)?.[0].length ?? 0;
  const from = start + leading;
  const to = end - trailing;
  if (to > from) spans.push({ text: text.slice(from, to), start: from, end: to });
}

export interface ProposedSegment {
  text: string;
}

/**
 * Align model-proposed excerpts to exact article offsets.
 * Falls back to sentence splits when coverage is too thin.
 */
export function alignSegments(article: string, proposed: ProposedSegment[]): TextSpan[] {
  const aligned: TextSpan[] = [];
  let cursor = 0;

  for (const item of proposed) {
    const needle = item.text.trim();
    if (needle.length < 2) continue;
    let index = article.indexOf(needle, cursor);
    if (index < 0) index = article.indexOf(needle);
    if (index < 0) continue;
    const end = index + needle.length;
    if (aligned.some((span) => index < span.end && end > span.start)) continue;
    aligned.push({ text: article.slice(index, end), start: index, end });
    cursor = end;
  }

  aligned.sort((a, b) => a.start - b.start);
  const covered = aligned.reduce((sum, span) => sum + (span.end - span.start), 0);
  const meaningful = article.replace(/\s/g, "").length;
  if (aligned.length === 0 || covered < meaningful * 0.45) {
    return splitSentences(article);
  }
  return aligned;
}

export function splitPastedTitle(text: string): { title: string | null; body: string } {
  const trimmed = text.trim();
  const match = trimmed.match(/^([^\n]{8,140})\n\n([\s\S]+)$/);
  if (!match) return { title: null, body: trimmed };
  const heading = match[1].trim();
  if (/[.!?;…]$/.test(heading)) return { title: null, body: trimmed };
  return { title: heading, body: match[2].trim() };
}
