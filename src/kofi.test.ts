import { describe, expect, it } from "vitest";
import { kofiButtonText, kofiDrawOptions, KOFI_BUTTON_FIT_CSS, KOFI_SRC } from "./kofi";

describe("kofi widget", () => {
  it("uses the publisher floating-chat snippet", () => {
    expect(KOFI_SRC).toBe("https://storage.ko-fi.com/cdn/scripts/overlay-widget.js");
    expect(kofiDrawOptions()).toEqual({
      type: "floating-chat",
      "floating-chat.donateButton.text": "Support me",
      "floating-chat.donateButton.background-color": "#323842",
      "floating-chat.donateButton.text-color": "#fff",
    });
    expect(kofiButtonText("el")).toBe("Στήριξέ με");
    expect(kofiDrawOptions("el")["floating-chat.donateButton.text"]).toBe("Στήριξέ με");
    expect(KOFI_BUTTON_FIT_CSS).toContain("overflow: hidden");
    expect(KOFI_BUTTON_FIT_CSS).toContain("nowrap");
  });
});
