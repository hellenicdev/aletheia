import { bindPipelineCache, durableResultCache } from "./persistentCache";
import {
  applyRelease,
  applyReserve,
  applyRevert,
  chargeCredits,
  emptyBook,
  emptyGlobal,
  releaseGlobal,
  reserveGlobal,
  revertGlobal,
  type GlobalLedger,
  type RateBook,
  type RateDecision,
  type RateGate,
  type ReserveInput,
} from "./rateLimit";

const IP_KEY = "self";

interface IpLedger {
  recent: number[];
  day: number[];
  inFlightUntil: number;
}

interface SyncKv {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
}

interface Store {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  transaction<T>(closure: (txn: Store) => Promise<T>): Promise<T>;
  /** Present on SQLite-backed Durable Objects. Writes inside it commit or roll back together. */
  kv?: SyncKv;
  transactionSync?<T>(closure: () => T): T;
}

interface SyncIo {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
  delete(key: string): void;
}

function syncIo(kv: SyncKv): SyncIo {
  return {
    get: (key) => kv.get(key),
    put: (key, value) => {
      kv.put(key, value);
    },
    delete: (key) => {
      kv.delete(key);
    },
  };
}

/** SQLite commits this synchronously. Tests use the async transaction instead. */
function runSync<T>(storage: Store, run: (io: SyncIo) => T): T | undefined {
  if (!storage.kv || !storage.transactionSync) return undefined;
  const io = syncIo(storage.kv);
  return storage.transactionSync(() => run(io));
}

/**
 * One object per client IP. SQLite storage is global, so the 10-minute,
 * daily, and in-flight limits hold on workers.dev. The in-flight stamp
 * expires after 90 seconds inside applyReserve.
 */
export class IpRateLimiter {
  constructor(private readonly ctx: { storage: Store }) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET") {
      await this.ctx.storage.get("ledger");
      return Response.json({ ok: true });
    }
    const body = (await request.json()) as { now?: number };
    const now = body.now ?? Date.now();
    const decision = runSync(this.ctx.storage, (io) => decideIp(io, url.pathname, now));
    if (!decision) throw new Error("The per-IP limiter is missing SQLite storage.");
    return Response.json(decision);
  }
}

function decideIp(io: SyncIo, pathname: string, now: number): RateDecision {
  const stored = io.get<IpLedger>("ledger") ?? { recent: [], day: [], inFlightUntil: 0 };
  const book = emptyBook(now);
  book.ips[IP_KEY] = stored;
  if (pathname.endsWith("/release")) {
    const next = applyRelease(book, IP_KEY, now);
    saveLedger(io, next.ips[IP_KEY]);
    return { ok: true, code: "ok", retryAfter: 0 };
  }
  if (pathname.endsWith("/revert")) {
    const next = applyRevert(book, IP_KEY, now);
    saveLedger(io, next.ips[IP_KEY]);
    return { ok: true, code: "ok", retryAfter: 0 };
  }
  const applied = applyReserve(book, { ip: IP_KEY, now, credits: 0, dailyCreditCap: 1 });
  saveLedger(io, applied.book.ips[IP_KEY]);
  return applied.decision;
}

function saveLedger(io: SyncIo, ledger: IpLedger | undefined): void {
  if (!ledger) {
    io.delete("ledger");
    return;
  }
  io.put("ledger", ledger);
}

/**
 * One global object. Counts Tavily credits for the UTC day and the calendar
 * month, and the site-wide fresh-analysis cap (6 per minute, 2 in flight).
 * The cap lives here so it does not need a new migration: `wrangler versions
 * upload` cannot apply a pending migration, and this class already shipped.
 */
export class TavilyCredits {
  constructor(private readonly ctx: { storage: Store }) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/xbot")) return this.xbot(request);
    if (request.method === "GET") {
      await this.ctx.storage.get("book");
      return Response.json({ ok: true });
    }
    if (url.pathname.includes("/global/")) {
      const body = (await request.json()) as { now?: number; reservedAt?: number };
      const now = body.now ?? Date.now();
      const reservedAt = body.reservedAt ?? now;
      const decision = runSync(this.ctx.storage, (io) => {
        const stored = io.get<GlobalLedger>("traffic") ?? emptyGlobal();
        if (url.pathname.endsWith("/global/release")) {
          io.put("traffic", releaseGlobal(stored, reservedAt, now));
          return { ok: true, code: "ok" as const, retryAfter: 0 };
        }
        if (url.pathname.endsWith("/global/revert")) {
          io.put("traffic", revertGlobal(stored, reservedAt));
          return { ok: true, code: "ok" as const, retryAfter: 0 };
        }
        const applied = reserveGlobal(stored, now);
        io.put("traffic", applied.ledger);
        return applied.decision;
      });
      if (!decision) throw new Error("The global limiter is missing SQLite storage.");
      return Response.json(decision);
    }
    const body = (await request.json()) as ReserveInput;
    const decision = runSync(this.ctx.storage, (io) => {
      const stored = io.get<RateBook>("book") ?? emptyBook(body.now);
      const applied = chargeCredits(stored, body);
      io.put("book", applied.book);
      return applied.decision;
    });
    if (!decision) throw new Error("The Tavily credit ledger is missing SQLite storage.");
    return Response.json(decision);
  }

  /** Bot cursor and denylist. A separate key from the credit book, same object. */
  private async xbot(request: Request): Promise<Response> {
    if (request.method === "GET") {
      const state = (await this.ctx.storage.get("xbot")) ?? null;
      return Response.json({ ok: true, state });
    }
    const body = (await request.json()) as { state?: unknown };
    if (!body.state || typeof body.state !== "object") return new Response("missing", { status: 400 });
    const synced = runSync(this.ctx.storage, (io) => {
      io.put("xbot", body.state);
      return true;
    });
    if (!synced) await this.ctx.storage.put("xbot", body.state);
    return Response.json({ ok: true });
  }
}

interface CacheRow {
  body: string;
  exp: number;
}

/** SQLite-backed cache for analysis results, scrapes, searches, and verdicts. */
export class PipelineCache {
  constructor(private readonly ctx: { storage: Store }) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/ping")) {
      await this.ctx.storage.get("ping");
      return Response.json({ ok: true });
    }
    if (url.pathname.endsWith("/put")) {
      const body = (await request.json()) as { key?: string; body?: string; ttl?: number };
      if (!body.key || typeof body.body !== "string") return new Response("missing", { status: 400 });
      const ttl = Number.isFinite(body.ttl) && (body.ttl ?? 0) > 0 ? (body.ttl as number) : 86_400;
      await this.ctx.storage.put<CacheRow>(body.key, { body: body.body, exp: Date.now() + ttl * 1000 });
      return Response.json({ ok: true });
    }
    const key = url.searchParams.get("key") ?? "";
    if (!key) return new Response("missing", { status: 400 });
    const row = await this.ctx.storage.get<CacheRow>(key);
    if (!row || row.exp <= Date.now()) {
      if (row) await this.ctx.storage.delete(key);
      return new Response(null, { status: 404 });
    }
    return new Response(row.body, { headers: { "content-type": "application/json" } });
  }
}

export function bindDurableCaches(namespace: DurableObjectNamespace | undefined): void {
  bindPipelineCache(namespace ? durableResultCache(namespace) : null);
}

export function durableBindingsPresent(env: {
  IP_LIMITER?: DurableObjectNamespace;
  TAVILY_CREDITS?: DurableObjectNamespace;
  PIPELINE_CACHE?: DurableObjectNamespace;
}): boolean {
  return Boolean(env.IP_LIMITER && env.TAVILY_CREDITS && env.PIPELINE_CACHE);
}

/** Read-only round trip. A missing binding or a storage error is reported, not thrown. */
export async function probeDurableObjects(env: {
  IP_LIMITER?: DurableObjectNamespace;
  TAVILY_CREDITS?: DurableObjectNamespace;
  PIPELINE_CACHE?: DurableObjectNamespace;
}): Promise<{ ok: boolean; error?: string }> {
  const missing = [
    env.IP_LIMITER ? "" : "IP_LIMITER",
    env.TAVILY_CREDITS ? "" : "TAVILY_CREDITS",
    env.PIPELINE_CACHE ? "" : "PIPELINE_CACHE",
  ].filter(Boolean);
  if (missing.length > 0) return { ok: false, error: `missing ${missing.join(", ")}` };
  try {
    const ips = env.IP_LIMITER as DurableObjectNamespace;
    const credits = env.TAVILY_CREDITS as DurableObjectNamespace;
    const cache = env.PIPELINE_CACHE as DurableObjectNamespace;
    const responses = await Promise.all([
      ips.get(ips.idFromName("health")).fetch("https://limiter.internal/ping"),
      credits.get(credits.idFromName("global")).fetch("https://credits.internal/ping"),
      cache.get(cache.idFromName("global")).fetch("https://pipeline-cache.internal/ping"),
    ]);
    const failed = responses.find((response) => !response.ok);
    if (failed) return { ok: false, error: `status ${failed.status}` };
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "The limiter could not be reached.";
    return { ok: false, error: message.slice(0, 180) };
  }
}

export class DurableRateGate implements RateGate {
  private reservedAt: number | null = null;

  constructor(
    private readonly ips: DurableObjectNamespace,
    private readonly credits: DurableObjectNamespace,
  ) {}

  async reserve(input: ReserveInput): Promise<RateDecision> {
    const ipResponse = await this.ipStub(input.ip).fetch("https://limiter.internal/reserve", {
      method: "POST",
      body: JSON.stringify({ now: input.now }),
    });
    if (!ipResponse.ok) throw new Error("The per-IP limiter is unavailable.");
    const ipDecision = (await ipResponse.json()) as RateDecision;
    if (!ipDecision.ok) return ipDecision;

    let globalHeld = false;
    try {
      const globalResponse = await this.creditStub().fetch("https://credits.internal/global/reserve", {
        method: "POST",
        body: JSON.stringify({ now: input.now }),
      });
      if (!globalResponse.ok) throw new Error("The global limiter is unavailable.");
      const globalDecision = (await globalResponse.json()) as RateDecision;
      if (!globalDecision.ok) {
        await this.revert(input.ip, input.now);
        return globalDecision;
      }
      globalHeld = true;
      if (input.credits > 0) {
        const creditResponse = await this.creditStub().fetch("https://credits.internal/reserve", {
          method: "POST",
          body: JSON.stringify(input),
        });
        if (!creditResponse.ok) throw new Error("The Tavily credit ledger is unavailable.");
        const creditDecision = (await creditResponse.json()) as RateDecision;
        if (!creditDecision.ok) {
          await this.revert(input.ip, input.now);
          await this.revertGlobal(input.now);
          return creditDecision;
        }
      }
      this.reservedAt = input.now;
      return { ok: true, code: "ok", retryAfter: 0 };
    } catch (error) {
      await this.revert(input.ip, input.now).catch(() => undefined);
      if (globalHeld) await this.revertGlobal(input.now).catch(() => undefined);
      throw error;
    }
  }

  async release(ip: string, now: number): Promise<void> {
    const reservedAt = this.reservedAt ?? now;
    const [ipResponse, globalResponse] = await Promise.all([
      this.ipStub(ip).fetch("https://limiter.internal/release", {
        method: "POST",
        body: JSON.stringify({ now }),
      }),
      this.creditStub().fetch("https://credits.internal/global/release", {
        method: "POST",
        body: JSON.stringify({ now, reservedAt }),
      }),
    ]);
    if (!ipResponse.ok || !globalResponse.ok) throw new Error("The limiter could not be released.");
  }

  private async revert(ip: string, now: number): Promise<void> {
    const response = await this.ipStub(ip).fetch("https://limiter.internal/revert", {
      method: "POST",
      body: JSON.stringify({ now }),
    });
    if (!response.ok) throw new Error("The per-IP limiter could not be reverted.");
  }

  private async revertGlobal(reservedAt: number): Promise<void> {
    const response = await this.creditStub().fetch("https://credits.internal/global/revert", {
      method: "POST",
      body: JSON.stringify({ now: reservedAt, reservedAt }),
    });
    if (!response.ok) throw new Error("The global limiter could not be reverted.");
  }

  private ipStub(ip: string): DurableObjectStub {
    return this.ips.get(this.ips.idFromName(ip || "anonymous"));
  }

  private creditStub(): DurableObjectStub {
    return this.credits.get(this.credits.idFromName("global"));
  }
}
