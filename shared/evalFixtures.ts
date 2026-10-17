export interface EvalFixture {
  id: string;
  kind: "reputable" | "opinion" | "satire" | "low-credibility";
  domain: string | null;
  title: string;
  text: string;
  minOverall?: number;
  maxOverall?: number;
  expectOpinion?: boolean;
  maxTone?: number;
}

const reputable = `Harbour board raises berth fees from 800 to 880 euros.
The vote on Monday was 7 to 2, according to the published minutes.
Twelve boats remain on the waiting list.
The chair said the change takes effect in May.`;

const opinion = `I think the council's fee vote is a failure of compassion.
We should freeze berth charges until wages catch up.
The minutes do record a 7 to 2 vote on Monday.
In my view that majority still ignores the people who live on those boats.`;

const satire = `The harbour board told the gulls to count their fucking days.
Those sniveling feathered pricks will receive one giant rutabaga instead of fish.
Officials said the birds had been asking for it, the absolute bastards.`;

const lowCred = `The harbour vaccine deposits secret light codes that were designed to depopulate the marina.
Doctors are lying about the 7 to 2 vote, which never happened.
Only the medicine of pure sunlight can undo the assault on every family.`;

export const EVAL_FIXTURES: EvalFixture[] = [
  {
    id: "reputable-wire",
    kind: "reputable",
    domain: "apnews.com",
    title: "Harbour board raises berth fees",
    text: reputable,
    minOverall: 70,
  },
  {
    id: "opinion-column",
    kind: "opinion",
    domain: "theguardian.com",
    title: "The fee vote is a failure of compassion",
    text: opinion,
    expectOpinion: true,
  },
  {
    id: "satire-desk",
    kind: "satire",
    domain: "theonion.com",
    title: "Harbour board tells gulls to count their days",
    text: satire,
    maxOverall: 49,
    maxTone: 89,
  },
  {
    id: "low-credibility-health",
    kind: "low-credibility",
    domain: "naturalnews.com",
    title: "Harbour vaccine and the medicine of light",
    text: lowCred,
    maxOverall: 49,
  },
];
