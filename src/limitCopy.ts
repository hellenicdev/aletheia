import { t, type MessageKey } from "./i18n";

const TIMED: Record<string, MessageKey> = {
  ip_burst: "rateLimitBurst",
  ip_daily: "rateLimitDaily",
  ip_concurrent: "rateLimitConcurrent",
  tavily_daily: "rateLimitCredits",
  tavily_monthly: "rateLimitCreditsMonth",
  global_busy: "rateLimitGlobal",
};

/** Friendly copy for a 429 or the limiter 503. Other errors return null. */
export function presentLimit(
  detail: { code?: string; status?: number; retryAfterSeconds?: number },
  lang: "en" | "el",
): string | null {
  if (detail.status === 503 || detail.code === "limiter_unavailable") {
    return t(lang, "rateLimitUnavailable");
  }
  const key = detail.code ? TIMED[detail.code] : undefined;
  if (!key) return null;
  const seconds = detail.retryAfterSeconds && detail.retryAfterSeconds > 0 ? detail.retryAfterSeconds : 60;
  return t(lang, key).replace("{time}", formatWait(seconds, lang));
}

function formatWait(seconds: number, lang: "en" | "el"): string {
  const minutes = Math.max(1, Math.ceil(Math.max(1, seconds) / 60));
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
