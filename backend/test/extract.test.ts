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
