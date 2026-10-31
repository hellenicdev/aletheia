import { describe, expect, it } from "vitest";
import { presetArticleUrl } from "./presetUrl";
import {
  prefersWebShare,
  reportPermalink,
  scoreBand,
  shareMessage,
  shareTarget,
} from "./share";

const article = "https://www.reuters.com/world/europe/story?id=1";
const production = { hostname: "hellenicdev.eu", origin: "https://hellenicdev.eu", pathname: "/aletheia/" };

describe("report permalink", () => {
  it("builds an English and a Greek cache link for the article URL", () => {
    const english = reportPermalink("en", article, production);
    const greek = reportPermalink("el", article, {
      hostname: "hellenicdev.eu",
      origin: "https://hellenicdev.eu",
      pathname: "/aletheia/el/",
    });
    expect(english).toBe(`https://hellenicdev.eu/aletheia/?url=${encodeURIComponent(article)}`);
    expect(greek).toBe(`https://hellenicdev.eu/aletheia/el/?url=${encodeURIComponent(article)}`);
    expect(presetArticleUrl(`?${new URL(english ?? "").searchParams.toString()}`)).toBe(article);
    expect(presetArticleUrl(new URL(greek ?? "").search)).toBe(article);
  });

  it("uses the local origin away from the production host", () => {
    expect(
      reportPermalink("en", article, { hostname: "localhost", origin: "http://localhost:5173", pathname: "/" }),
    ).toBe(`http://localhost:5173/?url=${encodeURIComponent(article)}`);
  });

  it("refuses a paste that has no public article URL", () => {
    expect(reportPermalink("en", "", production)).toBeNull();
    expect(reportPermalink("el", "not a url", production)).toBeNull();
  });
});

describe("share text and targets", () => {
  it("fills the score and the verdict label", () => {
    expect(shareMessage("Aletheia rated this article {score}/100: {band}", 62, "Mixed")).toBe(
      "Aletheia rated this article 62/100: Mixed",
    );
    expect(shareMessage("Η Αλήθεια βαθμολόγησε αυτό το άρθρο με {score}/100: {band}", 18, "Χαμηλή")).toContain(
      "18/100: Χαμηλή",
    );
  });

  it("puts the permalink on each channel", () => {
    const url = "https://hellenicdev.eu/aletheia/?url=https%3A%2F%2Fexample.com%2Fa";
    const text = "Aletheia rated this article 80/100: High";
    const targets = {
      x: shareTarget("x", text, url, "Aletheia report"),
      facebook: shareTarget("facebook", text, url, "Aletheia report"),
      linkedin: shareTarget("linkedin", text, url, "Aletheia report"),
      whatsapp: shareTarget("whatsapp", text, url, "Aletheia report"),
      telegram: shareTarget("telegram", text, url, "Aletheia report"),
      email: shareTarget("email", text, url, "Aletheia report"),
    };
    expect(targets.x).toContain("twitter.com/intent/tweet");
    expect(targets.x).toContain(encodeURIComponent(url));
    expect(targets.facebook).toContain("facebook.com/sharer/sharer.php");
    expect(targets.linkedin).toContain("linkedin.com/sharing/share-offsite");
    expect(targets.whatsapp).toContain("wa.me/?text=");
    expect(targets.telegram).toContain("t.me/share/url");
    expect(targets.email.startsWith("mailto:?")).toBe(true);
    for (const href of Object.values(targets)) expect(href).toContain(encodeURIComponent(url));
  });

  it("uses the system share sheet only for a coarse pointer", () => {
    expect(prefersWebShare({ canShare: true, coarsePointer: true })).toBe(true);
    expect(prefersWebShare({ canShare: true, coarsePointer: false })).toBe(false);
    expect(prefersWebShare({ canShare: false, coarsePointer: true })).toBe(false);
  });

  it("colours a score the same way as the gauge", () => {
    expect(scoreBand(80, false)).toBe("high");
    expect(scoreBand(60, false)).toBe("mid");
    expect(scoreBand(20, false)).toBe("low");
    expect(scoreBand(60, true)).toBe("provisional");
  });
});
