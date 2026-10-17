export function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^\uFEFF/, "");
  if (!trimmed) throw new Error("empty model response");

  const candidates = [unwrapModelText(trimmed)];
  if (candidates[0] !== trimmed) candidates.push(trimmed);

  let sawJson = false;
  for (const candidate of candidates) {
    const extracted = firstBalancedJson(candidate);
    if (extracted === "none") continue;
    sawJson = true;
    if (extracted === "open") continue;
    try {
      return JSON.parse(extracted);
    } catch {
      /* A later candidate may still hold a complete value. */
    }
  }
  throw new Error(sawJson ? "model response was not valid JSON" : "model response did not contain JSON");
}

function unwrapModelText(text: string): string {
  const withoutThink = text
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, "")
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<analysis\b[^>]*>[\s\S]*?<\/analysis>/gi, "")
    .trim();
  const fenced = withoutThink.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : withoutThink).trim();
}

function firstBalancedJson(text: string): string | "none" | "open" {
  let sawStart = false;
  for (let start = 0; start < text.length; start++) {
    const opener = text[start];
    if (opener !== "{" && opener !== "[") continue;
    sawStart = true;
    const slice = balancedSlice(text, start);
    if (!slice) continue;
    try {
      JSON.parse(slice);
      return slice;
    } catch {
      /* Keep scanning. A brace inside prose is not the payload. */
    }
  }
  if (!sawStart) return "none";
  return "open";
}

function balancedSlice(text: string, start: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escape = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const open = stack.pop();
      const expected = open === "{" ? "}" : open === "[" ? "]" : "";
      if (!open || char !== expected) return null;
      if (stack.length === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function expectNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw new Error(`${label} must be a number from ${min} to ${max}`);
  }
  return number;
}

export function expectOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}
