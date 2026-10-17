import type { Label, UiLanguage } from "./labels";
import { LABELS } from "./labels";
import type { ScoreResult } from "./types";

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
const SOURCING_CAP_NO_SEARCH = 30;
const CONTRADICTION_PENALTY = 30;
const UNCERTAIN_FACTUAL = 42;
const COMMENTARY_FACTUAL = 60;

export interface ScoreSegment {
  label: Label;
  confidence: number;
  hasValidSource: boolean;
}

export interface ScoreOptions {
  contradictionCount: number;
  searchEnabled: boolean;
  uiLanguage: UiLanguage;
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

  const decided = segments.filter(
    (segment): segment is ScoreSegment & { label: keyof typeof FACT_POINTS } =>
      segment.label === "True" ||
      segment.label === "False" ||
      segment.label === "Misleading",
  );
  const checkable = segments.filter((segment) =>
    ["True", "False", "Misleading", "Unverifiable"].includes(segment.label),
  );

  let factualAccuracy: number | null = null;
  if (decided.length > 0) {
    let weight = 0;
    let weighted = 0;
    for (const segment of decided) {
      const confidence = Math.min(1, Math.max(0.25, segment.confidence));
      weight += confidence;
      weighted += confidence * FACT_POINTS[segment.label];
    }
    factualAccuracy = round(weighted / weight);
  }

  let sourcing: number | null = null;
  if (checkable.length > 0) {
    const sourced = checkable.filter((segment) => segment.hasValidSource).length;
    sourcing = round((100 * sourced) / checkable.length);
    if (!options.searchEnabled) sourcing = Math.min(sourcing, SOURCING_CAP_NO_SEARCH);
  }

  const toneNeutrality = round(
    100 - (100 * counts.Rhetorical) / segments.length,
  );

  const logicalConsistency =
    segments.length < 2
      ? 100
      : Math.max(0, 100 - options.contradictionCount * CONTRADICTION_PENALTY);

  const hasUnverifiable = counts.Unverifiable > 0;
  const factualBasis: ScoreResult["factualBasis"] =
    factualAccuracy !== null ? "measured" : hasUnverifiable || checkable.length > 0 ? "uncertain" : "commentary";

  const factualForMix =
    factualAccuracy ??
    (factualBasis === "commentary" ? COMMENTARY_FACTUAL : UNCERTAIN_FACTUAL);

  const base =
    WEIGHTS.factual * factualForMix +
    WEIGHTS.sourcing * (sourcing ?? 40) +
    WEIGHTS.tone * toneNeutrality +
    WEIGHTS.consistency * logicalConsistency;

  const penalty = Math.min(
    MAX_PENALTY,
    counts.False * FALSE_PENALTY + counts.Misleading * MISLEADING_PENALTY,
  );

  let overall = clamp(round(base - penalty), 0, 100);
  if (factualBasis === "commentary") overall = Math.min(overall, COMMENTARY_CAP);
  if (!options.searchEnabled) overall = Math.min(overall, SEARCH_OFF_CAP);

  const verdict = buildVerdict(
    {
      overall,
      counts,
      factualBasis,
      searchEnabled: options.searchEnabled,
    },
    options.uiLanguage,
  );

  return {
    factualAccuracy,
    factualBasis,
    sourcing,
    toneNeutrality,
    logicalConsistency,
    overall,
    verdict,
    counts,
  };
}

function buildVerdict(
  input: {
    overall: number;
    counts: Record<Label, number>;
    factualBasis: ScoreResult["factualBasis"];
    searchEnabled: boolean;
  },
  lang: UiLanguage,
): string {
  const { overall, counts, factualBasis, searchEnabled } = input;
  const checkable =
    counts.True + counts.False + counts.Misleading + counts.Unverifiable;
  let sentence: string;

  if (factualBasis === "commentary") {
    sentence =
      lang === "el"
        ? `Το κείμενο βαθμολογείται με ${overall}/100 και είναι κυρίως γνώμη ή σχόλιο, όχι σύνολο ελέγξιμων ισχυρισμών.`
        : `The article scores ${overall}/100 and is mostly opinion or commentary, not a set of checkable claims.`;
  } else if (counts.False > 0 && counts.False >= counts.True) {
    sentence =
      lang === "el"
        ? counts.False === 1
          ? `Το κείμενο βαθμολογείται με ${overall}/100 επειδή 1 ελέγξιμος ισχυρισμός έρχεται σε αντίθεση με τα τεκμήρια.`
          : `Το κείμενο βαθμολογείται με ${overall}/100 επειδή ${counts.False} ελέγξιμοι ισχυρισμοί έρχονται σε αντίθεση με τα τεκμήρια.`
        : `The article scores ${overall}/100 because ${counts.False} checkable ${enClaim(counts.False)} contradicted by the evidence.`;
  } else if (counts.Misleading > 0 && counts.False === 0 && counts.Misleading >= counts.True) {
    sentence =
      lang === "el"
        ? `Το κείμενο βαθμολογείται με ${overall}/100: η βασική αδυναμία είναι παραπλανητική πλαισίωση σε ${counts.Misleading} ${counts.Misleading === 1 ? "ισχυρισμό" : "ισχυρισμούς"}.`
        : `The article scores ${overall}/100: the main weakness is misleading framing in ${counts.Misleading} ${counts.Misleading === 1 ? "claim" : "claims"}.`;
  } else if (checkable > 0 && counts.Unverifiable * 2 >= checkable && counts.False === 0) {
    sentence =
      lang === "el"
        ? `Το κείμενο βαθμολογείται με ${overall}/100 επειδή τα διαθέσιμα τεκμήρια δεν αρκούν για τους περισσότερους ελέγξιμους ισχυρισμούς.`
        : `The article scores ${overall}/100 because the available evidence is not enough to settle most checkable claims.`;
  } else if (overall >= 75 && counts.False === 0) {
    sentence =
      lang === "el"
        ? `Το κείμενο βαθμολογείται με ${overall}/100 επειδή οι ελέγξιμοι ισχυρισμοί στηρίζονται σε μεγάλο βαθμό από τις παρατιθέμενες πηγές και το ύφος μένει συγκρατημένο.`
        : `The article scores ${overall}/100 because its checkable claims are largely supported by the cited sources and the tone stays measured.`;
  } else {
    sentence =
      lang === "el"
        ? `Το κείμενο βαθμολογείται με ${overall}/100, με μεικτή εικόνα: ${elAdj(counts.True, "αληθής", "αληθείς")}, ${elAdj(counts.False, "ψευδής", "ψευδείς")} και ${elAdj(counts.Unverifiable, "μη επαληθεύσιμος", "μη επαληθεύσιμοι")} ισχυρισμοί.`
        : `The article scores ${overall}/100, a mixed picture: ${counts.True} true, ${counts.False} false, and ${counts.Unverifiable} unverifiable claims.`;
  }

  if (!searchEnabled) {
    sentence +=
      lang === "el"
        ? " Η ζωντανή αναζήτηση δεν ήταν διαθέσιμη, οπότε οι πραγματολογικές ετικέτες στηρίζονται μόνο στη γνώση του μοντέλου και δεν θεωρούνται επαληθευμένες."
        : " Live web search was unavailable, so factual labels are model-knowledge-only and are not treated as verified.";
  }

  return sentence;
}

function enClaim(count: number): string {
  return count === 1 ? "claim is" : "claims are";
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
