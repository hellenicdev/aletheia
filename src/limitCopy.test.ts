import { describe, expect, it } from "vitest";
import { presentLimit } from "./limitCopy";

const codes = [
  ["ip_burst", "this network", "αυτό το δίκτυο"],
  ["ip_daily", "daily analysis", "ημερήσιο όριο αναλύσεων"],
  ["ip_concurrent", "already running", "εκτελείται ήδη"],
  ["tavily_daily", "tomorrow", "αύριο"],
  ["global_busy", "busy with other analyses", "απασχολημένη"],
] as const;

describe("limit copy", () => {
  it("names every 429 code in English and Greek", () => {
    for (const [code, english, greek] of codes) {
      expect(presentLimit({ code, status: 429, retryAfterSeconds: 90 }, "en")).toContain(english);
      expect(presentLimit({ code, status: 429, retryAfterSeconds: 90 }, "el")).toContain(greek);
    }
    expect(presentLimit({ code: "tavily_monthly", status: 429, retryAfterSeconds: 86_400 }, "en")).toContain(
      "next month",
    );
    expect(presentLimit({ code: "tavily_monthly", status: 429, retryAfterSeconds: 86_400 }, "el")).toContain("μήνα");
  });

  it("uses a friendly message for the limiter 503", () => {
    expect(presentLimit({ status: 503, code: "limiter_unavailable" }, "en")).toContain("could not record");
    expect(presentLimit({ status: 503 }, "el")).toContain("καταγράψει");
    expect(presentLimit({ status: 400, code: "bad_json" }, "en")).toBeNull();
  });
});
