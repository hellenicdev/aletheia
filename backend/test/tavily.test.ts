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

  it("keeps a figure that sits past the short snippet for the first matching source", async () => {
    clearTavilyCache();
    const prefix = "Navigation and an unrelated introduction to the health survey. ".repeat(20);
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              title: "Other news",
              url: "https://example.com/other",
              content: "A short summary about shipping delays and harbour fees this week.",
              raw_content: `${prefix} Nothing here names the survey figure.`,
            },
            {
              title: "Adult vaping",
              url: "https://example.com/vaping",
              content: "A short summary of the health survey without the total.",
              raw_content: `${prefix} Official figures say 5.4 million people aged 16 and over vape in Britain.`,
            },
            {
              title: "Second copy",
              url: "https://example.com/copy",
              content: "Another short summary without the total.",
              raw_content: `${prefix} The same bulletin repeats that 5.4 million people vape.`,
            },
            {
              title: "Third copy",
              url: "https://example.com/third",
              content: "A third short summary without the total.",
              raw_content: `${prefix} A later wire also says 5.4 million people vape.`,
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const hits = await searchTavily({
      apiKey: "tavily-test-key",
      query: "5.4 million vape",
      claim: "5.4 million people aged 16 and over vape in Britain.",
      fetchImpl,
      topic: "news",
      includeRawContent: true,
    });
    expect(hits[0]?.snippet).not.toContain("5.4 million");
    expect(hits[1]?.snippet).toContain("Official figures say 5.4 million");
    expect(hits[1]?.snippet.length).toBeLessThanOrEqual(1500);
    expect(hits[2]?.snippet).toContain("5.4 million");
    expect(hits[3]?.snippet).not.toContain("5.4 million");
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
