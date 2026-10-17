import { describe, expect, it } from "vitest";
import { acceptContradiction } from "./consistency";

const vote = "The council voted 7 to 2 on Monday.";
const otherVote = "The council voted 4 to 5 on Monday.";

describe("acceptContradiction", () => {
  it("keeps a quoted pair about the same vote and drops a pair that does not quote", () => {
    const claims = [
      { id: "s1", text: vote },
      { id: "s2", text: otherVote },
    ];
    expect(
      acceptContradiction(
        {
          a: "s1",
          b: "s2",
          explanation:
            '"The council voted 7 to 2 on Monday" cannot also be true if "the council voted 4 to 5 on Monday" because both describe that same vote.',
        },
        claims,
      ),
    ).toBe(true);
    expect(
      acceptContradiction(
        {
          a: "s1",
          b: "s2",
          explanation: "These two claims contradict each other directly.",
        },
        claims,
      ),
    ).toBe(false);
  });

  it("rejects compatible parts and two different people", () => {
    expect(
      acceptContradiction(
        {
          a: "s1",
          b: "s2",
          explanation:
            '"Some amphorae remain on the seabed" does not rule out that "others were raised last spring" because both can be true.',
        },
        [
          { id: "s1", text: "Some amphorae remain on the seabed beside the wreck." },
          { id: "s2", text: "Others were raised last spring and taken to the museum." },
        ],
      ),
    ).toBe(false);

    expect(
      acceptContradiction(
        {
          a: "s1",
          b: "s2",
          explanation:
            '"A 21-year-old woman was arrested" is not the same person as "a 33-year-old woman was arrested" so this is not a contradiction.',
        },
        [
          { id: "s1", text: "A 21-year-old woman was arrested near the station on Tuesday." },
          { id: "s2", text: "A 33-year-old woman was arrested near the station on Tuesday." },
        ],
      ),
    ).toBe(false);

    expect(
      acceptContradiction(
        {
          a: "s1",
          b: "s2",
          explanation:
            '"The wreck sank in 1960" refers to a different year than "the wreck sank in 1974" so the dates are not the same event.',
        },
        [
          { id: "s1", text: "The wreck sank in 1960 off the southern coast." },
          { id: "s2", text: "The wreck sank in 1974 off the southern coast." },
        ],
      ),
    ).toBe(false);
  });
});
