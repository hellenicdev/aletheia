import type { AnalysisResult, ArticlePreview, StageEvent } from "../shared/types";
import { BACKEND_URL } from "./config";

export interface Health {
  ok: boolean;
  searchConfigured: boolean;
  model: string;
  searchProvider: string;
}

export async function fetchHealth(): Promise<Health | null> {
  try {
    const response = await fetch(`${trimSlash(BACKEND_URL)}/api/health`);
    if (!response.ok) return null;
    return (await response.json()) as Health;
  } catch {
    return null;
  }
}

/** No bytes, including keepalive pings, for this long means the run has stalled. */
export const ANALYSIS_STALL_MS = 45_000;

export const STALL_MESSAGE = "The analysis stopped sending updates.";

export class AnalysisError extends Error {
  readonly code?: string;
  readonly status?: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, detail?: { code?: string; status?: number; retryAfterSeconds?: number }) {
    super(message);
    this.name = "AnalysisError";
    this.code = detail?.code;
    this.status = detail?.status;
    this.retryAfterSeconds = detail?.retryAfterSeconds;
  }
}

export async function analyzeArticle(
  body: { text?: string; url?: string; uiLanguage: "en" | "el" },
  onStage: (event: StageEvent) => void,
  onPreview?: (article: ArticlePreview) => void,
  stallMs = ANALYSIS_STALL_MS,
): Promise<AnalysisResult> {
  const response = await fetch(`${trimSlash(BACKEND_URL)}/api/analyze`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    let code: string | undefined;
    let retryAfter = Number(response.headers.get("Retry-After") || "");
    try {
      const payload = (await response.json()) as { error?: string; code?: string; retryAfter?: number };
      if (payload.error) message = payload.error;
      if (payload.code) code = payload.code;
      if (typeof payload.retryAfter === "number") retryAfter = payload.retryAfter;
    } catch {
      /* The body was not JSON. */
    }
    throw new AnalysisError(message, {
      code,
      status: response.status,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
    });
  }
  if (!response.body) throw new Error("The analysis response was empty.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AnalysisResult | null = null;
  let failure: string | null = null;

  try {
    while (true) {
      const { done, value } = await readWithStall(reader, stallMs);
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const parsed = parseEvent(part);
        if (!parsed) continue;
        if (parsed.event === "stage") onStage(parsed.data as StageEvent);
        if (parsed.event === "preview") onPreview?.(parsed.data as ArticlePreview);
        if (parsed.event === "result") result = parsed.data as AnalysisResult;
        if (parsed.event === "error") {
          const data = parsed.data as { message?: string };
          failure = data.message || "The analysis could not be completed.";
        }
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  if (failure) throw new Error(failure);
  if (!result) throw new Error("The analysis ended without a result.");
  return result;
}

function readWithStall(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  stallMs: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(STALL_MESSAGE)), stallMs);
  });
  return Promise.race([reader.read(), stalled]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function parseEvent(block: string): { event: string; data: unknown } | null {
  const event = block.match(/^event: (.+)$/m)?.[1]?.trim();
  const data = block.match(/^data: (.+)$/m)?.[1];
  if (!event || !data) return null;
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return null;
  }
}

function trimSlash(url: string): string {
  return url.replace(/\/$/, "");
}
