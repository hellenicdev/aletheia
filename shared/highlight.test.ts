import { describe, expect, it } from "vitest";
import { renderHighlighted } from "./highlight";

describe("renderHighlighted", () => {
  it("escapes markup inside a highlighted claim", () => {
    const text = `Before <img src=x onerror=alert(1)> after`;
    const html = renderHighlighted(text, [
      { id: "s1", start: 7, end: text.indexOf(" after"), label: "False" },
    ]);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain('data-label="False"');
    expect(html).toContain('data-id="s1"');
  });

  it("skips overlapping ranges", () => {
    const text = "Alpha beta gamma";
    const html = renderHighlighted(text, [
      { id: "s1", start: 0, end: 10, label: "True" },
      { id: "s2", start: 6, end: 15, label: "False" },
    ]);
    expect(html.match(/data-id/g)).toHaveLength(1);
    expect(html).toContain("Alpha beta");
    expect(html).toContain("gamma");
  });
});
