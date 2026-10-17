import { isRecord } from "../../shared/json";
import type { Env } from "./config";
import { resolveConfig } from "./config";
import { HttpError, UpstreamError } from "./errors";
import { searchWeb } from "./firecrawl";
import { completeJson } from "./llm";

export interface ProbeCheck {
  ok: boolean;
  status: number | null;
  error?: string;
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
  try {
    await completeJson({
      config: resolveConfig(env),
      apiKey,
      fetchImpl,
      system: "Reply with one JSON object and nothing else.",
      user: 'Return {"ok":true}',
      maxTokens: 32,
      attempts: 1,
      validate: (data) => {
        if (!isRecord(data) || data.ok !== true) throw new Error("missing ok");
        return true;
      },
    });
    return { ok: true, status: 200 };
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
