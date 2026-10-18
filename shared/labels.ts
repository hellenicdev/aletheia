export const LABELS = [
  "True",
  "False",
  "Misleading",
  "Unverifiable",
  "Opinion",
  "Personal",
  "Rhetorical",
] as const;

export type Label = (typeof LABELS)[number];

export const CLAIM_TYPES = [
  "checkable_factual",
  "opinion",
  "personal",
  "rhetorical",
  "mixed",
] as const;

export type ClaimType = (typeof CLAIM_TYPES)[number];

export type EvidenceMode =
  | "web-search"
  | "model-knowledge-only"
  | "not-applicable";

export type UiLanguage = "en" | "el";

export type DetectedLanguage = "en" | "el" | "other";

export function isLabel(value: string): value is Label {
  return (LABELS as readonly string[]).includes(value);
}

export function isUiLanguage(value: unknown): value is UiLanguage {
  return value === "en" || value === "el";
}
