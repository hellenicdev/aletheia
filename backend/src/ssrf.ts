import { HttpError } from "./errors";

export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "Enter a valid http(s) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HttpError(400, "Only http and https URLs can be fetched.");
  }
  if (url.username || url.password) {
    throw new HttpError(400, "URLs with embedded credentials are not allowed.");
  }
  if (isBlockedHost(url.hostname)) {
    throw new HttpError(400, "That address cannot be fetched.");
  }
  return url;
}

export function isBlockedHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    return true;
  }

  if (isBlockedIPv4(host)) return true;

  if (host.includes(":")) {
    // URL parsing canonicalizes dotted IPv4 tails and expanded IPv6 forms.
    // In particular, ::ffff:127.0.0.1 becomes ::ffff:7f00:1.
    let canonical: string;
    try {
      canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    } catch {
      return true;
    }
    if (canonical === "::" || canonical === "::1") return true;
    const first = Number.parseInt(canonical.split(":")[0] || "0", 16);
    if (
      (first & 0xfe00) === 0xfc00 ||
      (first & 0xffc0) === 0xfe80 ||
      (first & 0xffc0) === 0xfec0 ||
      (first & 0xff00) === 0xff00
    ) return true;
    const mapped = canonical.match(/^::ffff:([\da-f]+):([\da-f]+)$/);
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16);
      const low = Number.parseInt(mapped[2], 16);
      return isBlockedIPv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
    }
  }
  return false;
}

function isBlockedIPv4(host: string): boolean {
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return false;
  const parts = match.slice(1).map((part) => Number(part));
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}
