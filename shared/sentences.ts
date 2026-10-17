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
  "gov",
  "lt",
  "col",
  "sgt",
  "capt",
  "cmdr",
  "adm",
  "rev",
  "hon",
  "pres",
  "vs",
  "etc",
  "eg",
  "ie",
  "e.g",
  "i.e",
  "us",
  "uk",
  "u.s",
  "u.k",
  "no",
  "vol",
  "fig",
  "al",
  "ed",
  "inc",
  "ltd",
  "co",
  "corp",
  "dept",
  "κ",
  "κα",
  "κος",
  "δρ",
  "πχ",
  "κλπ",
  "δηλ",
  "βλ",
  "αρ",
  "π.χ",
  "κ.λπ",
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

/** Deterministic sentence spans. The model classifies these; it does not copy the article. */
export function splitSentences(text: string): TextSpan[] {
  const spans: TextSpan[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "." && text[i + 1] === ".") {
      while (text[i + 1] === ".") i += 1;
      if (!followedByBreak(text, i)) continue;
      pushSpan(text, spans, start, i + 1);
      start = i + 1;
      continue;
    }
    if (!isBoundary(text, i)) continue;
    const end = i + 1;
    pushSpan(text, spans, start, end);
    start = end;
  }

  pushSpan(text, spans, start, text.length);
  return mergeFragments(text, spans.filter((span) => span.text.trim().length > 0));
}

function isBoundary(text: string, index: number): boolean {
  const ch = text[index];
  if (ch === "!" || ch === "?" || ch === "…" || ch === "\u037E") return followedByBreak(text, index);
  if (ch === ".") {
    if (/\d/.test(text[index - 1] ?? "") && /\d/.test(text[index + 1] ?? "")) return false;
    if (!followedByBreak(text, index)) return false;
    if (isAbbreviation(text, index)) return false;
    return true;
  }
  if ((ch === ";" || ch === "\u037E") && looksLikeGreekQuestion(text, index)) {
    return followedByBreak(text, index);
  }
  return false;
}

/** A period inside kathimerini.gr or https://www.bbc.com is not a sentence end. */
function followedByBreak(text: string, index: number): boolean {
  let cursor = index + 1;
  while (cursor < text.length && "\"'”’)]".includes(text[cursor])) cursor += 1;
  if (cursor >= text.length) return true;
  return /\s/.test(text[cursor]);
}

function looksLikeGreekQuestion(text: string, index: number): boolean {
  const window = text.slice(Math.max(0, index - 40), index);
  return /[\u0370-\u03FF]/.test(window);
}

function mergeFragments(text: string, spans: TextSpan[]): TextSpan[] {
  const merged: TextSpan[] = [];
  for (const span of spans) {
    const previous = merged[merged.length - 1];
    if (previous && isFragment(span.text)) {
      const end = span.end;
      merged[merged.length - 1] = {
        text: text.slice(previous.start, end).trim(),
        start: previous.start,
        end,
      };
      continue;
    }
    if (isFragment(span.text) && !previous) continue;
    merged.push(span);
  }
  return merged.filter((span) => span.text.trim().length >= 8);
}

function isFragment(value: string): boolean {
  const text = value.trim();
  if (text.length < 8) return true;
  if (/^["'“”’)\]]/.test(text) && text.length < 48) return true;
  if (/^(?:https?:\/\/|www\.)/i.test(text)) return true;
  if (/^[\w.-]+\.(?:gr|com|org|net|uk|eu)$/i.test(text)) return true;
  return false;
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
