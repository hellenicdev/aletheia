/** OAuth 1.0a HMAC-SHA1 for api.x.com user context. The signing key never leaves this function. */

export interface OAuth1Material {
  method: string;
  url: string;
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
  /** Extra parameters that are part of the request, such as a form body. JSON bodies are not signed. */
  params?: Record<string, string>;
  nonce?: string;
  timestamp?: string;
}

export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function oauthBaseUrl(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

export function signatureBaseString(material: OAuth1Material, nonce: string, timestamp: string): string {
  const collected = new Map<string, string>();
  const parsed = new URL(material.url);
  parsed.searchParams.forEach((value, key) => collected.set(key, value));
  for (const [key, value] of Object.entries(material.params ?? {})) collected.set(key, value);
  collected.set("oauth_consumer_key", material.consumerKey);
  collected.set("oauth_nonce", nonce);
  collected.set("oauth_signature_method", "HMAC-SHA1");
  collected.set("oauth_timestamp", timestamp);
  collected.set("oauth_token", material.token);
  collected.set("oauth_version", "1.0");
  const pairs = [...collected.entries()]
    .map(([key, value]) => [percentEncode(key), percentEncode(value)] as const)
    .sort((left, right) => (left[0] === right[0] ? left[1].localeCompare(right[1]) : left[0].localeCompare(right[0])));
  const paramString = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  return `${material.method.toUpperCase()}&${percentEncode(oauthBaseUrl(material.url))}&${percentEncode(paramString)}`;
}

export async function oauth1Header(material: OAuth1Material): Promise<string> {
  const nonce = material.nonce ?? randomNonce();
  const timestamp = material.timestamp ?? String(Math.floor(Date.now() / 1000));
  const base = signatureBaseString(material, nonce, timestamp);
  const signingKey = `${percentEncode(material.consumerSecret)}&${percentEncode(material.tokenSecret)}`;
  const signature = await hmacSha1(signingKey, base);
  const fields: Array<[string, string]> = [
    ["oauth_consumer_key", material.consumerKey],
    ["oauth_nonce", nonce],
    ["oauth_signature", signature],
    ["oauth_signature_method", "HMAC-SHA1"],
    ["oauth_timestamp", timestamp],
    ["oauth_token", material.token],
    ["oauth_version", "1.0"],
  ];
  return `OAuth ${fields.map(([key, value]) => `${key}="${percentEncode(value)}"`).join(", ")}`;
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha1(key: string, text: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(text));
  const bytes = new Uint8Array(signed);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
