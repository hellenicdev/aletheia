import type {
  DetectedLanguage,
  EvidenceMode,
  Label,
  UiLanguage,
} from "./labels";

export interface SourceCitation {
  url: string;
  title: string;
  snippet: string;
}

export interface SegmentResult {
  id: string;
  text: string;
  start: number;
  end: number;
  label: Label;
  confidence: number;
  explanation: string;
  sources: SourceCitation[];
  evidenceMode: EvidenceMode;
}

export interface SubScores {
  factualAccuracy: number | null;
  factualBasis: "measured" | "uncertain" | "commentary";
  sourcing: number | null;
  toneNeutrality: number | null;
  logicalConsistency: number;
}

export interface ScoreResult extends SubScores {
  overall: number;
  verdict: string;
  counts: Record<Label, number>;
}

export interface Contradiction {
  a: string;
  b: string;
  explanation: string;
}

export interface AnalysisArticle {
  title: string | null;
  text: string;
  sourceDomain: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  detectedLanguage: DetectedLanguage;
}

export interface AnalysisResult {
  article: AnalysisArticle;
  segments: SegmentResult[];
  score: ScoreResult;
  contradictions: Contradiction[];
  truncated: boolean;
  meta: {
    searchEnabled: boolean;
    searchDegraded: boolean;
    model: string;
    uiLanguage: UiLanguage;
    requestId: string;
    extraction: "pasted" | "firecrawl" | "local";
  };
}

export type StageName = "ingest" | "segment" | "evidence" | "verify" | "score";

export interface StageEvent {
  stage: StageName;
  status: "start" | "done";
}
