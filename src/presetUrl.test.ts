import { describe, expect, it } from "vitest";
import { presetArticleUrl } from "./presetUrl";

describe("presetArticleUrl", () => {
  it("reads an http(s) url parameter", () => {
    expect(presetArticleUrl("?url=https://www.reuters.com/world/story")).toBe("https://www.reuters.com/world/story");
    expect(presetArticleUrl("?lang=el&url=http://example.com/a")).toBe("http://example.com/a");
  });

  it("ignores missing and non-http values", () => {
    expect(presetArticleUrl("")).toBeNull();
    expect(presetArticleUrl("?url=javascript:alert(1)")).toBeNull();
    expect(presetArticleUrl("?demo=1")).toBeNull();
  });
});
