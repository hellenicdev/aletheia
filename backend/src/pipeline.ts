import { applyEvidence, type EvidenceItem } from "../../shared/citations";
import { detectLanguage, languageMatches } from "../../shared/language";
import type { ClaimType, DetectedLanguage, Label, UiLanguage } from "../../shared/labels";
import { CLAIM_TYPES, LABELS, isUiLanguage } from "../../shared/labels";
import {
  opinionExplanation,
  rhetoricalExplanation,
  unverifiableExplanation,
} from "../../shared/messages";
import { aggregateScore } from "../../shared/score";
import { alignSegments, splitPastedTitle } from "../../shared/sentences";
import type { AnalysisResult, Contradiction, SegmentResult, StageName } from "../../shared/types";
import type { Env } from "./config";
import { resolveConfig } from "./config";
import { HttpError } from "./errors";
import { fetchArticle } from "./extract";
import { completeJson } from "./llm";
import { LIMITS } from "./limits";
import {
  consistencySystem,
  consistencyUser,
  querySystem,
  queryUser,
  segmentSystem,
  segmentUser,
  verifySystem,
  verifyUser,
} from "./prompts";
import { searchWeb } from "./firecrawl";
import { expectNumber, expectOneOf, expectString, isRecord } from "../../shared/json";

export interface AnalyzeInput {
  text?: string;
  url?: string;
  uiLanguage?: string;
}

export interface AnalyzeDeps {
  env: Env;
  fetchImpl?: typeof fetch;
  onStage?: (stage: StageName, status: "start" | "done") => void;
  requestId?: string;
}

interface DraftSegment {
  id: string;
  text: string;
  start: number;
  end: number;
  claimType: ClaimType;
  note: string;
}

export async function analyze(input: AnalyzeInput, deps: AnalyzeDeps): Promise<AnalysisResult> {
  const config = resolveConfig(deps.env);
  if (!deps.env.OPENAI_API_KEY?.trim()) {
    throw new HttpError(503, "OPENAI_API_KEY is not configured on the worker.");
  }
  const uiLanguage: UiLanguage = isUiLanguage(input.uiLanguage) ? input.uiLanguage : "en";
  const fetchImpl = deps.fetchImpl ?? fetch;
  const requestId = deps.requestId ?? crypto.randomUUID();
  const stage = (name: StageName, status: "start" | "done") => deps.onStage?.(name, status);

  stage("ingest", "start");
  const ingested = await ingest(input, fetchImpl, deps.env.FIRECRAWL_API_KEY);
  stage("ingest", "done");

  stage("segment", "start");
  const segmented = await segmentArticle({
    text: ingested.text,
    uiLanguage,
    config,
    apiKey: deps.env.OPENAI_API_KEY,
    fetchImpl,
  });
  stage("segment", "done");

  const searchEnabled = config.searchConfigured;
  let searchDegraded = false;
  const evidence = new Map<string, EvidenceItem[]>();

  stage("evidence", "start");
  const searchable = segmented.segments.filter((segment) => isSearchable(segment.claimType));
  const budgeted = searchable.slice(0, LIMITS.maxSearches);
  const overBudget = new Set(searchable.slice(LIMITS.maxSearches).map((segment) => segment.id));

  if (searchEnabled && deps.env.FIRECRAWL_API_KEY) {
    const queries = await buildQueries(budgeted, config, deps.env.OPENAI_API_KEY, fetchImpl);
    for (const segment of budgeted) {
      const query = queries.get(segment.id) || segment.text.slice(0, 180);
      try {
        const hits = await searchWeb({
          apiKey: deps.env.FIRECRAWL_API_KEY,
          query,
          language: segmented.detectedLanguage,
          fetchImpl,
        });
        evidence.set(segment.id, dedupeEvidence(hits));
      } catch (error) {
        console.error("search failed", error instanceof Error ? error.message : "error");
        searchDegraded = true;
        evidence.set(segment.id, []);
      }
    }
  }
  stage("evidence", "done");

  stage("verify", "start");
  const verified = new Map<string, SegmentResult>();
  const toVerify = segmented.segments.filter(
    (segment) => isSearchable(segment.claimType) && !overBudget.has(segment.id),
  );
  const skippedForEvidence = toVerify.filter(
    (segment) => searchEnabled && (evidence.get(segment.id)?.length ?? 0) === 0,
  );
  const withEvidence = toVerify.filter((segment) => !skippedForEvidence.includes(segment));

  for (const segment of skippedForEvidence) {
    const failed = searchDegraded && searchEnabled;
    verified.set(
      segment.id,
      finishSegment(segment, {
        label: "Unverifiable",
        confidence: 0.35,
        explanation: unverifiableExplanation(
          uiLanguage,
          failed ? "search-failed" : "no-evidence",
        ),
        sources: [],
        evidenceMode: searchEnabled ? "web-search" : "model-knowledge-only",
      }),
    );
  }

  for (const group of chunk(withEvidence, 4)) {
    try {
      const judged = await judgeGroup({
        group,
        evidence,
        uiLanguage,
        searchEnabled,
        config,
        apiKey: deps.env.OPENAI_API_KEY,
        fetchImpl,
      });
      for (const [id, result] of judged) verified.set(id, result);
    } catch (error) {
      if (isModelAuthError(error)) throw error;
      console.error("verify failed", error instanceof Error ? error.message : "error");
      for (const segment of group) {
        verified.set(
          segment.id,
          finishSegment(segment, {
            label: "Unverifiable",
            confidence: 0.3,
            explanation: unverifiableExplanation(uiLanguage, "weak-evidence"),
            sources: [],
            evidenceMode: searchEnabled ? "web-search" : "model-knowledge-only",
          }),
        );
      }
    }
  }

  for (const segment of segmented.segments) {
    if (verified.has(segment.id)) continue;
    if (overBudget.has(segment.id)) {
      verified.set(
        segment.id,
        finishSegment(segment, {
          label: "Unverifiable",
          confidence: 0.3,
          explanation: unverifiableExplanation(uiLanguage, "budget"),
          sources: [],
          evidenceMode: searchEnabled ? "web-search" : "model-knowledge-only",
        }),
      );
      continue;
    }
    const opinion = segment.claimType === "opinion";
    verified.set(
      segment.id,
      finishSegment(segment, {
        label: opinion ? "Opinion" : "Rhetorical",
        confidence: 0.7,
        explanation: acceptNote(
          segment.note,
          uiLanguage,
          opinion ? opinionExplanation(uiLanguage) : rhetoricalExplanation(uiLanguage),
        ),
        sources: [],
        evidenceMode: "not-applicable",
      }),
    );
  }
  stage("verify", "done");

  stage("score", "start");
  const ordered = segmented.segments
    .map((segment) => verified.get(segment.id))
    .filter((segment): segment is SegmentResult => Boolean(segment));

  const contradictions = await findContradictions({
    segments: ordered,
    uiLanguage,
    config,
    apiKey: deps.env.OPENAI_API_KEY,
    fetchImpl,
  });

  const score = aggregateScore(
    ordered.map((segment) => ({
      label: segment.label,
      confidence: segment.confidence,
      hasValidSource: segment.sources.length > 0,
    })),
    {
      contradictionCount: contradictions.length,
      searchEnabled,
      uiLanguage,
    },
  );
  stage("score", "done");

  return {
    article: {
      title: ingested.title,
      text: ingested.text,
      sourceDomain: ingested.sourceDomain,
      sourceUrl: ingested.sourceUrl,
      publishedAt: ingested.publishedAt,
      detectedLanguage: segmented.detectedLanguage,
    },
    segments: ordered,
    score,
    contradictions,
    truncated: segmented.truncated,
    meta: {
      searchEnabled,
      searchDegraded,
      model: config.llmModel,
      uiLanguage,
      requestId,
      extraction: ingested.extraction,
    },
  };
}

async function ingest(input: AnalyzeInput, fetchImpl: typeof fetch, firecrawlKey?: string) {
  const hasText = typeof input.text === "string" && input.text.trim().length > 0;
  const hasUrl = typeof input.url === "string" && input.url.trim().length > 0;
  if (!hasText && !hasUrl) {
    throw new HttpError(400, "Provide article text or a URL.");
  }
  if (hasText && hasUrl) {
    throw new HttpError(400, "Provide either article text or a URL, not both.");
  }

  if (hasUrl) {
    const url = input.url!.trim();
    if (url.length > LIMITS.maxUrlChars) {
      throw new HttpError(400, "That URL is too long.");
    }
    const extracted = await fetchArticle(url, fetchImpl, firecrawlKey);
    let hostname: string | null = null;
    try {
      hostname = new URL(extracted.finalUrl).hostname.replace(/^www\./, "");
    } catch {
      hostname = null;
    }
    return {
      title: extracted.title,
      text: extracted.text,
      sourceDomain: hostname,
      sourceUrl: extracted.finalUrl,
      publishedAt: extracted.publishedAt,
      extraction: extracted.via,
    };
  }

  const raw = normalizeWhitespace(input.text || "");
  if (raw.length < LIMITS.minArticleChars) {
    throw new HttpError(400, "Paste a longer article. Very short text cannot be audited.");
  }
  if (raw.length > LIMITS.maxArticleChars) {
    throw new HttpError(413, `Articles are limited to ${LIMITS.maxArticleChars} characters.`);
  }
  const split = splitPastedTitle(raw);
  if (split.body.length < LIMITS.minArticleChars) {
    throw new HttpError(400, "Paste a longer article. Very short text cannot be audited.");
  }
  return {
    title: split.title,
    text: split.body,
    sourceDomain: null,
    sourceUrl: null,
    publishedAt: null,
    extraction: "pasted" as const,
  };
}

async function segmentArticle(options: {
  text: string;
  uiLanguage: UiLanguage;
  config: ReturnType<typeof resolveConfig>;
  apiKey: string;
  fetchImpl: typeof fetch;
}): Promise<{ segments: DraftSegment[]; detectedLanguage: DetectedLanguage; truncated: boolean }> {
  const localLanguage = detectLanguage(options.text);
  let proposed: { text: string; claimType: ClaimType; note: string }[] = [];
  let detected: DetectedLanguage = localLanguage;

  try {
    const parsed = await completeJson({
      config: options.config,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      system: segmentSystem(options.uiLanguage),
      user: segmentUser(options.text, options.uiLanguage),
      validate: validateSegments,
    });
    proposed = parsed.segments;
    detected = localLanguage === "other" ? parsed.detectedLanguage : localLanguage;
  } catch (error) {
    if (isModelAuthError(error)) throw error;
    console.error("segment failed", error instanceof Error ? error.message : "error");
  }

  const spans = alignSegments(
    options.text,
    proposed.map((segment) => ({ text: segment.text })),
  );
  let truncated = spans.length > LIMITS.maxSegments;
  const limited = spans.slice(0, LIMITS.maxSegments);
  const segments = limited.map((span, index) => {
    const match = proposed.find((item) => item.text.trim() === span.text.trim());
    return {
      id: `s${index + 1}`,
      text: span.text,
      start: span.start,
      end: span.end,
      claimType: match?.claimType ?? "checkable_factual",
      note: match?.note ?? "",
    };
  });

  if (segments.length === 0) {
    throw new HttpError(422, "The article could not be split into claims.");
  }
  return { segments, detectedLanguage: detected, truncated };
}

function validateSegments(data: unknown): {
  detectedLanguage: DetectedLanguage;
  segments: { text: string; claimType: ClaimType; note: string }[];
} {
  if (!isRecord(data)) throw new Error("segment payload must be an object");
  const detectedLanguage = expectOneOf(
    data.detectedLanguage,
    ["en", "el", "other"] as const,
    "detectedLanguage",
  );
  if (!Array.isArray(data.segments) || data.segments.length === 0) {
    throw new Error("segments must be a non-empty array");
  }
  const segments = data.segments.map((item, index) => {
    if (!isRecord(item)) throw new Error(`segment ${index} must be an object`);
    return {
      text: expectString(item.text, `segment ${index} text`),
      claimType: expectOneOf(item.claimType, CLAIM_TYPES, `segment ${index} claimType`),
      note: typeof item.note === "string" ? item.note.trim().slice(0, 500) : "",
    };
  });
  return { detectedLanguage, segments };
}

async function buildQueries(
  segments: DraftSegment[],
  config: ReturnType<typeof resolveConfig>,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<Map<string, string>> {
  const queries = new Map<string, string>();
  if (segments.length === 0) return queries;
  try {
    const parsed = await completeJson({
      config,
      apiKey,
      fetchImpl,
      system: querySystem(),
      user: queryUser(segments.map((segment) => ({ id: segment.id, text: segment.text }))),
      maxTokens: 1200,
      validate: (data) => validateQueries(data, new Set(segments.map((segment) => segment.id))),
    });
    for (const item of parsed) queries.set(item.id, item.query);
  } catch (error) {
    console.error("queries failed", error instanceof Error ? error.message : "error");
  }
  return queries;
}

function validateQueries(data: unknown, ids: Set<string>): { id: string; query: string }[] {
  if (!isRecord(data) || !Array.isArray(data.queries)) {
    throw new Error("queries must be an array");
  }
  return data.queries
    .map((item, index) => {
      if (!isRecord(item)) throw new Error(`query ${index} must be an object`);
      return {
        id: expectString(item.id, `query ${index} id`),
        query: expectString(item.query, `query ${index} query`).slice(0, 240),
      };
    })
    .filter((item) => ids.has(item.id));
}

async function judgeGroup(options: {
  group: DraftSegment[];
  evidence: Map<string, EvidenceItem[]>;
  uiLanguage: UiLanguage;
  searchEnabled: boolean;
  config: ReturnType<typeof resolveConfig>;
  apiKey: string;
  fetchImpl: typeof fetch;
}): Promise<Map<string, SegmentResult>> {
  const ids = new Set(options.group.map((segment) => segment.id));
  const parsed = await completeJson({
    config: options.config,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    system: verifySystem(options.uiLanguage, options.searchEnabled),
    user: verifyUser(
      options.group.map((segment) => ({
        id: segment.id,
        claim: segment.text,
        evidence: (options.evidence.get(segment.id) ?? []).map((item) => ({
          url: item.url,
          title: item.title,
          snippet: item.snippet,
        })),
      })),
    ),
    validate: (data) => validateVerdicts(data, ids, options.uiLanguage),
  });

  const results = new Map<string, SegmentResult>();
  for (const segment of options.group) {
    const verdict = parsed.find((item) => item.id === segment.id);
    if (!verdict) {
      results.set(
        segment.id,
        finishSegment(segment, {
          label: "Unverifiable",
          confidence: 0.3,
          explanation: unverifiableExplanation(options.uiLanguage, "weak-evidence"),
          sources: [],
          evidenceMode: options.searchEnabled ? "web-search" : "model-knowledge-only",
        }),
      );
      continue;
    }
    const applied = applyEvidence({
      label: verdict.label,
      confidence: verdict.confidence,
      explanation: verdict.explanation,
      claimText: segment.text,
      sourceUrls: verdict.sourceUrls,
      evidence: options.evidence.get(segment.id) ?? [],
      searchEnabled: options.searchEnabled,
      uiLanguage: options.uiLanguage,
    });
    results.set(segment.id, finishSegment(segment, applied));
  }
  return results;
}

function validateVerdicts(
  data: unknown,
  ids: Set<string>,
  uiLanguage: UiLanguage,
): { id: string; label: Label; confidence: number; explanation: string; sourceUrls: string[] }[] {
  if (!isRecord(data) || !Array.isArray(data.results)) {
    throw new Error("results must be an array");
  }
  const results = data.results.map((item, index) => {
    if (!isRecord(item)) throw new Error(`result ${index} must be an object`);
    const explanation = expectString(item.explanation, `result ${index} explanation`);
    if (!languageMatches(explanation, uiLanguage)) {
      throw new Error(`result ${index} explanation is not in the requested language`);
    }
    const sourceUrls = Array.isArray(item.sourceUrls)
      ? item.sourceUrls.filter((url): url is string => typeof url === "string")
      : [];
    return {
      id: expectString(item.id, `result ${index} id`),
      label: expectOneOf(item.label, LABELS, `result ${index} label`),
      confidence: expectNumber(item.confidence, `result ${index} confidence`, 0, 1),
      explanation,
      sourceUrls,
    };
  });
  const seen = new Set(results.map((item) => item.id));
  for (const id of ids) {
    if (!seen.has(id)) throw new Error(`missing verdict for ${id}`);
  }
  return results.filter((item) => ids.has(item.id));
}

async function findContradictions(options: {
  segments: SegmentResult[];
  uiLanguage: UiLanguage;
  config: ReturnType<typeof resolveConfig>;
  apiKey: string;
  fetchImpl: typeof fetch;
}): Promise<Contradiction[]> {
  const factual = options.segments.filter((segment) =>
    ["True", "False", "Misleading", "Unverifiable"].includes(segment.label),
  );
  if (factual.length < 2) return [];
  try {
    const parsed = await completeJson({
      config: options.config,
      apiKey: options.apiKey,
      fetchImpl: options.fetchImpl,
      system: consistencySystem(options.uiLanguage),
      user: consistencyUser(
        factual.map((segment) => ({
          id: segment.id,
          text: segment.text,
          label: segment.label,
        })),
      ),
      maxTokens: 800,
      validate: (data) => validateContradictions(data, options.uiLanguage),
    });
    const known = new Set(factual.map((segment) => segment.id));
    const unique: Contradiction[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (!known.has(item.a) || !known.has(item.b) || item.a === item.b) continue;
      const key = [item.a, item.b].sort().join(":");
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
      if (unique.length === 3) break;
    }
    return unique;
  } catch (error) {
    console.error("consistency failed", error instanceof Error ? error.message : "error");
    return [];
  }
}

function validateContradictions(data: unknown, uiLanguage: UiLanguage): Contradiction[] {
  if (!isRecord(data) || !Array.isArray(data.contradictions)) {
    throw new Error("contradictions must be an array");
  }
  return data.contradictions.map((item, index) => {
    if (!isRecord(item)) throw new Error(`contradiction ${index} must be an object`);
    const explanation = expectString(item.explanation, `contradiction ${index} explanation`);
    if (!languageMatches(explanation, uiLanguage)) {
      throw new Error(`contradiction ${index} explanation language mismatch`);
    }
    return {
      a: expectString(item.a, `contradiction ${index} a`),
      b: expectString(item.b, `contradiction ${index} b`),
      explanation,
    };
  });
}

function finishSegment(
  segment: DraftSegment,
  result: Pick<SegmentResult, "label" | "confidence" | "explanation" | "sources" | "evidenceMode">,
): SegmentResult {
  return {
    id: segment.id,
    text: segment.text,
    start: segment.start,
    end: segment.end,
    label: result.label,
    confidence: result.confidence,
    explanation: result.explanation,
    sources: result.sources,
    evidenceMode: result.evidenceMode,
  };
}

function acceptNote(note: string, lang: UiLanguage, fallback: string): string {
  const trimmed = note.replace(/\s+/g, " ").trim();
  if (trimmed.length < 8 || trimmed.length > 500) return fallback;
  if (/https?:\/\//i.test(trimmed)) return fallback;
  if (!languageMatches(trimmed, lang)) return fallback;
  return trimmed;
}

function isSearchable(claimType: ClaimType): boolean {
  return claimType === "checkable_factual" || claimType === "mixed";
}

function dedupeEvidence(items: EvidenceItem[]): EvidenceItem[] {
  const seen = new Set<string>();
  const unique: EvidenceItem[] = [];
  for (const item of items) {
    if (seen.has(item.url)) continue;
    seen.add(item.url);
    unique.push(item);
  }
  return unique;
}

function chunk<T>(items: T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    groups.push(items.slice(index, index + size));
  }
  return groups;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
}

function isModelAuthError(error: unknown): boolean {
  return error instanceof HttpError && /API key/i.test(error.message);
}
