import { isSkippableFragment, stripCredits } from "../../shared/articleText";
import { evaluativeDensity, inferClaimType, looksLikeOpinionSection, reconcileClaimType } from "../../shared/classify";
import { applyEvidence, independentEvidence, type EvidenceItem } from "../../shared/citations";
import { detectLanguage, languageMatches } from "../../shared/language";
import type { ClaimType, DetectedLanguage, Label, UiLanguage } from "../../shared/labels";
import { CLAIM_TYPES, LABELS, isUiLanguage } from "../../shared/labels";
import {
  opinionExplanation,
  rhetoricalExplanation,
  unverifiableExplanation,
} from "../../shared/messages";
import { claimImportance } from "../../shared/rank";
import { resolveOutlet } from "../../shared/reputation";
import { aggregateScore } from "../../shared/score";
import { splitPastedTitle, splitSentences } from "../../shared/sentences";
import { blendTone, combineTone, type Rhetoric } from "../../shared/tone";
import type { AnalysisResult, ArticlePreview, Contradiction, SegmentResult, StageName } from "../../shared/types";
import type { Env } from "./config";
import { resolveConfig } from "./config";
import { HttpError, UpstreamError } from "./errors";
import { fetchArticle } from "./extract";
import { resolveFetch } from "./runtime";
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
import { createSubrequestBudget, SUBREQUEST_RESERVE, trackFetch, type SubrequestBudget } from "./budget";
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
  onStage?: (stage: StageName, status: "start" | "done" | "progress", done?: number, total?: number) => void;
  onPreview?: (article: ArticlePreview) => void;
  onTick?: () => void;
  requestId?: string;
  budgetMs?: number;
  /** Test hook. Production uses the worker subrequest ceiling. */
  subrequestLimit?: number;
}

interface DraftSegment {
  id: string;
  text: string;
  start: number;
  end: number;
  claimType: ClaimType;
  note: string;
  importance: number;
}

export async function analyze(input: AnalyzeInput, deps: AnalyzeDeps): Promise<AnalysisResult> {
  const config = resolveConfig(deps.env);
  if (!deps.env.OPENAI_API_KEY?.trim()) {
    throw new HttpError(503, "OPENAI_API_KEY is not configured on the worker.");
  }
  const uiLanguage: UiLanguage = isUiLanguage(input.uiLanguage) ? input.uiLanguage : "en";
  const budget = createSubrequestBudget(deps.subrequestLimit);
  const fetchImpl = trackFetch(resolveFetch(deps.fetchImpl), budget);
  const tick = () => deps.onTick?.();
  const requestId = deps.requestId ?? crypto.randomUUID();
  const warnings: string[] = [];
  const llmKey = deps.env.OPENAI_API_KEY?.trim() ?? "";
  const searchKey = deps.env.FIRECRAWL_API_KEY?.trim() ?? "";
  const deadline = Date.now() + (deps.budgetMs ?? LIMITS.analysisDeadlineMs);
  const stage = (name: StageName, status: "start" | "done" | "progress", done?: number, total?: number) =>
    deps.onStage?.(name, status, done, total);

  stage("ingest", "start");
  const ingested = await ingest(input, fetchImpl, searchKey, warnings);
  stage("ingest", "done");
  deps.onPreview?.({
    title: ingested.title,
    text: ingested.text,
    sourceUrl: ingested.sourceUrl,
    publishedAt: ingested.publishedAt,
  });

  stage("segment", "start");
  const segmented = await segmentArticle({
    text: ingested.text,
    title: ingested.title,
    uiLanguage,
    config,
    apiKey: llmKey,
    fetchImpl,
    warnings,
    deadline,
  });
  stage("segment", "done");
  if (
    segmented.genre !== "satire" &&
    segmented.genre !== "unreliable" &&
    (looksLikeOpinionSection(ingested.sourceUrl, ingested.title, ingested.text) ||
      evaluativeDensity(segmented.segments.map((segment) => segment.text)))
  ) {
    segmented.genre = "opinion";
  }

  const searchEnabled = config.searchConfigured;
  let searchDegraded = false;
  const evidence = new Map<string, EvidenceItem[]>();

  stage("evidence", "start");
  const searchable = segmented.segments.filter((segment) => isSearchable(segment.claimType));
  const budgeted = [...searchable]
    .sort((a, b) => b.importance - a.importance || a.start - b.start)
    .slice(0, LIMITS.maxSearches);
  const budgetedIds = new Set(budgeted.map((segment) => segment.id));
  const overBudget = new Set(searchable.filter((segment) => !budgetedIds.has(segment.id)).map((segment) => segment.id));
  const echoOnly = new Set<string>();
  const searchFailed = new Set<string>();

  if (searchEnabled && searchKey) {
    const queries = await buildQueries(budgeted, config, llmKey, fetchImpl, warnings, deadline, budget);
    let finishedSearches = 0;
    for (let index = 0; index < budgeted.length; index++) {
      const segment = budgeted[index];
      tick();
      if (Date.now() > deadline - 3_000 || !budget.canSpend(SUBREQUEST_RESERVE)) {
        const reason =
          Date.now() > deadline - 3_000
            ? "analysis deadline reached before search finished"
            : "search stopped to stay within the worker subrequest limit";
        abandonSearches(budgeted, index, evidence, searchFailed, warnings, reason);
        searchDegraded = true;
        break;
      }
      const query = queries.get(segment.id) || segment.text.slice(0, 180);
      const timeoutMs = Math.max(1_000, Math.min(10_000, deadline - Date.now() - 2_000));
      try {
        const hits = dedupeEvidence(
          await withTimeout(
            searchWeb({
              apiKey: searchKey,
              query,
              language: segmented.detectedLanguage,
              fetchImpl,
              timeoutMs,
              canSpend: () => budget.canSpend(1),
            }),
            timeoutMs + 750,
            "search timed out",
          ),
        );
        const independent = independentEvidence(hits, {
          articleDomain: ingested.sourceDomain,
          articleText: ingested.text,
          claimText: segment.text,
        });
        if (hits.length > 0 && independent.length === 0) echoOnly.add(segment.id);
        evidence.set(segment.id, independent);
      } catch (error) {
        remember(warnings, error, "search");
        searchDegraded = true;
        searchFailed.add(segment.id);
        evidence.set(segment.id, []);
      }
      finishedSearches += 1;
      stage("evidence", "progress", finishedSearches, budgeted.length);
    }
  }
  stage("evidence", "done");

  stage("verify", "start");
  const verified = new Map<string, SegmentResult>();
  const toVerify = segmented.segments.filter(
    (segment) =>
      isSearchable(segment.claimType) && !overBudget.has(segment.id) && !searchFailed.has(segment.id),
  );
  const skippedForEvidence = toVerify.filter(
    (segment) => searchEnabled && echoOnly.has(segment.id),
  );
  const withEvidence = toVerify.filter((segment) => !skippedForEvidence.includes(segment));

  for (const segment of skippedForEvidence) {
    const failed = searchDegraded && searchEnabled && !echoOnly.has(segment.id);
    verified.set(
      segment.id,
      finishSegment(segment, {
        label: "Unverifiable",
        confidence: 0.35,
        explanation: unverifiableExplanation(
          uiLanguage,
          echoOnly.has(segment.id) ? "not-independent" : failed ? "search-failed" : "no-evidence",
        ),
        sources: [],
        evidenceMode: searchEnabled ? "web-search" : "model-knowledge-only",
      }),
    );
  }

  const groups = chunk(withEvidence, 4);
  let cursor = 0;
  while (cursor < groups.length) {
    tick();
    if (Date.now() > deadline || !budget.canSpend(2)) {
      remember(warnings, new Error("analysis deadline reached before verification finished"), "llm");
      for (const group of groups.slice(cursor)) {
        for (const segment of group) {
          verified.set(segment.id, unverifiedSegment(segment, uiLanguage, searchEnabled, "check-failed"));
        }
      }
      break;
    }
    const parallel = Math.max(1, Math.min(groups.length - cursor, Math.max(1, budget.remaining() - 2)));
    const batch = groups.slice(cursor, cursor + parallel);
    cursor += batch.length;
    const attempts = budget.canSpend(SUBREQUEST_RESERVE) ? 2 : 1;
    await Promise.all(
      batch.map(async (group, index) => {
        stage("verify", cursor - batch.length + index === 0 ? "start" : "progress", cursor, groups.length);
        try {
          const timeoutMs = remainingMs(deadline, 22_000);
          const judged = await withTimeout(
            judgeGroup({
              group,
              evidence,
              uiLanguage,
              searchEnabled,
              config,
              apiKey: llmKey,
              fetchImpl,
              deadline,
              publishedAt: ingested.publishedAt,
              articleDomain: ingested.sourceDomain,
              articleText: ingested.text,
              attempts,
              timeoutMs,
            }),
            timeoutMs + 750,
            "verification timed out",
          );
          for (const [id, result] of judged) verified.set(id, result);
        } catch (error) {
          if (isModelAuthError(error)) throw error;
          remember(warnings, error, "llm");
          for (const segment of group) {
            verified.set(segment.id, unverifiedSegment(segment, uiLanguage, searchEnabled, "check-failed"));
          }
        }
      }),
    );
  }

  for (const segment of segmented.segments) {
    if (verified.has(segment.id)) continue;
    if (searchFailed.has(segment.id)) {
      verified.set(segment.id, unverifiedSegment(segment, uiLanguage, searchEnabled, "search-failed"));
      continue;
    }
    if (overBudget.has(segment.id)) {
      if (segment.claimType === "opinion" || segment.claimType === "rhetorical") {
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
        continue;
      }
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

  const contradictions =
    Date.now() > deadline - 12_000
      ? []
      : await findContradictions({
          segments: ordered,
          uiLanguage,
          config,
          apiKey: llmKey,
          fetchImpl,
          warnings,
          deadline,
        });

  const draftById = new Map(segmented.segments.map((segment) => [segment.id, segment]));
  const outlet = resolveOutlet({
    domain: ingested.sourceDomain,
    genre: segmented.genre,
    tone: combineTone(ordered.map((segment) => segment.text)),
  });
  const score = aggregateScore(
    ordered.map((segment) => ({
      label: segment.label,
      confidence: segment.confidence,
      hasValidSource: segment.sources.length > 0,
      tone: blendTone(segment.text, rhetoricOf(segment.label, draftById.get(segment.id)?.claimType)),
      inCoverage: !overBudget.has(segment.id),
    })),
    {
      contradictionCount: contradictions.length,
      searchEnabled,
      searchDegraded,
      uiLanguage,
      outlet,
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
    truncated: segmented.truncated || ingested.truncated,
    meta: {
      searchEnabled,
      searchDegraded,
      model: config.llmModel,
      uiLanguage,
      requestId,
      extraction: ingested.extraction,
      warnings,
      outlet,
    },
  };
}

async function ingest(
  input: AnalyzeInput,
  fetchImpl: typeof fetch,
  firecrawlKey: string | undefined,
  warnings: string[],
) {
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
      truncated: false,
    };
  }

  let raw = stripCredits(normalizeWhitespace(input.text || ""));
  let truncated = false;
  if (raw.length < LIMITS.minArticleChars) {
    throw new HttpError(400, "Paste a longer article. Very short text cannot be audited.");
  }
  if (raw.length > LIMITS.maxArticleChars) {
    raw = raw.slice(0, LIMITS.maxArticleChars);
    truncated = true;
    warnings.push(`llm: pasted text was truncated to ${LIMITS.maxArticleChars} characters`);
  }
  const split = splitPastedTitle(raw);
  if (split.body.length < LIMITS.minArticleChars) {
    throw new HttpError(400, "Paste a longer article. Very short text cannot be audited.");
  }
  return {
    title: split.title,
    text: split.body.slice(0, LIMITS.maxArticleChars),
    sourceDomain: null,
    sourceUrl: null,
    publishedAt: null,
    extraction: "pasted" as const,
    truncated,
  };
}

async function segmentArticle(options: {
  text: string;
  title: string | null;
  uiLanguage: UiLanguage;
  config: ReturnType<typeof resolveConfig>;
  apiKey: string;
  fetchImpl: typeof fetch;
  warnings: string[];
  deadline: number;
}): Promise<{
  segments: DraftSegment[];
  detectedLanguage: DetectedLanguage;
  truncated: boolean;
  genre: string | null;
}> {
  const localLanguage = detectLanguage(options.text);
  const spans = uniqueSpans(splitSentences(options.text).filter((span) => !isSkippableFragment(span.text)));
  const ranked = spans
    .map((span, index) => ({ span, importance: claimImportance(span.text, options.title, index) }))
    .sort((a, b) => b.importance - a.importance || a.span.start - b.span.start);
  const truncated = ranked.length > LIMITS.maxSegments;
  const kept = ranked.slice(0, LIMITS.maxSegments).sort((a, b) => a.span.start - b.span.start);
  const drafts = kept.map((item, index) => ({
    id: `s${index + 1}`,
    text: item.span.text,
    start: item.span.start,
    end: item.span.end,
    claimType: inferClaimType(item.span.text),
    note: "",
    importance: item.importance,
  }));
  if (drafts.length === 0) {
    throw new HttpError(422, "The article could not be split into claims.");
  }

  let detected: DetectedLanguage = localLanguage;
  let genre: string | null = null;
  if (Date.now() < options.deadline - 8_000) {
    try {
      const parsed = await completeJson({
        config: options.config,
        apiKey: options.apiKey,
        fetchImpl: options.fetchImpl,
        system: segmentSystem(options.uiLanguage),
        user: segmentUser(
          drafts.map((segment) => ({ id: segment.id, text: segment.text })),
          options.uiLanguage,
        ),
        validate: validateSegments,
        reasoningEffort: "low",
        maxTokens: 4096,
        timeoutMs: remainingMs(options.deadline, 22_000),
      });
      genre = parsed.genre;
      detected = localLanguage === "other" ? parsed.detectedLanguage : localLanguage;
      const byId = new Map(parsed.segments.map((segment) => [segment.id, segment]));
      for (const draft of drafts) {
        const match = byId.get(draft.id);
        if (!match) continue;
        draft.claimType = match.claimType;
        draft.note = match.note;
      }
    } catch (error) {
      if (isModelAuthError(error)) throw error;
      remember(options.warnings, error, "llm");
    }
  }
  for (const draft of drafts) {
    draft.claimType = reconcileClaimType(draft.text, draft.claimType);
  }
  return { segments: drafts, detectedLanguage: detected, truncated, genre };
}

function validateSegments(data: unknown): {
  detectedLanguage: DetectedLanguage;
  genre: string | null;
  segments: { id: string; claimType: ClaimType; note: string }[];
} {
  if (!isRecord(data)) throw new Error("segment payload must be an object");
  const detectedLanguage = expectOneOf(
    data.detectedLanguage,
    ["en", "el", "other"] as const,
    "detectedLanguage",
  );
  const genre =
    typeof data.genre === "string" && ["news", "opinion", "satire", "unreliable"].includes(data.genre)
      ? data.genre
      : null;
  if (!Array.isArray(data.segments) || data.segments.length === 0) {
    throw new Error("segments must be a non-empty array");
  }
  const segments = data.segments.map((item, index) => {
    if (!isRecord(item)) throw new Error(`segment ${index} must be an object`);
    return {
      id: expectString(item.id, `segment ${index} id`),
      claimType: expectOneOf(item.claimType, CLAIM_TYPES, `segment ${index} claimType`),
      note: typeof item.note === "string" ? item.note.trim().slice(0, 240) : "",
    };
  });
  return { detectedLanguage, genre, segments };
}

async function buildQueries(
  segments: DraftSegment[],
  config: ReturnType<typeof resolveConfig>,
  apiKey: string,
  fetchImpl: typeof fetch,
  warnings: string[],
  deadline: number,
  budget: SubrequestBudget,
): Promise<Map<string, string>> {
  const queries = new Map<string, string>();
  if (segments.length === 0) return queries;
  for (const batch of chunk(segments, 6)) {
    if (Date.now() > deadline - 8_000 || !budget.canSpend(SUBREQUEST_RESERVE)) {
      remember(warnings, new Error("query generation stopped before the deadline or subrequest limit"), "llm");
      break;
    }
    try {
      const parsed = await completeJson({
        config,
        apiKey,
        fetchImpl,
        system: querySystem(),
        user: queryUser(batch.map((segment) => ({ id: segment.id, text: segment.text.slice(0, 280) }))),
        validate: (data) => validateQueries(data, new Set(batch.map((segment) => segment.id))),
        reasoningEffort: "low",
        maxTokens: 4096,
        attempts: 1,
        timeoutMs: remainingMs(deadline, 16_000),
      });
      for (const item of parsed) queries.set(item.id, item.query);
    } catch (error) {
      remember(warnings, error, "llm");
    }
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
        query: boundQuery(expectString(item.query, `query ${index} query`)),
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
  deadline: number;
  publishedAt: string | null;
  articleDomain: string | null;
  articleText: string;
  attempts: number;
  timeoutMs: number;
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
        context: surroundingParagraph(options.articleText, segment.start, segment.end),
        evidence: (options.evidence.get(segment.id) ?? []).map((item) => ({
          url: item.url,
          title: item.title,
          snippet: item.snippet,
        })),
      })),
      options.publishedAt,
    ),
    validate: (data) => validateVerdicts(data, ids, options.uiLanguage),
    reasoningEffort: "medium",
    attempts: options.attempts,
    timeoutMs: options.timeoutMs,
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
      articleDomain: options.articleDomain,
      articleText: options.articleText,
      allowModelKnowledge: options.searchEnabled && (options.evidence.get(segment.id)?.length ?? 0) === 0,
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
  warnings: string[];
  deadline: number;
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
      reasoningEffort: "low",
      maxTokens: 2048,
      timeoutMs: remainingMs(options.deadline, 16_000),
      user: consistencyUser(
        factual.map((segment) => ({
          id: segment.id,
          text: segment.text,
          label: segment.label,
        })),
      ),
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
    remember(options.warnings, error, "llm");
    return [];
  }
}

function remember(warnings: string[], error: unknown, source: "llm" | "search") {
  const message =
    error instanceof UpstreamError
      ? error.message
      : `${source}: ${error instanceof Error ? error.message : "request failed"}`;
  const warning = message.slice(0, 240);
  if (!warnings.includes(warning)) warnings.push(warning);
  if (!(error instanceof UpstreamError)) console.error(warning);
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

function unverifiedSegment(
  segment: DraftSegment,
  uiLanguage: UiLanguage,
  searchEnabled: boolean,
  reason: "weak-evidence" | "budget" | "no-evidence" | "search-failed" | "not-independent" | "check-failed",
): SegmentResult {
  return finishSegment(segment, {
    label: "Unverifiable",
    confidence: 0.3,
    explanation: unverifiableExplanation(uiLanguage, reason),
    sources: [],
    evidenceMode: searchEnabled ? "web-search" : "model-knowledge-only",
  });
}

function remainingMs(deadline: number, cap: number): number {
  return Math.max(1_000, Math.min(cap, deadline - Date.now()));
}

function boundQuery(query: string): string {
  return query.replace(/\s+/g, " ").trim().split(" ").slice(0, 8).join(" ").slice(0, 120);
}

function abandonSearches(
  budgeted: DraftSegment[],
  fromIndex: number,
  evidence: Map<string, EvidenceItem[]>,
  searchFailed: Set<string>,
  warnings: string[],
  reason: string,
): void {
  remember(warnings, new Error(reason), "search");
  for (let index = fromIndex; index < budgeted.length; index++) {
    const id = budgeted[index].id;
    if (evidence.has(id)) continue;
    searchFailed.add(id);
    evidence.set(id, []);
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms));
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isSearchable(claimType: ClaimType): boolean {
  return claimType === "checkable_factual" || claimType === "mixed";
}

function rhetoricOf(label: Label, claimType: ClaimType | undefined): Rhetoric {
  if (label === "Rhetorical" || claimType === "rhetorical") return "rhetorical";
  if (claimType === "mixed") return "loaded";
  return "neutral";
}

function surroundingParagraph(article: string, start: number, end: number): string {
  const from = Math.max(0, start - 320);
  const to = Math.min(article.length, end + 320);
  return article.slice(from, to).replace(/\s+/g, " ").trim();
}

function uniqueSpans(spans: { text: string; start: number; end: number }[]) {
  const seen = new Set<string>();
  const unique: typeof spans = [];
  for (const span of spans) {
    const key = span.text.replace(/\s+/g, " ").trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(span);
  }
  return unique;
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
