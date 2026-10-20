import { describe, expect, it, vi } from "vitest";
import { errorFields, logEvent, redactLog } from "../src/log";

describe("failure logs", () => {
  it("drops secrets, emails, and IP addresses", () => {
    expect(redactLog("bearer sk-live-secret from 203.0.113.8 user@example.com")).toBe(
      "bearer [redacted] from [redacted-ip] [redacted-email]",
    );
    expect(redactLog("api_key=super-secret")).toBe("[redacted]");
  });

  it("writes one JSON line with a stable kind and no stack", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    logEvent("limiter_reserve_failed", errorFields(new Error("token=abc at 198.51.100.4")));
    const line = String(error.mock.calls[0]?.[0]);
    const parsed = JSON.parse(line) as { event: string; kind: string; name: string; message: string };
    expect(parsed).toMatchObject({ event: "aletheia", kind: "limiter_reserve_failed", name: "Error" });
    expect(parsed.message).not.toContain("198.51.100.4");
    expect(parsed.message).not.toContain("abc");
    expect(line).not.toContain("stack");
    error.mockRestore();
  });
});
