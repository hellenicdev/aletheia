export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class UpstreamError extends Error {
  readonly name = "UpstreamError";

  constructor(
    readonly source: "llm" | "search",
    readonly status: number | null,
    detail: string,
  ) {
    super(formatUpstream(source, status, detail));
  }
}

export function formatUpstream(
  source: "llm" | "search",
  status: number | null,
  detail: string,
): string {
  const clean = detail.replace(/\s+/g, " ").trim().slice(0, 180);
  if (status) return clean ? `${source}: HTTP ${status} ${clean}` : `${source}: HTTP ${status}`;
  return `${source}: ${clean || "request failed"}`;
}

export function redactSecret(text: string, secret: string | undefined): string {
  const trimmed = secret?.trim();
  let safe = text;
  if (secret) safe = safe.replaceAll(secret, "[redacted]");
  if (trimmed && trimmed !== secret) safe = safe.replaceAll(trimmed, "[redacted]");
  return safe.replace(/\s+/g, " ").trim().slice(0, 180);
}
