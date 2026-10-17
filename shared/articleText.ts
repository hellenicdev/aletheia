const MENU =
  /^(enable accessibility|see all newsletters|sign in|log in|subscribe|menu|home|world|politics|business|sport|opinion|culture|lifestyle|skip to|share|follow us|related|popular|most read|cookie|accept all|reject all|manage cookies|privacy preference|newsletter)\b/i;

const COOKIE =
  /\b(cookie|accept all|manage preferences|privacy preference|enable accessibility|see all newsletters|subscribe to our newsletter)\b/i;

export function cleanArticleText(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const kept = lines.filter((line) => !looksLikeBoilerplate(line));
  const paragraphs = kept
    .join("\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim())
    .filter((paragraph) => paragraph && !looksLikeBoilerplate(paragraph));
  const start = paragraphs.findIndex((paragraph) => proseWeight(paragraph) >= 12);
  const body = (start >= 0 ? paragraphs.slice(start) : paragraphs).filter(
    (paragraph) => proseWeight(paragraph) > 0 || paragraph.length > 80,
  );
  return body.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function proseScore(text: string): number {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => proseWeight(paragraph))
    .reduce((sum, weight) => sum + weight, 0);
}

function looksLikeBoilerplate(line: string): boolean {
  const text = line.trim();
  if (!text) return false;
  if (MENU.test(text)) return true;
  if (COOKIE.test(text) && text.length < 500) return true;
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
