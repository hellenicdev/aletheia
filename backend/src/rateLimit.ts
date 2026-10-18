export const IP_BURST_LIMIT = 3;
export const IP_BURST_WINDOW_MS = 10 * 60 * 1000;
export const IP_DAILY_LIMIT = 15;
export const IP_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const TAVILY_CREDITS_PER_ANALYSIS = 12;
export const TAVILY_DAILY_CREDITS = 120;
export const TAVILY_MONTHLY_CREDITS = 950;
/** A crashed isolate must not hold the per-IP lock forever. */
export const IN_FLIGHT_MS = 90_000;

export type RateCode = "ok" | "ip_burst" | "ip_daily" | "ip_concurrent" | "tavily_daily" | "tavily_monthly";

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

export function applyRelease(book: RateBook, ip: string, now: number): RateBook {
  const next = prune(structuredClone(book), now);
  const ledger = next.ips[ip];
  if (!ledger) return next;
  ledger.inFlightUntil = 0;
  return next;
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

export function rateLimitMessage(code: RateCode, retryAfter: number, lang: "en" | "el"): string {
  const time = formatWait(retryAfter, lang);
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
