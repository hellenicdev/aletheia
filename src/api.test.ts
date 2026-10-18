import { describe, expect, it, vi, afterEach } from "vitest";
import { ANALYSIS_STALL_MS, AnalysisError, analyzeArticle, STALL_MESSAGE } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("analyzeArticle stall watchdog", () => {
  it("keeps the retry wait from a 429", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "limited", code: "ip_burst", retryAfter: 125 }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": "125" },
        }),
      ),
    );
    const error = await analyzeArticle({ text: "x".repeat(80), uiLanguage: "en" }, () => {}).catch((caught) => caught);
    expect(error).toBeInstanceOf(AnalysisError);
    expect(error.code).toBe("ip_burst");
    expect(error.retryAfterSeconds).toBe(125);
  });

  it("rejects when the stream sends nothing for 45 seconds", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode('event: stage\ndata: {"stage":"evidence","status":"progress","done":6,"total":12}\n\n'),
        );
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })),
    );
    const pending = analyzeArticle({ text: "x".repeat(80), uiLanguage: "en" }, () => {});
    const assertion = expect(pending).rejects.toThrow(STALL_MESSAGE);
    await vi.advanceTimersByTimeAsync(ANALYSIS_STALL_MS);
    await assertion;
  });

  it("returns a result when events keep arriving", async () => {
    const encoder = new TextEncoder();
    const payload = {
      article: { title: "Harbour", text: "The council voted.", sourceDomain: null, sourceUrl: null, publishedAt: null, detectedLanguage: "en" },
      segments: [],
      score: {
        factualAccuracy: 100,
        factualBasis: "measured",
        sourcing: 100,
        toneNeutrality: 100,
        logicalConsistency: 100,
        overall: 100,
        verdict: "1 of 1",
        counts: { True: 1, False: 0, Misleading: 0, Unverifiable: 0, Opinion: 0, Personal: 0, Rhetorical: 0 },
      },
      contradictions: [],
      truncated: false,
      degraded: false,
      claimsVerified: 1,
      claimsCovered: 1,
      claimsTotal: 1,
      provisional: false,
      meta: {
        searchEnabled: true,
        searchDegraded: false,
        searchStatus: { state: "ok", reason: null, provider: "tavily" },
        model: "test",
        uiLanguage: "en",
        requestId: "r",
        extraction: "pasted",
        warnings: [],
        outlet: "news",
        subrequests: { ingest: 0, segment: 0, evidence: 0, verify: 0, score: 0, total: 0 },
      },
    };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`: ping\n\n`));
        controller.enqueue(encoder.encode(`event: result\ndata: ${JSON.stringify(payload)}\n\n`));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } })),
    );
    const result = await analyzeArticle({ text: "x".repeat(80), uiLanguage: "en" }, () => {});
    expect(result.claimsVerified).toBe(1);
    expect(result.score.verdict).toBe("1 of 1");
  });
});
