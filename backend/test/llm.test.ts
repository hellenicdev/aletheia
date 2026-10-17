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
    expect((bodies[0] as { max_completion_tokens: number }).max_completion_tokens).toBe(8192);
    expect(bodies[0] as { max_tokens?: number }).not.toHaveProperty("max_tokens");
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

  it("reads JSON after a think block and from reasoning_content when content is empty", async () => {
    let call = 0;
    const fetchImpl: typeof fetch = async () => {
      call += 1;
      const message =
        call === 1
          ? {
              content: '<think>draft {not the answer}</think>\n```json\n{"ok":true}\n```',
              reasoning_content: "ignored once content parses",
            }
          : { content: null, reasoning_content: 'Reasoning first. {"ok":true}' };
      return new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const validate = (data: unknown) => {
      if (!data || typeof data !== "object" || !("ok" in data)) throw new Error("missing ok");
      return data as { ok: boolean };
    };
    const first = await completeJson({
      config: resolveConfig({ OPENAI_API_KEY: "test-key" }),
      apiKey: "test-key",
      system: "TASK:segment",
      user: "article",
      fetchImpl,
      attempts: 1,
      validate,
    });
    const second = await completeJson({
      config: resolveConfig({ OPENAI_API_KEY: "test-key" }),
      apiKey: "test-key",
      system: "TASK:segment",
      user: "article",
      fetchImpl,
      attempts: 1,
      validate,
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  it("retries with max_tokens when max_completion_tokens is rejected", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if ("max_completion_tokens" in body) {
        return new Response("unknown parameter max_completion_tokens", { status: 400 });
      }
      return new Response(
        JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }] }),
        { status: 200 },
      );
    };
    const value = await completeJson({
      config: resolveConfig({ OPENAI_API_KEY: "test-key" }),
      apiKey: "test-key",
      system: "TASK:segment",
      user: "article",
      fetchImpl,
      attempts: 1,
      validate: (data) => data as { ok: boolean },
    });
    expect(value.ok).toBe(true);
    expect(bodies[0]).toHaveProperty("max_completion_tokens");
    expect(bodies[1]?.max_tokens).toBe(8192);
    expect(bodies[1]).not.toHaveProperty("max_completion_tokens");
  });

  it("joins text parts from array content", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: [{ text: '{"ok":' }, "true}"] },
            },
          ],
        }),
        { status: 200 },
      );
    const value = await completeJson({
      config: resolveConfig({ OPENAI_API_KEY: "test-key" }),
      apiKey: "test-key",
      system: "TASK:segment",
      user: "article",
      fetchImpl,
      attempts: 1,
      validate: (data) => data as { ok: boolean },
    });
    expect(value.ok).toBe(true);
  });

  it("names the field and finish reason without putting the raw preview in the error", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "length",
              message: { content: `{"ok":${"x".repeat(80)}` },
            },
          ],
        }),
        { status: 200 },
      );
    await expect(
      completeJson({
        config: resolveConfig({ OPENAI_API_KEY: "test-key" }),
        apiKey: "test-key",
        system: "TASK:segment",
        user: "article",
        fetchImpl,
        attempts: 1,
        validate: (data) => data as { ok: boolean },
      }),
    ).rejects.toThrow(/finish_reason length; field content(?![\s\S]*xxxxxxxx)/);
  });
});
