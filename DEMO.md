# Demo pre-flight

Use this before a live meetup. `PIPELINE_VERSION` is **15**. This pass does not change verdicts or the cache version, so a clean `https` URL that was already cached still hits. A URL that was only cached with tracking parameters needs one fresh run of the clean URL.

Nothing below calls search unless the step says **spends credits**.

## 1. Health check (no credits)

```bash
curl -sS https://aletheia.hellenicdev.workers.dev/api/health
```

Do not add `?probe=1`. A probe calls the model and both search providers.

Expect:

- `ok: true`
- `limiter: "durable-object"` and all three `bindings` true
- `pipelineVersion: "15"`
- `model` equal to the configured `OPENAI_MODEL` (`Beam-501B-A23B` in `wrangler.toml`). This is the configured id, not a live model call.
- `searchProvider: "firecrawl-then-tavily"` when both keys are set. Firecrawl is tried first. A rejection, including HTTP 402, falls through to Tavily. `search.note` says the same thing. `search.firecrawl` and `search.tavily` are `configured` or `absent`. No key material is included.

The page chip stays “Live search on”. Hover it for the model and provider chain.

## 2. Static checks (no credits)

- Open https://hellenicdev.eu/aletheia/ and https://hellenicdev.eu/aletheia/el/
- **Sample report** loads a fixture. It does not call the worker.
- Switch EN/EL and confirm the sample, the error area, and the progress label follow the language.

## 3. Pre-warm (spends credits, once per item)

Do this before going on stage, after the worker that will be demoed is deployed. Each first analysis of a new URL or paste searches. A repeat should be well under a second and send `x-aletheia-cache: hit`. Cache hits do not reserve the per-IP limit, the global cap, or Tavily credits.

From the live page is the simplest path. A cache hit is the fast second run of the same article.

Or, once per URL (**spends credits** on a miss):

```bash
curl -sS -D - -o /tmp/aletheia-warm.txt \
  -H 'Origin: https://hellenicdev.eu' \
  -H 'Content-Type: application/json' \
  -X POST https://aletheia.hellenicdev.workers.dev/api/analyze \
  --data '{"url":"https://example.com/the-story","uiLanguage":"en"}'
```

Repeat the same command. The second response header should include `x-aletheia-cache: hit`.

The cache key folds these together, so pre-warm the clean URL and the variants are free:

- `http` and `https`
- a trailing slash
- a fragment (`#…`)
- tracking parameters (`utm_*`, `fbclid`, `gclid`, and the usual ad click ids)
- host case

A real query parameter that is not tracking stays in the key. `www` and the apex host are different keys. Pasted text is cached separately: pipeline version, interface language, and the text with whitespace collapsed. English and Greek explanations are different entries. The durable cache keeps an entry for 24 hours.

## 4. If a limit hits

The page shows a sentence in the current language. It does not show raw JSON. Retry is offered for a timeout, a dropped connection, or a limiter that could not record the request. A 429 tells you how long to wait and does not offer an immediate retry.

| Code | What to do on stage |
| --- | --- |
| `global_busy` | Wait for the time in the message (site-wide cap). |
| `ip_burst`, `ip_daily`, `ip_concurrent` | Wait, or continue from another network. A cache hit does not count. |
| `tavily_daily`, `tavily_monthly` | Search credits for fresh analyses are used up. Wait. Pasting text does not skip this. Use **Sample report**, or an article you already pre-warmed. |
| `limiter_unavailable` (503) | The limit store failed closed. Retry once. If it persists, use **Sample report**. |
| Page could not be read | Paste the article text. That still searches unless the text was pre-warmed in the same interface language. |
| Timeout or “stopped sending updates” | Use **Retry**, or paste the text. |

A run often takes 17–44 seconds. The progress row shows the current stage and an elapsed-time line so a quiet search does not look frozen.

## X mention bot (off)

The cron is deployed and disabled. Leave `X_BOT_ENABLED` as `"false"` for the meetup. While it is false, or while any X secret or `X_BOT_USER_ID` / `X_BOT_HANDLE` is empty, the job makes **no** X API calls.

To turn it on later, after X has approved an AI reply bot in writing:

1. Create the bot account and turn on the Automated account label.
2. In the X developer portal, open the `@hellenicdev` app named `hellenicdev-aletheia`.
3. From the **bot** account, authorise that app with Read and write, and copy that account's access token and secret. Do not use a personal token.
4. Set `X_API_KEY`, `X_API_SECRET`, `X_ACCESS_TOKEN`, and `X_ACCESS_SECRET` as worker secrets. Set `X_BOT_USER_ID` and `X_BOT_HANDLE` as vars.
5. Put a spending limit on the X pay-per-use credits.
6. Keep `X_BOT_DAILY_CAP` at `0` until a cache-only rehearsal looks right. At `0` the bot replies only when the article URL is already in the analysis cache (no search). A higher cap **spends search credits** on misses and shares the site's Tavily daily and monthly limits.
7. Set `X_BOT_ENABLED` to `"true"`.

`stop` or `σταμάτα` adds that account to the denylist and confirms once. A mention with no article link gets no reply. The full report link is `https://hellenicdev.eu/aletheia/?url=` (or `/el/?url=`). If that URL is not cached, the page only prefills it.

## 5. Fallback that spends nothing

**Sample report** is the safe last resort. It is fixture data, labelled as such, and needs no API.
