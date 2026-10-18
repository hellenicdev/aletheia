# Aletheia

Aletheia is a claim-level news credibility desk. Paste an article or give it a URL. It splits the piece into sentences and claims, labels each one, and explains the label. Checkable claims are compared with live web search results. The page then shows a 0–100 credibility score, four sub-scores, and one sentence on why the article holds up or does not.

Labels: **True**, **False**, **Misleading**, **Unverifiable**, **Opinion**, **Rhetorical / emotional language**.

The interface is English and Greek. A language toggle translates the whole UI, and explanations come back in the language you selected. The article language is detected separately, so a Greek article can be explained in English and the reverse.

It does not invent sources. A URL is cited only when that page was returned by search for that claim. If the evidence is thin, the claim stays **Unverifiable**.

## Pipeline

1. **Extract.** A URL is sent to [Firecrawl](https://firecrawl.dev) scrape with markdown output and main content only. The title, source domain, and date come from the scrape metadata when the page exposes them. Pasted text is used as-is. A short first line followed by a blank line is treated as the title. If `FIRECRAWL_API_KEY` is missing, the worker reads a public HTML page directly and says so.
2. **Segment and classify.** The model splits the body into exact substrings and marks each as checkable, mixed, opinion, or rhetorical. Offsets are checked against the article. If the model’s excerpts do not line up, Aletheia falls back to a deterministic sentence split.
3. **Retrieve evidence.** Checkable claims get a short search query. Firecrawl’s search endpoint returns the pages. At most 12 searches run per article. A fresh isolate starts with two Firecrawl calls, then spaces the rest at about 10 a minute, and a 429 is retried once using `Retry-After` (capped so the deadline still wins). That limiter lives in the isolate: a limit shared across isolates would need a Durable Object or KV binding, which this worker does not add. Successful searches, scrapes, and per-claim verification results are cached for 24 hours, and that cache is what carries over between requests. Claim selection is sorted by a stable key so the same article checks the same sentences. Every outbound call — Firecrawl search and scrape, model calls, retries, and Cache API reads and writes — shares one counter capped at 32, under the free-plan limit of 50. A redirected response counts one extra hop, because the platform does not report how many redirects it followed. A direct page fetch, used when the Firecrawl scrape fails, counts the same way: one request plus each redirect hop. Keepalive comments are not fetches. Model calls are reserved first. The remaining budget is spent on the most important claims. A retry is skipped when that budget is low. When it runs out, evidence gathering stops and the run finishes with whatever is already in hand. A Firecrawl 402, 401, 429, or 5xx stops further searches for that request and does not wait out later search or consistency timeouts. The result then carries `searchStatus` (`ok`, `partial`, or `unavailable`, with a reason such as `out_of_credits`). If no claim was checked against evidence, the score is provisional: the gauge is grey, factual accuracy and sourcing are empty, and the page says live search is unavailable.
4. **Verify.** The model judges the core claim against the retrieved snippets and the surrounding paragraph. The reply is validated and retried. Citations that were not in the search results are dropped. A firm label needs an independent source: not the article itself, the same newsroom on another country domain, a wire reprint, an AOL copy, a social repost, or a low-credibility page. Evidence about a different person, plant, or event cannot make a claim False. A value judgement is labelled Opinion and is not scored as True. When search returns nothing, only a stable, well-known fact may keep a low-confidence model label. If search or the model call fails, the claim stays unverified and the result says the check failed.
5. **Score.** The gauge is computed in code from the labels, not by asking the model for a number. A second model call looks only for contradictions where both sentences are about the same entity at the same time and cannot both be true. It has to quote both sentences. Unknown ids, and pairs the model is unsure about, are ignored.

If `FIRECRAWL_API_KEY` is not set, search is skipped. Factual labels are marked **model knowledge only**, recent or numeric claims are left Unverifiable, no URLs are attached, and the score is capped at 68. URL fetches fall back to a direct HTML read.

## Score

Weights in `shared/score.ts`:

| Part | Weight |
| --- | --- |
| Factual accuracy | 58% |
| Sourcing | 16% |
| Tone / neutrality | 12% |
| Logical consistency | 14% |

True counts as 100, Misleading as 35, False as 0, weighted by confidence. Coverage is the share of the claims that were actually selected for verification, not every sentence in the article. Selected claims that stay unverified pull factual accuracy toward 50, and coverage under 25% caps the overall score at 70. Claims that were not checked because the budget, the deadline, or an error stopped the run are labelled Unverifiable and left out of that ratio, so a short run does not punish the claims that were checked. The result is marked degraded and the verdict says how many of the selected claims could be verified. Each False claim subtracts 14 and each Misleading claim subtracts 6, up to 36 points. One confirmed contradiction lowers logical consistency by 15 points, and further contradictions cannot lower it by more than 30. When none are confirmed, logical consistency stays at 100. A piece that is only opinion or rhetoric is capped at 64. A column with a large share of the author's own evaluations is described as mostly opinion and capped at 65, with less weight on sourcing and consistency. Quoted testimony does not count as the author's opinion. Pasted text has no outlet, so the verdict says the score is not a reputation judgement.

## Layout

```
index.html              static site entry
src/                    dashboard (Vite + TypeScript)
src/config.ts           backend URL — edit this before a Pages build
shared/                 scoring, citations, highlighting, JSON parsing
backend/                Cloudflare Worker
.github/workflows/      tests and GitHub Pages
```

The Worker calls an OpenAI-compatible chat API. `OPENAI_BASE_URL` defaults to `https://api.reflection.ai/openai/v1` and `OPENAI_MODEL` defaults to `Beam-501B-A23B` when unset. The key is the `OPENAI_API_KEY` secret.

## Run it locally

You need Node.js 20 or newer.

```bash
npm install
npm install --prefix backend
```

Frontend, from the repo root:

```bash
npm run dev
```

Open `http://localhost:5173`. **Sample report** loads a fixture analysis with no API keys, so you can see the desk before the worker is configured.

Worker, from `backend/`:

```bash
cp .dev.vars.example .dev.vars
# put real keys in .dev.vars — that file is gitignored
npx wrangler dev
```

`src/config.ts` already points at `http://127.0.0.1:8787`.

## Secrets

From `backend/`, log in once with `npx wrangler login`, then:

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put FIRECRAWL_API_KEY
```

| Name | Required | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | yes | Bearer token for the chat completions API |
| `FIRECRAWL_API_KEY` | no | Firecrawl key for search and for scraping article URLs |

Never commit either key. Do not put them in `wrangler.toml` or in the frontend.

## Worker variables

Set in `backend/wrangler.toml`. Change them there, or override per environment in the Cloudflare dashboard.

| Variable | Default |
| --- | --- |
| `OPENAI_BASE_URL` | `https://api.reflection.ai/openai/v1` |
| `OPENAI_MODEL` | `Beam-501B-A23B` |
| `ALLOWED_ORIGINS` | `https://hellenicdev.eu`, `https://hellenicdev.github.io`, plus localhost ports used in development |
| `RATE_LIMIT_PER_IP` | `30` |
| `RATE_LIMIT_WINDOW_SEC` | `600` |

Deploy:

```bash
cd backend
npx wrangler deploy
```

The command prints the worker URL, something like `https://aletheia.<account>.workers.dev`.

## Point the site at the worker

`src/config.ts` is the only place the static site learns the worker URL. It is set to the deployed worker:

```ts
export const BACKEND_URL = "https://aletheia.hellenicdev.workers.dev";
```

For local `wrangler dev`, change that one line to `http://127.0.0.1:8787` and rebuild. The Pages workflow does not inject this value.

## GitHub Pages

The site is a static Vite build. It is served at `https://hellenicdev.eu/aletheia/` and at `https://hellenicdev.github.io/aletheia/`. Both paths use the same base, so the workflow sets `PAGES_BASE=/aletheia/`. Asset URLs in the built `index.html` start with `/aletheia/`.

1. On GitHub, open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Merge to `main`. `.github/workflows/pages.yml` builds `dist/` and deploys it.

The browser origins are `https://hellenicdev.eu` and `https://hellenicdev.github.io` (no path). Both are on the worker’s allow list. Add any other origin to `ALLOWED_ORIGINS` before you use it. Requests with a different `Origin` header are rejected. `http://localhost:5173` and `http://127.0.0.1:5173` stay allowed for local development.

If the repository name changes, update `PAGES_BASE` in the workflow to `/<repo>/`.

## Diagnosing a live worker

`GET /api/health` reports whether the secrets are present. It does not call the providers.

`GET /api/health?probe=1` makes one chat completion and one Firecrawl search (`eiffel tower`, limit 1). The chat budget is 4096 tokens because Beam spends tokens on reasoning before the answer. `probe.llm` is `{ ok, status }` plus `finishReason`, `field`, and a `preview` of the first 300 characters of the raw model text (secrets removed). `field` is where that text lived (`content`, `reasoning_content`, `thinking`, `reasoning`, or `refusal`). Analysis calls use the same parser with an 8192-token budget sent as `max_completion_tokens`. `probe.search` is `{ ok, status }` or `{ ok: false, status, error }`. Failures are also written with `console.error` for `wrangler tail`. Probes are limited to 10 per IP per window.

A finished analysis also puts those lines on `meta.warnings` when a model or search call fails and the audit continues without it. Opinion and rhetorical sentences are not relabelled Unverifiable because search failed.

`OPENAI_MODEL` is sent as configured. The default in `wrangler.toml` is `Beam-501B-A23B`. Reflection's chat docs currently show `Beam-1.0-501B-A23B`. If the probe's llm error is HTTP 400, the body says whether that id was rejected.

## Limits

- Article text: 40 to 12,000 characters.
- Request body: 80 KB.
- Article URLs: public `http`/`https` only. Local, private, and link-local addresses are refused before anything is sent to Firecrawl. The direct fallback, used only when the Firecrawl key is absent, reads at most 1 MB of HTML and follows four redirects.
- 20 claims audited per article, 8 live searches, 4 analyses in flight on a worker isolate.
- 30 analyses per IP per 10 minutes. The counter lives in the isolate, so it resets when the isolate recycles. It is a basic guard, not a global quota.

## Tests

```bash
npm test
npm run typecheck
npm test --prefix backend
npm run typecheck --prefix backend
```

Frontend tests cover scoring inputs via the sample report, highlighting, and the English/Greek string table. Worker tests cover extraction, Firecrawl search and scrape parsing, SSRF checks, rate limiting, JSON retries, citation filtering, and a full analysis with the model and Firecrawl HTTP calls mocked. No live API key is required.

## How a live score behaves

Extraction prefers the article body (AP, WordPress, the Onion, BBC, the Guardian, Kathimerini, and ERT) over a longer menu-heavy markdown dump, then strips menus, cookie and newsletter banners, tag-manager copy, datelines, photo credits, reference lists, and repeated lines before the 12,000-character cap. If the Firecrawl scrape fails or comes back empty, the worker fetches the URL itself with a browser User-Agent, follows redirects, and extracts the article from the HTML. When that also fails, the reader is asked to paste the article text. The result records whether the text came from Firecrawl or that direct fetch. The page shows that text while the audit runs. Sentences are split in code. Fragments under about 25 characters, and other boilerplate, are left out of the score. The model only classifies the remaining sentences, and up to 12 searches go to the most specific claims. Coverage is measured on those selected claims. Coverage under 25% caps the overall score at 70. Each Firecrawl scrape and search, including the opening page fetch and any wait for the rate limiter, carries an abort timeout. A keepalive interval and a deadline, both armed before the page is fetched, race the whole pipeline: at about 140 seconds the stream always sends a partial result or an error and then closes, even if a fetch never returns. The segmentation call has its own 45-second abort timeout. A True label needs a source that is not the article itself, another edition of the same newsroom (`bbc.co.uk` for `bbc.com`), a wire reprint (including `/ap/` and `wireStory` paths, ClickOnDetroit, Manistee News, and `aol.*`), a social repost, or a low-credibility host such as Substack or the satire and misinformation list. Known satire and low-credibility domains cap the score under 50. Substack is excluded as evidence and does not by itself cap a score. Loaded language, in English and Greek, lowers the tone score, and a rhetorical label lowers it further. Opinion and value judgements are not fact-checked as True. A column is detected from the URL, from article categories such as Απόψεις or Δημόσιο Βήμα (not the site menu), and from section labels (`opinion`, `comment`, `apopseis`, `gnomes`, `Άποψη`, `Σχόλιο`). A piece that is mostly the author's opinion says so and is capped at 65, below straight news. Reported quotes stay checkable claims. Wire copies are recognised from an AP, Reuters, or AFP credit in the byline or body when the page is not that wire’s own site, and from a title or snippet that overlaps the article title or lede, including a shorter headline with no byline, not only from a list of hosts. Episode, promo, and navigation lines, including show titles such as Decentralize.TV, are removed before claims are extracted. Short link-title lines and anything after an end-of-article marker are left out of the text. After verification, the consistency call has its own timeout; if it hangs, the score is still sent. Model calls use temperature 0 and a fixed seed, and drop either field if the API rejects it.

## Honesty limits

Search snippets are short. A supported label means those snippets agree with the claim, not that every fact in the world was checked. Opinion and rhetorical passages are not “false”; they are not factual claims. When search is off, treat every factual label as unverified model knowledge.
