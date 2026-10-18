import { applyRelease, applyReserve, emptyBook, type RateBook, type RateDecision, type ReserveInput } from "./rateLimit";

/**
 * One global Durable Object. Wrangler creates it from the migration in
 * wrangler.toml on deploy. No KV namespace and no dashboard step.
 */
export class AnalysisRateLimiter {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const body = (await request.json()) as ReserveInput & { ip?: string; now?: number };
    const stored = (await this.ctx.storage.get<RateBook>("book")) ?? emptyBook(body.now ?? Date.now());
    if (url.pathname.endsWith("/release")) {
      const book = applyRelease(stored, body.ip || "anonymous", body.now ?? Date.now());
      await this.ctx.storage.put("book", book);
      return Response.json({ ok: true });
    }
    const applied = applyReserve(stored, {
      ip: body.ip || "anonymous",
      now: body.now ?? Date.now(),
      credits: body.credits ?? 0,
      dailyCreditCap: body.dailyCreditCap ?? 0,
    });
    await this.ctx.storage.put("book", applied.book);
    return Response.json(applied.decision satisfies RateDecision);
  }
}
