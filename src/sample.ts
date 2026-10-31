import type { EvidenceMode, Label, UiLanguage } from "../shared/labels";
import { aggregateScore } from "../shared/score";
import type { AnalysisResult, Contradiction, SearchOutageReason, SegmentResult, SourceCitation } from "../shared/types";

interface Seed {
  text: string;
  label: Label;
  confidence: number;
  explanation: string;
  sources: SourceCitation[];
  evidenceMode: EvidenceMode;
}

const minutesEn: SourceCitation = {
  url: "https://example.com/council/minutes-2026-03-03",
  title: "City council minutes, 3 March 2026",
  snippet: "Motion to raise annual berth fees from €800 to €880 carried 7–2.",
};

const scheduleEn: SourceCitation = {
  url: "https://example.com/marina/fee-schedule",
  title: "Municipal marina fee schedule",
  snippet: "Annual berth fee moves from €800 to €880, a 10 percent increase.",
};

const minutesEl: SourceCitation = {
  url: "https://example.com/council/minutes-2026-03-03",
  title: "Πρακτικά δημοτικού συμβουλίου, 3 Μαρτίου 2026",
  snippet: "Η πρόταση για αύξηση του τέλους από 800 σε 880 ευρώ εγκρίθηκε με 7–2.",
};

const scheduleEl: SourceCitation = {
  url: "https://example.com/marina/fee-schedule",
  title: "Πίνακας τελών δημοτικής μαρίνας",
  snippet: "Το ετήσιο τέλος θέσης πηγαίνει από 800 σε 880 ευρώ, αύξηση 10 τοις εκατό.",
};

function englishSeeds(): Seed[] {
  return [
    {
      text: "The city council voted 7–2 on 3 March 2026 to raise annual berth fees at the municipal marina from €800 to €880.",
      label: "True",
      confidence: 0.9,
      explanation: "The published minutes record a 7–2 vote and the same fee change, from €800 to €880.",
      sources: [minutesEn],
      evidenceMode: "web-search",
    },
    {
      text: "The hike doubles what working families pay to keep a boat in the water.",
      label: "Misleading",
      confidence: 0.86,
      explanation: "The fee does rise, but from €800 to €880 is a 10 percent increase, not a doubling.",
      sources: [scheduleEn, minutesEn],
      evidenceMode: "web-search",
    },
    {
      text: "Mayor Elena Varga ordered the increase herself, and no public vote was held.",
      label: "False",
      confidence: 0.9,
      explanation: "The minutes show a public 7–2 vote. They do not show a personal order with no vote.",
      sources: [minutesEn],
      evidenceMode: "web-search",
    },
    {
      text: "A dockworker who asked not to be named said foreign investors have already bought the dry dock.",
      label: "Unverifiable",
      confidence: 0.4,
      explanation: "The search results do not mention a sale of the dry dock, and an unnamed source cannot be checked.",
      sources: [],
      evidenceMode: "web-search",
    },
    {
      text: "At 33, she falls in the age range most likely to keep a boat, and she started sailing at university.",
      label: "Personal",
      confidence: 0.7,
      explanation: "This is a personal anecdote, so it was not selected for checking.",
      sources: [],
      evidenceMode: "not-applicable",
    },
    {
      text: "The waterfront should belong to the people who live here, not to a balance sheet.",
      label: "Opinion",
      confidence: 0.8,
      explanation: "This is a value judgement about who the waterfront is for, not a checkable proposition.",
      sources: [],
      evidenceMode: "not-applicable",
    },
    {
      text: "This is a shameful betrayal of every family who ever watched the sun set from the pier.",
      label: "Rhetorical",
      confidence: 0.84,
      explanation: "The sentence is an emotional charge. It does not state a discrete fact that evidence could settle.",
      sources: [],
      evidenceMode: "not-applicable",
    },
    {
      text: "The published minutes of that March meeting record the 7–2 vote and the new fee schedule.",
      label: "True",
      confidence: 0.93,
      explanation: "The minutes page records both the 7–2 vote and the updated fee schedule.",
      sources: [minutesEn],
      evidenceMode: "web-search",
    },
  ];
}

function greekSeeds(): Seed[] {
  return [
    {
      text: "Το δημοτικό συμβούλιο ψήφισε με 7–2 στις 3 Μαρτίου 2026 να αυξηθεί το ετήσιο τέλος θέσης στη δημοτική μαρίνα από 800 σε 880 ευρώ.",
      label: "True",
      confidence: 0.9,
      explanation: "Τα πρακτικά καταγράφουν ψηφοφορία 7–2 και την ίδια μεταβολή τέλους, από 800 σε 880 ευρώ.",
      sources: [minutesEl],
      evidenceMode: "web-search",
    },
    {
      text: "Η αύξηση διπλασιάζει όσα πληρώνουν οι εργαζόμενες οικογένειες για να κρατούν μια βάρκα στο νερό.",
      label: "Misleading",
      confidence: 0.86,
      explanation: "Το τέλος όντως αυξάνεται, όμως από 800 σε 880 ευρώ είναι αύξηση 10 τοις εκατό, όχι διπλασιασμός.",
      sources: [scheduleEl, minutesEl],
      evidenceMode: "web-search",
    },
    {
      text: "Η δήμαρχος Έλενα Βάργκα διέταξε η ίδια την αύξηση και δεν έγινε δημόσια ψηφοφορία.",
      label: "False",
      confidence: 0.9,
      explanation: "Τα πρακτικά δείχνουν δημόσια ψηφοφορία 7–2. Δεν δείχνουν προσωπική εντολή χωρίς ψήφο.",
      sources: [minutesEl],
      evidenceMode: "web-search",
    },
    {
      text: "Ένας εργάτης της αποβάθρας που ζήτησε να μην κατονομαστεί είπε ότι ξένοι επενδυτές έχουν ήδη αγοράσει τη δεξαμενή.",
      label: "Unverifiable",
      confidence: 0.4,
      explanation: "Τα αποτελέσματα αναζήτησης δεν αναφέρουν πώληση της δεξαμενής και η ανώνυμη πηγή δεν ελέγχεται.",
      sources: [],
      evidenceMode: "web-search",
    },
    {
      text: "Στα 33 της, η ίδια πέφτει στην ηλικιακή ομάδα που κρατά πιο συχνά βάρκα και ξεκίνησε ιστιοπλοΐα στο πανεπιστήμιο.",
      label: "Personal",
      confidence: 0.7,
      explanation: "Πρόκειται για προσωπική μαρτυρία, οπότε δεν επιλέχθηκε για έλεγχο.",
      sources: [],
      evidenceMode: "not-applicable",
    },
    {
      text: "Η παραλία πρέπει να ανήκει σε όσους ζουν εδώ, όχι σε έναν ισολογισμό.",
      label: "Opinion",
      confidence: 0.8,
      explanation: "Πρόκειται για αξιολογική κρίση για το σε ποιους ανήκει η παραλία, όχι για ελέγξιμο ισχυρισμό.",
      sources: [],
      evidenceMode: "not-applicable",
    },
    {
      text: "Είναι μια επαίσχυντη προδοσία κάθε οικογένειας που αντίκρισε το ηλιοβασίλεμα από την προβλήτα.",
      label: "Rhetorical",
      confidence: 0.84,
      explanation: "Η πρόταση είναι συναισθηματική καταγγελία. Δεν διατυπώνει διακριτό γεγονός που να κρίνεται με τεκμήρια.",
      sources: [],
      evidenceMode: "not-applicable",
    },
    {
      text: "Τα δημοσιευμένα πρακτικά εκείνης της συνεδρίασης του Μαρτίου καταγράφουν την ψηφοφορία 7–2 και τον νέο πίνακα τελών.",
      label: "True",
      confidence: 0.93,
      explanation: "Η σελίδα των πρακτικών καταγράφει και την ψηφοφορία 7–2 και τον ενημερωμένο πίνακα τελών.",
      sources: [minutesEl],
      evidenceMode: "web-search",
    },
  ];
}

/** Fixture report for the interface. Not a live audit. */
export function buildSample(lang: UiLanguage): AnalysisResult {
  const seeds = lang === "el" ? greekSeeds() : englishSeeds();
  const text = seeds.map((seed) => seed.text).join("\n\n");
  let cursor = 0;
  const segments: SegmentResult[] = seeds.map((seed, index) => {
    const start = text.indexOf(seed.text, cursor);
    const end = start + seed.text.length;
    cursor = end;
    return {
      id: `s${index + 1}`,
      text: seed.text,
      start,
      end,
      label: seed.label,
      confidence: seed.confidence,
      explanation: seed.explanation,
      sources: seed.sources,
      evidenceMode: seed.evidenceMode,
    };
  });

  const contradictions: Contradiction[] =
    lang === "el"
      ? [
          {
            a: "s1",
            b: "s3",
            explanation: "Ο ισχυρισμός ότι δεν έγινε δημόσια ψηφοφορία έρχεται σε αντίθεση με την καταγεγραμμένη ψήφο 7–2.",
          },
        ]
      : [
          {
            a: "s1",
            b: "s3",
            explanation: "The claim that no public vote was held contradicts the recorded 7–2 vote.",
          },
        ];

  const score = aggregateScore(
    segments.map((segment) => ({
      label: segment.label,
      confidence: segment.confidence,
      hasValidSource: segment.sources.length > 0,
    })),
    { contradictionCount: contradictions.length, searchEnabled: true, uiLanguage: lang },
  );

  return {
    article: {
      title:
        lang === "el"
          ? "Τα φώτα του λιμανιού: το συμβούλιο «πρόδωσε» την παραλία"
          : 'Harbour Lights: council "betrays" the waterfront',
      text,
      sourceDomain: "harbour-lights.example",
      sourceUrl: "https://harbour-lights.example/council-berth-fees",
      publishedAt: "2026-03-12T08:00:00.000Z",
      detectedLanguage: lang,
    },
    segments,
    score,
    contradictions,
    truncated: false,
    degraded: false,
    claimsVerified: 4,
    claimsCovered: 4,
    claimsTotal: 5,
    provisional: false,
    meta: {
      searchEnabled: true,
      searchDegraded: false,
      searchStatus: { state: "ok", reason: null, provider: null },
      model: "sample",
      uiLanguage: lang,
      requestId: "sample",
      extraction: "pasted",
      warnings: [],
      outlet: "news",
      subrequests: { ingest: 0, segment: 0, evidence: 0, verify: 0, score: 0, total: 0 },
    },
  };
}

export const FIXTURE_IDS = ["mixed", "true", "false", "unverifiable"] as const;
export type FixtureId = (typeof FIXTURE_IDS)[number];

export function parseFixtureId(value: string | null | undefined): FixtureId | null {
  if (value === "mixed" || value === "true" || value === "false" || value === "unverifiable") return value;
  return null;
}

/** `?fixture=` picks a local report. `?demo` stays the mixed sample. Neither calls the API. */
export function fixtureFromSearch(search: string): FixtureId | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const named = parseFixtureId(params.get("fixture"));
  if (named) return named;
  if (params.get("demo")) return "mixed";
  return null;
}

function segmentsFrom(seeds: Seed[]): { text: string; segments: SegmentResult[] } {
  const text = seeds.map((seed) => seed.text).join("\n\n");
  let cursor = 0;
  const segments = seeds.map((seed, index) => {
    const start = text.indexOf(seed.text, cursor);
    const end = start + seed.text.length;
    cursor = end;
    return {
      id: `s${index + 1}`,
      text: seed.text,
      start,
      end,
      label: seed.label,
      confidence: seed.confidence,
      explanation: seed.explanation,
      sources: seed.sources,
      evidenceMode: seed.evidenceMode,
    };
  });
  return { text, segments };
}

function sourced(text: string, label: Seed["label"], confidence: number, explanation: string, sources: SourceCitation[]): Seed {
  return { text, label, confidence, explanation, sources, evidenceMode: sources.length > 0 ? "web-search" : "web-search" };
}

function englishTrueSeeds(): Seed[] {
  return [
    sourced(
      "The city council voted 7–2 on 3 March 2026 to raise annual berth fees at the municipal marina from €800 to €880.",
      "True",
      0.94,
      "The minutes record the 7–2 vote and the fee change from €800 to €880.",
      [minutesEn],
    ),
    sourced(
      "The municipal marina fee schedule lists the new annual berth fee as €880.",
      "True",
      0.92,
      "The fee schedule states the annual berth fee is €880.",
      [scheduleEn],
    ),
    sourced(
      "The minutes say the motion carried with seven votes in favour and two against.",
      "True",
      0.9,
      "The minutes record seven votes in favour and two against.",
      [minutesEn],
    ),
    sourced(
      "The fee change leaves the charge almost unchanged.",
      "Misleading",
      0.84,
      "The fee does rise, from €800 to €880, which is a 10 percent increase rather than almost no change.",
      [scheduleEn],
    ),
  ];
}

function greekTrueSeeds(): Seed[] {
  return [
    sourced(
      "Το δημοτικό συμβούλιο ψήφισε με 7–2 στις 3 Μαρτίου 2026 να αυξηθεί το ετήσιο τέλος θέσης στη δημοτική μαρίνα από 800 σε 880 ευρώ.",
      "True",
      0.94,
      "Τα πρακτικά καταγράφουν την ψηφοφορία 7–2 και τη μεταβολή από 800 σε 880 ευρώ.",
      [minutesEl],
    ),
    sourced(
      "Ο πίνακας τελών της δημοτικής μαρίνας αναγράφει το νέο ετήσιο τέλος θέσης στα 880 ευρώ.",
      "True",
      0.92,
      "Ο πίνακας τελών αναφέρει ετήσιο τέλος θέσης 880 ευρώ.",
      [scheduleEl],
    ),
    sourced(
      "Τα πρακτικά λένε ότι η πρόταση πέρασε με επτά ψήφους υπέρ και δύο κατά.",
      "True",
      0.9,
      "Τα πρακτικά καταγράφουν επτά ψήφους υπέρ και δύο κατά.",
      [minutesEl],
    ),
    sourced(
      "Η μεταβολή του τέλους αφήνει τη χρέωση σχεδόν αμετάβλητη.",
      "Misleading",
      0.84,
      "Το τέλος αυξάνεται από 800 σε 880 ευρώ, δηλαδή 10 τοις εκατό, όχι σχεδόν καθόλου.",
      [scheduleEl],
    ),
  ];
}

function englishFalseSeeds(): Seed[] {
  return [
    sourced(
      "The council never voted on the marina fees.",
      "False",
      0.93,
      "The minutes record a public 7–2 vote on the marina fees.",
      [minutesEn],
    ),
    sourced(
      "Annual berth fees doubled from €800 to €1,600 on 3 March 2026.",
      "False",
      0.91,
      "The fee schedule moves the annual berth fee from €800 to €880, not to €1,600.",
      [scheduleEn],
    ),
    sourced(
      "Mayor Elena Varga cancelled the public meeting and signed the increase alone.",
      "False",
      0.88,
      "The minutes show a public vote. They do not show a cancelled meeting or a signature in place of a vote.",
      [minutesEn],
    ),
    sourced(
      "The published minutes show only that a vote was scheduled, not that it passed.",
      "Misleading",
      0.8,
      "The minutes do more than schedule a vote: they record that the motion carried 7–2.",
      [minutesEn],
    ),
  ];
}

function greekFalseSeeds(): Seed[] {
  return [
    sourced(
      "Το συμβούλιο δεν ψήφισε ποτέ για τα τέλη της μαρίνας.",
      "False",
      0.93,
      "Τα πρακτικά καταγράφουν δημόσια ψηφοφορία 7–2 για τα τέλη της μαρίνας.",
      [minutesEl],
    ),
    sourced(
      "Τα ετήσια τέλη θέσης διπλασιάστηκαν από 800 σε 1.600 ευρώ στις 3 Μαρτίου 2026.",
      "False",
      0.91,
      "Ο πίνακας τελών πηγαίνει το ετήσιο τέλος από 800 σε 880 ευρώ, όχι σε 1.600.",
      [scheduleEl],
    ),
    sourced(
      "Η δήμαρχος Έλενα Βάργκα ματαίωσε τη δημόσια συνεδρίαση και υπέγραψε μόνη της την αύξηση.",
      "False",
      0.88,
      "Τα πρακτικά δείχνουν δημόσια ψηφοφορία. Δεν δείχνουν ματαίωση ούτε υπογραφή στη θέση της ψήφου.",
      [minutesEl],
    ),
    sourced(
      "Τα δημοσιευμένα πρακτικά δείχνουν μόνο ότι προγραμματίστηκε ψηφοφορία, όχι ότι πέρασε.",
      "Misleading",
      0.8,
      "Τα πρακτικά δεν μένουν στον προγραμματισμό: καταγράφουν ότι η πρόταση πέρασε με 7–2.",
      [minutesEl],
    ),
  ];
}

function englishUnverifiableSeeds(): Seed[] {
  return [
    sourced(
      "A dockworker who asked not to be named said foreign investors bought the dry dock last week.",
      "Unverifiable",
      0.35,
      "No public record mentions a sale of the dry dock, and the source is unnamed.",
      [],
    ),
    sourced(
      "Residents say the night ferry was cancelled, though no notice was published.",
      "Unverifiable",
      0.32,
      "Search returned no notice of a cancelled night ferry.",
      [],
    ),
    sourced(
      "An anonymous post claimed the harbour master resigned on Tuesday.",
      "Unverifiable",
      0.3,
      "No named record confirms a resignation on Tuesday.",
      [],
    ),
    sourced(
      "Neighbours report that the fuel pontoon ran out of diesel before dawn.",
      "Unverifiable",
      0.28,
      "Nothing in the search results confirms a diesel shortage at the pontoon.",
      [],
    ),
  ];
}

function greekUnverifiableSeeds(): Seed[] {
  return [
    sourced(
      "Ένας εργάτης της αποβάθρας που ζήτησε να μην κατονομαστεί είπε ότι ξένοι επενδυτές αγόρασαν τη δεξαμενή την περασμένη εβδομάδα.",
      "Unverifiable",
      0.35,
      "Κανένα δημόσιο αρχείο δεν αναφέρει πώληση της δεξαμενής και η πηγή είναι ανώνυμη.",
      [],
    ),
    sourced(
      "Κάτοικοι λένε ότι το νυχτερινό φέρι ματαιώθηκε, αν και δεν δημοσιεύτηκε ανακοίνωση.",
      "Unverifiable",
      0.32,
      "Η αναζήτηση δεν επέστρεψε ανακοίνωση για ματαίωση του νυχτερινού φέρι.",
      [],
    ),
    sourced(
      "Μια ανώνυμη ανάρτηση υποστήριξε ότι ο λιμενάρχης παραιτήθηκε την Τρίτη.",
      "Unverifiable",
      0.3,
      "Κανένα επώνυμο αρχείο δεν επιβεβαιώνει παραίτηση την Τρίτη.",
      [],
    ),
    sourced(
      "Γείτονες αναφέρουν ότι η πλωτή δεξαμενή καυσίμων έμεινε από πετρέλαιο πριν ξημερώσει.",
      "Unverifiable",
      0.28,
      "Τίποτα στα αποτελέσματα δεν επιβεβαιώνει έλλειψη πετρελαίου στην πλωτή δεξαμενή.",
      [],
    ),
  ];
}

function fixtureReport(
  lang: UiLanguage,
  title: string,
  sourceUrl: string,
  seeds: Seed[],
  options: {
    provisional: boolean;
    searchState: "ok" | "unavailable";
    searchReason: SearchOutageReason | null;
    claimsVerified: number;
    claimsCovered: number;
    claimsTotal: number;
  },
): AnalysisResult {
  const { text, segments } = segmentsFrom(seeds);
  const score = aggregateScore(
    segments.map((segment) => ({
      label: segment.label,
      confidence: segment.confidence,
      hasValidSource: segment.sources.length > 0,
    })),
    {
      contradictionCount: 0,
      searchEnabled: true,
      uiLanguage: lang,
      provisional: options.provisional,
      searchDegraded: options.searchState !== "ok",
      claimsVerified: options.claimsVerified,
      claimsCovered: options.claimsCovered,
      claimsTotal: options.claimsTotal,
    },
  );
  return {
    article: {
      title,
      text,
      sourceDomain: "harbour-lights.example",
      sourceUrl,
      publishedAt: "2026-03-12T08:00:00.000Z",
      detectedLanguage: lang,
    },
    segments,
    score,
    contradictions: [],
    truncated: false,
    degraded: false,
    claimsVerified: options.claimsVerified,
    claimsCovered: options.claimsCovered,
    claimsTotal: options.claimsTotal,
    provisional: options.provisional,
    meta: {
      searchEnabled: true,
      searchDegraded: options.searchState !== "ok",
      searchStatus: { state: options.searchState, reason: options.searchReason, provider: null },
      model: "sample",
      uiLanguage: lang,
      requestId: "sample",
      extraction: "pasted",
      warnings: [],
      outlet: "news",
      subrequests: { ingest: 0, segment: 0, evidence: 0, verify: 0, score: 0, total: 0 },
    },
  };
}

/** Local report for the interface. `mixed` is the original sample. Nothing here calls the network. */
export function buildFixture(id: FixtureId, lang: UiLanguage): AnalysisResult {
  if (id === "mixed") return buildSample(lang);
  if (id === "true") {
    return fixtureReport(
      lang,
      lang === "el" ? "Το συμβούλιο δημοσιεύει την ψηφοφορία για τα τέλη του 2026" : "Council publishes the 2026 berth fee vote",
      "https://harbour-lights.example/fee-vote",
      lang === "el" ? greekTrueSeeds() : englishTrueSeeds(),
      { provisional: false, searchState: "ok", searchReason: null, claimsVerified: 4, claimsCovered: 4, claimsTotal: 4 },
    );
  }
  if (id === "false") {
    return fixtureReport(
      lang,
      lang === "el" ? "Τα τέλη της μαρίνας διπλασιάστηκαν κρυφά μέσα στη νύχτα" : "Marina fees secretly doubled overnight",
      "https://harbour-lights.example/fees-doubled",
      lang === "el" ? greekFalseSeeds() : englishFalseSeeds(),
      { provisional: false, searchState: "ok", searchReason: null, claimsVerified: 4, claimsCovered: 4, claimsTotal: 4 },
    );
  }
  return fixtureReport(
    lang,
    lang === "el" ? "Φήμες στην αποβάθρα και μια ανώνυμη πώληση" : "Wharf rumours and an unnamed sale",
    "https://harbour-lights.example/wharf-rumours",
    lang === "el" ? greekUnverifiableSeeds() : englishUnverifiableSeeds(),
    {
      provisional: true,
      searchState: "unavailable",
      searchReason: "failed",
      claimsVerified: 0,
      claimsCovered: 0,
      claimsTotal: 4,
    },
  );
}
