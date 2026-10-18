export type OutletKind = "news" | "opinion" | "satire" | "low-credibility" | "unknown";

const SATIRE = [
  "theonion.com",
  "babylonbee.com",
  "clickhole.com",
  "thedailymash.co.uk",
  "waterfordwhispersnews.com",
  "newsthump.com",
  "thebeaverton.com",
  "theshovel.com.au",
  "thedailymash.com",
];

const LOW_CREDIBILITY = [
  "naturalnews.com",
  "infowars.com",
  "beforeitsnews.com",
  "worldnewsdailyreport.com",
  "newspunch.com",
  "yournewswire.com",
  "globalresearch.ca",
  "veteranstoday.com",
  "collective-evolution.com",
  "davidicke.com",
];

const SOCIAL = [
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "t.co",
  "tiktok.com",
  "reddit.com",
  "youtube.com",
  "youtu.be",
];

export function registrableHost(hostname: string): string {
  const host = hostname.replace(/^www\./, "").toLowerCase();
  const parts = host.split(".").filter(Boolean);
  const multi = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "co.jp", "com.gr", "com.br"]);
  if (parts.length >= 3 && multi.has(parts.slice(-2).join("."))) return parts.slice(-3).join(".");
  if (parts.length >= 2) return parts.slice(-2).join(".");
  return host;
}

export function hostOf(url: string): string | null {
  try {
    return registrableHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Country editions of the same newsroom. bbc.co.uk is not a second source for bbc.com. */
const OUTLET_FAMILIES = [
  ["bbc.com", "bbc.co.uk"],
  ["theguardian.com", "guardian.co.uk"],
];

export function sameOutlet(url: string, articleDomain: string | null): boolean {
  if (!articleDomain) return false;
  const source = hostOf(url);
  if (!source) return false;
  const article = registrableHost(articleDomain);
  if (source === article) return true;
  return OUTLET_FAMILIES.some((family) => family.includes(source) && family.includes(article));
}

export function outletFromDomain(domain: string | null | undefined): OutletKind | null {
  if (!domain) return null;
  const host = registrableHost(domain);
  if (SATIRE.some((item) => host === item || host.endsWith(`.${item}`))) return "satire";
  if (LOW_CREDIBILITY.some((item) => host === item || host.endsWith(`.${item}`))) return "low-credibility";
  return null;
}

export function isSocialHost(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  return SOCIAL.some((item) => host === item || host.endsWith(`.${item}`));
}

export function isUnreliableHost(url: string): boolean {
  const kind = outletFromDomain(hostOf(url));
  return kind === "satire" || kind === "low-credibility";
}

/** Hosts that must not support a factual label, without capping an article published there. */
const EVIDENCE_BLOCK = ["substack.com", "publichealthpolicyjournal.com"];

export function bareHostname(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

const COMMERCIAL_HOST =
  /(?:^|[.-])(?:vapes?|e-?cigs?|coupons?|promo-?codes?|retailmenot|slickdeals|groupon|addiction-?centers?|rehabs?|treatment-?centers?|casinos?|payday|affiliates?)(?:[.-]|$)|(?:^|\.)recovery\.com$/i;

/** Lower sorts first. Official and academic hosts outrank news, which outranks shops and lead-gen. */
export function evidenceSourceRank(url: string): number {
  const host = bareHostname(url) ?? "";
  if (isOfficialOrAcademic(host)) return 0;
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    path = "";
  }
  if (COMMERCIAL_HOST.test(host) || /\/(?:coupons?|promo-codes?|affiliate)\b/i.test(path)) return 2;
  return 1;
}

function isOfficialOrAcademic(host: string): boolean {
  return (
    host.endsWith(".gov") ||
    host.endsWith(".mil") ||
    host.endsWith(".edu") ||
    host.endsWith(".ac.uk") ||
    host.endsWith(".gov.uk") ||
    host.endsWith(".edu.au") ||
    host.endsWith(".gov.au") ||
    host === "who.int" ||
    host.endsWith(".who.int") ||
    host === "europa.eu" ||
    host.endsWith(".europa.eu")
  );
}

export function isBlockedEvidenceHost(url: string): boolean {
  if (isUnreliableHost(url)) return true;
  const host = hostOf(url);
  const bare = bareHostname(url);
  return EVIDENCE_BLOCK.some(
    (item) =>
      host === item ||
      bare === item ||
      Boolean(bare && (bare.endsWith(`.${item}`) || bare.startsWith(`${item}.`))),
  );
}

export function resolveOutlet(options: {
  domain: string | null;
  genre: string | null;
  tone: number;
}): OutletKind {
  const listed = outletFromDomain(options.domain);
  if (listed) return listed;
  if (options.genre === "satire" && options.tone < 75) return "satire";
  if (options.genre === "unreliable" && options.tone < 85) return "low-credibility";
  if (options.genre === "opinion") return "opinion";
  if (!options.domain) return "unknown";
  return "news";
}
