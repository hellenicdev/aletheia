import { describe, expect, it } from "vitest";
import { stabilizeQuery } from "./query";

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

  it("leaves a query that already has the entity and the figures", () => {
    const claim = "The council voted 7 to 2 on Monday and published the minutes.";
    const query = stabilizeQuery("council voted 7 to 2 Monday", claim, "en");
    expect(query).toContain("council");
    expect(query).toContain("7");
    expect(query).toContain("2");
  });
});
