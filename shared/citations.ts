import type { EvidenceMode, Label, UiLanguage } from "./labels";
import { unverifiableExplanation } from "./messages";
import type { SourceCitation } from "./types";

export interface EvidenceItem {
  url: string;
  title: string;
  snippet: string;
}

export function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    let serialized = parsed.toString();
    if (serialized.endsWith("/")) serialized = serialized.slice(0, -1);
    return serialized;
  } catch {
    return url.trim();
  }
}

export interface AppliedEvidence {
  label: Label;
  confidence: number;
  explanation: string;
  sources: SourceCitation[];
  evidenceMode: EvidenceMode;
}

const DECIDED = new Set<Label>(["True", "False", "Misleading"]);

/**
 * Keep only URLs that were actually retrieved. A firm factual label without
 * a surviving citation is downgraded to Unverifiable. With search disabled,
 * sources are always empty and recent or numeric claims are not treated as verified.
 */
export function applyEvidence(input: {
  label: Label;
  confidence: number;
  explanation: string;
  claimText: string;
  sourceUrls: string[];
  evidence: EvidenceItem[];
  searchEnabled: boolean;
  uiLanguage: UiLanguage;
}): AppliedEvidence {
  const confidence = clampConfidence(input.confidence);

  if (!input.searchEnabled) {
    const downgrade =
      DECIDED.has(input.label) && looksLikeNewsOrFigure(input.claimText);
    return {
      label: downgrade ? "Unverifiable" : input.label,
      confidence: Math.min(confidence, 0.55),
      explanation: downgrade
        ? unverifiableExplanation(input.uiLanguage, "model-only")
        : input.explanation,
      sources: [],
      evidenceMode: "model-knowledge-only",
    };
  }

  const byUrl = new Map(input.evidence.map((item) => [canonicalUrl(item.url), item]));
  const sources: SourceCitation[] = [];
  const seen = new Set<string>();
  for (const url of input.sourceUrls) {
    const key = canonicalUrl(url);
    const item = byUrl.get(key);
    if (!item || seen.has(key)) continue;
    seen.add(key);
    sources.push({
      url: item.url,
      title: item.title,
      snippet: item.snippet,
    });
  }

  if (DECIDED.has(input.label) && sources.length === 0) {
    return {
      label: "Unverifiable",
      confidence: Math.min(confidence, 0.45),
      explanation: unverifiableExplanation(
        input.uiLanguage,
        input.evidence.length === 0 ? "no-evidence" : "uncited",
      ),
      sources: [],
      evidenceMode: "web-search",
    };
  }

  return {
    label: input.label,
    confidence,
    explanation: input.explanation,
    sources,
    evidenceMode: "web-search",
  };
}

export function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.4;
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
}

export function looksLikeNewsOrFigure(text: string): boolean {
  if (/\b20(?:1[5-9]|2\d)\b/.test(text)) return true;
  if (/(?:%|€|\$|£)/.test(text)) return true;
  if (/\b\d+(?:[.,]\d+)?\b/.test(text)) return true;
  return false;
}
