import { describe, expect, it } from "vitest";
import { compareClaims, pinHeadlineFirst } from "./rank";

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

  it("keeps the headline in the search set when later claims score higher", () => {
    const headline = {
      text: "Ίσως το αρχαιότερο ναυάγιο βρέθηκε στα ανοιχτά της Αττάλειας.",
      start: 0,
      importance: 1,
    };
    const later = Array.from({ length: 12 }, (_, index) => ({
      text: `Claim ${index} cites 1${index} million drachmas in a later paragraph of the dispatch.`,
      start: 200 + index,
      importance: 12,
    }));
    const pinned = pinHeadlineFirst([headline, ...later], headline.text, 12);
    expect(pinned).toHaveLength(12);
    expect(pinned[0]?.text).toBe(headline.text);
  });
});
