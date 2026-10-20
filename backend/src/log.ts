const SECRET = /(?:api[_-]?key|secret|token|authorization|bearer)\s*[:=]\s*\S+/gi;
const BEARER = /bearer\s+\S+/gi;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

/** One JSON line on stderr. Cloudflare logs can filter on `kind`. No secrets, addresses, or article text. */
export function logEvent(
  kind: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const payload: Record<string, string | number | boolean | null> = { event: "aletheia", kind };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    payload[key] = typeof value === "string" ? redactLog(value) : value;
  }
  console.error(JSON.stringify(payload));
}

export function redactLog(text: string): string {
  return text
    .replace(SECRET, "[redacted]")
    .replace(BEARER, "bearer [redacted]")
    .replace(EMAIL, "[redacted-email]")
    .replace(IPV4, "[redacted-ip]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

export function errorFields(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: redactLog(error.message) };
  return { name: "Error", message: "request failed" };
}
