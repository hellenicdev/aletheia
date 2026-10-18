export const IP_BURST_LIMIT = 3;
export const IP_BURST_WINDOW_MS = 10 * 60 * 1000;
export const IP_DAILY_LIMIT = 15;
export const IP_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TAVILY_CREDITS_PER_ANALYSIS = 12;
export const TAVILY_DAILY_CREDITS = 120;
export const TAVILY_MONTHLY_CREDITS = 950;
/** A crashed isolate must not hold the per-IP lock forever. */
export const IN_FLIGHT_MS = 90_000;

export type RateCode =
  | "ok"
  | "ip_burst"
  | "ip_daily"
  | "ip_concurrent"
  | "tavily_daily"
  | "tavily_monthly"
  | "global_busy";

/** Fresh analyses across every client. Cache hits never reach this gate. */
export const GLOBAL_PER_MINUTE = 6;
export const GLOBAL_WINDOW_MS = 60_000;
export const GLOBAL_IN_FLIGHT = 2;

export interface RateDecision {
  ok: boolean;
  retryAfter: number;
  code: RateCode;
}

interface IpLedger {
  recent: number[];
  day: number[];
  inFlightUntil: number;
}

export interface RateBook {
  ips: Record<string, IpLedger>;
  creditsDate: string;
  creditsMonth: string;
  creditsUsed: number;
  creditsMonthUsed: number;
}

export interface ReserveInput {
  ip: string;
  now: number;
  credits: number;
  dailyCreditCap: number;
  /** Defaults to TAVILY_MONTHLY_CREDITS when a caller omits it. */
  monthlyCreditCap?: number;
}

export function emptyBook(now = 0): RateBook {
  return {
    ips: {},
    creditsDate: utcDate(now),
    creditsMonth: utcMonth(now),
    creditsUsed: 0,
    creditsMonthUsed: 0,
  };
}

export function applyReserve(book: RateBook, input: ReserveInput): { book: RateBook; decision: RateDecision } {
  const next = prune(structuredClone(book), input.now);
  rollCredits(next, input.now);
  const ledger = next.ips[input.ip] ?? { recent: [], day: [], inFlightUntil: 0 };
  const concurrent = ledger.inFlightUntil > input.now;
  if (concurrent) {
    next.ips[input.ip] = ledger;
    return {
      book: next,
      decision: { ok: false, code: "ip_concurrent", retryAfter: secondsUntil(ledger.inFlightUntil, input.now) },
    };
  }
  if (ledger.recent.length >= IP_BURST_LIMIT) {
    const retryAt = (ledger.recent[0] ?? input.now) + IP_BURST_WINDOW_MS;
    next.ips[input.ip] = ledger;
    return { book: next, decision: { ok: false, code: "ip_burst", retryAfter: secondsUntil(retryAt, input.now) } };
  }
  if (ledger.day.length >= IP_DAILY_LIMIT) {
    const retryAt = (ledger.day[0] ?? input.now) + IP_DAILY_WINDOW_MS;
    next.ips[input.ip] = ledger;
    return { book: next, decision: { ok: false, code: "ip_daily", retryAfter: secondsUntil(retryAt, input.now) } };
  }
  const monthlyCap = input.monthlyCreditCap ?? TAVILY_MONTHLY_CREDITS;
  if (input.credits > 0 && next.creditsMonthUsed + input.credits > monthlyCap) {
    return {
      book: next,
      decision: { ok: false, code: "tavily_monthly", retryAfter: secondsUntilUtcMonth(input.now) },
    };
  }
  if (input.credits > 0 && next.creditsUsed + input.credits > input.dailyCreditCap) {
    return {
      book: next,
      decision: { ok: false, code: "tavily_daily", retryAfter: secondsUntilUtcMidnight(input.now) },
    };
  }
  ledger.recent.push(input.now);
  ledger.day.push(input.now);
  ledger.inFlightUntil = input.now + IN_FLIGHT_MS;
  next.ips[input.ip] = ledger;
  if (input.credits > 0) {
    next.creditsUsed += input.credits;
    next.creditsMonthUsed += input.credits;
  }
  return { book: next, decision: { ok: true, code: "ok", retryAfter: 0 } };
}

/** Credit cap only. The per-IP Durable Object does not charge credits. */
export function chargeCredits(
  book: RateBook,
  input: { now: number; credits: number; dailyCreditCap: number; monthlyCreditCap?: number },
): { book: RateBook; decision: RateDecision } {
  const next = structuredClone(book);
  rollCredits(next, input.now);
  const monthlyCap = input.monthlyCreditCap ?? TAVILY_MONTHLY_CREDITS;
  if (input.credits > 0 && next.creditsMonthUsed + input.credits > monthlyCap) {
    return {
      book: next,
      decision: { ok: false, code: "tavily_monthly", retryAfter: secondsUntilUtcMonth(input.now) },
    };
  }
  if (input.credits > 0 && next.creditsUsed + input.credits > input.dailyCreditCap) {
    return {
      book: next,
      decision: { ok: false, code: "tavily_daily", retryAfter: secondsUntilUtcMidnight(input.now) },
    };
  }
  if (input.credits > 0) {
    next.creditsUsed += input.credits;
    next.creditsMonthUsed += input.credits;
  }
  return { book: next, decision: { ok: true, code: "ok", retryAfter: 0 } };
}

export function applyRelease(book: RateBook, ip: string, now: number): RateBook {
  const next = prune(structuredClone(book), now);
  const ledger = next.ips[ip];
  if (!ledger) return next;
  ledger.inFlightUntil = 0;
  return next;
}

/** Drop the reservation taken before a credit charge was refused or failed. */
export function applyRevert(book: RateBook, ip: string, now: number): RateBook {
  const next = structuredClone(book);
  const ledger = next.ips[ip];
  if (!ledger) return next;
  removeOnce(ledger.recent, now);
  removeOnce(ledger.day, now);
  ledger.inFlightUntil = 0;
  if (ledger.recent.length === 0 && ledger.day.length === 0) delete next.ips[ip];
  return next;
}

function removeOnce(values: number[], hit: number): void {
  const index = values.lastIndexOf(hit);
  if (index >= 0) values.splice(index, 1);
}

export interface RateGate {
  reserve(input: ReserveInput): RateDecision | Promise<RateDecision>;
  release(ip: string, now: number): void | Promise<void>;
}

export class MemoryRateGate implements RateGate {
  book: RateBook = emptyBook();

  reserve(input: ReserveInput): RateDecision {
    const applied = applyReserve(this.book, input);
    this.book = applied.book;
    return applied.decision;
  }

  release(ip: string, now: number): void {
    this.book = applyRelease(this.book, ip, now);
  }
}

export interface GlobalLedger {
  recent: number[];
  inFlightUntil: number[];
}

export function emptyGlobal(): GlobalLedger {
  return { recent: [], inFlightUntil: [] };
}

/**
 * Site-wide cap: 6 fresh analyses per minute and 2 in flight. A refusal does
 * not add a timestamp. Callers revert this reservation when a later check fails.
 */
export function reserveGlobal(ledger: GlobalLedger, now: number): { ledger: GlobalLedger; decision: RateDecision } {
  const next = pruneGlobal(structuredClone(ledger), now);
  const flying = next.inFlightUntil.filter((until) => until > now);
  if (flying.length >= GLOBAL_IN_FLIGHT) {
    const retryAt = Math.min(...flying);
    return {
      ledger: next,
      decision: { ok: false, code: "global_busy", retryAfter: secondsUntil(retryAt, now) },
    };
  }
  if (next.recent.length >= GLOBAL_PER_MINUTE) {
    const retryAt = (next.recent[0] ?? now) + GLOBAL_WINDOW_MS;
    return {
      ledger: next,
      decision: { ok: false, code: "global_busy", retryAfter: secondsUntil(retryAt, now) },
    };
  }
  next.recent.push(now);
  next.inFlightUntil.push(now + IN_FLIGHT_MS);
  return { ledger: next, decision: { ok: true, code: "ok", retryAfter: 0 } };
}

/** Drop the in-flight stamp taken at reservedAt. An expired stamp is already gone. */
export function releaseGlobal(ledger: GlobalLedger, reservedAt: number, now: number): GlobalLedger {
  const next = pruneGlobal(structuredClone(ledger), now);
  removeOnce(next.inFlightUntil, reservedAt + IN_FLIGHT_MS);
  return next;
}

/** Undo a reservation that a later per-IP or credit check refused. */
export function revertGlobal(ledger: GlobalLedger, reservedAt: number): GlobalLedger {
  const next = structuredClone(ledger);
  removeOnce(next.recent, reservedAt);
  removeOnce(next.inFlightUntil, reservedAt + IN_FLIGHT_MS);
  return next;
}

/**
 * Per-IP limiter key. IPv4 stays the full address. IPv6 shares one bucket per
 * /64, which is the network a privacy address rotates inside. IPv4-mapped
 * addresses use the embedded IPv4 so they share that client's bucket.
 */
export function clientLimitKey(ip: string): string {
  let value = ip.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (!value) return "anonymous";
  if (isIpv4(value)) return normaliseIpv4(value);
  const groups = expandIpv6(value);
  if (!groups) return value;
  const mapped = ipv4FromMapped(groups);
  if (mapped) return mapped;
  return `${groups.slice(0, 4).join(":")}/64`;
}

function isIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function normaliseIpv4(value: string): string {
  return value.split(".").map((part) => String(Number(part))).join(".");
}

function ipv4FromMapped(groups: string[]): string | null {
  const mapped = groups.slice(0, 5).every((group) => group === "0000") && groups[5] === "ffff";
  if (!mapped) return null;
  const hi = Number.parseInt(groups[6] ?? "", 16);
  const lo = Number.parseInt(groups[7] ?? "", 16);
  if (!Number.isFinite(hi) || !Number.isFinite(lo)) return null;
  return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
}

function expandIpv6(value: string): string[] | null {
  if (!value.includes(":")) return null;
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const head = parseIpv6Section(halves[0] ?? "");
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parseIpv6Section(halves[1] ?? "");
  if (!tail || head.length + tail.length > 8) return null;
  const zeros = Array.from({ length: 8 - head.length - tail.length }, () => "0000");
  return [...head, ...zeros, ...tail];
}

function parseIpv6Section(section: string): string[] | null {
  if (!section) return [];
  const parts = section.split(":");
  const groups: string[] = [];
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (part.includes(".")) {
      if (i !== parts.length - 1 || !isIpv4(part)) return null;
      const [a, b, c, d] = part.split(".").map(Number);
      groups.push(((a << 8) | b).toString(16).padStart(4, "0"));
      groups.push(((c << 8) | d).toString(16).padStart(4, "0"));
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(part.padStart(4, "0"));
  }
  return groups;
}

function pruneGlobal(ledger: GlobalLedger, now: number): GlobalLedger {
  ledger.recent = ledger.recent.filter((hit) => now - hit < GLOBAL_WINDOW_MS);
  ledger.inFlightUntil = ledger.inFlightUntil.filter((until) => until > now);
  return ledger;
}

export function rateLimitMessage(code: RateCode, retryAfter: number, lang: "en" | "el"): string {
  const time = formatWait(retryAfter, lang);
  if (code === "global_busy") {
    return lang === "el"
      ? `Η Αλήθεια είναι απασχολημένη με άλλες αναλύσεις. Δοκιμάστε ξανά σε ${time}.`
      : `Aletheia is busy with other analyses. Try again in ${time}.`;
  }
  if (code === "tavily_monthly") {
    return lang === "el"
      ? `Συμπληρώθηκε το μηνιαίο όριο. Δοκιμάστε ξανά τον επόμενο μήνα (${time}).`
      : `Monthly limit reached. Try again next month (${time}).`;
  }
  if (code === "tavily_daily") {
    return lang === "el"
      ? `Συμπληρώθηκε το ημερήσιο όριο. Δοκιμάστε ξανά αύριο (${time}).`
      : `Daily limit reached. Try again tomorrow (${time}).`;
  }
  if (code === "ip_daily") {
    return lang === "el"
      ? `Συμπληρώθηκε το ημερήσιο όριο αναλύσεων. Δοκιμάστε ξανά σε ${time}.`
      : `The daily analysis limit was reached. Try again in ${time}.`;
  }
  if (code === "ip_concurrent") {
    return lang === "el"
      ? `Μια ανάλυση εκτελείται ήδη από αυτό το δίκτυο. Δοκιμάστε ξανά σε ${time}.`
      : `An analysis is already running from this network. Try again in ${time}.`;
  }
  return lang === "el"
    ? `Πάρα πολλές αναλύσεις από αυτό το δίκτυο. Δοκιμάστε ξανά σε ${time}.`
    : `Too many analyses from this network. Try again in ${time}.`;
}

export function formatWait(seconds: number, lang: "en" | "el"): string {
  const safe = Math.max(1, Math.ceil(seconds));
  const minutes = Math.max(1, Math.ceil(safe / 60));
  if (minutes < 60) {
    if (lang === "el") return minutes === 1 ? "1 λεπτό" : `${minutes} λεπτά`;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) {
    if (lang === "el") return hours === 1 ? "1 ώρα" : `${hours} ώρες`;
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  const days = Math.ceil(hours / 24);
  if (lang === "el") return days === 1 ? "1 ημέρα" : `${days} ημέρες`;
  return days === 1 ? "1 day" : `${days} days`;
}

export function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function utcMonth(now: number): string {
  return utcDate(now).slice(0, 7);
}

function rollCredits(book: RateBook, now: number): void {
  const date = utcDate(now);
  const month = utcMonth(now);
  if (book.creditsMonth !== month) {
    book.creditsMonth = month;
    book.creditsMonthUsed = 0;
    book.creditsDate = date;
    book.creditsUsed = 0;
    return;
  }
  if (book.creditsDate !== date) {
    book.creditsDate = date;
    book.creditsUsed = 0;
  }
}

function prune(book: RateBook, now: number): RateBook {
  for (const [ip, ledger] of Object.entries(book.ips)) {
    ledger.recent = ledger.recent.filter((hit) => now - hit < IP_BURST_WINDOW_MS);
    ledger.day = ledger.day.filter((hit) => now - hit < IP_DAILY_WINDOW_MS);
    if (ledger.recent.length === 0 && ledger.day.length === 0 && ledger.inFlightUntil <= now) {
      delete book.ips[ip];
    }
  }
  return book;
}

function secondsUntil(at: number, now: number): number {
  return Math.max(1, Math.ceil((at - now) / 1000));
}

function secondsUntilUtcMidnight(now: number): number {
  const date = new Date(now);
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
  return secondsUntil(next, now);
}

function secondsUntilUtcMonth(now: number): number {
  const date = new Date(now);
  const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  return secondsUntil(next, now);
}
