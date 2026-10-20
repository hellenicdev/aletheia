import { describe, expect, it } from "vitest";
import { searchReport } from "../src/searchReport";

describe("searchReport", () => {
  it("names the fallback chain when both keys are set", () => {
    expect(searchReport({ FIRECRAWL_API_KEY: "fc", TAVILY_API_KEY: "tv" })).toEqual({
      firecrawl: "configured",
      tavily: "configured",
      order: ["firecrawl", "tavily"],
      active: "firecrawl-then-tavily",
      note: expect.stringContaining("HTTP 402"),
    });
  });

  it("names a single provider, and none when both keys are missing", () => {
    expect(searchReport({ TAVILY_API_KEY: "tv" }).active).toBe("tavily");
    expect(searchReport({ FIRECRAWL_API_KEY: "fc" }).active).toBe("firecrawl");
    expect(searchReport({}).active).toBe("none");
    expect(searchReport({ FIRECRAWL_API_KEY: "  ", TAVILY_API_KEY: "" }).active).toBe("none");
  });
});
