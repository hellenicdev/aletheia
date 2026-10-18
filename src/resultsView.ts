import { LABELS, type Label } from "../shared/labels";

/** How many claim cards are shown before "Show all". */
export const CLAIM_LIMIT = 6;

export type ClaimFilter = "all" | Label;

export function parseFilter(value: string | null | undefined): ClaimFilter {
  if (value && (LABELS as readonly string[]).includes(value)) return value as Label;
  return "all";
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
