import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/index";
import { LIMITS } from "../src/limits";

function request(body: ReadableStream<Uint8Array>, length?: string): Request {
  const headers = new Headers({ Origin: "https://hellenicdev.eu" });
  if (length) headers.set("Content-Length", length);
  return new Request("https://worker.example/api/analyze", {
    method: "POST", headers, body, duplex: "half",
  } as RequestInit);
}

function chunks(...values: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}

const encode = (value: string) => new TextEncoder().encode(value);

describe("analysis request byte limit", () => {
  it.each([undefined, "1"])("stops an oversized stream with declared length %s", async (length) => {
    let reads = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++;
        if (reads > 8) { controller.close(); return; }
        controller.enqueue(new Uint8Array(20_001));
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const response = await handleRequest(request(body, length), {});
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Request body is too large." });
    expect(cancelled).toBe(true);
    expect(reads).toBe(4);
  });

  it("counts UTF-8 bytes rather than decoded characters", async () => {
    const raw = JSON.stringify({ ignored: "α".repeat(40_000) });
    expect(raw.length).toBeLessThan(LIMITS.maxBodyBytes);
    const response = await handleRequest(request(chunks(encode(raw))), {});
    expect(response.status).toBe(413);
  });

  it("accepts a body exactly at the limit, including split UTF-8 characters", async () => {
    const prefix = encode('{"ignored":"α');
    const raw = encode(JSON.stringify({ ignored: "α" + "a".repeat(LIMITS.maxBodyBytes - 16) }));
    expect(raw.byteLength).toBe(LIMITS.maxBodyBytes);
    const split = prefix.byteLength - 1;
    const response = await handleRequest(request(chunks(raw.slice(0, split), raw.slice(split))), {});
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Provide article text or a URL." });
  });
});
