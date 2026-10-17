import type { ClaimType } from "./labels";

const FACTUAL =
  /\b(?:located|completed|voted|according|percent|million|billion|capital|rescued|killed|issued|announced)\b|\b(?:ψήφισ|ανακοίνωσ|σκοτώ|διασώ)\p{L}*/iu;
const FACTUAL_FIGURE = /\b(?:1[89]|20)\d{2}\b|\d+(?:[.,]\d+)?\s*(?:%|€|\$|£)/;
const RHETORICAL =
  /\bwithout (?:a )?doubt\b|\bundoubtedly\b|\bbreathtaking\b|\bmost\b.{0,80}\bever\b|\b(?:fuck(?:ing)?|shit(?:ty)?|bastards?|pricks?|snivel(?:ing|ling)?|assholes?)\b|\bχωρίς αμφιβολία\b|\bαναμφίβολα\b|\bσυγκλονιστικ|\b(?:γαμ\p{L}*|σκατ\p{L}*|μαλακ\p{L}*)/iu;
const OPINION =
  /\b(?:i think|i believe|in my (?:view|opinion)|we should|they should|it seems to me|willingness to|ought to|deserves?|failure of|debilitating|it(?:'s| is) time to|the right thing|dump(?:ed|ing)? a|at a time of weakness)\b|\b(?:νομίζω|πιστεύω|θεωρώ|οφείλ\p{L}*)\b|κατά τη γνώμη|θα έπρεπε|είναι καιρός/iu;

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

/** Keep a local opinion or insult label when the model treated it as a fact. */
export function reconcileClaimType(text: string, model: ClaimType): ClaimType {
  const local = inferClaimType(text);
  if (local === "rhetorical" || local === "opinion") return local;
  if (local === "mixed" && model === "checkable_factual") return "mixed";
  return model;
}

const OPINION_PATH =
  /\/(?:opinions?|commentisfree|comments?|columns|columnists|op-eds?|oped|apopseis|gnomes|απόψεις|αποψεις|γνώμες|γνωμες)(?:\/|$)/iu;

const OPINION_KICKER =
  /(?:^|[\n|:—–])\s*(?:opinions?|commentisfree|columns|columnists|op-eds?|oped|apopseis|gnomes|απόψεις|αποψεις|γνώμες|γνωμες|δημόσιο\s+βήμα|δημοσιο\s+βημα)(?=$|[\n|:—–.,\s])/iu;

/** URL path or a section kicker, in English or Greek. A mention of "opinion" mid-sentence does not count. */
export function looksLikeOpinionSection(url: string | null, title: string | null, text: string): boolean {
  let path = "";
  if (url) {
    try {
      path = decodeURIComponent(new URL(url).pathname);
    } catch {
      path = url;
    }
  }
  if (OPINION_PATH.test(`/${path}`)) return true;
  const firstLine = text.split("\n")[0]?.slice(0, 180) ?? "";
  return OPINION_KICKER.test(`${title ?? ""}\n${firstLine}`);
}

/** A column, not a news story that quotes a few people. Needs several evaluative sentences. */
export function evaluativeDensity(texts: string[]): boolean {
  if (texts.length < 4) return false;
  const evaluative = texts.filter((text) => {
    const kind = inferClaimType(text);
    return kind === "opinion" || kind === "rhetorical";
  }).length;
  return evaluative >= 4 && evaluative / texts.length >= 0.4;
}
