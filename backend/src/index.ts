import type { AnalysisResult, ArticlePreview, StageName } from "../../shared/types";
import { cacheApiAnalysisCache, storeAnalysis, type AnalysisCache } from "./analysisCache";
import { PIPELINE_VERSION } from "./version";
import { errorFields, logEvent } from "./log";
import { searchReport } from "./searchReport";
import { resolveConfig, type Env } from "./config";
import { corsHeaders, jsonResponse } from "./cors";
import { HttpError } from "./errors";
import { LIMITS, allowRequest, type RateState } from "./limits";
import { probeUpstreams } from "./probe";
import { analyze, type AnalyzeInput } from "./pipeline";
import {
  bindDurableCaches,
  durableBindingsPresent,
  DurableRateGate,
  IpRateLimiter,
  PipelineCache,
  probeDurableObjects,
  TavilyCredits,
} from "./rateLimiter";
import {
  MemoryRateGate,
  TAVILY_CREDITS_PER_ANALYSIS,
  TAVILY_DAILY_CREDITS,
  TAVILY_MONTHLY_CREDITS,
  clientLimitKey,
  rateLimitMessage,
  type RateDecision,
  type RateGate,
} from "./rateLimit";
import { resolveFetch } from "./runtime";
import { assertPublicHttpUrl } from "./ssrf";
import { analysisFailedMessage, analysisInterruptedMessage, analysisTimeoutMessage } from "../../shared/messages";
import { runXBot } from "./xBot";

export { IpRateLimiter, PipelineCache, TavilyCredits };

export interface HandlerDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  rate?: RateState;
  /** Test hook. Production uses the analysis deadline. */
  deadlineMs?: number;
  /** Test hook. Production caps the segmentation call at the outbound fetch timeout. */
  segmentTimeoutMs?: number;
  /** Keeps the analysis alive after the response headers are sent. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** Test hook. Production pings every 10 seconds, on its own timer. */
  pingMs?: number;
  /** Shared book. Tests pass one gate. Production uses the Durable Object gate. */
  gate?: RateGate;
  /** Test hook. Production uses the ANALYZE_IP binding (3 per 60 seconds). */
  ipLimit?: { limit(options: { key: string }): Promise<{ success: boolean }> };
  /** Same URL on this pipeline version, for 24 hours. A hit skips the per-IP quota. */
  analysisCache?: AnalysisCache;
}

const isolateRate: RateState = {
  buckets: new Map(),
  inFlight: { count: 0 },
};

export async function handleRequest(
  request: Request,
  env: Env,
  deps: HandlerDeps = {},
): Promise<Response> {
  let config;
  try {
    config = resolveConfig(env);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid worker configuration.";
    return jsonResponse({ error: message }, 500, new Headers());
  }

  const origin = request.headers.get("Origin");
  const cors = corsHeaders(origin, config.allowedOrigins);
  if (origin && !config.allowedOrigins.includes(origin) && !localhostOrigin(origin)) {
    return jsonResponse({ error: "Origin not allowed." }, 403, cors);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (request.method === "GET" && path === "/api/health") {
    const search = searchReport(env);
    const base = {
      searchConfigured: config.searchConfigured,
      tavilyConfigured: search.tavily === "configured",
      firecrawlConfigured: search.firecrawl === "configured",
      model: config.llmModel,
      searchProvider: search.active,
      search,
      limiter: durableBindingsPresent(env) ? "durable-object" : "missing",
      bindings: {
        ipLimiter: Boolean(env.IP_LIMITER),
        tavilyCredits: Boolean(env.TAVILY_CREDITS),
        pipelineCache: Boolean(env.PIPELINE_CACHE),
      },
      pipelineVersion: PIPELINE_VERSION,
    };
    if (url.searchParams.get("probe") !== "1") {
      return jsonResponse({ ok: true, ...base }, 200, cors);
    }
    const rate = deps.rate ?? isolateRate;
    const now = deps.now ?? Date.now;
    if (!allowRequest(rate, `${clientKey(request)}:probe`, now(), 10, config.rateWindowMs)) {
      return jsonResponse({ error: "Too many health probes from this network. Try again shortly." }, 429, cors);
    }
    const probe = await probeUpstreams(env, resolveFetch(deps.fetchImpl), deps.now?.());
    const limiter = await probeDurableObjects(env);
    const searchUp = probe.firecrawl.ok || probe.tavily.ok;
    return jsonResponse({ ok: probe.llm.ok && searchUp, ...base, probe: { ...probe, limiter } }, 200, cors);
  }

  if (request.method === "GET" && path === "/api/cached") {
    return cachedLookup(url, env, cors, deps);
  }

  if (path !== "/api/analyze") {
    return jsonResponse({ error: "Not found." }, 404, cors);
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Use POST." }, 405, cors);
  }

  if (!analyzeOriginAllowed(origin)) {
    return jsonResponse({ error: "Origin not allowed." }, 403, cors);
  }

  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > LIMITS.maxBodyBytes) {
    return jsonResponse({ error: "Request body is too large." }, 413, cors);
  }

  const rate = deps.rate ?? isolateRate;
  const now = deps.now ?? Date.now;
  const key = clientKey(request);

  let input: AnalyzeInput;
  try {
    const raw = await request.text();
    if (raw.length > LIMITS.maxBodyBytes) {
      return jsonResponse({ error: "Request body is too large." }, 413, cors);
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return jsonResponse({ error: "Expected a JSON object." }, 400, cors);
    }
    const record = parsed as Record<string, unknown>;
    input = {
      text: typeof record.text === "string" ? record.text : undefined,
      url: typeof record.url === "string" ? record.url : undefined,
      uiLanguage: typeof record.uiLanguage === "string" ? record.uiLanguage : undefined,
    };
  } catch {
    return jsonResponse({ error: "Expected JSON." }, 400, cors);
  }

  const lang = input.uiLanguage === "el" ? "el" : "en";
  const rejection = rejectInput(input);
  if (rejection) return jsonResponse({ error: rejection.error }, rejection.status, cors);

  if (env.PIPELINE_CACHE) bindDurableCaches(env.PIPELINE_CACHE);
  const analysisCache = deps.analysisCache ?? cacheApiAnalysisCache();
  if (input.url) {
    const cached = await analysisCache.get(input.url, lang);
    if (cached) return streamResponse(cors, (send) => send("result", cached), "hit");
  } else if (input.text && analysisCache.getText) {
    const cached = await analysisCache.getText(input.text, lang);
    if (cached) return streamResponse(cors, (send) => send("result", cached), "hit");
  }

  if (!limiterReady(env, deps.gate)) {
    return jsonResponse({ error: limitStoreMessage(lang), code: "limiter_unavailable" }, 503, cors);
  }

  if (!env.OPENAI_API_KEY?.trim()) {
    return jsonResponse({ error: "OPENAI_API_KEY is not configured on the worker." }, 503, cors);
  }

  if (rate.inFlight.count >= LIMITS.maxInFlight) {
    return limitResponse("ip_concurrent", 30, lang, cors);
  }

  const edge = deps.ipLimit ?? env.ANALYZE_IP;
  if (edge) {
    let allowed = true;
    try {
      allowed = (await edge.limit({ key })).success;
    } catch (error) {
      logEvent("edge_limit_failed", errorFields(error));
    }
    if (!allowed) return limitResponse("ip_burst", 60, lang, cors);
  }

  const gate = resolveGate(env, deps.gate);
  const credits = env.TAVILY_API_KEY?.trim() ? TAVILY_CREDITS_PER_ANALYSIS : 0;
  const dailyCreditCap = positiveCap(env.TAVILY_DAILY_CREDITS, TAVILY_DAILY_CREDITS);
  const monthlyCreditCap = positiveCap(env.TAVILY_MONTHLY_CREDITS, TAVILY_MONTHLY_CREDITS);
  let decision;
  try {
    decision = await gate.reserve({ ip: key, now: now(), credits, dailyCreditCap, monthlyCreditCap });
  } catch (error) {
    logEvent("limiter_reserve_failed", errorFields(error));
    return jsonResponse({ error: limitStoreMessage(lang), code: "limiter_unavailable" }, 503, cors);
  }
  if (!decision.ok) return limitResponse(decision.code, decision.retryAfter, lang, cors);

  rate.inFlight.count += 1;
  const encoder = new TextEncoder();
  const deadlineMs = deps.deadlineMs ?? LIMITS.analysisDeadlineMs;
  const abort = new AbortController();
  const interruptedMessage = analysisInterruptedMessage(lang);
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let terminal = false;
  const onRequestAbort = () => abort.abort();
  if (request.signal.aborted) onRequestAbort();
  else request.signal.addEventListener("abort", onRequestAbort, { once: true });
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* The client is already gone. finish still clears the timers. */
        }
      };
      const sendTerminal = (event: "result" | "error", data: unknown) => {
        if (terminal || closed) return;
        terminal = true;
        send(event, data);
      };
      let deadlineSignal: AbortSignal | undefined;
      let onDeadline: () => void = () => {};
      let finishing: Promise<void> | undefined;
      const finish = (): Promise<void> => {
        if (finishing) return finishing;
        finishing = (async () => {
          closed = true;
          if (heartbeat) clearTimeout(heartbeat);
          if (hardStop) clearTimeout(hardStop);
          if (grace) clearTimeout(grace);
          deadlineSignal?.removeEventListener("abort", onDeadline);
          request.signal.removeEventListener("abort", onRequestAbort);
          abort.abort();
          if (!terminal) {
            terminal = true;
            try {
              controller.enqueue(
                encoder.encode(
                  `event: error\ndata: ${JSON.stringify({ message: interruptedMessage, code: "interrupted" })}\n\n`,
                ),
              );
            } catch {
              /* The client is already gone. */
            }
          }
          rate.inFlight.count = Math.max(0, rate.inFlight.count - 1);
          const release = Promise.resolve(gate.release(key, now())).catch((error) => {
            logEvent("limiter_release_failed", errorFields(error));
          });
          try {
            deps.waitUntil?.(release);
          } catch {
            /* The stream task also awaits finish, so the release still runs. */
          }
          await release;
          try {
            controller.close();
          } catch {
            /* The stream is already closed. */
          }
        })();
        return finishing;
      };
      const ping = () => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          if (heartbeat) clearTimeout(heartbeat);
          abort.abort();
          sendTerminal("error", { message: interruptedMessage, code: "interrupted" });
          finish();
        }
      };
      const deadline = new Promise<"timeout">((resolve) => {
        onDeadline = () => resolve("timeout");
      });
      deadlineSignal = AbortSignal.timeout(deadlineMs);
      if (deadlineSignal.aborted) onDeadline();
      else deadlineSignal.addEventListener("abort", onDeadline, { once: true });
      hardStop = setTimeout(onDeadline, deadlineMs);
      // The ping timer is armed before any await and rearms itself, so a hung
      // fetch cannot starve the keepalive or the deadline.
      const pingEvery = deps.pingMs ?? 10_000;
      const armPing = () => {
        heartbeat = setTimeout(() => {
          ping();
          if (!closed) armPing();
        }, pingEvery);
      };
      ping();
      armPing();
      let resolveAbort: (value: "aborted") => void = () => {};
      const aborted = new Promise<"aborted">((resolve) => {
        resolveAbort = resolve;
      });
      if (request.signal.aborted) resolveAbort("aborted");
      else request.signal.addEventListener("abort", () => resolveAbort("aborted"), { once: true });
      const work: Promise<AnalysisResult> = analyze(input, {
        env,
        fetchImpl: deps.fetchImpl,
        signal: abort.signal,
        budgetMs: deadlineMs,
        segmentTimeoutMs: deps.segmentTimeoutMs,
        onStage: (stage: StageName, status, done, total) => send("stage", { stage, status, done, total }),
        onPreview: (article: ArticlePreview) => send("preview", article),
        onTick: ping,
      });

      const task = (async () => {
        const timeoutMessage = analysisTimeoutMessage(lang);
        try {
          const winner = await Promise.race([work, deadline, aborted]);
          if (winner === "aborted") {
            abort.abort();
            void work.catch(() => undefined);
            sendTerminal("error", { message: interruptedMessage, code: "interrupted" });
          } else if (winner === "timeout") {
            abort.abort();
            const late = await Promise.race([
              work.catch(() => null),
              new Promise<AnalysisResult | null>((resolve) => {
                grace = setTimeout(() => resolve(null), 1_500);
              }),
            ]);
            if (late) {
              sendTerminal("result", late);
              rememberAnalysis(deps, analysisCache, input, lang, late);
            } else sendTerminal("error", { message: timeoutMessage, code: "timeout" });
          } else {
            sendTerminal("result", winner);
            rememberAnalysis(deps, analysisCache, input, lang, winner);
          }
        } catch (error) {
          const timedOut =
            abort.signal.aborted || (error instanceof Error && /deadline|timed out/i.test(error.message));
          const message = request.signal.aborted
            ? interruptedMessage
            : timedOut
              ? timeoutMessage
              : error instanceof HttpError
                ? error.message
                : analysisFailedMessage(lang);
          const code = request.signal.aborted
            ? "interrupted"
            : timedOut
              ? "timeout"
              : error instanceof HttpError
                ? undefined
                : "analysis_failed";
          if (!(error instanceof HttpError) && !timedOut && !request.signal.aborted) {
            logEvent("analysis_failed", errorFields(error));
          }
          const late = request.signal.aborted ? null : await work.catch(() => null);
          if (late) {
            sendTerminal("result", late);
            rememberAnalysis(deps, analysisCache, input, lang, late);
          } else sendTerminal("error", { ...errorEvent(error, message), ...(code ? { code } : {}) });
        } finally {
          await finish();
        }
      })();
      // Tie the producer to the request context. Without this, a killed isolate
      // can leave the stream open and the client waiting.
      try {
        deps.waitUntil?.(task);
      } catch {
        /* The stream's own deadline still closes the response. */
      }
    },
    cancel() {
      abort.abort();
    },
  });

  const headers = new Headers(cors);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-store");
  headers.set("x-aletheia-cache", "miss");
  return new Response(stream, { status: 200, headers });
}

function errorEvent(
  error: unknown,
  message: string,
): { message: string; extraction?: string; reason?: string } {
  if (!(error instanceof HttpError)) return { message };
  const event: { message: string; extraction?: string; reason?: string } = { message };
  if (error.extraction) event.extraction = error.extraction;
  if (error.reason) event.reason = error.reason;
  return event;
}

function localhostOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:") return false;
    return url.hostname === "localhost" || url.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function analyzeOriginAllowed(origin: string | null): boolean {
  if (!origin) return false;
  if (origin === "https://hellenicdev.eu" || origin === "https://www.hellenicdev.eu") return true;
  return localhostOrigin(origin);
}

function rejectInput(input: AnalyzeInput): { status: number; error: string } | null {
  const text = input.text?.trim() ?? "";
  const url = input.url?.trim() ?? "";
  if (text && url) return { status: 400, error: "Provide either article text or a URL, not both." };
  if (!text && !url) return { status: 400, error: "Provide article text or a URL." };
  if (text.length > LIMITS.maxArticleChars) return { status: 413, error: "Request body is too large." };
  if (!url) return null;
  if (url.length > LIMITS.maxUrlChars) return { status: 400, error: "That URL is too long." };
  try {
    assertPublicHttpUrl(url);
  } catch (error) {
    return { status: 400, error: error instanceof Error ? error.message : "That address cannot be fetched." };
  }
  return null;
}

function limitResponse(
  code: RateDecision["code"],
  retryAfter: number,
  lang: "en" | "el",
  cors: Headers,
): Response {
  const seconds = Math.max(1, Math.ceil(retryAfter));
  return jsonResponse(
    { error: rateLimitMessage(code, seconds, lang), code, retryAfter: seconds },
    429,
    cors,
    { "Retry-After": String(seconds) },
  );
}

function streamResponse(
  cors: Headers,
  write: (send: (event: string, data: unknown) => void) => void,
  cache: "hit" | "miss",
): Response {
  const encoder = new TextEncoder();
  const chunks: string[] = [];
  write((event, data) => {
    chunks.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  });
  const headers = new Headers(cors);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-store");
  headers.set("x-aletheia-cache", cache);
  return new Response(encoder.encode(chunks.join("")), { status: 200, headers });
}

function limiterReady(env: Env, gate?: RateGate): boolean {
  if (gate) return true;
  if (durableBindingsPresent(env)) return true;
  return env.ALLOW_MEMORY_LIMITER === "1";
}

function resolveGate(env: Env, gate?: RateGate): RateGate {
  if (gate) return gate;
  if (env.IP_LIMITER && env.TAVILY_CREDITS && env.PIPELINE_CACHE) {
    return new DurableRateGate(env.IP_LIMITER, env.TAVILY_CREDITS);
  }
  if (env.ALLOW_MEMORY_LIMITER === "1") return new MemoryRateGate();
  return {
    async reserve() {
      throw new Error("The limiter bindings are missing.");
    },
    async release() {
      /* Nothing was reserved. */
    },
  };
}

function rememberAnalysis(
  deps: HandlerDeps,
  analysisCache: AnalysisCache,
  input: AnalyzeInput,
  language: "en" | "el",
  result: AnalysisResult,
): void {
  const pending = storeAnalysis(analysisCache, input, language, result);
  if (pending) track(deps, pending);
}

function track(deps: HandlerDeps, promise: Promise<unknown>): void {
  const settled = promise.catch((error) => {
    logEvent("cache_write_failed", errorFields(error));
  });
  try {
    deps.waitUntil?.(settled);
  } catch {
    /* Tests omit waitUntil. The write still runs. */
  }
}

function limitStoreMessage(lang: "en" | "el"): string {
  return lang === "el"
    ? "Ο αναλυτής δεν μπόρεσε να καταγράψει το αίτημα. Δοκιμάστε ξανά σε λίγο."
    : "The analyser could not record this request. Try again shortly.";
}

function positiveCap(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function clientKey(request: Request): string {
  return clientLimitKey(
    request.headers.get("CF-Connecting-IP") ||
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      "",
  );
}

async function cachedLookup(url: URL, env: Env, cors: Headers, deps: HandlerDeps): Promise<Response> {
  const page = url.searchParams.get("url")?.trim() ?? "";
  const lang = url.searchParams.get("lang") === "el" ? "el" : "en";
  try {
    assertPublicHttpUrl(page);
  } catch (error) {
    const message = error instanceof Error ? error.message : "That address cannot be fetched.";
    return jsonResponse({ error: message }, 400, cors);
  }
  if (env.PIPELINE_CACHE) bindDurableCaches(env.PIPELINE_CACHE);
  const cache = deps.analysisCache ?? cacheApiAnalysisCache();
  const hit = await cache.get(page, lang);
  if (!hit) return jsonResponse({ cached: false }, 200, cors);
  return jsonResponse({ cached: true, result: hit }, 200, cors);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, {
      waitUntil: (promise) => ctx.waitUntil(promise),
    });
  },
  scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): void {
    ctx.waitUntil(
      runXBot(env).catch((error) => {
        logEvent("x_bot_failed", errorFields(error));
      }),
    );
  },
};
