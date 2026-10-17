import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import type { RateState } from "../src/limits";
import { analyze } from "../src/pipeline";

const vote = "The council voted 7 to 2 on Monday.";
const fee = "The marina fee doubled overnight.";
const rhetoric = "This betrayal will ruin everything we love.";
const article = `${vote} ${fee} ${rhetoric}`;

const minutes = {
  url: "https://example.com/minutes",
  title: "Council minutes",
  description: "The council voted 7 to 2 on Monday.",
};
const fees = {
  url: "https://example.com/fees",
  title: "Fee schedule",
  description: "Marina fees rose by 2 percent, not double.",
};

function llmPayload(content: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: typeof content === "string" ? content : JSON.stringify(content),
          },
        },
      ],
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function scriptedFetch(options?: {
  greek?: boolean;
  segmentFailures?: number;
}) {
  let segmentFailures = options?.segmentFailures ?? 0;
  const seen: { url: string; body?: Record<string, unknown> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    seen.push({ url, body });
    if (url.includes("/chat/completions")) {
      const messages = body?.messages as { content: string }[];
      const system = messages[0]?.content ?? "";
      const user = messages[1]?.content ?? "";
      const greek = system.includes("in Greek");
      if (system.startsWith("TASK:segment")) {
        if (segmentFailures > 0) {
          segmentFailures -= 1;
          return llmPayload("nope");
        }
        return llmPayload({
          detectedLanguage: "en",
          segments: [
            { text: vote, claimType: "checkable_factual", note: "A recorded vote." },
            { text: fee, claimType: "checkable_factual", note: "A numeric claim." },
            { text: rhetoric, claimType: "rhetorical", note: "Loaded language without a fact." },
          ],
        });
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({
          queries: [
            { id: "s1", query: "council voted 7 to 2 Monday" },
            { id: "s2", query: "marina fee doubled overnight" },
          ],
        });
      }
      if (system.startsWith("TASK:verify")) {
        const explain = (en: string, el: string) => (greek ? el : en);
        return llmPayload({
          results: [
            {
              id: "s1",
              label: "True",
              confidence: 0.92,
              explanation: explain(
                "The minutes record a seven to two vote.",
                "Τα πρακτικά καταγράφουν ψηφοφορία επτά προς δύο.",
              ),
              sourceUrls: [minutes.url, "https://evil.example/phish"],
            },
            {
              id: "s2",
              label: "False",
              confidence: 0.88,
              explanation: explain(
                "The schedule shows a two percent rise, not a doubling.",
                "Ο πίνακας δείχνει αύξηση δύο τοις εκατό, όχι διπλασιασμό.",
              ),
              sourceUrls: ["https://evil.example/only"],
            },
          ],
        });
      }
      if (system.startsWith("TASK:consistency")) {
        return llmPayload({
          contradictions: [
            {
              a: "s1",
              b: "s9",
              explanation: greek
                ? "Αυτό το ζεύγος δεν πρέπει να μετρήσει."
                : "This pair should be ignored.",
            },
          ],
        });
      }
      throw new Error(`unexpected task ${system.slice(0, 40)} from ${user.slice(0, 20)}`);
    }
    if (url.includes("api.firecrawl.dev/v2/search")) {
      const query = String((body as { query?: string } | undefined)?.query ?? "");
      const web = query.includes("council")
        ? [{ url: minutes.url, title: minutes.title, description: minutes.description }]
        : query.includes("marina")
          ? [{ url: fees.url, title: fees.title, description: fees.description }]
          : [];
      return new Response(JSON.stringify({ success: true, data: { web } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("api.firecrawl.dev/v2/scrape")) {
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            markdown: `# Harbour vote\n\n${vote}\n\n${fee}\n\n${rhetoric}`,
            metadata: {
              title: "Harbour vote",
              sourceURL: "https://news.example/harbour",
              publishedTime: "2026-03-03T10:00:00Z",
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetchImpl, seen };
}

const env = {
  OPENAI_API_KEY: "test-key",
  FIRECRAWL_API_KEY: "firecrawl-test-key",
  OPENAI_MODEL: "Beam-501B-A23B",
  OPENAI_BASE_URL: "https://api.reflection.ai/openai/v1",
};

describe("analyze", () => {
  it("grounds labels in retrieved pages and discards invented URLs", async () => {
    const { fetchImpl, seen } = scriptedFetch({ segmentFailures: 1 });
    const result = await analyze(
      { text: article, uiLanguage: "en" },
      { env, fetchImpl, requestId: "req-1" },
    );

    expect(result.meta.model).toBe("Beam-501B-A23B");
    expect(result.meta.searchEnabled).toBe(true);
    expect(result.article.detectedLanguage).toBe("en");
    expect(result.segments.map((segment) => segment.label)).toEqual([
      "True",
      "Unverifiable",
      "Rhetorical",
    ]);
    expect(result.segments[0].sources.map((source) => source.url)).toEqual([minutes.url]);
    expect(result.segments[1].sources).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("evil.example");
    for (const segment of result.segments) {
      expect(result.article.text.slice(segment.start, segment.end)).toBe(segment.text);
    }
    expect(result.contradictions).toEqual([]);
    expect(result.score.overall).toBeGreaterThan(0);
    expect(result.score.overall).toBeLessThanOrEqual(100);
    expect(seen.some((call) => call.url.includes("/chat/completions") && call.body?.temperature === 0)).toBe(
      true,
    );
  });

  it("returns Greek explanations when the interface language is Greek", async () => {
    const { fetchImpl } = scriptedFetch();
    const result = await analyze({ text: article, uiLanguage: "el" }, { env, fetchImpl });
    expect(result.segments[0].explanation).toMatch(/[\u0370-\u03FF]/);
    expect(result.score.verdict).toMatch(/[\u0370-\u03FF]/);
  });

  it("marks model-only judgements when search is not configured", async () => {
    const stable = "Paris is the capital of France and has been for generations.";
    const news = "The marina fee doubled in 2024 according to the mayor.";
    const text = `${stable} ${news}`;
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0].content;
      if (system.startsWith("TASK:segment")) {
        return llmPayload({
          detectedLanguage: "en",
          segments: [
            { text: stable, claimType: "checkable_factual", note: "A stable geographic fact." },
            { text: news, claimType: "checkable_factual", note: "A recent numeric claim." },
          ],
        });
      }
      if (system.startsWith("TASK:verify")) {
        return llmPayload({
          results: [
            {
              id: "s1",
              label: "True",
              confidence: 0.99,
              explanation: "Paris is the capital of France.",
              sourceUrls: ["https://example.com/should-not-stick"],
            },
            {
              id: "s2",
              label: "True",
              confidence: 0.8,
              explanation: "Reports described a doubling in 2024.",
              sourceUrls: ["https://example.com/also-no"],
            },
          ],
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 20));
    };

    const result = await analyze(
      { text, uiLanguage: "en" },
      { env: { OPENAI_API_KEY: "test-key" }, fetchImpl },
    );
    expect(result.meta.searchEnabled).toBe(false);
    expect(result.segments[0].label).toBe("True");
    expect(result.segments[0].evidenceMode).toBe("model-knowledge-only");
    expect(result.segments[0].sources).toEqual([]);
    expect(result.segments[0].confidence).toBeLessThanOrEqual(0.55);
    expect(result.segments[1].label).toBe("Unverifiable");
    expect(result.segments[1].sources).toEqual([]);
    expect(result.score.verdict).toContain("model-knowledge-only");
  });

  it("extracts a fetched article before auditing it", async () => {
    const { fetchImpl, seen } = scriptedFetch();
    const result = await analyze(
      { url: "https://news.example/harbour", uiLanguage: "en" },
      { env, fetchImpl },
    );
    expect(result.article.title).toBe("Harbour vote");
    expect(result.article.sourceDomain).toBe("news.example");
    expect(result.article.text).toContain(vote);
    expect(result.article.text).not.toContain("Ignore me please");
    expect(result.meta.extraction).toBe("firecrawl");
    expect(result.segments[0].label).toBe("True");
    const scrape = seen.find((call) => call.url.includes("/v2/scrape"));
    expect(scrape?.body).toMatchObject({
      url: "https://news.example/harbour",
      formats: ["markdown"],
      onlyMainContent: true,
    });
    expect(JSON.stringify(scrape?.body)).not.toContain("firecrawl-test-key");
  });

  it("rejects private URLs before any fetch", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not fetch");
    };
    await expect(
      analyze({ url: "http://169.254.169.254/latest/meta-data", uiLanguage: "en" }, { env, fetchImpl }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("handleRequest", () => {
  it("allows the GitHub Pages origin and hides the worker from other sites", async () => {
    const health = await handleRequest(
      new Request("https://worker.test/api/health", {
        headers: { Origin: "https://hellenicdev.github.io" },
      }),
      env,
    );
    expect(health.status).toBe(200);
    expect(health.headers.get("access-control-allow-origin")).toBe("https://hellenicdev.github.io");

    const blocked = await handleRequest(
      new Request("https://worker.test/api/health", {
        headers: { Origin: "https://evil.example" },
      }),
      env,
    );
    expect(blocked.status).toBe(403);
  });

  it("streams a full analysis for a localhost caller", async () => {
    const { fetchImpl } = scriptedFetch();
    const rate: RateState = { buckets: new Map(), inFlight: { count: 0 } };
    const response = await handleRequest(
      new Request("https://worker.test/api/analyze", {
        method: "POST",
        headers: { Origin: "http://localhost:5173", "Content-Type": "application/json" },
        body: JSON.stringify({ text: article, uiLanguage: "en" }),
      }),
      env,
      { fetchImpl, rate, now: () => 1_000 },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = parseSse(await response.text());
    expect(events.map((event) => event.event)).toContain("result");
    const result = events.find((event) => event.event === "result")?.data as {
      segments: { label: string }[];
    };
    expect(result.segments[0].label).toBe("True");
    expect(rate.inFlight.count).toBe(0);
  });

  it("rate limits repeated analyses", async () => {
    const rate: RateState = { buckets: new Map(), inFlight: { count: 0 } };
    const envTight = { ...env, RATE_LIMIT_PER_IP: "1" };
    const first = await handleRequest(post(article), envTight, { rate, now: () => 5_000, fetchImpl: scriptedFetch().fetchImpl });
    await first.text();
    const second = await handleRequest(post(article), envTight, { rate, now: () => 5_100, fetchImpl: scriptedFetch().fetchImpl });
    expect(second.status).toBe(429);
  });

  it("rejects an oversized article before calling the model", async () => {
    let called = false;
    const response = await handleRequest(
      post("A".repeat(13_000)),
      env,
      {
        fetchImpl: async () => {
          called = true;
          return new Response("no");
        },
      },
    );
    const events = parseSse(await response.text());
    expect(events.find((event) => event.event === "error")?.data).toMatchObject({
      message: expect.stringContaining("12000"),
    });
    expect(called).toBe(false);
  });
});

function post(text: string): Request {
  return new Request("https://worker.test/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
    body: JSON.stringify({ text, uiLanguage: "en" }),
  });
}

function parseSse(body: string): { event: string; data: unknown }[] {
  return body
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = block.match(/^event: (.+)$/m)?.[1] ?? "";
      const data = block.match(/^data: (.+)$/m)?.[1] ?? "{}";
      return { event, data: JSON.parse(data) };
    });
}
