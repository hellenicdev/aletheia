import { beforeEach, describe, expect, it } from "vitest";
import { clearSearchCache } from "../src/firecrawl";
import { clearTavilyCache } from "../src/tavily";
import { clearProbeCache } from "../src/probe";
import { handleRequest } from "../src/index";
import type { RateState } from "../src/limits";
import { analyze } from "../src/pipeline";
import { normaliseCachedText, type AnalysisCache } from "../src/analysisCache";
import { bindPipelineCache, type ResultCache } from "../src/persistentCache";
import { MemoryRateGate } from "../src/rateLimit";
import type { AnalysisResult } from "../../shared/types";
import { isProvisionalScore } from "../../shared/score";

function bindMapCache(store = new Map<string, string>()): Map<string, string> {
  const cache: ResultCache = {
    async match(request) {
      const hit = store.get(request.url);
      return hit ? new Response(hit) : undefined;
    },
    async put(request, response) {
      store.set(request.url, await response.text());
    },
  };
  bindPipelineCache(cache);
  return store;
}

beforeEach(() => {
  clearSearchCache();
  clearProbeCache();
  bindPipelineCache(null);
});

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
  ALLOW_MEMORY_LIMITER: "1",
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
    expect(seen.some((call) => call.url.includes("/chat/completions") && call.body?.seed === 7)).toBe(true);
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
    expect(result.meta.searchStatus).toEqual({ state: "ok", reason: null, provider: null });
    expect(result.provisional).toBe(false);
  });

  it("asks the model when search returns nothing and keeps only a stable fact", async () => {
    const stable = "Paris is the capital of France and has been for generations.";
    const news = "The marina fee doubled in 2024 according to the mayor.";
    let verifyUser = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev/v2/search")) {
        return new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0].content;
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({
          claimType: "checkable_factual",
          note: "A recorded claim.",
        })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({
          queries: [
            { id: "s1", query: "Paris capital of France" },
            { id: "s2", query: "marina fee 2024" },
          ],
        });
      }
      if (system.startsWith("TASK:verify")) {
        verifyUser = user;
        expect(system).toContain("core");
        expect(system).toContain("same plant");
        return llmPayload({
          results: [
            {
              id: "s1",
              label: "True",
              confidence: 0.9,
              explanation: "Paris is the capital of France.",
              sourceUrls: [],
            },
            {
              id: "s2",
              label: "True",
              confidence: 0.8,
              explanation: "Reports described a doubling in 2024.",
              sourceUrls: [],
            },
          ],
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };

    const result = await analyze(
      { text: `${stable} ${news}`, uiLanguage: "en" },
      { env, fetchImpl },
    );
    expect(verifyUser).toContain("context");
    expect(result.segments[0].label).toBe("True");
    expect(result.segments[0].evidenceMode).toBe("model-knowledge-only");
    expect(result.segments[0].confidence).toBeLessThanOrEqual(0.55);
    expect(result.segments[1].label).toBe("Unverifiable");
    expect(result.meta.searchStatus).toEqual({ state: "ok", reason: null, provider: "firecrawl" });
    expect(result.claimsVerified).toBe(0);
    expect(result.claimsTotal).toBe(2);
    expect(result.provisional).toBe(true);
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

  it("keeps an insult rhetorical when search hits the worker subrequest error", async () => {
    const fact = "The council voted 7 to 2 on Monday and published the minutes for residents.";
    const insult = "Savor that nectar now, you sniveling moth pricks.";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        throw new Error("Too many subrequests by single Worker invocation");
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({
          claimType: "checkable_factual",
          note: "Treated as a fact.",
        })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({ queries: [{ id: "s1", query: "council vote Monday" }] });
      }
      throw new Error(`verify should not run: ${system.slice(0, 24)}`);
    };
    const result = await analyze(
      { text: `${fact} ${insult}`, uiLanguage: "en" },
      { env, fetchImpl, subrequestLimit: 3 },
    );
    const factual = result.segments.find((segment) => segment.text.includes("voted"));
    const rhetorical = result.segments.find((segment) => segment.text.includes("pricks"));
    expect(rhetorical?.label).toBe("Rhetorical");
    expect(factual?.label).toBe("Unverifiable");
    expect(factual?.explanation.toLowerCase()).toContain("failed");
    expect(factual?.explanation).not.toContain("do not support a firm verdict");
    expect(result.meta.searchDegraded).toBe(true);
  });

  it("records subrequests per stage for a typical pasted article", async () => {
    const { fetchImpl } = scriptedFetch();
    const result = await analyze({ text: article, uiLanguage: "en" }, { env, fetchImpl });
    const counts = result.meta.subrequests;
    expect(counts.ingest + counts.segment + counts.evidence + counts.verify + counts.score).toBe(counts.total);
    expect(counts.total).toBeLessThanOrEqual(32);
    expect(counts).toEqual({ ingest: 0, segment: 1, evidence: 3, verify: 1, score: 1, total: 6 });
    expect(result.degraded).toBe(false);
    expect(result.claimsVerified).toBe(1);
    expect(result.claimsTotal).toBe(2);
    expect(result.score.verdict).not.toContain("Only ");
  });

  it("stops before search when the budget cannot cover it and does not drag the score", async () => {
    const facts = [
      "The council voted 7 to 2 on Monday and published the minutes for residents.",
      "The marina fee doubled overnight after the harbour master signed the notice.",
      "Twelve boats remain on the waiting list until the spring season opens.",
    ].join(" ");
    let searches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        searches += 1;
        throw new Error("Too many subrequests by single Worker invocation");
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries") || system.startsWith("TASK:verify")) {
        throw new Error(`should not call ${system.slice(0, 24)}`);
      }
      if (system.startsWith("TASK:consistency")) {
        return llmPayload({ contradictions: [] });
      }
      throw new Error(system.slice(0, 24));
    };
    const result = await analyze({ text: facts, uiLanguage: "en" }, { env, fetchImpl, subrequestLimit: 3 });
    expect(searches).toBe(0);
    expect(result.degraded).toBe(true);
    expect(result.claimsVerified).toBe(0);
    expect(result.claimsTotal).toBe(3);
    expect(result.segments.every((segment) => segment.label === "Unverifiable")).toBe(true);
    expect(result.segments[0]?.explanation.toLowerCase()).toContain("failed");
    expect(result.score.factualAccuracy).toBeNull();
    expect(result.score.sourcing).toBeNull();
    expect(result.provisional).toBe(true);
    expect(result.score.overall).toBe(57);
    expect(result.score.verdict).toContain("Only 0 of 3 claims could be verified (");
    expect(result.score.verdict).not.toContain("factual claims were checked");
    expect(result.meta.subrequests.total).toBeLessThanOrEqual(3);
  });

  it("stops the remaining searches after a subrequest error", async () => {
    let searches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        searches += 1;
        throw new Error("Too many subrequests by single Worker invocation. To configure this limit, see the docs.");
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({
          queries: [
            { id: "s1", query: "council vote Monday" },
            { id: "s2", query: "marina fee doubled" },
            { id: "s3", query: "boats waiting list" },
          ],
        });
      }
      if (system.startsWith("TASK:verify")) throw new Error("verify should not run");
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const facts = [
      "The council voted 7 to 2 on Monday and published the minutes for residents.",
      "The marina fee doubled overnight after the harbour master signed the notice.",
      "Twelve boats remain on the waiting list until the spring season opens.",
    ].join(" ");
    const result = await analyze({ text: facts, uiLanguage: "en" }, { env, fetchImpl });
    expect(searches).toBe(1);
    expect(result.degraded).toBe(true);
    expect(result.claimsVerified).toBe(0);
    expect(result.claimsTotal).toBe(3);
    expect(result.score.verdict).toContain("Only 0 of 3 claims could be verified (");
    expect(result.score.verdict).not.toContain("factual claims were checked");
  });

  it("stops calling Firecrawl after the provider runs out of credits", async () => {
    let searches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        searches += 1;
        return new Response(
          JSON.stringify({ success: false, error: "Insufficient credits to perform this request." }),
          { status: 402 },
        );
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({
          queries: [
            { id: "s1", query: "council vote Monday" },
            { id: "s2", query: "marina fee doubled" },
            { id: "s3", query: "boats waiting list" },
          ],
        });
      }
      if (system.startsWith("TASK:verify")) throw new Error("verify should not run");
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const facts = [
      "The council voted 7 to 2 on Monday and published the minutes for residents.",
      "The marina fee doubled overnight after the harbour master signed the notice.",
      "Twelve boats remain on the waiting list until the spring season opens.",
    ].join(" ");
    const result = await analyze({ text: facts, uiLanguage: "en" }, { env, fetchImpl });
    expect(searches).toBe(1);
    expect(result.meta.searchStatus).toEqual({ state: "unavailable", reason: "out_of_credits", provider: null });
    expect(result.provisional).toBe(true);
    expect(result.meta.searchDegraded).toBe(true);
    expect(result.score.factualAccuracy).toBeNull();
    expect(result.score.sourcing).toBeNull();
    expect(result.segments.every((segment) => segment.label === "Unverifiable")).toBe(true);
    expect(result.segments.every((segment) => segment.confidence <= 0.4)).toBe(true);
    expect(result.score.verdict).toContain("Only 0 of 3 claims could be verified");
    expect(result.score.verdict).not.toContain("factual claims were checked");
  });

  it("finishes a search outage without waiting on a hung body or consistency call", async () => {
    let searches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        searches += 1;
        if (searches > 1) return new Promise(() => {});
        return new Response(new ReadableStream({ start() {} }), { status: 402 });
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({
          queries: [
            { id: "s1", query: "council vote Monday" },
            { id: "s2", query: "marina fee doubled" },
            { id: "s3", query: "boats waiting list" },
          ],
        });
      }
      if (system.startsWith("TASK:verify") || system.startsWith("TASK:consistency")) {
        return new Promise(() => {});
      }
      throw new Error(system.slice(0, 24));
    };
    const facts = [
      "The council voted 7 to 2 on Monday and published the minutes for residents.",
      "The marina fee doubled overnight after the harbour master signed the notice.",
      "Twelve boats remain on the waiting list until the spring season opens.",
    ].join(" ");
    const started = Date.now();
    const result = await Promise.race([
      analyze({ text: facts, uiLanguage: "en" }, { env, fetchImpl }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("search outage waited too long")), 2500);
      }),
    ]);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(searches).toBe(1);
    expect(result.meta.searchStatus).toEqual({ state: "unavailable", reason: "out_of_credits", provider: null });
    expect(result.provisional).toBe(true);
    expect(result.score.factualAccuracy).toBeNull();
    expect(result.score.sourcing).toBeNull();
  });

  it("falls back to a direct fetch and skips search after a scrape 402", async () => {
    const systems: string[] = [];
    let searches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev/v2/scrape")) {
        return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
      }
      if (url.includes("api.firecrawl.dev/v2/search")) {
        searches += 1;
        return new Promise(() => {});
      }
      if (url.includes("news.example")) {
        return new Response(
          `<html><head><title>Harbour vote</title></head><body><article><p>${vote}</p><p>${fee}</p><p>${rhetoric}</p></article></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      systems.push(system.slice(0, 20));
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, (text) => {
          if (text.includes("betrayal")) return { claimType: "rhetorical", note: "Loaded language without a fact." };
          return { claimType: "checkable_factual", note: "A recorded claim." };
        }));
      }
      if (system.startsWith("TASK:queries") || system.startsWith("TASK:verify") || system.startsWith("TASK:consistency")) {
        return new Promise(() => {});
      }
      throw new Error(system.slice(0, 24));
    };
    const started = Date.now();
    const result = await Promise.race([
      analyze({ url: "https://news.example/harbour", uiLanguage: "en" }, { env, fetchImpl }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("scrape fallback waited too long")), 2500);
      }),
    ]);
    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.meta.extraction).toBe("direct");
    expect(result.article.text).toContain("voted 7 to 2");
    expect(searches).toBe(0);
    expect(systems.some((system) => system.startsWith("TASK:queries"))).toBe(false);
    expect(result.meta.searchStatus).toEqual({ state: "unavailable", reason: "out_of_credits", provider: null });
    expect(result.provisional).toBe(true);
    expect(result.score.verdict).toContain("Only 0 of");
    expect(result.meta.subrequests.ingest).toBeGreaterThanOrEqual(2);
  });

  it("shrinks a partial run when one cached claim is checked and the rest are not", async () => {
    let searches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        searches += 1;
        if (searches === 1) {
          return new Response(
            JSON.stringify({
              success: true,
              data: { web: [{ url: minutes.url, title: minutes.title, description: minutes.description }] },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({
          queries: [
            { id: "s1", query: "council vote Monday" },
            { id: "s2", query: "marina fee doubled" },
            { id: "s3", query: "boats waiting list" },
          ],
        });
      }
      if (system.startsWith("TASK:verify")) {
        return llmPayload({
          results: [
            {
              id: "s1",
              label: "True",
              confidence: 0.95,
              explanation: "The minutes record a seven to two vote.",
              sourceUrls: [minutes.url],
            },
          ],
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const facts = [
      "The council voted 7 to 2 on Monday and published the minutes for residents.",
      "The marina fee doubled overnight after the harbour master signed the notice.",
      "Twelve boats remain on the waiting list until the spring season opens.",
    ].join(" ");
    const result = await analyze({ text: facts, uiLanguage: "en" }, { env, fetchImpl });
    expect(searches).toBe(2);
    expect(result.claimsVerified).toBe(1);
    expect(result.claimsCovered).toBe(1);
    expect(result.claimsTotal).toBe(3);
    expect(result.meta.searchStatus).toEqual({
      state: "partial",
      reason: "out_of_credits",
      provider: "firecrawl",
    });
    expect(result.segments.some((segment) => segment.sources.length > 0)).toBe(true);
    expect(result.provisional).toBe(
      isProvisionalScore({
        searchEnabled: true,
        searchState: result.meta.searchStatus.state,
        claimsCovered: result.claimsCovered,
        claimsTotal: result.claimsTotal,
      }),
    );
    expect(result.provisional).toBe(true);
    expect(result.score.factualAccuracy).toBeNull();
    expect(result.score.sourcing).toBeNull();
    expect(result.score.overall).toBe(87);
    expect(result.score.verdict).toContain("87/100");
  });

  it("does not cite an AP reprint that lacks a byline", async () => {
    const title = "Coast Guard rescues sailors after a storm warning delayed the Baja crossing";
    const lede =
      "The Coast Guard rescued sixteen sailors off Baja California on Monday after a storm warning delayed their crossing and the crew stayed out overnight.";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              web: [
                {
                  url: "https://www.opb.org/article/coast-guard-baja",
                  title: "Coast Guard rescues sailors after Baja storm warning",
                  description:
                    "The Coast Guard rescued sixteen sailors off Baja California on Monday after a storm warning delayed their crossing.",
                },
                {
                  url: "https://www.arabnews.com/node/coast-guard-baja",
                  title: "Sailors rescued off Baja",
                  description: lede,
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({ queries: [{ id: "s1", query: "coast guard baja sailors" }] });
      }
      if (system.startsWith("TASK:verify")) {
        return llmPayload({
          results: [
            {
              id: "s1",
              label: "True",
              confidence: 0.9,
              explanation: "Other sites reported the same rescue.",
              sourceUrls: [
                "https://www.opb.org/article/coast-guard-baja",
                "https://www.arabnews.com/node/coast-guard-baja",
              ],
            },
          ],
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const result = await analyze({ text: `${title}\n\n${lede}`, uiLanguage: "en" }, { env, fetchImpl });
    expect(result.segments[0]?.label).toBe("Unverifiable");
    expect(result.segments[0]?.sources).toEqual([]);
    expect(result.segments[0]?.explanation.toLowerCase()).toContain("not independently verified");
  });

  it("returns a partial result when search hangs past the deadline", async () => {
    const fact = "The council voted 7 to 2 on Monday and published the minutes for residents.";
    let ticks = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        const signal = init?.signal;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 30_000);
          timer.unref?.();
          const onAbort = () => {
            clearTimeout(timer);
            reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
          };
          if (signal?.aborted) onAbort();
          else signal?.addEventListener("abort", onAbort, { once: true });
        });
        return new Response("late", { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({
          claimType: "checkable_factual",
          note: "A recorded claim.",
        })));
      }
      if (system.startsWith("TASK:queries")) return llmPayload({ queries: [] });
      if (system.startsWith("TASK:verify")) throw new Error("verify should wait for search");
      throw new Error(system.slice(0, 24));
    };
    const started = Date.now();
    const result = await analyze(
      { text: fact, uiLanguage: "en" },
      { env, fetchImpl, budgetMs: 4_000, onTick: () => { ticks += 1; } },
    );
    expect(Date.now() - started).toBeLessThan(6_000);
    expect(ticks).toBeGreaterThan(0);
    expect(result.segments[0]?.label).toBe("Unverifiable");
    expect(result.segments[0]?.explanation.toLowerCase()).toMatch(/failed|did not finish/);
    expect(result.meta.warnings.some((warning) => /deadline|timed out|subrequest/i.test(warning))).toBe(true);
    expect(result.score.verdict).toContain("/100");
  });

  it("treats an opinion-section URL as a column even when the model says news", async () => {
    const fact = "The council voted 7 to 2 on Monday and published the minutes for residents.";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev/v2/search")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              web: [
                {
                  url: "https://www.reuters.com/world/harbour-vote",
                  title: "Reuters",
                  description: "Councillors approved the harbour measure by seven votes to two.",
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("api.firecrawl.dev/v2/scrape")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              markdown: fact,
              metadata: {
                title: "Δημόσιο Βήμα",
                sourceURL: "https://www.ertnews.gr/apopseis/dimosio-vima/column",
              },
            },
          }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload({
          ...classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })),
          genre: "news",
        });
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({ queries: [{ id: "s1", query: "council vote Monday" }] });
      }
      if (system.startsWith("TASK:verify")) {
        const payload = JSON.parse(user) as { claims: { id: string }[] };
        return llmPayload({
          results: payload.claims.map((claim) => ({
            id: claim.id,
            label: "True",
            confidence: 0.9,
            explanation: "Reuters recorded the same seven to two vote.",
            sourceUrls: ["https://www.reuters.com/world/harbour-vote"],
          })),
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const result = await analyze(
      { url: "https://www.ertnews.gr/apopseis/dimosio-vima/column", uiLanguage: "en" },
      { env, fetchImpl },
    );
    expect(result.meta.outlet).toBe("opinion");
    expect(result.score.verdict.toLowerCase()).toContain("mostly opinion");
    expect(result.score.overall).toBeLessThanOrEqual(65);
  });

  it("returns a scored result when the post-verify consistency call hangs", async () => {
    const fact = "The council voted 7 to 2 on Monday and published the minutes for residents.";
    const other = "Twelve boats remain on the waiting list after the harbour master signs the notice.";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev/v2/search")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              web: [
                {
                  url: "https://www.reuters.com/world/harbour",
                  title: "Harbour notice",
                  description: "Councillors approved the harbour measure and left twelve boats waiting.",
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({
          queries: [
            { id: "s1", query: "council vote Monday" },
            { id: "s2", query: "boats waiting list" },
          ],
        });
      }
      if (system.startsWith("TASK:verify")) {
        const payload = JSON.parse(user) as { claims: { id: string }[] };
        return llmPayload({
          results: payload.claims.map((claim) => ({
            id: claim.id,
            label: "True",
            confidence: 0.9,
            explanation: "Reuters recorded the same harbour facts.",
            sourceUrls: ["https://www.reuters.com/world/harbour"],
          })),
        });
      }
      if (system.startsWith("TASK:consistency")) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 30_000);
          timer.unref?.();
        });
        return llmPayload({ contradictions: [] });
      }
      throw new Error(system.slice(0, 24));
    };
    const started = Date.now();
    const result = await analyze(
      { text: `${fact} ${other}`, uiLanguage: "en" },
      { env, fetchImpl, consistencyTimeoutMs: 300 },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.contradictions).toEqual([]);
    expect(result.score.verdict).toContain("/100");
    expect(result.score.verdict.toLowerCase()).toContain("outlet is unknown");
    expect(result.meta.outlet).toBe("unknown");
    expect(result.meta.warnings.some((warning) => /consistency timed out/i.test(warning))).toBe(true);
  });

  it("treats an ERT news URL as opinion when the article category is Απόψεις", async () => {
    const fact = "The council voted 7 to 2 on Monday and published the minutes for residents.";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev/v2/search")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              web: [
                {
                  url: "https://www.reuters.com/world/harbour-vote",
                  title: "Reuters",
                  description: "Councillors approved the harbour measure by seven votes to two.",
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes("api.firecrawl.dev/v2/scrape")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              markdown: fact,
              html: '<article class="post category-apopseis category-eidiseis"><script type="application/ld+json">{"articleSection":["ΑΠΟΨΕΙΣ","ΕΙΔΗΣΕΙΣ"]}</script><p>' +
                fact +
                "</p></article>",
              metadata: {
                title: "Η Ευρώπη έχει καύσιμα",
                sourceURL:
                  "https://www.ertnews.gr/eidiseis/diethni/i-eyropi-exei-kaysima-alla-oxi-anosia-sto-sok-ton-timon/",
              },
            },
          }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload({
          ...classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })),
          genre: "news",
        });
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({ queries: [{ id: "s1", query: "council vote Monday" }] });
      }
      if (system.startsWith("TASK:verify")) {
        const payload = JSON.parse(user) as { claims: { id: string }[] };
        return llmPayload({
          results: payload.claims.map((claim) => ({
            id: claim.id,
            label: "True",
            confidence: 0.9,
            explanation: "Reuters recorded the same seven to two vote.",
            sourceUrls: ["https://www.reuters.com/world/harbour-vote"],
          })),
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const result = await analyze(
      {
        url: "https://www.ertnews.gr/eidiseis/diethni/i-eyropi-exei-kaysima-alla-oxi-anosia-sto-sok-ton-timon/",
        uiLanguage: "en",
      },
      { env, fetchImpl },
    );
    expect(result.meta.outlet).toBe("opinion");
    expect(result.score.verdict.toLowerCase()).toContain("mostly opinion");
    expect(result.score.overall).toBeLessThanOrEqual(65);
  });

  it("drops a caption that repeats the previous sentence", async () => {
    const line = "A researcher examines the reconstructed skull in the cave.";
    const { fetchImpl } = scriptedFetch();
    const result = await analyze(
      { text: `${line} Caption: ${line}`, uiLanguage: "en" },
      { env, fetchImpl },
    );
    expect(result.segments.filter((segment) => segment.text.includes("reconstructed"))).toHaveLength(1);
  });

  it("rejects private URLs before any fetch", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not fetch");
    };
    await expect(
      analyze({ url: "http://169.254.169.254/latest/meta-data", uiLanguage: "en" }, { env, fetchImpl }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("uses Tavily when Firecrawl search is out of credits and keeps the score final", async () => {
    let firecrawlSearches = 0;
    let tavilySearches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        firecrawlSearches += 1;
        return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
      }
      if (url.includes("api.tavily.com/search")) {
        tavilySearches += 1;
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.search_depth).toBe("basic");
        expect(body.topic).toBe("news");
        expect(body.max_results).toBe(5);
        expect(body.include_raw_content).toBe(true);
        expect(JSON.stringify(body)).not.toContain("tavily-test-key");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer tavily-test-key");
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Council minutes",
                url: minutes.url,
                content: "The council voted 7 to 2 on Monday.",
                raw_content:
                  "The council voted 7 to 2 on Monday and the minutes name the harbour master for residents who asked.",
                published_date: "2026-03-01",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, (text) => {
          if (text.includes("betrayal")) return { claimType: "rhetorical", note: "Loaded language without a fact." };
          return { claimType: "checkable_factual", note: "A recorded claim." };
        }));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({
          queries: [
            { id: "s1", query: "council vote Monday" },
            { id: "s2", query: "marina fee doubled" },
          ],
        });
      }
      if (system.startsWith("TASK:verify")) {
        return llmPayload({
          results: [
            {
              id: "s1",
              label: "True",
              confidence: 0.9,
              explanation: "The minutes record a seven to two vote.",
              sourceUrls: [minutes.url],
            },
            {
              id: "s2",
              label: "Unverifiable",
              confidence: 0.4,
              explanation: "The fee change is not in the retrieved pages.",
              sourceUrls: [],
            },
          ],
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const result = await analyze(
      { text: article, uiLanguage: "en" },
      { env: { ...env, TAVILY_API_KEY: "tavily-test-key" }, fetchImpl },
    );
    expect(firecrawlSearches).toBe(1);
    expect(tavilySearches).toBe(2);
    expect(result.meta.searchStatus).toEqual({ state: "ok", reason: null, provider: "tavily" });
    expect(result.meta.searchDegraded).toBe(false);
    expect(result.claimsTotal).toBe(2);
    expect(result.claimsVerified).toBe(1);
    expect(result.provisional).toBe(false);
    expect(result.segments[0]?.sources.map((source) => source.url)).toEqual([minutes.url]);
    expect(result.segments[0]?.sources[0]?.snippet).toContain("voted 7 to 2");
    expect(result.score.factualAccuracy).not.toBeNull();
    expect(result.score.sourcing).not.toBeNull();
  });

  it("stops calling Tavily after a credit error", async () => {
    let tavilySearches = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
      }
      if (url.includes("api.tavily.com")) {
        tavilySearches += 1;
        return new Response(JSON.stringify({ error: "usage limit exceeded" }), { status: 432 });
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({
          queries: [
            { id: "s1", query: "council vote Monday" },
            { id: "s2", query: "marina fee doubled" },
            { id: "s3", query: "boats waiting list" },
          ],
        });
      }
      if (system.startsWith("TASK:verify") || system.startsWith("TASK:consistency")) {
        throw new Error("should not run");
      }
      throw new Error(system.slice(0, 24));
    };
    const facts = [
      "The council voted 7 to 2 on Monday and published the minutes for residents.",
      "The marina fee doubled overnight after the harbour master signed the notice.",
      "Twelve boats remain on the waiting list until the spring season opens.",
    ].join(" ");
    const result = await analyze(
      { text: facts, uiLanguage: "en" },
      { env: { ...env, TAVILY_API_KEY: "tavily-test-key" }, fetchImpl },
    );
    expect(tavilySearches).toBe(1);
    expect(result.meta.searchStatus).toEqual({ state: "unavailable", reason: "out_of_credits", provider: null });
    expect(result.provisional).toBe(true);
    expect(result.score.factualAccuracy).toBeNull();
  });

  it("reads the article with Tavily after scrape and direct fetch both fail", async () => {
    let directCalls = 0;
    let extracts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev/v2/scrape")) {
        return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
      }
      if (url.includes("api.firecrawl.dev/v2/search")) {
        return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
      }
      if (url.includes("api.tavily.com/extract")) {
        extracts += 1;
        const body = JSON.parse(String(init?.body)) as { extract_depth?: string; urls?: string[] };
        expect(body.extract_depth).toBe("basic");
        expect(body.urls?.[0]).toBe("https://news.example/harbour");
        return new Response(
          JSON.stringify({
            results: [
              {
                url: "https://news.example/harbour",
                raw_content: `Harbour vote\n\n${vote} ${fee} ${rhetoric} The notice was posted on the harbour gate for residents.`,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("api.tavily.com/search")) {
        return new Response(JSON.stringify({ results: [] }), { status: 200 });
      }
      if (url.includes("news.example")) {
        directCalls += 1;
        return new Response("nope", { status: 503 });
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, (text) => {
          if (text.includes("betrayal")) return { claimType: "rhetorical", note: "Loaded language without a fact." };
          return { claimType: "checkable_factual", note: "A recorded claim." };
        }));
      }
      if (system.startsWith("TASK:queries")) return llmPayload({ queries: [] });
      if (system.startsWith("TASK:verify")) {
        const parsed = JSON.parse(user) as { claims: { id: string }[] };
        return llmPayload({
          results: parsed.claims.map((claim) => ({
            id: claim.id,
            label: "Unverifiable",
            confidence: 0.3,
            explanation: "The retrieved pages do not decide this claim.",
            sourceUrls: [],
          })),
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const result = await analyze(
      { url: "https://news.example/harbour", uiLanguage: "en" },
      { env: { ...env, TAVILY_API_KEY: "tavily-test-key" }, fetchImpl },
    );
    expect(directCalls).toBe(1);
    expect(extracts).toBe(1);
    expect(result.meta.extraction).toBe("tavily");
    expect(result.article.text).toContain("voted 7 to 2");
    expect(result.article.title).toContain("Harbour vote");
  });

  it("does not search a calendar aside and does not cite an off-topic page", async () => {
    const searches: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        const body = JSON.parse(String(init?.body)) as { query?: string };
        searches.push(body.query ?? "");
        const aboutVote = (body.query ?? "").includes("council");
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              web: aboutVote
                ? [
                    { url: minutes.url, title: minutes.title, description: minutes.description },
                    {
                      url: "https://grayson.edu/cosmetology",
                      title: "Cosmetology catalogue",
                      description: "Grayson College lists courses in colour and salon management.",
                    },
                  ]
                : [
                    {
                      url: "https://shopping.example/advent",
                      title: "Best advent calendars",
                      description: "Shop the 2026 advent calendar before the holidays.",
                    },
                  ],
            },
          }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(
          classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })),
        );
      }
      if (system.startsWith("TASK:queries")) {
        const payload = JSON.parse(user) as { claims: { id: string; text: string }[] };
        return llmPayload({
          queries: payload.claims.map((claim) => ({ id: claim.id, query: claim.text })),
        });
      }
      if (system.startsWith("TASK:verify")) {
        const payload = JSON.parse(user) as { claims: { id: string; evidence: { url: string }[] }[] };
        return llmPayload({
          results: payload.claims.map((claim) => ({
            id: claim.id,
            label: "True",
            confidence: 0.9,
            explanation: "The minutes record the vote.",
            sourceUrls: claim.evidence.map((item) => item.url),
            sources: claim.evidence.map((item) => ({ url: item.url, relevant: true })),
          })),
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const result = await analyze(
      {
        text: "The council voted 7 to 2 on Monday and published the minutes. But check the calendar and it is 2026.",
        uiLanguage: "en",
      },
      { env, fetchImpl },
    );
    expect(searches).toEqual([expect.stringContaining("council")]);
    const calendar = result.segments.find((segment) => segment.text.includes("calendar"));
    expect(calendar?.label).toBe("Rhetorical");
    expect(calendar?.sources).toEqual([]);
    const voteSegment = result.segments.find((segment) => segment.text.includes("voted"));
    expect(voteSegment?.sources.map((source) => source.url)).toEqual([minutes.url]);
  });

  it("searches all 12 selected claims with Tavily inside the subrequest cap", async () => {
    const claims = [
      "The harbour council voted to dredge the north basin before winter.",
      "Marina fees doubled after the harbour master signed the notice.",
      "Twelve fishing boats remain on the waiting list until spring.",
      "The lighthouse keeper reported a broken lamp on Tuesday night.",
      "Coastal inspectors closed the west pier after finding rotten pilings.",
      "Ferry passengers waited three hours when the morning sailing was cancelled.",
      "The town clerk published the full minutes on the council website.",
      "Divers recovered an anchor from the channel beside the old quay.",
      "Storm winds tore the roof from the boathouse during the night.",
      "Harbour police fined a skipper for speeding inside the breakwater.",
      "Engineers surveyed the silt under the commercial dock last month.",
      "Residents petitioned for a new lifeboat station near the marina.",
    ];
    let firecrawlSearches = 0;
    let tavilySearches = 0;
    bindMapCache();
    try {
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        if (url.includes("api.firecrawl.dev")) {
          firecrawlSearches += 1;
          return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
        }
        if (url.includes("api.tavily.com/search")) {
          tavilySearches += 1;
          const body = JSON.parse(String(init?.body)) as { query?: string; include_raw_content?: boolean };
          expect(body.include_raw_content).toBe(true);
          const words = (body.query ?? "")
            .split(" ")
            .filter((word) => word.length > 4)
            .slice(0, 4)
            .join(" ");
          return new Response(
            JSON.stringify({
              results: [
                {
                  title: "Harbour minutes",
                  url: `https://example.com/minutes/${tavilySearches}`,
                  content: `A separate report confirmed ${words} after reviewing the local records.`,
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
        const system = body.messages[0]?.content ?? "";
        const user = body.messages[1]?.content ?? "";
        if (system.startsWith("TASK:segment")) {
          return llmPayload(
            classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })),
          );
        }
        if (system.startsWith("TASK:queries")) {
          const payload = JSON.parse(user) as { claims: { id: string; text: string }[] };
          expect(payload.claims).toHaveLength(12);
          return llmPayload({
            queries: payload.claims.map((claim) => ({ id: claim.id, query: claim.text })),
          });
        }
        if (system.startsWith("TASK:verify")) {
          const payload = JSON.parse(user) as { claims: { id: string; evidence: { url: string }[] }[] };
          return llmPayload({
            results: payload.claims.map((claim) => ({
              id: claim.id,
              label: "True",
              confidence: 0.9,
              explanation: "The minutes record the harbour council marina vote.",
              sourceUrls: claim.evidence.map((item) => item.url),
              sources: claim.evidence.map((item) => ({ url: item.url, relevant: true })),
            })),
          });
        }
        if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
        throw new Error(system.slice(0, 24));
      };
      const result = await analyze(
        { text: claims.join(" "), uiLanguage: "en" },
        { env: { ...env, TAVILY_API_KEY: "tavily-test-key" }, fetchImpl },
      );
      expect(firecrawlSearches).toBe(1);
      expect(tavilySearches).toBe(12);
      expect(result.claimsTotal).toBe(12);
      expect(result.claimsVerified).toBe(12);
      expect(result.degraded).toBe(false);
      expect(result.provisional).toBe(false);
      expect(result.meta.subrequests.total).toBeLessThanOrEqual(32);
      expect(result.meta.warnings.join(" ")).not.toContain("subrequest limit");
    } finally {
      bindPipelineCache(null);
    }
  });

  it("searches a headline again without the outlet name", async () => {
    const queries: string[] = [];
    const headline =
      "Associated Press sixteen people rescued 140 miles west of Ensenada after the boat capsized in the Pacific.";
    const text = `Associated Press sixteen people rescued\n\n${headline} The crew stayed out until dawn and returned with the passengers.`;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        const body = JSON.parse(String(init?.body)) as { query?: string };
        queries.push(body.query ?? "");
        return new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({ queries: [] });
      }
      if (system.startsWith("TASK:verify") || system.startsWith("TASK:consistency")) {
        return llmPayload({ contradictions: [], results: [] });
      }
      throw new Error(system.slice(0, 24));
    };
    await analyze({ text, uiLanguage: "en" }, { env, fetchImpl });
    expect(queries.some((query) => /associated press/i.test(query))).toBe(true);
    expect(queries.some((query) => !/associated press/i.test(query) && /ensenada/i.test(query))).toBe(true);
  });

  it("keeps True when the retrieved page uses the surname and a death synonym", async () => {
    clearSearchCache();
    const claim = "Emmanuel Macron said the driver was killed in the crash.";
    const page = "https://www.reuters.com/world/europe/macron-crash";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev/v2/search")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              web: [
                {
                  url: page,
                  title: "Macron on the crash",
                  description: "Macron said the driver died in the crash outside Paris.",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({ queries: [{ id: "s1", query: "Macron driver killed crash" }] });
      }
      if (system.startsWith("TASK:verify")) {
        const payload = JSON.parse(user) as { claims: { evidence: { url: string }[] }[] };
        expect(payload.claims[0]?.evidence.map((item) => item.url)).toContain(page);
        return llmPayload({
          results: [
            {
              id: "s1",
              label: "True",
              confidence: 0.9,
              explanation: "Reuters reports that Macron said the driver died in the crash.",
              sourceUrls: [page],
              sources: [{ url: page, relevant: true }],
            },
          ],
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const result = await analyze({ text: claim, uiLanguage: "en" }, { env, fetchImpl });
    expect(result.segments[0]?.label).toBe("True");
    expect(result.segments[0]?.sources.map((source) => source.url)).toEqual([page]);
  });

  it("verifies a claim from the highlighted passage instead of the site tagline", async () => {
    clearSearchCache();
    const claim = "The council voted 7 to 2 on Monday and published the minutes for residents.";
    const page = "https://www.reuters.com/world/council-vote";
    const filler = "Site navigation and newsletter signup. ".repeat(30);
    let highlights: unknown;
    let seenSnippet = "";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev/v2/search")) {
        const body = JSON.parse(String(init?.body)) as { highlights?: boolean; scrapeOptions?: unknown };
        highlights = body.highlights;
        expect(body.scrapeOptions).toBeUndefined();
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              web: [
                {
                  url: page,
                  title: "Council vote",
                  description: `${filler}The council voted 7 to 2 on Monday and published the minutes.`,
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({ queries: [{ id: "s1", query: "council voted 7 to 2" }] });
      }
      if (system.startsWith("TASK:verify")) {
        const payload = JSON.parse(user) as { claims: { evidence: { snippet: string }[] }[] };
        seenSnippet = payload.claims[0]?.evidence[0]?.snippet ?? "";
        return llmPayload({
          results: [
            {
              id: "s1",
              label: "True",
              confidence: 0.9,
              explanation: "Reuters reports that the council voted 7 to 2.",
              sourceUrls: [page],
              sources: [{ url: page, relevant: true }],
            },
          ],
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const result = await analyze({ text: claim, uiLanguage: "en" }, { env, fetchImpl });
    expect(highlights).toBe(true);
    expect(seenSnippet).toContain("voted 7 to 2");
    expect(seenSnippet.length).toBeLessThan(filler.length);
    expect(result.segments[0]?.label).toBe("True");
    expect(result.segments[0]?.explanation).toContain("7 to 2");
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
      probe: {
        llm: { ok: boolean; status: number; error: string };
        firecrawl: { ok: boolean; status: number; error: string };
        tavily: { ok: boolean; error?: string };
      };
    };
    expect(body.ok).toBe(false);
    expect(body.probe.llm).toMatchObject({ ok: false, status: 400 });
    expect(body.probe.llm.error).toContain("llm: HTTP 400");
    expect(body.probe.firecrawl).toMatchObject({ ok: false, status: 401 });
    expect(body.probe.firecrawl.error).toContain("HTTP 401");
    expect(body.probe.tavily.ok).toBe(false);
    expect(body.probe.tavily.error).toContain("TAVILY_API_KEY is not configured");
    expect(JSON.stringify(body)).not.toContain("test-key");
    expect(JSON.stringify(body)).not.toContain("firecrawl-test-key");
  });

  it("reports a live search 402 as out_of_credits and reuses that probe", async () => {
    let searches = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        searches += 1;
        return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
      }
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const rate = () => ({ buckets: new Map(), inFlight: { count: 0 } });
    const probeAt = async (now: number) => {
      const response = await handleRequest(new Request("https://worker.test/api/health?probe=1"), env, {
        fetchImpl,
        rate: rate(),
        now: () => now,
      });
      expect(response.status).toBe(200);
      return (await response.json()) as {
        ok: boolean;
        probe: {
          firecrawl: { ok: boolean; status: number; reason?: string; error?: string };
          tavily: { ok: boolean; error?: string };
        };
      };
    };

    const first = await probeAt(20_000);
    expect(first.ok).toBe(false);
    expect(first.probe.firecrawl).toMatchObject({ ok: false, status: 402, reason: "out_of_credits" });
    expect(first.probe.firecrawl.error).toMatch(/402|insufficient credits/i);
    expect(first.probe.tavily.ok).toBe(false);
    expect(searches).toBe(1);

    const cached = await probeAt(50_000);
    expect(cached.probe.firecrawl.reason).toBe("out_of_credits");
    expect(searches).toBe(1);

    const again = await probeAt(20_000 + 61_000);
    expect(again.probe.firecrawl.reason).toBe("out_of_credits");
    expect(searches).toBe(2);
  });

  it("reports Firecrawl and Tavily probe status separately and reuses them", async () => {
    let firecrawlCalls = 0;
    let tavilyCalls = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        firecrawlCalls += 1;
        return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
      }
      if (url.includes("api.tavily.com")) {
        tavilyCalls += 1;
        return new Response(
          JSON.stringify({
            results: [{ title: "Tower", url: "https://example.com/tower", content: "The tower stands in Paris." }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const probeAt = async (now: number) => {
      const response = await handleRequest(
        new Request("https://worker.test/api/health?probe=1"),
        { ...env, TAVILY_API_KEY: "tavily-test-key" },
        {
          fetchImpl,
          rate: { buckets: new Map(), inFlight: { count: 0 } },
          now: () => now,
        },
      );
      expect(response.status).toBe(200);
      return (await response.json()) as {
        ok: boolean;
        tavilyConfigured: boolean;
        searchProvider: string;
        probe: {
          firecrawl: { ok: boolean; status: number; reason?: string };
          tavily: { ok: boolean; status: number };
        };
      };
    };
    const first = await probeAt(40_000);
    expect(first.tavilyConfigured).toBe(true);
    expect(first.searchProvider).toBe("firecrawl-then-tavily");
    expect(first.ok).toBe(true);
    expect(first.probe.firecrawl).toMatchObject({ ok: false, status: 402, reason: "out_of_credits" });
    expect(first.probe.tavily).toMatchObject({ ok: true, status: 200 });
    expect(firecrawlCalls).toBe(1);
    expect(tavilyCalls).toBe(1);
    const second = await probeAt(70_000);
    expect(second.probe.tavily.ok).toBe(true);
    expect(second.probe.firecrawl.ok).toBe(false);
    expect(firecrawlCalls).toBe(1);
    expect(tavilyCalls).toBe(1);
  });

  it("records a direct fetch on the error event when scrape and the page both fail", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("api.firecrawl.dev")) {
        return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
      }
      return new Response("Just a moment", { status: 403, headers: { "content-type": "text/html" } });
    };
    const response = await handleRequest(
      new Request("https://worker.test/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({ url: "https://apnews.com/article/coast-guard", uiLanguage: "en" }),
      }),
      env,
      { fetchImpl, rate: { buckets: new Map(), inFlight: { count: 0 } }, now: () => 30_000 },
    );
    expect(response.status).toBe(200);
    const events = parseSse(await response.text());
    const error = events.find((event) => event.event === "error")?.data as {
      message?: string;
      extraction?: string;
      reason?: string;
    };
    expect(error.message).toBe("This page could not be read. Paste the article text instead.");
    expect(error.message).not.toMatch(/Firecrawl scrape failed/);
    expect(error.extraction).toBe("direct");
    expect(error.reason).toBe("scrape HTTP 402; direct fetch failed: HTTP 403");
    expect(calls.some((url) => url.includes("apnews.com"))).toBe(true);
    expect(events.some((event) => event.event === "result")).toBe(false);
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

  it("keeps pinging during a slow fetch and finishes the stream with waitUntil", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { fetchImpl: scripted } = scriptedFetch();
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).includes("/chat/completions")) await gate;
      return scripted(input, init);
    };
    let settled = false;
    const waited: Promise<unknown>[] = [];
    const response = await handleRequest(post(article), env, {
      fetchImpl,
      rate: { buckets: new Map(), inFlight: { count: 0 } },
      now: () => 2_000,
      pingMs: 25,
      waitUntil: (promise) => {
        waited.push(promise.then(() => {
          settled = true;
        }));
      },
    });
    expect(waited).toHaveLength(1);
    const bodyPromise = response.text();
    await new Promise((resolve) => setTimeout(resolve, 60));
    release();
    const body = await bodyPromise;
    expect(body.split(": ping").length - 1).toBeGreaterThanOrEqual(2);
    expect(body).toContain("event: result");
    await Promise.all(waited);
    expect(settled).toBe(true);
  });

  it("rate limits repeated analyses", async () => {
    const { MemoryRateGate } = await import("../src/rateLimit");
    const gate = new MemoryRateGate();
    const rate: RateState = { buckets: new Map(), inFlight: { count: 0 } };
    for (let i = 0; i < 3; i += 1) {
      const response = await handleRequest(post(article), env, {
        rate,
        gate,
        now: () => 5_000 + i,
        fetchImpl: scriptedFetch().fetchImpl,
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    const blocked = await handleRequest(post(article), env, {
      rate,
      gate,
      now: () => 5_100,
      fetchImpl: scriptedFetch().fetchImpl,
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    const body = (await blocked.json()) as { code?: string; retryAfter?: number };
    expect(body.code).toBe("ip_burst");
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(rate.inFlight.count).toBe(0);
  });

  it("closes the stream when a search fetch never resolves", async () => {
    clearSearchCache();
    let hungCalls = 0;
    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        hungCalls += 1;
        return new Promise((resolve) => {
          const timer = setTimeout(() => resolve(new Response("late")), 60_000);
          timer.unref?.();
          void init?.signal;
        });
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return Promise.resolve(
          llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." }))),
        );
      }
      if (system.startsWith("TASK:queries")) {
        return Promise.resolve(llmPayload({ queries: [{ id: "s1", query: "council vote Monday" }] }));
      }
      if (system.startsWith("TASK:verify") || system.startsWith("TASK:consistency")) {
        return Promise.resolve(llmPayload({ contradictions: [], results: [] }));
      }
      return Promise.reject(new Error(system.slice(0, 24)));
    };
    const started = Date.now();
    const response = await handleRequest(post(article), env, {
      fetchImpl,
      rate: { buckets: new Map(), inFlight: { count: 0 } },
      now: () => 50_000,
      deadlineMs: 5_000,
    });
    const events = parseSse(await response.text());
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(hungCalls).toBeGreaterThan(0);
    expect(events.some((event) => event.event === "result" || event.event === "error")).toBe(true);
    const terminal = events.filter((event) => event.event === "result" || event.event === "error");
    expect(terminal).toHaveLength(1);
  }, 12_000);

  it("emits a final event when a model call never resolves", async () => {
    const fetchImpl: typeof fetch = () => new Promise(() => {});
    const started = Date.now();
    const response = await handleRequest(post(article), env, {
      fetchImpl,
      rate: { buckets: new Map(), inFlight: { count: 0 } },
      now: () => 80_000,
      deadlineMs: 1_200,
    });
    const events = parseSse(await response.text());
    expect(Date.now() - started).toBeLessThan(5_000);
    const terminal = events.filter((event) => event.event === "result" || event.event === "error");
    expect(terminal).toHaveLength(1);
  }, 8_000);

  it("emits a final event when the model stalls immediately after a scrape", async () => {
    let scraped = false;
    const fetchImpl: typeof fetch = (input) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        scraped = true;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              success: true,
              data: {
                markdown: `${article} The harbour master signed the notice and published the minutes for residents.`,
                metadata: { title: "Harbour", sourceURL: "https://news.example/story" },
              },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return new Promise(() => {});
    };
    const started = Date.now();
    const response = await handleRequest(
      new Request("https://worker.test/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({ url: "https://news.example/story", uiLanguage: "en" }),
      }),
      env,
      {
        fetchImpl,
        rate: { buckets: new Map(), inFlight: { count: 0 } },
        now: () => 90_000,
        deadlineMs: 1_200,
      },
    );
    const events = parseSse(await response.text());
    expect(scraped).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    const terminal = events.filter((event) => event.event === "result" || event.event === "error");
    expect(terminal).toHaveLength(1);
  }, 8_000);

  it("finishes when the segment call never resolves", async () => {
    let segmentCalls = 0;
    const fetchImpl: typeof fetch = (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        return Promise.resolve(new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200 }));
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        segmentCalls += 1;
        return new Promise(() => {});
      }
      if (system.startsWith("TASK:queries")) {
        return Promise.resolve(llmPayload({ queries: [{ id: "s1", query: "council vote Monday" }] }));
      }
      if (system.startsWith("TASK:verify") || system.startsWith("TASK:consistency")) {
        return Promise.resolve(llmPayload({ contradictions: [], results: [] }));
      }
      return Promise.reject(new Error(`${system.slice(0, 24)} ${user.slice(0, 12)}`));
    };
    const started = Date.now();
    const response = await handleRequest(post(article), env, {
      fetchImpl,
      rate: { buckets: new Map(), inFlight: { count: 0 } },
      now: () => 120_000,
      deadlineMs: 8_000,
      segmentTimeoutMs: 400,
    });
    const events = parseSse(await response.text());
    expect(segmentCalls).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(4_000);
    const terminal = events.filter((event) => event.event === "result" || event.event === "error");
    expect(terminal).toHaveLength(1);
  }, 8_000);

  it("reuses a cached verification for the same claim and evidence", async () => {
    clearSearchCache();
    const store = bindMapCache();
    let verifyCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              web: [
                {
                  url: "https://www.reuters.com/world/harbour-vote",
                  title: "Harbour vote",
                  description: "Councillors approved the harbour measure by seven votes to two.",
                },
              ],
            },
          }),
          { status: 200 },
        );
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        return llmPayload({ queries: [{ id: "s1", query: "council vote Monday" }] });
      }
      if (system.startsWith("TASK:verify")) {
        verifyCalls += 1;
        const payload = JSON.parse(user) as { claims: { id: string }[] };
        return llmPayload({
          results: payload.claims.map((claim) => ({
            id: claim.id,
            label: "True",
            confidence: 0.9,
            explanation: "Reuters recorded the same seven to two vote.",
            sourceUrls: ["https://www.reuters.com/world/harbour-vote"],
          })),
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const text = "The council voted 7 to 2 on Monday and published the minutes for residents.";
    try {
      await analyze({ text, uiLanguage: "en" }, { env, fetchImpl, requestId: "cache-1" });
      const afterFirst = verifyCalls;
      clearSearchCache();
      await analyze({ text, uiLanguage: "en" }, { env, fetchImpl, requestId: "cache-2" });
      expect(afterFirst).toBeGreaterThan(0);
      expect(verifyCalls).toBe(afterFirst);
      expect(store.size).toBeGreaterThan(0);
    } finally {
      bindPipelineCache(null);
      clearSearchCache();
    }
  });

  it("rejects pasted text over the character budget before starting an analysis", async () => {
    const { fetchImpl } = scriptedFetch();
    const response = await handleRequest(post(`${"The council voted 7 to 2 on Monday. ".repeat(400)}`), env, {
      fetchImpl,
      rate: { buckets: new Map(), inFlight: { count: 0 } },
      now: () => 9_000,
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request body is too large." });
  });

  it("caches a repeated paste and does not reserve the second analysis", async () => {
    const { fetchImpl } = scriptedFetch();
    const gate = new MemoryRateGate();
    const saved = new Map<string, AnalysisResult>();
    const analysisCache: AnalysisCache = {
      async get() {
        return null;
      },
      async put() {
        /* URL cache is unused for a paste. */
      },
      async getText(text, language) {
        return saved.get(`${language}:${normaliseCachedText(text)}`) ?? null;
      },
      async putText(text, language, result) {
        saved.set(`${language}:${normaliseCachedText(text)}`, result);
      },
    };
    const now = 1_700_000_000_000;
    const first = await handleRequest(post(article), env, {
      gate,
      fetchImpl,
      analysisCache,
      now: () => now,
      rate: { buckets: new Map(), inFlight: { count: 0 } },
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("event: result");
    expect(gate.book.ips.anonymous?.recent).toHaveLength(1);
    const second = await handleRequest(post(article.replace(/ /g, "  ")), env, {
      gate,
      fetchImpl,
      analysisCache,
      now: () => now + 1_000,
      rate: { buckets: new Map(), inFlight: { count: 0 } },
    });
    expect(second.status).toBe(200);
    expect(await second.text()).toContain("event: result");
    expect(gate.book.ips.anonymous?.recent).toHaveLength(1);
    expect(saved.size).toBe(1);
  });

  it("does not search a personal anecdote and keeps an echo-only claim in coverage", async () => {
    const anecdote = "\"I've been vaping for two years,\" said Maria, a teacher from Leeds.";
    const vote = "The council voted 7 to 2 on Monday and published the minutes for residents.";
    const echo = "Twelve boats remain on the waiting list until the spring season opens for residents.";
    const queries: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        const body = JSON.parse(String(init?.body)) as { query?: string };
        const query = body.query ?? "";
        queries.push(query);
        const web = query.includes("council")
          ? [{ url: minutes.url, title: minutes.title, description: "The council voted 7 to 2 on Monday." }]
          : [
              {
                url: "https://news.yahoo.com/boats",
                title: echo,
                description: echo,
              },
            ];
        return new Response(JSON.stringify({ success: true, data: { web } }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        const payload = JSON.parse(user) as { claims: { id: string; text: string }[] };
        expect(payload.claims.some((claim) => claim.text.includes("Maria"))).toBe(false);
        return llmPayload({
          queries: payload.claims.map((claim) => ({
            id: claim.id,
            query: claim.text.includes("council") ? "council voted 7 to 2" : "boats waiting list",
          })),
        });
      }
      if (system.startsWith("TASK:verify")) {
        const payload = JSON.parse(user) as { claims: { id: string; evidence: { url: string }[] }[] };
        return llmPayload({
          results: payload.claims.map((claim) => ({
            id: claim.id,
            label: "True",
            confidence: 0.9,
            explanation: "The minutes record a seven to two vote.",
            sourceUrls: claim.evidence.map((item) => item.url),
          })),
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const result = await analyze(
      { text: `${anecdote} ${vote} ${echo}`, uiLanguage: "en" },
      { env, fetchImpl },
    );
    const personal = result.segments.find((segment) => segment.text.includes("Maria"));
    expect(personal?.label).toBe("Personal");
    expect(personal?.explanation.toLowerCase()).toContain("not selected");
    expect(personal?.sources).toEqual([]);
    expect(queries.some((query) => /maria|vaping/i.test(query))).toBe(false);
    expect(result.claimsVerified).toBe(1);
    expect(result.claimsCovered).toBe(1);
    expect(result.claimsTotal).toBe(2);
    expect(result.score.verdict).toContain("1 of 2");
    expect(result.provisional).toBe(false);
  });

  it("searches a Greek claim in Greek and keeps a dropped figure", async () => {
    const searches: string[] = [];
    const greek = "4,9 εκατομμύρια ενήλικες στην Ελλάδα καπνίζουν σύμφωνα με την έρευνα υγείας του υπουργείου.";
    const english = "BBC reported that 4.9 million adults in the UK smoke according to the health survey.";
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        const body = JSON.parse(String(init?.body)) as { query?: string };
        searches.push(body.query ?? "");
        return new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        const start = user.indexOf("[");
        const sentences = JSON.parse(user.slice(start)) as { id: string; text: string }[];
        const greekArticle = sentences.some((sentence) => /[\u0370-\u03FF]/.test(sentence.text));
        return llmPayload({
          detectedLanguage: greekArticle ? "el" : "en",
          genre: "news",
          segments: sentences.map((sentence) => ({
            id: sentence.id,
            claimType: "checkable_factual",
            note: greekArticle ? "Καταγεγραμμένος ισχυρισμός." : "A recorded claim.",
          })),
        });
      }
      if (system.startsWith("TASK:queries")) {
        const payload = JSON.parse(user) as { claims: { id: string; text: string }[] };
        return llmPayload({
          queries: payload.claims.map((claim) => ({
            id: claim.id,
            query: /[\u0370-\u03FF]/.test(claim.text) ? "adult smoking habits" : "smoking habits survey",
          })),
        });
      }
      if (system.startsWith("TASK:verify")) {
        const payload = JSON.parse(user) as { claims: { id: string }[] };
        return llmPayload({
          results: payload.claims.map((claim) => ({
            id: claim.id,
            label: "Unverifiable",
            confidence: 0.4,
            explanation: "No pages were retrieved.",
            sourceUrls: [],
          })),
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    await analyze({ text: greek, uiLanguage: "en" }, { env, fetchImpl });
    expect(searches.some((query) => /[\u0370-\u03FF]/.test(query) && /4[,.]9/.test(query))).toBe(true);
    searches.length = 0;
    await analyze({ text: english, uiLanguage: "en" }, { env, fetchImpl });
    expect(searches.some((query) => /4\.9/.test(query) && /BBC/i.test(query))).toBe(true);
  });

  it("says an unselected claim was not selected for checking", async () => {
    const topics = [
      "bridge", "harbour", "marina", "ferry", "dock", "pier", "lighthouse", "breakwater",
      "channel", "buoy", "anchor", "keel", "rudder",
    ];
    const claims = topics.map(
      (topic, index) =>
        `The ${topic} committee counted ${index + 20} vessels and published the tally for residents.`,
    );
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.firecrawl.dev")) {
        return new Response(JSON.stringify({ success: true, data: { web: [] } }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        const payload = JSON.parse(user) as { claims: { id: string }[] };
        return llmPayload({ queries: payload.claims.map((claim) => ({ id: claim.id, query: "committee vessels" })) });
      }
      if (system.startsWith("TASK:verify") || system.startsWith("TASK:consistency")) {
        return llmPayload({ contradictions: [], results: [] });
      }
      throw new Error(system.slice(0, 24));
    };
    const result = await analyze({ text: claims.join(" "), uiLanguage: "en" }, { env, fetchImpl });
    const skipped = result.segments.find((segment) => segment.text.includes("rudder"));
    expect(skipped?.explanation).toBe("This claim was not selected for checking.");
    expect(skipped?.explanation).not.toContain("budget");
    expect(result.meta.warnings.join(" ")).not.toContain("subrequest limit");
  });

  it("reuses a deterministic query for the same claim and reads a buried figure", async () => {
    clearSearchCache();
    const claim = "5.4 million people aged 16 and over vape in Britain according to the health survey.";
    const text = `${claim} Researchers said the survey asked adults about daily use and published the tables the same afternoon.`;
    const searches: string[] = [];
    let queryCalls = 0;
    let verifyClaim = "";
    const prefix = "Site navigation and an unrelated introduction. ".repeat(24);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("api.tavily.com/search")) {
        const body = JSON.parse(String(init?.body)) as { query?: string };
        searches.push(body.query ?? "");
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Adult vaping",
                url: "https://www.ons.gov.uk/vaping",
                content: "The health survey discusses adult habits in Britain.",
                raw_content: `${prefix} Official figures say 5.4 million people aged 16 and over vape in Britain.`,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
      const system = body.messages[0]?.content ?? "";
      const user = body.messages[1]?.content ?? "";
      if (system.startsWith("TASK:segment")) {
        return llmPayload(classifyPayload(user, () => ({ claimType: "checkable_factual", note: "A recorded claim." })));
      }
      if (system.startsWith("TASK:queries")) {
        queryCalls += 1;
        return llmPayload({ queries: [{ id: "s1", query: "vaping habits survey" }] });
      }
      if (system.startsWith("TASK:verify")) {
        verifyClaim = user;
        const payload = JSON.parse(user) as { claims: { id: string; evidence: { url: string }[] }[] };
        return llmPayload({
          results: payload.claims.map((item) => ({
            id: item.id,
            label: "True",
            confidence: 0.9,
            explanation: "The survey reports 5.4 million people.",
            sourceUrls: item.evidence.map((entry) => entry.url),
          })),
        });
      }
      if (system.startsWith("TASK:consistency")) return llmPayload({ contradictions: [] });
      throw new Error(system.slice(0, 24));
    };
    const envWithTavily = { ...env, TAVILY_API_KEY: "tavily-test-key", FIRECRAWL_API_KEY: "" };
    await analyze({ text, uiLanguage: "en" }, { env: envWithTavily, fetchImpl });
    expect(queryCalls).toBe(1);
    expect(verifyClaim).toContain("Official figures say 5.4 million");
    const first = searches[0] ?? "";
    expect(first).toMatch(/5\.4/);
    searches.length = 0;
    clearTavilyCache();
    await analyze({ text, uiLanguage: "en" }, { env: envWithTavily, fetchImpl });
    expect(queryCalls).toBe(1);
    expect(searches[0]).toBe(first);
  });

  it("sends an error event when the request is aborted", async () => {
    const controller = new AbortController();
    const fetchImpl: typeof fetch = () => new Promise(() => {});
    const response = await handleRequest(
      new Request("https://worker.test/api/analyze", {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json", Origin: "http://127.0.0.1:5173" },
        body: JSON.stringify({ text: article, uiLanguage: "en" }),
      }),
      env,
      {
        fetchImpl,
        rate: { buckets: new Map(), inFlight: { count: 0 } },
        now: () => 40_000,
        deadlineMs: 30_000,
      },
    );
    controller.abort();
    const events = parseSse(await response.text());
    const terminal = events.filter((event) => event.event === "result" || event.event === "error");
    expect(terminal).toHaveLength(1);
    expect(terminal[0]?.event).toBe("error");
    expect(JSON.stringify(terminal[0]?.data)).toContain("interrupted");
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
