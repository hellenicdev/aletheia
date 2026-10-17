import type { DetectedLanguage, UiLanguage } from "./labels";

const GREEK = /[\u0370-\u03FF\u1F00-\u1FFF]/g;
const LATIN = /[A-Za-z]/g;

export function detectLanguage(text: string): DetectedLanguage {
  const greek = text.match(GREEK)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  const letters = greek + latin;
  if (letters < 8) return "other";
  if (greek / letters >= 0.35) return "el";
  if (latin / letters >= 0.5) return "en";
  return "other";
}

export function languageMatches(text: string, lang: UiLanguage): boolean {
  const greek = text.match(GREEK)?.length ?? 0;
  const latin = text.match(LATIN)?.length ?? 0;
  if (greek + latin < 4) return false;
  if (lang === "el") return greek > latin;
  return latin >= greek;
}

export function languageName(lang: UiLanguage): string {
  return lang === "el" ? "Greek" : "English";
}
