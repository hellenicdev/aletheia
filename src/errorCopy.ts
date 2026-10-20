import { STALL_MESSAGE } from "./api";
import { t } from "./i18n";

export interface ShownError {
  message: string;
  retryable: boolean;
}

/**
 * Maps a stream or client failure onto the interface language.
 * Rate-limit copy is handled separately so a 429 keeps its wait time.
 */
export function presentStreamError(
  detail: { message: string; code?: string },
  lang: "en" | "el",
): ShownError | null {
  const message = detail.message.trim();
  const code = detail.code;
  if (code === "timeout" || /timed out before a verdict/i.test(message)) {
    return { message: t(lang, "errorTimeout"), retryable: true };
  }
  if (code === "interrupted" || /interrupted before a verdict/i.test(message)) {
    return { message: t(lang, "errorInterrupted"), retryable: true };
  }
  if (code === "analysis_failed" || message === "The analysis could not be completed.") {
    return { message: t(lang, "errorFailed"), retryable: true };
  }
  if (code === "stall" || message === STALL_MESSAGE) {
    return { message: t(lang, "errorStall"), retryable: true };
  }
  if (/ended without a result|response was empty/i.test(message)) {
    return { message: t(lang, "errorEmptyResult"), retryable: true };
  }
  if (/could not be read|browser check|paste the article|paste the text|επικολλήστε το κείμενο/i.test(message)) {
    return { message: t(lang, "scrapeFailed"), retryable: false };
  }
  if (/^\s*[{[]/.test(message)) {
    return { message: t(lang, "errorFailed"), retryable: true };
  }
  return null;
}
