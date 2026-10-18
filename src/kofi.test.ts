import { describe, expect, it } from "vitest";
import { kofiDrawOptions, KOFI_SRC } from "./kofi";

describe("kofi widget", () => {
  it("uses the publisher floating-chat snippet", () => {
    expect(KOFI_SRC).toBe("https://storage.ko-fi.com/cdn/scripts/overlay-widget.js");
    expect(kofiDrawOptions()).toEqual({
      type: "floating-chat",
      "floating-chat.donateButton.text": "Support me",
      "floating-chat.donateButton.background-color": "#323842",
      "floating-chat.donateButton.text-color": "#fff",
    });
  });
});
