import { describe, expect, it } from "vitest";
import {
  evaluativeDensity,
  inferClaimType,
  isAttributedClaim,
  isDateFiller,
  isPersonalAccount,
  looksLikeOpinionSection,
  opinionCueFromHtml,
  reconcileClaimType,
} from "./classify";

describe("inferClaimType", () => {
  it("keeps a dated place claim checkable and a slogan rhetorical", () => {
    expect(
      inferClaimType("The Eiffel Tower is located in Berlin and was completed in 1889."),
    ).toBe("checkable_factual");
    expect(
      inferClaimType(
        "It is, without doubt, the most breathtaking structure humanity has ever built.",
      ),
    ).toBe("rhetorical");
  });

  it("treats a value judgement as opinion and a dated opinion as mixed", () => {
    expect(inferClaimType("I think the waterfront deserves better lighting.")).toBe("opinion");
    expect(inferClaimType("I think the fee doubled in 2024.")).toBe("mixed");
    expect(inferClaimType("Savor that nectar now, you sniveling moth pricks.")).toBe("rhetorical");
    expect(
      inferClaimType("the White House's willingness to dump a client at a time of weakness"),
    ).toBe("opinion");
    expect(inferClaimType("Disabled people face a debilitating mess of bureaucracy.")).toBe("opinion");
  });

  it("keeps a local opinion label when the model called the sentence factual", () => {
    expect(
      reconcileClaimType("Savor that nectar now, you sniveling moth pricks.", "checkable_factual"),
    ).toBe("rhetorical");
    expect(reconcileClaimType("I think the fee doubled in 2024.", "checkable_factual")).toBe("mixed");
    expect(reconcileClaimType("The council voted 7 to 2.", "checkable_factual")).toBe("checkable_factual");
    expect(
      reconcileClaimType("\"I have been vaping for two years,\" said Maria, a teacher from Leeds.", "opinion"),
    ).toBe("personal");
  });

  it("treats a calendar aside as rhetorical and keeps a dated news claim", () => {
    expect(isDateFiller("But check the calendar and it is 2026.")).toBe(true);
    expect(inferClaimType("But check the calendar and it is 2026.")).toBe("rhetorical");
    expect(reconcileClaimType("But check the calendar and it is 2026.", "checkable_factual")).toBe(
      "rhetorical",
    );
    expect(inferClaimType("The council voted 7 to 2 in 2026 and published the minutes.")).toBe(
      "checkable_factual",
    );
  });

  it("treats reported testimony as an attributed claim, not the author's opinion", () => {
    const quote = "\"The ban starts in June,\" the health secretary said.";
    expect(isAttributedClaim(quote)).toBe(true);
    expect(inferClaimType(quote)).toBe("checkable_factual");
    expect(inferClaimType("I think the waterfront deserves better lighting.")).toBe("opinion");
    expect(isAttributedClaim("I think the fee doubled in 2024.")).toBe(false);
  });

  it("does not select personal testimony, an age anecdote, or a private story", () => {
    const quote = "\"I've been vaping for two years,\" said Maria, a teacher from Leeds.";
    expect(isPersonalAccount(quote)).toBe(true);
    expect(inferClaimType(quote)).toBe("personal");
    expect(reconcileClaimType(quote, "checkable_factual")).toBe("personal");
    expect(isPersonalAccount("A 26-year-old from Leeds said she started vaping at university.")).toBe(true);
    expect(
      isPersonalAccount("When vaping first took off at Gracey Mungulu's school, the habit looked like a fad."),
    ).toBe(true);
    const ageRange = "At 33, she falls in the age range most likely to vape.";
    expect(isPersonalAccount(ageRange)).toBe(true);
    expect(inferClaimType(ageRange)).toBe("personal");
    expect(isPersonalAccount("At 33 percent of adults smoke, according to the survey.")).toBe(false);
    const statistic = "4.9 million adults in the UK smoke, according to the health survey.";
    expect(isPersonalAccount(statistic)).toBe(false);
    expect(inferClaimType(statistic)).toBe("checkable_factual");
    const secretary = "\"The ban starts in June,\" the health secretary said.";
    expect(isPersonalAccount(secretary)).toBe(false);
    expect(inferClaimType(secretary)).toBe("checkable_factual");
    expect(isPersonalAccount("This betrayal will ruin everything we love.")).toBe(false);
    const chief = "\"We will count every butterfly,\" the EPA chief told reporters on Monday.";
    expect(isPersonalAccount(chief)).toBe(false);
    expect(inferClaimType(chief)).toBe("checkable_factual");
    expect(reconcileClaimType(chief, "personal")).toBe("checkable_factual");
    const archaeologist =
      "\"We are the first people to touch these objects,\" the archaeologist said at the site.";
    expect(isPersonalAccount(archaeologist)).toBe(false);
    expect(reconcileClaimType(archaeologist, "personal")).toBe("checkable_factual");
    const greek =
      "«Είμαστε οι πρώτοι που αγγίξαμε αυτά τα αντικείμενα», είπε ο αρχαιολόγος.";
    expect(isPersonalAccount(greek)).toBe(false);
    expect(inferClaimType(greek)).toBe("checkable_factual");
  });
});

describe("opinion section cues", () => {
  it("reads opinion paths and section kickers without flagging a news lead", () => {
    expect(looksLikeOpinionSection("https://www.ertnews.gr/apopseis/dimosio-vima/column", null, "Κείμενο.")).toBe(
      true,
    );
    expect(
      looksLikeOpinionSection(
        "https://www.ertnews.gr/eidiseis/diethni/i-eyropi-exei-kaysima-alla-oxi-anosia-sto-sok-ton-timon/",
        "Η Ευρώπη έχει καύσιμα",
        "Η συμφωνία αποδεσμεύει αποθέματα.",
      ),
    ).toBe(false);
    expect(
      opinionCueFromHtml(
        '<article class="post category-apopseis category-dimosio-vima category-eidiseis"><script type="application/ld+json">{"articleSection":["ΑΠΟΨΕΙΣ","ΕΙΔΗΣΕΙΣ","ΔΗΜΟΣΙΟ ΒΗΜΑ"]}</script><p>Κείμενο.</p></article>',
      ),
    ).toBe(true);
    expect(
      opinionCueFromHtml(
        '<nav><a class="menu-item" href="https://www.ertnews.gr/news/apopseis/">ΑΠΟΨΕΙΣ</a></nav><article class="category-eidiseis"><p>Είδηση.</p></article>',
      ),
    ).toBe(false);
    expect(looksLikeOpinionSection("https://www.theguardian.com/commentisfree/2026/oct/fees", null, "Fees rose.")).toBe(
      true,
    );
    expect(looksLikeOpinionSection(null, "Δημόσιο Βήμα: η συμφωνία", "Η κυβέρνηση ανακοίνωσε μέτρα.")).toBe(true);
    expect(
      looksLikeOpinionSection(
        "https://www.bbc.com/news/articles/vaping",
        "A million people vape",
        "Public opinion is divided, but the study counted a million people.",
      ),
    ).toBe(false);
  });

  it("needs several evaluative sentences before a news story becomes a column", () => {
    const column = [
      "I think the fee vote is a failure of compassion.",
      "We should freeze the charges until wages catch up.",
      "In my view the majority ignores the people on those boats.",
      "The harbour deserves a quieter season.",
      "The minutes do record a 7 to 2 vote on Monday.",
    ];
    expect(evaluativeDensity(column)).toBe(true);
    expect(
      evaluativeDensity([
        "The council voted 7 to 2.",
        "I think the fee is high.",
        "Twelve boats remain on the list.",
        "The change takes effect in May.",
      ]),
    ).toBe(false);
  });
});
