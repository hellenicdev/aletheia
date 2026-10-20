import { describe, expect, it } from "vitest";
import { analysisFailedMessage, analysisInterruptedMessage, analysisTimeoutMessage } from "../../shared/messages";
import { handleRequest } from "../src/index";

function events(body: string): Array<{ event: string; data: Record<string, unknown> }> {
  return body
    .split("\n\n")
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1];
      const data = block.match(/^data: (.+)$/m)?.[1];
      if (!event || !data) return null;
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    })
    .filter((item): item is { event: string; data: Record<string, unknown> } => item !== null);
}

describe("demo health and failures", () => {
  it("reports the configured provider chain without calling search", async () => {
    let calls = 0;
    const response = await handleRequest(
      new Request("https://worker.test/api/health"),
      {
        OPENAI_API_KEY: "openai-secret",
        OPENAI_MODEL: "Beam-501B-A23B",
        FIRECRAWL_API_KEY: "firecrawl-secret",
        TAVILY_API_KEY: "tavily-secret",
      },
      {
        fetchImpl: async () => {
          calls += 1;
          return new Response("nope", { status: 500 });
        },
      },
    );
    expect(response.status).toBe(200);
    expect(calls).toBe(0);
    const body = (await response.json()) as {
      model: string;
      searchProvider: string;
      search: { active: string; firecrawl: string; tavily: string };
    };
    expect(body.model).toBe("Beam-501B-A23B");
    expect(body.searchProvider).toBe("firecrawl-then-tavily");
    expect(body.search).toMatchObject({ active: "firecrawl-then-tavily", firecrawl: "configured", tavily: "configured" });
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain("secret");
    expect(serialised).not.toContain("openai");
  });

  it("sends a Greek interruption the page can recognise", async () => {
    const controller = new AbortController();
    const response = await handleRequest(
      new Request("https://worker.test/api/analyze", {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Origin: "http://127.0.0.1:5173",
        },
        body: JSON.stringify({
          text: "The harbour fee doubled to 880 euros after the Monday vote in Piraeus.",
          uiLanguage: "el",
        }),
      }),
      { OPENAI_API_KEY: "test-key", ALLOW_MEMORY_LIMITER: "1" },
      {
        deadlineMs: 30_000,
        pingMs: 60_000,
        fetchImpl: () => new Promise(() => {}),
      },
    );
    controller.abort();
    const error = events(await response.text()).find((event) => event.event === "error");
    expect(error?.data.code).toBe("interrupted");
    expect(error?.data.message).toBe(analysisInterruptedMessage("el"));
    expect(analysisTimeoutMessage("el")).toContain("Δοκιμάστε ξανά");
    expect(analysisFailedMessage("en")).toContain("paste the article text");
  });
});
