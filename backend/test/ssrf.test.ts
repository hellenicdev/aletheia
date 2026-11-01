import { describe, expect, it, vi } from "vitest";
import { fetchArticle } from "../src/extract";
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

  it.each([
    "[::ffff:127.0.0.1]", "[::ffff:169.254.169.254]",
    "[::ffff:10.1.2.3]", "[::ffff:192.168.1.1]", "[::ffff:172.16.0.1]",
    "[0:0:0:0:0:ffff:7f00:1]", "[::]", "[0:0:0:0:0:0:0:1]",
    "[fe80::1]", "[fe90::1]", "[febf::1]", "[fc00::1]", "[fd00::1]",
    "[fec0::1]", "[ff02::1]",
  ])("rejects non-public IPv6 URL %s", (host) => {
    expect(() => assertPublicHttpUrl(`http://${host}/article`)).toThrow(HttpError);
  });

  it.each(["[2606:4700:4700::1111]", "[::ffff:8.8.8.8]"])(
    "allows public IPv6 URL %s", (host) => {
      expect(() => assertPublicHttpUrl(`https://${host}/article`)).not.toThrow();
    },
  );

  it("rejects mapped loopback before calling a scraping provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(fetchArticle("http://[::ffff:127.0.0.1]/", fetchImpl, "test-key"))
      .rejects.toThrow("That address cannot be fetched.");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not follow a public page redirect to mapped metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, {
      status: 302, headers: { location: "http://[::ffff:169.254.169.254]/" },
    }));
    await expect(fetchArticle("https://news.example/story", fetchImpl))
      .rejects.toThrow("That address cannot be fetched.");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://news.example/story");
  });

  it("rejects non-http URLs", () => {
    expect(() => assertPublicHttpUrl("file:///etc/passwd")).toThrow(HttpError);
    expect(() => assertPublicHttpUrl("http://user:pass@news.example/a")).toThrow(HttpError);
  });
});
