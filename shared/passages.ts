/**
 * A longer evidence window around the claim's figures and names.
 * Search snippets are short; the number often sits later in the page text
 * the provider already returned.
 */
const PASSAGE_LIMIT = 1500;
const BEFORE = 160;
const AFTER = 520;

const WORD_DIGIT: Record<string, string> = {
  two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8",
  nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14",
  fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19",
  twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60", seventy: "70",
  eighty: "80", ninety: "90", hundred: "100",
  δύο: "2", δυο: "2", τρία: "3", δεκαέξι: "16", είκοσι: "20",
};

const MAGNITUDE =
  /^(?:million|billion|thousand|percent|miles|mile|kilometres|kilometers|rescued|vape|vapes|vaping|εκατομμύρια|μίλια|ναυάγιο)$/iu;

/** True when the page text is missing a figure that appears in the claim. */
export function passageMissesFigure(claim: string, page: string): boolean {
  const groups = figureGroups(claim);
  if (groups.length === 0) return false;
  return groups.some((forms) => forms.every((form) => indexOfNeedle(page, form) < 0));
}

/** True when `after` contains a claim figure that `before` does not. */
export function passageAddsFigure(claim: string, before: string, after: string): boolean {
  return figureGroups(claim).some(
    (forms) =>
      forms.every((form) => indexOfNeedle(before, form) < 0) &&
      forms.some((form) => indexOfNeedle(after, form) >= 0),
  );
}

export function focusPassage(claim: string, page: string, limit = PASSAGE_LIMIT): string | null {
  const text = page.replace(/\s+/g, " ").trim();
  if (text.length < 40) return null;
  const needles = passageNeedles(claim);
  if (needles.length === 0) return null;
  const hits: { at: number; len: number; numeric: boolean }[] = [];
  for (const needle of needles) {
    const at = indexOfNeedle(text, needle);
    if (at < 0) continue;
    hits.push({ at, len: needle.length, numeric: /\d/.test(needle) });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => Number(b.numeric) - Number(a.numeric) || b.len - a.len || a.at - b.at);
  const ranges: { start: number; end: number }[] = [];
  for (const hit of hits.slice(0, 3)) {
    ranges.push({
      start: Math.max(0, hit.at - BEFORE),
      end: Math.min(text.length, hit.at + hit.len + AFTER),
    });
  }
  ranges.sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 48) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  let out = "";
  for (const range of merged) {
    const piece = text.slice(range.start, range.end).trim();
    if (!piece) continue;
    const next = out ? `${out} … ${piece}` : piece;
    if (next.length > limit) {
      const room = limit - (out ? out.length + 3 : 0);
      if (room > 60) out = `${out}${out ? " … " : ""}${piece.slice(0, room).trim()}`;
      break;
    }
    out = next;
  }
  return out || null;
}

function figureGroups(claim: string): string[][] {
  const groups: string[][] = [];
  for (const match of claim.matchAll(/\d+(?:[.,]\d+)?/g)) {
    const forms = [match[0]];
    if (match[0].includes(".")) forms.push(match[0].replace(".", ","));
    if (match[0].includes(",")) forms.push(match[0].replace(",", "."));
    groups.push(forms);
  }
  for (const match of claim.matchAll(/[\p{L}]{3,}/gu)) {
    const digit = WORD_DIGIT[match[0].toLowerCase()];
    if (!digit) continue;
    groups.push([match[0], digit]);
  }
  return groups;
}

function passageNeedles(claim: string): string[] {
  const found: string[] = [];
  const push = (value: string) => {
    const needle = value.trim();
    if (needle.length < 2) return;
    if (found.some((item) => item.toLowerCase() === needle.toLowerCase())) return;
    found.push(needle);
  };
  for (const match of claim.matchAll(/\d+(?:[.,]\d+)?/g)) {
    push(match[0]);
    if (match[0].includes(".")) push(match[0].replace(".", ","));
    if (match[0].includes(",")) push(match[0].replace(",", "."));
  }
  for (const match of claim.matchAll(/[\p{L}]{3,}/gu)) {
    const word = match[0];
    const digit = WORD_DIGIT[word.toLowerCase()];
    if (digit) {
      push(word);
      push(digit);
    } else if (MAGNITUDE.test(word) || /^[\p{Lu}]/u.test(word)) {
      push(word);
    }
  }
  return found;
}

/** "16" must not match inside 2016. */
function indexOfNeedle(haystack: string, needle: string): number {
  const lower = haystack.toLowerCase();
  const target = needle.toLowerCase();
  const numeric = /\d/.test(target);
  let from = 0;
  while (from < lower.length) {
    const at = lower.indexOf(target, from);
    if (at < 0) return -1;
    if (numeric) {
      const before = lower[at - 1] ?? "";
      const after = lower[at + target.length] ?? "";
      if (/\d/.test(before) || /\d/.test(after)) {
        from = at + 1;
        continue;
      }
    }
    return at;
  }
  return -1;
}
