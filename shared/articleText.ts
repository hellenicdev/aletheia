const MENU =
  /^(enable accessibility|see all newsletters|sign in|log in|subscribe|menu|home|world|politics|business|sport|opinion|culture|lifestyle|skip to|share|follow us|related|popular|most read|cookie|accept all|reject all|manage cookies|privacy preference|newsletter|get the onion newsletter)\b/i;

const COOKIE =
  /\b(cookies?|accept all|manage preferences|privacy preferences?|enable accessibility|see all newsletters|subscribe to (?:our|the) (?:newsletter|alerts|emails)|newsletters?|we use cookies|consent manager|privacy policy|by continuing to use this site|google tag manager|essential cookies|personalization engine|email alerts|manage consent|sign up for)\b/i;

const MENU_BLOB =
  /\b(?:Εκδόσεις|Reimagine Tourism|Our personalization engine|Get email alerts|Popular articles|Google Tag Manager|Essential cookies)\b/i;

const REFERENCE_HEADING =
  /^(?:references|sources|popular articles|related articles|you may also like|σχετικά άρθρα|διαβάστε επίσης)\b/i;

const DATELINE =
  /^(?:\d{1,2},\s+\d{4},\s+in\s+\p{Lu}[\p{L} .'-]{1,48}\.?|(?:[\p{Lu}][\p{L} .'-]{0,40},\s+)?(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+\d{1,2},?\s+\d{4}\b.*)$/u;

const PHOTO_CREDIT =
  /^(?:photograph|photo|image|caption|credit|φωτογραφία|εικόνα|πηγή)\s*[:：]|^\(?\s*(?:AP|Reuters|AFP|Getty)\s+Photo\b|^Getty Images\b/i;

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
  if (value.length < 25) return true;
  if (MENU.test(value)) return true;
  if (isDateline(value) || isPhotoCredit(value)) return true;
  if (COOKIE.test(value) && value.length < 700) return true;
  if (/^https?:\/\//i.test(value)) return true;
  return false;
}

export function cleanArticleText(raw: string): string {
  const lines = stripCredits(raw).replace(/\r\n/g, "\n").split("\n");
  const seenLines = new Set<string>();
  let droppingReferences = false;
  let keptProse = false;
  const kept = lines.filter((line) => {
    const trimmed = line.trim();
    if (keptProse && REFERENCE_HEADING.test(trimmed)) {
      droppingReferences = true;
      return false;
    }
    if (droppingReferences) {
      if (proseWeight(trimmed) >= 12 && /[.!?…]/.test(trimmed) && !MENU_BLOB.test(trimmed)) {
        droppingReferences = false;
      } else {
        return false;
      }
    }
    if (looksLikeBoilerplate(line)) return false;
    const key = line.replace(/\s+/g, " ").trim().toLowerCase();
    if (!key) return true;
    if (seenLines.has(key)) return false;
    seenLines.add(key);
    if (proseWeight(key) >= 12) keptProse = true;
    return true;
  });
  const paragraphs = kept
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
  return unique.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
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

function looksLikeBoilerplate(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
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

function proseWeight(paragraph: string): number {
  const words = paragraph.split(/\s+/).filter(Boolean);
  if (words.length < 8 && !/[.!?…]/.test(paragraph)) return 0;
  const links = (paragraph.match(/https?:\/\//gi) || []).length;
  return Math.max(0, words.length - links * 8);
}
