import { describe, expect, it } from "vitest";
import { alignSegments, splitPastedTitle, splitSentences } from "./sentences";

describe("splitSentences", () => {
  it("keeps abbreviations and decimals intact", () => {
    const text = "The U.S. economy grew by 2.5 percent. Later it slowed.";
    const parts = splitSentences(text).map((span) => span.text);
    expect(parts).toEqual(["The U.S. economy grew by 2.5 percent.", "Later it slowed."]);
  });

  it("splits Greek sentences including a Greek question mark", () => {
    const text = "Ο κ. Παπαδόπουλος μίλησε χθες. Είναι δίκαιη αυτή η αύξηση;";
    const parts = splitSentences(text).map((span) => span.text);
    expect(parts).toEqual([
      "Ο κ. Παπαδόπουλος μίλησε χθες.",
      "Είναι δίκαιη αυτή η αύξηση;",
    ]);
  });

  it("does not split domains, ranks, or abbreviations", () => {
    const text =
      "Read more at kathimerini.gr today. Coast Guard Lt. Santiago Tamburini led the rescue. See https://www.bbc.com/news later.";
    const parts = splitSentences(text).map((span) => span.text);
    expect(parts).toEqual([
      "Read more at kathimerini.gr today.",
      "Coast Guard Lt. Santiago Tamburini led the rescue.",
      "See https://www.bbc.com/news later.",
    ]);
  });

  it("returns offsets that match the source", () => {
    const text = "First claim here. Second claim here.";
    for (const span of splitSentences(text)) {
      expect(text.slice(span.start, span.end)).toBe(span.text);
    }
  });
});

describe("alignSegments", () => {
  it("places exact excerpts and ignores invented wording", () => {
    const article = "Alpha happened on Monday. Beta did not.";
    const aligned = alignSegments(article, [
      { text: "Alpha happened on Monday." },
      { text: "This sentence was rewritten." },
      { text: "Beta did not." },
    ]);
    expect(aligned.map((span) => span.text)).toEqual([
      "Alpha happened on Monday.",
      "Beta did not.",
    ]);
  });

  it("falls back to sentences when the model misses the article", () => {
    const article = "One real sentence stands alone. Another follows it closely.";
    const aligned = alignSegments(article, [{ text: "Completely different wording from a model." }]);
    expect(aligned.length).toBe(2);
  });
});

describe("splitPastedTitle", () => {
  it("lifts a short heading separated by a blank line", () => {
    const split = splitPastedTitle("Harbour lights\n\nThe council voted last night and published the minutes.");
    expect(split.title).toBe("Harbour lights");
    expect(split.body.startsWith("The council")).toBe(true);
  });

  it("leaves a normal paragraph alone", () => {
    const text = "The council voted last night. The minutes were published the next morning for residents.";
    expect(splitPastedTitle(text)).toEqual({ title: null, body: text });
  });
});
