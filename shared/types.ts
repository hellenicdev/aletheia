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
  /**
   * Selected claims labelled True, False, or Misleading that have at least one
   * relevant cited source. The verdict sentence uses this count and says
   * "confirmed or refuted", so it is not the provisional coverage ratio.
   */
  claimsVerified: number;
  /**
   * Selected checkable claims that have at least one relevant independent source,
   * whatever the label, Unverifiable included. The provisional flag uses this
   * count. It is larger than claimsVerified when sourced claims stay unverified.
   */
  claimsCovered: number;
  /**
   * Selected checkable claims in the coverage total. A personal account is not
   * selected, and a claim whose only pages are the article or a copy of it is left out.
   */
  claimsTotal: number;
  /**
   * True when live search is not ok, or fewer than 40% of the coverage claims
   * are covered by a relevant independent source. The gauge is provisional, the
   * factual and sourcing sub-scores are empty, and the overall is pulled part
   * of the way toward a neutral prior.
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
    /** Lines removed as page navigation or related headlines. Absent on older payloads. */
    ignoredLines?: number;
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
