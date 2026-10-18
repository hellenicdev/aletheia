import type {
  DetectedLanguage,
  EvidenceMode,
  Label,
  UiLanguage,
} from "./labels";
import type { OutletKind } from "./reputation";

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

export interface SubrequestCounts {
  ingest: number;
  segment: number;
  evidence: number;
  verify: number;
  score: number;
  total: number;
}

export type SearchState = "ok" | "partial" | "unavailable";

export type SearchOutageReason =
  | "out_of_credits"
  | "unauthorized"
  | "rate_limited"
  | "upstream_error"
  | "failed";

export type SearchProviderName = "firecrawl" | "tavily";

export interface SearchStatus {
  state: SearchState;
  reason: SearchOutageReason | null;
  /** Provider that supplied the evidence. Null when search did not succeed. */
  provider: SearchProviderName | null;
}

export interface AnalysisResult {
  article: AnalysisArticle;
  segments: SegmentResult[];
  score: ScoreResult;
  contradictions: Contradiction[];
  truncated: boolean;
  /** True when budget, the deadline, or an error left some selected claims unchecked. */
  degraded: boolean;
  /** Selected claims that received a finished check. */
  claimsVerified: number;
  /** Selected claims that were meant to be checked, up to the search cap. */
  claimsTotal: number;
  /**
   * True when live search is not ok, or fewer than half of the selected claims
   * were checked. The gauge is provisional, the factual and sourcing sub-scores
   * are empty, and the overall is pulled toward a neutral prior by coverage.
   */
  provisional: boolean;
  meta: {
    searchEnabled: boolean;
    searchDegraded: boolean;
    searchStatus: SearchStatus;
    model: string;
    uiLanguage: UiLanguage;
    requestId: string;
    extraction: "pasted" | "firecrawl" | "local" | "direct" | "tavily";
    warnings: string[];
    outlet: OutletKind;
    subrequests: SubrequestCounts;
  };
}

export interface ArticlePreview {
  title: string | null;
  text: string;
  sourceUrl: string | null;
  publishedAt: string | null;
}

export type StageName = "ingest" | "segment" | "evidence" | "verify" | "score";

export interface StageEvent {
  stage: StageName;
  status: "start" | "done" | "progress";
  done?: number;
  total?: number;
}
