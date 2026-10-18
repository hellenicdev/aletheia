import { workerCache } from "./analysisCache";
import { applyRelease, applyReserve, emptyBook, type RateBook, type RateDecision, type ReserveInput } from "./rateLimit";

/** One book for every isolate. The Cache API needs no namespace and no migration. */
const BOOK_URL = "https://cache.aletheia.internal/rate/book";
const BOOK_TTL_SECONDS = 32 * 24 * 60 * 60;

export interface RateBookCache {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
}

/**
 * Shared counters for the 10-minute, daily, in-flight, and Tavily credit limits.
 * A cache miss starts a fresh book, so the edge rate-limit binding stays in front.
 */
export class CacheRateGate {
  constructor(private readonly cache: RateBookCache) {}

  async reserve(input: ReserveInput): Promise<RateDecision> {
    const applied = applyReserve(await this.read(), input);
    await this.write(applied.book);
    return applied.decision;
  }

  async release(ip: string, now: number): Promise<void> {
    await this.write(applyRelease(await this.read(), ip, now));
  }

  private async read(): Promise<RateBook> {
    const hit = await this.cache.match(new Request(BOOK_URL));
    if (!hit) return emptyBook();
    try {
      const parsed = (await hit.json()) as RateBook;
      if (!parsed || typeof parsed !== "object" || !parsed.ips) return emptyBook();
      return parsed;
    } catch {
      return emptyBook();
    }
  }

  private async write(book: RateBook): Promise<void> {
    await this.cache.put(
      new Request(BOOK_URL),
      new Response(JSON.stringify(book), {
        headers: { "Cache-Control": `public, max-age=${BOOK_TTL_SECONDS}` },
      }),
    );
  }
}

export function cacheApiRateGate(): CacheRateGate | null {
  const cache = workerCache();
  return cache ? new CacheRateGate(cache) : null;
}
