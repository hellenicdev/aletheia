import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config";
import { completeJson } from "../src/llm";

describe("completeJson", () => {
  it("retries malformed output and then accepts valid JSON", async () => {
    const bodies: unknown[] = [];
    let calls = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      calls += 1;
      bodies.push(JSON.parse(String(init?.body)));
      const content = calls === 1 ? JSON.stringify({ nope: true }) : JSON.stringify({ ok: true });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const value = await completeJson({
      config: resolveConfig({ OPENAI_API_KEY: "test-key" }),
      apiKey: "test-key",
      system: "TASK:segment",
      user: "article",
      fetchImpl,
      validate: (data) => {
        if (!data || typeof data !== "object" || !("ok" in data)) throw new Error("missing ok");
        return data as { ok: boolean };
      },
    });

    expect(value.ok).toBe(true);
    expect(calls).toBe(2);
    expect((bodies[0] as { temperature: number }).temperature).toBe(0);
    expect((bodies[0] as { model: string }).model).toBe("Beam-501B-A23B");
    expect((bodies[1] as { messages: { content: string }[] }).messages.at(-1)?.content).toContain(
      "missing ok",
    );
  });

  it("does not echo the API key when the provider rejects it", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("bad key test-key-value", { status: 401 });
    await expect(
      completeJson({
        config: resolveConfig({}),
        apiKey: "test-key-value",
        system: "TASK:segment",
        user: "article",
        fetchImpl,
        validate: () => {
          throw new Error("unused");
        },
      }),
    ).rejects.toThrow(/rejected/);
  });
});
