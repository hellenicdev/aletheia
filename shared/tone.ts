interface ToneRule {
  pattern: RegExp;
  weight: number;
}

const RULES: ToneRule[] = [
  {
    pattern:
      /\b(?:fuck(?:ing|er|ed|ers)?|motherfuck(?:er|ing)?|shit(?:ty|ting)?|bullshit|asshole|bastard|prick|bitch|cunt|dick|wtf|dumbass)\b/gi,
    weight: 3,
  },
  {
    pattern:
      /(?:γαμ\p{L}*|σκατ\p{L}*|μαλακ\p{L}*|πουστ\p{L}*|κωλο\p{L}*|μπουρδελ\p{L}*|αρχίδ\p{L}*|πουτάν\p{L}*|καριόλ\p{L}*|χεστ\p{L}*)/giu,
    weight: 3,
  },
  {
    pattern:
      /\b(?:snivel(?:ing|ling)?|idiot|moron|stupid|scum|disgusting|outrageous|vile|ugly|grift(?:ing|er|ers)?|ominously|ominous|deception|deceive|deceit|shocking|shockingly|vibes|pathetic|sleazy|crooked|liar|lying|fraud|fraudulent|scam|hoax|propaganda|brainwash(?:ed|ing)?|ridiculous|absurd|insane|corrupt|corruption|nasty|gross|trash|garbage|clown|clowns|joke|kidding|laughable|unbelievable|stunning|explosive|slammed|blasted|raging|rage|furious|outrage|nightmare|disaster|catastrophic|apocalyptic|evil|wicked|sickening|shameful|disgrace|disgraceful|humiliating|insult|insulting|smear|smears|witch-hunt|cover-up|coverup)\b/gi,
    weight: 2,
  },
  {
    pattern:
      /(?:ηλίθι\p{L}*|απαράδεκτ\p{L}*|αισχρ\p{L}*|κατάπτυστ\p{L}*|αηδί\p{L}*|βρωμ\p{L}*|απατεών\p{L}*|ξεφτίλ\p{L}*|γελοί\p{L}*|ανόητ\p{L}*|εξαπάτ\p{L}*|φρικτ\p{L}*|εμετ\p{L}*|αίσχος|ντροπή|προπαγάνδ\p{L}*|σκάνδαλ\p{L}*|απάτη|διασύρ\p{L}*|χυδαί\p{L}*|προδοσ\p{L}*|προδότ\p{L}*)/giu,
    weight: 2,
  },
  {
    pattern:
      /\b(?:yeah right|as if|oh please|give me a break|what a joke|just vibes|surely you|how dare|so-called|supposedly shocking)\b/gi,
    weight: 2,
  },
  { pattern: /(?:δήθεν|τάχα|καλά κρασιά|τι ωραία|σιγά μην|πλάκα κάν)/giu, weight: 2 },
  { pattern: /\b(?:damn|crap|hellish|horrific|terrifying|breathtaking|undoubtedly|shockingly honest)\b/gi, weight: 1 },
  { pattern: /\bwithout (?:a )?doubt\b/gi, weight: 1 },
  { pattern: /(?:αναμφίβολα|συγκλονιστ\p{L}*|χωρίς αμφιβολία|αδιανόητ\p{L}*|τεράστι\p{L}* σκάνδαλ)/giu, weight: 1 },
  { pattern: /\b(?:utterly|absolutely|extremely)\b/gi, weight: 1 },
  { pattern: /(?:απολύτως|εντελώς)/giu, weight: 1 },
];

/** 100 is neutral. Loaded language, insults, and profanity pull the number down. */
export function passageTone(text: string): number {
  let weight = 0;
  for (const rule of RULES) {
    const matches = text.match(rule.pattern);
    if (matches) weight += rule.weight * matches.length;
  }
  const question = /[?]/.test(text) || (/;/.test(text) && /[\u0370-\u03FF]/.test(text));
  if (question && /\b(?:why|how dare|what kind|γιατί|πώς τολμ)/i.test(text)) weight += 1.5;
  const words = Math.max(1, text.trim().split(/\s+/).filter(Boolean).length);
  const density = (weight / words) * 12;
  const score = clamp(Math.round(100 - density * 22), 5, 100);
  if (weight >= 3) return clamp(Math.min(score, 58), 5, 100);
  return score;
}

export type Rhetoric = "neutral" | "loaded" | "rhetorical";

/** Lexicon score, pulled down when the model has already called the passage rhetorical or mixed. */
export function blendTone(text: string, rhetoric: Rhetoric = "neutral"): number {
  const base = passageTone(text);
  if (rhetoric === "rhetorical") return clamp(Math.min(base, 62), 5, 100);
  if (rhetoric === "loaded") return clamp(Math.round(base * 0.84), 5, 100);
  return base;
}

export function combineTone(passages: string[]): number {
  const scored = passages.map((passage) => passageTone(passage)).filter((value) => Number.isFinite(value));
  if (scored.length === 0) return 100;
  const average = scored.reduce((sum, value) => sum + value, 0) / scored.length;
  const worst = Math.min(...scored);
  return clamp(Math.round(average * 0.7 + worst * 0.3), 5, 100);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
