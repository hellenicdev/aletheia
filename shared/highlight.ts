import type { Label } from "./labels";

export interface HighlightSegment {
  id: string;
  start: number;
  end: number;
  label: Label;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderHighlighted(text: string, segments: HighlightSegment[]): string {
  const usable = segments
    .filter(
      (segment) =>
        segment.start >= 0 &&
        segment.end > segment.start &&
        segment.end <= text.length &&
        text.slice(segment.start, segment.end).trim().length > 0,
    )
    .sort((a, b) => a.start - b.start);

  const chosen: HighlightSegment[] = [];
  let cursor = 0;
  for (const segment of usable) {
    if (segment.start < cursor) continue;
    chosen.push(segment);
    cursor = segment.end;
  }

  let html = "";
  let index = 0;
  for (const segment of chosen) {
    html += escapeHtml(text.slice(index, segment.start));
    const body = escapeHtml(text.slice(segment.start, segment.end));
    html += `<button type="button" class="claim" data-id="${escapeHtml(segment.id)}" data-label="${segment.label}">${body}</button>`;
    index = segment.end;
  }
  html += escapeHtml(text.slice(index));
  return html;
}
