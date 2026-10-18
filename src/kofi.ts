/**
 * Ko-fi floating chat, drawn with the publisher's options.
 * The script is injected after load, on idle, so it stays off the critical path.
 */
export const KOFI_SRC = "https://storage.ko-fi.com/cdn/scripts/overlay-widget.js";

type KofiOverlay = {
  draw: (pageId: string, options: Record<string, string>) => void;
};

export function kofiDrawOptions(): Record<string, string> {
  return {
    type: "floating-chat",
    "floating-chat.donateButton.text": "Support me",
    "floating-chat.donateButton.background-color": "#323842",
    "floating-chat.donateButton.text-color": "#fff",
  };
}

export function mountKofi(doc: Document = document): void {
  if (doc.querySelector("script[data-kofi='hellenicdev']")) return;
  const script = doc.createElement("script");
  script.src = KOFI_SRC;
  script.async = true;
  script.dataset.kofi = "hellenicdev";
  script.addEventListener("load", () => {
    const overlay = (window as Window & { kofiWidgetOverlay?: KofiOverlay }).kofiWidgetOverlay;
    overlay?.draw("hellenicdev", kofiDrawOptions());
    // The widget's button lives in an untitled iframe. Name it so the frame is not an accessibility failure.
    labelKofiFrames(doc);
    window.setTimeout(() => labelKofiFrames(doc), 500);
  });
  doc.body.append(script);
}

export function labelKofiFrames(doc: Document): void {
  for (const frame of doc.querySelectorAll("iframe")) {
    if (!(frame instanceof HTMLIFrameElement)) continue;
    const owned =
      frame.id.startsWith("kofi-") ||
      frame.className.includes("floatingchat") ||
      frame.closest("[id^='kofi-widget-overlay']") !== null;
    if (!owned || frame.title) continue;
    frame.title = "Support me on Ko-fi";
  }
}

export function scheduleKofi(target: Window = window): void {
  const start = () => {
    const idle = target.requestIdleCallback?.bind(target);
    if (idle) idle(() => mountKofi(target.document), { timeout: 2000 });
    else target.setTimeout(() => mountKofi(target.document), 1);
  };
  if (target.document.readyState === "complete") start();
  else target.addEventListener("load", start, { once: true });
}
