import type { AnalysisResult } from "../../shared/types";
import { cacheApiAnalysisCache, normaliseAnalysisUrl, storeAnalysis, type AnalysisCache } from "./analysisCache";
import type { Env } from "./config";
import { errorFields, logEvent } from "./log";
import { bindDurableCaches, DurableRateGate } from "./rateLimiter";
import {
  TAVILY_CREDITS_PER_ANALYSIS,
  TAVILY_DAILY_CREDITS,
  TAVILY_MONTHLY_CREDITS,
  type RateGate,
} from "./rateLimit";
import { analyze as runAnalyze, type AnalyzeDeps, type AnalyzeInput } from "./pipeline";
import { articleLink, indexIncludes, isRetweet, isStop, mentionsHandle, replyLanguage, type MentionPage, type XPost } from "./xMentions";
import { oauth1Header } from "./xOauth";
import { formatMentionReply, stopReply } from "./xReply";
import { emptyXBot, laterId, rememberId, rollXBot, type XBotState } from "./xState";

const MENTIONS = "https://api.x.com/2/users";
const TWEETS = "https://api.x.com/2/tweets";

export interface XBotDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  analyze?: (input: AnalyzeInput, deps: AnalyzeDeps) => Promise<AnalysisResult>;
  gate?: RateGate;
  cache?: AnalysisCache;
  /** Test hook. Production reads and writes the TavilyCredits object. */
  state?: XBotState;
}

export function xBotReady(env: Env): boolean {
  if (env.X_BOT_ENABLED !== "true") return false;
  return [env.X_API_KEY, env.X_API_SECRET, env.X_ACCESS_TOKEN, env.X_ACCESS_SECRET, env.X_BOT_USER_ID, env.X_BOT_HANDLE].every(
    (value) => Boolean(value?.trim()),
  );
}

export async function runXBot(env: Env, deps: XBotDeps = {}): Promise<XBotState | null> {
  if (!xBotReady(env)) return deps.state ?? null;
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let state = rollXBot(deps.state ?? (await loadState(env, now())), now());
  if (state.rateLimitUntil > now()) {
    await saveState(env, state, deps.state);
    return state;
  }
  if (env.PIPELINE_CACHE) bindDurableCaches(env.PIPELINE_CACHE);
  const cache = deps.cache ?? cacheApiAnalysisCache();
  let page: MentionPage;
  try {
    const loaded = await getMentions(env, state.sinceId, fetchImpl);
    if (loaded.retry) {
      state = { ...state, rateLimitUntil: loaded.limitedUntil ?? now() + 60_000 };
      await saveState(env, state, deps.state);
      logEvent("x_bot_limited", { until: state.rateLimitUntil });
      return state;
    }
    page = loaded.page;
    if (loaded.limitedUntil) state = { ...state, rateLimitUntil: loaded.limitedUntil };
  } catch (error) {
    logEvent("x_bot_failed", errorFields(error));
    return state;
  }
  const included = indexIncludes(page);
  const posts = [...(page.data ?? [])].reverse();
  const caps = botCaps(env);
  for (const post of posts) {
    state = rollXBot(state, now());
    if (state.rateLimitUntil > now()) break;
    const outcome = await handleMention(env, deps, cache, state, post, included, caps, fetchImpl, now());
    state = outcome.state;
    if (outcome.stop) break;
  }
  await saveState(env, state, deps.state);
  return state;
}

interface Caps {
  fresh: number;
  perUser: number;
  replies: number;
}

function botCaps(env: Env): Caps {
  return {
    fresh: nonNegative(env.X_BOT_DAILY_CAP, 0),
    perUser: nonNegative(env.X_BOT_PER_USER_DAILY, 3),
    replies: nonNegative(env.X_BOT_MAX_REPLIES_DAILY, 30),
  };
}

async function handleMention(
  env: Env,
  deps: XBotDeps,
  cache: AnalysisCache,
  state: XBotState,
  post: XPost,
  included: Map<string, XPost>,
  caps: Caps,
  fetchImpl: typeof fetch,
  now: number,
): Promise<{ state: XBotState; stop: boolean }> {
  const handle = env.X_BOT_HANDLE?.trim() ?? "";
  const botId = env.X_BOT_USER_ID?.trim() ?? "";
  if (!post.id || state.replied.includes(post.id)) return { state, stop: false };
  const seen = (next: XBotState): XBotState => ({
    ...next,
    replied: rememberId(next.replied, post.id),
    sinceId: laterId(next.sinceId, post.id),
  });
  if (post.author_id && post.author_id === botId) return { state: seen(state), stop: false };
  if (isRetweet(post) || !mentionsHandle(post, handle)) return { state: seen(state), stop: false };
  const author = post.author_id ?? "anonymous";
  if (state.denylist.includes(author)) return { state: seen(state), stop: false };
  const lang = replyLanguage(post);
  if (isStop(post)) {
    if (state.replies >= caps.replies || userCount(state, author, now) >= caps.perUser) {
      return { state: seen(state), stop: false };
    }
    const posted = await postReply(env, post.id, stopReply(lang), fetchImpl);
    if (posted.limitedUntil) return { state: { ...state, rateLimitUntil: posted.limitedUntil }, stop: true };
    if (!posted.ok) return { state: seen(state), stop: false };
    return {
      state: seen({
        ...state,
        denylist: state.denylist.includes(author) ? state.denylist : [...state.denylist, author],
        replies: state.replies + 1,
        users: bumpUser(state, author, now),
      }),
      stop: false,
    };
  }
  const link = articleLink(post, included);
  if (!link) return { state: seen(state), stop: false };
  const normalised = normaliseAnalysisUrl(link);
  const conversation = post.conversation_id ?? post.id;
  if ((state.answered[conversation] ?? []).includes(normalised)) return { state: seen(state), stop: false };
  if (state.replies >= caps.replies || userCount(state, author, now) >= caps.perUser) {
    return { state: seen(state), stop: false };
  }
  const cached = await cache.get(link, lang);
  let result = cached;
  if (!result) {
    if (state.fresh >= caps.fresh) return { state: seen(state), stop: false };
    const reserved = await reserveFresh(env, deps, author, now);
    if (reserved === "retry") return { state, stop: true };
    if (reserved === "skip") return { state: seen(state), stop: false };
    try {
      result = await (deps.analyze ?? runAnalyze)(
        { url: link, uiLanguage: lang },
        { env, fetchImpl, requestId: `x:${post.id}` },
      );
    } catch (error) {
      logEvent("x_bot_failed", errorFields(error));
      return { state, stop: true };
    } finally {
      await reserved.release().catch((error) => logEvent("x_bot_failed", errorFields(error)));
    }
    state = { ...state, fresh: state.fresh + 1 };
    const write = storeAnalysis(cache, { url: link }, lang, result);
    if (write) await write.catch((error) => logEvent("x_bot_failed", errorFields(error)));
  }
  if (!result) return { state: seen(state), stop: false };
  const posted = await postReply(env, post.id, formatMentionReply(result, link, lang), fetchImpl);
  if (posted.limitedUntil) {
    return { state: { ...state, rateLimitUntil: posted.limitedUntil }, stop: true };
  }
  if (!posted.ok) return { state: seen(state), stop: false };
  const prior = state.answered[conversation] ?? [];
  return {
    state: seen({
      ...state,
      replies: state.replies + 1,
      users: bumpUser(state, author, now),
      answered: { ...state.answered, [conversation]: [...prior, normalised].slice(-20) },
    }),
    stop: false,
  };
}

async function reserveFresh(
  env: Env,
  deps: XBotDeps,
  author: string,
  now: number,
): Promise<{ release: () => Promise<void> } | "retry" | "skip"> {
  const gate = deps.gate ?? (env.IP_LIMITER && env.TAVILY_CREDITS ? new DurableRateGate(env.IP_LIMITER, env.TAVILY_CREDITS) : null);
  if (!gate) {
    logEvent("x_bot_unready", { reason: "limiter" });
    return "retry";
  }
  const credits = env.TAVILY_API_KEY?.trim() ? TAVILY_CREDITS_PER_ANALYSIS : 0;
  const decision = await gate.reserve({
    ip: `x:${author}`,
    now,
    credits,
    dailyCreditCap: positive(env.TAVILY_DAILY_CREDITS, TAVILY_DAILY_CREDITS),
    monthlyCreditCap: positive(env.TAVILY_MONTHLY_CREDITS, TAVILY_MONTHLY_CREDITS),
  });
  if (!decision.ok) {
    if (decision.code === "global_busy" || decision.code === "ip_burst" || decision.code === "ip_concurrent") return "retry";
    return "skip";
  }
  return {
    release: async () => {
      await gate.release(`x:${author}`, now);
    },
  };
}

async function getMentions(
  env: Env,
  sinceId: string | null,
  fetchImpl: typeof fetch,
): Promise<{ page: MentionPage; limitedUntil?: number; retry?: boolean }> {
  const params = new URLSearchParams({
    "tweet.fields": "entities,note_tweet,referenced_tweets,lang,author_id,conversation_id",
    expansions: "referenced_tweets.id",
    max_results: "10",
  });
  if (sinceId) params.set("since_id", sinceId);
  const url = `${MENTIONS}/${encodeURIComponent(env.X_BOT_USER_ID?.trim() ?? "")}/mentions?${params.toString()}`;
  const response = await fetchImpl(url, { headers: { Authorization: await authorization(env, "GET", url) } });
  const limitedUntil = limitUntil(response);
  if (response.status === 429) return { page: {}, retry: true, limitedUntil: limitedUntil ?? Date.now() + 60_000 };
  if (!response.ok) throw new Error(`x mentions HTTP ${response.status}`);
  return { page: (await response.json()) as MentionPage, limitedUntil: remainingBlocked(response) };
}

async function postReply(
  env: Env,
  mentionId: string,
  text: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; limitedUntil?: number }> {
  const response = await fetchImpl(TWEETS, {
    method: "POST",
    headers: {
      Authorization: await authorization(env, "POST", TWEETS),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text, reply: { in_reply_to_tweet_id: mentionId } }),
  });
  if (response.status === 429) return { ok: false, limitedUntil: limitUntil(response) ?? Date.now() + 60_000 };
  if (!response.ok) {
    logEvent("x_bot_reply_failed", { status: response.status });
    return { ok: false };
  }
  logEvent("x_bot_replied", { mention: mentionId });
  return { ok: true };
}

async function authorization(env: Env, method: string, url: string): Promise<string> {
  return oauth1Header({
    method,
    url,
    consumerKey: env.X_API_KEY?.trim() ?? "",
    consumerSecret: env.X_API_SECRET?.trim() ?? "",
    token: env.X_ACCESS_TOKEN?.trim() ?? "",
    tokenSecret: env.X_ACCESS_SECRET?.trim() ?? "",
  });
}

function limitUntil(response: Response): number | undefined {
  const reset = Number(response.headers.get("x-rate-limit-reset"));
  if (!Number.isFinite(reset) || reset <= 0) return undefined;
  return reset * 1000;
}

function remainingBlocked(response: Response): number | undefined {
  const remaining = Number(response.headers.get("x-rate-limit-remaining"));
  if (remaining !== 0) return undefined;
  return limitUntil(response);
}

function userCount(state: XBotState, author: string, now: number): number {
  const row = state.users[author];
  if (!row || row.day !== rollXBot(state, now).day) return 0;
  return row.count;
}

function bumpUser(state: XBotState, author: string, now: number): XBotState["users"] {
  const day = rollXBot(state, now).day;
  const count = userCount(state, author, now) + 1;
  return { ...state.users, [author]: { day, count } };
}

async function loadState(env: Env, now: number): Promise<XBotState> {
  if (!env.TAVILY_CREDITS) return emptyXBot(now);
  const stub = env.TAVILY_CREDITS.get(env.TAVILY_CREDITS.idFromName("global"));
  const response = await stub.fetch("https://credits.internal/xbot");
  if (!response.ok) return emptyXBot(now);
  const body = (await response.json()) as { state?: XBotState | null };
  return body.state ?? emptyXBot(now);
}

async function saveState(env: Env, state: XBotState, injected: XBotState | undefined): Promise<void> {
  if (injected) {
    Object.assign(injected, state);
    return;
  }
  if (!env.TAVILY_CREDITS) return;
  const stub = env.TAVILY_CREDITS.get(env.TAVILY_CREDITS.idFromName("global"));
  await stub.fetch("https://credits.internal/xbot", {
    method: "POST",
    body: JSON.stringify({ state }),
  });
}

function nonNegative(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

function positive(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}
