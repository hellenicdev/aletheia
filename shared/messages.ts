import type { UiLanguage } from "./labels";

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

export function unverifiableExplanation(
  lang: UiLanguage,
  reason: "no-evidence" | "weak-evidence" | "uncited" | "search-failed" | "budget" | "model-only",
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
      "Ο ισχυρισμός δεν ελέγχθηκε σε ζωντανή αναζήτηση σε αυτό το αίτημα, επειδή ξεπεράστηκε το όριο τεκμηρίων.",
    "model-only":
      "Χωρίς ζωντανή αναζήτηση ο ισχυρισμός μένει μη επαληθεύσιμος. Δεν παρατίθεται πηγή.",
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
      "This claim was not checked against live search in this request because the evidence budget was reached.",
    "model-only":
      "Without live web search this claim stays unverified. No source is cited.",
  };
  return lang === "el" ? el[reason] : en[reason];
}
