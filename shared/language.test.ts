import { describe, expect, it } from "vitest";
import { detectLanguage, languageMatches } from "./language";

describe("detectLanguage", () => {
  it("detects Greek and English", () => {
    expect(detectLanguage("Το συμβούλιο ψήφισε την αύξηση των τελών χθες το βράδυ.")).toBe("el");
    expect(detectLanguage("The council voted to raise the fee last night.")).toBe("en");
  });
});

describe("languageMatches", () => {
  it("requires the requested script", () => {
    expect(languageMatches("Τα πρακτικά καταγράφουν την ψηφοφορία.", "el")).toBe(true);
    expect(languageMatches("The minutes record the vote.", "el")).toBe(false);
    expect(languageMatches("The minutes record the vote.", "en")).toBe(true);
  });
});
