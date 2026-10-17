import { describe, expect, it } from "vitest";
import { blendTone, passageTone } from "./tone";

describe("passageTone", () => {
  it("penalises loaded opinion wording and profanity", () => {
    const neutral = passageTone("The council voted 7 to 2 and published the minutes on Monday.");
    const loaded = passageTone("The ugly, ominously cheerful pitch is just vibes and grifting.");
    const profane = passageTone("Those sniveling feathered pricks can count their fucking days.");
    expect(neutral).toBe(100);
    expect(loaded).toBeLessThan(70);
    expect(profane).toBeLessThanOrEqual(58);
  });

  it("blends a rhetorical label into an otherwise neutral sentence", () => {
    const sentence = "The policy failed to keep the harbour open through the winter.";
    expect(passageTone(sentence)).toBe(100);
    expect(blendTone(sentence, "rhetorical")).toBeLessThanOrEqual(62);
    expect(blendTone(sentence, "loaded")).toBeLessThan(100);
  });

  it("penalises Greek insults", () => {
    expect(passageTone("Αυτό το σχέδιο είναι γελοίο και απαράδεκτο για κάθε κάτοικο της πόλης.")).toBeLessThan(80);
  });
});
