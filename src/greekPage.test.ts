import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderGreekDocument } from "./greekPage";

describe("greek page", () => {
  it("emits Greek meta, lang, and a canonical /el/ URL", () => {
    const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const greek = renderGreekDocument(html);
    expect(greek).toContain("<html lang=\"el\">");
    expect(greek).toContain("<title>Αλήθεια — αξιοπιστία ειδήσεων</title>");
    expect(greek).toContain('rel="canonical" href="https://hellenicdev.eu/aletheia/el/"');
    expect(greek).toContain('property="og:url" content="https://hellenicdev.eu/aletheia/el/"');
    expect(greek).toContain('hreflang="el" href="https://hellenicdev.eu/aletheia/el/"');
    expect(greek).toContain('hreflang="en" href="https://hellenicdev.eu/aletheia/"');
    expect(greek).toContain('property="og:locale" content="el_GR"');
    expect(greek).toContain('property="og:locale:alternate" content="en_GB"');
    expect(greek).toContain("Το σήμα της Αλήθειας σε σκούρο φόντο");
    expect(greek).not.toContain("claim-level news credibility");
    expect(greek).toContain("gtag('consent', 'default'");
  });
});
