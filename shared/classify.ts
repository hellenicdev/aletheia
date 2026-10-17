import type { ClaimType } from "./labels";

const FACTUAL =
  /\b(?:located|completed|voted|according|percent|million|billion|capital|rescued|killed|issued|announced)\b|\b(?:ψήφισ|ανακοίνωσ|σκοτώ|διασώ)\p{L}*/iu;
const FACTUAL_FIGURE = /\b(?:1[89]|20)\d{2}\b|\d+(?:[.,]\d+)?\s*(?:%|€|\$|£)/;
const RHETORICAL =
  /\bwithout (?:a )?doubt\b|\bundoubtedly\b|\bbreathtaking\b|\bmost\b.{0,80}\bever\b|\b(?:fuck(?:ing)?|shit|bastard|prick)\b|\bχωρίς αμφιβολία\b|\bαναμφίβολα\b|\bσυγκλονιστικ|\b(?:γαμ\p{L}*|σκατ\p{L}*|μαλακ\p{L}*)/iu;
const OPINION =
  /\b(?:i think|i believe|in my (?:view|opinion)|we should|it seems to me)\b|\b(?:νομίζω|πιστεύω|θεωρώ)\b|κατά τη γνώμη|θα έπρεπε/iu;

/**
 * Used only when the model did not classify a sentence. Factual anchors win
 * over tone, so a dated claim is not treated as rhetoric.
 */
export function inferClaimType(text: string): ClaimType {
  const value = text.replace(/\s+/g, " ").trim();
  const factual = FACTUAL.test(value) || FACTUAL_FIGURE.test(value);
  const rhetorical = RHETORICAL.test(value);
  const opinion = OPINION.test(value);
  if ((rhetorical || opinion) && factual) return "mixed";
  if (rhetorical) return "rhetorical";
  if (opinion) return "opinion";
  return "checkable_factual";
}
