import { appBaseFromPath, siteBase } from "./seo";

export type ScoreBand = "high" | "mid" | "low" | "provisional";

/** Same cuts as the gauge: under 45 is low, under 75 is mixed, otherwise high. */
export function scoreBand(overall: number, provisional: boolean): ScoreBand {
  if (provisional) return "provisional";
  if (overall < 45) return "low";
  if (overall < 75) return "mid";
  return "high";
}

export function shareMessage(template: string, score: number, band: string): string {
  return template.replaceAll("{score}", String(score)).replaceAll("{band}", band);
}

export interface SharePage {
  hostname: string;
  origin: string;
  pathname: string;
}

/**
 * Permalink that reopens a cached report. Greek keeps the /el/ path so the
 * cache lookup uses the same language the report was saved in.
 * Null when the analysis has no public article URL (a paste).
 */
export function reportPermalink(lang: "en" | "el", articleUrl: string, page: SharePage): string | null {
  const trimmed = articleUrl.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const base = siteBase(page.hostname, page.origin, appBaseFromPath(page.pathname));
  const root = lang === "el" ? `${base}el/` : base;
  const params = new URLSearchParams();
  params.set("url", trimmed);
  return `${root}?${params.toString()}`;
}

export const SHARE_CHANNELS = ["copy", "x", "facebook", "linkedin", "whatsapp", "telegram", "email"] as const;
export type ShareChannel = (typeof SHARE_CHANNELS)[number];

/** Web Share is the mobile path. A fine pointer keeps the menu, which is what desktop needs. */
export function prefersWebShare(input: { canShare: boolean; coarsePointer: boolean }): boolean {
  return input.canShare && input.coarsePointer;
}

export function shareTarget(
  channel: Exclude<ShareChannel, "copy">,
  text: string,
  url: string,
  subject: string,
): string {
  const full = `${text} ${url}`;
  switch (channel) {
    case "x":
      return `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    case "facebook":
      return `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`;
    case "linkedin":
      return `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`;
    case "whatsapp":
      return `https://wa.me/?text=${encodeURIComponent(full)}`;
    case "telegram":
      return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
    case "email":
      return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(`${text}\n\n${url}`)}`;
  }
}

export async function writeClipboard(text: string, doc: Document = document): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Fall through to the selection copy. */
  }
  try {
    const area = doc.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    doc.body.append(area);
    area.select();
    const ok = doc.execCommand("copy");
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
