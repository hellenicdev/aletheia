import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../shared/types";
import { analysisCacheUrl, normaliseCachedText, textAnalysisCacheUrl } from "../src/analysisCache";
import { handleRequest } from "../src/index";
import { LIMITS } from "../src/limits";
import { bindPipelineCache, cacheStorageKey } from "../src/persistentCache";
import { clearProbeCache } from "../src/probe";
import { DurableRateGate, IpRateLimiter, PipelineCache, TavilyCredits } from "../src/rateLimiter";
import { PIPELINE_VERSION } from "../src/version";
import {
  GLOBAL_IN_FLIGHT,
  GLOBAL_PER_MINUTE,
  IN_FLIGHT_MS,
  IP_BURST_LIMIT,
  IP_DAILY_LIMIT,
  MemoryRateGate,
  TAVILY_CREDITS_PER_ANALYSIS,
  TAVILY_DAILY_CREDITS,
  TAVILY_MONTHLY_CREDITS,
  clientLimitKey,
  utcDate,
  utcMonth,
} from "../src/rateLimit";

const env = { OPENAI_API_KEY: "test-key", TAVILY_API_KEY: "tavily-test-key" };

function post(body: unknown, origin = "http://127.0.0.1:5173", ip = "203.0.113.8"): Request {
  return new Request("https://worker.test/api/analyze", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "CF-Connecting-IP": ip,
    },
    body: JSON.stringify(body),
  });
}

describe("analysis rate gate", () => {
  it("allows 3 analyses in 10 minutes and then names the wait", () => {
    const gate = new MemoryRateGate();
    const now = 1_700_000_000_000;
    for (let i = 0; i < IP_BURST_LIMIT; i += 1) {
      expect(gate.reserve({ ip: "203.0.113.8", now, credits: 0, dailyCreditCap: 30 }).ok).toBe(true);
      gate.release("203.0.113.8", now);
    }
    const blocked = gate.reserve({ ip: "203.0.113.8", now: now + 1_000, credits: 0, dailyCreditCap: 30 });
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe("ip_burst");
    expect(blocked.retryAfter).toBeGreaterThan(500);
    expect(gate.reserve({ ip: "203.0.113.9", now: now + 1_000, credits: 0, dailyCreditCap: 30 }).ok).toBe(true);
  });

  it("stops a 16th analysis inside a day and a second concurrent one", () => {
    const gate = new MemoryRateGate();
    let now = 1_700_000_000_000;
    for (let i = 0; i < IP_DAILY_LIMIT; i += 1) {
      now += 11 * 60 * 1000;
      const decision = gate.reserve({ ip: "203.0.113.8", now, credits: 0, dailyCreditCap: 30 });
      expect(decision.ok, String(i)).toBe(true);
      gate.release("203.0.113.8", now);
    }
    const daily = gate.reserve({ ip: "203.0.113.8", now: now + 11 * 60 * 1000, credits: 0, dailyCreditCap: 30 });
    expect(daily.code).toBe("ip_daily");

    const fresh = new MemoryRateGate();
    const held = fresh.reserve({ ip: "203.0.113.8", now, credits: 0, dailyCreditCap: 30 });
    expect(held.ok).toBe(true);
    const concurrent = fresh.reserve({ ip: "203.0.113.8", now: now + 1_000, credits: 0, dailyCreditCap: 30 });
    expect(concurrent.code).toBe("ip_concurrent");
    fresh.release("203.0.113.8", now + 1_000);
    expect(fresh.reserve({ ip: "203.0.113.8", now: now + 2_000, credits: 0, dailyCreditCap: 30 }).ok).toBe(true);
  });

  it("counts about 12 Tavily credits per analysis and resets the next UTC day", () => {
    const gate = new MemoryRateGate();
    const now = Date.UTC(2026, 9, 18, 12, 0, 0);
    let used = 0;
    while (used < TAVILY_DAILY_CREDITS) {
      const decision = gate.reserve({
        ip: `203.0.113.${used}`,
        now,
        credits: TAVILY_CREDITS_PER_ANALYSIS,
        dailyCreditCap: TAVILY_DAILY_CREDITS,
      });
      expect(decision.ok).toBe(true);
      gate.release(`203.0.113.${used}`, now);
      used += TAVILY_CREDITS_PER_ANALYSIS;
    }
    expect(gate.book.creditsUsed).toBe(TAVILY_DAILY_CREDITS);
    const blocked = gate.reserve({
      ip: "203.0.113.50",
      now: now + 1_000,
      credits: TAVILY_CREDITS_PER_ANALYSIS,
      dailyCreditCap: TAVILY_DAILY_CREDITS,
    });
    expect(blocked.code).toBe("tavily_daily");
    const tomorrow = Date.UTC(2026, 9, 19, 0, 5, 0);
    expect(utcDate(tomorrow)).not.toBe(utcDate(now));
    expect(
      gate.reserve({
        ip: "203.0.113.50",
        now: tomorrow,
        credits: TAVILY_CREDITS_PER_ANALYSIS,
        dailyCreditCap: TAVILY_DAILY_CREDITS,
      }).ok,
    ).toBe(true);
  });

  it("stops before a calendar month passes 950 Tavily credits", () => {
    const gate = new MemoryRateGate();
    const now = Date.UTC(2026, 9, 1, 0, 0, 0);
    let used = 0;
    let i = 0;
    while (used + TAVILY_CREDITS_PER_ANALYSIS <= TAVILY_MONTHLY_CREDITS) {
      const decision = gate.reserve({
        ip: `month-${i}`,
        now,
        credits: TAVILY_CREDITS_PER_ANALYSIS,
        dailyCreditCap: 10_000,
        monthlyCreditCap: TAVILY_MONTHLY_CREDITS,
      });
      expect(decision.ok, String(used)).toBe(true);
      gate.release(`month-${i}`, now);
      used += TAVILY_CREDITS_PER_ANALYSIS;
      i += 1;
    }
    expect(gate.book.creditsMonthUsed).toBe(948);
    const blocked = gate.reserve({
      ip: "month-blocked",
      now,
      credits: TAVILY_CREDITS_PER_ANALYSIS,
      dailyCreditCap: 10_000,
      monthlyCreditCap: TAVILY_MONTHLY_CREDITS,
    });
    expect(blocked.code).toBe("tavily_monthly");
    const nextMonth = Date.UTC(2026, 10, 1, 0, 5, 0);
    expect(
      gate.reserve({
        ip: "month-next",
        now: nextMonth,
        credits: TAVILY_CREDITS_PER_ANALYSIS,
        dailyCreditCap: 10_000,
        monthlyCreditCap: TAVILY_MONTHLY_CREDITS,
      }).ok,
    ).toBe(true);
    expect(gate.book.creditsMonthUsed).toBe(TAVILY_CREDITS_PER_ANALYSIS);
  });

  it("shares one credit ledger and stops at the daily and monthly caps", async () => {
    const credits = new TavilyCredits({ storage: sqliteStore() });
    const now = Date.UTC(2026, 9, 18, 12, 0, 0);
    let used = 0;
    while (used < TAVILY_DAILY_CREDITS) {
      const response = await credits.fetch(creditRequest({ now, credits: TAVILY_CREDITS_PER_ANALYSIS }));
      expect((await response.json()).ok).toBe(true);
      used += TAVILY_CREDITS_PER_ANALYSIS;
    }
    const blocked = await credits.fetch(creditRequest({ now: now + 1_000, credits: TAVILY_CREDITS_PER_ANALYSIS }));
    expect((await blocked.json()).code).toBe("tavily_daily");

    const month = new TavilyCredits({ storage: sqliteStore() });
    const start = Date.UTC(2026, 9, 1, 0, 0, 0);
    let monthUsed = 0;
    while (monthUsed + TAVILY_CREDITS_PER_ANALYSIS <= TAVILY_MONTHLY_CREDITS) {
      const response = await month.fetch(
        creditRequest({ now: start, credits: TAVILY_CREDITS_PER_ANALYSIS, dailyCreditCap: 10_000 }),
      );
      expect((await response.json()).ok).toBe(true);
      monthUsed += TAVILY_CREDITS_PER_ANALYSIS;
    }
    expect(monthUsed).toBe(948);
    const monthBlocked = await month.fetch(
      creditRequest({ now: start, credits: TAVILY_CREDITS_PER_ANALYSIS, dailyCreditCap: 10_000 }),
    );
    expect((await monthBlocked.json()).code).toBe("tavily_monthly");
  });

  it("returns the IP slot when the credit cap refuses the analysis", async () => {
    const namespaces = durableNamespaces();
    const gate = new DurableRateGate(namespaces.IP_LIMITER, namespaces.TAVILY_CREDITS);
    const start = Date.UTC(2026, 9, 18, 12, 0, 0);
    for (let i = 0; i < 10; i += 1) {
      const now = start + i * 61_000;
      const decision = await gate.reserve({
        ip: `credit-${i}`,
        now,
        credits: TAVILY_CREDITS_PER_ANALYSIS,
        dailyCreditCap: TAVILY_DAILY_CREDITS,
        monthlyCreditCap: TAVILY_MONTHLY_CREDITS,
      });
      expect(decision.ok).toBe(true);
      await gate.release(`credit-${i}`, now);
    }
    const blockedAt = start + 10 * 61_000;
    const blocked = await gate.reserve({
      ip: "203.0.113.8",
      now: blockedAt,
      credits: TAVILY_CREDITS_PER_ANALYSIS,
      dailyCreditCap: TAVILY_DAILY_CREDITS,
      monthlyCreditCap: TAVILY_MONTHLY_CREDITS,
    });
    expect(blocked.code).toBe("tavily_daily");
    for (let i = 0; i < IP_BURST_LIMIT; i += 1) {
      const decision = await gate.reserve({
        ip: "203.0.113.8",
        now: blockedAt + 61_000 + i,
        credits: 0,
        dailyCreditCap: TAVILY_DAILY_CREDITS,
      });
      expect(decision.ok).toBe(true);
      await gate.release("203.0.113.8", blockedAt + 61_000 + i);
    }
  });

  it("expires an in-flight lock and stores a pipeline cache row", async () => {
    const limiter = new IpRateLimiter({ storage: sqliteStore() });
    const now = 1_700_000_000_000;
    expect((await (await limiter.fetch(ipRequest("/reserve", now))).json()).ok).toBe(true);
    expect((await (await limiter.fetch(ipRequest("/reserve", now + 1_000))).json()).code).toBe("ip_concurrent");
    const later = await limiter.fetch(ipRequest("/reserve", now + IN_FLIGHT_MS));
    expect((await later.json()).ok).toBe(true);

    const cache = new PipelineCache({ storage: sqliteStore() });
    const saved = await cache.fetch(
      new Request("https://pipeline-cache.internal/put", {
        method: "POST",
        body: JSON.stringify({ key: "abc", body: "{\"title\":\"Cached\"}", ttl: 60 }),
      }),
    );
    expect(saved.ok).toBe(true);
    const hit = await cache.fetch(new Request("https://pipeline-cache.internal/get?key=abc"));
    expect(await hit.text()).toContain("Cached");
    const expired = new PipelineCache({
      storage: sqliteStore(new Map([["old", { body: "{}", exp: Date.now() - 1_000 }]])),
    });
    const miss = await expired.fetch(new Request("https://pipeline-cache.internal/get?key=old"));
    expect(miss.status).toBe(404);
  });
});

describe("analyze guards", () => {
  it("rejects a private URL, a non-http URL, a long paste, and a foreign origin", async () => {
    const gate = new MemoryRateGate();
    const now = () => 1_700_000_000_000;
    const privateUrl = await handleRequest(post({ url: "http://127.0.0.1/secret" }), env, { gate, now });
    expect(privateUrl.status).toBe(400);
    const scheme = await handleRequest(post({ url: "file:///etc/passwd" }), env, { gate, now });
    expect(scheme.status).toBe(400);
    const long = await handleRequest(post({ text: "a".repeat(LIMITS.maxArticleChars + 1) }), env, { gate, now });
    expect(long.status).toBe(413);
    const foreign = await handleRequest(post({ text: "a".repeat(80) }, "https://hellenicdev.github.io"), env, { gate, now });
    expect(foreign.status).toBe(403);
    const missing = await handleRequest(
      new Request("https://worker.test/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.8" },
        body: JSON.stringify({ text: "a".repeat(80) }),
      }),
      env,
      { gate, now },
    );
    expect(missing.status).toBe(403);
    expect(gate.book.creditsUsed).toBe(0);
  });

  it("does not count a cached URL against the per-IP limit", async () => {
    const gate = new MemoryRateGate();
    const now = 1_700_000_000_000;
    gate.reserve({ ip: "203.0.113.8", now, credits: 0, dailyCreditCap: 30 });
    const cached = {
      article: { title: "Cached", text: "The council voted." },
    } as AnalysisResult;
    const response = await handleRequest(post({ url: "https://www.kathimerini.gr/politics/story" }), env, {
      gate,
      now: () => now + 1_000,
      analysisCache: {
        async get() {
          return cached;
        },
        async put() {
          /* unused */
        },
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-aletheia-cache")).toBe("hit");
    expect(response.headers.get("access-control-expose-headers")).toContain("x-aletheia-cache");
    expect(await response.text()).toContain("Cached");
    expect(gate.book.ips["203.0.113.8"]?.recent).toHaveLength(1);
  });

  it("returns 429 with Retry-After when the Tavily day is spent", async () => {
    const gate = new MemoryRateGate();
    const now = Date.UTC(2026, 9, 18, 18, 0, 0);
    gate.book.creditsDate = utcDate(now);
    gate.book.creditsMonth = utcMonth(now);
    gate.book.creditsUsed = TAVILY_DAILY_CREDITS;
    gate.book.creditsMonthUsed = TAVILY_DAILY_CREDITS;
    const response = await handleRequest(post({ text: "a".repeat(80), uiLanguage: "el" }), env, {
      gate,
      now: () => now,
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.code).toBe("tavily_daily");
    expect(body.error).toContain("αύριο");
  });

  it("returns 429 ip_burst for a fourth request inside 10 minutes", async () => {
    const { IP_LIMITER, TAVILY_CREDITS } = durableNamespaces();
    const limited = {
      ...env,
      IP_LIMITER,
      TAVILY_CREDITS,
      PIPELINE_CACHE: singleNamespace(new PipelineCache({ storage: sqliteStore() })),
    };
    const rate = { buckets: new Map(), inFlight: { count: 0 } };
    const fetchImpl: typeof fetch = async () => {
      throw new Error("stop");
    };
    for (let i = 0; i < 3; i += 1) {
      const response = await handleRequest(post({ text: "a".repeat(80) }), limited, {
        rate,
        now: () => 1_700_000_000_000 + i,
        fetchImpl,
        deadlineMs: 1_000,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-aletheia-cache")).toBe("miss");
      await response.text();
    }
    const blocked = await handleRequest(post({ text: "a".repeat(80) }), limited, {
      rate,
      now: () => 1_700_000_000_000 + 3_000,
      fetchImpl,
    });
    expect(blocked.status).toBe(429);
    const body = (await blocked.json()) as { code: string };
    expect(body.code).toBe("ip_burst");
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    const other = await handleRequest(
      post({ text: "a".repeat(80) }, "http://127.0.0.1:5173", "203.0.113.9"),
      limited,
      { rate, now: () => 1_700_000_000_000 + 4_000, fetchImpl, deadlineMs: 1_000 },
    );
    expect(other.status).toBe(200);
    await other.text();
  });

  it("returns 503 when the durable object bindings are missing", async () => {
    let calls = 0;
    const response = await handleRequest(post({ text: "a".repeat(80) }), { OPENAI_API_KEY: "test-key" }, {
      now: () => 1_700_000_000_000,
      fetchImpl: async () => {
        calls += 1;
        return new Response("nope");
      },
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("could not record");
    expect(calls).toBe(0);
  });

  it("returns 503 and does not start an analysis when the limiter storage throws", async () => {
    let calls = 0;
    const response = await handleRequest(post({ text: "a".repeat(80), uiLanguage: "el" }), {
      ...env,
      IP_LIMITER: throwingNamespace(),
      TAVILY_CREDITS: throwingNamespace(),
      PIPELINE_CACHE: singleNamespace(new PipelineCache({ storage: sqliteStore() })),
    }, {
      now: () => 1_700_000_000_000,
      fetchImpl: async () => {
        calls += 1;
        return new Response("nope");
      },
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("καταγράψει");
    expect(calls).toBe(0);
  });

  it("does not ask the limiter for a cached analysis", async () => {
    let reserves = 0;
    const limiter = {
      idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
      get() {
        return {
          fetch: async () => {
            reserves += 1;
            return Response.json({ ok: true, code: "ok", retryAfter: 0 });
          },
        };
      },
    } as unknown as DurableObjectNamespace;
    const cacheObject = new PipelineCache({ storage: sqliteStore() });
    const page = "https://www.kathimerini.gr/politics/story";
    const key = await cacheStorageKey(new Request(analysisCacheUrl(page)));
    await cacheObject.fetch(
      new Request("https://pipeline-cache.internal/put", {
        method: "POST",
        body: JSON.stringify({
          key,
          body: JSON.stringify({ article: { title: "Cached", text: "The council voted." } }),
          ttl: 3_600,
        }),
      }),
    );
    try {
      const response = await handleRequest(post({ url: page }), {
        ...env,
        IP_LIMITER: limiter,
        TAVILY_CREDITS: limiter,
        PIPELINE_CACHE: singleNamespace(cacheObject),
      }, { now: () => 1_700_000_000_000 });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Cached");
      expect(reserves).toBe(0);
    } finally {
      bindPipelineCache(null);
    }
  });

  it("reports durable object bindings on the health check", async () => {
    clearProbeCache();
    const plain = await handleRequest(new Request("https://worker.test/api/health"), { OPENAI_API_KEY: "test-key" });
    const missing = (await plain.json()) as {
      limiter: string;
      pipelineVersion: string;
      bindings: { ipLimiter: boolean; tavilyCredits: boolean; pipelineCache: boolean };
    };
    expect(missing.limiter).toBe("missing");
    expect(missing.pipelineVersion).toBe(PIPELINE_VERSION);
    expect(missing.bindings).toEqual({ ipLimiter: false, tavilyCredits: false, pipelineCache: false });

    const { IP_LIMITER, TAVILY_CREDITS } = durableNamespaces();
    const PIPELINE_CACHE = singleNamespace(new PipelineCache({ storage: sqliteStore() }));
    const probed = await handleRequest(new Request("https://worker.test/api/health?probe=1"), {
      OPENAI_API_KEY: "test-key",
      IP_LIMITER,
      TAVILY_CREDITS,
      PIPELINE_CACHE,
    }, {
      now: () => 90_000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const body = (await probed.json()) as {
      limiter: string;
      bindings: { ipLimiter: boolean };
      probe: { limiter: { ok: boolean; error?: string } };
    };
    expect(body.limiter).toBe("durable-object");
    expect(body.bindings.ipLimiter).toBe(true);
    expect(body.probe.limiter.ok).toBe(true);
  });

  it("does not count a repeated paste against the limit", async () => {
    const cacheObject = new PipelineCache({ storage: sqliteStore() });
    const pageText = "The council voted 7 to 2 on Monday and published the minutes.";
    const key = await cacheStorageKey(new Request(await textAnalysisCacheUrl(pageText, "en")));
    await cacheObject.fetch(
      new Request("https://pipeline-cache.internal/put", {
        method: "POST",
        body: JSON.stringify({
          key,
          body: JSON.stringify({ article: { title: "Cached paste", text: pageText } }),
          ttl: 3_600,
        }),
      }),
    );
    let reserves = 0;
    const limiter = {
      idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
      get() {
        return {
          fetch: async () => {
            reserves += 1;
            return Response.json({ ok: true, code: "ok", retryAfter: 0 });
          },
        };
      },
    } as unknown as DurableObjectNamespace;
    const spaced = pageText.replace(" ", "   ");
    expect(normaliseCachedText(spaced)).toBe(normaliseCachedText(pageText));
    try {
      const response = await handleRequest(post({ text: spaced }), {
        ...env,
        IP_LIMITER: limiter,
        TAVILY_CREDITS: limiter,
        PIPELINE_CACHE: singleNamespace(cacheObject),
      }, { now: () => 1_700_000_000_000 });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-aletheia-cache")).toBe("hit");
      expect(await response.text()).toContain("Cached paste");
      expect(reserves).toBe(0);
    } finally {
      bindPipelineCache(null);
    }
  });

  it("returns 429 from the edge limiter without charging Tavily credits", async () => {
    const gate = new MemoryRateGate();
    const response = await handleRequest(post({ text: "a".repeat(80) }), env, {
      gate,
      now: () => Date.UTC(2026, 9, 18, 12, 0, 0),
      ipLimit: {
        async limit() {
          return { success: false };
        },
      },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("ip_burst");
    expect(gate.book.creditsUsed).toBe(0);
  });

  it("shares burst, daily, and in-flight limits across one IPv6 /64", async () => {
    const prefix = clientLimitKey("2a04:4e41:80:edd9::b9a4:edd9");
    expect(prefix).toBe(clientLimitKey("2a04:4e41:80:edd9::1"));
    expect(prefix).toBe(clientLimitKey("2A04:4E41:80:EDD9:0:0:0:1"));
    expect(prefix).toBe("2a04:4e41:0080:edd9/64");
    expect(clientLimitKey("2a04:4e41:80:c73a::7cd7:c73a")).toBe("2a04:4e41:0080:c73a/64");
    expect(clientLimitKey("203.0.113.8")).toBe("203.0.113.8");
    expect(clientLimitKey("203.000.113.008")).toBe("203.0.113.8");
    expect(clientLimitKey("::ffff:203.0.113.8")).toBe("203.0.113.8");
    expect(clientLimitKey("::ffff:cb00:7108")).toBe("203.0.113.8");

    const keyA = clientLimitKey("2a04:4e41:80:edd9::aa");
    const keyB = clientLimitKey("2a04:4e41:80:edd9::bb");
    expect(keyA).toBe(keyB);
    const flightNs = durableNamespaces();
    const left = new DurableRateGate(flightNs.IP_LIMITER, flightNs.TAVILY_CREDITS);
    const right = new DurableRateGate(flightNs.IP_LIMITER, flightNs.TAVILY_CREDITS);
    const now = 1_800_000_000_000;
    expect((await left.reserve({ ip: keyA, now, credits: 0, dailyCreditCap: 30 })).ok).toBe(true);
    expect((await right.reserve({ ip: keyB, now: now + 1_000, credits: 0, dailyCreditCap: 30 })).code).toBe(
      "ip_concurrent",
    );

    const dailyNs = durableNamespaces();
    const daily = new DurableRateGate(dailyNs.IP_LIMITER, dailyNs.TAVILY_CREDITS);
    let at = now;
    for (let i = 0; i < IP_DAILY_LIMIT; i += 1) {
      at += 11 * 60 * 1000;
      const decision = await daily.reserve({ ip: i % 2 === 0 ? keyA : keyB, now: at, credits: 0, dailyCreditCap: 30 });
      expect(decision.ok, String(i)).toBe(true);
      await daily.release(i % 2 === 0 ? keyA : keyB, at);
    }
    expect(
      (await daily.reserve({ ip: keyA, now: at + 11 * 60 * 1000, credits: 0, dailyCreditCap: 30 })).code,
    ).toBe("ip_daily");

    const { IP_LIMITER, TAVILY_CREDITS } = durableNamespaces();
    const limited = {
      ...env,
      IP_LIMITER,
      TAVILY_CREDITS,
      PIPELINE_CACHE: singleNamespace(new PipelineCache({ storage: sqliteStore() })),
    };
    const rate = { buckets: new Map(), inFlight: { count: 0 } };
    const fetchImpl: typeof fetch = async () => {
      throw new Error("stop");
    };
    const same = ["2a04:4e41:80:edd9::1", "2a04:4e41:80:edd9::2", "2a04:4e41:80:edd9::3"];
    for (const ip of same) {
      const response = await handleRequest(post({ text: `reef ${ip}` }, "http://127.0.0.1:5173", ip), limited, {
        rate,
        now: () => 1_700_000_000_000,
        fetchImpl,
        deadlineMs: 1_000,
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    const shared = await handleRequest(
      post({ text: "reef four" }, "http://127.0.0.1:5173", "2a04:4e41:80:edd9::4"),
      limited,
      { rate, now: () => 1_700_000_000_000 + 1_000, fetchImpl },
    );
    expect(shared.status).toBe(429);
    expect(((await shared.json()) as { code: string }).code).toBe("ip_burst");
    const other = await handleRequest(
      post({ text: "other prefix" }, "http://127.0.0.1:5173", "2a04:4e41:80:c73a::1"),
      limited,
      { rate, now: () => 1_700_000_000_000 + 2_000, fetchImpl, deadlineMs: 1_000 },
    );
    expect(other.status).toBe(200);
    await other.text();
  });

  it("caps fresh analyses at 6 per minute and 2 in flight for every client", async () => {
    const namespaces = durableNamespaces();
    const now = 1_700_000_000_000;
    const input = { credits: 0, dailyCreditCap: 30 };
    const first = new DurableRateGate(namespaces.IP_LIMITER, namespaces.TAVILY_CREDITS);
    const second = new DurableRateGate(namespaces.IP_LIMITER, namespaces.TAVILY_CREDITS);
    const thirdGate = new DurableRateGate(namespaces.IP_LIMITER, namespaces.TAVILY_CREDITS);
    expect((await first.reserve({ ip: "203.0.113.1", now, ...input })).ok).toBe(true);
    expect((await second.reserve({ ip: "203.0.113.2", now, ...input })).ok).toBe(true);
    const third = await thirdGate.reserve({ ip: "203.0.113.3", now: now + 500, ...input });
    expect(third.code).toBe("global_busy");
    expect(third.retryAfter).toBe(90);
    await first.release("203.0.113.1", now + 500);
    await second.release("203.0.113.2", now + 500);

    const returned = new DurableRateGate(namespaces.IP_LIMITER, namespaces.TAVILY_CREDITS);
    for (let i = 0; i < IP_BURST_LIMIT; i += 1) {
      const decision = await returned.reserve({ ip: "203.0.113.3", now: now + 1_000 + i, ...input });
      expect(decision.ok).toBe(true);
      await returned.release("203.0.113.3", now + 1_000 + i);
    }
    const burst = await returned.reserve({ ip: "203.0.113.3", now: now + 2_000, ...input });
    expect(burst.code).toBe("ip_burst");

    const minuteNs = durableNamespaces();
    const minute = new DurableRateGate(minuteNs.IP_LIMITER, minuteNs.TAVILY_CREDITS);
    for (let i = 0; i < GLOBAL_PER_MINUTE; i += 1) {
      const decision = await minute.reserve({ ip: `198.51.100.${i + 1}`, now, ...input });
      expect(decision.ok, String(i)).toBe(true);
      await minute.release(`198.51.100.${i + 1}`, now);
    }
    const busy = await minute.reserve({ ip: "198.51.100.20", now: now + 1_000, ...input });
    expect(busy.code).toBe("global_busy");
    expect(busy.retryAfter).toBeGreaterThanOrEqual(59);
    const later = await minute.reserve({
      ip: "198.51.100.20",
      now: now + 60_000,
      ...input,
    });
    expect(later.ok).toBe(true);
    expect(GLOBAL_IN_FLIGHT).toBe(2);

    const freshGate = durableNamespaces();
    const worker = {
      ...env,
      IP_LIMITER: freshGate.IP_LIMITER,
      TAVILY_CREDITS: freshGate.TAVILY_CREDITS,
      PIPELINE_CACHE: singleNamespace(new PipelineCache({ storage: sqliteStore() })),
    };
    const fetchImpl: typeof fetch = async () => {
      throw new Error("stop");
    };
    for (let i = 0; i < GLOBAL_PER_MINUTE; i += 1) {
      const response = await handleRequest(post({ text: `fresh ${i}` }, "http://127.0.0.1:5173", `198.51.100.${i + 1}`), worker, {
        rate: { buckets: new Map(), inFlight: { count: 0 } },
        now: () => now,
        fetchImpl,
        deadlineMs: 1_000,
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    const refused = await handleRequest(
      post({ text: "fresh over", uiLanguage: "el" }, "http://127.0.0.1:5173", "198.51.100.30"),
      worker,
      { rate: { buckets: new Map(), inFlight: { count: 0 } }, now: () => now + 1_000, fetchImpl },
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();
    const body = (await refused.json()) as { code: string; error: string };
    expect(body.code).toBe("global_busy");
    expect(body.error).toContain("απασχολημένη");
  });
});

function sqliteStore(initial?: Map<string, unknown>) {
  const map = initial ?? new Map<string, unknown>();
  const kv = {
    get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    put<T>(key: string, value: T) {
      map.set(key, value);
    },
    delete(key: string) {
      map.delete(key);
      return true;
    },
  };
  return {
    kv,
    transactionSync<T>(run: () => T) {
      return run();
    },
    async get<T>(key: string) {
      return kv.get<T>(key);
    },
    async put<T>(key: string, value: T) {
      kv.put(key, value);
    },
    async delete(key: string) {
      return kv.delete(key);
    },
    async transaction<T>(run: (txn: unknown) => Promise<T>) {
      return run(this);
    },
  };
}

function creditRequest(body: { now: number; credits: number; dailyCreditCap?: number }): Request {
  return new Request("https://credits.internal/reserve", {
    method: "POST",
    body: JSON.stringify({
      ip: "global",
      now: body.now,
      credits: body.credits,
      dailyCreditCap: body.dailyCreditCap ?? TAVILY_DAILY_CREDITS,
      monthlyCreditCap: TAVILY_MONTHLY_CREDITS,
    }),
  });
}

function ipRequest(path: string, now: number): Request {
  return new Request(`https://limiter.internal${path}`, {
    method: "POST",
    body: JSON.stringify({ now }),
  });
}

function singleNamespace(object: { fetch(request: Request): Promise<Response> }): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
    get() {
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => object.fetch(new Request(input, init)),
      };
    },
  } as unknown as DurableObjectNamespace;
}

function objectNamespace(factory: () => { fetch(request: Request): Promise<Response> }): DurableObjectNamespace {
  const objects = new Map<string, { fetch(request: Request): Promise<Response> }>();
  return {
    idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
    get(id: DurableObjectId) {
      const name = id.toString();
      let object = objects.get(name);
      if (!object) {
        object = factory();
        objects.set(name, object);
      }
      return {
        fetch: (input: RequestInfo | URL, init?: RequestInit) => object!.fetch(new Request(input, init)),
      };
    },
  } as unknown as DurableObjectNamespace;
}

function durableNamespaces(): { IP_LIMITER: DurableObjectNamespace; TAVILY_CREDITS: DurableObjectNamespace } {
  return {
    IP_LIMITER: objectNamespace(() => new IpRateLimiter({ storage: sqliteStore() })),
    TAVILY_CREDITS: objectNamespace(() => new TavilyCredits({ storage: sqliteStore() })),
  };
}

function throwingNamespace(): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ toString: () => name }) as DurableObjectId,
    get() {
      return {
        fetch: async () => {
          throw new Error("storage down");
        },
      };
    },
  } as unknown as DurableObjectNamespace;
}
