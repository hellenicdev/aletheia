interface ToneRule {
  pattern: RegExp;
  weight: number;
}

const RULES: ToneRule[] = [
  { pattern: /\b(?:fuck(?:ing|er|ed)?|shit(?:ty)?|asshole|bastard|prick|bitch|cunt|dick)\b/gi, weight: 3 },
  { pattern: /(?:γαμ\p{L}*|σκατ\p{L}*|μαλακ\p{L}*|πουστ\p{L}*|κωλο\p{L}*|μπουρδελ\p{L}*)/giu, weight: 3 },
  { pattern: /\b(?:snivel(?:ing|ling)?|idiot|moron|stupid|scum|disgusting|outrageous|vile)\b/gi, weight: 2 },
  { pattern: /(?:ηλίθι\p{L}*|απαράδεκτ\p{L}*|αισχρ\p{L}*|κατάπτυστ\p{L}*|αηδί\p{L}*|βρωμ\p{L}*)/giu, weight: 2 },
  { pattern: /\b(?:damn|crap|hellish|horrific|terrifying|breathtaking|undoubtedly)\b/gi, weight: 1 },
  { pattern: /\bwithout (?:a )?doubt\b/gi, weight: 1 },
  { pattern: /(?:αναμφίβολα|συγκλονιστ\p{L}*|χωρίς αμφιβολία)/giu, weight: 1 },
  { pattern: /\b(?:utterly|absolutely|extremely)\b/gi, weight: 1 },
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
  return clamp(Math.round(100 - density * 18), 5, 100);
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
