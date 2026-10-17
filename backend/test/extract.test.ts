import { describe, expect, it } from "vitest";
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
});

describe("fetchArticle", () => {
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
});
