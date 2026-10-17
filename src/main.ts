import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/600.css";
import "./styles.css";
import { LABELS, type UiLanguage } from "../shared/labels";
import { renderHighlighted } from "../shared/highlight";
import type { AnalysisResult, StageName } from "../shared/types";
import { analyzeArticle, fetchHealth } from "./api";
import { detectedName, labelHelp, labelName, t, type MessageKey } from "./i18n";
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
  selectedId: string | null;
  sample: boolean;
} = {
  lang: "en",
  mode: "paste",
  running: false,
  result: null,
  selectedId: null,
  sample: false,
};

const mount = document.querySelector<HTMLElement>("#app");
if (!mount) throw new Error("Missing #app");
const app: HTMLElement = mount;

app.classList.add("app");
app.dataset.phase = "idle";
app.innerHTML = `
  <a class="skip" href="#composer" data-i18n="skip"></a>
  <header class="top">
    <div class="brand">
      <svg class="mark" viewBox="0 0 44 44" aria-hidden="true">
        <circle cx="22" cy="22" r="20" fill="none" stroke="currentColor" stroke-width="1.5"></circle>
        <path d="M11 24c3.2-6 6.4-8.5 11-8.5S29.8 18 33 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
        <circle cx="22" cy="23" r="2.4" fill="currentColor"></circle>
      </svg>
      <div>
        <p class="kicker" data-i18n="kicker"></p>
        <h1 data-i18n="title"></h1>
        <p class="tagline" data-i18n="tagline"></p>
      </div>
    </div>
    <div class="header-side">
      <p class="health" id="health" data-state="unknown"></p>
      <div class="langs" role="group" aria-labelledby="lang-label">
        <span id="lang-label" class="visually-hidden" data-i18n="languageGroup"></span>
        <button type="button" data-lang="en" aria-pressed="true">EN</button>
        <button type="button" data-lang="el" aria-pressed="false">EL</button>
      </div>
    </div>
  </header>
  <main class="layout" id="layout">
    <div class="stack">
      <section class="card composer" id="composer">
        <div id="composer-full">
          <div class="tabs" role="tablist">
            <button type="button" role="tab" id="tab-paste" aria-controls="panel-paste" aria-selected="true" data-i18n="paste"></button>
            <button type="button" role="tab" id="tab-url" aria-controls="panel-url" aria-selected="false" data-i18n="url"></button>
          </div>
          <form id="analyze-form">
            <div id="panel-paste" role="tabpanel" aria-labelledby="tab-paste">
              <label class="field">
                <span data-i18n="articleLabel"></span>
                <textarea id="article-text" data-i18n-placeholder="placeholderPaste" maxlength="12000"></textarea>
              </label>
            </div>
            <div id="panel-url" role="tabpanel" aria-labelledby="tab-url" hidden>
              <label class="field">
                <span data-i18n="urlLabel"></span>
                <input id="article-url" type="url" inputmode="url" autocomplete="off" spellcheck="false" data-i18n-placeholder="placeholderUrl" />
              </label>
            </div>
            <div class="composer-foot">
              <span class="counter"><span id="char-count">0</span> / 12000 <span data-i18n="chars"></span></span>
              <div class="actions">
                <button class="ghost" type="button" id="sample-button" data-i18n="sample"></button>
                <button class="primary" type="submit" id="analyze-button" data-i18n="analyze"></button>
              </div>
            </div>
            <p class="error" id="form-error" hidden></p>
          </form>
        </div>
        <div class="compact" id="composer-compact" hidden>
          <p data-i18n="readyAnother"></p>
          <button class="ghost" type="button" id="expand-button" data-i18n="newAnalysis"></button>
        </div>
      </section>
      <section class="card stages" id="stages" hidden>
        <ol id="stage-list"></ol>
      </section>
      <article class="card paper" id="paper" hidden>
        <div class="paper-head">
          <h2 id="article-title"></h2>
        </div>
        <p class="meta" id="article-meta"></p>
        <p class="banner" id="sample-banner" hidden data-i18n="sampleBanner"></p>
        <p class="banner" id="truncated-banner" hidden data-i18n="truncated"></p>
        <div class="article-body" id="article-body"></div>
      </article>
    </div>
    <aside class="rail" id="rail" hidden>
      <section class="card scorecard" aria-labelledby="score-label">
        <div class="score-top">
          <div class="gauge" id="gauge" data-band="mid">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle class="gauge-track" cx="60" cy="60" r="52"></circle>
              <circle class="gauge-value" id="gauge-value" cx="60" cy="60" r="52"></circle>
            </svg>
            <div class="gauge-readout">
              <span class="gauge-number" id="gauge-number">—</span>
              <span class="gauge-of">/100</span>
            </div>
          </div>
          <div>
            <p class="section-label" id="score-label" data-i18n="scoreLabel"></p>
          </div>
        </div>
        <p class="section-label verdict-label" data-i18n="verdict"></p>
        <p class="verdict" id="verdict" tabindex="-1"></p>
        <ul class="notes" id="score-notes" hidden></ul>
        <p class="section-label" id="warnings-label" data-i18n="warnings" hidden></p>
        <ul class="warnings" id="warnings" hidden></ul>
        <div class="subs" id="subscores"></div>
      </section>
      <section class="card detail" id="detail" aria-live="polite">
        <p class="section-label" data-i18n="detailTitle"></p>
        <div id="detail-body"></div>
      </section>
      <section class="card counts">
        <p class="section-label" data-i18n="countsTitle"></p>
        <div class="count-grid" id="counts"></div>
      </section>
      <section class="card legend">
        <p class="section-label" data-i18n="legend"></p>
        <div class="legend-list" id="legend"></div>
      </section>
      <details class="card method">
        <summary data-i18n="howTitle"></summary>
        <p data-i18n="howBody"></p>
      </details>
    </aside>
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
const analyzeButton = $<HTMLButtonElement>("#analyze-button");
const charCount = $<HTMLElement>("#char-count");
const layout = $<HTMLElement>("#layout");
const rail = $<HTMLElement>("#rail");
const stagesEl = $<HTMLElement>("#stages");
const stageList = $<HTMLOListElement>("#stage-list");
const paper = $<HTMLElement>("#paper");
const verdictEl = $<HTMLElement>("#verdict");
const gauge = $<HTMLElement>("#gauge");
const gaugeValue = $<SVGCircleElement>("#gauge-value");
const gaugeNumber = $<HTMLElement>("#gauge-number");
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

function applyI18n() {
  document.documentElement.lang = state.lang === "el" ? "el" : "en";
  document.title = state.lang === "el" ? "Αλήθεια — αξιοπιστία ειδήσεων" : "Aletheia — claim-level news credibility";
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
  for (const button of app.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === state.lang));
  }
  renderLegend();
  renderHealth();
  renderCounts();
  renderStages(currentStages());
  renderScore();
  renderDetail();
  if (state.result) renderArticle();
}

function setLanguage(lang: UiLanguage) {
  state.lang = lang;
  try {
    localStorage.setItem("aletheia-lang", lang);
  } catch {
    /* Storage can be blocked. */
  }
  if (state.sample) state.result = buildSample(lang);
  applyI18n();
}

function setMode(mode: "paste" | "url") {
  state.mode = mode;
  $<HTMLButtonElement>("#tab-paste").setAttribute("aria-selected", String(mode === "paste"));
  $<HTMLButtonElement>("#tab-url").setAttribute("aria-selected", String(mode === "url"));
  $<HTMLElement>("#panel-paste").hidden = mode !== "paste";
  $<HTMLElement>("#panel-url").hidden = mode !== "url";
}

function showError(message: string | null) {
  errorBox.hidden = !message;
  errorBox.textContent = message ?? "";
}

function currentStages(): Record<StageName, StageState> {
  return stageMemory;
}

const stageMemory: Record<StageName, StageState> = {
  ingest: "pending",
  segment: "pending",
  evidence: "pending",
  verify: "pending",
  score: "pending",
};

function resetStages() {
  for (const stage of STAGES) stageMemory[stage] = "pending";
  renderStages(stageMemory);
}

function setStage(stage: StageName, status: "start" | "done") {
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
  for (const stage of STAGES) {
    const item = document.createElement("li");
    item.dataset.state = stages[stage];
    const dot = document.createElement("span");
    dot.className = "dot";
    const name = document.createElement("span");
    name.textContent = t(state.lang, STAGE_KEY[stage]);
    const status = document.createElement("span");
    status.className = "stage-state";
    const statusKey: MessageKey =
      stages[stage] === "active" ? "stageActive" : stages[stage] === "done" ? "stageDone" : "stagePending";
    status.textContent = t(state.lang, statusKey);
    item.append(dot, name, status);
    stageList.append(item);
  }
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

function renderCounts() {
  const grid = $<HTMLElement>("#counts");
  grid.replaceChildren();
  for (const label of LABELS) {
    const cell = document.createElement("div");
    cell.className = "count";
    cell.dataset.label = label;
    const value = document.createElement("strong");
    value.textContent = String(state.result?.score.counts[label] ?? 0);
    const name = document.createElement("span");
    name.textContent = labelName(state.lang, label);
    cell.append(value, name);
    grid.append(cell);
  }
}

function renderScore() {
  const result = state.result;
  const notes = $<HTMLElement>("#score-notes");
  notes.replaceChildren();
  if (!result) {
    gauge.classList.toggle("is-running", state.running);
    gauge.dataset.band = "mid";
    gaugeValue.style.strokeDashoffset = state.running ? "230" : String(ARC);
    gaugeNumber.textContent = "—";
    verdictEl.textContent = t(state.lang, state.running ? "runningVerdict" : "idleVerdict");
    notes.hidden = true;
    $<HTMLElement>("#warnings").hidden = true;
    $<HTMLElement>("#warnings-label").hidden = true;
    renderSubs(null);
    return;
  }
  gauge.classList.remove("is-running");
  const overall = result.score.overall;
  gauge.dataset.band = overall < 45 ? "low" : overall < 75 ? "mid" : "high";
  animateGauge(overall);
  verdictEl.textContent = result.score.verdict;
  const extra: string[] = [];
  if (result.meta.searchDegraded) extra.push(t(state.lang, "searchDegraded"));
  for (const item of result.contradictions) extra.push(item.explanation);
  notes.hidden = extra.length === 0;
  for (const line of extra) {
    const li = document.createElement("li");
    li.textContent = line;
    notes.append(li);
  }
  const warnings = $<HTMLElement>("#warnings");
  const warningsLabel = $<HTMLElement>("#warnings-label");
  warnings.replaceChildren();
  const lines = result?.meta.warnings ?? [];
  warnings.hidden = lines.length === 0;
  warningsLabel.hidden = lines.length === 0;
  for (const line of lines) {
    const item = document.createElement("li");
    item.textContent = line;
    warnings.append(item);
  }
  renderSubs(result);
}

function renderSubs(result: AnalysisResult | null) {
  const root = $<HTMLElement>("#subscores");
  root.replaceChildren();
  const rows: { label: MessageKey; value: number | null; note: string }[] = result
    ? [
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
      ]
    : [
        { label: "factual", value: null, note: "" },
        { label: "sourcing", value: null, note: "" },
        { label: "tone", value: null, note: "" },
        { label: "consistency", value: null, note: "" },
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
    const progress = Math.min(1, (now - started) / 900);
    const eased = 1 - (1 - progress) ** 3;
    gaugeNumber.textContent = String(Math.round(target * eased));
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderArticle() {
  const result = state.result;
  if (!result) {
    paper.hidden = true;
    return;
  }
  paper.hidden = false;
  $<HTMLElement>("#article-title").textContent = result.article.title || t(state.lang, "pasted");
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
  const count = document.createElement("span");
  count.textContent = `${result.segments.length} ${t(state.lang, "claims")}`;
  bits.push(count);
  if (result.meta.extraction === "local") {
    const local = document.createElement("span");
    local.textContent = t(state.lang, "localExtract");
    bits.push(local);
  }
  bits.forEach((bit, index) => {
    if (index) meta.append(" · ");
    meta.append(bit);
  });
  $<HTMLElement>("#sample-banner").hidden = result.meta.model !== "sample";
  $<HTMLElement>("#truncated-banner").hidden = !result.truncated;
  const body = $<HTMLElement>("#article-body");
  body.innerHTML = renderHighlighted(result.article.text, result.segments);
  for (const button of body.querySelectorAll<HTMLButtonElement>(".claim")) {
    const selected = button.dataset.id === state.selectedId;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
}

function renderDetail() {
  const root = $<HTMLElement>("#detail-body");
  root.replaceChildren();
  const segment = state.result?.segments.find((item) => item.id === state.selectedId);
  if (!segment) {
    const empty = document.createElement("p");
    empty.className = "explanation";
    empty.textContent = t(state.lang, "selectClaim");
    root.append(empty);
    return;
  }
  const kicker = document.createElement("div");
  kicker.className = "detail-kicker";
  const pill = document.createElement("span");
  pill.className = "pill";
  pill.dataset.label = segment.label;
  const swatch = document.createElement("span");
  swatch.className = "swatch";
  pill.append(swatch, document.createTextNode(labelName(state.lang, segment.label)));
  kicker.append(pill);
  const confidence = document.createElement("p");
  confidence.className = "confidence-label";
  const percent = Math.round(segment.confidence * 100);
  confidence.textContent = `${t(state.lang, "confidence")} ${percent}%`;
  const track = document.createElement("div");
  track.className = "confidence-track";
  const fill = document.createElement("span");
  fill.style.width = `${percent}%`;
  track.append(fill);
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
  root.append(kicker, confidence, track, explanation, mode);
  const heading = document.createElement("p");
  heading.className = "section-label";
  heading.textContent = t(state.lang, "sources");
  root.append(heading);
  if (segment.sources.length === 0) {
    const none = document.createElement("p");
    none.className = "explanation";
    none.textContent = t(state.lang, "noSources");
    root.append(none);
    return;
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
  root.append(list);
}

function selectClaim(id: string | null, scroll: boolean) {
  if (id === state.selectedId && !scroll) return;
  state.selectedId = id;
  for (const button of app.querySelectorAll<HTMLButtonElement>(".claim")) {
    const selected = button.dataset.id === id;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  }
  renderDetail();
  if (scroll && window.matchMedia("(max-width: 960px)").matches) {
    $<HTMLElement>("#detail").scrollIntoView({ block: "nearest" });
  }
}

function showReport(result: AnalysisResult, sample: boolean) {
  state.result = result;
  state.sample = sample;
  state.running = false;
  state.selectedId = result.segments[0]?.id ?? null;
  $<HTMLElement>("#composer-full").hidden = true;
  $<HTMLElement>("#composer-compact").hidden = false;
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
  state.selectedId = null;
  $<HTMLElement>("#composer-full").hidden = false;
  $<HTMLElement>("#composer-compact").hidden = true;
  showError(null);
  setPhase("idle");
  applyI18n();
  textInput.focus();
}

function setPhase(phase: "idle" | "running" | "result") {
  app.dataset.phase = phase;
  layout.classList.toggle("has-result", phase === "result");
  layout.classList.toggle("is-running", phase === "running");
  rail.hidden = phase !== "result";
  stagesEl.hidden = phase !== "running";
  if (phase !== "result") paper.hidden = true;
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
  renderScore();
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

  state.running = true;
  state.sample = false;
  state.result = null;
  state.selectedId = null;
  analyzeButton.disabled = true;
  analyzeButton.textContent = t(state.lang, "analyzing");
  setPhase("running");
  resetStages();
  renderScore();
  renderDetail();
  renderCounts();

  try {
    const result = await analyzeArticle(payload, (event) => setStage(event.stage, event.status));
    for (const stage of STAGES) stageMemory[stage] = "done";
    showReport(result, false);
  } catch (error) {
    state.running = false;
    analyzeButton.disabled = false;
    analyzeButton.textContent = t(state.lang, "analyze");
    setPhase("idle");
    renderScore();
    showError(error instanceof Error ? error.message : t(state.lang, "errorEmpty"));
  }
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

$<HTMLButtonElement>("#tab-paste").addEventListener("click", () => setMode("paste"));
$<HTMLButtonElement>("#tab-url").addEventListener("click", () => setMode("url"));
$<HTMLButtonElement>("#sample-button").addEventListener("click", () => void runSample(false));
$<HTMLButtonElement>("#expand-button").addEventListener("click", () => {
  returnToInput();
});
form.addEventListener("submit", (event) => {
  event.preventDefault();
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
$<HTMLElement>("#article-body").addEventListener("click", (event) => {
  const claim = (event.target as HTMLElement).closest<HTMLButtonElement>(".claim");
  if (!claim?.dataset.id) return;
  selectClaim(claim.dataset.id, true);
});
$<HTMLElement>("#article-body").addEventListener("focusin", (event) => {
  const claim = (event.target as HTMLElement).closest<HTMLButtonElement>(".claim");
  if (!claim?.dataset.id) return;
  selectClaim(claim.dataset.id, false);
});
$<HTMLElement>("#article-body").addEventListener("mouseover", (event) => {
  if (!window.matchMedia("(hover: hover)").matches) return;
  const claim = (event.target as HTMLElement).closest<HTMLButtonElement>(".claim");
  if (!claim?.dataset.id) return;
  selectClaim(claim.dataset.id, false);
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
state.lang = demo === "el" ? "el" : demo === "en" || demo === "1" ? "en" : stored === "el" || stored === "en" ? stored : navigator.language.toLowerCase().startsWith("el") ? "el" : "en";
applyI18n();
void fetchHealth().then((health) => {
  healthKind = !health ? "down" : health.searchConfigured ? "search" : "nosearch";
  renderHealth();
});
if (demo) void runSample(params.get("instant") === "1");
