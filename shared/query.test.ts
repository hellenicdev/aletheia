import { describe, expect, it } from "vitest";
import { deterministicQuery, queryCacheKey, stabilizeQuery } from "./query";

describe("stabilizeQuery", () => {
  it("keeps the named entity and the figure the model dropped", () => {
    const claim = "4.9 million adults in the UK smoke, according to the Office for National Statistics.";
    const query = stabilizeQuery("smoking habits survey", claim, "en");
    expect(query).toMatch(/4\.9/);
    expect(query.toLowerCase()).toMatch(/office|national|statistics/);
    expect(query.split(/\s+/).length).toBeLessThanOrEqual(12);
  });

  it("rewrites an English query for a Greek claim and keeps the number", () => {
    const claim = "4,9 εκατομμύρια ενήλικες στην Ελλάδα καπνίζουν σύμφωνα με την έρευνα υγείας.";
    const query = stabilizeQuery("adult smoking habits", claim, "el");
    expect(query).toMatch(/[\u0370-\u03FF]/);
    expect(query).toMatch(/4[,.]9/);
    expect(query.split(/\s+/).length).toBeLessThanOrEqual(12);
  });

  it("builds the same query from the claim text and includes the pipeline version in the cache key", () => {
    const claim = "5.4 million people aged 16 and over vape in Britain.";
    expect(deterministicQuery(claim, "en")).toBe(deterministicQuery(claim, "en"));
    expect(deterministicQuery(claim, "en")).toMatch(/5\.4/);
    expect(queryCacheKey(`  ${claim} `, "11")).toBe(queryCacheKey(claim, "11"));
    expect(queryCacheKey(claim, "11")).not.toBe(queryCacheKey(claim, "10"));
  });

  it("uses a Greek query for a Greek headline even when the article language is English", () => {
    const claim = "Ίσως το αρχαιότερο ναυάγιο που έχει εντοπιστεί στη Μεσόγειο βρέθηκε στα ανοιχτά της Αττάλειας.";
    const query = deterministicQuery(claim, "en");
    expect(query).toMatch(/[\u0370-\u03FF]/);
    expect(query).toMatch(/ναυάγιο|αρχαιότερο|Αττάλειας|Μεσόγειο/);
  });

  it("leaves a query that already has the entity and the figures", () => {
    const claim = "The council voted 7 to 2 on Monday and published the minutes.";
    const query = stabilizeQuery("council voted 7 to 2 Monday", claim, "en");
    expect(query).toContain("council");
    expect(query).toContain("7");
    expect(query).toContain("2");
  });
});
