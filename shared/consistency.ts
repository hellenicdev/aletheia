import { namedEntities } from "./citations";

export interface ContradictionCandidate {
  a: string;
  b: string;
  explanation: string;
}

/**
 * A model pair counts only when it quotes both sentences, they share an entity
 * and a time, and they are not two compatible parts of the same event.
 * Anything less stays out, so logic stays high when the model is unsure.
 */
export function acceptContradiction(
  item: ContradictionCandidate,
  claims: { id: string; text: string }[],
): boolean {
  const left = claims.find((claim) => claim.id === item.a);
  const right = claims.find((claim) => claim.id === item.b);
  if (!left || !right || left.id === right.id) return false;
  const explanation = item.explanation.replace(/\s+/g, " ").trim();
  if (explanation.length < 24) return false;
  if (!quotesSentence(explanation, left.text) || !quotesSentence(explanation, right.text)) return false;
  if (!sameEntityAndTime(left.text, right.text)) return false;
  if (compatibleParts(left.text, right.text)) return false;
  return true;
}

function quotesSentence(explanation: string, sentence: string): boolean {
  const haystack = normalize(explanation);
  const words = normalize(sentence).split(" ").filter(Boolean);
  if (words.length === 0) return false;
  const width = Math.min(4, words.length);
  if (width < 3 && words.join(" ").length < 12) return false;
  for (let index = 0; index <= words.length - width; index += 1) {
    const phrase = words.slice(index, index + width).join(" ");
    if (phrase.length >= 8 && haystack.includes(phrase)) return true;
  }
  return false;
}

function sameEntityAndTime(left: string, right: string): boolean {
  const yearsLeft = years(left);
  const yearsRight = years(right);
  if (yearsLeft.length > 0 && yearsRight.length > 0 && !yearsLeft.some((year) => yearsRight.includes(year))) {
    return false;
  }
  const agesLeft = ages(left);
  const agesRight = ages(right);
  if (agesLeft.length > 0 && agesRight.length > 0 && !agesLeft.some((age) => agesRight.includes(age))) {
    return false;
  }
  const entitiesLeft = namedEntities(left);
  const entitiesRight = namedEntities(right);
  if (entitiesLeft.length > 0 && entitiesRight.length > 0) {
    const shared = entitiesLeft.some((entity) =>
      entitiesRight.some((other) => entity === other || entity.includes(other) || other.includes(entity)),
    );
    if (!shared) return false;
  }
  return true;
}

/** "Some remain" and "others were raised" can both be true, as can two different wrecks. */
function compatibleParts(left: string, right: string): boolean {
  const part = /(?:^|[^\p{L}])(some|others|another|other|separate|separately|μερικά|μερικα|άλλα|αλλα|υπόλοιπα|υπολοιπα)(?=$|[^\p{L}])/iu;
  if (part.test(left) && part.test(right)) return true;
  const wreck = /(?:^|[^\p{L}])(wreck|shipwreck|ναυάγιο|ναυαγιο)(?=$|[^\p{L}])/iu;
  return wreck.test(left) && wreck.test(right) && !sameEntityAndTime(left, right);
}

function years(text: string): string[] {
  return [...text.matchAll(/\b(?:1[5-9]\d{2}|20\d{2})\b/g)].map((match) => match[0]);
}

function ages(text: string): number[] {
  const found: number[] = [];
  for (const match of text.matchAll(/\b(\d{1,2})[-\s]year[-\s]old\b/gi)) found.push(Number(match[1]));
  for (const match of text.matchAll(/\baged\s+(\d{1,2})\b/gi)) found.push(Number(match[1]));
  return found.filter((age) => age >= 1 && age <= 120);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
