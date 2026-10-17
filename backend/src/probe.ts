import { isRecord, parseModelJson } from "../../shared/json";
import type { Env } from "./config";
import { resolveConfig } from "./config";
import { HttpError, UpstreamError } from "./errors";
import { searchWeb } from "./firecrawl";
import { ModelOutputError, requestChat, sanitisePreview, type ChatMessage } from "./llm";

export interface ProbeCheck {
  ok: boolean;
  status: number | null;
  error?: string;
  finishReason?: string | null;
  field?: string | null;
  preview?: string;
}

export async function probeUpstreams(
  env: Env,
  fetchImpl: typeof fetch,
): Promise<{ llm: ProbeCheck; search: ProbeCheck }> {
  const [llm, search] = await Promise.all([probeLlm(env, fetchImpl), probeSearch(env, fetchImpl)]);
  return { llm, search };
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

async function probeSearch(env: Env, fetchImpl: typeof fetch): Promise<ProbeCheck> {
  const apiKey = env.FIRECRAWL_API_KEY?.trim() ?? "";
  if (!apiKey) return { ok: false, status: null, error: "search: FIRECRAWL_API_KEY is not configured" };
  try {
    await searchWeb({
      apiKey,
      query: "eiffel tower",
      language: "en",
      fetchImpl,
      limit: 1,
    });
    return { ok: true, status: 200 };
  } catch (error) {
    return asCheck("search", error);
  }
}

function asCheck(source: "llm" | "search", error: unknown): ProbeCheck {
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
