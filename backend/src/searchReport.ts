/** Configured search chain. This does not call Firecrawl or Tavily. */
export interface SearchReport {
  firecrawl: "configured" | "absent";
  tavily: "configured" | "absent";
  /** Firecrawl is first when its key is set. Tavily is the fallback, or the only provider. */
  order: Array<"firecrawl" | "tavily">;
  /**
   * What a fresh analysis will try. `firecrawl-then-tavily` means both keys are
   * set. A live 402 is not checked here.
   */
  active: "none" | "firecrawl" | "tavily" | "firecrawl-then-tavily";
  note: string;
}

export function searchReport(env: { FIRECRAWL_API_KEY?: string; TAVILY_API_KEY?: string }): SearchReport {
  const firecrawl = Boolean(env.FIRECRAWL_API_KEY?.trim());
  const tavily = Boolean(env.TAVILY_API_KEY?.trim());
  const order: Array<"firecrawl" | "tavily"> = [];
  if (firecrawl) order.push("firecrawl");
  if (tavily) order.push("tavily");
  const active = firecrawl && tavily ? "firecrawl-then-tavily" : firecrawl ? "firecrawl" : tavily ? "tavily" : "none";
  return {
    firecrawl: firecrawl ? "configured" : "absent",
    tavily: tavily ? "configured" : "absent",
    order,
    active,
    note: searchNote(active),
  };
}

function searchNote(active: SearchReport["active"]): string {
  if (active === "firecrawl-then-tavily") {
    return "Firecrawl is attempted first. A rejection, including HTTP 402, falls through to Tavily. This response does not call either provider.";
  }
  if (active === "tavily") return "Tavily is the only configured search provider. This response does not call it.";
  if (active === "firecrawl") return "Firecrawl is the only configured search provider. This response does not call it.";
  return "No search provider is configured.";
}
