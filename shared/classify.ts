import type { ClaimType } from "./labels";

const FACTUAL =
  /\b(?:located|completed|voted|according|percent|million|billion|capital)\b|\b(?:1[89]|20)\d{2}\b|\d+(?:[.,]\d+)?\s*(?:%|€|\$|£)/i;
const RHETORICAL =
  /\bwithout (?:a )?doubt\b|\bundoubtedly\b|\bbreathtaking\b|\bmost\b.{0,80}\bever\b|\bχωρίς αμφιβολία\b|\bαναμφίβολα\b|\bσυγκλονιστικ/i;
const OPINION =
  /\b(?:i think|i believe|in my (?:view|opinion)|we should)\b|\b(?:νομίζω|πιστεύω)\b|κατά τη γνώμη/i;

/**
 * Used only when the model did not classify a sentence. Factual anchors win
 * over tone, so a dated claim is not treated as rhetoric.
 */
export function inferClaimType(text: string): ClaimType {
  const value = text.replace(/\s+/g, " ").trim();
  const factual = FACTUAL.test(value);
  const rhetorical = RHETORICAL.test(value);
  const opinion = OPINION.test(value);
  if ((rhetorical || opinion) && factual) return "mixed";
  if (rhetorical) return "rhetorical";
  if (opinion) return "opinion";
  return "checkable_factual";
}
