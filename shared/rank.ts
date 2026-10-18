/** Higher importance first, then earlier text, then the claim itself. Equal scores do not depend on insertion order. */
export function compareClaims(
  a: { importance: number; start: number; text: string },
  b: { importance: number; start: number; text: string },
): number {
  if (a.importance !== b.importance) return b.importance - a.importance;
  if (a.start !== b.start) return a.start - b.start;
  if (a.text < b.text) return -1;
  if (a.text > b.text) return 1;
  return 0;
}

export function claimImportance(text: string, title: string | null, index: number): number {
  let score = 0;
  if (/\d/.test(text)) score += 4;
  if (/(?:%|€|\$|£)|\b(?:million|billion|thousand|εκατομμ\p{L}*|δισ\p{L}*|χιλιάδ\p{L}*)/iu.test(text)) {
    score += 3;
  }
  if (/\b(?:1[5-9]|20)\d{2}\b/.test(text)) score += 2;
  if (title && tokenOverlap(text, title) >= 0.34) score += 5;
  if (index < 2) score += 2;
  const names = text.match(/\b[\p{Lu}][\p{L}'’-]{2,}/gu) ?? [];
  if (names.length >= 1) score += 2;
  if (/\b(?:because|caused|according to|επειδή|προκάλεσε|σύμφωνα)\b/iu.test(text)) score += 1;
  if (text.trim().length < 45) score -= 2;
  if (/^["'“”].{0,50}\b(?:says|said|λέει|είπε)\b/iu.test(text.trim())) score -= 2;
  return score;
}

/**
 * Keep a headline in the searchable set. Later sentences can outrank it on
 * figures; the title claim is still searched first.
 */
export function pinHeadlineFirst<T extends { text: string; start: number; importance: number }>(
  segments: T[],
  title: string | null,
  limit: number,
): T[] {
  const ranked = [...segments].sort(compareClaims);
  const headline = headlineSegment(segments, title);
  if (!headline) return ranked.slice(0, limit);
  const rest = ranked.filter((segment) => segment !== headline);
  return [headline, ...rest].slice(0, limit);
}

function headlineSegment<T extends { text: string; start: number }>(
  segments: T[],
  title: string | null,
): T | null {
  if (!title || !title.trim()) return null;
  const ordered = [...segments].sort((a, b) => a.start - b.start);
  return ordered.find((segment) => matchesTitle(segment.text, title)) ?? null;
}

function matchesTitle(text: string, title: string): boolean {
  if (tokenOverlap(text, title) >= 0.34 || tokenOverlap(title, text) >= 0.6) return true;
  const left = text.replace(/\s+/g, " ").trim().toLowerCase();
  const right = title.replace(/\s+/g, " ").trim().toLowerCase();
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left);
}

export function tokenOverlap(left: string, right: string): number {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let hit = 0;
  for (const token of a) if (b.has(token)) hit += 1;
  return hit / a.size;
}

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((token) => token.length > 3),
  );
}
