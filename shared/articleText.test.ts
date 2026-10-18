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

  it("drops cookie, newsletter, and menu boilerplate, including a menu glued to a headline", () => {
    const raw = [
      "Essential cookies enable basic functions of the site and remember the choices you make.",
      "Google Tag Manager simplifies tag deployment for the newsroom and its partners.",
      "Our personalization engine recommends more stories from the politics desk.",
      "Get email alerts when this story is updated throughout the day.",
      "",
      "Η κυβέρνηση ανακοίνωσε νέο πλαίσιο για τον τουρισμό μετά τη σύνοδο. Εκδόσεις Καθημερινής Reimagine Tourism πακέτα για επισκέπτες.",
      "",
      "The coastal plant received a federal loan that will fund the restart, according to the filing released on Monday.",
      "",
      "Operators said the licence review finishes next spring after the board signs the notice.",
      "",
      "References",
      "Smith J. A short citation.",
      "Popular articles",
      "Another harbour story from last year",
      "",
      "A later paragraph that looks like prose but sits after the article end marker and must be dropped from the body.",
    ].join("\n");
    const text = cleanArticleText(raw);
    expect(text).toContain("τουρισμό");
    expect(text).not.toContain("Reimagine Tourism");
    expect(text).not.toContain("Essential cookies");
    expect(text).not.toContain("Google Tag Manager");
    expect(text).not.toContain("personalization engine");
    expect(text).not.toContain("email alerts");
    expect(text).not.toContain("Smith");
    expect(text).not.toContain("Another harbour");
    expect(text).not.toContain("end marker");
    expect(text).toContain("federal loan");
    expect(text).toContain("licence review");
  });

  it("drops list-like link titles and anything after an end marker", () => {
    const raw = [
      "The coastal plant received a federal loan that will fund the restart, according to the filing released on Monday.",
      "",
      "Decentralize.TV – Episode 166.",
      "Brighteon.TV – Episode 12 – BrighteonBroadcast",
      "",
      "Operators said the licence review finishes next spring after the board signs the notice.",
      "",
      "Related articles",
      "Another harbour story from last year that should not be scored.",
      "",
      "A later paragraph that looks like prose but sits after the article end marker and must be dropped.",
    ].join("\n");
    const text = cleanArticleText(raw);
    expect(text).toContain("federal loan");
    expect(text).toContain("licence review");
    expect(text).not.toContain("Decentralize");
    expect(text).not.toContain("Brighteon");
    expect(text).not.toContain("Episode");
    expect(text).not.toContain("Another harbour");
    expect(text).not.toContain("end marker");
  });

  it("drops an episode promo glued to the front of the article", () => {
    const raw = [
      "Decentralize.TV – Episode 166 The coastal plant received a federal loan that will fund the restart, according to the filing released on Monday.",
      "Brighteon.TV – Episode 12 – BrighteonBroadcast",
      "Decentralize.TV – Episode 166 " + "Store promo banner ".repeat(12),
    ].join("\n");
    const text = cleanArticleText(raw);
    expect(text).toContain("federal loan");
    expect(text).not.toContain("Decentralize");
    expect(text).not.toContain("Episode 166");
    expect(text).not.toContain("Brighteon");
    const prose =
      "The committee discussed episode 166 of the series during a hearing that lasted two hours and produced a written report for the board.";
    expect(cleanArticleText(prose)).toContain("written report");
  });

  it("keeps a Greek opinion kicker and drops the related-story list under it", () => {
    const raw = [
      "Άποψη",
      "",
      "Η κυβέρνηση ανακοίνωσε νέο πλαίσιο για τον τουρισμό μετά τη σύνοδο των υπουργών.",
      "",
      "Διαβάστε επίσης",
      "Ανακαλύφθηκε στη Σικελία άλλο ναυάγιο που δεν ανήκει σε αυτό το κείμενο.",
    ].join("\n");
    const text = cleanArticleText(raw);
    expect(text).toContain("τουρισμό");
    expect(text).not.toContain("Σικελία");
  });
});
