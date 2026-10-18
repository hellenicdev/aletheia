import type { ClaimType } from "./labels";

const FACTUAL =
  /\b(?:located|completed|voted|according|percent|million|billion|capital|rescued|killed|issued|announced)\b|\b(?:ψήφισ|ανακοίνωσ|σκοτώ|διασώ)\p{L}*/iu;
const FACTUAL_FIGURE = /\b(?:1[89]|20)\d{2}\b|\d+(?:[.,]\d+)?\s*(?:%|€|\$|£)/;
const DATE_FILLER =
  /\b(?:check|look at|mark) the calendar\b|\bit is (?:now |already )?(?:19|20)\d{2}\b|\bthe year is (?:19|20)\d{2}\b|\bas of (?:19|20)\d{2}\b|ημερολόγι\p{L}*|είναι(?:\s+\p{L}+){0,2}\s+(?:το\s+)?(?:19|20)\d{2}/iu;
const RHETORICAL =
  /\bwithout (?:a )?doubt\b|\bundoubtedly\b|\bbreathtaking\b|\bmost\b.{0,80}\bever\b|\b(?:fuck(?:ing)?|shit(?:ty)?|bastards?|pricks?|snivel(?:ing|ling)?|assholes?)\b|\bχωρίς αμφιβολία\b|\bαναμφίβολα\b|\bσυγκλονιστικ|\b(?:γαμ\p{L}*|σκατ\p{L}*|μαλακ\p{L}*)/iu;
const OPINION =
  /\b(?:i think|i believe|in my (?:view|opinion)|we should|they should|it seems to me|willingness to|ought to|deserves?|failure of|debilitating|it(?:'s| is) time to|the right thing|dump(?:ed|ing)? a|at a time of weakness)\b|\b(?:νομίζω|πιστεύω|θεωρώ|οφείλ\p{L}*)\b|κατά τη γνώμη|θα έπρεπε|είναι καιρός/iu;

/**
 * Used only when the model did not classify a sentence. Factual anchors win
 * over tone, so a dated claim is not treated as rhetoric.
 */
const ATTRIBUTED =
  /(?:^|[^\p{L}])(?:said|says|told|according to|reported that|wrote that|είπε|δήλωσε|ανέφερε|σύμφωνα με)(?=$|[^\p{L}])/iu;

/** A reported quote is the speaker's claim, not the author's opinion. */
export function isAttributedClaim(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (ATTRIBUTED.test(value)) return true;
  const quoted = value.match(/["“«]([^"”»]{12,})["”»]/);
  return Boolean(quoted && quoted[1].length >= value.length * 0.45);
}

/**
 * A calendar aside or a sentence whose only fact is the year. "But check the
 * calendar and it is 2026" is not a news claim.
 */
export function isDateFiller(text: string): boolean {
  const value = text.replace(/\s+/g, " ").trim();
  if (!DATE_FILLER.test(value) && !/^\W*(?:it is|it's|today is|the year is)\b/i.test(value)) return false;
  const stripped = value
    .replace(DATE_FILLER, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b(?:it|is|the|and|but|now|already|year|today|check|calendar|look|at|date|time|είναι|το|και|αλλά|ήδη|έτος|σήμερα|ημερολόγιο)\b/giu, " ");
  const words = stripped
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 3);
  return words.length <= 2;
}

export function inferClaimType(text: string): ClaimType {
  const value = text.replace(/\s+/g, " ").trim();
  if (isDateFiller(value)) return "rhetorical";
  const factual = FACTUAL.test(value) || FACTUAL_FIGURE.test(value);
  const rhetorical = RHETORICAL.test(value);
  const opinion = OPINION.test(value) && !isAttributedClaim(value);
  if (isAttributedClaim(value)) {
    if (rhetorical && !factual) return "rhetorical";
    return "checkable_factual";
  }
  if ((rhetorical || opinion) && factual) return "mixed";
  if (rhetorical) return "rhetorical";
  if (opinion) return "opinion";
  return "checkable_factual";
}

/** Keep a local opinion or insult label when the model treated it as a fact. */
export function reconcileClaimType(text: string, model: ClaimType): ClaimType {
  if (isDateFiller(text)) return "rhetorical";
  if (isAttributedClaim(text) && model === "opinion") return "checkable_factual";
  const local = inferClaimType(text);
  if (local === "rhetorical" || local === "opinion") return local;
  if (local === "mixed" && model === "checkable_factual") return "mixed";
  return model;
}

const OPINION_PATH =
  /\/(?:opinions?|commentisfree|comments?|columns|columnists|op-eds?|oped|apopseis|apopsi|gnomes|gnomi|sxolio|sxolia|dimosio-vima|arthrografia|απόψεις|αποψεις|άποψη|αποψη|γνώμες|γνωμες|σχόλιο|σχολιο)(?:\/|$)/iu;

const OPINION_KICKER =
  /(?:^|[\n|:—–])\s*(?:opinions?|commentisfree|columns|columnists|op-eds?|oped|apopseis|gnomes|απόψεις|αποψεις|άποψη|αποψη|γνώμες|γνωμες|σχόλιο|σχολιο|δημόσιο\s+βήμα|δημοσιο\s+βημα|αρθρογραφία|αρθρογραφια|γράφει\s+(?:ο|η)|γραφει\s+(?:ο|η))(?=$|[\n|:—–.,\s])/iu;

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
  const head = text.split("\n").slice(0, 4).join("\n").slice(0, 400);
  return OPINION_KICKER.test(`${title ?? ""}\n${head}`);
}

const OPINION_SECTION =
  /αποψεις|αποψη|σχολιο|γνωμες|δημοσιο\s*βημα|αρθρογραφια|\bopinions?\b|\bapopseis\b|\bgnomes?\b|\bcommentisfree\b|\bcolumns?\b/;

function withoutMarks(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Article-scoped category markup. A site-wide menu link to Απόψεις does not count. */
export function opinionCueFromHtml(html: string): boolean {
  const section = html.match(/"articleSection"\s*:\s*(\[[\s\S]*?\]|"[^"]*")/);
  if (section && OPINION_SECTION.test(withoutMarks(section[1]))) return true;
  for (const hit of html.matchAll(/class\s*=\s*["']([^"']+)["']/gi)) {
    const cls = hit[1];
    if (/\bmenu-item\b/.test(cls)) continue;
    if (
      /\bcategory-(?:apopseis|apopsi|dimosio-vima|arthrografia|opinions?|commentisfree|gnomes?|gnomi|sxolio|columns?)\b/i.test(
        cls,
      )
    ) {
      return true;
    }
  }
  return false;
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
