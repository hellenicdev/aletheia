import { describe, expect, it } from "vitest";
import { LABELS } from "../../shared/labels";
import type { AnalysisResult } from "../../shared/types";
import { handleRequest } from "../src/index";
import { TavilyCredits } from "../src/rateLimiter";
import { runXBot, xBotReady, type XBotDeps } from "../src/xBot";
import { articleLink, commandText, indexIncludes, isStart, isStop, type MentionPage, type XPost } from "../src/xMentions";
import { oauth1Header, signatureBaseString } from "../src/xOauth";
import { clipMentionText, formatMentionReply, optOutFooter, reportUrl, stopReply, weightedLength } from "../src/xReply";
import { emptyXBot } from "../src/xState";
import type { Env } from "../src/config";
import type { AnalysisCache } from "../src/analysisCache";

const ready: Env = {
  X_BOT_ENABLED: "true",
  X_API_KEY: "ck",
  X_API_SECRET: "cs",
  X_ACCESS_TOKEN: "tk",
  X_ACCESS_SECRET: "ts",
  X_BOT_USER_ID: "42",
  X_BOT_HANDLE: "aletheia",
  X_BOT_DAILY_CAP: "0",
  X_BOT_PER_USER_DAILY: "3",
  X_BOT_MAX_REPLIES_DAILY: "30",
  OPENAI_API_KEY: "openai",
  TAVILY_API_KEY: "tavily",
};

function report(overall = 62): AnalysisResult {
  const counts = Object.fromEntries(LABELS.map((label) => [label, 0])) as AnalysisResult["score"]["counts"];
  counts.True = 5;
  counts.False = 1;
  counts.Opinion = 2;
  return {
    score: { overall, counts, verdict: "ok", factualAccuracy: 70, factualBasis: "measured", sourcing: 60, toneNeutrality: 80, logicalConsistency: 90 },
    segments: [],
    degraded: false,
    provisional: false,
    meta: { searchStatus: { state: "ok", reason: null, provider: "tavily" } },
  } as AnalysisResult;
}

function mention(partial: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "100",
    author_id: "7",
    conversation_id: "100",
    lang: "en",
    text: "@aletheia check this",
    ...partial,
  };
}

describe("oauth1", () => {
  it("builds a stable HMAC-SHA1 header and leaves the secrets out of it", async () => {
    const material = {
      method: "POST",
      url: "https://api.x.com/2/tweets",
      consumerKey: "consumer-key",
      consumerSecret: "consumer-secret",
      token: "access-token",
      tokenSecret: "access-secret",
      nonce: "fixed-nonce",
      timestamp: "1700000000",
    };
    const base = signatureBaseString(material, material.nonce, material.timestamp);
    expect(base.startsWith("POST&https%3A%2F%2Fapi.x.com%2F2%2Ftweets&")).toBe(true);
    expect(base).toContain("oauth_signature_method%3DHMAC-SHA1");
    const header = await oauth1Header(material);
    expect(header).toBe(await oauth1Header(material));
    expect(header).toContain('oauth_signature_method="HMAC-SHA1"');
    expect(header).not.toContain("consumer-secret");
    expect(header).not.toContain("access-secret");
    const other = await oauth1Header({ ...material, tokenSecret: "other-secret" });
    expect(other).not.toBe(header);
  });
});

describe("mention links", () => {
  it("reads expanded urls and quoted posts from either include list", () => {
    const page: MentionPage = {
      data: [
        mention({
          id: "5",
          entities: { urls: [{ url: "https://t.co/abc", expanded_url: "https://www.reuters.com/world/story" }] },
        }) as MentionPage["data"] extends (infer T)[] | undefined ? T : never,
      ],
    };
    const post = page.data?.[0];
    expect(post && articleLink(post, new Map())).toBe("https://www.reuters.com/world/story");

    const quoted = {
      id: "9",
      text: "@aletheia",
      referenced_posts: [{ type: "quoted", id: "8" }],
    };
    const included = indexIncludes({
      includes: { posts: [{ id: "8", entities: { urls: [{ unwound_url: "https://apnews.com/article/harbour" }] } }] },
    });
    expect(articleLink(quoted, included)).toBe("https://apnews.com/article/harbour");
    expect(articleLink({ id: "1", text: "@aletheia", entities: { urls: [{ expanded_url: "https://x.com/someone/status/1" }] } }, new Map())).toBeNull();
    expect(articleLink({ id: "2", text: "@aletheia", entities: { urls: [{ expanded_url: "https://hellenicdev.eu/aletheia/" }] } }, new Map())).toBeNull();
  });
});

describe("reply length", () => {
  it("stays within 280 weighted characters in both languages", () => {
    const worst = report(100);
    for (const label of LABELS) worst.score.counts[label] = 99;
    worst.degraded = true;
    worst.provisional = true;
    worst.meta.searchStatus = { state: "partial", reason: "failed", provider: "tavily" };
    const longUrl = `https://www.example.com/${"a".repeat(180)}?q=${"b".repeat(80)}`;
    for (const lang of ["en", "el"] as const) {
      const text = formatMentionReply(worst, longUrl, lang);
      const link = reportUrl(longUrl, lang);
      expect(weightedLength(text)).toBeLessThanOrEqual(280);
      expect(text).toContain(link);
      expect(text.endsWith(optOutFooter(lang))).toBe(true);
      expect(text).toContain("100/100");
    }
    expect(weightedLength(`see ${longUrl}`)).toBeLessThan(40);
  });

  it("truncates the summary and keeps the footer and report link", () => {
    const longUrl = `https://www.example.com/${"a".repeat(180)}?q=${"b".repeat(80)}`;
    const link = reportUrl(longUrl, "en");
    const footer = optOutFooter("en");
    const tail = `Full report: ${link}\n${footer}`;
    const summary = `Aletheia: 100/100, Mostly reliable. ${"9 true, ".repeat(80)}`;
    const text = clipMentionText(summary, tail);
    expect(weightedLength(text)).toBeLessThanOrEqual(280);
    expect(text.endsWith(footer)).toBe(true);
    expect(text).toContain(link);
    expect(text).toContain("100/100");
    expect(text.length).toBeLessThan(summary.length);
    expect(weightedLength(stopReply("en"))).toBeLessThanOrEqual(280);
    expect(weightedLength(stopReply("el"))).toBeLessThanOrEqual(280);
  });
});

describe("x mention bot", () => {
  it("makes no X calls when disabled or incomplete", async () => {
    const fetchImpl = async () => {
      throw new Error("x called");
    };
    expect(xBotReady({ ...ready, X_BOT_ENABLED: "false" })).toBe(false);
    await expect(runXBot({ ...ready, X_BOT_ENABLED: "false" }, { fetchImpl })).resolves.toBeNull();
    await expect(runXBot({ ...ready, X_API_SECRET: "" }, { fetchImpl })).resolves.toBeNull();
  });

  it("replies from the cache without a fresh analysis when the daily cap is 0", async () => {
    const calls: string[] = [];
    const state = emptyXBot(Date.UTC(2026, 9, 22));
    const langs: string[] = [];
    const cache: AnalysisCache = {
      async get(_url, language) {
        langs.push(language ?? "en");
        return report();
      },
      async put() {
        throw new Error("cache write");
      },
    };
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.includes("/mentions")) {
        return Response.json({
          data: [mention({ entities: { urls: [{ expanded_url: "https://www.reuters.com/world/story" }] } })],
        });
      }
      const body = JSON.parse(String(init?.body)) as { text: string; reply: { in_reply_to_tweet_id: string } };
      expect(body.reply.in_reply_to_tweet_id).toBe("100");
      expect(body.text).toContain("62/100");
      expect(body.text).toContain("5 true");
      expect(body.text.endsWith(optOutFooter("en"))).toBe(true);
      expect(weightedLength(body.text)).toBeLessThanOrEqual(280);
      return Response.json({ data: { id: "200" } });
    };
    const next = await runXBot(ready, { fetchImpl, cache, state, now: () => Date.UTC(2026, 9, 22), analyze: async () => { throw new Error("analyzed"); } });
    expect(calls.some((call) => call.includes("expansions=referenced_tweets.id"))).toBe(true);
    expect(calls.some((call) => call.startsWith("POST"))).toBe(true);
    expect(langs).toEqual(["en"]);
    expect(next?.replied).toContain("100");
    expect(next?.fresh).toBe(0);
  });

  it("stays silent on a cache miss when the fresh cap is 0", async () => {
    const posts: string[] = [];
    const state = emptyXBot(1);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "POST") posts.push(url);
      return Response.json({ data: [mention({ entities: { urls: [{ expanded_url: "https://apnews.com/a" }] } })] });
    };
    const cache: AnalysisCache = { async get() { return null; }, async put() {} };
    const next = await runXBot(ready, { fetchImpl, cache, state, now: () => 1, analyze: async () => { throw new Error("analyzed"); } });
    expect(posts).toEqual([]);
    expect(next?.replied).toContain("100");
  });

  it("reserves a fresh analysis on the shared gate as x:<author>", async () => {
    const reserved: string[] = [];
    let analyzed = 0;
    const state = emptyXBot(1);
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "POST") return Response.json({ data: { id: "9" } });
      return Response.json({
        data: [mention({ lang: "el", text: "@aletheia δες", entities: { urls: [{ expanded_url: "https://www.kathimerini.gr/politics/story" }] } })],
      });
    };
    const deps: XBotDeps = {
      fetchImpl,
      state,
      now: () => 1,
      cache: { async get() { return null; }, async put() {} },
      analyze: async (input) => {
        analyzed += 1;
        expect(input.uiLanguage).toBe("el");
        return report(40);
      },
      gate: {
        async reserve(input) {
          reserved.push(input.ip);
          return { ok: true, code: "ok", retryAfter: 0 };
        },
        async release() {},
      },
    };
    const next = await runXBot({ ...ready, X_BOT_DAILY_CAP: "2" }, deps);
    expect(analyzed).toBe(1);
    expect(reserved).toEqual(["x:7"]);
    expect(next?.fresh).toBe(1);
    const reply = formatMentionReply(report(40), "https://www.kathimerini.gr/politics/story", "el");
    expect(reply).toContain("/aletheia/el/?url=");
  });

  it("confirms stop once and then ignores that author", async () => {
    const texts: string[] = [];
    const targets: string[] = [];
    const state = emptyXBot(1);
    const optOut: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body)) as { text: string; reply: { in_reply_to_tweet_id: string } };
        texts.push(body.text);
        targets.push(body.reply.in_reply_to_tweet_id);
        return Response.json({ data: { id: "1" } });
      }
      return Response.json({
        data: [
          mention({ id: "4", text: "@aletheia https://apnews.com/again", entities: { urls: [{ expanded_url: "https://apnews.com/again" }] } }),
          mention({ id: "5", lang: "el", text: "@aletheia σταμάτα" }),
          mention({ id: "3", lang: "el", text: "@aletheia σταμάτα" }),
        ],
      });
    };
    const next = await runXBot(ready, {
      fetchImpl,
      state,
      optOut,
      now: () => 1,
      cache: { async get() { throw new Error("cache"); }, async put() { throw new Error("put"); } },
      analyze: async () => { throw new Error("analyzed"); },
    });
    expect(texts).toEqual([stopReply("el")]);
    expect(targets).toEqual(["3"]);
    expect(optOut).toEqual(["7"]);
    expect(next?.denylist).toEqual([]);
    expect(next?.fresh).toBe(0);
    expect(next?.replies).toBe(1);
  });

  it("skips an opted-out author before analysis, replies, credits, and caps", async () => {
    const optOut = ["7"];
    const state = emptyXBot(1);
    let posts = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET") === "POST") posts += 1;
      return Response.json({
        data: [mention({ id: "50", text: "@aletheia check https://apnews.com/a", entities: { urls: [{ expanded_url: "https://apnews.com/a" }] } })],
      });
    };
    const next = await runXBot({ ...ready, X_BOT_DAILY_CAP: "5" }, {
      fetchImpl,
      state,
      optOut,
      now: () => 1,
      cache: { async get() { throw new Error("cache"); }, async put() { throw new Error("put"); } },
      analyze: async () => { throw new Error("analyzed"); },
      gate: {
        async reserve() { throw new Error("reserve"); },
        async release() { throw new Error("release"); },
      },
    });
    expect(posts).toBe(0);
    expect(optOut).toEqual(["7"]);
    expect(next?.fresh).toBe(0);
    expect(next?.replies).toBe(0);
    expect(next?.users).toEqual({});
    expect(next?.replied).toContain("50");
  });

  it("drops the opt-out when the author replies start", async () => {
    const optOut = ["7"];
    const state = { ...emptyXBot(1), denylist: ["7"] };
    const replies: string[] = [];
    let analyzed = 0;
    let reserved = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        replies.push((JSON.parse(String(init?.body)) as { reply: { in_reply_to_tweet_id: string } }).reply.in_reply_to_tweet_id);
        return Response.json({ data: { id: "1" } });
      }
      return Response.json({
        data: [
          mention({ id: "62", text: "@aletheia https://apnews.com/back", entities: { urls: [{ expanded_url: "https://apnews.com/back" }] } }),
          mention({ id: "61", text: "@aletheia   start  " }),
        ],
      });
    };
    const next = await runXBot({ ...ready, X_BOT_DAILY_CAP: "2" }, {
      fetchImpl,
      state,
      optOut,
      now: () => 1,
      cache: { async get() { return null; }, async put() {} },
      analyze: async () => {
        analyzed += 1;
        return report();
      },
      gate: {
        async reserve() {
          reserved += 1;
          return { ok: true, code: "ok", retryAfter: 0 };
        },
        async release() {},
      },
    });
    expect(optOut).toEqual([]);
    expect(next?.denylist).toEqual([]);
    expect(analyzed).toBe(1);
    expect(reserved).toBe(1);
    expect(replies).toEqual(["62"]);
    expect(next?.fresh).toBe(1);
  });

  it("records stop without sending when the daily reply cap is spent", async () => {
    const optOut: string[] = [];
    const state = { ...emptyXBot(1), replies: 30 };
    let posts = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET") === "POST") posts += 1;
      return Response.json({ data: [mention({ id: "70", text: "@aletheia stop https://apnews.com/a", entities: { urls: [{ expanded_url: "https://apnews.com/a" }] } })] });
    };
    const next = await runXBot(ready, {
      fetchImpl,
      state,
      optOut,
      now: () => 1,
      cache: { async get() { throw new Error("cache"); }, async put() { throw new Error("put"); } },
      analyze: async () => { throw new Error("analyzed"); },
    });
    expect(posts).toBe(0);
    expect(optOut).toEqual(["7"]);
    expect(next?.replies).toBe(30);
    expect(next?.fresh).toBe(0);
  });

  it("sends nothing when the bot is disabled", async () => {
    let calls = 0;
    const optOut = ["7"];
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      throw new Error("x called");
    };
    const state = emptyXBot(1);
    const next = await runXBot({ ...ready, X_BOT_ENABLED: "false" }, { fetchImpl, optOut, state });
    expect(next).toBe(state);
    expect(calls).toBe(0);
    expect(optOut).toEqual(["7"]);
  });

  it("does not reply to itself, a retweet, a post without the handle, or a repeated url", async () => {
    const replies: string[] = [];
    const state = emptyXBot(1);
    const fetchImpl: typeof fetch = async (_input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        replies.push(JSON.parse(String(init?.body)).reply.in_reply_to_tweet_id as string);
        return Response.json({ data: { id: "1" } });
      }
      return Response.json({
        data: [
          mention({ id: "15", conversation_id: "c", entities: { urls: [{ expanded_url: "https://apnews.com/same?utm_source=x" }] } }),
          mention({ id: "14", conversation_id: "c", entities: { urls: [{ expanded_url: "https://apnews.com/same" }] } }),
          mention({ id: "13", text: "no mention https://apnews.com/x", entities: { urls: [{ expanded_url: "https://apnews.com/x" }] } }),
          mention({ id: "12", referenced_tweets: [{ type: "retweeted", id: "1" }] }),
          mention({ id: "11", author_id: "42" }),
        ],
      });
    };
    const next = await runXBot(ready, {
      fetchImpl,
      state,
      now: () => 1,
      cache: { async get() { return report(); }, async put() {} },
    });
    expect(replies).toEqual(["14"]);
    expect(next?.replied).toEqual(expect.arrayContaining(["11", "12", "13", "14", "15"]));
  });

  it("holds since_id when mentions are rate limited", async () => {
    const state = { ...emptyXBot(1), sinceId: "50" };
    const fetchImpl: typeof fetch = async () =>
      new Response("{}", { status: 429, headers: { "x-rate-limit-reset": "200" } });
    const next = await runXBot(ready, { fetchImpl, state, now: () => 1 });
    expect(next?.sinceId).toBe("50");
    expect(next?.rateLimitUntil).toBe(200_000);
  });
});

describe("cached lookup", () => {
  it("returns a stored result and does not call the network or the limiter", async () => {
    let fetches = 0;
    const response = await handleRequest(
      new Request("https://worker.test/api/cached?url=https://www.reuters.com/world/story&lang=el"),
      { OPENAI_API_KEY: "k" },
      {
        fetchImpl: async () => {
          fetches += 1;
          return new Response("no");
        },
        analysisCache: {
          async get(url, language) {
            expect(url).toContain("reuters.com");
            expect(language).toBe("el");
            return report();
          },
          async put() {
            throw new Error("put");
          },
        },
      },
    );
    expect(fetches).toBe(0);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { cached: boolean };
    expect(body.cached).toBe(true);
  });

  it("reports a miss without starting an analysis", async () => {
    const response = await handleRequest(
      new Request("https://worker.test/api/cached?url=https://apnews.com/missing"),
      { OPENAI_API_KEY: "k" },
      { analysisCache: { async get() { return null; }, async put() {} } },
    );
    expect(await response.json()).toEqual({ cached: false });
  });
});

describe("opt-out commands", () => {
  it("matches stop, unsubscribe, and σταμάτα only after mentions, urls, and whitespace are gone", () => {
    const post = (text: string): XPost => mention({ text }) as XPost;
    expect(commandText(post("@Aletheia  STOP  https://t.co/abc"))).toBe("stop");
    expect(isStop(post("@someone @aletheia unsubscribe"))).toBe(true);
    expect(isStop(post("@aletheia\nΣταμάτα"))).toBe(true);
    expect(isStop(post("@aletheia please stop"))).toBe(false);
    expect(isStop(post("@aletheia stopping by https://apnews.com/a"))).toBe(false);
    expect(isStart(post("@aletheia start"))).toBe(true);
    expect(isStart(post("@aletheia start now"))).toBe(false);
  });
});

describe("xbot durable object key", () => {
  it("stores the cursor beside the credit book", async () => {
    const map = new Map<string, unknown>();
    const kv = {
      get<T>(key: string) { return map.get(key) as T | undefined; },
      put<T>(key: string, value: T) { map.set(key, value); },
      delete(key: string) { map.delete(key); return true; },
    };
    const credits = new TavilyCredits({
      storage: {
        kv,
        transactionSync<T>(run: () => T) { return run(); },
        async get<T>(key: string) { return kv.get<T>(key); },
        async put<T>(key: string, value: T) { kv.put(key, value); },
        async delete(key: string) { return kv.delete(key); },
        async transaction<T>(run: (txn: unknown) => Promise<T>) { return run(this); },
      },
    });
    const state = { ...emptyXBot(1), sinceId: "77" };
    const saved = await credits.fetch(new Request("https://credits.internal/xbot", { method: "POST", body: JSON.stringify({ state }) }));
    expect(saved.status).toBe(200);
    const loaded = await credits.fetch(new Request("https://credits.internal/xbot"));
    const body = (await loaded.json()) as { state: { sinceId: string } };
    expect(body.state.sinceId).toBe("77");
    expect(map.has("book")).toBe(false);
    const rejected = await credits.fetch(new Request("https://credits.internal/xbot-optout", { method: "POST", body: JSON.stringify({}) }));
    expect(rejected.status).toBe(400);
    const savedOpt = await credits.fetch(new Request("https://credits.internal/xbot-optout", {
      method: "POST",
      body: JSON.stringify({ ids: ["7", "7", "8"] }),
    }));
    expect(savedOpt.status).toBe(200);
    const loadedOpt = await credits.fetch(new Request("https://credits.internal/xbot-optout"));
    expect(await loadedOpt.json()).toEqual({ ok: true, ids: ["7", "8"] });
    expect(map.get("xbot_optout")).toEqual(["7", "8"]);
    expect(map.has("book")).toBe(false);
    const cursor = map.get("xbot") as { sinceId: string };
    expect(cursor.sinceId).toBe("77");
  });

  it("persists stop on xbot_optout, skips that account, and lets start undo it", async () => {
    const map = new Map<string, unknown>();
    const credits = new TavilyCredits({ storage: sqliteStore(map) });
    const env = { ...ready, X_BOT_DAILY_CAP: "2", TAVILY_CREDITS: bindCredits(credits) };
    let phase = "stop";
    const replies: { text: string; to: string }[] = [];
    let analyzed = 0;
    let reserved = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(String(init?.body)) as { text: string; reply: { in_reply_to_tweet_id: string } };
        replies.push({ text: body.text, to: body.reply.in_reply_to_tweet_id });
        return Response.json({ data: { id: "r" } });
      }
      if (!url.includes("/mentions")) throw new Error(`unexpected ${url}`);
      if (phase === "stop") {
        return Response.json({
          data: [mention({
            id: "30",
            text: "@aletheia unsubscribe https://apnews.com/nope",
            entities: { urls: [{ expanded_url: "https://apnews.com/nope" }] },
          })],
        });
      }
      if (phase === "skip") {
        return Response.json({
          data: [mention({ id: "31", text: "@aletheia https://apnews.com/later", entities: { urls: [{ expanded_url: "https://apnews.com/later" }] } })],
        });
      }
      return Response.json({
        data: [
          mention({ id: "33", text: "@aletheia https://apnews.com/back", entities: { urls: [{ expanded_url: "https://apnews.com/back" }] } }),
          mention({ id: "32", text: "@aletheia start" }),
        ],
      });
    };
    const deps = {
      fetchImpl,
      now: () => 1,
      cache: {
        async get() {
          return null;
        },
        async put() {},
      },
      analyze: async () => {
        analyzed += 1;
        return report();
      },
      gate: {
        async reserve() {
          reserved += 1;
          return { ok: true as const, code: "ok" as const, retryAfter: 0 };
        },
        async release() {},
      },
    };
    const stopped = await runXBot(env, deps);
    expect(replies).toEqual([{ text: stopReply("en"), to: "30" }]);
    expect(map.get("xbot_optout")).toEqual(["7"]);
    expect((map.get("xbot") as { denylist: string[] }).denylist).toEqual([]);
    expect(analyzed).toBe(0);
    expect(reserved).toBe(0);
    expect(stopped?.replies).toBe(1);
    expect(stopped?.fresh).toBe(0);

    phase = "skip";
    replies.length = 0;
    const skipped = await runXBot(env, deps);
    expect(replies).toEqual([]);
    expect(analyzed).toBe(0);
    expect(reserved).toBe(0);
    expect(skipped?.fresh).toBe(0);
    expect(skipped?.replies).toBe(1);
    expect(map.get("xbot_optout")).toEqual(["7"]);

    phase = "start";
    const resumed = await runXBot(env, deps);
    expect(map.get("xbot_optout")).toEqual([]);
    expect(analyzed).toBe(1);
    expect(reserved).toBe(1);
    expect(replies).toEqual([{ text: expect.stringContaining("62/100"), to: "33" }]);
    expect(replies[0]?.text.endsWith(optOutFooter("en"))).toBe(true);
    expect(resumed?.fresh).toBe(1);
    expect(map.has("book")).toBe(false);
  });
});

function sqliteStore(map: Map<string, unknown>) {
  const kv = {
    get<T>(key: string) { return map.get(key) as T | undefined; },
    put<T>(key: string, value: T) { map.set(key, value); },
    delete(key: string) { map.delete(key); return true; },
  };
  return {
    kv,
    transactionSync<T>(run: () => T) { return run(); },
    async get<T>(key: string) { return kv.get<T>(key); },
    async put<T>(key: string, value: T) { kv.put(key, value); },
    async delete(key: string) { return kv.delete(key); },
    async transaction<T>(run: (txn: unknown) => Promise<T>) { return run(this); },
  };
}

function bindCredits(object: { fetch(request: Request): Promise<Response> }): NonNullable<Env["TAVILY_CREDITS"]> {
  return {
    idFromName: (name: string) => ({ toString: () => name }),
    get() {
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => object.fetch(new Request(input, init)),
      };
    },
  } as unknown as NonNullable<Env["TAVILY_CREDITS"]>;
}
