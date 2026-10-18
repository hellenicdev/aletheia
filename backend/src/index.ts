import type { AnalysisResult, ArticlePreview, StageName } from "../../shared/types";
import { resolveConfig, type Env } from "./config";
import { corsHeaders, jsonResponse } from "./cors";
import { HttpError } from "./errors";
import { LIMITS, allowRequest, type RateState } from "./limits";
import { probeUpstreams } from "./probe";
import { analyze, type AnalyzeInput } from "./pipeline";
import { resolveFetch } from "./runtime";

export interface HandlerDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  rate?: RateState;
  /** Test hook. Production uses the analysis deadline. */
  deadlineMs?: number;
  /** Test hook. Production caps the segmentation call at 45 seconds. */
  segmentTimeoutMs?: number;
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
  if (origin && !config.allowedOrigins.includes(origin)) {
    return jsonResponse({ error: "Origin not allowed." }, 403, cors);
  }
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "") || "/";

  if (request.method === "GET" && path === "/api/health") {
    const tavilyConfigured = Boolean(env.TAVILY_API_KEY?.trim());
    const base = {
      searchConfigured: config.searchConfigured,
      tavilyConfigured,
      model: config.llmModel,
      searchProvider: tavilyConfigured && !env.FIRECRAWL_API_KEY?.trim() ? "tavily" : "firecrawl",
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
    const searchUp = probe.firecrawl.ok || probe.tavily.ok;
    return jsonResponse({ ok: probe.llm.ok && searchUp, ...base, probe }, 200, cors);
  }

  if (path !== "/api/analyze") {
    return jsonResponse({ error: "Not found." }, 404, cors);
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Use POST." }, 405, cors);
  }

  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > LIMITS.maxBodyBytes) {
    return jsonResponse({ error: "Request body is too large." }, 413, cors);
  }

  const rate = deps.rate ?? isolateRate;
  const now = deps.now ?? Date.now;
  const key = clientKey(request);
  if (!allowRequest(rate, key, now(), config.rateLimit, config.rateWindowMs)) {
    return jsonResponse({ error: "Too many analyses from this network. Try again shortly." }, 429, cors);
  }
  if (rate.inFlight.count >= LIMITS.maxInFlight) {
    return jsonResponse({ error: "The analyser is busy. Try again in a moment." }, 429, cors);
  }

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

  if (!env.OPENAI_API_KEY?.trim()) {
    return jsonResponse({ error: "OPENAI_API_KEY is not configured on the worker." }, 503, cors);
  }

  rate.inFlight.count += 1;
  const encoder = new TextEncoder();
  const deadlineMs = deps.deadlineMs ?? LIMITS.analysisDeadlineMs;
  const abort = new AbortController();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let hardStop: ReturnType<typeof setTimeout> | undefined;
  let grace: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        if (hardStop) clearTimeout(hardStop);
        if (grace) clearTimeout(grace);
        deadlineSignal.removeEventListener("abort", onDeadline);
        abort.abort();
        rate.inFlight.count = Math.max(0, rate.inFlight.count - 1);
        try {
          controller.close();
        } catch {
          /* The stream is already closed. */
        }
      };
      const ping = () => {
        try {
          if (!closed) controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
        }
      };
      // Keepalive and the deadline are armed before ingest, scrape, or the segment call.
      ping();
      heartbeat = setInterval(ping, 10_000);

      const deadlineSignal = AbortSignal.timeout(deadlineMs);
      let resolveDeadline: (value: "timeout") => void = () => {};
      const deadline = new Promise<"timeout">((resolve) => {
        resolveDeadline = resolve;
      });
      const onDeadline = () => resolveDeadline("timeout");
      if (deadlineSignal.aborted) onDeadline();
      else deadlineSignal.addEventListener("abort", onDeadline, { once: true });
      hardStop = setTimeout(onDeadline, deadlineMs);
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

      void (async () => {
        const timeoutMessage = "The analysis timed out before a verdict could be sent.";
        try {
          const winner = await Promise.race([work, deadline]);
          if (winner === "timeout") {
            abort.abort();
            const late = await Promise.race([
              work.catch(() => null),
              new Promise<AnalysisResult | null>((resolve) => {
                grace = setTimeout(() => resolve(null), 1_500);
              }),
            ]);
            if (late) send("result", late);
            else send("error", { message: timeoutMessage });
          } else {
            send("result", winner);
          }
        } catch (error) {
          const timedOut =
            abort.signal.aborted || (error instanceof Error && /deadline|timed out/i.test(error.message));
          const message = timedOut
            ? timeoutMessage
            : error instanceof HttpError
              ? error.message
              : "The analysis could not be completed.";
          if (!(error instanceof HttpError) && !timedOut) console.error(error);
          const late = await work.catch(() => null);
          if (late) send("result", late);
          else send("error", errorEvent(error, message));
        } finally {
          finish();
        }
      })();
    },
    cancel() {
      abort.abort();
    },
  });

  const headers = new Headers(cors);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-store");
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

function clientKey(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "anonymous"
  );
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};
