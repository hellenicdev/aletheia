import { describe, expect, it } from "vitest";
import { HttpError } from "../src/errors";
import { assertPublicHttpUrl, isBlockedHost } from "../src/ssrf";

describe("ssrf", () => {
  it("blocks loopback, link-local, and private hosts", () => {
    expect(isBlockedHost("localhost")).toBe(true);
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("10.1.2.3")).toBe(true);
    expect(isBlockedHost("192.168.0.8")).toBe(true);
    expect(isBlockedHost("172.16.4.1")).toBe(true);
    expect(isBlockedHost("169.254.169.254")).toBe(true);
    expect(isBlockedHost("metadata.google.internal")).toBe(true);
    expect(isBlockedHost("news.example")).toBe(false);
  });

  it("rejects non-http URLs", () => {
    expect(() => assertPublicHttpUrl("file:///etc/passwd")).toThrow(HttpError);
    expect(() => assertPublicHttpUrl("http://user:pass@news.example/a")).toThrow(HttpError);
  });
});
