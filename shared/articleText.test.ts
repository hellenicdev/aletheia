import { describe, expect, it } from "vitest";
import { cleanArticleText } from "./articleText";

describe("cleanArticleText", () => {
  it("drops navigation and keeps the article paragraphs", () => {
    const raw = [
      "Enable accessibility",
      "See All Newsletters",
      "World Politics Business",
      "navagio-1-1-1.png?",
      "",
      "The council voted 7 to 2 on Monday and published the full minutes for residents of the harbour district.",
      "",
      "Fees rose from 800 to 880 euros, and twelve boats remain on the waiting list after the harbour master signs the notice.",
    ].join("\n");
    const text = cleanArticleText(raw);
    expect(text).toContain("voted 7 to 2");
    expect(text).toContain("880 euros");
    expect(text).not.toContain("Enable accessibility");
    expect(text).not.toContain("Newsletters");
    expect(text).not.toContain("png");
  });
});
