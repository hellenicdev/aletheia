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

export function grantAnalytics(gtag?: (...args: unknown[]) => void): void {
  gtag?.("consent", "update", { ...CONSENT_ANALYTICS });
}

export function denyAnalytics(gtag?: (...args: unknown[]) => void): void {
  gtag?.("consent", "update", { ...CONSENT_DENIED });
}

/**
 * gtag.js is injected after load, on idle. The inline stub has already queued
 * consent and config, so the first page_view is sent when this script runs.
 * The library is much heavier than the Ko-fi widget, so it waits out the first
 * idle slice. An immediate idle callback still lands in the opening interaction
 * window and brings mobile performance back down.
 */
export const GTAG_DELAY_MS = 6_000;

export function scheduleGtag(target: Window = window): void {
  const start = () => {
    const run = () => injectGtag(target.document);
    target.setTimeout(() => {
      const idle = target.requestIdleCallback?.bind(target);
      if (idle) idle(run, { timeout: 2_000 });
      else run();
    }, GTAG_DELAY_MS);
  };
  if (target.document.readyState === "complete") start();
  else target.addEventListener("load", start, { once: true });
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
