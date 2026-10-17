import { describe, expect, it } from "vitest";
import { parseModelJson } from "./json";

describe("parseModelJson", () => {
  it("parses raw JSON", () => {
    expect(parseModelJson('{"ok":true}')).toEqual({ ok: true });
  });

  it("parses fenced JSON with a preamble", () => {
    const raw = "Here is the audit:\n```json\n{\"segments\":[]}\n```";
    expect(parseModelJson(raw)).toEqual({ segments: [] });
  });

  it("parses a JSON object that has trailing prose", () => {
    expect(parseModelJson('Note\n{"label":"True"}\nThanks')).toEqual({ label: "True" });
  });

  it("rejects an empty reply", () => {
    expect(() => parseModelJson("   ")).toThrow(/empty/);
  });

  it("strips think blocks and reads the first balanced object", () => {
    const raw = `<think>The brace { in reasoning is not the answer.</think>
Here is the object:
{"ok":true,"note":"a } brace and \\"quote\\""}
Thanks.`;
    expect(parseModelJson(raw)).toEqual({ ok: true, note: 'a } brace and "quote"' });
  });

  it("reads a JSON array after a fenced think-style preamble", () => {
    const raw = "<thinking>draft</thinking>\n```json\n[{\"id\":\"s1\"}]\n```";
    expect(parseModelJson(raw)).toEqual([{ id: "s1" }]);
  });

  it("rejects a truncated object", () => {
    expect(() => parseModelJson('{"ok":')).toThrow(/not valid JSON/);
  });

  it("skips a brace that is not JSON and reads the object after it", () => {
    expect(parseModelJson('Note {not json} then {"label":"False"}')).toEqual({ label: "False" });
  });
});
