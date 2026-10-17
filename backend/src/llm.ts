import { parseModelJson } from "../../shared/json";
import type { AppConfig } from "./config";
import { HttpError, UpstreamError, redactSecret } from "./errors";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ModelText {
  field: string;
  text: string;
}

export interface ModelCompletion {
  texts: ModelText[];
  finishReason: string | null;
}

export class ModelOutputError extends Error {
  readonly name = "ModelOutputError";

  constructor(
    message: string,
    readonly field: string | null,
    readonly finishReason: string | null,
    readonly preview: string,
  ) {
    super(message);
  }
}

/** Beam counts reasoning tokens against this budget. 32 is not enough to finish. */
export const COMPLETION_TOKEN_BUDGET = 8192;

export function sanitisePreview(text: string, secret?: string): string {
  let safe = text;
  const trimmed = secret?.trim();
  if (secret) safe = safe.replaceAll(secret, "[redacted]");
  if (trimmed && trimmed !== secret) safe = safe.replaceAll(trimmed, "[redacted]");
  return safe.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, 300);
}

export async function completeJson<T>(options: {
  config: AppConfig;
  apiKey: string;
  system: string;
  user: string;
  validate: (data: unknown) => T;
  fetchImpl: typeof fetch;
  maxTokens?: number;
  attempts?: number;
}): Promise<T> {
  let hint = "";
  let lastDetail = "invalid JSON";
  let lastField: string | null = null;
  let lastReason: string | null = null;
  let lastPreview = "";
  const attempts = options.attempts ?? 3;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const messages: ChatMessage[] = [
      { role: "system", content: options.system },
      { role: "user", content: options.user },
    ];
    if (hint) {
      messages.push({
        role: "user",
        content: `The previous reply was rejected: ${hint}. Reply again with one JSON object only. No markdown.`,
      });
    }
    const completion = await requestChat(options, messages, {
      dropResponseFormat: attempt > 0,
      legacyMaxTokens: false,
    });
    const candidates = completion.texts.length
      ? completion.texts
      : [{ field: "content", text: "" }];
    for (const candidate of candidates) {
      lastField = candidate.field;
      lastReason = completion.finishReason;
      lastPreview = sanitisePreview(candidate.text, options.apiKey);
      if (!candidate.text.trim()) {
        lastDetail =
          completion.finishReason === "length"
            ? "output limit reached before the answer"
            : "empty model response";
        continue;
      }
      try {
        return options.validate(parseModelJson(candidate.text));
      } catch (error) {
        lastDetail = error instanceof Error ? error.message : "invalid JSON";
        hint = lastDetail.slice(0, 400);
      }
    }
  }
  const where = [
    lastReason ? `finish_reason ${lastReason}` : "",
    lastField ? `field ${lastField}` : "",
  ]
    .filter(Boolean)
    .join("; ");
  const message = `The model returned invalid JSON after retries (${lastDetail}${where ? `; ${where}` : ""}).`;
  console.error(`llm: ${message}${lastPreview ? ` preview=${JSON.stringify(lastPreview)}` : ""}`);
  throw new ModelOutputError(message, lastField, lastReason, lastPreview);
}

export async function requestChat(
  options: {
    config: AppConfig;
    apiKey: string;
    fetchImpl: typeof fetch;
    maxTokens?: number;
  },
  messages: ChatMessage[],
  flags: { dropResponseFormat: boolean; legacyMaxTokens: boolean },
): Promise<ModelCompletion> {
  const budget = options.maxTokens ?? COMPLETION_TOKEN_BUDGET;
  const body: Record<string, unknown> = {
    model: options.config.llmModel,
    temperature: 0,
    messages,
  };
  if (flags.legacyMaxTokens) body.max_tokens = budget;
  else body.max_completion_tokens = budget;
  if (!flags.dropResponseFormat) body.response_format = { type: "json_object" };

  let response: Response;
  try {
    response = await options.fetchImpl(`${options.config.llmBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch (error) {
    throw loggedUpstream("llm", null, errorText(error), options.apiKey);
  }

  const text = await response.text();
  if (!response.ok) {
    const safe = redactSecret(text, options.apiKey);
    if (
      response.status === 400 &&
      /max_completion_tokens/i.test(safe) &&
      !flags.legacyMaxTokens
    ) {
      console.error(`llm: HTTP ${response.status} ${safe}`);
      return requestChat(options, messages, { ...flags, legacyMaxTokens: true });
    }
    if (
      response.status === 400 &&
      /response_format/i.test(safe) &&
      !flags.dropResponseFormat
    ) {
      console.error(`llm: HTTP ${response.status} ${safe}`);
      return requestChat(options, messages, { ...flags, dropResponseFormat: true });
    }
    if (response.status === 401 || response.status === 403) {
      console.error(`llm: HTTP ${response.status} ${safe}`);
      throw new HttpError(502, "The LLM API key was rejected.");
    }
    throw loggedUpstream("llm", response.status, safe, options.apiKey);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(502, "The LLM response was not JSON.");
  }
  return readCompletion(parsed);
}

function loggedUpstream(
  source: "llm",
  status: number | null,
  detail: string,
  secret: string,
): UpstreamError {
  const error = new UpstreamError(source, status, redactSecret(detail, secret));
  console.error(error.message);
  return error;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}

export function readCompletion(payload: unknown): ModelCompletion {
  if (!payload || typeof payload !== "object") {
    throw new HttpError(502, "The LLM response was empty.");
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new HttpError(502, "The LLM response had no choices.");
  }
  const choice = choices[0] as {
    finish_reason?: unknown;
    message?: Record<string, unknown>;
  };
  const finishReason = typeof choice.finish_reason === "string" ? choice.finish_reason : null;
  const message = choice.message ?? {};
  const texts: ModelText[] = [];
  for (const field of ["content", "reasoning_content", "thinking", "reasoning", "refusal"] as const) {
    const text = readText(message[field]);
    if (text.trim()) texts.push({ field, text });
  }
  return { texts, finishReason };
}

function readText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text: unknown }).text ?? "");
      }
      return "";
    })
    .join("");
}
