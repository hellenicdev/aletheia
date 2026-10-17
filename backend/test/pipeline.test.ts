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

function classifyPayload(
  user: string,
  classify: (text: string) => { claimType: string; note: string },
) {
  const start = user.indexOf("[");
  const sentences = JSON.parse(user.slice(start)) as { id: string; text: string }[];
  return {
    detectedLanguage: "en",
    genre: "news",
    segments: sentences.map((sentence) => ({ id: sentence.id, ...classify(sentence.text) })),
  };
}

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
        return llmPayload(classifyPayload(user, (text) => {
          if (text.includes("betrayal") || text.includes("breathtaking")) {
            return { claimType: "rhetorical", note: "Loaded language without a fact." };
          }
          return { claimType: "checkable_factual", note: "A recorded claim." };
        }));
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
            markdown: `Enable accessibility\nSee All Newsletters\nIgnore me please\n\n# Harbour vote\n\n${vote}\n\n${fee}\n\n${rhetoric}`,
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
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({
          claimType: "checkable_factual",
          note: "A recorded claim.",
        })));
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
      formats: ["markdown", "html"],
      onlyMainContent: true,
      excludeTags: expect.arrayContaining(["nav", "header", "footer", "aside", "form"]),
    });
    expect(JSON.stringify(scrape?.body)).not.toContain("firecrawl-test-key");
  });

  it("records upstream failures and does not treat a slogan as unverifiable", async () => {
    const text =
      "The Eiffel Tower is located in Berlin and was completed in 1889. It is, without doubt, the most breathtaking structure humanity has ever built.";
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("Illegal invocation: function called with incorrect this");
    };
    const result = await analyze({ text, uiLanguage: "en" }, { env, fetchImpl });
    expect(result.segments.map((segment) => segment.label)).toEqual(["Unverifiable", "Rhetorical"]);
    expect(result.segments[1].explanation).not.toContain("Evidence retrieval failed");
    expect(result.meta.warnings.some((warning) => warning.startsWith("llm:"))).toBe(true);
    expect(result.meta.warnings.some((warning) => warning.startsWith("search:"))).toBe(true);
  });

  it("keeps a model-classified rhetorical sentence when search returns HTTP 401", async () => {
    const fact = "The Eiffel Tower is located in Berlin and was completed in 1889.";
    const slogan = "It is, without doubt, the most breathtaking structure humanity has ever built.";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        return new Response("Unauthorized: Invalid token", { status: 401 });
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, (text) => ({
          claimType: text.includes("without doubt") ? "rhetorical" : "checkable_factual",
          note: text.includes("without doubt") ? "Praise without a discrete fact." : "A place and a year.",
        })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({ queries: [{ id: "s1", query: "Eiffel Tower Berlin 1889" }] });
      }
      throw new Error(system.slice(0, 24));
    };
    const result = await analyze(
      { text: `${fact} ${slogan}`, uiLanguage: "en" },
      { env, fetchImpl },
    );
    expect(result.segments.map((segment) => segment.label)).toEqual(["Unverifiable", "Rhetorical"]);
    expect(result.meta.searchDegraded).toBe(true);
    expect(result.meta.warnings.some((warning) => warning.includes("search: HTTP 401"))).toBe(true);
    expect(result.meta.warnings.join(" ")).not.toContain("firecrawl-test-key");
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
  it("probes the model and Firecrawl without echoing secrets", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        return new Response("Unauthorized token firecrawl-test-key", { status: 401 });
      }
      return new Response(JSON.stringify({ error: { message: "unknown model test-key" } }), {
        status: 400,
      });
    };
    const response = await handleRequest(
      new Request("https://worker.test/api/health?probe=1"),
      env,
      { fetchImpl, rate: { buckets: new Map(), inFlight: { count: 0 } }, now: () => 1 },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      ok: boolean;
      probe: { llm: { ok: boolean; status: number; error: string }; search: { ok: boolean; status: number; error: string } };
    };
    expect(body.ok).toBe(false);
    expect(body.probe.llm).toMatchObject({ ok: false, status: 400 });
    expect(body.probe.llm.error).toContain("llm: HTTP 400");
    expect(body.probe.search).toMatchObject({ ok: false, status: 401 });
    expect(body.probe.search.error).toContain("search: HTTP 401");
    expect(JSON.stringify(body)).not.toContain("test-key");
    expect(JSON.stringify(body)).not.toContain("firecrawl-test-key");
  });

  it("reports the field, finish reason, and a short preview of Beam output", async () => {
    const bodies: Record<string, unknown>[] = [];
    let llmCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
      }
      llmCalls += 1;
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const message =
        llmCalls === 1
          ? {
              content: `<think>The brace { inside reasoning is not the payload.</think>\n{"ok":true}`,
              reasoning_content: "draft only",
            }
          : llmCalls === 2
            ? { content: null, reasoning_content: 'Answer follows. {"ok":true}' }
            : { content: `{"ok":${"x".repeat(400)}`, reasoning_content: null };
      const finish = llmCalls === 3 ? "length" : "stop";
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: finish, message }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const probe = async () => {
      const response = await handleRequest(
        new Request("https://worker.test/api/health?probe=1"),
        env,
        { fetchImpl, rate: { buckets: new Map(), inFlight: { count: 0 } }, now: () => 2 },
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        ok: boolean;
        probe: {
          llm: { ok: boolean; status: number; error?: string; finishReason?: string; field?: string; preview?: string };
          search: { ok: boolean };
        };
      };
    };

    const wrapped = await probe();
    expect(wrapped.ok).toBe(true);
    expect(wrapped.probe.llm).toMatchObject({
      ok: true,
      status: 200,
      finishReason: "stop",
      field: "content",
    });
    expect(wrapped.probe.llm.preview).toContain("<think>");
    expect(wrapped.probe.llm.preview?.length).toBeLessThanOrEqual(300);
    expect(bodies[0]?.max_completion_tokens).toBe(4096);
    expect(bodies[0]).not.toHaveProperty("max_tokens");

    const reasoned = await probe();
    expect(reasoned.probe.llm).toMatchObject({
      ok: true,
      field: "reasoning_content",
      finishReason: "stop",
    });
    expect(reasoned.probe.llm.preview).toContain('{"ok":true}');

    const truncated = await probe();
    expect(truncated.ok).toBe(false);
    expect(truncated.probe.llm).toMatchObject({
      ok: false,
      status: 502,
      finishReason: "length",
      field: "content",
    });
    expect(truncated.probe.llm.error).toContain("not valid JSON");
    expect(truncated.probe.llm.preview).toHaveLength(300);
    expect(truncated.probe.llm.preview?.startsWith('{"ok":')).toBe(true);
    expect(JSON.stringify(truncated)).not.toContain("test-key");
  });


  it("allows the GitHub Pages origin and hides the worker from other sites", async () => {
    const health = await handleRequest(
      new Request("https://worker.test/api/health", {
        headers: { Origin: "https://hellenicdev.github.io" },
      }),
      env,
    );
    expect(health.status).toBe(200);
    expect(health.headers.get("access-control-allow-origin")).toBe("https://hellenicdev.github.io");

    const custom = await handleRequest(
      new Request("https://worker.test/api/health", {
        headers: { Origin: "https://hellenicdev.eu" },
      }),
      env,
    );
    expect(custom.status).toBe(200);
    expect(custom.headers.get("access-control-allow-origin")).toBe("https://hellenicdev.eu");

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

  it("truncates pasted text over the character budget and still returns a result", async () => {
    const { fetchImpl } = scriptedFetch();
    const response = await handleRequest(post(`${"The council voted 7 to 2 on Monday. ".repeat(400)}`), env, {
      fetchImpl,
      rate: { buckets: new Map(), inFlight: { count: 0 } },
      now: () => 9_000,
    });
    const events = parseSse(await response.text());
    const result = events.find((event) => event.event === "result")?.data as {
      truncated: boolean;
      article: { text: string };
    };
    expect(result.truncated).toBe(true);
    expect(result.article.text.length).toBeLessThanOrEqual(12_000);
    expect(events.some((event) => event.event === "preview")).toBe(true);
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
