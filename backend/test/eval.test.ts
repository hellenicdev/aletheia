import { describe, expect, it } from "vitest";
import { combineTone } from "../../shared/tone";
import { EVAL_FIXTURES } from "../../shared/evalFixtures";
import { analyze } from "../src/pipeline";

const env = {
  OPENAI_API_KEY: "test-key",
  FIRECRAWL_API_KEY: "firecrawl-test-key",
  OPENAI_MODEL: "Beam-501B-A23B",
  OPENAI_BASE_URL: "https://api.reflection.ai/openai/v1",
};

function sentencesFrom(user: string): { id: string; text: string }[] {
  const start = user.indexOf("[");
  return JSON.parse(user.slice(start)) as { id: string; text: string }[];
}

describe("offline evaluation fixtures", () => {
  for (const fixture of EVAL_FIXTURES) {
    it(`${fixture.id} keeps the expected score shape`, async () => {
      const fetchImpl: typeof fetch = async (input, init) => {
        const url = String(input);
        const body = init?.body ? (JSON.parse(String(init.body)) as { messages?: { content: string }[] }) : {};
        const system = body.messages?.[0]?.content ?? "";
        const user = body.messages?.[1]?.content ?? "";
        if (url.includes("/chat/completions") && system.startsWith("TASK:segment")) {
          const sentences = sentencesFrom(user);
          return json({
            detectedLanguage: "en",
            genre: fixture.kind === "reputable" ? "news" : fixture.kind === "low-credibility" ? "unreliable" : fixture.kind,
            segments: sentences.map((sentence) => ({
              id: sentence.id,
              claimType: /I think|We should|In my view/.test(sentence.text)
                ? "opinion"
                : /fucking|pricks|bastards/.test(sentence.text)
                  ? "rhetorical"
                  : "checkable_factual",
              note: "Classified for the fixture.",
            })),
          });
        }
        if (url.includes("/chat/completions") && system.startsWith("TASK:queries")) {
          const claims = JSON.parse(user) as { claims: { id: string }[] };
          return json({ queries: claims.claims.map((claim) => ({ id: claim.id, query: claim.id })) });
        }
        if (url.includes("/chat/completions") && system.startsWith("TASK:verify")) {
          const payload = JSON.parse(user) as { claims: { id: string }[] };
          const source =
            fixture.kind === "reputable" ? "https://www.reuters.com/world/harbour-fees" : `https://www.${fixture.domain}/copy`;
          return json({
            results: payload.claims.map((claim) => ({
              id: claim.id,
              label: "True",
              confidence: 0.95,
              explanation: "The retrieved page repeats the claim.",
              sourceUrls: [source],
            })),
          });
        }
        if (url.includes("/chat/completions") && system.startsWith("TASK:consistency")) {
          return json({ contradictions: [] });
        }
        if (url.includes("api.firecrawl.dev/v2/search")) {
          const source =
            fixture.kind === "reputable" || fixture.kind === "opinion"
              ? {
                  url: "https://www.reuters.com/world/harbour-fees",
                  title: "Reuters",
                  description: "Harbour officials confirmed a separate count of the fee vote and the waiting list.",
                }
              : {
                  url: `https://www.${fixture.domain}/copy`,
                  title: fixture.domain ?? "copy",
                  description: fixture.text.slice(0, 180),
                };
          return new Response(JSON.stringify({ success: true, data: { web: [source] } }), { status: 200 });
        }
        if (url.includes("api.firecrawl.dev/v2/scrape")) {
          return new Response(
            JSON.stringify({
              success: true,
              data: {
                markdown: `# ${fixture.title}\n\n${fixture.text}`,
                metadata: {
                  title: fixture.title,
                  sourceURL: `https://www.${fixture.domain}/story`,
                  publishedTime: "2026-10-12T08:00:00Z",
                },
              },
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected ${url} ${system.slice(0, 24)}`);
      };

      const result = await analyze(
        { url: `https://www.${fixture.domain}/story`, uiLanguage: "en" },
        { env: { ...env }, fetchImpl, requestId: fixture.id },
      );
      if (fixture.minOverall !== undefined) expect(result.score.overall).toBeGreaterThanOrEqual(fixture.minOverall);
      if (fixture.maxOverall !== undefined) expect(result.score.overall).toBeLessThanOrEqual(fixture.maxOverall);
      if (fixture.expectOpinion) {
        expect(result.segments.some((segment) => segment.label === "Opinion")).toBe(true);
        expect(result.score.verdict.toLowerCase()).toContain("mostly opinion");
        expect(result.score.overall).toBeLessThanOrEqual(65);
      }
      if (fixture.kind === "reputable") {
        expect(result.score.verdict.toLowerCase()).not.toContain("mostly opinion");
      }
      if (fixture.maxTone !== undefined) {
        expect(result.score.toneNeutrality).toBeLessThanOrEqual(fixture.maxTone);
        expect(combineTone(result.segments.map((segment) => segment.text))).toBeLessThanOrEqual(fixture.maxTone);
      }
      if (fixture.kind === "satire" || fixture.kind === "low-credibility") {
        expect(result.segments.some((segment) => segment.label === "True" && segment.sources.some((source) => source.url.includes(fixture.domain ?? "")))).toBe(false);
      }
      expect(result.score.verdict).toContain(`${result.score.overall}/100`);
      expect(result.meta.outlet).toBe(fixture.kind === "reputable" ? "news" : fixture.kind);
    });
  }
});

function json(payload: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(payload) } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
