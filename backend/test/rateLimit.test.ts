import { describe, expect, it } from "vitest";
import type { AnalysisResult } from "../../shared/types";
import { handleRequest } from "../src/index";
import { LIMITS } from "../src/limits";
import { CacheRateGate } from "../src/rateLimiter";
import {
  IP_BURST_LIMIT,
  IP_DAILY_LIMIT,
  MemoryRateGate,
  TAVILY_CREDITS_PER_ANALYSIS,
  TAVILY_DAILY_CREDITS,
  TAVILY_MONTHLY_CREDITS,
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

  it("shares the credit book through the cache", async () => {
    const cache = new Map<string, string>();
    const bookCache = {
      async match(request: Request) {
        const body = cache.get(request.url);
        return body ? new Response(body) : undefined;
      },
      async put(request: Request, response: Response) {
        cache.set(request.url, await response.text());
      },
    };
    const now = Date.UTC(2026, 9, 18, 12, 0, 0);
    const first = new CacheRateGate(bookCache);
    expect(
      (
        await first.reserve({
          ip: "203.0.113.8",
          now,
          credits: TAVILY_CREDITS_PER_ANALYSIS,
          dailyCreditCap: TAVILY_DAILY_CREDITS,
        })
      ).ok,
    ).toBe(true);
    const second = new CacheRateGate(bookCache);
    await second.release("203.0.113.8", now);
    const stored = JSON.parse(cache.values().next().value as string) as { creditsUsed: number };
    expect(stored.creditsUsed).toBe(TAVILY_CREDITS_PER_ANALYSIS);
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
});
