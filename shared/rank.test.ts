import { describe, expect, it } from "vitest";
import { compareClaims } from "./rank";

describe("compareClaims", () => {
  it("sorts by importance, then position, then text", () => {
    const claims = [
      { importance: 4, start: 20, text: "Zebra claim about the harbour fee tonight." },
      { importance: 4, start: 20, text: "Alpha claim about the harbour fee tonight." },
      { importance: 9, start: 80, text: "Later but more important claim about the vote." },
      { importance: 4, start: 5, text: "Earlier claim about the same harbour fee." },
    ];
    const sorted = [...claims].sort(compareClaims);
    expect(sorted.map((item) => item.text[0])).toEqual(["L", "E", "A", "Z"]);
  });
});
