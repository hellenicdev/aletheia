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
