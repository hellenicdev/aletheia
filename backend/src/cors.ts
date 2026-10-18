export function corsHeaders(origin: string | null, allowed: string[]): Headers {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (origin && allowed.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Expose-Headers", "x-aletheia-cache");
    headers.set("Access-Control-Max-Age", "86400");
  }
  return headers;
}

export function jsonResponse(
  body: unknown,
  status: number,
  cors: Headers,
  extra?: Record<string, string>,
): Response {
  const headers = new Headers(cors);
  headers.set("Content-Type", "application/json; charset=utf-8");
  if (extra) {
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}
