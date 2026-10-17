import { describe, expect, it } from "vitest";
import { markdownToText, scrapeArticle, searchWeb } from "../src/firecrawl";
import { fetchArticle } from "../src/extract";
import { HttpError } from "../src/errors";

describe("searchWeb", () => {
  it("reads Firecrawl web hits and never puts the key in the body", async () => {
    let authorization = "";
    let payload: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      payload = JSON.parse(String(init?.body));
      expect(String(input)).toBe("https://api.firecrawl.dev/v2/search");
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            web: [
              {
                url: "https://example.com/minutes/",
                title: "Minutes",
                description: "The council voted 7 to 2.",
              },
              { url: "javascript:alert(1)", title: "Nope", description: "Ignore" },
            ],
          },
        }),
        { status: 200 },
      );
    };

    const hits = await searchWeb({
      apiKey: "secret-firecrawl-key",
      query: "council vote",
      language: "en",
      fetchImpl,
    });

    expect(authorization).toBe("Bearer secret-firecrawl-key");
    expect(JSON.stringify(payload)).not.toContain("secret-firecrawl-key");
    expect(payload).toMatchObject({ query: "council vote", sources: ["web"], highlights: false });
    expect(hits).toEqual([
      {
        url: "https://example.com/minutes/",
        title: "Minutes",
        snippet: "The council voted 7 to 2.",
      },
    ]);
  });

  it("also accepts the older array-shaped data payload and biases Greek queries to Greece", async () => {
    let payload: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          success: true,
          data: [{ url: "https://example.com/a", title: "A", description: "Snippet" }],
        }),
      );
    };
    const hits = await searchWeb({
      apiKey: "k",
      query: "αύξηση τέλους",
      language: "el",
      fetchImpl,
    });
    expect(payload.country).toBe("GR");
    expect(hits[0]?.snippet).toBe("Snippet");
  });
});

describe("searchWeb retries", () => {
  it("backs off on HTTP 429 and then accepts the next response", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("Consumed (req/min): 11, Remaining: 0", { status: 429 });
      return new Response(
        JSON.stringify({
          success: true,
          data: [{ url: "https://example.com/a", title: "A", description: "Recovered" }],
        }),
      );
    };
    const hits = await searchWeb({
      apiKey: "k",
      query: "retry after limit",
      language: "en",
      fetchImpl,
      retryDelayMs: 0,
    });
    expect(calls).toBe(2);
    expect(hits[0]?.snippet).toBe("Recovered");
  });
});

describe("searchWeb failures", () => {
  it("includes the HTTP status and strips the key", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("bad token secret-firecrawl-key", { status: 401 });
    await expect(
      searchWeb({
        apiKey: "secret-firecrawl-key",
        query: "eiffel tower",
        language: "en",
        fetchImpl,
      }),
    ).rejects.toThrow(/search: HTTP 401/);
    await expect(
      searchWeb({
        apiKey: "secret-firecrawl-key",
        query: "eiffel tower",
        language: "en",
        fetchImpl,
      }),
    ).rejects.toThrow(/\[redacted\]/);
  });
});

describe("scrapeArticle", () => {
  it("asks for markdown main content and keeps title, date, and body", async () => {
    let payload: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (input, init) => {
      payload = JSON.parse(String(init?.body));
      expect(String(input)).toBe("https://api.firecrawl.dev/v2/scrape");
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            markdown:
              "# Harbour vote\n\nThe council [voted](https://example.com/m) **7 to 2** and published the full minutes for residents.\n\nNav crumbs should already be gone.",
            metadata: {
              title: "Harbour vote",
              sourceURL: "https://news.example/harbour",
              publishedTime: "2026-03-03T10:00:00Z",
            },
          },
        }),
      );
    };

    const page = await scrapeArticle({
      url: "https://news.example/harbour",
      apiKey: "secret-firecrawl-key",
      fetchImpl,
    });

    expect(payload).toMatchObject({
      formats: ["markdown", "html"],
      onlyMainContent: true,
      excludeTags: expect.arrayContaining(["nav", "footer"]),
      url: "https://news.example/harbour",
    });
    expect(JSON.stringify(payload)).not.toContain("secret-firecrawl-key");
    expect(page.title).toBe("Harbour vote");
    expect(page.finalUrl).toBe("https://news.example/harbour");
    expect(page.publishedAt).toBe("2026-03-03T10:00:00.000Z");
    expect(page.text).toContain("voted 7 to 2");
    expect(page.text).not.toContain("https://example.com/m");
    expect(page.text).not.toContain("**");
  });

  it("does not call Firecrawl for a private URL", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new Error("should not fetch");
    };
    await expect(
      scrapeArticle({
        url: "http://169.254.169.254/latest",
        apiKey: "k",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(HttpError);
  });
});

describe("fetchArticle fallback", () => {
  it("uses Firecrawl when a key is set and the direct reader when it is not", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      if (String(input).includes("api.firecrawl.dev")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              markdown:
                "The council voted 7 to 2 and published the full minutes for every resident to read.",
              metadata: { title: "From Firecrawl", sourceURL: "https://news.example/story" },
            },
          }),
        );
      }
      return new Response(
        "<html><body><article><p>The council voted 7 to 2 and published the full minutes for every resident to read.</p></article></body></html>",
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };

    const scraped = await fetchArticle("https://news.example/story", fetchImpl, "fc-key");
    expect(scraped.via).toBe("firecrawl");
    expect(scraped.title).toBe("From Firecrawl");
    expect(calls.some((call) => call.startsWith("GET https://news.example"))).toBe(false);

    const local = await fetchArticle("https://news.example/story", fetchImpl);
    expect(local.via).toBe("local");
    expect(local.text).toContain("full minutes");
  });
});

describe("markdownToText", () => {
  it("drops link targets and emphasis", () => {
    expect(markdownToText("See [the minutes](https://example.com/m) and *the fee*.")).toBe(
      "See the minutes and the fee.",
    );
  });
});
