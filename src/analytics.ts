/** Page views come from the standard gtag config. This event carries no article text or URL. */
export const GA_MEASUREMENT_ID = "G-9FWQFZME3Z";
export const CONSENT_STORAGE_KEY = "aletheia-consent";

/** Consent Mode v2. Advertising stays denied even after the visitor accepts analytics. */
export const CONSENT_DENIED = {
  analytics_storage: "denied",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
} as const;

export const CONSENT_ANALYTICS = {
  analytics_storage: "granted",
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
} as const;

export function trackAnalyzeStarted(gtag?: (...args: unknown[]) => void): void {
  gtag?.("event", "analyze_started");
}

/** Recommended `share` event. The method is the channel. The article URL stays out. */
export function trackShare(gtag: ((...args: unknown[]) => void) | undefined, method: string): void {
  gtag?.("event", "share", { method });
}

export function grantAnalytics(gtag?: (...args: unknown[]) => void): void {
  gtag?.("consent", "update", { ...CONSENT_ANALYTICS });
}

export function denyAnalytics(gtag?: (...args: unknown[]) => void): void {
  gtag?.("consent", "update", { ...CONSENT_DENIED });
}

/** Sent only after analytics consent is granted, so the hit is not a denied ping. */
export function trackPageView(gtag?: (...args: unknown[]) => void): void {
  gtag?.("event", "page_view");
}

export function readConsent(storage: Pick<Storage, "getItem"> | null): "accepted" | "declined" | null {
  try {
    const value = storage?.getItem(CONSENT_STORAGE_KEY);
    return value === "accepted" || value === "declined" ? value : null;
  } catch {
    return null;
  }
}

/**
 * gtag.js loads only after Accept. A return visit schedules it on idle, or
 * after this timeout, so a short visit is still measured. The library stays
 * off the first view, which is what Lighthouse records.
 */
export const GTAG_IDLE_TIMEOUT_MS = 1_500;

export function scheduleGtag(target: Window = window): void {
  const run = () => injectGtag(target.document);
  const idle = target.requestIdleCallback?.bind(target);
  if (idle) idle(run, { timeout: GTAG_IDLE_TIMEOUT_MS });
  else target.setTimeout(run, GTAG_IDLE_TIMEOUT_MS);
}

export function injectGtag(doc: Document, id = GA_MEASUREMENT_ID): void {
  if (doc.querySelector("script[data-ga='gtag']")) return;
  const script = doc.createElement("script");
  script.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
  script.async = true;
  script.dataset.ga = "gtag";
  doc.head.append(script);
}

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}
