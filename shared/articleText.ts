const MENU =
  /^(enable accessibility|see all newsletters|sign in|log in|subscribe|menu|home|world|politics|business|sport|opinion|culture|lifestyle|skip to|share|follow us|related|popular|most read|cookie|accept all|reject all|manage cookies|privacy preference|newsletter|get the onion newsletter)\b/i;

const COOKIE =
  /\b(cookies?|accept all|manage preferences|privacy preferences?|enable accessibility|see all newsletters|subscribe to (?:our|the) (?:newsletter|alerts|emails)|newsletters?|we use cookies|consent manager|privacy policy|by continuing to use this site|google tag manager|essential cookies|personalization engine|email alerts|manage consent|sign up for)\b/i;

const MENU_BLOB =
  /\b(?:Εκδόσεις|Reimagine Tourism|Our personalization engine|Get email alerts|Popular articles|Google Tag Manager|Essential cookies)\b/i;

const REFERENCE_HEADING =
  /^(?:references|sources|popular articles|related articles|related stories|related posts|you may also like|you might also like|read more|also read|more stories|more from|trending|end of article|about the author|σχετικά άρθρα|σχετικά θέματα|διαβάστε επίσης|διαβάστε περισσότερα|δείτε επίσης|περισσότερα άρθρα)$/iu;

/** Short end-of-article labels. A long sentence that merely contains one of these words is kept. */
const RELATED_MARKERS = [
  "related",
  "related stories",
  "related articles",
  "related posts",
  "more on this story",
  "more from",
  "more stories",
  "most read",
  "most popular",
  "read more",
  "top stories",
  "you may also like",
  "you might also like",
  "recommended",
  "recommended for you",
  "sign up",
  "διαβάστε επίσης",
  "διαβάστε περισσότερα",
  "σχετικά άρθρα",
  "σχετικά θέματα",
  "περισσότερα",
  "περισσότερα άρθρα",
  "τα πιο διαβασμένα",
  "δείτε ακόμα",
  "δείτε επίσης",
];

const SECTION_LABEL =
  /^(?:opinion|opinions|comment|άποψη|αποψη|σχόλιο|σχολιο|απόψεις|αποψεις|γνώμες|γνωμες|δημόσιο βήμα|δημοσιο βημα|αρθρογραφία|αρθρογραφια)$/iu;

const DATELINE =
  /^(?:\d{1,2},\s+\d{4},\s+in\s+\p{Lu}[\p{L} .'-]{1,48}\.?|(?:[\p{Lu}][\p{L} .'-]{0,40},\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}\b.*)$/u;

const PHOTO_CREDIT =
  /^(?:photograph|photo|image|caption|credit|φωτογραφία|εικόνα|πηγή)\s*[:：]|^\(?\s*(?:AP|Reuters|AFP|Getty)\s+Photo\b|^Getty Images\b/i;

const GLUED_PROMO =
  /^.{0,60}?\b(?:decentralize|brighteon)\.tv\b.{0,40}?\bepisode\s*\d+\b(?:\s*[|–—:-]\s*[^\s.]{0,40})?\s*/i;

/** Remove episode, promo, and show-title lines before sentences are split. */
export function stripPromoItems(raw: string): string {
  return raw
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      const stripped = stripLeadingShow(trimmed);
      if (stripped !== trimmed) {
        const rest = stripped.trim();
        if (!rest || isPromoLine(rest)) return "";
        return rest;
      }
      if (isPromoLine(trimmed)) return "";
      return line;
    })
    .join("\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function stripLeadingShow(line: string): string {
  const glued = line.match(GLUED_PROMO);
  if (glued && glued[0].length < line.length) return line.slice(glued[0].length);
  const brand = line.match(/^(?:decentralize|brighteon)\.tv\b\s*(?:[|–—:-]\s*)?/i);
  if (!brand || brand[0].length >= line.length) return line;
  const rest = line.slice(brand[0].length).trim();
  if (
    rest.split(/\s+/).length >= 8 &&
    /\b(received|according|said|voted|announced|reported|published|signed|released)\b/i.test(rest)
  ) {
    return rest;
  }
  return line;
}

function isPromoLine(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return false;
  const words = value.split(/\s+/);
  if (/\b(?:decentralize|brighteon)\.tv\b/i.test(value) && words.length <= 40) return true;
  if (words.length > 40) return false;
  if (!/\bepisode\s*\d+\b/i.test(value)) return false;
  const early = words.slice(0, 4).join(" ");
  if (/\bepisode\s*\d+\b/i.test(early)) return true;
  return !/\b(was|were|is|are|said|says|discussed|voted|will|have|has|had|produced|lasted|during)\b/i.test(value);
}

export function stripCredits(raw: string): string {
  return raw
    .replace(/\s*\((?:AP|Reuters|AFP|Getty)\s+Photo\/[^)]{0,160}\)/gi, "")
    .replace(/\s*(?:Photograph|Photo|Image|Caption|Φωτογραφία|Εικόνα)\s*:\s*[^.!?\n]{0,180}/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Fragments that are not claims: crumbs, datelines, credits, cookie copy, and very short lines. */
export function isSkippableFragment(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return true;
  if (SECTION_LABEL.test(value)) return true;
  if (isPromoLine(value)) return true;
  if (isLinkTitle(value)) return true;
  if (value.length < 25) return true;
  if (MENU.test(value)) return true;
  if (isDateline(value) || isPhotoCredit(value)) return true;
  if (COOKIE.test(value) && value.length < 700) return true;
  if (/^https?:\/\//i.test(value)) return true;
  return false;
}

export interface ArticleCleanup {
  text: string;
  /** Non-empty lines removed as page navigation or related headlines. */
  ignoredLines: number;
}

export function cleanArticleText(raw: string): string {
  return cleanupArticle(raw).text;
}

export function cleanupArticle(raw: string): ArticleCleanup {
  const lines = stripPromoItems(stripCredits(raw)).replace(/\r\n/g, "\n").split("\n");
  const seenLines = new Set<string>();
  let droppingTail = false;
  let keptProse = false;
  let ignoredLines = 0;
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (keptProse && isRelatedHeading(trimmed) && tailIsRelated(lines.slice(index + 1))) {
      droppingTail = true;
    }
    if (droppingTail) {
      if (trimmed) ignoredLines += 1;
      continue;
    }
    if (keptProse && isRelatedHeading(trimmed)) {
      if (trimmed) ignoredLines += 1;
      continue;
    }
    if (isPromoLine(trimmed) || isLinkTitle(trimmed)) {
      if (trimmed && isLinkTitle(trimmed)) ignoredLines += 1;
      continue;
    }
    if (looksLikeBoilerplate(line)) {
      if (trimmed && trimmed.length < 160 && !/[.!?…]$/.test(trimmed)) ignoredLines += 1;
      continue;
    }
    const key = line.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key) {
      kept.push(line);
      continue;
    }
    if (seenLines.has(key)) continue;
    seenLines.add(key);
    if (proseWeight(key) >= 12) keptProse = true;
    kept.push(line);
  }
  const trimmedTail = dropTrailingHeadlineRun(kept);
  ignoredLines += trimmedTail.dropped;
  const paragraphs = trimmedTail.lines
    .join("\n")
    .split(/\n{2,}/)
    .map((paragraph) => stripGluedMenu(paragraph.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim()))
    .filter((paragraph) => paragraph && !looksLikeBoilerplate(paragraph));
  const start = paragraphs.findIndex((paragraph) => proseWeight(paragraph) >= 12);
  const body = (start >= 0 ? paragraphs.slice(start) : paragraphs).filter(
    (paragraph) => proseWeight(paragraph) > 0 || paragraph.length > 80,
  );
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const paragraph of body) {
    const key = paragraph.replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(paragraph);
  }
  return {
    text: unique.join("\n\n").replace(/\n{3,}/g, "\n\n").trim(),
    ignoredLines,
  };
}

function isRelatedHeading(line: string): boolean {
  if (REFERENCE_HEADING.test(line.trim())) return true;
  const stripped = line
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[\s>*•\-–—]+/, "")
    .trim();
  if (!stripped || stripped.length > 90 || /[.!?…]/.test(stripped)) return false;
  const value = stripped.replace(/[:：]\s*$/, "").replace(/\s+/g, " ").trim().toLowerCase();
  const words = value.split(" ");
  if (words.length > 8) return false;
  return RELATED_MARKERS.some((marker) => value === marker || value.startsWith(`${marker} `));
}

function tailIsRelated(rest: string[]): boolean {
  const upcoming = rest.map((line) => line.trim()).filter(Boolean).slice(0, 8);
  if (upcoming.length === 0) return true;
  const longProse = upcoming.filter((line) => line.split(/\s+/).length >= 22 && /[.!?…]/.test(line));
  return longProse.length === 0;
}

function dropTrailingHeadlineRun(lines: string[]): { lines: string[]; dropped: number } {
  let index = lines.length - 1;
  while (index >= 0 && !lines[index].trim()) index -= 1;
  let run = 0;
  let cursor = index;
  while (cursor >= 0) {
    const trimmed = lines[cursor].trim();
    if (!trimmed) {
      cursor -= 1;
      continue;
    }
    if (!isTrailingCard(trimmed)) break;
    run += 1;
    cursor -= 1;
  }
  const proseBefore = lines.slice(0, cursor + 1).some((line) => proseWeight(line) >= 12 || /[.!?…]$/.test(line.trim()));
  if (run < 3 || !proseBefore) return { lines, dropped: 0 };
  return { lines: lines.slice(0, cursor + 1), dropped: run };
}

/** A short end-of-page line with no closing punctuation: a headline, a tag, or a link title. */
function isTrailingCard(line: string): boolean {
  const value = line.trim();
  if (!value || value.length > 160 || /[.!?…]$/.test(value)) return false;
  if (/^[\p{Ll}]/u.test(value)) return false;
  const words = value.split(/\s+/);
  return words.length >= 1 && words.length <= 18;
}

export function proseScore(text: string): number {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => proseWeight(paragraph))
    .reduce((sum, weight) => sum + weight, 0);
}

function stripGluedMenu(paragraph: string): string {
  const cut = paragraph.search(MENU_BLOB);
  if (cut < 0) return paragraph;
  if (cut >= 40) return paragraph.slice(0, cut).trim();
  return "";
}

function isDateline(text: string): boolean {
  const value = text.trim();
  if (value.length > 90) return false;
  return DATELINE.test(value);
}

function isPhotoCredit(text: string): boolean {
  return PHOTO_CREDIT.test(text.trim());
}

function isLinkTitle(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return false;
  if (isPromoLine(value)) return true;
  if (value.length > 120 || value.length < 12) return false;
  if (!/[–—|:]/.test(value)) return false;
  if (/,/.test(value)) return false;
  if (/[.!?]/.test(value.slice(0, -1))) return false;
  if (/\b(was|were|is|are|said|says|voted|will|have|has|had|ανακοίνωσε|είπε|δήλωσε)\b/iu.test(value)) {
    return false;
  }
  return value.split(/\s+/).length <= 10;
}

function looksLikeBoilerplate(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (SECTION_LABEL.test(text)) return false;
  if (isLinkTitle(text)) return true;
  if (MENU.test(text)) return true;
  if (isDateline(text) || isPhotoCredit(text)) return true;
  if (text.length < 25) return true;
  if (COOKIE.test(text) && text.length < 700 && text.search(COOKIE) < 40) return true;
  if (MENU_BLOB.test(text) && text.length < 700 && text.search(MENU_BLOB) < 40) return true;
  if (/^https?:\/\//i.test(text)) return true;
  if (/\.(png|jpe?g|webp|gif|svg)(\?|\s|$)/i.test(text) && text.length < 160) return true;
  if ((text.match(/https?:\/\//gi) || []).length >= 2 && text.length < 280) return true;
  if (text.length < 40 && !/[.!?…]/.test(text) && !/[\u0370-\u03FF];/.test(text)) return true;
  const words = text.split(/\s+/);
  if (words.length >= 6 && !/[.!?…]/.test(text) && words.filter((word) => word.length <= 14).length / words.length > 0.85) {
    return true;
  }
  return false;
}

const STOP_WORDS = new Set([
  "that", "this", "with", "from", "have", "were", "been", "their", "about", "after", "which", "would",
  "could", "there", "these", "those", "into", "over", "under", "than", "then", "also", "said", "says",
  "will", "just", "more", "some", "such", "only", "other", "when", "what", "your", "they", "them",
  "και", "που", "για", "από", "στο", "στη", "στην", "τον", "την", "της", "του", "των",
]);

export function isMarkdownLinkLine(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value) return false;
  if (/^\[[^\]]+\]\([^)]+\)$/.test(value)) return true;
  const stripped = value.replace(/\[[^\]]+\]\([^)]+\)/g, "").replace(/https?:\/\/\S+/g, "").trim();
  return value.includes("](") && stripped.length < 12;
}

/** A heading or link line, not a sentence. Sentences keep their closing punctuation. */
export function isHeadlineOnlyLine(text: string): boolean {
  const value = text.replace(/^#{1,6}\s*/, "").replace(/\s+/g, " ").trim();
  if (!value || value.length > 140 || /[.!?…]/.test(value)) return false;
  if (isMarkdownLinkLine(value) || /^https?:\/\//i.test(value)) return true;
  const words = value.split(/\s+/);
  if (words.length < 2 || words.length > 16) return false;
  const significant = words.filter((word) => word.length > 3);
  if (significant.length < 2) return false;
  const titled = significant.filter((word) => /^[\p{Lu}]/u.test(word)).length;
  return titled / significant.length >= 0.6;
}

function isLooseHeadline(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (!value || value.length > 140 || /[.!?…]/.test(value) || /,/.test(value)) return false;
  const words = value.split(/\s+/);
  if (words.length < 2 || words.length > 14) return false;
  return !/\b(was|were|is|are|said|says|will|have|has|had|είπε|δήλωσε|ανακοίνωσε|είναι|ήταν)\b/iu.test(value);
}

function keywordsOf(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  return new Set(words.filter((word) => !STOP_WORDS.has(word)));
}

function keywordOverlap(text: string, context: Set<string>): number {
  const words = keywordsOf(text);
  if (words.size === 0 || context.size === 0) return 0;
  let shared = 0;
  for (const word of words) if (context.has(word)) shared += 1;
  return shared / words.size;
}

/**
 * Drop markdown links, headline-only lines, and short off-topic lines near the
 * end of the article. Sentences in the lede stay even when their wording is new.
 */
export function filterClaimSpans<T extends { text: string; start: number; end: number }>(
  spans: T[],
  title: string | null,
  article: string,
): { spans: T[]; ignored: number } {
  const context = keywordsOf(`${title ?? ""}\n${article.slice(0, 700)}`);
  const cutoff = article.length * 0.72;
  const kept: T[] = [];
  let ignored = 0;
  spans.forEach((span, index) => {
    const text = span.text.replace(/\s+/g, " ").trim();
    if (isMarkdownLinkLine(text) || isHeadlineOnlyLine(text)) {
      ignored += 1;
      return;
    }
    const nearEnd = span.start >= cutoff && index >= 2;
    if (nearEnd && isLooseHeadline(text) && keywordOverlap(text, context) < 0.2) {
      ignored += 1;
      return;
    }
    kept.push(span);
  });
  return { spans: kept, ignored };
}

function proseWeight(paragraph: string): number {
  const words = paragraph.split(/\s+/).filter(Boolean);
  if (words.length < 8 && !/[.!?…]/.test(paragraph)) return 0;
  const links = (paragraph.match(/https?:\/\//gi) || []).length;
  return Math.max(0, words.length - links * 8);
}
