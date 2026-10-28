import { describe, expect, it } from "vitest";
import { LABELS } from "../../shared/labels";
import type { AnalysisResult } from "../../shared/types";
import { handleRequest } from "../src/index";
import { TavilyCredits } from "../src/rateLimiter";
import { runXBot, xBotReady, type XBotDeps } from "../src/xBot";
import { articleLink, indexIncludes, type MentionPage } from "../src/xMentions";
import { oauth1Header, signatureBaseString } from "../src/xOauth";
import { formatMentionReply, weightedLength } from "../src/xReply";
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
  it("matches the documented HMAC-SHA1 signature", async () => {
    const material = {
      method: "POST",
      url: "https://api.twitter.com/1.1/statuses/update.json?include_entities=true",
      consumerKey: "xvz1evFS4wEEPTGEFPHBog",
      consumerSecret: "kAcSOqF21Fu85e7zjz7ZN2U4ZRhfV3WpwPAoE3Z7kBw",
      token: "370773112-GmHxMAgYyLbNEtIKZeRNFsMKPR9EyMZeS9weJAEb",
      tokenSecret: "LswwdoUaIvS8ltyTt5jkRh4J50vUPVVHtR2YPi5kE",
      params: { status: "Hello Ladies + Gentlemen, a signed OAuth request!" },
      nonce: "kYjzVBB8Y0ZFabxSWbWovY3uYSQ2pTgmZeNu2VS4cg",
      timestamp: "1318622958",
    };
    expect(signatureBaseString(material, material.nonce, material.timestamp)).toContain("include_entities%3Dtrue");
    const header = await oauth1Header(material);
    expect(header).toContain('oauth_signature="hCtSmYh%2BiHYCEqBWrE7C7hYmtUk%3D"');
    expect(header).not.toContain(material.consumerSecret);
    expect(header).not.toContain(material.tokenSecret);
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
      expect(weightedLength(text)).toBeLessThanOrEqual(280);
      expect(text).toContain(lang === "el" ? "/aletheia/el/?url=" : "/aletheia/?url=");
      expect(text).toContain("100/100");
    }
    expect(weightedLength(`see ${longUrl}`)).toBeLessThan(40);
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
    const state = emptyXBot(1);
    const fetchImpl: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "POST") {
        texts.push(JSON.parse(String(init?.body)).text as string);
        return Response.json({ data: { id: "1" } });
      }
      return Response.json({
        data: [
          mention({ id: "4", text: "@aletheia https://apnews.com/again", entities: { urls: [{ expanded_url: "https://apnews.com/again" }] } }),
          mention({ id: "3", lang: "el", text: "@aletheia σταμάτα" }),
        ],
      });
    };
    const next = await runXBot(ready, {
      fetchImpl,
      state,
      now: () => 1,
      cache: { async get() { return report(); }, async put() {} },
      analyze: async () => { throw new Error("analyzed"); },
    });
    expect(texts).toEqual(["Εντάξει. Η Αλήθεια δεν θα σας απαντήσει ξανά."]);
    expect(next?.denylist).toContain("7");
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
  });
});
