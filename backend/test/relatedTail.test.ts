import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanupArticle, isSkippableFragment } from "../../shared/articleText";
import { splitSentences } from "../../shared/sentences";

const cases = [
  {
    file: "bbc-vaping-tail.md",
    headline: "panic-buy",
    also: "lie-ins",
    keep: "not considered a healthy",
  },
  {
    file: "guardian-opinion-tail.md",
    headline: "Andy Burnham",
    also: "Universal credit",
    keep: "safety net must hold",
  },
  {
    file: "onion-related-tail.md",
    headline: "Amelia Earhart",
    also: "Russia Diesel",
    keep: "count your fucking days",
  },
  {
    file: "kathimerini-tail.md",
    headline: "λαχανόρυζο",
    also: "Ινφαντίνο",
    keep: "καταφύγια",
  },
  {
    file: "in-tail.md",
    headline: "κάτω από τον πήχη",
    also: "σύνοδος κορυφής",
    keep: "Η ανεργία υποχώρησε",
  },
];

describe("related headline snapshots", () => {
  for (const item of cases) {
    it(`drops the related headlines in ${item.file}`, () => {
      const raw = readFileSync(new URL(`./fixtures/tails/${item.file}`, import.meta.url), "utf8");
      const before = splitSentences(raw).filter((span) => !isSkippableFragment(span.text)).length;
      const cleaned = cleanupArticle(raw);
      const after = splitSentences(cleaned.text).filter((span) => !isSkippableFragment(span.text)).length;
      expect(cleaned.text).toContain(item.keep);
      expect(cleaned.text).not.toContain(item.headline);
      expect(cleaned.text).not.toContain(item.also);
      expect(after).toBeLessThan(before);
      expect(cleaned.ignoredLines).toBeGreaterThan(0);
      expect({ file: item.file, before, after, ignored: cleaned.ignoredLines }).toMatchObject({
        file: item.file,
        before,
        after,
      });
    });
  }
});
