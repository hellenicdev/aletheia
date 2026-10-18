import { describe, expect, it } from "vitest";
import { clearTavilyCache, createTavilyGate, extractTavily, searchTavily } from "../src/tavily";

describe("searchTavily", () => {
  it("maps a news result and trims raw content when the snippet is thin", async () => {
    clearTavilyCache();
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://api.tavily.com/search");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer tavily-test-key");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      expect(JSON.stringify(body)).not.toContain("tavily-test-key");
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Council minutes",
              url: "https://example.com/minutes",
              content: "short",
              raw_content: `The council voted 7 to 2 on Monday. ${"detail ".repeat(80)}`,
              published_date: "2026-03-01T00:00:00Z",
            },
            { title: "Skip", url: "not a url", content: "no" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const hits = await searchTavily({
      apiKey: "tavily-test-key",
      query: "council vote",
      fetchImpl,
      topic: "news",
      includeRawContent: true,
    });
    expect(bodies[0]).toMatchObject({
      search_depth: "basic",
      topic: "news",
      max_results: 5,
      include_raw_content: true,
      include_answer: false,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.url).toBe("https://example.com/minutes");
    expect(hits[0]?.snippet.startsWith("The council voted 7 to 2")).toBe(true);
    expect(hits[0]?.snippet.length).toBeLessThanOrEqual(400);
    expect(hits[0]?.publishedAt).toBe("2026-03-01T00:00:00.000Z");
  });

  it("stops further calls after HTTP 432 and does not echo the key", async () => {
    clearTavilyCache();
    const gate = createTavilyGate();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: "plan limit for key tavily-test-key" }), { status: 432 });
    };
    await expect(
      searchTavily({ apiKey: "tavily-test-key", query: "harbour fee", fetchImpl, gate }),
    ).rejects.toThrow(/HTTP 432/);
    await expect(
      searchTavily({ apiKey: "tavily-test-key", query: "second claim", fetchImpl, gate }),
    ).rejects.toThrow(/HTTP 432/);
    expect(calls).toBe(1);
    try {
      await searchTavily({ apiKey: "tavily-test-key", query: "third", fetchImpl, gate });
    } catch (error) {
      expect(String(error)).not.toContain("tavily-test-key");
    }
  });
});

describe("extractTavily", () => {
  it("returns article text from a basic extract", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toBe("https://api.tavily.com/extract");
      const body = JSON.parse(String(init?.body)) as { extract_depth?: string; urls?: string[] };
      expect(body).toEqual({ urls: ["https://news.example/story"], extract_depth: "basic" });
      return new Response(
        JSON.stringify({
          results: [
            {
              url: "https://news.example/story",
              raw_content:
                "Harbour vote\n\nThe council voted 7 to 2 on Monday and published the minutes for residents of the district.",
            },
          ],
        }),
        { status: 200 },
      );
    };
    const page = await extractTavily({
      apiKey: "tavily-test-key",
      url: "https://news.example/story",
      fetchImpl,
    });
    expect(page.title).toBe("Harbour vote");
    expect(page.text).toContain("voted 7 to 2");
    expect(page.finalUrl).toBe("https://news.example/story");
  });
});
