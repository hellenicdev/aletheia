import type { DetectedLanguage } from "./labels";

const GREEK = /[\u0370-\u03FF]/;

const QUERY_STOP = new Set([
  "the", "a", "an", "of", "and", "to", "in", "for", "on", "with", "that", "this", "was", "were",
  "are", "is", "from", "by", "at", "as", "or", "be", "it", "its", "their", "his", "her", "she",
  "he", "they", "who", "which", "into", "than", "after", "before", "when", "now", "but",
  "ο", "η", "το", "του", "της", "των", "και", "να", "σε", "με", "για", "από", "στο", "στη",
  "στην", "στον", "που", "είναι", "ήταν", "θα", "δεν", "μια", "ένα", "ένας", "την", "τον",
  "τις", "τους", "τα", "οι", "ως", "ή",
]);

const LEADING_STOP = new Set([
  "the", "a", "an", "when", "now", "this", "that", "these", "those", "but", "and", "for", "with",
  "from", "after", "before", "during", "while", "if", "in", "on", "at", "of", "to", "by", "as",
  "or", "two", "one", "three",
]);

/** Keep a query short without dropping the entity or the figure that identifies the claim. */
export function boundQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 12).join(" ").slice(0, 180);
}

/**
 * Retrieval is unstable when the model drops the number or switches a Greek
 * claim into English. Put the named entity and any figure first, and rebuild
 * a Greek claim from its own words when the model query has none.
 */
export function stabilizeQuery(query: string, claim: string, language: DetectedLanguage): string {
  const wantGreek = language === "el" || GREEK.test(claim);
  let next = query.replace(/\s+/g, " ").trim();
  if (!next || (wantGreek && !GREEK.test(next))) next = claimTokens(claim);

  const required: string[] = [];
  const entity = firstMissingEntity(next, claim);
  if (entity) required.push(...entity.split(/\s+/));
  for (const figure of missingFigures(next, claim)) required.push(...figure.split(/\s+/));

  const seen = new Set(required.map((word) => word.toLowerCase()));
  const rest = next.split(/\s+/).filter((word) => word && !seen.has(word.toLowerCase()));
  return boundQuery([...required, ...rest].join(" "));
}

function claimTokens(claim: string): string {
  return claim
    .replace(/[^\p{L}\p{N}%.,\s-]/gu, " ")
    .split(/\s+/)
    .filter((token) => token && !QUERY_STOP.has(token.toLowerCase()))
    .slice(0, 12)
    .join(" ");
}

function missingFigures(query: string, claim: string): string[] {
  const missing: string[] = [];
  for (const match of claim.matchAll(/\d+(?:[.,]\d+)?(?:\s*(?:%|percent|per cent|million|billion|εκατομμύρια))?/giu)) {
    const raw = match[0].replace(/\s+/g, " ").trim();
    const digits = raw.match(/\d+(?:[.,]\d+)?/)?.[0] ?? "";
    if (!digits) continue;
    const forms = new Set([digits, digits.replace(",", "."), digits.replace(".", ",")]);
    if ([...forms].some((form) => query.includes(form))) continue;
    missing.push(raw);
  }
  return missing;
}

function firstMissingEntity(query: string, claim: string): string | null {
  const haystack = query.toLowerCase();
  const re = /[\p{Lu}][\p{L}'’.-]{2,}(?:\s+[\p{Lu}][\p{L}'’.-]{2,}){0,2}/gu;
  for (const match of claim.matchAll(re)) {
    const words = match[0].split(/\s+/).filter((word) => !LEADING_STOP.has(word.toLowerCase()));
    if (words.length === 0) continue;
    const present = words.some((word) => word.length >= 3 && haystack.includes(word.toLowerCase()));
    if (!present) return words.join(" ");
  }
  return null;
}
