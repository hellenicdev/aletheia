import { describe, expect, it } from "vitest";
import { documentMeta, languageUrl, langSearch, pageLangFromSearch, siteBase } from "./seo";

describe("seo", () => {
  it("describes the page in English and Greek", () => {
    const en = documentMeta("en", "https://hellenicdev.eu/aletheia/");
    const el = documentMeta("el", "https://hellenicdev.eu/aletheia/");
    expect(en.title).toBe("Aletheia — claim-level news credibility");
    expect(en.description).toBe(
      "Aletheia labels each claim in a news article and scores credibility from evidence, sourcing, tone, and consistency.",
    );
    expect(el.title).toBe("Αλήθεια — αξιοπιστία ειδήσεων");
    expect(el.description).toMatch(/[\u0370-\u03FF]/);
    expect(en.canonical).toBe("https://hellenicdev.eu/aletheia/");
    expect(el.canonical).toBe("https://hellenicdev.eu/aletheia/el/");
    expect(en.alternates.el).toBe(el.canonical);
    expect(el.alternates.en).toBe(en.canonical);
    expect(en.alternates["x-default"]).toBe(en.canonical);
    expect(en.image).toBe("https://hellenicdev.eu/aletheia/og.png");
    expect(en.imageAlt).toBe("Aletheia mark on a dark background");
    expect(el.imageAlt).toMatch(/[\u0370-\u03FF]/);
    expect(en.locale).toBe("en_GB");
    expect(el.locale).toBe("el_GR");
  });

  it("uses the production origin on the live host and the preview origin elsewhere", () => {
    expect(siteBase("hellenicdev.eu", "https://hellenicdev.eu", "/aletheia/")).toBe(
      "https://hellenicdev.eu/aletheia/",
    );
    expect(siteBase("127.0.0.1", "http://127.0.0.1:4173", "/aletheia/")).toBe(
      "http://127.0.0.1:4173/aletheia/",
    );
    expect(siteBase("localhost", "http://localhost:5173", "/")).toBe("http://localhost:5173/");
  });

  it("honours an explicit language parameter ahead of the stored language", () => {
    expect(pageLangFromSearch("?lang=el", "en", "en-US")).toBe("el");
    expect(pageLangFromSearch("?demo=1", "el", "el")).toBe("en");
    expect(pageLangFromSearch("", "el", "en-US", "/aletheia/el/")).toBe("el");
    expect(pageLangFromSearch("", "en", "en-US", "/el")).toBe("el");
    expect(pageLangFromSearch("", "el", "en-US")).toBe("el");
    expect(pageLangFromSearch("", null, "el-GR")).toBe("el");
    expect(langSearch("?demo=1", "el")).toBe("?demo=1");
    expect(langSearch("?lang=el&demo=1", "en")).toBe("?demo=1");
    expect(languageUrl("/aletheia/", "?lang=el", "el")).toBe("/aletheia/el/");
    expect(languageUrl("/aletheia/el/", "?lang=en", "en")).toBe("/aletheia/");
    expect(languageUrl("/", "?demo=el", "el")).toBe("/el/?demo=el");
    expect(languageUrl("/el/", "?lang=en&demo=el", "en")).toBe("/?demo=1");
  });
});
