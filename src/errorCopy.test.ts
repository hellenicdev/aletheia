import { describe, expect, it } from "vitest";
import { presentStreamError } from "./errorCopy";
import { STALL_MESSAGE } from "./api";

describe("presentStreamError", () => {
  it("translates timeout, busy-adjacent failures, and unread pages", () => {
    const timedOut = presentStreamError({ message: "ignored", code: "timeout" }, "el");
    expect(timedOut?.message).toContain("ετυμηγορία");
    expect(presentStreamError({ message: "The analysis timed out before a verdict could be sent.", code: "timeout" }, "en")?.retryable).toBe(true);
    expect(presentStreamError({ message: STALL_MESSAGE }, "el")?.message).toContain("ενημερώσεις");
    expect(presentStreamError({ message: '{"error":"raw"}' }, "en")).toEqual({
      message: "The analysis could not be completed. Try again, or paste the article text.",
      retryable: true,
    });
    const unread = presentStreamError(
      { message: "This page could not be read. Paste the article text instead." },
      "el",
    );
    expect(unread?.message).toContain("Επικολλήστε");
    expect(unread?.retryable).toBe(false);
  });

  it("leaves ordinary validation text alone", () => {
    expect(presentStreamError({ message: "Paste an article or enter a URL." }, "en")).toBeNull();
  });
});
