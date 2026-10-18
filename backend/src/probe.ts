import { isRecord, parseModelJson } from "../../shared/json";
import type { Env } from "./config";
import { resolveConfig } from "./config";
import { HttpError, UpstreamError } from "./errors";
import { searchWeb } from "./firecrawl";
import { ModelOutputError, requestChat, sanitisePreview, type ChatMessage } from "./llm";
import { searchTavily } from "./tavily";

export interface ProbeCheck {
  ok: boolean;
  status: number | null;
  error?: string;
  /** Set when Firecrawl rejects the probe because credits are exhausted. */
  reason?: "out_of_credits";
  finishReason?: string | null;
  field?: string | null;
  preview?: string;
}

/** Long enough to stop a health poll from billing a search on every hit. */
const PROBE_TTL_MS = 60_000;
const probeMemo = new Map<string, { at: number; check: ProbeCheck }>();

export function clearProbeCache(): void {
  probeMemo.clear();
}

export async function probeUpstreams(
  env: Env,
  fetchImpl: typeof fetch,
  now = Date.now(),
): Promise<{ llm: ProbeCheck; firecrawl: ProbeCheck; tavily: ProbeCheck }> {
  const [llm, firecrawl, tavily] = await Promise.all([
    probeLlm(env, fetchImpl),
    probeFirecrawl(env, fetchImpl, now),
    probeTavily(env, fetchImpl, now),
  ]);
  return { llm, firecrawl, tavily };
}

async function probeLlm(env: Env, fetchImpl: typeof fetch): Promise<ProbeCheck> {
  const apiKey = env.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey) return { ok: false, status: null, error: "llm: OPENAI_API_KEY is not configured" };
  const messages: ChatMessage[] = [
    { role: "system", content: "Reply with one JSON object and nothing else." },
    { role: "user", content: 'Return {"ok":true}' },
  ];
  try {
    const completion = await requestChat(
      { config: resolveConfig(env), apiKey, fetchImpl, maxTokens: 4096 },
      messages,
      {
        dropResponseFormat: false,
        legacyMaxTokens: false,
        dropReasoningEffort: false,
        dropTemperature: false,
        dropSeed: false,
      },
    );
    const shown = completion.texts[0] ?? null;
    let detail = shown
      ? "model response was not valid JSON"
      : completion.finishReason === "length"
        ? "output limit reached before the answer"
        : "empty model response";
    for (const part of completion.texts) {
      try {
        const parsed = parseModelJson(part.text);
        if (isRecord(parsed) && parsed.ok === true) {
          return {
            ok: true,
            status: 200,
            finishReason: completion.finishReason,
            field: part.field,
            preview: sanitisePreview(part.text, apiKey),
          };
        }
        detail = "missing ok";
      } catch (error) {
        detail = error instanceof Error ? error.message : detail;
      }
    }
    return {
      ok: false,
      status: 502,
      error: `llm: HTTP 502 ${detail}`,
      finishReason: completion.finishReason,
      field: shown?.field ?? null,
      preview: sanitisePreview(shown?.text ?? "", apiKey),
    };
  } catch (error) {
    return asCheck("llm", error);
  }
}

async function probeFirecrawl(env: Env, fetchImpl: typeof fetch, now: number): Promise<ProbeCheck> {
  const apiKey = env.FIRECRAWL_API_KEY?.trim() ?? "";
  if (!apiKey) return { ok: false, status: null, error: "firecrawl: FIRECRAWL_API_KEY is not configured" };
  return cachedProbe("firecrawl", now, async () => {
    try {
      await searchWeb({
        apiKey,
        query: "eiffel tower",
        language: "en",
        fetchImpl,
        limit: 1,
        bypassCache: true,
      });
      return { ok: true, status: 200 };
    } catch (error) {
      return withCreditReason(asCheck("firecrawl", error), error);
    }
  });
}

async function probeTavily(env: Env, fetchImpl: typeof fetch, now: number): Promise<ProbeCheck> {
  const apiKey = env.TAVILY_API_KEY?.trim() ?? "";
  if (!apiKey) return { ok: false, status: null, error: "tavily: TAVILY_API_KEY is not configured" };
  return cachedProbe("tavily", now, async () => {
    try {
      await searchTavily({
        apiKey,
        query: "eiffel tower",
        fetchImpl,
        limit: 1,
        topic: "general",
        includeRawContent: false,
        bypassCache: true,
      });
      return { ok: true, status: 200 };
    } catch (error) {
      return withCreditReason(asCheck("tavily", error), error);
    }
  });
}

async function cachedProbe(
  name: string,
  now: number,
  load: () => Promise<ProbeCheck>,
): Promise<ProbeCheck> {
  const hit = probeMemo.get(name);
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.check;
  const check = await load();
  probeMemo.set(name, { at: now, check });
  return check;
}

function withCreditReason(check: ProbeCheck, error: unknown): ProbeCheck {
  if (!isOutOfCredits(error)) return check;
  return { ...check, reason: "out_of_credits" };
}

function isOutOfCredits(error: unknown): boolean {
  if (error instanceof UpstreamError && (error.status === 402 || error.status === 432)) return true;
  const message = error instanceof Error ? error.message : "";
  return /HTTP\s*402\b|HTTP\s*432\b|insufficient credits|usage limit/i.test(message);
}

function asCheck(source: "llm" | "firecrawl" | "tavily", error: unknown): ProbeCheck {
  if (error instanceof ModelOutputError) {
    return {
      ok: false,
      status: 502,
      error: `${source}: HTTP 502 ${error.message}`,
      finishReason: error.finishReason,
      field: error.field,
      preview: error.preview,
    };
  }
  if (error instanceof UpstreamError) {
    return { ok: false, status: error.status, error: error.message };
  }
  if (error instanceof HttpError) {
    const status = /API key/i.test(error.message) ? 401 : error.status;
    return { ok: false, status, error: `${source}: HTTP ${status} ${error.message}` };
  }
  const message = error instanceof Error ? error.message : "request failed";
  return { ok: false, status: null, error: message.startsWith(`${source}:`) ? message : `${source}: ${message}` };
}
