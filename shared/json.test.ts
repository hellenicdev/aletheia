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
});
