import { bindPipelineCache, durableResultCache } from "./persistentCache";
import {
  applyRelease,
  applyReserve,
  applyRevert,
  chargeCredits,
  emptyBook,
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

/** One global object. Counts Tavily credits for the UTC day and the calendar month. */
export class TavilyCredits {
  constructor(private readonly ctx: { storage: Store }) {}

  async fetch(request: Request): Promise<Response> {
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

export class DurableRateGate implements RateGate {
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
    if (!ipDecision.ok || input.credits <= 0) return ipDecision;
    try {
      const creditResponse = await this.creditStub().fetch("https://credits.internal/reserve", {
        method: "POST",
        body: JSON.stringify(input),
      });
      if (!creditResponse.ok) throw new Error("The Tavily credit ledger is unavailable.");
      const creditDecision = (await creditResponse.json()) as RateDecision;
      if (!creditDecision.ok) {
        await this.revert(input.ip, input.now);
        return creditDecision;
      }
      return { ok: true, code: "ok", retryAfter: 0 };
    } catch (error) {
      await this.revert(input.ip, input.now).catch(() => undefined);
      throw error;
    }
  }

  async release(ip: string, now: number): Promise<void> {
    const response = await this.ipStub(ip).fetch("https://limiter.internal/release", {
      method: "POST",
      body: JSON.stringify({ now }),
    });
    if (!response.ok) throw new Error("The per-IP limiter could not be released.");
  }

  private async revert(ip: string, now: number): Promise<void> {
    const response = await this.ipStub(ip).fetch("https://limiter.internal/revert", {
      method: "POST",
      body: JSON.stringify({ now }),
    });
    if (!response.ok) throw new Error("The per-IP limiter could not be reverted.");
  }

  private ipStub(ip: string): DurableObjectStub {
    return this.ips.get(this.ips.idFromName(ip || "anonymous"));
  }

  private creditStub(): DurableObjectStub {
    return this.credits.get(this.credits.idFromName("global"));
  }
}
