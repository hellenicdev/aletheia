import type { AnalysisResult, StageEvent } from "../shared/types";
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

export async function analyzeArticle(
  body: { text?: string; url?: string; uiLanguage: "en" | "el" },
  onStage: (event: StageEvent) => void,
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
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      /* The body was not JSON. */
    }
    throw new Error(message);
  }
  if (!response.body) throw new Error("The analysis response was empty.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: AnalysisResult | null = null;
  let failure: string | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const parsed = parseEvent(part);
      if (!parsed) continue;
      if (parsed.event === "stage") onStage(parsed.data as StageEvent);
      if (parsed.event === "result") result = parsed.data as AnalysisResult;
      if (parsed.event === "error") {
        const data = parsed.data as { message?: string };
        failure = data.message || "The analysis could not be completed.";
      }
    }
  }

  if (failure) throw new Error(failure);
  if (!result) throw new Error("The analysis ended without a result.");
  return result;
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
