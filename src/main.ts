import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/greek-400.css";
import "@fontsource/ibm-plex-sans/greek-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/source-serif-4/latin-400.css";
import "@fontsource/source-serif-4/latin-600.css";
import "@fontsource/source-serif-4/greek-400.css";
import "@fontsource/source-serif-4/greek-600.css";
import "./styles.css";
import { renderHighlighted } from "../shared/highlight";
import { LABELS, type UiLanguage } from "../shared/labels";
import { partialClaimsNotice } from "../shared/messages";
import type { AnalysisResult, SearchOutageReason, SegmentResult, StageName } from "../shared/types";
import { CONSENT_STORAGE_KEY, grantAnalytics, injectGtag, readConsent, scheduleGtag, trackAnalyzeStarted, trackPageView } from "./analytics";
import { AnalysisError, analyzeArticle, fetchHealth, STALL_MESSAGE } from "./api";
import { presentLimit } from "./limitCopy";
import { detectedName, labelHelp, labelName, t, type MessageKey } from "./i18n";
import { scheduleKofi } from "./kofi";
import { appBaseFromPath, documentMeta, languageUrl, pageLangFromSearch, siteBase } from "./seo";
import { CLAIM_LIMIT, joinNotice, parseFilter, presentLabels, visibleClaims, type ClaimFilter } from "./resultsView";
import { buildSample } from "./sample";

const STAGES: StageName[] = ["ingest", "segment", "evidence", "verify", "score"];
const STAGE_KEY: Record<StageName, MessageKey> = {
  ingest: "stageIngest",
  segment: "stageSegment",
  evidence: "stageEvidence",
  verify: "stageVerify",
  score: "stageScore",
};
const ARC = 326.726;

type StageState = "pending" | "active" | "done";

const state: {
  lang: UiLanguage;
  mode: "paste" | "url";
  running: boolean;
  result: AnalysisResult | null;
  sample: boolean;
  claimFilter: ClaimFilter;
  showAllClaims: boolean;
  openClaimId: string | null;
} = {
  lang: "en",
  mode: "paste",
  running: false,
  result: null,
  sample: false,
  claimFilter: "all",
  showAllClaims: false,
  openClaimId: null,
};

const mount = document.querySelector<HTMLElement>("#app");
if (!mount) throw new Error("Missing #app");
const app: HTMLElement = mount;

app.classList.add("app");
app.dataset.phase = "idle";
app.innerHTML = `
  <a class="skip" href="#composer" data-i18n="skip"></a>
  <div class="consent" id="consent" role="region" aria-labelledby="consent-title" hidden>
    <div class="consent-copy">
      <p class="consent-title" id="consent-title" data-i18n="consentTitle"></p>
      <p class="consent-body" data-i18n="consentBody"></p>
    </div>
    <div class="consent-actions">
      <button type="button" id="consent-decline" data-i18n="consentDecline"></button>
      <button type="button" class="consent-accept" id="consent-accept" data-i18n="consentAccept"></button>
    </div>
  </div>
  <header class="top">
    <div class="brand">
      <svg class="mark" viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r="20" fill="none" stroke="currentColor" stroke-width="1.5"></circle>
        <path d="M11 24c3.2-6 6.4-8.5 11-8.5S29.8 18 33 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
        <circle cx="22" cy="23" r="2.4" fill="currentColor"></circle>
      </svg>
      <div>
        <p class="kicker" data-i18n="kicker"></p>
        <h1 id="page-title" tabindex="-1" data-i18n="title"></h1>
        <p class="tagline" data-i18n="tagline"></p>
      </div>
    </div>
    <div class="header-side">
      <a class="github-link" href="https://github.com/hellenicdev/aletheia" target="_blank" rel="noopener noreferrer" data-i18n-aria="github">
        <svg class="github-mark" viewBox="0 0 16 16" aria-hidden="true">
          <path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"></path>
        </svg>
        <span class="github-label">GitHub</span>
      </a>
      <p class="health" id="health" data-state="unknown"></p>
      <div class="langs" role="group" aria-labelledby="lang-label">
        <span id="lang-label" class="visually-hidden" data-i18n="languageGroup"></span>
        <button type="button" data-lang="en" aria-pressed="true">EN</button>
        <button type="button" data-lang="el" aria-pressed="false">EL</button>
      </div>
      <button class="ghost" type="button" id="expand-button" data-i18n="newAnalysis" hidden></button>
    </div>
  </header>
  <main class="layout" id="layout">
    <div class="stack">
      <section class="composer" id="composer">
        <div class="tabs" role="tablist">
          <button type="button" role="tab" id="tab-paste" aria-controls="panel-paste" aria-selected="true" tabindex="0" data-i18n="paste"></button>
          <button type="button" role="tab" id="tab-url" aria-controls="panel-url" aria-selected="false" tabindex="-1" data-i18n="url"></button>
        </div>
        <form id="analyze-form">
          <div id="panel-paste" role="tabpanel" aria-labelledby="tab-paste">
            <label class="field">
              <span data-i18n="articleLabel"></span>
              <textarea id="article-text" data-i18n-placeholder="placeholderPaste" maxlength="12000" aria-describedby="char-count-label"></textarea>
            </label>
          </div>
          <div id="panel-url" role="tabpanel" aria-labelledby="tab-url" hidden>
            <label class="field">
              <span data-i18n="urlLabel"></span>
              <input id="article-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" data-i18n-placeholder="placeholderUrl" />
            </label>
          </div>
          <div class="composer-foot">
            <span class="counter" id="char-count-label"><span id="char-count">0</span> / 12000 <span data-i18n="chars"></span></span>
            <div class="actions">
              <button class="ghost" type="button" id="sample-button" data-i18n="sample"></button>
              <button class="primary" type="submit" id="analyze-button" data-i18n="analyze"></button>
            </div>
          </div>
          <p class="error" id="form-error" role="alert" hidden></p>
          <button class="ghost" type="button" id="retry-button" data-i18n="retry" hidden></button>
        </form>
      </section>
      <section id="stages" hidden tabindex="-1" aria-labelledby="stages-label">
        <h2 id="stages-label" class="visually-hidden" data-i18n="stagesLabel"></h2>
        <ol class="stepper" id="stage-list"></ol>
        <p class="step-name" id="step-name" aria-live="polite"></p>
      </section>
      <details class="fold" id="extract-preview" hidden>
        <summary><span data-i18n="extracted"></span><span class="fold-aside" id="preview-title"></span></summary>
        <div class="fold-body">
          <p class="hint" data-i18n="extractedHint"></p>
          <div class="article-body preview-body" id="preview-body"></div>
        </div>
      </details>
      <section id="report" hidden tabindex="-1" aria-labelledby="score-label">
        <div class="focal">
          <div class="gauge" id="gauge" data-band="mid" role="img">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle class="gauge-track" cx="60" cy="60" r="52"></circle>
              <circle class="gauge-value" id="gauge-value" cx="60" cy="60" r="52"></circle>
            </svg>
            <div class="gauge-readout">
              <span class="gauge-number" id="gauge-number">—</span>
              <span class="gauge-of">/100</span>
              <span class="gauge-status" id="gauge-status" hidden></span>
            </div>
          </div>
          <div>
            <p class="section-label" id="score-label" data-i18n="scoreLabel"></p>
            <p class="verdict" id="verdict" tabindex="-1" aria-live="polite"></p>
            <p class="notice" id="notice" hidden></p>
          </div>
        </div>
        <div class="summary" id="summary" role="group" aria-labelledby="claims-heading"></div>
        <h2 class="claims-heading" id="claims-heading" data-i18n="claimsHeading"></h2>
        <div class="claim-list" id="claim-list"></div>
        <button class="ghost show-all" type="button" id="show-all-claims" hidden></button>
        <div class="folds">
          <details class="fold" id="ignored-fold" hidden>
            <summary id="ignored-summary"></summary>
          </details>
          <details class="fold" id="breakdown">
            <summary data-i18n="breakdownTitle"></summary>
            <div class="fold-body">
              <div class="subs" id="subscores"></div>
              <div id="contradictions"></div>
              <ul class="warnings" id="warnings" hidden></ul>
            </div>
          </details>
          <details class="fold" id="article-fold">
            <summary><span data-i18n="articleFold"></span><span class="fold-aside" id="article-title"></span></summary>
            <div class="fold-body">
              <h3 class="article-title" id="article-heading"></h3>
              <p class="meta" id="article-meta"></p>
              <div class="article-body" id="article-body"></div>
            </div>
          </details>
          <details class="fold" id="labels-fold">
            <summary data-i18n="labelsFold"></summary>
            <div class="fold-body"><div class="legend-list" id="legend"></div></div>
          </details>
          <details class="fold method">
            <summary data-i18n="howTitle"></summary>
            <div class="fold-body">
              <p data-i18n="howBody"></p>
              <p class="method-provider" id="search-provider" hidden></p>
            </div>
          </details>
        </div>
      </section>
    </div>
  </main>
  <footer class="foot" data-i18n="disclaimer"></footer>
`;

const $ = <T extends Element>(selector: string) => {
  const node = app.querySelector<T>(selector);
  if (!node) throw new Error(`Missing ${selector}`);
  return node;
};

const textInput = $<HTMLTextAreaElement>("#article-text");
const urlInput = $<HTMLInputElement>("#article-url");
const form = $<HTMLFormElement>("#analyze-form");
const errorBox = $<HTMLParagraphElement>("#form-error");
const retryButton = $<HTMLButtonElement>("#retry-button");
const analyzeButton = $<HTMLButtonElement>("#analyze-button");
const charCount = $<HTMLElement>("#char-count");
const composer = $<HTMLElement>("#composer");
const stagesEl = $<HTMLElement>("#stages");
const stageList = $<HTMLOListElement>("#stage-list");
const stepName = $<HTMLElement>("#step-name");
const report = $<HTMLElement>("#report");
const verdictEl = $<HTMLElement>("#verdict");
const gauge = $<HTMLElement>("#gauge");
const gaugeValue = $<SVGCircleElement>("#gauge-value");
const gaugeNumber = $<HTMLElement>("#gauge-number");
const gaugeStatus = $<HTMLElement>("#gauge-status");
const newAnalysis = $<HTMLButtonElement>("#expand-button");
let healthKind: "unknown" | "down" | "search" | "nosearch" = "unknown";

function renderHealth() {
  const node = $<HTMLElement>("#health");
  node.dataset.state = healthKind;
  if (healthKind === "unknown") {
    node.textContent = "";
    return;
  }
  const key: MessageKey =
    healthKind === "down" ? "backendDown" : healthKind === "search" ? "searchOn" : "searchOff";
  node.textContent = t(state.lang, key);
}

function applyHead() {
  const base = siteBase(location.hostname, location.origin, appBaseFromPath(location.pathname));
  const meta = documentMeta(state.lang, base);
  document.documentElement.lang = state.lang;
  document.title = meta.title;
  setMetaName("description", meta.description);
  setMetaProperty("og:title", meta.title);
  setMetaProperty("og:description", meta.description);
  setMetaProperty("og:url", meta.canonical);
  setMetaProperty("og:locale", meta.locale);
  setMetaName("twitter:title", meta.title);
  setMetaName("twitter:description", meta.description);
  setMetaProperty("og:image:alt", meta.imageAlt);
  setMetaName("twitter:image:alt", meta.imageAlt);
  setCanonical(meta.canonical);
  setAlternate("en", meta.alternates.en);
  setAlternate("el", meta.alternates.el);
  setAlternate("x-default", meta.alternates["x-default"]);
}

function setMetaName(name: string, content: string) {
  let node = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!node) {
    node = document.createElement("meta");
    node.name = name;
    document.head.append(node);
  }
  node.content = content;
}

function setMetaProperty(property: string, content: string) {
  let node = document.head.querySelector<HTMLMetaElement>(`meta[property="${property}"]`);
  if (!node) {
    node = document.createElement("meta");
    node.setAttribute("property", property);
    document.head.append(node);
  }
  node.content = content;
}

function setCanonical(href: string) {
  let node = document.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
  if (!node) {
    node = document.createElement("link");
    node.rel = "canonical";
    document.head.append(node);
  }
  node.href = href;
}

function setAlternate(hreflang: string, href: string) {
  let node = document.head.querySelector<HTMLLinkElement>(`link[rel="alternate"][hreflang="${hreflang}"]`);
  if (!node) {
    node = document.createElement("link");
    node.rel = "alternate";
    node.hreflang = hreflang;
    document.head.append(node);
  }
  node.href = href;
}

function syncSkip() {
  const skip = $<HTMLAnchorElement>(".skip");
  const phase = app.dataset.phase;
  if (phase === "result") {
    skip.href = "#report";
    skip.dataset.i18n = "skipResults";
  } else if (phase === "running") {
    skip.href = "#stages";
    skip.dataset.i18n = "skipProgress";
  } else {
    skip.href = "#composer";
    skip.dataset.i18n = "skip";
  }
  const key = skip.dataset.i18n as MessageKey;
  skip.textContent = t(state.lang, key);
}

function applyI18n() {
  applyHead();
  for (const node of app.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = node.dataset.i18n as MessageKey;
    node.textContent = t(state.lang, key);
  }
  for (const node of app.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    const key = node.dataset.i18nPlaceholder as MessageKey;
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      node.placeholder = t(state.lang, key);
    }
  }
  for (const node of app.querySelectorAll<HTMLElement>("[data-i18n-aria]")) {
    const key = node.dataset.i18nAria as MessageKey;
    node.setAttribute("aria-label", t(state.lang, key));
  }
  syncSkip();
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === state.lang));
  }
  renderLegend();
  renderHealth();
  renderStages(currentStages());
  renderScore();
  renderIgnored();
  renderClaims();
  if (state.result) renderArticle();
}

function setLanguage(lang: UiLanguage) {
  try {
    localStorage.setItem("aletheia-lang", lang);
  } catch {
    /* Storage can be blocked. */
  }
  const next = languageUrl(location.pathname, location.search, lang);
  if (next !== `${location.pathname}${location.search}`) {
    location.assign(`${next}${location.hash}`);
    return;
  }
  state.lang = lang;
  if (state.sample && state.result) state.result = buildSample(lang);
  applyI18n();
  if (storedConsent()) scheduleKofi(window, lang);
}

function setMode(mode: "paste" | "url") {
  state.mode = mode;
  const paste = $<HTMLButtonElement>("#tab-paste");
  const url = $<HTMLButtonElement>("#tab-url");
  paste.setAttribute("aria-selected", String(mode === "paste"));
  url.setAttribute("aria-selected", String(mode === "url"));
  paste.tabIndex = mode === "paste" ? 0 : -1;
  url.tabIndex = mode === "url" ? 0 : -1;
  $<HTMLElement>("#panel-paste").hidden = mode !== "paste";
  $<HTMLElement>("#panel-url").hidden = mode !== "url";
}

function showError(message: string | null, retryable = false) {
  errorBox.hidden = !message;
  errorBox.textContent = message ? presentError(message) : "";
  retryButton.hidden = !message || !retryable;
}

function presentCaught(error: unknown): string {
  if (error instanceof AnalysisError) {
    const limited = presentLimit(error, state.lang);
    if (limited) return limited;
  }
  return error instanceof Error ? presentError(error.message) : t(state.lang, "errorEmpty");
}

function presentError(message: string): string {
  if (/firecrawl scrape failed|could not be read|επικολλήστε το κείμενο του άρθρου/i.test(message)) {
    return t(state.lang, "scrapeFailed");
  }
  if (message === STALL_MESSAGE) return t(state.lang, "errorStall");
  return message;
}

function canRetry(message: string): boolean {
  return (
    message === STALL_MESSAGE ||
    /ended without a result|interrupted before a verdict|timed out before a verdict/i.test(message)
  );
}

function currentStages(): Record<StageName, StageState> {
  return stageMemory;
}

const stageDetail: Partial<Record<StageName, string>> = {};

const stageMemory: Record<StageName, StageState> = {
  ingest: "pending",
  segment: "pending",
  evidence: "pending",
  verify: "pending",
  score: "pending",
};

function resetStages() {
  for (const stage of STAGES) {
    stageMemory[stage] = "pending";
    delete stageDetail[stage];
  }
  $<HTMLElement>("#extract-preview").hidden = true;
  renderStages(stageMemory);
}

function setStage(stage: StageName, status: "start" | "done" | "progress", done?: number, total?: number) {
  if (status === "progress") {
    if (done !== undefined && total !== undefined) stageDetail[stage] = `${done}/${total}`;
    renderStages(stageMemory);
    return;
  }
  if (status === "start") {
    for (const name of STAGES) {
      if (stageMemory[name] === "active") stageMemory[name] = "done";
    }
    stageMemory[stage] = "active";
  } else {
    stageMemory[stage] = "done";
  }
  renderStages(stageMemory);
}

function renderStages(stages: Record<StageName, StageState>) {
  stageList.replaceChildren();
  let current: StageName | null = null;
  for (const stage of STAGES) {
    const item = document.createElement("li");
    item.dataset.state = stages[stage];
    const label = t(state.lang, STAGE_KEY[stage]);
    const statusKey: MessageKey =
      stages[stage] === "active" ? "stageActive" : stages[stage] === "done" ? "stageDone" : "stagePending";
    item.setAttribute("aria-label", `${label}, ${t(state.lang, statusKey)}`);
    if (stages[stage] === "active") {
      item.setAttribute("aria-current", "step");
      current = stage;
    }
    const dot = document.createElement("span");
    dot.className = "step-dot";
    item.append(dot);
    stageList.append(item);
  }
  const named = current ?? STAGES.find((stage) => stages[stage] === "pending") ?? null;
  const progress = named ? stageDetail[named] : "";
  stepName.textContent = named ? `${t(state.lang, STAGE_KEY[named])}${progress ? ` ${progress}` : ""}` : "";
}

function renderLegend() {
  const legend = $<HTMLElement>("#legend");
  legend.replaceChildren();
  for (const label of LABELS) {
    const item = document.createElement("div");
    item.className = "legend-item";
    item.dataset.label = label;
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = labelName(state.lang, label);
    const help = document.createElement("p");
    help.textContent = labelHelp(state.lang, label);
    copy.append(title, help);
    item.append(swatch, copy);
    legend.append(item);
  }
}

function renderSummary(segments: SegmentResult[]) {
  const row = $<HTMLElement>("#summary");
  row.replaceChildren();
  const all = document.createElement("button");
  all.type = "button";
  all.dataset.filter = "all";
  all.setAttribute("aria-pressed", String(state.claimFilter === "all"));
  all.textContent = `${t(state.lang, "filterAll")} ${segments.length}`;
  row.append(all);
  for (const label of presentLabels(segments)) {
    const count = segments.filter((segment) => segment.label === label).length;
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.filter = label;
    button.setAttribute("aria-pressed", String(state.claimFilter === label));
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.setAttribute("aria-hidden", "true");
    button.append(swatch, document.createTextNode(`${count} ${labelName(state.lang, label)}`));
    row.append(button);
  }
  const tone = document.createElement("span");
  tone.className = "tone-chip";
  const toneValue = state.result?.score.toneNeutrality;
  tone.textContent = `${t(state.lang, "toneShort")} ${toneValue === null || toneValue === undefined ? "—" : toneValue}`;
  row.append(tone);
}

function renderClaims() {
  const list = $<HTMLElement>("#claim-list");
  const more = $<HTMLButtonElement>("#show-all-claims");
  list.replaceChildren();
  const segments = state.result?.segments ?? [];
  renderSummary(segments);
  const { visible, total } = visibleClaims(segments, state.claimFilter, state.showAllClaims);
  for (const segment of visible) list.append(claimCard(segment));
  more.hidden = total <= CLAIM_LIMIT;
  more.textContent = state.showAllClaims ? t(state.lang, "showFewer") : `${t(state.lang, "showAll")} (${total})`;
  more.setAttribute("aria-expanded", String(state.showAllClaims));
}

function claimCard(segment: SegmentResult): HTMLElement {
  const open = state.openClaimId === segment.id;
  const card = document.createElement("article");
  card.className = "claim-card";
  card.id = `claim-${segment.id}`;
  card.dataset.label = segment.label;
  const top = document.createElement("div");
  top.className = "claim-top";
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.dataset.label = segment.label;
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  swatch.setAttribute("aria-hidden", "true");
  pill.append(swatch, document.createTextNode(labelName(state.lang, segment.label)));
  const confidence = document.createElement("span");
  confidence.className = "claim-confidence";
  const percent = Math.round(segment.confidence * 100);
  const confidenceName = document.createElement("span");
  confidenceName.className = "visually-hidden";
  confidenceName.textContent = `${t(state.lang, "confidence")} `;
  confidence.append(confidenceName, document.createTextNode(`${percent}%`));
  top.append(pill, confidence);
  const text = document.createElement("p");
  text.className = "claim-text";
  text.textContent = segment.text;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "claim-toggle";
  toggle.id = `toggle-${segment.id}`;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.setAttribute("aria-controls", `reason-${segment.id}`);
  toggle.textContent = open ? t(state.lang, "hideClaim") : t(state.lang, "whyClaim");
  toggle.addEventListener("click", () => {
    state.openClaimId = open ? null : segment.id;
    renderClaims();
    $<HTMLButtonElement>(`#toggle-${segment.id}`).focus();
  });
  card.append(top, text, toggle);
  const reason = document.createElement("div");
  reason.className = "claim-more";
  reason.id = `reason-${segment.id}`;
  reason.hidden = !open;
  if (open) reason.append(claimReason(segment));
  card.append(reason);
  return card;
}

function claimReason(segment: SegmentResult): DocumentFragment {
  const fragment = document.createDocumentFragment();
  const explanation = document.createElement("p");
  explanation.className = "explanation";
  explanation.textContent = segment.explanation;
  const mode = document.createElement("p");
  mode.className = "mode";
  mode.textContent = t(
    state.lang,
    segment.evidenceMode === "web-search"
      ? "evidenceWeb"
      : segment.evidenceMode === "model-knowledge-only"
        ? "evidenceModel"
        : "evidenceNa",
  );
  fragment.append(explanation, mode);
  if (segment.sources.length === 0) {
    const none = document.createElement("p");
    none.className = "explanation";
    none.textContent = t(state.lang, "noSources");
    fragment.append(none);
    return fragment;
  }
  const list = document.createElement("ul");
  list.className = "sources";
  for (const source of segment.sources) {
    const item = document.createElement("li");
    const link = document.createElement("a");
    link.href = source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = source.title || source.url;
    const snippet = document.createElement("p");
    snippet.textContent = source.snippet;
    const address = document.createElement("small");
    address.textContent = source.url;
    item.append(link, snippet, address);
    list.append(item);
  }
  fragment.append(list);
  return fragment;
}

function renderIgnored() {
  const fold = $<HTMLDetailsElement>("#ignored-fold");
  const count = state.result?.meta.ignoredLines ?? 0;
  fold.hidden = count <= 0;
  if (count <= 0) return;
  $<HTMLElement>("#ignored-summary").textContent = t(state.lang, "ignoredNav").replace("{n}", String(count));
}

function renderScore() {
  const result = state.result;
  if (!result) {
    gauge.classList.remove("is-provisional");
    gauge.dataset.band = "mid";
    gauge.setAttribute("aria-label", t(state.lang, "scoreLabel"));
    gaugeValue.style.strokeDashoffset = String(ARC);
    gaugeNumber.textContent = "—";
    gaugeStatus.hidden = true;
    verdictEl.textContent = "";
    $<HTMLElement>("#notice").hidden = true;
    $<HTMLElement>("#subscores").replaceChildren();
    $<HTMLElement>("#contradictions").replaceChildren();
    $<HTMLElement>("#search-provider").hidden = true;
    $<HTMLElement>("#warnings").hidden = true;
    return;
  }
  const overall = result.score.overall;
  const provisional = result.provisional === true;
  gauge.classList.toggle("is-provisional", provisional);
  gauge.dataset.band = overall < 45 ? "low" : overall < 75 ? "mid" : "high";
  gaugeStatus.hidden = !provisional;
  gaugeStatus.textContent = provisional ? t(state.lang, "provisional") : "";
  gauge.setAttribute(
    "aria-label",
    `${t(state.lang, "scoreLabel")} ${overall}${provisional ? `, ${t(state.lang, "provisional")}` : ""}`,
  );
  animateGauge(overall);
  verdictEl.textContent = result.score.verdict;
  const notice = $<HTMLElement>("#notice");
  const line = joinNotice(noticeParts(result));
  notice.hidden = line.length === 0;
  notice.textContent = line;
  renderSubs(result);
  renderContradictions(result);
  const warnings = $<HTMLElement>("#warnings");
  warnings.replaceChildren();
  const lines = result.meta.warnings ?? [];
  warnings.hidden = lines.length === 0;
  for (const lineItem of lines) {
    const item = document.createElement("li");
    item.textContent = lineItem;
    warnings.append(item);
  }
}

function noticeParts(result: AnalysisResult): string[] {
  const parts: string[] = [];
  if (result.meta.model === "sample") parts.push(t(state.lang, "sampleBanner"));
  const outage = outageMessage(result);
  if (outage) parts.push(outage);
  else if (result.degraded) parts.push(partialClaimsNotice(state.lang, result.claimsVerified, result.claimsTotal));
  else if (result.meta.searchDegraded) parts.push(t(state.lang, "searchFailedBanner"));
  if (result.meta.outlet === "satire") parts.push(t(state.lang, "satireBanner"));
  else if (result.meta.outlet === "low-credibility") parts.push(t(state.lang, "lowCredBanner"));
  if (result.truncated) parts.push(t(state.lang, "truncated"));
  return parts;
}

function renderContradictions(result: AnalysisResult) {
  const root = $<HTMLElement>("#contradictions");
  root.replaceChildren();
  if (result.contradictions.length === 0) return;
  const heading = document.createElement("p");
  heading.className = "section-label";
  heading.textContent = t(state.lang, "contradictionTitle");
  const list = document.createElement("ul");
  list.className = "contradictions";
  for (const item of result.contradictions) {
    const li = document.createElement("li");
    li.textContent = item.explanation;
    list.append(li);
  }
  root.append(heading, list);
}

function renderSubs(result: AnalysisResult) {
  const root = $<HTMLElement>("#subscores");
  root.replaceChildren();
  const rows: { label: MessageKey; value: number | null; note: string }[] = [
    {
      label: "factual",
      value: result.score.factualAccuracy,
      note: t(
        state.lang,
        result.score.factualBasis === "measured"
          ? "factualMeasured"
          : result.score.factualBasis === "commentary"
            ? "factualCommentary"
            : "factualUncertain",
      ),
    },
    {
      label: "sourcing",
      value: result.score.sourcing,
      note: result.score.sourcing === null ? t(state.lang, "sourcingEmpty") : "",
    },
    { label: "tone", value: result.score.toneNeutrality, note: "" },
    { label: "consistency", value: result.score.logicalConsistency, note: "" },
  ];
  for (const row of rows) {
    const block = document.createElement("div");
    block.className = "sub";
    const top = document.createElement("div");
    top.className = "sub-top";
    const name = document.createElement("span");
    name.textContent = t(state.lang, row.label);
    const value = document.createElement("strong");
    value.textContent = row.value === null ? "—" : String(row.value);
    top.append(name, value);
    const track = document.createElement("div");
    track.className = "track";
    const fill = document.createElement("span");
    fill.style.width = `${row.value ?? 0}%`;
    track.append(fill);
    block.append(top, track);
    if (row.note) {
      const note = document.createElement("p");
      note.className = "sub-note";
      note.textContent = row.note;
      block.append(note);
    }
    root.append(block);
  }
}

function animateGauge(target: number) {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  gaugeValue.style.strokeDashoffset = String(ARC * (1 - target / 100));
  if (reduce) {
    gaugeNumber.textContent = String(target);
    return;
  }
  const started = performance.now();
  const step = (now: number) => {
    const progress = Math.min(1, (now - started) / 700);
    const eased = 1 - (1 - progress) ** 3;
    gaugeNumber.textContent = String(Math.round(target * eased));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function outageMessage(result: AnalysisResult): string | null {
  const status = result.meta.searchStatus;
  if (!status || status.state === "ok") return null;
  const key: Record<SearchOutageReason, MessageKey> = {
    out_of_credits: "searchOutageCredits",
    unauthorized: "searchOutageUnauthorized",
    rate_limited: "searchOutageRate",
    upstream_error: "searchOutageUpstream",
    failed: "searchOutageFailed",
  };
  return t(state.lang, status.reason ? key[status.reason] : "searchOutageFailed");
}

function renderArticle() {
  const result = state.result;
  if (!result) return;
  const providerLine = $<HTMLElement>("#search-provider");
  const provider = result.meta.searchStatus.provider;
  providerLine.hidden = !provider;
  providerLine.textContent = provider
    ? t(state.lang, provider === "tavily" ? "searchViaTavily" : "searchViaFirecrawl")
    : "";
  const title = result.article.title || t(state.lang, "pasted");
  $<HTMLElement>("#article-title").textContent = title;
  $<HTMLElement>("#article-heading").textContent = title;
  const meta = $<HTMLElement>("#article-meta");
  meta.replaceChildren();
  const bits: Node[] = [];
  if (result.article.sourceDomain) {
    const source = document.createElement("span");
    if (result.article.sourceUrl) {
      const link = document.createElement("a");
      link.href = result.article.sourceUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = result.article.sourceDomain;
      source.append(`${t(state.lang, "source")}: `, link);
    } else {
      source.textContent = `${t(state.lang, "source")}: ${result.article.sourceDomain}`;
    }
    bits.push(source);
  }
  if (result.article.publishedAt) {
    const date = document.createElement("span");
    const formatted = new Intl.DateTimeFormat(state.lang === "el" ? "el" : "en", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }).format(new Date(result.article.publishedAt));
    date.textContent = `${t(state.lang, "published")}: ${formatted}`;
    bits.push(date);
  }
  const detected = document.createElement("span");
  detected.textContent = `${t(state.lang, "detected")}: ${detectedName(state.lang, result.article.detectedLanguage)}`;
  bits.push(detected);
  if (result.meta.extraction === "local") {
    const local = document.createElement("span");
    local.textContent = t(state.lang, "localExtract");
    bits.push(local);
  }
  bits.forEach((bit, index) => {
    if (index) meta.append(" · ");
    meta.append(bit);
  });
  const body = $<HTMLElement>("#article-body");
  body.innerHTML = renderHighlighted(result.article.text, result.segments);
  for (const button of body.querySelectorAll<HTMLButtonElement>(".claim")) {
    const selected = button.dataset.id === state.openClaimId;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function openClaim(id: string) {
  const segments = state.result?.segments ?? [];
  const index = segments.findIndex((segment) => segment.id === id);
  if (index < 0) return;
  state.claimFilter = "all";
  if (index >= CLAIM_LIMIT) state.showAllClaims = true;
  state.openClaimId = id;
  renderClaims();
  renderArticle();
  document.getElementById(`claim-${id}`)?.scrollIntoView({ block: "nearest" });
}

function showReport(result: AnalysisResult, sample: boolean) {
  state.result = result;
  state.sample = sample;
  state.running = false;
  state.claimFilter = "all";
  state.showAllClaims = false;
  state.openClaimId = null;
  analyzeButton.disabled = false;
  analyzeButton.textContent = t(state.lang, "analyze");
  setPhase("result");
  applyI18n();
  verdictEl.focus();
}

function returnToInput() {
  state.result = null;
  state.sample = false;
  state.running = false;
  state.openClaimId = null;
  state.claimFilter = "all";
  state.showAllClaims = false;
  showError(null);
  setPhase("idle");
  applyI18n();
  textInput.focus();
}

function setPhase(phase: "idle" | "running" | "result") {
  app.dataset.phase = phase;
  composer.hidden = phase !== "idle";
  stagesEl.hidden = phase !== "running";
  report.hidden = phase !== "result";
  newAnalysis.hidden = phase !== "result";
  if (phase !== "running") $<HTMLElement>("#extract-preview").hidden = true;
  syncSkip();
}

function showPreview(article: { title: string | null; text: string }) {
  const box = $<HTMLElement>("#extract-preview");
  box.hidden = false;
  $<HTMLElement>("#preview-title").textContent = article.title || t(state.lang, "pasted");
  $<HTMLElement>("#preview-body").textContent = article.text;
}

async function runSample(instant: boolean) {
  if (state.running) return;
  showError(null);
  state.running = true;
  state.result = null;
  state.sample = true;
  analyzeButton.disabled = true;
  setPhase("running");
  resetStages();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!instant && !reduce) {
    for (const stage of STAGES) {
      setStage(stage, "start");
      await wait(380);
      setStage(stage, "done");
    }
  }
  showReport(buildSample(state.lang), true);
}

async function runAnalysis() {
  if (state.running) return;
  showError(null);
  const uiLanguage = state.lang;
  const payload =
    state.mode === "url"
      ? { url: urlInput.value.trim(), uiLanguage }
      : { text: textInput.value.trim(), uiLanguage };
  if (state.mode === "url" && !payload.url) {
    showError(t(state.lang, "errorEmpty"));
    return;
  }
  if (state.mode === "url" && !/^https?:\/\//i.test(payload.url ?? "")) {
    showError(t(state.lang, "errorUrl"));
    return;
  }
  if (state.mode === "paste" && (payload.text ?? "").length < 40) {
    showError(t(state.lang, (payload.text ?? "").length === 0 ? "errorEmpty" : "errorShort"));
    return;
  }

  trackAnalyzeStarted(window.gtag);
  state.running = true;
  state.sample = false;
  state.result = null;
  state.openClaimId = null;
  analyzeButton.disabled = true;
  analyzeButton.textContent = t(state.lang, "analyzing");
  setPhase("running");
  resetStages();

  try {
    const result = await analyzeArticle(
      payload,
      (event) => setStage(event.stage, event.status, event.done, event.total),
      showPreview,
    );
    for (const stage of STAGES) stageMemory[stage] = "done";
    showReport(result, false);
  } catch (error) {
    state.running = false;
    analyzeButton.disabled = false;
    analyzeButton.textContent = t(state.lang, "analyze");
    setPhase("idle");
    const message = presentCaught(error);
    showError(message, canRetry(message));
  }
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

$<HTMLButtonElement>("#tab-paste").addEventListener("click", () => setMode("paste"));
$<HTMLButtonElement>("#tab-url").addEventListener("click", () => setMode("url"));
$<HTMLElement>(".tabs").addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const next = event.key === "ArrowRight" ? (state.mode === "paste" ? "url" : "paste") : state.mode === "url" ? "paste" : "url";
  setMode(next);
  $<HTMLButtonElement>(next === "paste" ? "#tab-paste" : "#tab-url").focus();
});
$<HTMLButtonElement>("#sample-button").addEventListener("click", () => void runSample(false));
newAnalysis.addEventListener("click", () => {
  returnToInput();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void runAnalysis();
});
retryButton.addEventListener("click", () => {
  void runAnalysis();
});
textInput.addEventListener("input", () => {
  charCount.textContent = String(textInput.value.length);
});
for (const button of app.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
  button.addEventListener("click", () => {
    const lang = button.dataset.lang === "el" ? "el" : "en";
    setLanguage(lang);
  });
}
$<HTMLElement>("#summary").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-filter]");
  if (!button) return;
  state.claimFilter = parseFilter(button.dataset.filter);
  state.showAllClaims = false;
  state.openClaimId = null;
  renderClaims();
  app.querySelector<HTMLButtonElement>(`[data-filter="${state.claimFilter}"]`)?.focus();
});
$<HTMLButtonElement>("#show-all-claims").addEventListener("click", () => {
  state.showAllClaims = !state.showAllClaims;
  renderClaims();
  $<HTMLButtonElement>("#show-all-claims").focus();
});
$<HTMLElement>("#article-body").addEventListener("click", (event) => {
  const claim = (event.target as HTMLElement).closest<HTMLButtonElement>(".claim");
  if (!claim?.dataset.id) return;
  openClaim(claim.dataset.id);
});

const params = new URLSearchParams(location.search);
const demo = params.get("demo");
const stored = (() => {
  try {
    return localStorage.getItem("aletheia-lang");
  } catch {
    return null;
  }
})();
state.lang = pageLangFromSearch(location.search, stored, navigator.language, location.pathname);
const aligned = languageUrl(location.pathname, location.search, state.lang);
if ((params.get("lang") === "el" || params.get("lang") === "en") && aligned !== `${location.pathname}${location.search}`) {
  location.replace(`${aligned}${location.hash}`);
} else {
  const consentChoice = storedConsent();
  if (!consentChoice) {
    $<HTMLElement>("#consent").hidden = false;
  } else {
    scheduleKofi(window, state.lang);
  }
  applyI18n();
  if (consentChoice === "accepted") scheduleGtag();
  void fetchHealth().then((health) => {
    healthKind = !health ? "down" : health.searchConfigured ? "search" : "nosearch";
    renderHealth();
  });
  if (demo) void runSample(params.get("instant") === "1");
}

function storedConsent(): "accepted" | "declined" | null {
  try {
    return readConsent(localStorage);
  } catch {
    return null;
  }
}

function focusAfterConsent(): void {
  const composer = $<HTMLElement>("#composer");
  const paste = $<HTMLElement>("#panel-paste");
  const field = $<HTMLTextAreaElement>("#article-text");
  const composerOpen = Boolean(composer && !composer.hidden);
  if (composerOpen && paste && !paste.hidden && field) {
    field.focus();
    return;
  }
  $<HTMLElement>("#page-title").focus();
}

function rememberConsent(choice: "accepted" | "declined") {
  try {
    localStorage.setItem(CONSENT_STORAGE_KEY, choice);
  } catch {
    /* Storage can be blocked. The choice still applies to this visit. */
  }
  if (choice === "accepted") {
    grantAnalytics(window.gtag);
    trackPageView(window.gtag);
    injectGtag(document);
  }
  $<HTMLElement>("#consent").hidden = true;
  scheduleKofi(window, state.lang);
  focusAfterConsent();
}

$<HTMLButtonElement>("#consent-accept").addEventListener("click", () => rememberConsent("accepted"));
$<HTMLButtonElement>("#consent-decline").addEventListener("click", () => rememberConsent("declined"));
