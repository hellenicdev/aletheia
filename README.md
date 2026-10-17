# Aletheia

Aletheia is a claim-level news credibility desk. Paste an article or give it a URL. It splits the piece into sentences and claims, labels each one, and explains the label. Checkable claims are compared with live web search results. The page then shows a 0–100 credibility score, four sub-scores, and one sentence on why the article holds up or does not.

Labels: **True**, **False**, **Misleading**, **Unverifiable**, **Opinion**, **Rhetorical / emotional language**.

The interface is English and Greek. A language toggle translates the whole UI, and explanations come back in the language you selected. The article language is detected separately, so a Greek article can be explained in English and the reverse.

It does not invent sources. A URL is cited only when that page was returned by search for that claim. If the evidence is thin, the claim stays **Unverifiable**.

## Pipeline

1. **Extract.** A URL is sent to [Firecrawl](https://firecrawl.dev) scrape with markdown output and main content only. The title, source domain, and date come from the scrape metadata when the page exposes them. Pasted text is used as-is. A short first line followed by a blank line is treated as the title. If `FIRECRAWL_API_KEY` is missing, the worker reads a public HTML page directly and says so.
2. **Segment and classify.** The model splits the body into exact substrings and marks each as checkable, mixed, opinion, or rhetorical. Offsets are checked against the article. If the model’s excerpts do not line up, Aletheia falls back to a deterministic sentence split.
3. **Retrieve evidence.** Checkable claims get a short search query. Firecrawl’s search endpoint returns the pages. At most 12 searches run per article. A fresh isolate starts with two Firecrawl calls, then spaces the rest at about 10 a minute, and a 429 is retried once using `Retry-After` (capped so the deadline still wins). That limiter lives in the isolate: a limit shared across isolates would need a Durable Object or KV binding, which this worker does not add. Successful searches and scrapes are cached for 24 hours, and that cache is what carries over between requests. The worker also stops searching before it spends the Cloudflare subrequest budget, so the model call can still run.
4. **Verify.** The model judges the core claim against the retrieved snippets and the surrounding paragraph. The reply is validated and retried. Citations that were not in the search results are dropped. A firm label needs an independent source: not the article itself, the same newsroom on another country domain, a wire reprint, an AOL copy, a social repost, or a low-credibility page. Evidence about a different person, plant, or event cannot make a claim False. A value judgement is labelled Opinion and is not scored as True. When search returns nothing, only a stable, well-known fact may keep a low-confidence model label. If search or the model call fails, the claim stays unverified and the result says the check failed.
5. **Score.** The gauge is computed in code from the labels, not by asking the model for a number. A second model call only looks for direct contradictions, and unknown claim ids are ignored.

If `FIRECRAWL_API_KEY` is not set, search is skipped. Factual labels are marked **model knowledge only**, recent or numeric claims are left Unverifiable, no URLs are attached, and the score is capped at 68. URL fetches fall back to a direct HTML read.

## Score

Weights in `shared/score.ts`:

| Part | Weight |
| --- | --- |
| Factual accuracy | 58% |
| Sourcing | 16% |
| Tone / neutrality | 12% |
| Logical consistency | 14% |

True counts as 100, Misleading as 35, False as 0, weighted by confidence. Coverage is the share of the claims that were actually selected for verification, not every sentence in the article. Selected claims that stay unverified pull factual accuracy toward 50, and coverage under 25% caps the overall score at 70. Each False claim subtracts 14 and each Misleading claim subtracts 6, up to 36 points. A direct contradiction subtracts 30 from logical consistency. A piece that is only opinion or rhetoric is capped at 64. A column with a large share of opinion passages is described as mostly opinion and capped at 74, with less weight on sourcing and consistency.

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

Extraction prefers the article body (AP, WordPress, the Onion, BBC, the Guardian, Kathimerini, and ERT) over a longer menu-heavy markdown dump, then strips menus, cookie and newsletter banners, tag-manager copy, datelines, photo credits, reference lists, and repeated lines before the 12,000-character cap. The page shows that text while the audit runs. Sentences are split in code. Fragments under about 25 characters, and other boilerplate, are left out of the score. The model only classifies the remaining sentences, and up to 12 searches go to the most specific claims. Coverage is measured on those selected claims. Coverage under 25% caps the overall score at 70. Each call has its own timeout, the whole audit stops around 140 seconds, and the stream keeps sending keepalives so a slow evidence stage still finishes with a partial result. A True label needs a source that is not the article itself, another edition of the same newsroom (`bbc.co.uk` for `bbc.com`), a wire reprint (including `/ap/` and `wireStory` paths, ClickOnDetroit, Manistee News, and `aol.*`), a social repost, or a low-credibility host such as Substack or the satire and misinformation list. Known satire and low-credibility domains cap the score under 50. Substack is excluded as evidence and does not by itself cap a score. Loaded language, in English and Greek, lowers the tone score, and a rhetorical label lowers it further. Opinion and value judgements are not fact-checked as True. A column is detected from the URL or section (`opinion`, `comment`, `apopseis`, `gnomes`, `απόψεις`, `Δημόσιο Βήμα`) and from a high share of first-person or evaluative sentences. A piece that is mostly opinion says so and is scored apart from straight news, with a cap of 74.

## Honesty limits

Search snippets are short. A supported label means those snippets agree with the claim, not that every fact in the world was checked. Opinion and rhetorical passages are not “false”; they are not factual claims. When search is off, treat every factual label as unverified model knowledge.
