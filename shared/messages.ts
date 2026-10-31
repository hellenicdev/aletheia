import type { UiLanguage } from "./labels";

export function analysisTimeoutMessage(lang: UiLanguage): string {
  return lang === "el"
    ? "Η ανάλυση έληξε πριν σταλεί ετυμηγορία. Δοκιμάστε ξανά."
    : "The analysis timed out before a verdict could be sent. Try again.";
}

export function analysisInterruptedMessage(lang: UiLanguage): string {
  return lang === "el"
    ? "Η ανάλυση διακόπηκε πριν σταλεί ετυμηγορία. Δοκιμάστε ξανά."
    : "The analysis was interrupted before a verdict could be sent. Try again.";
}

export function analysisFailedMessage(lang: UiLanguage): string {
  return lang === "el"
    ? "Η ανάλυση δεν ολοκληρώθηκε. Δοκιμάστε ξανά ή επικολλήστε το κείμενο."
    : "The analysis could not be completed. Try again, or paste the article text.";
}

/** Shown when the page could not be scraped or fetched. Never names the provider status. */
export function pageUnreadMessage(lang: UiLanguage): string {
  if (lang === "el") {
    return "Δεν ήταν δυνατή η ανάγνωση της σελίδας. Επικολλήστε το κείμενο του άρθρου.";
  }
  return "This page could not be read. Paste the article text instead.";
}

/** Short banner when the run stopped early but search itself was not down. */
export function partialClaimsNotice(lang: UiLanguage, verified: number, total: number): string {
  if (lang === "el") return `Επαληθεύτηκαν μόνο ${verified} από ${total} ισχυρισμούς.`;
  return `Only ${verified} of ${total} claims could be verified.`;
}

/** One sentence for a cut-short run, including how the checked claims came out. */
export function degradedClaimsSentence(
  lang: UiLanguage,
  verified: number,
  total: number,
  counts: { True: number; False: number; Misleading: number; Unverifiable: number },
): string {
  if (lang === "el") {
    return `Επαληθεύτηκαν μόνο ${verified} από ${total} ισχυρισμούς (${elCount(counts.True, "αληθής", "αληθείς")}, ${elCount(counts.False, "ψευδής", "ψευδείς")}, ${elCount(counts.Misleading, "παραπλανητικός", "παραπλανητικοί")}, ${elCount(counts.Unverifiable, "μη επαληθεύσιμος", "μη επαληθεύσιμοι")}).`;
  }
  return `Only ${verified} of ${total} claims could be verified (${counts.True} true, ${counts.False} false, ${counts.Misleading} misleading, ${counts.Unverifiable} unverifiable).`;
}

function elCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function opinionExplanation(lang: UiLanguage): string {
  return lang === "el"
    ? "Πρόκειται για αξιολογική κρίση ή ερμηνεία, όχι για ισχυρισμό που μπορεί να ελεγχθεί με δημόσια τεκμήρια."
    : "This is a value judgement or interpretation, not a proposition that can be checked against public evidence.";
}

export function rhetoricalExplanation(lang: UiLanguage): string {
  return lang === "el"
    ? "Το απόσπασμα χρησιμοποιεί φορτισμένη ή συναισθηματική γλώσσα χωρίς διακριτό πραγματολογικό ισχυρισμό."
    : "This passage uses loaded or emotional language without a discrete factual proposition.";
}

export function anecdoteExplanation(lang: UiLanguage): string {
  return lang === "el"
    ? "Πρόκειται για προσωπική μαρτυρία, παράθεμα ή περιστατικό, οπότε δεν επιλέχθηκε για έλεγχο."
    : "This is a personal anecdote or quotation, so it was not selected for checking.";
}

/** A checkable claim the 12-search cap did not reach. Not a verdict. */
export function notCheckedExplanation(lang: UiLanguage): string {
  return lang === "el"
    ? "Δεν ελέγχθηκε σε αυτή την ανάλυση για εξοικονόμηση μονάδων αναζήτησης."
    : "Not checked in this analysis to save search credits.";
}

export function unverifiableExplanation(
  lang: UiLanguage,
  reason:
    | "no-evidence"
    | "weak-evidence"
    | "uncited"
    | "search-failed"
    | "budget"
    | "model-only"
    | "not-independent"
    | "entity-mismatch"
    | "not-contradiction"
    | "detail-missing"
    | "check-failed",
): string {
  const el: Record<typeof reason, string> = {
    "no-evidence":
      "Η αναζήτηση δεν επέστρεψε σελίδες που να αφορούν τον ισχυρισμό, οπότε μένει μη επαληθεύσιμος.",
    "weak-evidence":
      "Οι σελίδες που ανακτήθηκαν δεν στηρίζουν σαφή ετυμηγορία, οπότε ο ισχυρισμός μένει μη επαληθεύσιμος.",
    uncited:
      "Δεν υπάρχει παραπομπή μέσα στα ανακτημένα τεκμήρια, οπότε ο ισχυρισμός μένει μη επαληθεύσιμος.",
    "search-failed":
      "Η ανάκτηση τεκμηρίων απέτυχε για αυτόν τον ισχυρισμό, οπότε μένει μη επαληθεύσιμος.",
    budget:
      "Αυτός ο ισχυρισμός δεν επιλέχθηκε για έλεγχο.",
    "model-only":
      "Χωρίς ζωντανή αναζήτηση ο ισχυρισμός μένει μη επαληθεύσιμος. Δεν παρατίθεται πηγή.",
    "not-independent":
      "Οι μόνες σελίδες που βρέθηκαν είναι το ίδιο το άρθρο ή αντίγραφά του, οπότε ο ισχυρισμός δεν επαληθεύεται ανεξάρτητα.",
    "entity-mismatch":
      "Τα τεκμήρια αφορούν διαφορετικό πρόσωπο, τόπο ή γεγονός, οπότε ο ισχυρισμός δεν κρίνεται ψευδής και μένει μη επαληθεύσιμος.",
    "not-contradiction":
      "Τα τεκμήρια δεν παραθέτουν ασύμβατο γεγονός για το ίδιο πράγμα, οπότε μια διαφορά ή μια παράλειψη δεν κάνει τον ισχυρισμό ψευδή.",
    "detail-missing":
      "Τα τεκμήρια στηρίζουν ένα σχετικό γεγονός, όχι αυτή τη συγκεκριμένη λεπτομέρεια, οπότε ο ισχυρισμός μένει μη επαληθεύσιμος.",
    "check-failed":
      "Ο έλεγχος δεν ολοκληρώθηκε επειδή απέτυχε η κλήση του μοντέλου, οπότε αυτό δεν είναι κρίση επί των τεκμηρίων.",
  };
  const en: Record<typeof reason, string> = {
    "no-evidence":
      "Search returned no pages that address this claim, so it stays unverified.",
    "weak-evidence":
      "The retrieved pages do not support a firm verdict, so this claim stays unverified.",
    uncited:
      "No citation from the retrieved evidence was provided, so this claim stays unverified.",
    "search-failed":
      "Evidence retrieval failed for this claim, so it stays unverified.",
    budget:
      "This claim was not selected for checking.",
    "model-only":
      "Without live web search this claim stays unverified. No source is cited.",
    "not-independent":
      "The only pages found were this article or copies of it, so the claim is not independently verified.",
    "entity-mismatch":
      "The evidence is about a different person, place, or event, so this claim is not marked false and stays unverified.",
    "not-contradiction":
      "The evidence does not quote an incompatible fact about the same thing, so a different detail or an omission does not make this claim false.",
    "detail-missing":
      "The evidence supports a related fact but not this specific detail, so the claim stays unverified.",
    "check-failed":
      "The fact-check did not finish because the model call failed, so this is not a verdict on the evidence.",
  };
  return lang === "el" ? el[reason] : en[reason];
}
