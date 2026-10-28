import { utcDate } from "./rateLimit";

export interface XUserCount {
  day: string;
  count: number;
}

/** Stored on the existing global TavilyCredits object, under the key `xbot`. */
export interface XBotState {
  sinceId: string | null;
  replied: string[];
  answered: Record<string, string[]>;
  users: Record<string, XUserCount>;
  denylist: string[];
  day: string;
  fresh: number;
  replies: number;
  rateLimitUntil: number;
}

export function emptyXBot(now: number): XBotState {
  return {
    sinceId: null,
    replied: [],
    answered: {},
    users: {},
    denylist: [],
    day: utcDate(now),
    fresh: 0,
    replies: 0,
    rateLimitUntil: 0,
  };
}

export function rollXBot(state: XBotState, now: number): XBotState {
  const day = utcDate(now);
  if (state.day === day) return state;
  return { ...state, day, fresh: 0, replies: 0 };
}

export function rememberId(ids: string[], id: string): string[] {
  if (ids.includes(id)) return ids;
  return [...ids, id].slice(-400);
}

export function laterId(current: string | null, next: string): string {
  if (!current) return next;
  try {
    return BigInt(next) > BigInt(current) ? next : current;
  } catch {
    return next > current ? next : current;
  }
}
