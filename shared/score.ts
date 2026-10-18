import type { Label, UiLanguage } from "./labels";
import { LABELS } from "./labels";
import { degradedClaimsSentence } from "./messages";
import type { OutletKind } from "./reputation";
import type { ScoreResult, SearchState } from "./types";

export const WEIGHTS = {
  factual: 0.58,
  sourcing: 0.16,
  tone: 0.12,
  consistency: 0.14,
} as const;

export const FACT_POINTS = {
  True: 100,
  Misleading: 35,
  False: 0,
} as const;

const FALSE_PENALTY = 14;
const MISLEADING_PENALTY = 6;
const MAX_PENALTY = 36;
const SEARCH_OFF_CAP = 68;
const COMMENTARY_CAP = 64;
const LOW_COVERAGE_CAP = 70;
const LOW_COVERAGE_THRESHOLD = 0.25;
const OPINION_CAP = 65;
const SATIRE_CAP = 42;
const LOW_CREDIBILITY_CAP = 44;
const SOURCING_CAP_NO_SEARCH = 30;
const CONTRADICTION_PENALTY = 15;
const CONTRADICTION_CAP = 30;
const NEUTRAL_FACTUAL = 50;
const COMMENTARY_FACTUAL = 60;
/** A thin or failed search is blended toward this prior so one cached hit cannot read as a confident score. */
const SCORE_PRIOR = NEUTRAL_FACTUAL;
/** Selected claims checked below this share, or a search that is not ok, make the score provisional. */
export const PROVISIONAL_COVERAGE = 0.5;

export interface ScoreSegment {
  label: Label;
  confidence: number;
  hasValidSource: boolean;
  tone?: number;
  /**
   * Unverifiable claims left outside the search budget are still shown, but they
   * are not part of the coverage ratio. Omitted means the claim was selected.
   */
  inCoverage?: boolean;
  /**
   * A claim the run could not finish (budget, deadline, or an error) is shown
   * as Unverifiable and left out of the score.
   */
  countsTowardScore?: boolean;
}

export interface ScoreOptions {
  contradictionCount: number;
  searchEnabled: boolean;
  uiLanguage: UiLanguage;
  searchDegraded?: boolean;
  outlet?: OutletKind;
  degraded?: boolean;
  claimsVerified?: number;
  claimsTotal?: number;
  /**
   * Hide factual and sourcing figures and pull the overall toward a neutral prior.
   * Set from isProvisionalScore so the flag and the search status stay one rule.
   */
  provisional?: boolean;
}

/**
 * One rule for the provisional flag. Search that is off stays a normal model-only
 * score. A configured search is provisional when it is not ok, or when fewer than
 * half of the selected claims have a relevant cited source.
 */
export function isProvisionalScore(input: {
  searchEnabled: boolean;
  searchState: SearchState;
  claimsVerified: number;
  claimsTotal: number;
}): boolean {
  if (!input.searchEnabled) return false;
  if (input.searchState !== "ok") return true;
  if (input.claimsTotal <= 0) return false;
  return input.claimsVerified / input.claimsTotal < PROVISIONAL_COVERAGE;
}

export function emptyCounts(): Record<Label, number> {
  return {
    True: 0,
    False: 0,
    Misleading: 0,
    Unverifiable: 0,
    Opinion: 0,
    Rhetorical: 0,
  };
}

export function aggregateScore(
  segments: ScoreSegment[],
  options: ScoreOptions,
): ScoreResult {
  const counts = emptyCounts();
  for (const segment of segments) counts[segment.label] += 1;

  if (segments.length === 0) {
    return {
      factualAccuracy: null,
      factualBasis: "uncertain",
      sourcing: null,
      toneNeutrality: null,
      logicalConsistency: 100,
      overall: 0,
      verdict: options.uiLanguage === "el" ? "Δεν υπάρχει κείμενο προς ανάλυση." : "There is nothing to analyse.",
      counts,
    };
  }

  const countsInScore = (segment: ScoreSegment) => segment.countsTowardScore !== false;
  const inPool = (segment: ScoreSegment) => segment.inCoverage !== false && countsInScore(segment);
  const decided = segments.filter(
    (segment): segment is ScoreSegment & { label: keyof typeof FACT_POINTS } =>
      (segment.label === "True" ||
        segment.label === "False" ||
        segment.label === "Misleading") &&
      inPool(segment),
  );
  const checkable = segments.filter((segment) =>
    ["True", "False", "Misleading", "Unverifiable"].includes(segment.label),
  );
  const coveragePool = checkable.filter((segment) => inPool(segment));
  const outsideSearch = checkable.filter((segment) => segment.inCoverage === false).length;
  const cutShort = checkable.some((segment) => segment.countsTowardScore === false);
  const nothingScored = coveragePool.length === 0 && cutShort;

  let measured: number | null = null;
  if (decided.length > 0) {
    let weight = 0;
    let weighted = 0;
    for (const segment of decided) {
      const confidence = Math.min(1, Math.max(0.25, segment.confidence));
      weight += confidence;
      weighted += confidence * FACT_POINTS[segment.label];
    }
    measured = weighted / weight;
  }

  const coverage = coveragePool.length === 0 ? 1 : decided.length / coveragePool.length;
  const factualAccuracy =
    checkable.length === 0 || nothingScored
      ? null
      : round(
          measured === null ? NEUTRAL_FACTUAL : measured * coverage + NEUTRAL_FACTUAL * (1 - coverage),
        );

  let sourcing: number | null = null;
  if (coveragePool.length > 0) {
    const sourced = coveragePool.filter((segment) => segment.hasValidSource).length;
    sourcing = round((100 * sourced) / coveragePool.length);
    if (!options.searchEnabled) sourcing = Math.min(sourcing, SOURCING_CAP_NO_SEARCH);
  }

  const toneSource = segments.filter((segment) => countsInScore(segment));
  const tones = (toneSource.length > 0 ? toneSource : segments).map((segment) => segment.tone ?? 100);
  const averageTone = tones.reduce((sum, value) => sum + value, 0) / tones.length;
  const worstTone = Math.min(...tones);
  const toneNeutrality = round(averageTone * 0.7 + worstTone * 0.3);

  const logicalConsistency =
    segments.length < 2 || options.contradictionCount <= 0
      ? 100
      : Math.max(
          0,
          100 - Math.min(CONTRADICTION_CAP, options.contradictionCount * CONTRADICTION_PENALTY),
        );

  const outlet = options.outlet ?? "news";
  const opinionPiece =
    !nothingScored && (options.outlet === "opinion" || isMostlyOpinion(counts, segments.length));
  const factualBasis: ScoreResult["factualBasis"] = nothingScored
    ? "uncertain"
    : checkable.length === 0
      ? "commentary"
      : coverage < 0.6 || decided.length === 0
        ? "uncertain"
        : "measured";

  const factualForMix = factualAccuracy ?? (factualBasis === "commentary" ? COMMENTARY_FACTUAL : NEUTRAL_FACTUAL);

  const base =
    WEIGHTS.factual * factualForMix +
    WEIGHTS.sourcing * (sourcing ?? 40) +
    WEIGHTS.tone * toneNeutrality +
    WEIGHTS.consistency * logicalConsistency;

  let falseCount = 0;
  let misleadingCount = 0;
  for (const segment of segments) {
    if (!countsInScore(segment)) continue;
    if (segment.label === "False") falseCount += 1;
    if (segment.label === "Misleading") misleadingCount += 1;
  }
  const penalty = Math.min(MAX_PENALTY, falseCount * FALSE_PENALTY + misleadingCount * MISLEADING_PENALTY);

  let overall = clamp(round(base - penalty), 0, 100);
  if (opinionPiece && factualBasis !== "commentary" && outlet !== "satire" && outlet !== "low-credibility") {
    const opinionBase =
      0.5 * factualForMix +
      0.08 * (sourcing ?? 40) +
      0.3 * toneNeutrality +
      0.12 * logicalConsistency;
    overall = Math.min(OPINION_CAP, clamp(round(opinionBase - penalty), 0, 100));
  }
  if (factualBasis === "commentary") overall = Math.min(overall, COMMENTARY_CAP);
  if (!options.searchEnabled) overall = Math.min(overall, SEARCH_OFF_CAP);
  if (!options.degraded && coveragePool.length >= 4 && coverage < LOW_COVERAGE_THRESHOLD) {
    overall = Math.min(overall, LOW_COVERAGE_CAP);
  }
  if (outlet === "satire") overall = Math.min(overall, SATIRE_CAP);
  if (outlet === "low-credibility") overall = Math.min(overall, LOW_CREDIBILITY_CAP);
  if (options.provisional) {
    const verified = options.claimsVerified ?? 0;
    const total = options.claimsTotal ?? 0;
    const weight = total > 0 ? clamp(verified / total, 0, 1) : 0;
    overall = round(SCORE_PRIOR + (overall - SCORE_PRIOR) * weight);
    if (outlet === "satire") overall = Math.min(overall, SATIRE_CAP);
    if (outlet === "low-credibility") overall = Math.min(overall, LOW_CREDIBILITY_CAP);
    if (opinionPiece && factualBasis !== "commentary" && outlet !== "satire" && outlet !== "low-credibility") {
      overall = Math.min(overall, OPINION_CAP);
    }
    if (factualBasis === "commentary") overall = Math.min(overall, COMMENTARY_CAP);
  }

  const poolCounts = emptyCounts();
  for (const segment of coveragePool) poolCounts[segment.label] += 1;

  const verdict = buildVerdict(
    {
      overall,
      counts,
      poolCounts,
      outsideSearch,
      factualBasis,
      searchEnabled: options.searchEnabled,
      searchDegraded: options.searchDegraded === true,
      outlet,
      opinionPiece,
      thin: segments.length <= 1,
      degraded: options.degraded === true,
      claimsVerified: options.claimsVerified ?? 0,
      claimsTotal: options.claimsTotal ?? 0,
    },
    options.uiLanguage,
  );

  return {
    factualAccuracy: options.provisional ? null : factualAccuracy,
    factualBasis,
    sourcing: options.provisional ? null : sourcing,
    toneNeutrality,
    logicalConsistency,
    overall,
    verdict,
    counts,
  };
}

function isMostlyOpinion(counts: Record<Label, number>, total: number): boolean {
  return total > 0 && counts.Opinion >= 3 && counts.Opinion / total >= 0.2;
}

function buildVerdict(
  input: {
    overall: number;
    counts: Record<Label, number>;
    poolCounts: Record<Label, number>;
    outsideSearch: number;
    factualBasis: ScoreResult["factualBasis"];
    searchEnabled: boolean;
    searchDegraded: boolean;
    outlet: OutletKind;
    opinionPiece: boolean;
    thin: boolean;
    degraded: boolean;
    claimsVerified: number;
    claimsTotal: number;
  },
  lang: UiLanguage,
): string {
  const {
    overall,
    counts,
    poolCounts,
    outsideSearch,
    factualBasis,
    searchEnabled,
    searchDegraded,
    outlet,
    opinionPiece,
    thin,
    degraded,
    claimsVerified,
    claimsTotal,
  } = input;
  const checked = poolCounts.True + poolCounts.False + poolCounts.Misleading;
  const checkable = checked + poolCounts.Unverifiable;
  const parts: string[] = [];

  if (outlet === "satire") {
    parts.push(
      lang === "el"
        ? `Το κείμενο βαθμολογείται με ${overall}/100 και είναι σάτιρα, όχι είδηση.`
        : `The article scores ${overall}/100 and is satire, not news.`,
    );
  } else if (outlet === "low-credibility") {
    parts.push(
      lang === "el"
        ? `Το κείμενο βαθμολογείται με ${overall}/100. Η πηγή έχει ιστορικό αναξιόπιστων ισχυρισμών.`
        : `The article scores ${overall}/100. The outlet has a record of unreliable claims.`,
    );
  } else if (factualBasis === "commentary") {
    parts.push(
      lang === "el"
        ? `Το κείμενο βαθμολογείται με ${overall}/100 και είναι κυρίως γνώμη ή σχόλιο, όχι σύνολο ελέγξιμων ισχυρισμών.`
        : `The article scores ${overall}/100 and is mostly opinion or commentary, not a set of checkable claims.`,
    );
  } else if (opinionPiece) {
    parts.push(
      lang === "el"
        ? `Το κείμενο βαθμολογείται με ${overall}/100 και είναι κυρίως γνώμη.`
        : `The article scores ${overall}/100 and is mostly opinion.`,
    );
  } else if (searchDegraded && checked === 0) {
    parts.push(
      lang === "el"
        ? `Το κείμενο βαθμολογείται με ${overall}/100, αλλά αυτό δεν είναι κρίση αξιοπιστίας: η ζωντανή αναζήτηση απέτυχε.`
        : `The article scores ${overall}/100, but that is not a credibility judgement: live search failed.`,
    );
  } else {
    parts.push(
      lang === "el"
        ? `Το κείμενο βαθμολογείται με ${overall}/100.`
        : `The article scores ${overall}/100.`,
    );
  }

  if (degraded && claimsTotal > 0) {
    parts.push(degradedClaimsSentence(lang, claimsVerified, claimsTotal, poolCounts));
  } else if (thin && checked === 0 && checkable > 0) {
    parts.push(
      lang === "el"
        ? "Η σελίδα είχε πολύ λίγο κείμενο άρθρου για να ελεγχθεί ένας πραγματολογικός ισχυρισμός."
        : "The page had too little article text to check a factual claim.",
    );
  } else if (checkable > 0) {
    parts.push(
      lang === "el"
        ? `Ελέγχθηκαν ${checked} από ${checkable} πραγματολογικούς ισχυρισμούς: ${elAdj(poolCounts.True, "αληθής", "αληθείς")}, ${elAdj(poolCounts.False, "ψευδής", "ψευδείς")} και ${elAdj(poolCounts.Unverifiable, "μη επαληθεύσιμος", "μη επαληθεύσιμοι")}.`
        : checkable === 1
          ? `${checked} of 1 factual claim was checked (${poolCounts.True} true, ${poolCounts.False} false, ${poolCounts.Misleading} misleading, ${poolCounts.Unverifiable} unverifiable).`
          : `${checked} of ${checkable} factual claims were checked (${poolCounts.True} true, ${poolCounts.False} false, ${poolCounts.Misleading} misleading, ${poolCounts.Unverifiable} unverifiable).`,
    );
  }
  if (outlet === "unknown") {
    parts.push(
      lang === "el"
        ? "Το κείμενο επικολλήθηκε, οπότε η πηγή είναι άγνωστη και ο βαθμός δεν είναι κρίση φήμης ενός μέσου."
        : "The text was pasted, so the outlet is unknown and this score is not a reputation judgement.",
    );
  }
  if (outsideSearch > 0) {
    parts.push(
      lang === "el"
        ? outsideSearch === 1
          ? "1 ισχυρισμός έμεινε εκτός αναζήτησης και δεν μετρά ως κενό κάλυψης."
          : `${outsideSearch} ισχυρισμοί έμειναν εκτός αναζήτησης και δεν μετρούν ως κενό κάλυψης.`
        : outsideSearch === 1
          ? "1 further claim was outside this search and does not count as a coverage gap."
          : `${outsideSearch} further claims were outside this search and do not count as a coverage gap.`,
    );
  }
  if (counts.Opinion > 0) {
    parts.push(
      lang === "el"
        ? `${counts.Opinion} ${counts.Opinion === 1 ? "απόσπασμα χαρακτηρίστηκε γνώμη" : "αποσπάσματα χαρακτηρίστηκαν γνώμη"}.`
        : `${counts.Opinion} ${counts.Opinion === 1 ? "passage is labelled opinion" : "passages are labelled opinion"}.`,
    );
  }
  if (counts.Rhetorical > 0) {
    parts.push(
      lang === "el"
        ? `${counts.Rhetorical} ${counts.Rhetorical === 1 ? "απόσπασμα είναι ρητορικό" : "αποσπάσματα είναι ρητορικά"}.`
        : `${counts.Rhetorical} ${counts.Rhetorical === 1 ? "passage is rhetorical" : "passages are rhetorical"}.`,
    );
  }
  if (searchDegraded && checked > 0) {
    parts.push(
      lang === "el"
        ? "Μέρος της αναζήτησης απέτυχε, οπότε οι κενές παραπομπές δεν σημαίνουν επιβεβαίωση."
        : "Part of the search failed, so missing citations are not a confirmation.",
    );
  }
  if (!searchEnabled) {
    parts.push(
      lang === "el"
        ? "Η ζωντανή αναζήτηση δεν ήταν διαθέσιμη, οπότε οι πραγματολογικές ετικέτες στηρίζονται μόνο στη γνώση του μοντέλου και δεν θεωρούνται επαληθευμένες."
        : "Live web search was unavailable, so factual labels are model-knowledge-only and are not treated as verified.",
    );
  }
  return parts.join(" ");
}

function elAdj(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function round(value: number): number {
  return Math.round(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function assertLabelCoverage(counts: Record<Label, number>): void {
  for (const label of LABELS) {
    if (typeof counts[label] !== "number") {
      throw new Error(`missing count for ${label}`);
    }
  }
}
