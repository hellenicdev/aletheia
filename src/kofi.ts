/**
 * Ko-fi floating chat, drawn with the publisher's options.
 * The script is injected after load, on idle, so it stays off the critical path.
 */
export const KOFI_SRC = "https://storage.ko-fi.com/cdn/scripts/overlay-widget.js";

type KofiOverlay = {
  draw: (pageId: string, options: Record<string, string>) => void;
};

export function kofiButtonText(lang: "en" | "el"): string {
  return lang === "el" ? "Υποστήριξέ με" : "Support me";
}

export function kofiFrameTitle(lang: "en" | "el"): string {
  return lang === "el" ? "Υποστήριξέ με στο Ko-fi" : "Support me on Ko-fi";
}

export function kofiDrawOptions(lang: "en" | "el" = "en"): Record<string, string> {
  return {
    type: "floating-chat",
    "floating-chat.donateButton.text": kofiButtonText(lang),
    "floating-chat.donateButton.background-color": "#323842",
    "floating-chat.donateButton.text-color": "#fff",
  };
}

export function mountKofi(doc: Document = document, lang: "en" | "el" = "en"): void {
  if (doc.querySelector("script[data-kofi='hellenicdev']")) return;
  const script = doc.createElement("script");
  script.src = KOFI_SRC;
  script.async = true;
  script.dataset.kofi = "hellenicdev";
  script.addEventListener("load", () => {
    const overlay = (window as Window & { kofiWidgetOverlay?: KofiOverlay }).kofiWidgetOverlay;
    overlay?.draw("hellenicdev", kofiDrawOptions(lang));
    // The widget's button lives in an untitled iframe. Name it so the frame is not an accessibility failure.
    labelKofiFrames(doc, lang);
    window.setTimeout(() => labelKofiFrames(doc, lang), 500);
  });
  doc.body.append(script);
}

export function labelKofiFrames(doc: Document, lang: "en" | "el" = "en"): void {
  for (const frame of doc.querySelectorAll("iframe")) {
    if (!(frame instanceof HTMLIFrameElement)) continue;
    const owned =
      frame.id.startsWith("kofi-") ||
      frame.className.includes("floatingchat") ||
      frame.closest("[id^='kofi-widget-overlay']") !== null;
    if (!owned) continue;
    const title = kofiFrameTitle(lang);
    if (frame.title === title) continue;
    frame.title = title;
  }
}

export function scheduleKofi(target: Window = window, lang: "en" | "el" = "en"): void {
  const start = () => {
    const idle = target.requestIdleCallback?.bind(target);
    const run = () => mountKofi(target.document, lang);
    if (idle) idle(run, { timeout: 2000 });
    else target.setTimeout(run, 1);
  };
  if (target.document.readyState === "complete") start();
  else target.addEventListener("load", start, { once: true });
}
