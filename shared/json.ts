export function parseModelJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty model response");

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : trimmed).trim();
  const start = body.search(/[\[{]/);
  if (start < 0) throw new Error("model response did not contain JSON");

  const slice = body.slice(start);
  try {
    return JSON.parse(slice);
  } catch {
    const end = Math.max(slice.lastIndexOf("}"), slice.lastIndexOf("]"));
    if (end <= 0) throw new Error("model response was not valid JSON");
    return JSON.parse(slice.slice(0, end + 1));
  }
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
