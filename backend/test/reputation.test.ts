import { describe, expect, it } from "vitest";
import { evidenceSourceRank } from "../../shared/reputation";

describe("evidence source rank", () => {
  it("puts official and academic hosts ahead of news, and shops last", () => {
    const official = evidenceSourceRank("https://www.nih.gov/health/vaping-rates");
    const academic = evidenceSourceRank("https://www.ox.ac.uk/news/harbour-study");
    const news = evidenceSourceRank("https://www.bbc.com/news/articles/vaping");
    const shop = evidenceSourceRank("https://cheap-vape-shop.example/blog/nicotine");
    const coupons = evidenceSourceRank("https://www.retailmenot.com/view/kathimerini");
    const rehab = evidenceSourceRank("https://addictioncenter.com/nicotine");
    expect(official).toBeLessThan(news);
    expect(academic).toBeLessThan(news);
    expect(news).toBeLessThan(shop);
    expect(news).toBeLessThan(coupons);
    expect(news).toBeLessThan(rehab);
    expect(evidenceSourceRank("https://www.bbc.com/news/vaping-rates")).toBe(news);
  });
});
