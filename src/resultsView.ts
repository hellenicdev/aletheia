import { LABELS, type Label } from "../shared/labels";

/** How many claim cards are shown before "Show all". */
export const CLAIM_LIMIT = 6;

export type ClaimFilter = "all" | Label;

export type ClaimSort = "reading" | "verdict" | "confidence";

/** Problems first, then supported claims, then commentary. Not checked is not a verdict. */
const VERDICT_RANK: Record<Label, number> = {
  False: 0,
  Misleading: 1,
  Unverifiable: 2,
  True: 3,
  Opinion: 4,
  Personal: 5,
  Rhetorical: 6,
  "Not checked": 7,
};

export function parseFilter(value: string | null | undefined): ClaimFilter {
  if (value && (LABELS as readonly string[]).includes(value)) return value as Label;
  return "all";
}

export function parseSort(value: string | null | undefined): ClaimSort {
  if (value === "verdict" || value === "confidence" || value === "reading") return value;
  return "reading";
}

export function sortClaims<T extends { label: Label; confidence: number; start: number }>(
  items: T[],
  sort: ClaimSort,
): T[] {
  const copy = [...items];
  if (sort === "confidence") {
    copy.sort((a, b) => b.confidence - a.confidence || a.start - b.start);
  } else if (sort === "verdict") {
    copy.sort((a, b) => VERDICT_RANK[a.label] - VERDICT_RANK[b.label] || a.start - b.start);
  } else {
    copy.sort((a, b) => a.start - b.start);
  }
  return copy;
}

export function presentLabels<T extends { label: Label }>(items: T[]): Label[] {
  return LABELS.filter((label) => items.some((item) => item.label === label));
}

export function visibleClaims<T extends { label: Label }>(
  items: T[],
  filter: ClaimFilter,
  showAll: boolean,
): { visible: T[]; total: number } {
  const matched = filter === "all" ? items : items.filter((item) => item.label === filter);
  if (showAll || matched.length <= CLAIM_LIMIT) return { visible: matched, total: matched.length };
  return { visible: matched.slice(0, CLAIM_LIMIT), total: matched.length };
}

/** One quiet line. Empty pieces are left out. */
export function joinNotice(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.replace(/\s+/g, " ").trim() ?? "")
    .filter((part) => part.length > 0)
    .join(" · ");
}
