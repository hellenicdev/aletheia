import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONSENT_ANALYTICS,
  CONSENT_DENIED,
  GTAG_IDLE_TIMEOUT_MS,
  denyAnalytics,
  grantAnalytics,
  readConsent,
  trackAnalyzeStarted,
  trackPageView,
  trackShare,
} from "./analytics";

describe("analytics", () => {
  it("sends a content-free analyze_started event", () => {
    const calls: unknown[][] = [];
    trackAnalyzeStarted((...args) => {
      calls.push(args);
    });
    expect(calls).toEqual([["event", "analyze_started"]]);
    trackAnalyzeStarted(undefined);
    expect(calls).toHaveLength(1);
  });

  it("records a share event with the channel and without the article URL", () => {
    const calls: unknown[][] = [];
    trackShare((...args) => {
      calls.push(args);
    }, "copy");
    trackShare(undefined, "web_share");
    expect(calls).toEqual([["event", "share", { method: "copy" }]]);
    expect(JSON.stringify(calls)).not.toContain("http");
  });

  it("grants analytics only and never grants ads", () => {
    const calls: unknown[][] = [];
    const gtag = (...args: unknown[]) => {
      calls.push(args);
    };
    grantAnalytics(gtag);
    trackPageView(gtag);
    denyAnalytics(gtag);
    expect(calls[0]).toEqual(["consent", "update", CONSENT_ANALYTICS]);
    expect(calls[1]).toEqual(["event", "page_view"]);
    expect(calls[2]).toEqual(["consent", "update", CONSENT_DENIED]);
    expect(readConsent({ getItem: () => "accepted" })).toBe("accepted");
    expect(readConsent({ getItem: () => "declined" })).toBe("declined");
    expect(readConsent({ getItem: () => null })).toBeNull();
    expect(readConsent(null)).toBeNull();
    expect(CONSENT_ANALYTICS.analytics_storage).toBe("granted");
    for (const state of [CONSENT_DENIED, CONSENT_ANALYTICS]) {
      expect(state.ad_storage).toBe("denied");
      expect(state.ad_user_data).toBe("denied");
      expect(state.ad_personalization).toBe("denied");
    }
  });

  it("sets consent defaults before gtag config and does not load gtag.js in the document", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const consent = html.indexOf("gtag('consent', 'default'");
    const config = html.indexOf("gtag('config'");
    expect(consent).toBeGreaterThan(-1);
    expect(config).toBeGreaterThan(consent);
    expect(html).toContain("analytics_storage: 'denied'");
    expect(html).toContain("ad_storage: 'denied'");
    expect(html).toContain("ad_user_data: 'denied'");
    expect(html).toContain("ad_personalization: 'denied'");
    expect(html).toContain("allow_google_signals: false");
    expect(html).toContain("allow_ad_personalization_signals: false");
    expect(html).toContain("send_page_view: false");
    expect(html).not.toContain("googletagmanager.com/gtag/js");
    expect(html.indexOf("gtag('consent', 'update'")).toBeLessThan(config);
    const pageView = html.indexOf("gtag('event', 'page_view')");
    expect(pageView).toBeGreaterThan(config);
    expect(html.indexOf("aletheiaConsent === 'accepted'")).toBeLessThan(pageView);
    expect(GTAG_IDLE_TIMEOUT_MS).toBeGreaterThan(0);
    expect(GTAG_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(1_500);
  });
});
