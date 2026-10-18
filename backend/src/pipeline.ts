import { isSkippableFragment, stripCredits, stripPromoItems } from "../../shared/articleText";
import { evaluativeDensity, inferClaimType, looksLikeOpinionSection, reconcileClaimType } from "../../shared/classify";
import { acceptContradiction } from "../../shared/consistency";
import {
  applyEvidence,
  canonicalUrl,
  independentEvidence,
  isRelevantEvidence,
  type EvidenceItem,
} from "../../shared/citations";
import { detectLanguage, languageMatches } from "../../shared/language";
import type { ClaimType, DetectedLanguage, Label, UiLanguage } from "../../shared/labels";
import { CLAIM_TYPES, LABELS, isUiLanguage } from "../../shared/labels";
import {
  opinionExplanation,
  rhetoricalExplanation,
  unverifiableExplanation,
} from "../../shared/messages";
import { claimImportance, compareClaims, tokenOverlap } from "../../shared/rank";
import { resolveOutlet } from "../../shared/reputation";
import { aggregateScore, isProvisionalScore } from "../../shared/score";
import { splitPastedTitle, splitSentences } from "../../shared/sentences";
import { blendTone, combineTone, type Rhetoric } from "../../shared/tone";
import type {
  AnalysisResult,
  ArticlePreview,
  Contradiction,
  SearchOutageReason,
  SearchStatus,
  SegmentResult,
  StageName,
} from "../../shared/types";
import type { Env } from "./config";
import { resolveConfig } from "./config";
import { HttpError, UpstreamError } from "./errors";
import { fetchArticle } from "./extract";
import { createTavilyGate, searchTavily } from "./tavily";
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
import {
  BudgetExhausted,
  createSubrequestBudget,
  isBudgetExhausted,
  planEvidence,
  trackFetch,
  type SubrequestBudget,
} from "./budget";
import { deadlineReached, isDeadline, raceAbort } from "./deadline";
import {
  cacheCountsAsSubrequest,
  createProviderGate,
  readVerification,
  searchWeb,
  verificationCacheKey,
  writeVerification,
  type CacheCharge,
} from "./firecrawl";
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
  /** Aborted by the request deadline. In-flight scrapes and searches must observe it. */
  signal?: AbortSignal;
  /** Test hook. Production caps the post-verify consistency call at a few seconds. */
  consistencyTimeoutMs?: number;
  /** Test hook. Production uses the worker subrequest ceiling. */
  subrequestLimit?: number;
  /** Test hook. Production caps the segmentation call at 45 seconds. */
  segmentTimeoutMs?: number;
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
  const providerGate = createProviderGate();
  const llmKey = deps.env.OPENAI_API_KEY?.trim() ?? "";
  const searchKey = deps.env.FIRECRAWL_API_KEY?.trim() ?? "";
  const tavilyKey = deps.env.TAVILY_API_KEY?.trim() ?? "";
  const tavilyGate = createTavilyGate();
  const deadline = Date.now() + (deps.budgetMs ?? LIMITS.analysisDeadlineMs);
  const owned = new AbortController();
  const abortOwned = () => owned.abort();
  deps.signal?.addEventListener("abort", abortOwned);
  const budgetTimer = setTimeout(abortOwned, Math.max(1, deadline - Date.now()));
  const signal = owned.signal;
  const cacheOn = cacheCountsAsSubrequest();
  let llmHold = 2;
  const chargeCache: CacheCharge = (op) => {
    if (op === "write" && !budget.canSpend(llmHold + 1)) return false;
    return budget.trySpend(1);
  };
  try {
  const stage = (name: StageName, status: "start" | "done" | "progress", done?: number, total?: number) =>
    deps.onStage?.(name, status, done, total);

  budget.setStage("ingest");
  stage("ingest", "start");
  const ingested = await ingest(
    input,
    fetchImpl,
    searchKey,
    warnings,
    signal,
    () => budget.canSpend(1),
    chargeCache,
    uiLanguage,
    providerGate,
    tavilyKey,
    tavilyGate,
  );
  stage("ingest", "done");
  deps.onPreview?.({
    title: ingested.title,
    text: ingested.text,
    sourceUrl: ingested.sourceUrl,
    publishedAt: ingested.publishedAt,
  });

  budget.setStage("segment");
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
    signal,
    attempts: budget.canSpend(6) ? 2 : 1,
    segmentTimeoutMs: deps.segmentTimeoutMs,
  });
  stage("segment", "done");
  if (
    segmented.genre !== "satire" &&
    segmented.genre !== "unreliable" &&
    (ingested.opinionSection ||
      looksLikeOpinionSection(ingested.sourceUrl, ingested.title, ingested.text) ||
      evaluativeDensity(segmented.segments.map((segment) => segment.text)))
  ) {
    segmented.genre = "opinion";
  }

  const searchEnabled = config.searchConfigured;
  let searchDegraded = false;
  const evidence = new Map<string, EvidenceItem[]>();

  budget.setStage("evidence");
  stage("evidence", "start");
  const searchable = segmented.segments.filter((segment) => isSearchable(segment.claimType));
  const budgeted = [...searchable].sort(compareClaims).slice(0, LIMITS.maxSearches);
  const budgetedIds = new Set(budgeted.map((segment) => segment.id));
  const overBudget = new Set(searchable.filter((segment) => !budgetedIds.has(segment.id)).map((segment) => segment.id));
  const echoOnly = new Set<string>();
  const searchFailed = new Set<string>();
  const cutShort = new Set<string>();
  let providerReason: SearchOutageReason | null = null;
  let searchAttempts = 0;
  let searchErrors = 0;
  let searchProvider: "firecrawl" | "tavily" | null = null;

  if (providerGate.block) providerReason = providerReason ?? outageFromStatus(providerGate.block.status);
  const tavilyAvailable = () => Boolean(tavilyKey) && tavilyGate.block === null;

  if (searchEnabled && (searchKey || tavilyKey) && budgeted.length > 0 && providerReason && !tavilyAvailable()) {
    abandonSearches(
      budgeted,
      0,
      evidence,
      searchFailed,
      cutShort,
      warnings,
      "search stopped after the provider rejected the request",
    );
    searchDegraded = true;
  } else if (searchEnabled && (searchKey || tavilyKey) && budgeted.length > 0) {
    // Tavily returns a snippet in the search response, so a search is one
    // subrequest and the result URLs are not scraped. Firecrawl search still
    // pays for a cache read. One extra subrequest is held back for the
    // Firecrawl call that may fail before the Tavily fallback.
    const tavilySearch = Boolean(tavilyKey);
    const searchCost = tavilySearch ? 1 : cacheOn ? 2 : 1;
    const verifyCost = cacheOn ? 2 : 1;
    const firecrawlProbe = tavilySearch && searchKey && !providerGate.block ? 1 : 0;
    const planned = planEvidence(Math.max(0, budget.remaining() - firecrawlProbe), budgeted.length, {
      search: searchCost,
      verify: verifyCost,
    });
    const selected = budgeted.slice(0, planned);
    const verifyGroups = planned === 0 ? 0 : Math.ceil(planned / 4);
    llmHold = 1 + verifyGroups;
    if (planned < budgeted.length) {
      abandonSearches(
        budgeted,
        planned,
        evidence,
        searchFailed,
        cutShort,
        warnings,
        "search stopped to stay within the worker subrequest limit",
      );
      searchDegraded = true;
    }
    const queries =
      selected.length === 0
        ? new Map<string, string>()
        : await buildQueries(selected, config, llmKey, fetchImpl, warnings, deadline, budget, signal);
    llmHold = 1 + verifyGroups;
    let finishedSearches = planned < budgeted.length ? budgeted.length - planned : 0;
    for (let index = 0; index < selected.length; index++) {
      const segment = selected[index];
      tick();
      if (signal.aborted || Date.now() > deadline - 3_000 || !budget.canSpend(searchCost)) {
        const reason =
          signal.aborted || Date.now() > deadline - 3_000
            ? "analysis deadline reached before search finished"
            : "search stopped to stay within the worker subrequest limit";
        abandonSearches(selected, index, evidence, searchFailed, cutShort, warnings, reason);
        searchDegraded = true;
        break;
      }
      if (providerReason && !tavilyAvailable()) {
        abandonSearches(
          selected,
          index,
          evidence,
          searchFailed,
          cutShort,
          warnings,
          "search stopped after the provider rejected the request",
        );
        searchDegraded = true;
        break;
      }
      const query = queries.get(segment.id) || segment.text.slice(0, 180);
      const timeoutMs = Math.max(1_000, Math.min(10_000, deadline - Date.now() - 2_000));
      try {
        searchAttempts += 1;
        const found = await retrieveHits({
          query,
          language: segmented.detectedLanguage,
          firecrawlKey: searchKey,
          tavilyKey,
          fetchImpl,
          timeoutMs,
          canSpend: () => budget.canSpend(1),
          signal,
          charge: chargeCache,
          firecrawlGate: providerGate,
          tavilyGate,
          deadline,
        });
        if (found.provider === "tavily") searchProvider = "tavily";
        else if (searchProvider !== "tavily") searchProvider = "firecrawl";
        const hits = dedupeEvidence(found.hits);
        const independent = independentEvidence(hits, {
          articleDomain: ingested.sourceDomain,
          articleText: ingested.text,
          articleTitle: ingested.title,
          claimText: segment.text,
        }).filter((item) => isRelevantEvidence(segment.text, item));
        if (hits.length > 0 && independent.length === 0) echoOnly.add(segment.id);
        evidence.set(segment.id, independent);
      } catch (error) {
        remember(warnings, error, "search");
        searchDegraded = true;
        searchErrors += 1;
        searchFailed.add(segment.id);
        cutShort.add(segment.id);
        evidence.set(segment.id, []);
        const outage = providerOutage(error);
        if (outage) providerReason = providerReason ?? outage;
        if (outage || isBudgetExhausted(error) || signal.aborted) {
          abandonSearches(
            selected,
            index + 1,
            evidence,
            searchFailed,
            cutShort,
            warnings,
            outage
              ? "search stopped after the provider rejected the request"
              : isBudgetExhausted(error)
                ? "search stopped to stay within the worker subrequest limit"
                : "analysis deadline reached before search finished",
          );
          break;
        }
      }
      finishedSearches += 1;
      stage("evidence", "progress", Math.min(finishedSearches, budgeted.length), budgeted.length);
    }
  }
  stage("evidence", "done");

  budget.setStage("verify");
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
    if (signal.aborted || Date.now() > deadline || !budget.canSpend(1)) {
      remember(warnings, new Error("analysis deadline reached before verification finished"), "llm");
      for (const group of groups.slice(cursor)) {
        for (const segment of group) {
          verified.set(segment.id, unverifiedSegment(segment, uiLanguage, searchEnabled, "check-failed"));
          cutShort.add(segment.id);
        }
      }
      break;
    }
    const parallel = Math.max(1, Math.min(groups.length - cursor, Math.max(1, budget.remaining() - 1)));
    const batch = groups.slice(cursor, cursor + parallel);
    cursor += batch.length;
    const attempts = budget.canSpend(6) ? 2 : 1;
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
              articleTitle: ingested.title,
              attempts,
              timeoutMs,
              signal,
              charge: chargeCache,
              suppressModelKnowledge: providerReason !== null,
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
            cutShort.add(segment.id);
          }
        }
      }),
    );
    if (signal.aborted || !budget.canSpend(1)) {
      for (const group of groups.slice(cursor)) {
        for (const segment of group) {
          if (verified.has(segment.id)) continue;
          verified.set(segment.id, unverifiedSegment(segment, uiLanguage, searchEnabled, "check-failed"));
          cutShort.add(segment.id);
        }
      }
      break;
    }
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
  tick();

  budget.setStage("score");
  stage("score", "start");
  tick();
  const ordered = segmented.segments
    .map((segment) => verified.get(segment.id))
    .filter((segment): segment is SegmentResult => Boolean(segment));

  const consistencyMs =
    deps.consistencyTimeoutMs ?? Math.min(8_000, deadline - Date.now() - 500);
  const evidenceBacked = [...evidence.values()].filter((items) => items.length > 0).length;
  if (searchProvider === "tavily" && searchErrors === 0) providerReason = null;
  let contradictions: Contradiction[] = [];
  const skipConsistency = providerReason !== null && evidenceBacked === 0;
  if (!signal.aborted && consistencyMs >= 200 && budget.canSpend(1) && !skipConsistency) {
    try {
      contradictions = await withTimeout(
        findContradictions({
          segments: ordered,
          uiLanguage,
          config,
          apiKey: llmKey,
          fetchImpl,
          warnings,
          deadline,
          timeoutMs: consistencyMs,
          signal,
        }),
        consistencyMs + 400,
        "consistency timed out",
      );
    } catch (error) {
      remember(warnings, error, "llm");
      contradictions = [];
    }
  }
  tick();

  const draftById = new Map(segmented.segments.map((segment) => [segment.id, segment]));
  const searchStatus = resolveSearchStatus({
    searchEnabled,
    providerReason,
    searchAttempts,
    searchErrors,
    searchDegraded,
    evidenceBacked,
    provider: searchProvider,
  });
  if (searchStatus.state !== "ok") {
    for (const segment of ordered) {
      if (segment.sources.length === 0 && segment.confidence > 0.4) segment.confidence = 0.4;
    }
  }
  const claimsVerified = budgeted.filter((segment) => {
    const checked = verified.get(segment.id);
    return Boolean(checked && checked.sources.length > 0);
  }).length;
  const claimsTotal = budgeted.length;
  const provisional = isProvisionalScore({
    searchEnabled,
    searchState: searchStatus.state,
    claimsVerified,
    claimsTotal,
  });
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
      countsTowardScore: !cutShort.has(segment.id),
    })),
    {
      contradictionCount: contradictions.length,
      searchEnabled,
      searchDegraded,
      uiLanguage,
      outlet,
      degraded: cutShort.size > 0,
      claimsVerified,
      claimsTotal,
      provisional,
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
    degraded: cutShort.size > 0,
    claimsVerified,
    claimsTotal,
    provisional,
    meta: {
      searchEnabled,
      searchDegraded,
      searchStatus,
      model: config.llmModel,
      uiLanguage,
      requestId,
      extraction: ingested.extraction,
      warnings,
      outlet,
      subrequests: budget.snapshot(),
    },
  };
  } finally {
    clearTimeout(budgetTimer);
    deps.signal?.removeEventListener("abort", abortOwned);
  }
}

async function ingest(
  input: AnalyzeInput,
  fetchImpl: typeof fetch,
  firecrawlKey: string | undefined,
  warnings: string[],
  signal?: AbortSignal,
  canSpend?: () => boolean,
  charge?: CacheCharge,
  uiLanguage: UiLanguage = "en",
  gate?: ReturnType<typeof createProviderGate>,
  tavilyKey?: string,
  tavilyGate?: ReturnType<typeof createTavilyGate>,
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
    const extracted = await fetchArticle(
      url,
      fetchImpl,
      firecrawlKey,
      signal,
      canSpend,
      charge,
      uiLanguage,
      gate,
      tavilyKey,
      tavilyGate,
    );
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
      opinionSection: extracted.opinionSection === true,
    };
  }

  let raw = stripPromoItems(stripCredits(normalizeWhitespace(input.text || "")));
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
    opinionSection: looksLikeOpinionSection(null, split.title, split.body),
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
  signal?: AbortSignal;
  attempts: number;
  segmentTimeoutMs?: number;
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
    .sort((a, b) => compareClaims(
      { importance: a.importance, start: a.span.start, text: a.span.text },
      { importance: b.importance, start: b.span.start, text: b.span.text },
    ));
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
  const segmentCap = options.segmentTimeoutMs ?? 45_000;
  const segmentMs = Math.min(segmentCap, Math.max(300, options.deadline - Date.now()));
  if (Date.now() < options.deadline - 1_000) {
    try {
      const parsed = await withTimeout(
        raceAbort(
          completeJson({
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
            timeoutMs: segmentMs,
            signal: options.signal,
            attempts: options.attempts,
          }),
          options.signal,
        ),
        segmentMs + 500,
        "segment timed out",
      );
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
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const queries = new Map<string, string>();
  if (segments.length === 0) return queries;
  for (const batch of chunk(segments, LIMITS.maxSearches)) {
    if (Date.now() > deadline - 8_000 || !budget.canSpend(1)) {
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
        signal,
      });
      for (const item of parsed) queries.set(item.id, item.query);
    } catch (error) {
      remember(warnings, error, "llm");
      if (isBudgetExhausted(error)) break;
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
  articleTitle: string | null;
  attempts: number;
  timeoutMs: number;
  signal?: AbortSignal;
  charge?: CacheCharge;
  suppressModelKnowledge?: boolean;
}): Promise<Map<string, SegmentResult>> {
  const results = new Map<string, SegmentResult>();
  const pending: DraftSegment[] = [];
  for (const segment of options.group) {
    const urls = (options.evidence.get(segment.id) ?? []).map((item) => item.url);
    const key = verificationCacheKey(segment.text, urls, options.uiLanguage);
    const cached = await readVerification(key, options.charge);
    if (!cached || !(LABELS as readonly string[]).includes(cached.label)) {
      pending.push(segment);
      continue;
    }
    results.set(
      segment.id,
      finishSegment(
        segment,
        applyEvidence({
          label: cached.label as Label,
          confidence: cached.confidence,
          explanation: cached.explanation,
          claimText: segment.text,
          sourceUrls: cached.sourceUrls,
          relevance: cached.relevance ?? null,
          evidence: options.evidence.get(segment.id) ?? [],
          searchEnabled: options.searchEnabled,
          uiLanguage: options.uiLanguage,
          articleDomain: options.articleDomain,
          articleText: options.articleText,
          articleTitle: options.articleTitle,
          allowModelKnowledge:
            options.searchEnabled && urls.length === 0 && !options.suppressModelKnowledge,
        }),
      ),
    );
  }
  if (pending.length === 0) return results;
  const pendingIds = new Set(pending.map((segment) => segment.id));
  const parsed = await completeJson({
    config: options.config,
    apiKey: options.apiKey,
    fetchImpl: options.fetchImpl,
    system: verifySystem(options.uiLanguage, options.searchEnabled),
    user: verifyUser(
      pending.map((segment) => ({
        id: segment.id,
        claim: segment.text,
        context: surroundingParagraph(options.articleText, segment.start, segment.end),
        evidence: (options.evidence.get(segment.id) ?? []).map((item) => ({
          url: item.url,
          title: item.title,
          snippet: item.snippet,
          ...(item.publishedAt ? { publishedAt: item.publishedAt } : {}),
        })),
      })),
      options.publishedAt,
    ),
    validate: (data) => validateVerdicts(data, pendingIds, options.uiLanguage),
    reasoningEffort: "medium",
    attempts: options.attempts,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });

  for (const segment of pending) {
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
      relevance: verdict.relevance,
      evidence: options.evidence.get(segment.id) ?? [],
      searchEnabled: options.searchEnabled,
      uiLanguage: options.uiLanguage,
      articleDomain: options.articleDomain,
      articleText: options.articleText,
      articleTitle: options.articleTitle,
      allowModelKnowledge:
        options.searchEnabled &&
        (options.evidence.get(segment.id)?.length ?? 0) === 0 &&
        !options.suppressModelKnowledge,
    });
    results.set(segment.id, finishSegment(segment, applied));
    const urls = (options.evidence.get(segment.id) ?? []).map((item) => item.url);
    await writeVerification(
      verificationCacheKey(segment.text, urls, options.uiLanguage),
      {
        label: verdict.label,
        confidence: verdict.confidence,
        explanation: verdict.explanation,
        sourceUrls: verdict.sourceUrls,
        ...(verdict.relevance ? { relevance: verdict.relevance } : {}),
      },
      options.charge,
    );
  }
  return results;
}

function validateVerdicts(
  data: unknown,
  ids: Set<string>,
  uiLanguage: UiLanguage,
): {
  id: string;
  label: Label;
  confidence: number;
  explanation: string;
  sourceUrls: string[];
  relevance: Record<string, boolean> | null;
}[] {
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
      relevance: readRelevance(item),
    };
  });
  const seen = new Set(results.map((item) => item.id));
  for (const id of ids) {
    if (!seen.has(id)) throw new Error(`missing verdict for ${id}`);
  }
  return results.filter((item) => ids.has(item.id));
}

function readRelevance(item: Record<string, unknown>): Record<string, boolean> | null {
  if (!Array.isArray(item.sources)) return null;
  const relevance: Record<string, boolean> = {};
  let flagged = false;
  for (const source of item.sources) {
    if (!isRecord(source) || typeof source.url !== "string" || typeof source.relevant !== "boolean") continue;
    relevance[canonicalUrl(source.url)] = source.relevant;
    flagged = true;
  }
  return flagged ? relevance : null;
}

async function findContradictions(options: {
  segments: SegmentResult[];
  uiLanguage: UiLanguage;
  config: ReturnType<typeof resolveConfig>;
  apiKey: string;
  fetchImpl: typeof fetch;
  warnings: string[];
  deadline: number;
  timeoutMs: number;
  signal?: AbortSignal;
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
      attempts: 1,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      user: consistencyUser(
        factual.map((segment) => ({
          id: segment.id,
          text: segment.text,
          label: segment.label,
        })),
      ),
      validate: (data) => validateContradictions(data, options.uiLanguage),
    });
    const known = factual.map((segment) => ({ id: segment.id, text: segment.text }));
    const unique: Contradiction[] = [];
    const seen = new Set<string>();
    for (const item of parsed) {
      if (!acceptContradiction(item, known)) continue;
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

function outageFromStatus(status: number): SearchOutageReason | null {
  if (status === 402 || status === 432) return "out_of_credits";
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "upstream_error";
  return null;
}

function providerOutage(error: unknown): SearchOutageReason | null {
  const message = error instanceof Error ? error.message : "";
  if (/HTTP\s*402\b|HTTP\s*432\b|insufficient credits|usage limit/i.test(message)) return "out_of_credits";
  if (/HTTP\s*401\b|HTTP\s*403\b/.test(message)) return "unauthorized";
  if (/HTTP\s*429\b/.test(message)) return "rate_limited";
  if (/HTTP\s*5\d\d\b/.test(message)) return "upstream_error";
  return null;
}

function tavilyCanCover(error: unknown): boolean {
  if (isBudgetExhausted(error) || isDeadline(error)) return false;
  const message = error instanceof Error ? error.message : "";
  if (/timed out|timeout/i.test(message)) return true;
  return providerOutage(error) !== null;
}

async function retrieveHits(options: {
  query: string;
  language: DetectedLanguage;
  firecrawlKey: string;
  tavilyKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  canSpend: () => boolean;
  signal?: AbortSignal;
  charge?: CacheCharge;
  firecrawlGate: ReturnType<typeof createProviderGate>;
  tavilyGate: ReturnType<typeof createTavilyGate>;
  deadline: number;
}): Promise<{ hits: EvidenceItem[]; provider: "firecrawl" | "tavily" }> {
  let firecrawlError: unknown = null;
  if (options.firecrawlKey && !options.firecrawlGate.block) {
    try {
      const hits = await withTimeout(
        searchWeb({
          apiKey: options.firecrawlKey,
          query: options.query,
          language: options.language,
          fetchImpl: options.fetchImpl,
          timeoutMs: options.timeoutMs,
          canSpend: options.canSpend,
          signal: options.signal,
          charge: options.charge,
          gate: options.firecrawlGate,
        }),
        options.timeoutMs + 750,
        "search timed out",
      );
      return { hits, provider: "firecrawl" };
    } catch (error) {
      if (isBudgetExhausted(error) || isDeadline(error) || options.signal?.aborted) throw error;
      firecrawlError = error;
      if (!options.tavilyKey || options.tavilyGate.block || !tavilyCanCover(error)) throw error;
    }
  }
  if (!options.tavilyKey || options.tavilyGate.block) {
    if (firecrawlError) throw firecrawlError;
    throw new Error("search failed");
  }
  if (!options.canSpend() || options.signal?.aborted || Date.now() > options.deadline - 3_000) {
    if (firecrawlError) throw firecrawlError;
    if (options.signal?.aborted || Date.now() > options.deadline - 3_000) throw deadlineReached();
    throw new BudgetExhausted();
  }
  // The search response already includes the snippet. Do not scrape each URL.
  const hits = await withTimeout(
    searchTavily({
      apiKey: options.tavilyKey,
      query: options.query,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      topic: "news",
      limit: 5,
      includeRawContent: true,
      gate: options.tavilyGate,
    }),
    options.timeoutMs + 750,
    "search timed out",
  );
  return { hits, provider: "tavily" };
}

function resolveSearchStatus(input: {
  searchEnabled: boolean;
  providerReason: SearchOutageReason | null;
  searchAttempts: number;
  searchErrors: number;
  searchDegraded: boolean;
  evidenceBacked: number;
  provider: "firecrawl" | "tavily" | null;
}): SearchStatus {
  if (!input.searchEnabled) return { state: "ok", reason: null, provider: null };
  const failedMost = input.searchAttempts > 0 && input.searchErrors > input.searchAttempts / 2;
  if (input.providerReason) {
    return {
      state: input.evidenceBacked === 0 ? "unavailable" : "partial",
      reason: input.providerReason,
      provider: input.provider,
    };
  }
  if (failedMost) {
    return {
      state: input.evidenceBacked === 0 ? "unavailable" : "partial",
      reason: "failed",
      provider: input.provider,
    };
  }
  if (input.searchDegraded && input.searchErrors > 0) {
    return { state: "partial", reason: "failed", provider: input.provider };
  }
  return { state: "ok", reason: null, provider: input.provider };
}

function abandonSearches(
  budgeted: DraftSegment[],
  fromIndex: number,
  evidence: Map<string, EvidenceItem[]>,
  searchFailed: Set<string>,
  cutShort: Set<string>,
  warnings: string[],
  reason: string,
): void {
  remember(warnings, new Error(reason), "search");
  for (let index = fromIndex; index < budgeted.length; index++) {
    const id = budgeted[index].id;
    if (evidence.has(id) && !searchFailed.has(id)) continue;
    searchFailed.add(id);
    cutShort.add(id);
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
  const kept: { key: string; span: (typeof spans)[number] }[] = [];
  for (const span of spans) {
    const key = span.text
      .replace(/\s+/g, " ")
      .replace(/^(?:photograph|photo|image|caption|credit|φωτογραφία|εικόνα)\s*[:：]\s*/i, "")
      .trim()
      .toLowerCase();
    if (!key) continue;
    if (kept.some((item) => item.key === key || captionDuplicate(item.key, key))) continue;
    kept.push({ key, span });
  }
  return kept.map((item) => item.span);
}

function captionDuplicate(left: string, right: string): boolean {
  if (left.length < 24 || right.length < 24) return false;
  return Math.min(tokenOverlap(left, right), tokenOverlap(right, left)) >= 0.9;
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
