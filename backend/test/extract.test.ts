import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pageUnreadMessage } from "../../shared/messages";
import { createSubrequestBudget, trackFetch } from "../src/budget";
import { clearSearchCache, createProviderGate } from "../src/firecrawl";
import { extractArticle, fetchArticle } from "../src/extract";
import { HttpError } from "../src/errors";

const html = `<!doctype html>
<html>
<head>
  <title>Ignored title</title>
  <meta property="og:title" content="Harbour vote &amp; fees" />
  <meta property="article:published_time" content="2026-03-03T10:00:00Z" />
  <script type="application/ld+json">{"@type":"NewsArticle","headline":"From JSON","datePublished":"2026-01-01"}</script>
</head>
<body>
  <nav>Home navigation secretcookie</nav>
  <article>
    <h1>Harbour vote</h1>
    <p>The council voted 7 to 2 and published the full minutes for residents.</p>
    <p>Fees &amp; fines rose by a small amount, according to the schedule.</p>
    <script>secretcookie</script>
  </article>
  <footer>Copyright secretcookie</footer>
</body>
</html>`;

describe("extractArticle", () => {
  it("keeps the article and drops navigation, scripts, and the footer", () => {
    const article = extractArticle(html, "https://news.example/story");
    expect(article.title).toBe("Harbour vote & fees");
    expect(article.text).toContain("The council voted 7 to 2");
    expect(article.text).toContain("Fees & fines");
    expect(article.text).not.toContain("secretcookie");
    expect(article.text).not.toContain("Home navigation");
    expect(article.publishedAt).toBe("2026-03-03T10:00:00.000Z");
  });

  it("keeps the AP story body and the Onion article, not the menu or the cookie banner", () => {
    const ap = extractArticle(
      `<body>
        <div class="NavMenu">World editors recommend more stories from the politics desk and the business desk today.</div>
        <p>16, 2026, in San Diego.</p>
        <div class="RichTextStoryBody">
          <p>The coastal plant received a federal loan that will fund the restart, according to the filing released on Monday morning.</p>
        </div>
      </body>`,
      "https://apnews.com/article/coastal-loan",
    );
    expect(ap.text).toContain("federal loan");
    expect(ap.text).not.toContain("politics desk");
    expect(ap.text).not.toContain("San Diego");

    const onion = extractArticle(
      `<body>
        <div class="cookie-banner">We use cookies and similar technologies to measure visits. Accept all cookies to continue browsing this video page today.</div>
        <div class="entry-content">
          <p>The harbour board told the gulls to count their days and issued a written notice to every marina on the coast.</p>
        </div>
      </body>`,
      "https://www.theonion.com/video/gulls",
    );
    expect(onion.text).toContain("harbour board");
    expect(onion.text).not.toContain("cookies");
  });

  it("keeps a WordPress article body and drops the sibling menu", () => {
    const page = extractArticle(
      `<body>
        <div class="sidebar">World editors recommend more stories from the politics desk and the business desk today.</div>
        <div class="entry-content">
          <p>The council voted 7 to 2 and published the full minutes for residents of the harbour district.</p>
        </div>
      </body>`,
      "https://example.com/2026/10/harbour",
    );
    expect(page.text).toContain("voted 7 to 2");
    expect(page.text).not.toContain("politics desk");
  });

  it("drops a related-story block that sits beside the article", () => {
    const page = extractArticle(
      `<body>
        <div class="entry-content">
          <p>The wreck was found off Antalya and is described as the oldest shipwreck known to archaeologists.</p>
        </div>
        <div class="k-read-more-wrapper">
          <p>A different wreck off Sicily was found by another team last year and is not this story at all.</p>
        </div>
      </body>`,
      "https://www.kathimerini.gr/world/564520936/story",
    );
    expect(page.text).toContain("Antalya");
    expect(page.text).not.toContain("Sicily");
  });

  it("reads saved BBC, Onion, Guardian, and AP fixtures", () => {
    const bbc = extractArticle(fixture("bbc-vaping.html"), "https://www.bbc.com/news/articles/ck62y33489zqo");
    expect(bbc.title).toBe("Vaping: Why people who have never smoked are getting hooked");
    expect(bbc.publishedAt).toBe("2026-10-16T23:49:16.051Z");
    expect(bbc.text).toContain("Gracey Mungulu");
    expect(bbc.text).toContain("never smoked");
    expect(bbc.text).not.toContain("vape shop");
    expect(bbc.text).not.toContain("another health story");
    expect(bbc.text).not.toContain("cookies");

    const related = extractArticle(
      fixture("tails/bbc-related.html"),
      "https://www.bbc.com/news/articles/ck62y33489zqo",
    );
    expect(related.text).toContain("not considered a healthy");
    expect(related.text).not.toContain("panic-buy");
    expect(related.text).not.toContain("lie-ins");
    expect(related.text).not.toContain("life-changing drug");
    expect(related.ignoredLines).toBeGreaterThan(0);

    const onion = extractArticle(
      fixture("onion-monarch.html"),
      "https://theonion.com/epa-to-monarch-butterflies-count-your-fucking-days/",
    );
    expect(onion.title).toBe("EPA To Monarch Butterflies: ‘Count Your Fucking Days’");
    expect(onion.siteName).toBe("The Onion");
    expect(onion.byline).toBe("The Onion Staff");
    expect(onion.publishedAt).toBe("2025-11-10T14:00:00.000Z");
    expect(onion.text).toContain("count your fucking days");
    expect(onion.text).toContain("moth pricks");
    expect(onion.text).not.toContain("traffic");
    expect(onion.text).not.toContain("Subscribe");

    const guardian = extractArticle(
      fixture("guardian-scrounger.html"),
      "https://www.theguardian.com/commentisfree/2026/oct/16/right-scrounger-rhetoric-benefits-labour-compassion-welfare",
    );
    expect(guardian.title).toContain("scrounger rhetoric");
    expect(guardian.siteName).toBe("the Guardian");
    expect(guardian.byline).toBe("Frances Ryan");
    expect(guardian.publishedAt).toBe("2026-10-16T05:00:52.000Z");
    expect(guardian.text).toContain("Back in 2009");
    expect(guardian.text).not.toContain("housing");
    expect(guardian.text).not.toContain("cookies");

    const ap = extractArticle(fixture("ap-loan.html"), "https://apnews.com/article/coastal-loan");
    expect(ap.title).toBe("Coastal plant receives federal loan to restart operations");
    expect(ap.siteName).toBe("AP News");
    expect(ap.byline).toBe("Jane Reporter");
    expect(ap.publishedAt).toBe("2026-10-16T12:00:00.000Z");
    expect(ap.text).toContain("federal loan");
    expect(ap.text).not.toContain("politics desk");
    expect(ap.text).not.toContain("San Diego");
    expect(ap.text).not.toContain("promo");
    expect(ap.text).not.toContain("File photo");
  });

  it("reads a byline and site name from JSON-LD when the meta author is a URL", () => {
    const guardian = extractArticle(
      `<head>
        <meta property="og:site_name" content="the Guardian" />
        <meta property="article:author" content="https://www.theguardian.com/profile/frances-ryan" />
        <script type="application/ld+json">{"@type":"NewsArticle","headline":"A column","author":[{"@type":"Person","name":"Frances Ryan"}],"publisher":{"@type":"Organization","name":"The Guardian"}}</script>
      </head>
      <body><article><p>Back in 2009, months before the coalition government unleashed sweeping austerity, the debate had already turned on people who claimed benefits.</p></article></body>`,
      "https://www.theguardian.com/commentisfree/example",
    );
    expect(guardian.byline).toBe("Frances Ryan");
    expect(guardian.siteName).toBe("the Guardian");

    const bbc = extractArticle(
      `<head>
        <meta property="cXenseParse:author" content="Amy Walker" />
        <script type="application/ld+json">{"@type":"ReportageNewsArticle","headline":"Vaping","author":[{"@type":"Person","name":"Amy Walker"}],"publisher":{"@type":"NewsMediaOrganization","name":"BBC News"},"datePublished":"2026-10-16T23:49:16.051Z"}</script>
      </head>
      <body><article><p>When vaping first took off at Gracey Mungulu's school, the habit looked like a fad that would pass by the summer.</p></article></body>`,
      "https://www.bbc.com/news/articles/example",
    );
    expect(bbc.byline).toBe("Amy Walker");
    expect(bbc.siteName).toBe("BBC News");
  });

  it("uses the document title when og:title is missing", () => {
    const page = extractArticle(
      `<head><title>Document title wins</title>
        <script type="application/ld+json">{"@type":"NewsArticle","headline":"JSON headline"}</script>
      </head>
      <body><h1>H1 headline</h1>
        <article><p>The council voted 7 to 2 and published the full minutes for residents of the harbour district.</p></article>
      </body>`,
      "https://news.example/story",
    );
    expect(page.title).toBe("Document title wins");
  });

  it("keeps the largest paragraph cluster when the page has no article body", () => {
    const page = extractArticle(
      `<body>
        <p>The council voted 7 to 2 and published the full minutes for residents of the harbour district.</p>
        <p>Fees and fines rose by a small amount, according to the schedule released on Monday morning.</p>
        <nav><p>Home world politics business sport and the rest of the menu today.</p></nav>
        <p>The evening concert was cancelled after the stage lights failed and the crowd went home.</p>
        <div class="related-stories"><p>A different story about a festival should not be included in this cluster at all.</p></div>
        <div class="subscribe"><p>Subscribe to the morning newsletter for more headlines and alerts every day.</p></div>
        <figcaption>A photo of the harbour wall at dusk should stay out of the text.</figcaption>
      </body>`,
      "https://news.example/cluster",
    );
    expect(page.text).toContain("voted 7 to 2");
    expect(page.text).toContain("Fees and fines");
    expect(page.text).not.toContain("evening concert");
    expect(page.text).not.toContain("festival");
    expect(page.text).not.toContain("newsletter");
    expect(page.text).not.toContain("harbour wall");
    expect(page.text).not.toContain("politics");
  });

  it("rejects a Cloudflare challenge page", () => {
    expect(() =>
      extractArticle(
        `<html><head><title>Just a moment...</title></head><body><p>Just a moment...</p><p>Enable JavaScript and cookies to continue.</p></body></html>`,
        "https://apnews.com/",
      ),
    ).toThrow(/Paste the text instead/);
  });
});

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

describe("fetchArticle", () => {
  it("prefers the AP HTML story when markdown is a longer menu", async () => {
    clearSearchCache();
    const menu =
      "World editors recommend more stories from the politics desk and the business desk every morning before the paper closes for the night.";
    const loan =
      "The coastal plant received a federal loan that will fund the restart, according to the filing released on Monday morning.";
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            markdown: `${menu}\n\n${menu} The politics desk kept filing more items so this markdown dump is much longer than the story itself and would otherwise win.`,
            html: `<div class="NavMenu"><p>${menu}</p></div><div class="RichTextStoryBody"><p>${loan}</p></div>`,
            metadata: { title: "Loan", sourceURL: "https://apnews.com/article/coastal-loan" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const page = await fetchArticle("https://apnews.com/article/coastal-loan", fetchImpl, "key");
    expect(page.text).toContain("federal loan");
    expect(page.text).not.toContain("politics desk");
    expect(page.text).not.toContain("personalization");
  });

  it("refuses a redirect onto a private address", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return new Response("", {
        status: 302,
        headers: { location: "http://127.0.0.1/secret" },
      });
    };
    await expect(fetchArticle("https://news.example/story", fetchImpl)).rejects.toBeInstanceOf(
      HttpError,
    );
    expect(calls).toBe(1);
  });

  it("reads the page directly when Firecrawl scrape fails", async () => {
    clearSearchCache();
    const gate = createProviderGate();
    const calls: { url: string; headers: HeadersInit | undefined; signal: AbortSignal | null | undefined }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), headers: init?.headers, signal: init?.signal });
      if (String(input).includes("api.firecrawl.dev")) {
        return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
      }
      return new Response(fixture("bbc-vaping.html"), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };
    const page = await fetchArticle(
      "https://www.bbc.com/news/articles/ck62y33489zqo",
      fetchImpl,
      "fc-key",
      undefined,
      undefined,
      undefined,
      "en",
      gate,
    );
    expect(page.via).toBe("direct");
    expect(page.text).toContain("Gracey Mungulu");
    expect(page.title).toContain("Vaping");
    expect(calls.some((call) => call.url.startsWith("GET") || call.url.includes("bbc.com"))).toBe(true);
    const direct = calls.find((call) => call.url.includes("bbc.com"));
    const headers = new Headers(direct?.headers);
    expect(headers.get("user-agent")).toMatch(/Mozilla\/5\.0/);
    expect(headers.get("accept")).toContain("text/html");
    expect(direct?.signal).toBeInstanceOf(AbortSignal);
    expect(gate.block?.status).toBe(402);
    expect(calls.filter((call) => call.url.includes("bbc.com"))).toHaveLength(1);
  });

  it("counts the direct fetch and each redirect hop", async () => {
    clearSearchCache();
    const budget = createSubrequestBudget();
    let hops = 0;
    const raw: typeof fetch = async () => {
      hops += 1;
      if (hops === 1) {
        return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
      }
      if (hops === 2) {
        return new Response("", { status: 302, headers: { location: "https://www.bbc.com/news/articles/final" } });
      }
      return new Response(fixture("bbc-vaping.html"), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };
    const page = await fetchArticle("https://www.bbc.com/news/articles/start", trackFetch(raw, budget), "fc-key");
    expect(page.via).toBe("direct");
    expect(page.finalUrl).toBe("https://www.bbc.com/news/articles/final");
    expect(budget.snapshot().ingest).toBe(3);
    expect(budget.snapshot().total).toBe(3);
  });

  it("falls back when the scrape is empty or times out", async () => {
    clearSearchCache();
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("api.firecrawl.dev")) {
        return new Response(
          JSON.stringify({ success: true, data: { markdown: "short", metadata: { title: "Empty" } } }),
          { status: 200 },
        );
      }
      return new Response(fixture("ap-loan.html"), { status: 200, headers: { "content-type": "text/html" } });
    };
    const empty = await fetchArticle("https://apnews.com/article/coastal-loan", fetchImpl, "fc-key");
    expect(empty.via).toBe("direct");
    expect(empty.text).toContain("federal loan");

    clearSearchCache();
    const timingOut: typeof fetch = async (input) => {
      if (String(input).includes("api.firecrawl.dev")) throw new Error("The operation was aborted due to timeout");
      return new Response(fixture("onion-monarch.html"), { status: 200, headers: { "content-type": "text/html" } });
    };
    const timed = await fetchArticle(
      "https://theonion.com/epa-to-monarch-butterflies-count-your-fucking-days/",
      timingOut,
      "fc-key",
    );
    expect(timed.via).toBe("direct");
    expect(timed.byline).toBe("The Onion Staff");
  });

  it("asks the reader to paste the text when both reads fail", async () => {
    clearSearchCache();
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).includes("api.firecrawl.dev")) {
        return new Response("Insufficient credits", { status: 402 });
      }
      return new Response("nope", { status: 503 });
    };
    await expect(
      fetchArticle("https://news.example/story", fetchImpl, "fc-key"),
    ).rejects.toThrow(pageUnreadMessage("en"));
    await expect(
      fetchArticle("https://news.example/story", fetchImpl, "fc-key", undefined, undefined, undefined, "el"),
    ).rejects.toThrow(pageUnreadMessage("el"));
    const calls: string[] = [];
    const recording: typeof fetch = async (input, init) => {
      calls.push(String(input));
      return fetchImpl(input, init);
    };
    try {
      await fetchArticle("https://news.example/story", recording, "fc-key");
      expect.unreachable("both reads should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      const http = error as HttpError;
      expect(http.message).toBe(pageUnreadMessage("en"));
      expect(http.message).not.toMatch(/Firecrawl scrape failed/);
      expect(http.extraction).toBe("direct");
      expect(http.reason).toMatch(/direct fetch failed: HTTP 503/);
      expect(http.reason).toMatch(/scrape HTTP 402/);
      expect(calls.some((url) => url.includes("news.example"))).toBe(true);
    }
  });

  it("tries the page itself after a scrape 402 and records a browser check", async () => {
    clearSearchCache();
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("api.firecrawl.dev")) {
        return new Response(JSON.stringify({ error: "Insufficient credits" }), { status: 402 });
      }
      return new Response(
        `<html><head><title>Just a moment...</title></head><body><p>Just a moment...</p><p>Enable JavaScript and cookies to continue.</p></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      );
    };
    try {
      await fetchArticle("https://apnews.com/article/coast-guard", fetchImpl, "fc-key");
      expect.unreachable("a browser check should fail");
    } catch (error) {
      const http = error as HttpError;
      expect(http.message).toBe(pageUnreadMessage("en"));
      expect(http.message).not.toMatch(/Firecrawl scrape failed/);
      expect(http.extraction).toBe("direct");
      expect(http.reason).toBe("scrape HTTP 402; direct fetch failed: cloudflare challenge");
    }
    expect(calls.filter((url) => url.includes("api.firecrawl.dev"))).toHaveLength(1);
    expect(calls.filter((url) => url.includes("apnews.com"))).toHaveLength(1);
  });
});
