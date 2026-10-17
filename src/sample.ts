import type { EvidenceMode, Label, UiLanguage } from "../shared/labels";
import { aggregateScore } from "../shared/score";
import type { AnalysisResult, Contradiction, SegmentResult, SourceCitation } from "../shared/types";

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
    meta: {
      searchEnabled: true,
      searchDegraded: false,
      model: "sample",
      uiLanguage: lang,
      requestId: "sample",
      extraction: "pasted",
    },
  };
}
