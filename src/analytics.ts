/** Page views come from the standard gtag config. This event carries no article text or URL. */
export function trackAnalyzeStarted(gtag?: (...args: unknown[]) => void): void {
  gtag?.("event", "analyze_started");
}

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
  }
}
