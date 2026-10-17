import type { Label, UiLanguage } from "./labels";
import { LABELS } from "./labels";
import type { OutletKind } from "./reputation";
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
const LOW_COVERAGE_CAP = 70;
const SATIRE_CAP = 42;
const LOW_CREDIBILITY_CAP = 44;
const SOURCING_CAP_NO_SEARCH = 30;
const CONTRADICTION_PENALTY = 30;
const NEUTRAL_FACTUAL = 50;
const COMMENTARY_FACTUAL = 60;

export interface ScoreSegment {
  label: Label;
  confidence: number;
  hasValidSource: boolean;
  tone?: number;
}

export interface ScoreOptions {
  contradictionCount: number;
  searchEnabled: boolean;
  uiLanguage: UiLanguage;
  searchDegraded?: boolean;
  outlet?: OutletKind;
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

  const coverage = checkable.length === 0 ? 1 : decided.length / checkable.length;
  const factualAccuracy =
    checkable.length === 0
      ? null
      : round(measured === null ? NEUTRAL_FACTUAL : measured * coverage + NEUTRAL_FACTUAL * (1 - coverage));

  let sourcing: number | null = null;
  if (checkable.length > 0) {
    const sourced = checkable.filter((segment) => segment.hasValidSource).length;
    sourcing = round((100 * sourced) / checkable.length);
    if (!options.searchEnabled) sourcing = Math.min(sourcing, SOURCING_CAP_NO_SEARCH);
  }

  const tones = segments.map((segment) => segment.tone ?? 100);
  const averageTone = tones.reduce((sum, value) => sum + value, 0) / tones.length;
  const worstTone = Math.min(...tones);
  const toneNeutrality = round(averageTone * 0.7 + worstTone * 0.3);

  const logicalConsistency =
    segments.length < 2
      ? 100
      : Math.max(0, 100 - options.contradictionCount * CONTRADICTION_PENALTY);

  const outlet = options.outlet ?? "news";
  const factualBasis: ScoreResult["factualBasis"] =
    checkable.length === 0 ? "commentary" : coverage < 0.6 || decided.length === 0 ? "uncertain" : "measured";

  const factualForMix = factualAccuracy ?? (factualBasis === "commentary" ? COMMENTARY_FACTUAL : NEUTRAL_FACTUAL);

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
  if (checkable.length >= 4 && coverage < 0.4) overall = Math.min(overall, LOW_COVERAGE_CAP);
  if (outlet === "satire") overall = Math.min(overall, SATIRE_CAP);
  if (outlet === "low-credibility") overall = Math.min(overall, LOW_CREDIBILITY_CAP);

  const verdict = buildVerdict(
    {
      overall,
      counts,
      factualBasis,
      searchEnabled: options.searchEnabled,
      searchDegraded: options.searchDegraded === true,
      outlet,
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
    searchDegraded: boolean;
    outlet: OutletKind;
  },
  lang: UiLanguage,
): string {
  const { overall, counts, factualBasis, searchEnabled, searchDegraded, outlet } = input;
  const checked = counts.True + counts.False + counts.Misleading;
  const checkable = checked + counts.Unverifiable;
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

  if (checkable > 0) {
    parts.push(
      lang === "el"
        ? `Ελέγχθηκαν ${checked} από ${checkable} πραγματολογικούς ισχυρισμούς: ${elAdj(counts.True, "αληθής", "αληθείς")}, ${elAdj(counts.False, "ψευδής", "ψευδείς")} και ${elAdj(counts.Unverifiable, "μη επαληθεύσιμος", "μη επαληθεύσιμοι")}.`
        : `${checked} of ${checkable} factual claims were checked (${counts.True} true, ${counts.False} false, ${counts.Misleading} misleading, ${counts.Unverifiable} unverifiable).`,
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
