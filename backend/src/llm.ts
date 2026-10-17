import { parseModelJson } from "../../shared/json";
import type { AppConfig } from "./config";
import { HttpError } from "./errors";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export async function completeJson<T>(options: {
  config: AppConfig;
  apiKey: string;
  system: string;
  user: string;
  validate: (data: unknown) => T;
  fetchImpl: typeof fetch;
  maxTokens?: number;
}): Promise<T> {
  let hint = "";
  let lastError = "invalid JSON";
  for (let attempt = 0; attempt < 3; attempt++) {
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
    const raw = await chat(options, messages, attempt > 0);
    try {
      return options.validate(parseModelJson(raw));
    } catch (error) {
      lastError = error instanceof Error ? error.message : "invalid JSON";
      hint = lastError.slice(0, 400);
    }
  }
  throw new HttpError(502, `The model returned invalid JSON after retries (${lastError}).`);
}

async function chat(
  options: {
    config: AppConfig;
    apiKey: string;
    fetchImpl: typeof fetch;
    maxTokens?: number;
  },
  messages: ChatMessage[],
  dropResponseFormat: boolean,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: options.config.llmModel,
    temperature: 0,
    max_tokens: options.maxTokens ?? 4096,
    messages,
  };
  if (!dropResponseFormat) body.response_format = { type: "json_object" };

  const response = await options.fetchImpl(`${options.config.llmBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000),
  });

  const text = await response.text();
  if (!response.ok) {
    const safe = text.replaceAll(options.apiKey, "[redacted]").slice(0, 300);
    if (
      response.status === 400 &&
      /response_format/i.test(safe) &&
      !dropResponseFormat
    ) {
      return chat(options, messages, true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new HttpError(502, "The LLM API key was rejected.");
    }
    throw new HttpError(502, `The LLM request failed (${response.status}).`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(502, "The LLM response was not JSON.");
  }
  return messageText(parsed);
}

function messageText(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    throw new HttpError(502, "The LLM response was empty.");
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new HttpError(502, "The LLM response had no choices.");
  }
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  const content = message?.content;
  if (typeof content === "string" && content.trim()) return content;
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text: unknown }).text ?? "");
        }
        return "";
      })
      .join("");
    if (joined.trim()) return joined;
  }
  throw new HttpError(502, "The LLM response had no message content.");
}
