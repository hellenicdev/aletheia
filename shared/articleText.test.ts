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

  it("drops datelines, photo credits, cookie copy, and repeated lines", () => {
    const raw = [
      "16, 2026, in San Diego.",
      "16, 2026, in San Diego.",
      "We use cookies to measure visits. Accept all cookies to continue browsing this video page today.",
      "",
      "The coastal plant received a federal loan that will fund the restart, according to the filing released on Monday.",
      "Photograph: Ada Lovelace/Getty",
      "",
      "The coastal plant received a federal loan that will fund the restart, according to the filing released on Monday.",
      "Operators said the work begins next year after the licence review is finished (AP Photo/Jane Doe).",
    ].join("\n");
    const text = cleanArticleText(raw);
    expect(text).toContain("federal loan");
    expect(text).toContain("licence review");
    expect(text).not.toContain("San Diego");
    expect(text).not.toContain("cookies");
    expect(text).not.toContain("Photograph");
    expect(text).not.toContain("AP Photo");
    expect(text.match(/federal loan/g)).toHaveLength(1);
  });
});
