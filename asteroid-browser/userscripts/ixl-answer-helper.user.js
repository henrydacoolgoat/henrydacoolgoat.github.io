// ==UserScript==
// @name         IXL Answer Helper - Fixed DOM and Selection Support
// @namespace    local.codex.ixl-helper
// @version      14.0.0
// @description  Structured multi-stage IXL solver with deterministic math, evidence-linked reading, learned widget strategies, quarantine, replay tests, and state-machine automation.
// @match        https://*.ixl.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_ID = "ixl-answer-helper-fixed";
  const PANEL_ID = `${SCRIPT_ID}-panel`;
  const COMPLETION_MODAL_ID = `${SCRIPT_ID}-completion-modal`;
  const MISTRAL_TUTORIAL_MODAL_ID = `${SCRIPT_ID}-mistral-tutorial-modal`;
  const MISTRAL_TUTORIAL_SEEN_KEY = `${SCRIPT_ID}-mistral-tutorial-seen-v1`;
  const STORE_KEY = `${SCRIPT_ID}-config-v3`;
  const PREVIOUS_STORE_KEY = `${SCRIPT_ID}-config-v2`;
  const TEACHER_HANDOFF_KEY = `${SCRIPT_ID}-teacher-handoff-v1`;
  const ANSWER_CACHE_KEY = `${SCRIPT_ID}-answer-cache-v1`;
  const READING_CONTEXT_KEY = `${SCRIPT_ID}-reading-context-v2`;
  const READING_ACTIVE_SESSION_KEY = `${SCRIPT_ID}-reading-active-v2`;
  const READING_BINDINGS_SESSION_KEY = `${SCRIPT_ID}-reading-bindings-v2`;
  const AUTO_LOOP_SESSION_KEY = `${SCRIPT_ID}-auto-loop-session-v1`;
  const WIDGET_STRATEGY_CACHE_KEY = `${SCRIPT_ID}-widget-strategies-v1`;
  const SOLVE_ATTEMPT_CACHE_KEY = `${SCRIPT_ID}-solve-attempts-v1`;
  const READING_CONTEXT_TTL_MS = 45 * 60 * 1000;
  const ANSWER_CACHE_LIMIT = 500;
  const USAGE_RETRY_MS = 60 * 1000;
  const SUPABASE_TABLE_RECHECK_MS = 60 * 1000;
  const AI_RETRY_MAX_MS = 15 * 1000;
  const GOT_IT_WATCH_MS = 650;
  const QUESTION_STABLE_MS = 450;
  const DEFAULT_CONFIG = {
    apiKey: "",
    endpoint: "https://api.mistral.ai/v1/chat/completions",
    model: "mistral-small-2603",
    backupEnabled: false,
    backupApiKey: "",
    backupEndpoint: "https://api.mistral.ai/v1/chat/completions",
    backupModel: "mistral-small-2603",
    mode: "fill",
    subjectMode: "adaptive",
    autoSubmit: false,
    includeScreenshot: false,
    screenshotFallback: true,
    verifyBeforeSubmit: true,
    verifierModel: "",
    deterministicMath: true,
    evidenceVerification: true,
    semanticCache: true,
    learnWidgetStrategies: true,
    attemptDiagnostics: true,
    localAnswerCache: true,
    supabaseEnabled: true,
    supabaseUrl: "https://bescumcfyltymxlkbhqw.supabase.co",
    supabasePublishableKey: "sb_publishable_dlN2AWz8yK4LAWilB9smVg_YJ4fhomK",
    supabaseTable: "ixl_answer_cache",
    supabaseNamespace: "",
  };

  const ANSWER_SELECTOR = [
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"])',
    "textarea",
    "select",
    '[contenteditable="true"]',
    '[role="textbox"]',
    '[role="radio"]',
    '[role="checkbox"]',
    '[role="combobox"]',
    '[role="option"]',
    '[role="listbox"]',
    '[role="application"]',
    '[role="gridcell"]',
    '[role="switch"]',
    '[role="slider"]',
    '[draggable="true"]',
    '[aria-dropeffect]',
    '[data-testid="listItem"]',
    '[class*="draggable" i]',
    '[class*="droppable" i]',
    '[class*="drop-zone" i]',
    '[class*="dropzone" i]',
    '[class*="graphingPointerOverlay" i]',
    'canvas',
    '[class*="interactive" i][tabindex]',
    '[data-testid*="choice" i]',
    '[class*="choice" i]',
    '[class*="answer-option" i]',
    'button',
  ].join(",");

  const LOOP_STATES = Object.freeze({
    STOPPED: "stopped",
    WAITING_FOR_PAGE: "waiting-for-page",
    READING_PASSAGE: "reading-passage",
    WAITING_FOR_QUESTION: "waiting-for-question",
    EXTRACTING: "extracting",
    CACHE_LOOKUP: "cache-lookup",
    SOLVING: "solving",
    VERIFYING: "verifying",
    PLANNING_ACTIONS: "planning-actions",
    APPLYING: "applying",
    SUBMITTING: "submitting",
    WAITING_FOR_FEEDBACK: "waiting-for-feedback",
    HANDLING_CORRECTION: "handling-correction",
    WAITING_FOR_NEXT: "waiting-for-next",
    USAGE_LIMIT_WAIT: "usage-limit-wait",
    SMARTSCORE_COMPLETE: "smartscore-complete",
  });

  const WIDGET_CAPABILITY_REGISTRY = Object.freeze({
    text: ["native-value", "input-events", "keyboard-entry"],
    symbolic: ["sympad-keyboard", "sympad-input-events", "keyboard-entry"],
    choice: ["direct-click", "label-remap", "keyboard-activate", "nested-click"],
    dropdown: ["native-select", "custom-option-click", "keyboard-select"],
    slider: ["native-range", "keyboard-slider"],
    ordering: ["pointer-reorder", "html5-reorder"],
    drag: ["pointer-drag", "html5-drag"],
    graph: ["coordinate-overlay", "coordinate-overlay-retry", "relative-pointer"],
    press: ["keyboard-sequence"],
  });

  const ROOT_SELECTORS = [
    '[aria-label="question"]',
    '[data-cy="question-section"]',
    '[data-testid*="practice-problem" i]',
    '[data-testid*="question" i]',
    '[data-testid*="problem" i]',
    '[class*="practice-problem" i]',
    '[class*="question-container" i]',
    '[class*="question" i]',
    '[class*="problem" i]',
    "main article section",
    "main article",
    "article",
    "main",
  ];

  const UTILITY_BUTTON_RE = /^(submit|check|check answer|done|next|continue|start|skip|hint|learn with an example|got it|close|cancel|back|settings?|logs?|rollback|answer|enter)$/i;
  const SUBMIT_BUTTON_RE = /^(submit|check|check answer|done|enter)$/i;

  let config = loadConfig();
  let ui = null;
  let busy = false;
  let lastContext = null;
  let lastSnapshot = null;
  let progressTimer = null;
  let lastSolveOutcome = null;
  let loopActive = false;
  let loopTimer = null;
  let loopCycleRunning = false;
  let loopWaitingForNext = false;
  let loopLastRoot = null;
  let loopLastQuestionSignature = "";
  let loopSawSubmitUnavailable = false;
  let loopNextClicked = false;
  let loopSubmittedAt = 0;
  let loopObserver = null;
  let completionPromptShown = false;
  let usageRetryAt = 0;
  let usageCountdownTimer = null;
  let primaryUsageLimitedUntil = 0;
  let backupUsageLimitedUntil = 0;
  let lastSolveProvider = null;
  let loopReadySignature = "";
  let loopReadySince = 0;
  let loopAiRetryCount = 0;
  let loopRetryFeedback = "";
  let gotItWatchTimer = null;
  let gotItHandling = false;
  let gotItWatchAttempts = 0;
  let pendingAnswerCache = null;
  let manualFeedbackObserver = null;
  let manualFeedbackTimeout = null;
  let supabaseTableHealth = { status: "unknown", checkedAt: 0, message: "Not checked yet." };
  let uiCompletelyHidden = false;
  let lastDebugReport = null;
  let debugHighlightElements = [];
  let loopState = LOOP_STATES.STOPPED;
  let currentSolveTrace = null;
  let lastProblemIR = null;
  const ollamaCapabilityCache = new Map();

  function loadConfig() {
    let saved = {};
    try {
      saved = GM_getValue(STORE_KEY, {}) || {};
      if (typeof saved === "string") saved = JSON.parse(saved);
    } catch (_error) {
      saved = {};
    }

    // Migrate only an existing LOCAL configuration. An older saved remote/OpenAI
    // endpoint must not override this version's local-Ollama-first default.
    if (!saved.endpoint || !saved.model) {
      try {
        let previous = GM_getValue(PREVIOUS_STORE_KEY, {}) || {};
        if (typeof previous === "string") previous = JSON.parse(previous);
        if (previous.endpoint && isLoopbackEndpoint(previous.endpoint)) {
          saved = { ...previous, ...saved, apiKey: "" };
        } else {
          const old = JSON.parse(localStorage.getItem("myNewIxLStorage") || "{}");
          const localModel = Object.keys(old).find((name) => old[name]?.apiBase && isLoopbackEndpoint(old[name].apiBase));
          if (localModel) {
            saved.endpoint ||= old[localModel].apiBase;
            saved.model ||= localModel;
            saved.apiKey = "";
          }
        }
      } catch (_error) {
        // Ignore malformed previous configuration and use local Ollama defaults.
      }
    }

    if (!saved.mistralSmall2603MigrationApplied
      && /api\.mistral\.ai/i.test(String(saved.endpoint || ""))
      && String(saved.model || "").trim().toLowerCase() === "mistral-small-latest") {
      saved.model = "mistral-small-2603";
      saved.mistralSmall2603MigrationApplied = true;
    }
    const merged = { ...DEFAULT_CONFIG, ...saved };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(merged.supabaseNamespace || "")) {
      merged.supabaseNamespace = typeof crypto?.randomUUID === "function"
        ? crypto.randomUUID()
        : `00000000-0000-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, "0").slice(0, 12)}`;
    }
    return merged;
  }

  function saveConfig() {
    GM_setValue(STORE_KEY, { ...config });
  }

  function addStyles() {
    GM_addStyle(`
      #${PANEL_ID} {
        position: fixed;
        top: 16px;
        right: 16px;
        z-index: 2147483647;
        width: 390px;
        max-height: calc(100vh - 32px);
        overflow: auto;
        color: #1d2939;
        background: #fff;
        border: 1px solid #d0d5dd;
        border-radius: 10px;
        box-shadow: 0 8px 28px rgba(16, 24, 40, .22);
        font: 13px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      html.iah-helper-ui-hidden #${PANEL_ID},
      html.iah-helper-ui-hidden #${COMPLETION_MODAL_ID},
      html.iah-helper-ui-hidden #${MISTRAL_TUTORIAL_MODAL_ID} {
        display: none !important;
      }
      html.iah-helper-ui-hidden .iah-teacher-highlight {
        outline: none !important;
        box-shadow: none !important;
      }
      #${PANEL_ID}, #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} .iah-header {
        position: sticky;
        top: 0;
        z-index: 1;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        color: #fff;
        background: #1570ef;
      }
      #${PANEL_ID} .iah-title { flex: 1; font-weight: 700; }
      #${PANEL_ID} .iah-body { padding: 12px; }
      #${PANEL_ID} .iah-row { display: flex; gap: 8px; margin: 8px 0; }
      #${PANEL_ID} label { display: block; flex: 1; color: #344054; font-weight: 600; }
      #${PANEL_ID} input[type="text"],
      #${PANEL_ID} input[type="password"],
      #${PANEL_ID} select,
      #${PANEL_ID} textarea {
        width: 100%;
        margin-top: 4px;
        padding: 7px 8px;
        border: 1px solid #d0d5dd;
        border-radius: 6px;
        color: #101828;
        background: #fff;
        font: inherit;
      }
      #${PANEL_ID} button {
        min-height: 32px;
        padding: 6px 10px;
        border: 1px solid #b2ccff;
        border-radius: 6px;
        color: #1849a9;
        background: #eff4ff;
        cursor: pointer;
        font: inherit;
        font-weight: 650;
      }
      #${PANEL_ID} button:hover { background: #d1e0ff; }
      #${PANEL_ID} button:disabled { cursor: wait; opacity: .55; }
      #${PANEL_ID} .iah-help-button {
        width: 32px;
        min-width: 32px;
        padding: 0;
        border-radius: 999px;
        font-size: 18px;
        line-height: 1;
      }
      #${PANEL_ID} .iah-primary { flex: 1; color: #fff; background: #1570ef; border-color: #1570ef; }
      #${PANEL_ID} .iah-primary:hover { background: #175cd3; }
      #${PANEL_ID} .iah-check { display: flex; align-items: center; gap: 6px; font-weight: 500; }
      #${PANEL_ID} .iah-check input { margin: 0; }
      #${PANEL_ID} .iah-settings { display: none; padding-top: 4px; border-top: 1px solid #eaecf0; }
      #${PANEL_ID} .iah-settings.open { display: block; }
      #${PANEL_ID} .iah-status { margin: 9px 0 0; padding: 8px; border-radius: 6px; background: #f2f4f7; white-space: pre-wrap; }
      #${PANEL_ID} .iah-status.error { color: #b42318; background: #fef3f2; }
      #${PANEL_ID} .iah-status.success { color: #027a48; background: #ecfdf3; }
      #${PANEL_ID} .iah-progress { display: none; width: 100%; height: 5px; margin-top: 8px; }
      #${PANEL_ID} .iah-answer { display: none; margin-top: 10px; padding: 9px; border: 1px solid #d0d5dd; border-radius: 6px; }
      #${PANEL_ID} .iah-answer strong { display: block; margin-bottom: 4px; }
      #${PANEL_ID} .iah-explanation { margin-top: 6px; color: #475467; white-space: pre-wrap; }
      #${PANEL_ID} .iah-logs { display: none; max-height: 130px; overflow: auto; margin-top: 9px; padding: 7px; color: #344054; background: #f9fafb; border: 1px solid #eaecf0; border-radius: 6px; font: 11px/1.35 ui-monospace, monospace; }
      #${PANEL_ID} .iah-logs.open { display: block; }
      #${PANEL_ID} .iah-debugger { display: none; margin-top: 9px; padding: 9px; color: #344054; background: #f8f9fc; border: 1px solid #c7d7fe; border-radius: 8px; }
      #${PANEL_ID} .iah-debugger.open { display: block; }
      #${PANEL_ID} .iah-debugger pre { max-height: 260px; overflow: auto; margin: 8px 0 0; padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; background: #fff; border: 1px solid #eaecf0; border-radius: 6px; font: 11px/1.4 ui-monospace, monospace; }
      .iah-debug-root-highlight { outline: 4px solid #7f56d9 !important; outline-offset: 3px !important; }
      .iah-debug-target-highlight { outline: 3px solid #f79009 !important; outline-offset: 2px !important; }
      .iah-debug-passage-highlight { outline: 4px solid #12b76a !important; outline-offset: 3px !important; }
      #${PANEL_ID} .iah-note { margin: 5px 0; color: #667085; font-size: 11px; }
      #${PANEL_ID} .iah-provider-card { margin: 10px 0; padding: 10px; border: 1px solid #d0d5dd; border-radius: 8px; background: #f9fafb; }
      #${PANEL_ID} .iah-provider-card > strong { display: block; margin-bottom: 6px; color: #101828; }
      #${PANEL_ID} .iah-cache-health { margin: 8px 0; padding: 7px 8px; border-radius: 6px; color: #475467; background: #f2f4f7; font-size: 12px; }
      #${PANEL_ID} .iah-cache-health.success { color: #027a48; background: #ecfdf3; }
      #${PANEL_ID} .iah-cache-health.error { color: #b42318; background: #fef3f2; }
      #${PANEL_ID} .iah-cache-health.warning { color: #b54708; background: #fffaeb; }
      .iah-teacher-highlight {
        position: relative !important;
        z-index: 2147483645 !important;
        outline: 5px solid #fdb022 !important;
        outline-offset: 5px !important;
        border-radius: 8px !important;
        box-shadow: 0 0 0 10px rgba(253, 176, 34, .24) !important;
      }
      #${COMPLETION_MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483646;
        display: grid;
        place-items: center;
        padding: 20px;
        background: rgba(16, 24, 40, .55);
        font: 15px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${COMPLETION_MODAL_ID} .iah-modal-card {
        width: min(460px, 100%);
        padding: 22px;
        color: #101828;
        background: #fff;
        border-radius: 14px;
        box-shadow: 0 20px 48px rgba(16, 24, 40, .3);
      }
      #${COMPLETION_MODAL_ID} h2 { margin: 0 0 8px; font-size: 22px; }
      #${COMPLETION_MODAL_ID} p { margin: 0 0 18px; color: #475467; }
      #${COMPLETION_MODAL_ID} .iah-modal-actions { display: flex; justify-content: flex-end; gap: 10px; }
      #${COMPLETION_MODAL_ID} button {
        min-height: 38px;
        padding: 8px 14px;
        border: 1px solid #b2ccff;
        border-radius: 7px;
        color: #1849a9;
        background: #eff4ff;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
      }
      #${COMPLETION_MODAL_ID} button[data-choice="yes"] { color: #fff; background: #1570ef; border-color: #1570ef; }
      #${COMPLETION_MODAL_ID} button:disabled { cursor: not-allowed; opacity: .5; }
      #${MISTRAL_TUTORIAL_MODAL_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        place-items: center;
        padding: 18px;
        color: #101828;
        background: rgba(16, 24, 40, .68);
        font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #${MISTRAL_TUTORIAL_MODAL_ID}, #${MISTRAL_TUTORIAL_MODAL_ID} * { box-sizing: border-box; }
      #${MISTRAL_TUTORIAL_MODAL_ID} .iah-mistral-card {
        width: min(760px, 100%);
        max-height: min(860px, calc(100vh - 36px));
        overflow: auto;
        padding: 24px;
        background: #fff;
        border: 1px solid #d0d5dd;
        border-radius: 16px;
        box-shadow: 0 24px 64px rgba(16, 24, 40, .38);
      }
      #${MISTRAL_TUTORIAL_MODAL_ID} .iah-tutorial-head { display: flex; align-items: flex-start; gap: 12px; }
      #${MISTRAL_TUTORIAL_MODAL_ID} .iah-tutorial-head > div { flex: 1; }
      #${MISTRAL_TUTORIAL_MODAL_ID} h2 { margin: 0 0 5px; font-size: 24px; line-height: 1.2; }
      #${MISTRAL_TUTORIAL_MODAL_ID} h3 { margin: 18px 0 6px; font-size: 16px; }
      #${MISTRAL_TUTORIAL_MODAL_ID} p { margin: 5px 0 10px; color: #475467; }
      #${MISTRAL_TUTORIAL_MODAL_ID} ol { margin: 10px 0; padding-left: 24px; }
      #${MISTRAL_TUTORIAL_MODAL_ID} li { margin: 8px 0; }
      #${MISTRAL_TUTORIAL_MODAL_ID} code {
        padding: 2px 5px;
        color: #1849a9;
        background: #eff4ff;
        border-radius: 4px;
        overflow-wrap: anywhere;
      }
      #${MISTRAL_TUTORIAL_MODAL_ID} .iah-tutorial-box { margin: 12px 0; padding: 12px; border-radius: 9px; background: #f9fafb; border: 1px solid #eaecf0; }
      #${MISTRAL_TUTORIAL_MODAL_ID} .iah-tutorial-warning { color: #7a2e0e; background: #fffaeb; border-color: #fedf89; }
      #${MISTRAL_TUTORIAL_MODAL_ID} .iah-tutorial-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      #${MISTRAL_TUTORIAL_MODAL_ID} .iah-tutorial-actions { position: sticky; bottom: -24px; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin: 20px -24px -24px; padding: 14px 24px; background: rgba(255,255,255,.96); border-top: 1px solid #eaecf0; }
      #${MISTRAL_TUTORIAL_MODAL_ID} button,
      #${MISTRAL_TUTORIAL_MODAL_ID} a.iah-tutorial-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 38px;
        padding: 8px 13px;
        color: #1849a9;
        background: #eff4ff;
        border: 1px solid #b2ccff;
        border-radius: 7px;
        cursor: pointer;
        font: inherit;
        font-weight: 700;
        text-decoration: none;
      }
      #${MISTRAL_TUTORIAL_MODAL_ID} [data-tutorial-action="apply"] { color: #fff; background: #1570ef; border-color: #1570ef; }
      @media (max-width: 620px) {
        #${MISTRAL_TUTORIAL_MODAL_ID} .iah-tutorial-grid { grid-template-columns: 1fr; }
        #${MISTRAL_TUTORIAL_MODAL_ID} .iah-mistral-card { padding: 18px; }
        #${MISTRAL_TUTORIAL_MODAL_ID} .iah-tutorial-actions { bottom: -18px; margin: 18px -18px -18px; padding: 12px 18px; }
      }
    `);
  }

  function createPanel() {
    document.getElementById(PANEL_ID)?.remove();
    const panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="iah-header">
        <span class="iah-title">IXL Answer Helper</span>
        <button type="button" class="iah-help-button" data-action="mistral-tutorial" aria-label="Open setup tutorial" title="Open setup tutorial">?</button>
        <button type="button" data-action="mistral-tutorial">Mistral setup</button>
        <button type="button" data-action="debug">Debug</button>
        <button type="button" data-action="logs">Logs</button>
        <button type="button" data-action="toggle">Hide</button>
      </div>
      <div class="iah-body">
        <div class="iah-row">
          <label>Mode
            <select data-field="mode">
              <option value="fill">Solve and fill</option>
              <option value="display">Display answer only</option>
            </select>
          </label>
          <label>Solver profile
            <select data-field="subjectMode">
              <option value="adaptive">Adaptive (auto-detect)</option>
              <option value="math-legacy">Math (legacy)</option>
              <option value="reading">Reading / ELA</option>
            </select>
          </label>
          <label>Model
            <input type="text" data-field="model" autocomplete="off">
          </label>
        </div>
        <div class="iah-row">
          <button type="button" class="iah-primary" data-action="start">Solve current question</button>
          <button type="button" data-action="loop">Start auto loop</button>
          <button type="button" data-action="rollback">Rollback</button>
          <button type="button" data-action="settings">Settings</button>
        </div>
        <div class="iah-row">
          <label class="iah-check"><input type="checkbox" data-field="autoSubmit"> Auto-submit after a successful fill</label>
          <label class="iah-check"><input type="checkbox" data-field="screenshotFallback"> Screenshot only when DOM evidence is incomplete</label>
          <label class="iah-check"><input type="checkbox" data-field="verifyBeforeSubmit"> Independently verify each answer</label>
        </div>
        <progress class="iah-progress" max="100" value="0"></progress>
        <div class="iah-status">Ready.</div>
        <div class="iah-answer">
          <strong>Answer</strong>
          <div class="iah-final"></div>
          <div class="iah-explanation"></div>
        </div>
        <div class="iah-settings">
          <label>API endpoint
            <input type="text" data-field="endpoint" placeholder="https://api.mistral.ai/v1/chat/completions">
          </label>
          <label>API key (required for Mistral; not needed for local Ollama)
            <input type="password" data-field="apiKey" placeholder="Paste a Mistral Studio API key" autocomplete="off">
          </label>
          <label>Verifier model (optional; blank uses the main model)
            <input type="text" data-field="verifierModel" placeholder="mistral-medium-3-5" autocomplete="off">
          </label>
          <label class="iah-check"><input type="checkbox" data-field="includeScreenshot"> Always include a screenshot (debug override)</label>
          <div class="iah-provider-card">
            <strong>Smart solver pipeline</strong>
            <label class="iah-check"><input type="checkbox" data-field="deterministicMath"> Use deterministic math and word-problem templates before AI</label>
            <label class="iah-check"><input type="checkbox" data-field="evidenceVerification"> Require passage evidence for reading answers</label>
            <label class="iah-check"><input type="checkbox" data-field="semanticCache"> Verify and reuse semantically equivalent cached questions</label>
            <label class="iah-check"><input type="checkbox" data-field="learnWidgetStrategies"> Learn successful IXL control strategies</label>
            <label class="iah-check"><input type="checkbox" data-field="attemptDiagnostics"> Save privacy-safe solve traces and replay diagnostics</label>
          </div>
          <div class="iah-provider-card">
            <strong>Backup API for usage limits</strong>
            <label class="iah-check"><input type="checkbox" data-field="backupEnabled"> Automatically use this backup when the primary API reaches its quota or rate limit</label>
            <label>Backup API endpoint
              <input type="text" data-field="backupEndpoint" placeholder="https://api.mistral.ai/v1/chat/completions" autocomplete="off">
            </label>
            <label>Backup API key
              <input type="password" data-field="backupApiKey" placeholder="Paste a different API key" autocomplete="off">
            </label>
            <label>Backup model
              <input type="text" data-field="backupModel" placeholder="mistral-small-2603" autocomplete="off">
            </label>
            <button type="button" data-action="test-backup">Test backup API</button>
            <p class="iah-note">The backup may use Mistral, Ollama, or another supported provider. It is contacted only when enabled and the primary returns a usage/quota error, or when you press Test backup API. Use a separate account/key if the primary and backup otherwise share the same quota.</p>
          </div>
          <div class="iah-row">
            <label class="iah-check"><input type="checkbox" data-field="localAnswerCache"> Reuse correct answers on this browser</label>
            <label class="iah-check"><input type="checkbox" data-field="supabaseEnabled"> Sync correct answers with Supabase</label>
          </div>
          <label>Supabase project URL
            <input type="text" data-field="supabaseUrl" placeholder="https://project-ref.supabase.co" autocomplete="off">
          </label>
          <label>Supabase publishable/anon key
            <input type="password" data-field="supabasePublishableKey" placeholder="sb_publishable_… (never use a secret/service-role key)" autocomplete="off">
          </label>
          <label>Supabase cache table
            <input type="text" data-field="supabaseTable" placeholder="ixl_answer_cache" autocomplete="off">
          </label>
          <div class="iah-cache-health" data-cache-table-status>Supabase table: not checked yet.</div>
          <button type="button" data-action="mistral-tutorial">How to get and configure a Mistral API key</button>
          <p class="iah-note">Compatible with Mistral and other OpenAI-compatible Chat Completions/Responses endpoints, native Ollama /api/chat or /api/generate, Anthropic Messages, and Gemini generateContent. New installations default to Mistral's API with model mistral-small-2603. The helper checks Ollama model capabilities and automatically skips screenshots for text-only local models. Independent verification makes a second model request per uncached question and can increase API usage. A remote endpoint receives the extracted question and any enabled screenshot.</p>
          <p class="iah-note">The answer cache fingerprints the full question and its controls. Exact cache hits skip both AI requests. Model answers are saved only after IXL accepts them; when IXL shows a correction, the confirmed correct multi-action answer replaces the model answer. Supabase rows are isolated with a random per-install namespace. Use only a browser-safe publishable or legacy anon key—never a secret/service-role key.</p>
          <div class="iah-row">
            <button type="button" data-action="save">Save settings</button>
            <button type="button" data-action="test">Test API</button>
            <button type="button" data-action="test-cache">Test cache</button>
            <button type="button" data-action="check-table">Check table</button>
          </div>
        </div>
        <div class="iah-debugger">
          <strong>Adaptive debugger</strong>
          <div class="iah-row">
            <button type="button" data-action="debug-scan">Scan page</button>
            <button type="button" data-action="debug-highlight">Highlight detections</button>
            <button type="button" data-action="debug-copy">Copy report</button>
            <button type="button" data-action="replay-tests">Run replay tests</button>
          </div>
          <pre data-debug-report>No scan yet.</pre>
        </div>
        <div class="iah-logs"></div>
      </div>`;
    document.body.appendChild(panel);

    ui = {
      panel,
      body: panel.querySelector(".iah-body"),
      start: panel.querySelector('[data-action="start"]'),
      loop: panel.querySelector('[data-action="loop"]'),
      status: panel.querySelector(".iah-status"),
      progress: panel.querySelector(".iah-progress"),
      answer: panel.querySelector(".iah-answer"),
      final: panel.querySelector(".iah-final"),
      explanation: panel.querySelector(".iah-explanation"),
      settings: panel.querySelector(".iah-settings"),
      logs: panel.querySelector(".iah-logs"),
      debugger: panel.querySelector(".iah-debugger"),
      debugReport: panel.querySelector('[data-debug-report]'),
      cacheTableStatus: panel.querySelector('[data-cache-table-status]'),
      fields: {
        mode: panel.querySelector('[data-field="mode"]'),
        subjectMode: panel.querySelector('[data-field="subjectMode"]'),
        model: panel.querySelector('[data-field="model"]'),
        autoSubmit: panel.querySelector('[data-field="autoSubmit"]'),
        includeScreenshot: panel.querySelector('[data-field="includeScreenshot"]'),
        screenshotFallback: panel.querySelector('[data-field="screenshotFallback"]'),
        verifyBeforeSubmit: panel.querySelector('[data-field="verifyBeforeSubmit"]'),
        deterministicMath: panel.querySelector('[data-field="deterministicMath"]'),
        evidenceVerification: panel.querySelector('[data-field="evidenceVerification"]'),
        semanticCache: panel.querySelector('[data-field="semanticCache"]'),
        learnWidgetStrategies: panel.querySelector('[data-field="learnWidgetStrategies"]'),
        attemptDiagnostics: panel.querySelector('[data-field="attemptDiagnostics"]'),
        verifierModel: panel.querySelector('[data-field="verifierModel"]'),
        endpoint: panel.querySelector('[data-field="endpoint"]'),
        apiKey: panel.querySelector('[data-field="apiKey"]'),
        backupEnabled: panel.querySelector('[data-field="backupEnabled"]'),
        backupEndpoint: panel.querySelector('[data-field="backupEndpoint"]'),
        backupApiKey: panel.querySelector('[data-field="backupApiKey"]'),
        backupModel: panel.querySelector('[data-field="backupModel"]'),
        localAnswerCache: panel.querySelector('[data-field="localAnswerCache"]'),
        supabaseEnabled: panel.querySelector('[data-field="supabaseEnabled"]'),
        supabaseUrl: panel.querySelector('[data-field="supabaseUrl"]'),
        supabasePublishableKey: panel.querySelector('[data-field="supabasePublishableKey"]'),
        supabaseTable: panel.querySelector('[data-field="supabaseTable"]'),
      },
    };

    syncPanelFromConfig();
    panel.addEventListener("click", handlePanelClick);
    panel.addEventListener("change", handlePanelChange);
    // Bind rollback directly so it remains responsive while an async solve click
    // is still unwinding through the delegated panel handler.
    panel.querySelector('[data-action="rollback"]').addEventListener("click", rollback);
  }

  function syncPanelFromConfig() {
    ui.fields.mode.value = config.mode;
    ui.fields.subjectMode.value = ["adaptive", "math-legacy", "reading"].includes(config.subjectMode) ? config.subjectMode : "adaptive";
    ui.fields.model.value = config.model;
    ui.fields.autoSubmit.checked = Boolean(config.autoSubmit);
    ui.fields.includeScreenshot.checked = Boolean(config.includeScreenshot);
    ui.fields.screenshotFallback.checked = config.screenshotFallback !== false;
    ui.fields.verifyBeforeSubmit.checked = config.verifyBeforeSubmit !== false;
    ui.fields.deterministicMath.checked = config.deterministicMath !== false;
    ui.fields.evidenceVerification.checked = config.evidenceVerification !== false;
    ui.fields.semanticCache.checked = config.semanticCache !== false;
    ui.fields.learnWidgetStrategies.checked = config.learnWidgetStrategies !== false;
    ui.fields.attemptDiagnostics.checked = config.attemptDiagnostics !== false;
    ui.fields.verifierModel.value = config.verifierModel || "";
    ui.fields.endpoint.value = config.endpoint;
    ui.fields.apiKey.value = config.apiKey;
    ui.fields.backupEnabled.checked = Boolean(config.backupEnabled);
    ui.fields.backupEndpoint.value = config.backupEndpoint || "";
    ui.fields.backupApiKey.value = config.backupApiKey || "";
    ui.fields.backupModel.value = config.backupModel || "";
    ui.fields.localAnswerCache.checked = config.localAnswerCache !== false;
    ui.fields.supabaseEnabled.checked = Boolean(config.supabaseEnabled);
    ui.fields.supabaseUrl.value = config.supabaseUrl || "";
    ui.fields.supabasePublishableKey.value = config.supabasePublishableKey || "";
    ui.fields.supabaseTable.value = config.supabaseTable || "ixl_answer_cache";
  }

  function handlePanelChange(event) {
    const field = event.target?.dataset?.field;
    if (!field) return;
    config[field] = event.target.type === "checkbox" ? event.target.checked : event.target.value.trim();
    if (field === "subjectMode") {
      const labels = { adaptive: "Adaptive auto-detection", "math-legacy": "Math legacy", reading: "Reading / ELA passage-aware" };
      setStatus(`${labels[config.subjectMode] || "Adaptive"} solver profile selected.`, "success");
      loopReadySignature = "";
      loopReadySince = 0;
    }
    if (["endpoint", "apiKey", "model"].includes(field)) primaryUsageLimitedUntil = 0;
    if (["backupEnabled", "backupEndpoint", "backupApiKey", "backupModel"].includes(field)) backupUsageLimitedUntil = 0;
    if (["supabaseEnabled", "supabaseUrl", "supabasePublishableKey", "supabaseTable"].includes(field)) {
      supabaseTableHealth = { status: "unknown", checkedAt: 0, message: "Settings changed; check required." };
      updateSupabaseTableHealthUi();
    }
    saveConfig();
  }

  async function handlePanelClick(event) {
    const action = event.target?.closest("button")?.dataset?.action;
    if (!action) return;
    if (action === "start") await startAnswer();
    if (action === "loop") {
      if (loopActive) stopAutoLoop("Auto loop stopped.");
      else startAutoLoop();
    }
    if (action === "settings") ui.settings.classList.toggle("open");
    if (action === "debug") {
      ui.debugger.classList.toggle("open");
      if (ui.debugger.classList.contains("open")) runAdaptiveDebugScan();
    }
    if (action === "debug-scan") runAdaptiveDebugScan();
    if (action === "debug-highlight") toggleAdaptiveDebugHighlights();
    if (action === "debug-copy") await copyAdaptiveDebugReport();
    if (action === "replay-tests") await runBuiltInReplayTests();
    if (action === "mistral-tutorial") showMistralApiTutorial();
    if (action === "logs") ui.logs.classList.toggle("open");
    if (action === "toggle") {
      const hidden = ui.body.style.display === "none";
      ui.body.style.display = hidden ? "block" : "none";
      event.target.textContent = hidden ? "Hide" : "Show";
    }
    if (action === "save") {
      readConfigFromPanel();
      setStatus("Settings saved.", "success");
    }
    if (action === "test") await testApi();
    if (action === "test-backup") await testBackupApi();
    if (action === "test-cache") await testAnswerCache();
    if (action === "check-table") await checkSupabaseCacheTable({ force: true, announce: true });
  }

  function closeMistralApiTutorial() {
    document.getElementById(MISTRAL_TUTORIAL_MODAL_ID)?.remove();
    document.removeEventListener("keydown", handleMistralTutorialKeydown, true);
  }

  function handleMistralTutorialKeydown(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    closeMistralApiTutorial();
  }

  function applyMistralDefaultsFromTutorial() {
    config.endpoint = "https://api.mistral.ai/v1/chat/completions";
    config.model = "mistral-small-2603";
    saveConfig();
    syncPanelFromConfig();
    ui.settings.classList.add("open");
    closeMistralApiTutorial();
    setStatus("Mistral endpoint and mistral-small-2603 applied. Paste your own API key in Settings, save, then press Test API.", "success");
    ui.fields.apiKey.focus();
  }

  function showMistralApiTutorial(options = {}) {
    closeMistralApiTutorial();
    const modal = document.createElement("div");
    modal.id = MISTRAL_TUTORIAL_MODAL_ID;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", `${MISTRAL_TUTORIAL_MODAL_ID}-title`);
    modal.innerHTML = `
      <section class="iah-mistral-card">
        <div class="iah-tutorial-head">
          <div>
            <h2 id="${MISTRAL_TUTORIAL_MODAL_ID}-title">Get a Mistral API key</h2>
            <p>A general setup guide for any user. It normally takes about five minutes.</p>
          </div>
          <button type="button" data-tutorial-action="close" aria-label="Close Mistral tutorial">Close</button>
        </div>

        <div class="iah-tutorial-box">
          <strong>Settings this helper expects</strong>
          <div class="iah-tutorial-grid">
            <p>Endpoint<br><code>https://api.mistral.ai/v1/chat/completions</code></p>
            <p>Default model<br><code>mistral-small-2603</code></p>
          </div>
        </div>

        <h3>1. Open Mistral Studio</h3>
        <ol>
          <li>Open <a href="https://console.mistral.ai/" target="_blank" rel="noopener noreferrer">Mistral Studio</a> and sign in or create a Mistral account.</li>
          <li>Studio's free mode currently enables API access without requiring a credit card, but it has usage and rate limits. Paid availability, limits, and regional requirements can change, so review the information shown in the user's own Studio account.</li>
        </ol>

        <h3>2. Create the key</h3>
        <ol>
          <li>In Studio, open <strong>API Keys</strong> in the left sidebar or user-profile menu.</li>
          <li>Press <strong>Create new key</strong>.</li>
          <li>Give it a recognizable name such as <code>IXL helper</code>.</li>
          <li>Choose an expiration date. Shorter expiration plus regular rotation is safer.</li>
          <li>For this helper, the default <strong>Shared connectors only</strong> scope is sufficient; it does not need private connectors.</li>
          <li>Create the key and copy it immediately. Mistral displays the full secret only once.</li>
        </ol>

        <div class="iah-tutorial-box iah-tutorial-warning">
          <strong>Keep the API key secret.</strong>
          <p>Each person must create and use their own keys. Do not post them, send them in chat, put them in screenshots, or commit them to a public file. If one is exposed, delete/rotate it with that provider. This helper stores primary and backup keys in that browser's Tampermonkey storage and sends each only as authorization for its configured AI endpoint; neither key is saved in the Supabase answer table.</p>
        </div>

        <h3>3. Configure the userscript</h3>
        <ol>
          <li>Press <strong>Apply Mistral settings</strong> below. It fills the endpoint and model but does not change or expose an existing key.</li>
          <li>In the helper's Settings, paste the newly created key into <strong>API key</strong>.</li>
          <li>Confirm the endpoint is <code>https://api.mistral.ai/v1/chat/completions</code>.</li>
          <li>Confirm the model is <code>mistral-small-2603</code>.</li>
          <li>Press <strong>Save settings</strong>, followed by <strong>Test API</strong>.</li>
        </ol>

        <h3>4. Understand usage</h3>
        <p>An uncached question normally makes one solver request. If independent verification is enabled, it makes a second request. Exact local or Supabase cache hits make no solver/verifier request. Usage, rate limits, and possible charges belong to the Mistral account that created the key.</p>

        <h3>5. Optional backup API</h3>
        <ol>
          <li>Open helper <strong>Settings</strong> and find <strong>Backup API for usage limits</strong>.</li>
          <li>Enter the backup endpoint, API key, and model. A different account or provider is best; two keys sharing one account may share the same quota.</li>
          <li>Press <strong>Test backup API</strong>. When it passes, enable <strong>Automatically use this backup</strong> and save Settings.</li>
          <li>If the primary returns a quota/rate-limit error, the current solver or verifier request switches to the backup immediately. If both are limited, the auto loop keeps running and retries after one minute.</li>
        </ol>

        <h3>Common errors</h3>
        <div class="iah-tutorial-grid">
          <div class="iah-tutorial-box"><strong>401 Unauthorized</strong><p>The key was copied incorrectly, expired, deleted, or belongs to an unavailable Workspace. Create or copy an active Studio key.</p></div>
          <div class="iah-tutorial-box"><strong>402 / 429 usage limit</strong><p>The account reached a quota, rate, billing, or free-mode limit. A configured backup is tried immediately; if both profiles are limited, the auto loop waits one minute and retries.</p></div>
          <div class="iah-tutorial-box"><strong>422 invalid model</strong><p>Use the exact model ID <code>mistral-small-2603</code>, or review Mistral's current model list if it is later retired.</p></div>
          <div class="iah-tutorial-box"><strong>Browser test fails</strong><p>Recheck the endpoint, remove leading/trailing spaces from the key, save Settings, and try Test API again.</p></div>
        </div>

        <p>Official references: <a href="https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key" target="_blank" rel="noopener noreferrer">Studio activation and API-key quickstart</a> · <a href="https://docs.mistral.ai/admin/identity-access/api-keys" target="_blank" rel="noopener noreferrer">API-key security and management</a> · <a href="https://docs.mistral.ai/studio-api/conversations/chat-completion" target="_blank" rel="noopener noreferrer">Chat Completions</a></p>

        <div class="iah-tutorial-actions">
          <a class="iah-tutorial-button" href="https://console.mistral.ai/" target="_blank" rel="noopener noreferrer">Open Mistral Studio</a>
          <a class="iah-tutorial-button" href="https://docs.mistral.ai/getting-started/quickstarts/studio/activate-and-generate-api-key" target="_blank" rel="noopener noreferrer">Official guide</a>
          <button type="button" data-tutorial-action="settings">Open helper Settings</button>
          <button type="button" data-tutorial-action="apply">Apply Mistral settings</button>
        </div>
      </section>`;
    document.body.appendChild(modal);
    try { GM_setValue(MISTRAL_TUTORIAL_SEEN_KEY, true); } catch (_error) { /* The tutorial can still be used without persistence. */ }
    document.addEventListener("keydown", handleMistralTutorialKeydown, true);
    modal.addEventListener("click", (event) => {
      if (event.target === modal || event.target.closest('[data-tutorial-action="close"]')) {
        closeMistralApiTutorial();
        return;
      }
      if (event.target.closest('[data-tutorial-action="settings"]')) {
        ui.settings.classList.add("open");
        closeMistralApiTutorial();
        ui.fields.apiKey.focus();
        return;
      }
      if (event.target.closest('[data-tutorial-action="apply"]')) applyMistralDefaultsFromTutorial();
    });
    modal.querySelector('[data-tutorial-action="close"]').focus();
    log(options.automatic ? "Opened the built-in Mistral API setup tutorial automatically for first-time onboarding." : "Opened the built-in Mistral API setup tutorial.");
  }

  function isIxlSignInScreen() {
    if (/\/(?:login|signin|sign-in)(?:\/|$)/i.test(location.pathname)) return true;
    const password = [...document.querySelectorAll('input[type="password"]')].find(isVisible);
    if (!password) return false;
    const form = password.closest("form") || password.parentElement;
    return /(?:sign|log)\s*in/i.test(normalizedText(form));
  }

  function scheduleFirstLoginTutorial() {
    try { if (GM_getValue(MISTRAL_TUTORIAL_SEEN_KEY, false)) return; } catch (_error) { /* Try showing it in this session. */ }
    let attempts = 0;
    const attempt = () => {
      attempts += 1;
      try {
        if (GM_getValue(MISTRAL_TUTORIAL_SEEN_KEY, false)) return true;
      } catch (_error) { /* Continue with the in-page check. */ }
      if (uiCompletelyHidden || isIxlSignInScreen() || document.getElementById(COMPLETION_MODAL_ID)) return false;
      showMistralApiTutorial({ automatic: true });
      return true;
    };
    const firstTimer = setTimeout(() => {
      if (attempt()) return;
      const retryTimer = setInterval(() => {
        if (attempt() || attempts >= 400) clearInterval(retryTimer);
      }, 1500);
    }, 900);
    window.addEventListener("pagehide", () => clearTimeout(firstTimer), { once: true });
  }

  function isTypingTarget(element) {
    return Boolean(element?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"]'));
  }

  function setHelperUiHidden(hidden) {
    uiCompletelyHidden = Boolean(hidden);
    document.documentElement.classList.toggle("iah-helper-ui-hidden", uiCompletelyHidden);
    if (!uiCompletelyHidden) {
      ui?.panel?.querySelector('button, input, select')?.blur?.();
      log("Helper UI restored with the Q hotkey; background activity was not interrupted.");
    } else {
      log("Helper UI hidden with the Q hotkey; background activity remains active.");
    }
  }

  function handleGlobalUiHotkey(event) {
    if (event.defaultPrevented || event.repeat || comparableText(event.key) !== "q") return;
    if (event.ctrlKey || event.altKey || event.metaKey) return;
    // Preserve the ability to type the variable/letter q during manual work.
    // While the auto loop is active, Q remains a global UI toggle even if an
    // IXL proxy input happens to retain focus. A hidden UI always restores.
    if (!uiCompletelyHidden && !loopActive && isTypingTarget(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    setHelperUiHidden(!uiCompletelyHidden);
  }

  function readConfigFromPanel() {
    const previousSupabaseSignature = `${config.supabaseEnabled}|${config.supabaseUrl}|${config.supabasePublishableKey}|${config.supabaseTable}`;
    const previousPrimarySignature = `${config.endpoint}|${config.apiKey}|${config.model}`;
    const previousBackupSignature = `${config.backupEnabled}|${config.backupEndpoint}|${config.backupApiKey}|${config.backupModel}`;
    config = {
      ...config,
      mode: ui.fields.mode.value,
      subjectMode: ui.fields.subjectMode.value,
      model: ui.fields.model.value.trim(),
      autoSubmit: ui.fields.autoSubmit.checked,
      includeScreenshot: ui.fields.includeScreenshot.checked,
      screenshotFallback: ui.fields.screenshotFallback.checked,
      verifyBeforeSubmit: ui.fields.verifyBeforeSubmit.checked,
      deterministicMath: ui.fields.deterministicMath.checked,
      evidenceVerification: ui.fields.evidenceVerification.checked,
      semanticCache: ui.fields.semanticCache.checked,
      learnWidgetStrategies: ui.fields.learnWidgetStrategies.checked,
      attemptDiagnostics: ui.fields.attemptDiagnostics.checked,
      verifierModel: ui.fields.verifierModel.value.trim(),
      endpoint: ui.fields.endpoint.value.trim(),
      apiKey: ui.fields.apiKey.value.trim(),
      backupEnabled: ui.fields.backupEnabled.checked,
      backupEndpoint: ui.fields.backupEndpoint.value.trim(),
      backupApiKey: ui.fields.backupApiKey.value.trim(),
      backupModel: ui.fields.backupModel.value.trim(),
      localAnswerCache: ui.fields.localAnswerCache.checked,
      supabaseEnabled: ui.fields.supabaseEnabled.checked,
      supabaseUrl: ui.fields.supabaseUrl.value.trim().replace(/\/$/, ""),
      supabasePublishableKey: ui.fields.supabasePublishableKey.value.trim(),
      supabaseTable: ui.fields.supabaseTable.value.trim() || "ixl_answer_cache",
    };
    const nextSupabaseSignature = `${config.supabaseEnabled}|${config.supabaseUrl}|${config.supabasePublishableKey}|${config.supabaseTable}`;
    if (previousPrimarySignature !== `${config.endpoint}|${config.apiKey}|${config.model}`) primaryUsageLimitedUntil = 0;
    if (previousBackupSignature !== `${config.backupEnabled}|${config.backupEndpoint}|${config.backupApiKey}|${config.backupModel}`) backupUsageLimitedUntil = 0;
    if (previousSupabaseSignature !== nextSupabaseSignature) {
      supabaseTableHealth = { status: "unknown", checkedAt: 0, message: "Settings changed; check required." };
      updateSupabaseTableHealthUi();
    }
    saveConfig();
  }

  function log(message, details) {
    const line = document.createElement("div");
    const suffix = details === undefined ? "" : ` ${safeStringify(details)}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}${suffix}`;
    ui?.logs?.appendChild(line);
    if (ui?.logs) ui.logs.scrollTop = ui.logs.scrollHeight;
    console.debug(`[${SCRIPT_ID}] ${message}`, details ?? "");
  }

  function safeStringify(value) {
    try {
      const text = JSON.stringify(value);
      return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
    } catch (_error) {
      return String(value);
    }
  }

  function setStatus(message, type = "") {
    ui.status.textContent = message;
    ui.status.className = `iah-status${type ? ` ${type}` : ""}`;
  }

  function startProgress() {
    clearInterval(progressTimer);
    ui.progress.style.display = "block";
    ui.progress.value = 4;
    progressTimer = setInterval(() => {
      ui.progress.value = Math.min(92, ui.progress.value + Math.max(1, (92 - ui.progress.value) * 0.08));
    }, 250);
  }

  function stopProgress() {
    clearInterval(progressTimer);
    progressTimer = null;
    ui.progress.value = 100;
    setTimeout(() => {
      ui.progress.style.display = "none";
      ui.progress.value = 0;
    }, 350);
  }

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) return false;
    if (element.closest(`#${PANEL_ID}`)) return false;
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  function normalizedText(element) {
    return (element?.innerText || element?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function getAccessibleName(element) {
    const direct = element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("placeholder");
    if (direct?.trim()) return direct.trim();

    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent || "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) return text;
    }

    if (element.labels?.length) {
      const text = [...element.labels].map(normalizedText).join(" ").trim();
      if (text) return text;
    }

    const label = element.closest("label");
    if (label) {
      const text = normalizedText(label);
      if (text) return text;
    }

    const own = normalizedText(element);
    if (own) return own;
    return normalizedText(element.parentElement).slice(0, 250);
  }

  function looksLikeChoiceButton(element) {
    if (element.matches('[role="radio"], [role="checkbox"], [role="option"], [data-testid*="choice" i], [class*="choice" i], [class*="answer-option" i]')) {
      return true;
    }
    if (element.tagName !== "BUTTON" && element.getAttribute("role") !== "button") return false;
    const text = getAccessibleName(element);
    if (!text || UTILITY_BUTTON_RE.test(text)) return false;
    const parentButtons = element.parentElement
      ? [...element.parentElement.querySelectorAll(":scope > button, :scope > [role=button]")].filter(isVisible)
      : [];
    return parentButtons.length >= 2 || Boolean(element.closest('[class*="choice" i], [class*="answer" i], [class*="option" i]'));
  }

  function isAnswerTarget(element) {
    if (!isVisible(element) || element.disabled || element.closest("nav, header, footer")) return false;
    if (element.matches("input, textarea, select, canvas, [contenteditable=true], [role=textbox], [role=combobox], [role=radio], [role=checkbox], [role=switch], [role=slider], [role=listbox], [role=application], [role=gridcell], [draggable=true], [aria-dropeffect], [data-testid=listItem], [class*=draggable i], [class*=droppable i], [class*=drop-zone i], [class*=dropzone i], [class*=graphingPointerOverlay i], [class*=interactive i][tabindex]")) {
      return true;
    }
    return looksLikeChoiceButton(element);
  }

  function isInteractiveGraphControl(element) {
    if (targetKind(element) !== "graph") return false;
    const className = String(element.className?.baseVal ?? element.className ?? "");
    return element.getAttribute("role") === "application"
      || element.hasAttribute("tabindex")
      || /graphingPointerOverlay|interactive|plot|draw|coordinate.*input/i.test(className)
      || Boolean(element.closest('[role="application"], [class*="graphingPointerOverlay" i], [class*="interactive" i][tabindex]'));
  }

  function collectTargets(root) {
    const seen = new Set();
    const candidates = [...root.querySelectorAll(ANSWER_SELECTOR)].filter((element) => {
      if (!isAnswerTarget(element)) return false;
      const kind = targetKind(element);
      const semanticOption = element.parentElement?.closest('[role="option"], [role="radio"], [role="checkbox"]');
      if (semanticOption && root.contains(semanticOption) && semanticOption !== element && ["choice", "drag-source"].includes(kind)) return false;
      // Keep the leaf control instead of a wrapping custom-choice/choices container.
      if (
        !element.matches("input, textarea, select")
        && !["ordering", "graph", "drop-zone"].includes(kind)
        && element.querySelector('input, textarea, select, button, [role="button"], [role="radio"], [role="checkbox"], [role="option"]')
      ) return false;
      if (seen.has(element)) return false;
      seen.add(element);
      return true;
    });
    const nonGraphTargets = candidates.filter((element) => targetKind(element) !== "graph");
    if (nonGraphTargets.length) {
      // Static graph canvases illustrate many multiple-choice questions. Once
      // real controls exist, do not expose those canvases as answer targets.
      return candidates.filter((element) => targetKind(element) !== "graph" || isInteractiveGraphControl(element));
    }
    const onlyPassiveCanvases = candidates.length > 0 && candidates.every((element) => targetKind(element) === "graph" && !isInteractiveGraphControl(element));
    if (onlyPassiveCanvases) {
      const submitPresent = [...root.querySelectorAll('button, input[type="submit"], [role="button"]')]
        .some((element) => isVisible(element) && SUBMIT_BUTTON_RE.test(getAccessibleName(element)));
      // During IXL's question transition, illustration canvases can appear a
      // moment before the actual answer controls and Submit button.
      if (!submitPresent) return [];
    }
    return candidates;
  }

  function findQuestionRoot() {
    const exactIxlRoot = [...document.querySelectorAll('[aria-label="question"], [data-cy="question-section"]')]
      .find((element) => isVisible(element) && collectTargets(element).length);
    if (exactIxlRoot) return exactIxlRoot;
    const searchRoot = document.querySelector("main, article") || document.body;
    const allTargets = collectTargets(searchRoot);
    if (!allTargets.length) return null;

    const scored = [];
    for (const selector of ROOT_SELECTORS) {
      for (const candidate of searchRoot.querySelectorAll(selector)) {
        if (!isVisible(candidate)) continue;
        const targets = allTargets.filter((target) => candidate.contains(target));
        if (!targets.length) continue;
        const textLength = normalizedText(candidate).length;
        if (textLength < 3) continue;
        const rect = candidate.getBoundingClientRect();
        const selectorBonus = ROOT_SELECTORS.length - ROOT_SELECTORS.indexOf(selector);
        const hugePenalty = textLength > 12000 ? 30 : 0;
        const areaPenalty = rect.height > innerHeight * 2.5 ? 10 : 0;
        const score = selectorBonus * 5 + Math.min(20, targets.length * 3) + Math.min(25, textLength / 80) - hugePenalty - areaPenalty;
        scored.push({ candidate, score, textLength });
      }
    }

    if (scored.length) {
      scored.sort((a, b) => b.score - a.score || a.textLength - b.textLength);
      return scored[0].candidate;
    }

    // Fallback: walk upward from the first likely answer control until prompt text is included.
    let candidate = allTargets[0];
    for (let depth = 0; candidate?.parentElement && depth < 9; depth += 1) {
      candidate = candidate.parentElement;
      if (normalizedText(candidate).length >= 20 && collectTargets(candidate).length) return candidate;
    }
    return searchRoot;
  }

  function targetKind(element) {
    const role = element.getAttribute("role") || "";
    const type = element.getAttribute("type") || "";
    const className = String(element.className?.baseVal ?? element.className).toLowerCase();
    if (role === "listbox" || element.getAttribute("aria-roledescription")?.toLowerCase().includes("orderable")) return "ordering";
    if (role === "application" || element.tagName === "CANVAS" || className.includes("graphingpointeroverlay")) return "graph";
    if (element.matches('[aria-dropeffect], [class*="droppable" i], [class*="drop-zone" i], [class*="dropzone" i]')) return "drop-zone";
    if (element.matches('[draggable="true"], [data-testid="listItem"], [class*="draggable" i]')) return "drag-source";
    if (element.tagName === "SELECT" || role === "combobox") return "dropdown";
    if (type === "radio" || role === "radio") return "single-choice";
    if (type === "checkbox" || role === "checkbox" || role === "switch") return "multi-choice";
    if (element.tagName === "TEXTAREA" || element.isContentEditable || role === "textbox") return "text";
    if (element.tagName === "INPUT" && !["radio", "checkbox", "range"].includes(type)) return "text";
    if (role === "slider" || type === "range") return "slider";
    if (role === "gridcell") return "grid-cell";
    return "choice";
  }

  function relativeBounds(element, root) {
    const rect = element.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const round = (number) => Math.round(number * 1000) / 1000;
    return {
      left: round((rect.left - rootRect.left) / Math.max(1, rootRect.width)),
      top: round((rect.top - rootRect.top) / Math.max(1, rootRect.height)),
      width: round(rect.width / Math.max(1, rootRect.width)),
      height: round(rect.height / Math.max(1, rootRect.height)),
    };
  }

  function describeTarget(element, index) {
    const descriptor = {
      target: index,
      kind: targetKind(element),
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute("role") || null,
      roleDescription: element.getAttribute("aria-roledescription") || null,
      inputType: element.getAttribute("type") || null,
      label: getAccessibleName(element).slice(0, 500),
      currentValue: "value" in element ? String(element.value || "") : normalizedText(element).slice(0, 250),
      checked: ["single-choice", "multi-choice"].includes(targetKind(element)) && "checked" in element
        ? Boolean(element.checked)
        : element.getAttribute("aria-checked"),
      bounds: relativeBounds(element, findQuestionRoot() || element.parentElement || element),
    };
    if (element.tagName === "SELECT") {
      descriptor.options = [...element.options].map((option, optionIndex) => ({
        optionIndex,
        text: normalizedText(option),
        value: option.value,
        selected: option.selected,
      }));
    }
    if (descriptor.kind === "slider") {
      descriptor.min = element.min || element.getAttribute("aria-valuemin");
      descriptor.max = element.max || element.getAttribute("aria-valuemax");
      descriptor.step = element.step || null;
    }
    if (descriptor.kind === "ordering") {
      descriptor.items = [...element.querySelectorAll(':scope > [role="option"], :scope > [data-testid="listItem"]')]
        .map((item, itemIndex) => ({ itemIndex, label: getAccessibleName(item).slice(0, 300), text: normalizedText(item).slice(0, 200) }));
    }
    if (descriptor.kind === "graph") {
      const graphBase = element.closest('[class*="graphingBaseContainer" i]') || element.parentElement;
      const scaleLabels = [...(graphBase?.querySelectorAll?.('.xAxisScaleLabel, .yAxisScaleLabel, [class*="axis" i][class*="label" i]') || [])]
        .map((label) => normalizedText(label)).filter(Boolean).slice(0, 80);
      const graphTools = [...(graphBase?.querySelectorAll?.('button, [role="button"], [role="radio"]') || [])]
        .filter(isVisible).map((tool) => getAccessibleName(tool)).filter(Boolean).slice(0, 30);
      descriptor.graphDescription = [
        normalizedText(graphBase?.querySelector('.hiddenCoordinatePlaneDescription')),
        graphBase?.getAttribute("aria-label") || "",
        normalizedText(graphBase).slice(0, 1200),
        scaleLabels.length ? `Axis labels: ${scaleLabels.join(", ")}` : "",
        graphTools.length ? `Graph tools: ${graphTools.join(", ")}` : "",
      ].filter(Boolean).join(" | ").slice(0, 4000);
      descriptor.graphWidget = {
        interactive: isInteractiveGraphControl(element),
        surfaceTag: graphInteractionSurface(element)?.tagName || element.tagName,
        toolLabels: graphTools,
        scaleLabels,
      };
    }
    return descriptor;
  }

  function extractMath(root) {
    const parts = [];
    const selectors = [
      'script[type^="math/tex"]',
      "math",
      "mjx-assistive-mml",
      "[data-latex]",
      "[aria-label*='equals' i]",
    ];
    for (const element of root.querySelectorAll(selectors.join(","))) {
      const value = element.dataset?.latex || element.getAttribute("aria-label") || element.textContent;
      const clean = value?.replace(/\s+/g, " ").trim();
      if (clean && !parts.includes(clean)) parts.push(clean);
    }
    return parts.slice(0, 100).join("\n");
  }

  function sanitizeHtml(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll(`script, style, link, noscript, iframe, #${PANEL_ID}`).forEach((node) => node.remove());
    clone.querySelectorAll("*").forEach((element) => {
      [...element.attributes].forEach((attribute) => {
        if (/^on/i.test(attribute.name) || ["style", "srcset"].includes(attribute.name)) element.removeAttribute(attribute.name);
      });
    });
    return clone.outerHTML.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").slice(0, 35000);
  }

  function activityContextKey(root) {
    const page = questionPageContext(root);
    const path = location.pathname.replace(/\/+$/, "").toLowerCase();
    const breadcrumb = (page.breadcrumbs || []).map(comparableText).filter(Boolean).join("|");
    return `${location.hostname.toLowerCase()}|${path}|${breadcrumb || comparableText(page.heading || "")}`.slice(0, 1800);
  }

  function readRememberedPassages() {
    try {
      let stored = GM_getValue(READING_CONTEXT_KEY, {}) || {};
      if (typeof stored === "string") stored = JSON.parse(stored);
      return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
    } catch (_error) {
      return {};
    }
  }

  function readSessionObject(key) {
    try {
      const parsed = JSON.parse(sessionStorage.getItem(key) || "{}");
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (_error) {
      return {};
    }
  }

  function writeSessionObject(key, value) {
    try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (_error) { /* A private/locked tab can reject storage. */ }
  }

  function compactTextFingerprint(value) {
    const text = comparableText(String(value || "")).slice(0, 60000);
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `${hash.toString(16).padStart(8, "0")}-${text.length}`;
  }

  function passageFingerprint(passage) {
    return compactTextFingerprint(`${passage?.title || ""}\n${passage?.text || ""}`);
  }

  function passageStorageKey(activityKey, fingerprint) {
    return `${activityKey}::article:${fingerprint}`;
  }

  function questionPassageBindingKey(activityKey, questionText) {
    return `${activityKey}::question:${compactTextFingerprint(`${location.pathname}${location.search}\n${questionText || ""}`)}`;
  }

  function saveRememberedPassage(passage) {
    if (!passage?.activityKey || !passage.text || passage.text.length < 120) return "";
    const fingerprint = passageFingerprint(passage);
    const stored = readRememberedPassages();
    stored[passageStorageKey(passage.activityKey, fingerprint)] = {
      activityKey: passage.activityKey,
      fingerprint,
      text: passage.text.slice(0, 30000),
      title: passage.title || "",
      html: passage.html?.slice(0, 30000) || "",
      sourceUrl: location.href,
      savedAt: Date.now(),
    };
    const recent = Object.entries(stored)
      .filter(([, value]) => Date.now() - Number(value?.savedAt || 0) <= READING_CONTEXT_TTL_MS)
      .sort((left, right) => Number(right[1]?.savedAt || 0) - Number(left[1]?.savedAt || 0))
      .slice(0, 24);
    GM_setValue(READING_CONTEXT_KEY, Object.fromEntries(recent));

    // sessionStorage is intentionally tab-scoped. A passage opened in another
    // tab cannot become the active article for this tab's questions.
    const active = readSessionObject(READING_ACTIVE_SESSION_KEY);
    active[passage.activityKey] = { fingerprint, activityKey: passage.activityKey, savedAt: Date.now(), sourceUrl: location.href };
    writeSessionObject(READING_ACTIVE_SESSION_KEY, active);
    return fingerprint;
  }

  function armReadingPageHandoff(passage) {
    if (!passage?.fingerprint || !passage.activityKey) return;
    const active = readSessionObject(READING_ACTIVE_SESSION_KEY);
    active.__pendingQuestionHandoff = {
      fingerprint: passage.fingerprint,
      activityKey: passage.activityKey,
      sourceUrl: passage.sourceUrl || location.href,
      savedAt: Date.now(),
    };
    writeSessionObject(READING_ACTIVE_SESSION_KEY, active);
  }

  function rememberedPassageForQuestion(activityKey, questionText) {
    const stored = readRememberedPassages();
    const active = readSessionObject(READING_ACTIVE_SESSION_KEY);
    const bindings = readSessionObject(READING_BINDINGS_SESSION_KEY);
    const bindingKey = questionPassageBindingKey(activityKey, questionText);
    const pending = active.__pendingQuestionHandoff;
    const validPending = pending?.fingerprint && Date.now() - Number(pending.savedAt || 0) <= 5 * 60 * 1000
      ? pending
      : null;
    const activeReference = active[activityKey] || validPending;
    const existingBinding = bindings[bindingKey];

    // The same prompt has now appeared after a different article became active.
    // Treat that as ambiguous instead of ever returning the wrong passage.
    if (existingBinding?.fingerprint && activeReference?.fingerprint
      && existingBinding.fingerprint !== activeReference.fingerprint) {
      return { passage: null, ambiguity: "This question prompt has been seen with more than one active article in this tab." };
    }

    const reference = existingBinding?.fingerprint ? existingBinding : activeReference;
    if (!reference?.fingerprint) return { passage: null, ambiguity: "No article is securely bound to this question." };
    const sourceActivityKey = reference.sourceActivityKey || reference.activityKey || activityKey;
    const record = stored[passageStorageKey(sourceActivityKey, reference.fingerprint)];
    if (!record
      || record.activityKey !== sourceActivityKey
      || record.fingerprint !== reference.fingerprint
      || Date.now() - Number(record.savedAt || 0) > READING_CONTEXT_TTL_MS) {
      return { passage: null, ambiguity: "The bound article is missing, expired, or failed fingerprint validation." };
    }

    if (!existingBinding) {
      bindings[bindingKey] = { fingerprint: reference.fingerprint, sourceActivityKey, boundAt: Date.now(), activityKey };
      const recentBindings = Object.entries(bindings)
        .sort((left, right) => Number(right[1]?.boundAt || 0) - Number(left[1]?.boundAt || 0))
        .slice(0, 200);
      writeSessionObject(READING_BINDINGS_SESSION_KEY, Object.fromEntries(recentBindings));
    }
    if (!active[activityKey] && validPending) {
      active[activityKey] = { ...validPending, sourceActivityKey, activityKey: sourceActivityKey, adoptedAt: Date.now() };
      delete active.__pendingQuestionHandoff;
      writeSessionObject(READING_ACTIVE_SESSION_KEY, active);
    }
    return { passage: record, ambiguity: "" };
  }

  function likelyReadingCue(text) {
    return /\b(?:read(?:ing)?|passage|selection|story|poem|article|paragraph|sentence|author|narrator|character|main idea|central idea|theme|text evidence|infer(?:ence)?|context clue|vocabulary|grammar|pronoun|verb|adjective|adverb|synonym|antonym|meaning of|best supports|according to the text)\b/i.test(text || "");
  }

  function extractReadingPassage(root, targets, questionText, forceReading = false) {
    const activityKey = activityContextKey(root);
    const candidates = [];
    const seen = new Set();
    const add = (element, source = "page candidate") => {
      if (!(element instanceof Element) || seen.has(element) || !isVisible(element) || element.closest(`#${PANEL_ID}`)) return;
      seen.add(element);
      const text = normalizedText(element).replace(/\s+/g, " ").trim();
      if (text.length < 120 || text.length > 32000) return;
      const marker = `${element.id || ""} ${element.className?.baseVal ?? element.className ?? ""} ${element.getAttribute("aria-label") || ""} ${element.getAttribute("data-testid") || ""}`;
      const containedTargets = targets.filter((target) => element.contains(target)).length;
      let score = Math.min(35, Math.log2(text.length) * 3);
      if (/passage|selection|story|article|reading|poem|source-text|stimulus|excerpt/i.test(marker)) score += 55;
      if (element.matches("article, blockquote, [role=article]")) score += 28;
      score += Math.min(20, element.querySelectorAll("p").length * 4);
      if (element === root) score -= targets.length ? 45 : 5;
      if (containedTargets) score -= Math.min(70, containedTargets * 18);
      if (/\b(?:submit|check answer|answer choices?)\b/i.test(text.slice(-400))) score -= 20;
      candidates.push({ element, text, source, score });
    };

    const selectors = [
      '[aria-label*="passage" i]', '[aria-label*="reading" i]', '[data-testid*="passage" i]',
      '[data-cy*="passage" i]', '[class*="passage" i]', '[class*="selection" i]',
      '[class*="story" i]', '[class*="article" i]', '[class*="reading" i]',
      "article", "blockquote", '[role="article"]'
    ].join(",");
    for (const element of querySelectorAllDeep(selectors)) add(element, "explicit passage element");

    let current = root;
    for (let depth = 0; current?.parentElement && depth < 6; depth += 1, current = current.parentElement) {
      const siblings = [...current.parentElement.children];
      const index = siblings.indexOf(current);
      for (const sibling of siblings.slice(Math.max(0, index - 4), index)) add(sibling, "preceding question content");
    }

    candidates.sort((left, right) => right.score - left.score || right.text.length - left.text.length);
    const best = candidates[0];
    if (best && best.score >= 38) {
      const heading = best.element.querySelector("h1, h2, h3, [role=heading]");
      const passage = {
        activityKey,
        text: best.text.slice(0, 30000),
        title: normalizedText(heading).slice(0, 500),
        html: sanitizeHtml(best.element).slice(0, 30000),
        element: best.element,
        source: best.source,
        sourceUrl: location.href,
        savedAt: Date.now(),
        currentPage: true,
      };
      passage.fingerprint = saveRememberedPassage(passage);
      return passage;
    }

    const pageHints = `${location.pathname} ${questionPageContext(root).breadcrumbs.join(" ")} ${questionPageContext(root).heading} ${questionText}`;
    if (forceReading || likelyReadingCue(pageHints)) {
      const rememberedResult = rememberedPassageForQuestion(activityKey, questionText);
      const remembered = rememberedResult.passage;
      if (remembered) {
        return {
          activityKey,
          fingerprint: remembered.fingerprint,
          text: String(remembered.text || "").slice(0, 30000),
          title: String(remembered.title || "").slice(0, 500),
          html: String(remembered.html || "").slice(0, 30000),
          element: null,
          source: "fingerprint-verified article bound to this question from a previous IXL page",
          sourceUrl: remembered.sourceUrl || "",
          savedAt: Number(remembered.savedAt || 0),
          currentPage: false,
        };
      }
      return { activityKey, fingerprint: "", text: "", title: "", html: "", element: null, source: "none", sourceUrl: "", savedAt: 0, currentPage: false, ambiguity: rememberedResult.ambiguity };
    }
    return { activityKey, fingerprint: "", text: "", title: "", html: "", element: null, source: "none", sourceUrl: "", savedAt: 0, currentPage: false, ambiguity: "" };
  }

  function detectAcademicSubject(root, questionText, readingPassage) {
    const page = questionPageContext(root);
    const evidence = `${location.pathname} ${(page.breadcrumbs || []).join(" ")} ${page.heading} ${questionText} ${readingPassage?.title || ""}`;
    if (readingPassage?.text || likelyReadingCue(evidence) || /language arts|ela\b|english/i.test(evidence)) return "reading-language-arts";
    if (/\b(?:science|biology|chemistry|physics|earth science)\b/i.test(evidence)) return "science";
    if (/\b(?:social studies|history|geography|civics)\b/i.test(evidence)) return "social-studies";
    if (extractMath(root) || /\b(?:math|algebra|geometry|arithmetic|equation|fraction|decimal|factor|multiple|function|slope)\b/i.test(evidence)) return "mathematics";
    return "general-academic";
  }

  function detectQuestionType(subject, descriptors, questionText, readingPassage) {
    if (subject === "reading-language-arts") {
      if (/\b(?:grammar|pronoun|verb|adjective|adverb|punctuation|sentence fragment)\b/i.test(questionText)) return "language-grammar";
      if (/\b(?:meaning|vocabulary|synonym|antonym|context clue)\b/i.test(questionText)) return "language-vocabulary";
      return readingPassage?.text ? "reading-comprehension" : "language-arts";
    }
    if (descriptors.some((target) => target.kind === "graph")) return "interactive-graph";
    if (descriptors.some((target) => target.kind === "ordering")) return "ordering";
    if (descriptors.some((target) => ["drag-source", "drop-zone"].includes(target.kind))) return "drag-and-drop";
    if (descriptors.filter((target) => target.kind === "text").length > 1) return "multi-part-entry";
    if (descriptors.some((target) => target.kind === "multi-choice")) return "multiple-select";
    if (descriptors.some((target) => ["choice", "single-choice"].includes(target.kind))) return "multiple-choice";
    return "constructed-response";
  }

  function evaluateDomEvidence(context) {
    let score = 100;
    const issues = [];
    const visibleLabels = context.descriptors.filter((target) => comparableText(target.label)).length;
    if (context.questionText.length < 12) { score -= 45; issues.push("question text is very short"); }
    if (!context.descriptors.length) { score -= 60; issues.push("no answer targets detected"); }
    if (context.descriptors.length && visibleLabels / context.descriptors.length < 0.5) { score -= 25; issues.push("most answer targets lack accessible labels"); }
    const passageRequired = context.subject === "reading-language-arts" && /\b(?:passage|selection|story|article|poem|text|author|character|according to|best supports|evidence)\b/i.test(context.questionText);
    if (passageRequired && context.readingPassage.text.length < 120) { score -= 50; issues.push("the question refers to reading material, but no passage was extracted or remembered"); }
    const graphWithoutText = context.descriptors.some((target) => target.kind === "graph" && comparableText(target.graphDescription || "").length < 20);
    if (graphWithoutText) { score -= 45; issues.push("an interactive graph has no useful accessibility description"); }
    const unlabeledVisual = [...context.root.querySelectorAll("canvas, img, svg")].some((element) => {
      if (!isVisible(element)) return false;
      const label = comparableText(element.getAttribute("aria-label") || element.getAttribute("alt") || element.querySelector?.("title, desc")?.textContent || "");
      return label.length < 8;
    });
    const visualCue = /\b(?:image|picture|diagram|graph|chart|figure|shown|above|below)\b/i.test(context.questionText);
    if (unlabeledVisual && visualCue) { score -= 35; issues.push("the prompt depends on an unlabeled visual"); }
    score = Math.max(0, Math.min(100, score));
    return {
      score,
      issues,
      screenshotRecommended: score < 60,
      reason: issues.length ? issues.join("; ") : "DOM text, passage context, and target labels are sufficient",
    };
  }

  async function captureQuestionImage(root, force = false) {
    if ((!force && !config.includeScreenshot && !config.screenshotFallback) || typeof html2canvas !== "function") return null;
    try {
      const rect = root.getBoundingClientRect();
      const scale = Math.max(0.75, Math.min(1.5, 1600 / Math.max(rect.width, rect.height, 1)));
      const canvas = await html2canvas(root, {
        backgroundColor: "#ffffff",
        logging: false,
        scale,
        useCORS: true,
        imageTimeout: 2500,
        removeContainer: true,
        ignoreElements: (element) => element.id === PANEL_ID,
      });
      return canvas.toDataURL("image/jpeg", 0.86);
    } catch (error) {
      log("Question screenshot failed; continuing with DOM extraction.", String(error));
      return captureFirstCanvas(root);
    }
  }

  async function captureTargetedQuestionImage(context) {
    if (typeof html2canvas !== "function") return captureFirstCanvas(context.root);
    const candidates = [];
    const add = (element) => { if (element?.isConnected && isVisible(element) && !candidates.includes(element)) candidates.push(element); };
    context.targets.filter((target) => ["graph", "drag", "ordering"].includes(targetKind(target))).forEach(add);
    [...context.root.querySelectorAll("canvas,svg,img")].filter(isVisible).forEach((element) => {
      const label = comparableText(element.getAttribute("aria-label") || element.getAttribute("alt") || element.querySelector?.("title,desc")?.textContent || "");
      if (label.length < 12 || context.domEvidence?.screenshotRecommended) add(element.closest("figure,[class*=graph i],[class*=diagram i]") || element);
    });
    if (context.readingPassage?.element?.isConnected && context.domEvidence?.issues?.some((issue) => /passage|reading/i.test(issue))) add(context.readingPassage.element);
    if (!candidates.length) add(context.root);
    const captures = [];
    for (const element of candidates.slice(0, 3)) {
      try {
        const rect = element.getBoundingClientRect();
        const scale = Math.max(0.8, Math.min(1.5, 1200 / Math.max(rect.width, rect.height, 1)));
        captures.push(await html2canvas(element, { backgroundColor: "#ffffff", logging: false, scale, useCORS: true, imageTimeout: 2500, removeContainer: true, ignoreElements: (node) => node.id === PANEL_ID }));
      } catch (error) { log("One targeted screenshot crop failed; trying the remaining evidence regions.", String(error)); }
    }
    if (!captures.length) return captureQuestionImage(context.root, true);
    if (captures.length === 1) return captures[0].toDataURL("image/jpeg", 0.88);
    const width = Math.min(1800, Math.max(...captures.map((canvas) => canvas.width)));
    const scaledHeights = captures.map((canvas) => Math.round(canvas.height * Math.min(1, width / canvas.width)));
    const collage = document.createElement("canvas");
    collage.width = width;
    collage.height = Math.min(2600, scaledHeights.reduce((sum, height) => sum + height + 8, 0));
    const draw = collage.getContext("2d");
    draw.fillStyle = "#fff"; draw.fillRect(0, 0, collage.width, collage.height);
    let y = 0;
    captures.forEach((canvas, index) => {
      const ratio = Math.min(1, width / canvas.width); const height = scaledHeights[index];
      if (y + height <= collage.height) draw.drawImage(canvas, 0, y, Math.round(canvas.width * ratio), height);
      y += height + 8;
    });
    return collage.toDataURL("image/jpeg", 0.88);
  }

  function captureFirstCanvas(root) {
    for (const canvas of root.querySelectorAll("canvas")) {
      try {
        if (canvas.width && canvas.height) return canvas.toDataURL("image/png");
      } catch (_error) {
        // A cross-origin canvas can be tainted. Try the next one.
      }
    }
    return null;
  }

  function makeContext(root, targets) {
    const descriptors = targets.map(describeTarget);
    const questionText = normalizedText(root).slice(0, 20000);
    const solverProfile = ["adaptive", "math-legacy", "reading"].includes(config.subjectMode) ? config.subjectMode : "adaptive";
    const readingPassage = solverProfile === "math-legacy"
      ? { activityKey: activityContextKey(root), fingerprint: "", text: "", title: "", html: "", element: null, source: "disabled by Math legacy profile", sourceUrl: "", savedAt: 0, currentPage: false, ambiguity: "" }
      : extractReadingPassage(root, targets, questionText, solverProfile === "reading");
    const detectedSubject = detectAcademicSubject(root, questionText, readingPassage);
    const subject = solverProfile === "math-legacy"
      ? "mathematics"
      : solverProfile === "reading" ? "reading-language-arts" : detectedSubject;
    const questionType = detectQuestionType(subject, descriptors, questionText, readingPassage);
    let captureRoot = root;
    if (readingPassage.element && !root.contains(readingPassage.element)) {
      let ancestor = root.parentElement;
      while (ancestor && ancestor !== document.body && !ancestor.contains(readingPassage.element)) ancestor = ancestor.parentElement;
      if (ancestor?.contains(readingPassage.element)) captureRoot = ancestor;
    }
    const context = {
      root,
      targets,
      descriptors,
      questionText,
      math: extractMath(root),
      html: sanitizeHtml(root),
      readingPassage,
      solverProfile,
      detectedSubject,
      subject,
      questionType,
      captureRoot,
      fingerprint: `${location.pathname}|${subject}|${questionType}|${questionText.slice(0, 800)}|${readingPassage.text.slice(0, 800)}|${safeStringify(descriptors).slice(0, 1200)}`,
    };
    context.domEvidence = evaluateDomEvidence(context);
    updateAdaptiveDebugger(context);
    return context;
  }

  function passageEvidenceSegments(readingPassage = {}) {
    const segments = [];
    const pushText = (raw, paragraphIndex) => {
      const text = comparableText(raw);
      if (!text) return;
      const sentences = text.match(/[^.!?]+(?:[.!?]+|$)/g) || [text];
      sentences.forEach((sentence, sentenceIndex) => {
        const clean = comparableText(sentence);
        if (clean.length >= 2) segments.push({ id: `p${paragraphIndex}-s${sentenceIndex + 1}`, text: clean });
      });
    };
    if (readingPassage.html) {
      try {
        const doc = new DOMParser().parseFromString(`<main>${readingPassage.html}</main>`, "text/html");
        const blocks = [...doc.querySelectorAll("h1,h2,h3,h4,p,li,blockquote,figcaption")];
        blocks.forEach((block, index) => pushText(block.textContent, index + 1));
      } catch (_error) { /* Text fallback below. */ }
    }
    if (!segments.length) {
      String(readingPassage.text || "").split(/\n{2,}|\r?\n/).filter(Boolean).forEach((text, index) => pushText(text, index + 1));
    }
    return segments.slice(0, 500);
  }

  function extractQuestionConstraints(text) {
    const source = comparableText(text);
    const requiredForm = source.match(/(?:in|using)\s+the\s+(?:form|format)\s+([^.!?]+)/i)?.[1]
      || source.match(/write (?:your )?answer (?:as|in)\s+([^.!?]+)/i)?.[1] || "";
    const rounding = source.match(/round(?: your answer)? to (?:the )?([^.!?]+)/i)?.[1] || "";
    const unit = source.match(/\b(square|cubic)?\s*(feet|foot|inches|inch|yards|yard|miles|mile|meters|meter|centimeters|centimeter|kilometers|kilometer|seconds|second|minutes|minute|hours|hour|dollars|cents|degrees|percent)\b(?!.*\b(?:per|each)\b)/i);
    return {
      requiredForm: comparableText(requiredForm),
      rounding: comparableText(rounding),
      unit: unit ? comparableText(`${unit[1] || ""} ${unit[2]}`) : "",
      selectAll: /select all|choose all|all (?:answers|statements) that apply/i.test(source),
      ordered: /order|arrange|least to greatest|greatest to least|chronological/i.test(source),
      exact: /exact|simplest form|fully simplified|gcf|greatest common factor/i.test(source),
    };
  }

  function targetRoleForIr(descriptor, index, context) {
    return comparableText(descriptor.contextText || targetSemanticContext(context.targets[index], context.root, descriptor.kind) || descriptor.label || `answer ${index + 1}`);
  }

  function buildProblemIR(context) {
    const neutral = targetNeutralQuestionClone(context);
    const prompt = comparableText(normalizedText(neutral)) || comparableText(context.questionText);
    const segments = passageEvidenceSegments(context.readingPassage);
    const targets = context.descriptors.map((descriptor, index) => ({
      id: `t${index}`,
      target: index,
      kind: descriptor.kind,
      role: targetRoleForIr(descriptor, index, context),
      label: comparableText(descriptor.label || ""),
      options: (descriptor.options || []).map((option) => comparableText(option.text)).filter(Boolean),
      items: (descriptor.items || []).map((item) => comparableText(item.label || item.text)).filter(Boolean),
      graphDescription: comparableText(descriptor.graphDescription || ""),
    }));
    const quantities = [...prompt.matchAll(/(?<![\w.])-?\d+(?:,\d{3})*(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*%?/g)].map((match, index) => ({
      id: `q${index + 1}`,
      raw: match[0].replace(/\s+/g, ""),
      offset: match.index,
      context: prompt.slice(Math.max(0, match.index - 45), match.index + match[0].length + 45),
    }));
    const ir = {
      schema: 1,
      solverProfile: context.solverProfile,
      subject: context.subject,
      questionType: context.questionType,
      prompt,
      math: comparableText(context.math || ""),
      tables: extractTableDetails(neutral),
      quantities,
      constraints: extractQuestionConstraints(prompt),
      targets,
      passage: context.readingPassage?.fingerprint ? {
        fingerprint: context.readingPassage.fingerprint,
        title: comparableText(context.readingPassage.title || ""),
        segments,
      } : null,
      visualDependency: Boolean(context.domEvidence?.screenshotRecommended),
    };
    lastProblemIR = ir;
    return ir;
  }

  function semanticProblemShape(ir) {
    return {
      schema: ir.schema,
      subject: ir.subject,
      questionType: ir.questionType,
      prompt: comparableText(ir.prompt),
      math: comparableText(ir.math),
      tables: ir.tables,
      constraints: ir.constraints,
      targets: ir.targets.map((target) => ({
        kind: target.kind,
        role: target.role,
        label: target.label,
        options: [...target.options].sort(),
        items: [...target.items].sort(),
        graphDescription: target.graphDescription,
      })).sort((left, right) => safeStringify(left).localeCompare(safeStringify(right))),
      passageFingerprint: ir.passage?.fingerprint || null,
    };
  }

  function numberValue(raw) {
    const value = String(raw || "").replace(/,/g, "").trim();
    if (/^-?\d+(?:\.\d+)?\s*\/\s*-?\d+(?:\.\d+)?$/.test(value)) {
      const [left, right] = value.split("/").map(Number);
      return right ? left / right : NaN;
    }
    return Number(value.replace(/%$/, ""));
  }

  function gcdInteger(left, right) {
    let a = Math.abs(Math.trunc(left));
    let b = Math.abs(Math.trunc(right));
    while (b) [a, b] = [b, a % b];
    return a;
  }

  function formatCalculatedNumber(value, constraints = {}) {
    if (!Number.isFinite(value)) return "";
    const rounding = constraints.rounding || "";
    const place = /tenth/i.test(rounding) ? 1 : /hundredth/i.test(rounding) ? 2 : /thousandth/i.test(rounding) ? 3 : null;
    if (place !== null) return value.toFixed(place);
    if (Math.abs(value - Math.round(value)) < 1e-10) return String(Math.round(value));
    return String(Number(value.toPrecision(12)));
  }

  function tokenizeArithmetic(expression) {
    const source = String(expression || "").replace(/[×·]/g, "*").replace(/÷/g, "/").replace(/[−–—]/g, "-").replace(/\s+/g, "");
    const tokens = source.match(/\d+(?:\.\d+)?|[()+\-*/^]/g) || [];
    if (tokens.join("") !== source) return null;
    return tokens;
  }

  function evaluateArithmetic(expression) {
    const tokens = tokenizeArithmetic(expression);
    if (!tokens?.length) return NaN;
    let index = 0;
    const primary = () => {
      if (tokens[index] === "(") {
        index += 1;
        const value = addSub();
        if (tokens[index] !== ")") throw new Error("missing parenthesis");
        index += 1;
        return value;
      }
      const token = tokens[index++];
      if (!/^\d/.test(token || "")) throw new Error("number expected");
      return Number(token);
    };
    const unary = () => tokens[index] === "+" ? (index += 1, unary()) : tokens[index] === "-" ? (index += 1, -unary()) : primary();
    const power = () => { let value = unary(); if (tokens[index] === "^") { index += 1; value **= power(); } return value; };
    const mulDiv = () => { let value = power(); while (["*", "/"].includes(tokens[index])) { const op = tokens[index++]; const right = power(); value = op === "*" ? value * right : value / right; } return value; };
    const addSub = () => { let value = mulDiv(); while (["+", "-"].includes(tokens[index])) { const op = tokens[index++]; const right = mulDiv(); value = op === "+" ? value + right : value - right; } return value; };
    try { const result = addSub(); return index === tokens.length && Number.isFinite(result) ? result : NaN; } catch (_error) { return NaN; }
  }

  function semanticSolution(finalAnswer, explanation, options = {}) {
    const values = Array.isArray(options.answerValues) && options.answerValues.length ? options.answerValues.map(String) : [String(finalAnswer)];
    return {
      finalAnswer: String(finalAnswer),
      answerValues: values,
      answerBindings: Array.isArray(options.answerBindings) ? options.answerBindings : [],
      explanation: String(explanation || ""),
      confidence: Math.max(0, Math.min(1, Number(options.confidence ?? 0.99))),
      evidence: Array.isArray(options.evidence) ? options.evidence : [],
      graphObjects: Array.isArray(options.graphObjects) ? options.graphObjects : [],
      source: options.source || "deterministic-math",
      verification: options.verification || "deterministic-recalculation",
    };
  }

  function solveWordProblemDeterministically(ir) {
    const text = ir.prompt.replace(/,/g, "");
    const constraints = ir.constraints;
    let match;
    // Constant-rate distance/time and unit-price problems, including a second requested amount.
    match = text.match(/(?:travels?|drives?|runs?|walks?|cycles?|moves?)\s+(\d+(?:\.\d+)?)\s+\w+\s+in\s+(\d+(?:\.\d+)?)\s+\w+[\s\S]*?(?:in|for)\s+(\d+(?:\.\d+)?)\s+(?:hours?|minutes?|seconds?)/i);
    if (match && /same (?:rate|speed)|constant (?:rate|speed)|how (?:far|many)/i.test(text)) {
      const [distance, time, requested] = match.slice(1).map(Number);
      const result = distance / time * requested;
      return semanticSolution(formatCalculatedNumber(result, constraints), `${distance} ÷ ${time} gives the constant rate; multiplying by ${requested} gives ${formatCalculatedNumber(result, constraints)}.`, { source: "word-problem:constant-rate" });
    }
    match = text.match(/(\d+(?:\.\d+)?)\s+(?:items?|tickets?|pounds?|ounces?|books?|gallons?)\s+(?:cost|for)\s+\$?(\d+(?:\.\d+)?)[\s\S]*?(\d+(?:\.\d+)?)\s+(?:items?|tickets?|pounds?|ounces?|books?|gallons?)/i);
    if (match && /how much|cost/i.test(text)) {
      const [count, cost, requested] = match.slice(1).map(Number);
      const result = cost / count * requested;
      return semanticSolution(formatCalculatedNumber(result, constraints), `The unit price is ${cost} ÷ ${count}; for ${requested}, the total is ${formatCalculatedNumber(result, constraints)}.`, { source: "word-problem:unit-price" });
    }
    match = text.match(/(?:rectangle|rectangular)[\s\S]{0,80}?(?:length|long)\s*(?:is|of|=)?\s*(\d+(?:\.\d+)?)[\s\S]{0,80}?(?:width|wide)\s*(?:is|of|=)?\s*(\d+(?:\.\d+)?)/i)
      || text.match(/(?:rectangle|rectangular)[\s\S]{0,80}?(\d+(?:\.\d+)?)\s*(?:by|×|x)\s*(\d+(?:\.\d+)?)/i);
    if (match) {
      const length = Number(match[1]); const width = Number(match[2]);
      if (/perimeter/i.test(text)) return semanticSolution(formatCalculatedNumber(2 * (length + width), constraints), `Perimeter = 2(${length} + ${width}).`, { source: "word-problem:rectangle-perimeter" });
      if (/area|square (?:feet|inches|yards|meters|centimeters)/i.test(text)) return semanticSolution(formatCalculatedNumber(length * width, constraints), `Area = ${length} × ${width}.`, { source: "word-problem:rectangle-area" });
    }
    match = text.match(/(\d+(?:\.\d+)?)\s*(?:percent|%)\s+of\s+(\d+(?:\.\d+)?)/i);
    if (match) {
      const result = Number(match[1]) / 100 * Number(match[2]);
      return semanticSolution(formatCalculatedNumber(result, constraints), `${match[1]}% of ${match[2]} is ${match[1]} ÷ 100 × ${match[2]}.`, { source: "word-problem:percent-of" });
    }
    match = text.match(/(?:ratio of|ratio is)\s*(\d+(?:\.\d+)?)\s*(?::|to)\s*(\d+(?:\.\d+)?)[\s\S]*?(?:if|when)[\s\S]*?(\d+(?:\.\d+)?)/i);
    if (match && /how many|find|what/i.test(text)) {
      const [a, b, known] = match.slice(1).map(Number);
      const result = known * b / a;
      return semanticSolution(formatCalculatedNumber(result, constraints), `Use the proportion ${a}:${b}; ${known} × ${b} ÷ ${a} = ${formatCalculatedNumber(result, constraints)}.`, { source: "word-problem:ratio" });
    }
    return null;
  }

  function solveDeterministicMath(ir) {
    if (!config.deterministicMath || ir.subject === "reading-language-arts" || ir.visualDependency) return null;
    const text = ir.prompt.replace(/,/g, "");
    const constraints = ir.constraints;
    let match;
    match = text.match(/factor\s+(-?\d+)\s*\+\s*(-?\d+)[\s\S]*?gcf/i);
    if (match) {
      const a = Number(match[1]); const b = Number(match[2]); const g = gcdInteger(a, b);
      return semanticSolution(`${g}(${a / g}+${b / g})`, `The GCF of ${a} and ${b} is ${g}; divide both terms by ${g}.`, { source: "deterministic:gcf-factor" });
    }
    match = text.match(/(?:greatest common factor|gcf)\D{0,30}?(\d+)\D+(\d+)/i);
    if (match) return semanticSolution(String(gcdInteger(Number(match[1]), Number(match[2]))), "Computed with the Euclidean algorithm.", { source: "deterministic:gcf" });
    match = text.match(/(?:least common multiple|lcm)\D{0,30}?(\d+)\D+(\d+)/i);
    if (match) {
      const a = Number(match[1]); const b = Number(match[2]);
      return semanticSolution(String(Math.abs(a * b) / gcdInteger(a, b)), "LCM = |a × b| ÷ GCF(a,b).", { source: "deterministic:lcm" });
    }
    match = text.match(/(-?\d+(?:\.\d+)?)\s*%\s+of\s+(-?\d+(?:\.\d+)?)/i);
    if (match) {
      const value = Number(match[1]) / 100 * Number(match[2]);
      return semanticSolution(formatCalculatedNumber(value, constraints), `${match[1]} ÷ 100 × ${match[2]} = ${formatCalculatedNumber(value, constraints)}.`, { source: "deterministic:percent" });
    }
    match = text.match(/slope[\s\S]{0,100}?\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)[\s\S]{0,80}?\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/i);
    if (match) {
      const [x1, y1, x2, y2] = match.slice(1).map(Number); const value = (y2 - y1) / (x2 - x1);
      return semanticSolution(formatCalculatedNumber(value, constraints), `Slope = (${y2} − ${y1}) ÷ (${x2} − ${x1}).`, { source: "deterministic:slope" });
    }
    match = text.match(/(?:solve|find\s+[a-z])[^.!?]*?(-?\d*(?:\.\d+)?)\s*([a-z])\s*([+-]\s*\d+(?:\.\d+)?)?\s*=\s*(-?\d+(?:\.\d+)?)/i);
    if (match && !/[a-z]\s*[+-][^=]*[a-z]/i.test(match[0])) {
      const a = match[1] === "" || match[1] === "+" ? 1 : match[1] === "-" ? -1 : Number(match[1]);
      const b = Number(String(match[3] || "0").replace(/\s/g, "")); const c = Number(match[4]);
      if (a) {
        const value = (c - b) / a;
        return semanticSolution(formatCalculatedNumber(value, constraints), `Subtract ${b} and divide by ${a}; ${match[2]} = ${formatCalculatedNumber(value, constraints)}.`, { source: "deterministic:linear-equation" });
      }
    }
    if (ir.tables.length === 1 && ir.tables[0].length >= 3 && ir.tables[0].every((row) => row.length >= 2)) {
      const rows = ir.tables[0].map((row) => row.slice(0, 2).map((cell) => numberValue(cell.text))).filter((row) => row.every(Number.isFinite));
      if (rows.length >= 3 && /linear or nonlinear|is (?:the )?function linear/i.test(text)) {
        const slopes = rows.slice(1).map((row, index) => (row[1] - rows[index][1]) / (row[0] - rows[index][0]));
        const linear = slopes.every((slope) => Number.isFinite(slope) && Math.abs(slope - slopes[0]) < 1e-9);
        return semanticSolution(linear ? "linear" : "nonlinear", linear ? "The rate of change is constant between every pair of rows." : "The rate of change is not constant between the rows.", { source: "deterministic:table-linearity" });
      }
    }
    const wordProblem = solveWordProblemDeterministically(ir);
    if (wordProblem) return wordProblem;
    match = text.match(/(?:evaluate|calculate|what is|find the value of)\s+([\d\s()+\-×÷*/^·.]+)(?:[?=]|$)/i);
    if (match) {
      const value = evaluateArithmetic(match[1]);
      if (Number.isFinite(value)) return semanticSolution(formatCalculatedNumber(value, constraints), `Evaluated ${match[1].trim()} using the order of operations.`, { source: "deterministic:arithmetic" });
    }
    return null;
  }

  function contentTokens(text) {
    return new Set(comparableText(text).split(/[^a-z0-9']+/).filter((token) => token.length > 2 && !/^(?:the|and|that|this|with|from|what|which|when|where|were|have|has|had|for|are|was)$/.test(token)));
  }

  function bestEvidenceForSolution(solution, ir) {
    if (!ir.passage?.segments?.length) return [];
    const wanted = contentTokens(`${solution.finalAnswer} ${(solution.answerValues || []).join(" ")} ${solution.explanation}`);
    return ir.passage.segments.map((segment) => {
      const tokens = contentTokens(segment.text);
      const overlap = [...wanted].filter((token) => tokens.has(token)).length;
      return { segment, overlap };
    }).filter((entry) => entry.overlap > 0).sort((left, right) => right.overlap - left.overlap).slice(0, 3)
      .map(({ segment }) => ({ segmentId: segment.id, quote: segment.text.slice(0, 240) }));
  }

  function verifyReadingEvidence(solution, ir) {
    if (!config.evidenceVerification || !ir.passage?.segments?.length) return solution;
    const byId = new Map(ir.passage.segments.map((segment) => [segment.id, segment]));
    let evidence = (solution.evidence || []).filter((item) => {
      const segment = byId.get(String(item.segmentId || item.id || ""));
      if (!segment) return false;
      const quote = comparableText(item.quote || "");
      return !quote || comparableText(segment.text).includes(quote) || quote.includes(comparableText(segment.text));
    }).map((item) => ({ segmentId: String(item.segmentId || item.id), quote: String(item.quote || byId.get(String(item.segmentId || item.id))?.text || "").slice(0, 240) }));
    if (!evidence.length) evidence = bestEvidenceForSolution(solution, ir);
    const passageDependent = /according to|passage|article|story|poem|author|character|evidence|best supports|main idea|theme|text/i.test(ir.prompt);
    if (passageDependent && !evidence.length) throw Object.assign(new Error("Reading answer did not include evidence from the bound article; retrying instead of guessing."), { retryableAi: true });
    return { ...solution, evidence, confidence: passageDependent ? Math.min(solution.confidence, evidence.length ? 0.98 : 0.55) : solution.confidence };
  }

  function planActionsFromSemanticSolution(solution, context) {
    const values = [...new Set([...(solution.answerValues || []), solution.finalAnswer].map((value) => comparableText(value)).filter(Boolean))];
    const actions = [];
    const used = new Set();
    const choiceTargets = context.descriptors.filter((target) => ["choice", "single-choice", "multi-choice", "grid-cell"].includes(target.kind));
    for (const value of values) {
      const match = choiceTargets.find((target) => !used.has(target.target) && comparableText(target.label) === value);
      if (match) { actions.push({ type: match.kind === "multi-choice" ? "toggle" : "click", target: match.target, value: match.kind === "multi-choice" ? true : match.label, optionIndex: null }); used.add(match.target); }
    }
    if (!actions.length) {
      const textTargets = context.descriptors.filter((target) => target.kind === "text");
      const bindings = Array.isArray(solution.answerBindings) ? solution.answerBindings : [];
      const boundTargets = new Set();
      for (const binding of bindings) {
        const roleTokens = contentTokens(binding.role || "");
        const ranked = textTargets.filter((target) => !boundTargets.has(target.target)).map((target) => {
          const descriptorIndex = Number(target.target);
          const targetRole = targetRoleForIr(target, descriptorIndex, context);
          const targetTokens = contentTokens(targetRole);
          return { target, score: [...roleTokens].filter((token) => targetTokens.has(token)).length + (comparableText(targetRole) === comparableText(binding.role) ? 10 : 0) };
        }).sort((left, right) => right.score - left.score);
        if (ranked[0]?.score > 0 && (!ranked[1] || ranked[0].score > ranked[1].score)) {
          actions.push({ type: "fill", target: ranked[0].target.target, value: String(binding.value), optionIndex: null });
          boundTargets.add(ranked[0].target.target);
        }
      }
      if (!actions.length) {
        const fillValues = solution.answerValues?.length === textTargets.length ? solution.answerValues : textTargets.length === 1 ? [solution.finalAnswer] : [];
        fillValues.forEach((value, index) => actions.push({ type: "fill", target: textTargets[index].target, value: String(value), optionIndex: null }));
      }
    }
    if (!actions.length) {
      for (const descriptor of context.descriptors.filter((target) => target.kind === "dropdown")) {
        const value = values.find((candidate) => descriptor.options?.some((option) => comparableText(option.text) === candidate));
        if (value) actions.push({ type: "choose", target: descriptor.target, value, optionIndex: null });
      }
    }
    if (!actions.length && solution.graphObjects?.length) {
      const graphTarget = context.descriptors.find((target) => target.kind === "graph");
      if (graphTarget) solution.graphObjects.forEach((object) => {
        if (object.type === "point") actions.push({ type: "graph-point", target: graphTarget.target, value: `${object.x},${object.y}`, optionIndex: null });
        else if (["line", "segment", "ray", "path"].includes(object.type) && Array.isArray(object.points)) actions.push({ type: "graph-path", target: graphTarget.target, value: object.points.map((point) => `${point.x},${point.y}`).join(";"), optionIndex: null });
      });
    }
    return { actions, finalAnswer: solution.finalAnswer, explanation: solution.explanation, confidence: solution.confidence, semanticSolution: solution };
  }

  function adaptiveDebugReportForContext(context, extra = {}) {
    const passage = context.readingPassage || {};
    return {
      generatedAt: new Date().toISOString(),
      url: location.href,
      solverProfile: context.solverProfile || config.subjectMode || "adaptive",
      detectedSubject: context.detectedSubject || context.subject,
      subject: context.subject,
      questionType: context.questionType,
      root: {
        tag: context.root?.tagName || null,
        id: context.root?.id || null,
        className: String(context.root?.className?.baseVal ?? context.root?.className ?? "").slice(0, 500),
      },
      questionCharacters: context.questionText?.length || 0,
      passage: {
        status: passage.text ? "bound" : (passage.ambiguity ? "blocked-ambiguous" : "not-needed-or-not-found"),
        activityKey: passage.activityKey || null,
        fingerprint: passage.fingerprint || null,
        title: passage.title || null,
        characters: passage.text?.length || 0,
        source: passage.source || null,
        sourceUrl: passage.sourceUrl || null,
        currentPage: Boolean(passage.currentPage),
        ambiguity: passage.ambiguity || null,
      },
      targets: context.descriptors.map((target, index) => ({
        index,
        kind: target.kind,
        label: target.label || null,
        inputType: target.inputType || null,
        optionCount: target.options?.length || 0,
        itemCount: target.items?.length || 0,
        graphDescription: target.graphDescription || null,
        graphWidget: target.graphWidget || null,
      })),
      domEvidence: context.domEvidence,
      screenshotPolicy: {
        always: Boolean(config.includeScreenshot),
        fallbackEnabled: config.screenshotFallback !== false,
        recommended: Boolean(context.domEvidence?.screenshotRecommended),
        reason: context.domEvidence?.reason || "",
      },
      cache: {
        identitySchema: context.solverProfile === "math-legacy" ? 2 : 4,
        solverProfile: context.solverProfile || "adaptive",
        articleFingerprintIncluded: Boolean(passage.fingerprint),
        supabaseEnabled: Boolean(config.supabaseEnabled),
        supabaseTableStatus: supabaseTableHealth.status,
      },
      autoLoop: {
        active: loopActive,
        state: loopState,
        waitingForNext: loopWaitingForNext,
        retryCount: loopAiRetryCount,
        retryFeedback: loopRetryFeedback || null,
      },
      smartPipeline: {
        deterministicMath: config.deterministicMath !== false,
        evidenceVerification: config.evidenceVerification !== false,
        semanticCache: config.semanticCache !== false,
        learnedWidgetStrategies: Object.keys(readJsonValue(WIDGET_STRATEGY_CACHE_KEY, {})).length,
        savedSolveTraces: (readJsonValue(SOLVE_ATTEMPT_CACHE_KEY, []) || []).length,
        problemIR: lastProblemIR ? {
          schema: lastProblemIR.schema,
          subject: lastProblemIR.subject,
          questionType: lastProblemIR.questionType,
          quantityCount: lastProblemIR.quantities?.length || 0,
          constraints: lastProblemIR.constraints,
          evidenceSegmentCount: lastProblemIR.passage?.segments?.length || 0,
          targetKinds: lastProblemIR.targets?.map((target) => target.kind) || [],
        } : null,
      },
      ...extra,
    };
  }

  function updateAdaptiveDebugger(context, extra = {}) {
    if (!context) return;
    lastDebugReport = adaptiveDebugReportForContext(context, extra);
    if (ui?.debugReport) ui.debugReport.textContent = JSON.stringify(lastDebugReport, null, 2);
  }

  function runAdaptiveDebugScan() {
    const root = findQuestionRoot();
    const targets = root ? collectTargets(root) : [];
    if (!root || !targets.length) {
      const standalonePassage = rememberStandaloneReadingContext();
      lastDebugReport = {
        generatedAt: new Date().toISOString(),
        url: location.href,
        state: standalonePassage?.text ? "reading-passage-page" : "no-supported-question",
        passage: standalonePassage ? {
          fingerprint: standalonePassage.fingerprint || null,
          title: standalonePassage.title || null,
          characters: standalonePassage.text.length,
          source: standalonePassage.source,
        } : null,
        issue: standalonePassage?.text ? "Passage saved; waiting for its question page." : "No visible supported answer targets were detected.",
      };
      if (ui?.debugReport) ui.debugReport.textContent = JSON.stringify(lastDebugReport, null, 2);
      return null;
    }
    const context = makeContext(root, targets);
    lastContext = context;
    updateAdaptiveDebugger(context, { state: "question-ready" });
    return context;
  }

  function clearAdaptiveDebugHighlights() {
    for (const element of debugHighlightElements) {
      element?.classList?.remove("iah-debug-root-highlight", "iah-debug-target-highlight", "iah-debug-passage-highlight");
    }
    debugHighlightElements = [];
  }

  function toggleAdaptiveDebugHighlights() {
    if (debugHighlightElements.length) {
      clearAdaptiveDebugHighlights();
      return;
    }
    const context = lastContext?.root?.isConnected ? lastContext : runAdaptiveDebugScan();
    if (!context) return;
    context.root.classList.add("iah-debug-root-highlight");
    debugHighlightElements.push(context.root);
    for (const target of context.targets) {
      target.classList.add("iah-debug-target-highlight");
      debugHighlightElements.push(target);
    }
    if (context.readingPassage?.element?.isConnected) {
      context.readingPassage.element.classList.add("iah-debug-passage-highlight");
      debugHighlightElements.push(context.readingPassage.element);
    }
    context.root.scrollIntoView({ block: "center", inline: "nearest" });
  }

  async function copyAdaptiveDebugReport() {
    if (!lastDebugReport) runAdaptiveDebugScan();
    const report = JSON.stringify(lastDebugReport || { state: "no-report" }, null, 2);
    try {
      await navigator.clipboard.writeText(report);
    } catch (_error) {
      const textarea = document.createElement("textarea");
      textarea.value = report;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setStatus("Adaptive debugger report copied. It contains no API keys.", "success");
  }

  function rememberStandaloneReadingContext() {
    if (config.subjectMode === "math-legacy") return null;
    const root = querySelectorAllDeep('main, [role="main"], article')
      .filter((element) => isVisible(element) && !element.closest(`#${PANEL_ID}`))
      .sort((left, right) => normalizedText(right).length - normalizedText(left).length)[0];
    if (!root) return null;
    const pageText = normalizedText(root).slice(0, 30000);
    const page = questionPageContext(root);
    const readingEvidence = `${location.pathname} ${(page.breadcrumbs || []).join(" ")} ${page.heading} ${pageText.slice(0, 2500)}`;
    if (!likelyReadingCue(readingEvidence) && !/language arts|\bela\b|english/i.test(readingEvidence)) return null;
    const passage = extractReadingPassage(root, [], pageText);
    return passage?.text ? passage : null;
  }

  function findReadingPageAdvanceButton() {
    return querySelectorAllDeep('button, a, [role="button"], input[type="button"], input[type="submit"]')
      .filter((element) => isVisible(element) && !element.disabled && element.getAttribute("aria-disabled") !== "true" && !element.closest(`#${PANEL_ID}`))
      .find((element) => /^(?:next|continue|start questions?|answer questions?|begin questions?|go to questions?)$/i.test(normalizedAdvanceLabel(element)));
  }

  function handleReadingNavigationHandoff(event) {
    const control = event.target?.closest?.('button, a, [role="button"], input[type="button"], input[type="submit"]');
    if (!control || control.closest(`#${PANEL_ID}`)
      || !/^(?:next|continue|start questions?|answer questions?|begin questions?|go to questions?)$/i.test(normalizedAdvanceLabel(control))) return;
    const passage = rememberStandaloneReadingContext();
    if (passage?.text) {
      armReadingPageHandoff(passage);
      log("Armed a fingerprinted reading handoff for the next IXL page.", { fingerprint: passage.fingerprint, from: passage.sourceUrl });
    }
  }

  async function advanceStandaloneReadingPageIfReady() {
    const passage = rememberStandaloneReadingContext();
    if (!passage?.text) return false;
    updateAdaptiveDebugger({
      root: passage.element || document.querySelector("main") || document.body,
      targets: [],
      descriptors: [],
      questionText: "",
      readingPassage: passage,
      subject: "reading-language-arts",
      questionType: "passage-page",
      domEvidence: { score: 100, issues: [], screenshotRecommended: false, reason: "The article was extracted directly from the DOM." },
    }, { state: "passage-saved-waiting-for-question-page" });
    const advance = findReadingPageAdvanceButton();
    if (!advance || loopNextClicked) {
      setStatus(`Reading article saved as ${passage.fingerprint}. Waiting for its question page…`, "success");
      return true;
    }
    loopNextClicked = true;
    armReadingPageHandoff(passage);
    setStatus(`Reading article saved as ${passage.fingerprint}. Advancing to its questions…`, "success");
    log("Saved a fingerprinted reading article before leaving its separate passage page.", { fingerprint: passage.fingerprint, title: passage.title, nextLabel: getAccessibleName(advance) });
    const advanced = await activateNextQuestionButton(advance);
    if (!advanced) loopNextClicked = false;
    return true;
  }

  function cacheTargetSignature(context) {
    return context.descriptors.map((target, index) => ({
      kind: target.kind,
      label: comparableText(target.label),
      inputType: target.inputType || null,
      options: target.options?.map((option) => comparableText(option.text)) || null,
      items: target.items?.map((item) => comparableText(item.label || item.text)) || null,
      graphDescription: comparableText(target.graphDescription || "") || null,
      contextText: targetSemanticContext(context.targets[index], context.root, target.kind),
      domPath: stableTargetPath(context.targets[index], context.root),
    }));
  }

  function targetSemanticContext(element, root, kind = "") {
    if (!element || !root || ["choice", "single-choice", "multi-choice", "grid-cell"].includes(kind)) return "";
    const pieces = [];
    const add = (value) => {
      const clean = comparableText(value).slice(0, 350);
      if (clean && !UTILITY_BUTTON_RE.test(clean) && !pieces.includes(clean)) pieces.push(clean);
    };
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      for (const id of labelledBy.split(/\s+/)) add(document.getElementById(id)?.textContent || "");
    }
    const describedBy = element.getAttribute("aria-describedby");
    if (describedBy) {
      for (const id of describedBy.split(/\s+/)) add(document.getElementById(id)?.textContent || "");
    }
    const closestLabel = element.closest("label");
    if (closestLabel && root.contains(closestLabel)) add(normalizedText(closestLabel));
    if (element.id) {
      try { document.querySelectorAll(`label[for="${CSS.escape(element.id)}"]`).forEach((label) => add(normalizedText(label))); } catch (_error) { /* Ignore an invalid generated id. */ }
    }
    let current = element;
    for (let depth = 0; current?.parentElement && current !== root && depth < 4; depth += 1, current = current.parentElement) {
      const siblings = [...current.parentElement.children];
      const index = siblings.indexOf(current);
      for (const offset of [-2, -1, 1, 2]) {
        const sibling = siblings[index + offset];
        if (sibling && !sibling.matches?.(ANSWER_SELECTOR) && !sibling.querySelector?.(ANSWER_SELECTOR)) add(normalizedText(sibling));
      }
      const directText = [...current.parentElement.childNodes]
        .filter((node) => node.nodeType === Node.TEXT_NODE)
        .map((node) => node.textContent || "")
        .join(" ");
      add(directText);
    }
    return pieces.sort().join(" | ").slice(0, 1200);
  }

  function canonicalTargetShape(target = {}) {
    const sorted = (values) => Array.isArray(values) ? values.map(comparableText).filter(Boolean).sort() : [];
    return {
      kind: comparableText(target.kind),
      label: comparableText(target.label),
      inputType: comparableText(target.inputType || ""),
      options: sorted(target.options),
      items: sorted(target.items),
      graphDescription: comparableText(target.graphDescription || ""),
      contextText: comparableText(target.contextText || ""),
    };
  }

  function canonicalTargetSet(signature) {
    return (signature || []).map(canonicalTargetShape).sort((left, right) => safeStringify(left).localeCompare(safeStringify(right)));
  }

  function stableTargetPath(element, root) {
    if (!element) return "";
    const parts = [];
    let current = element;
    for (let depth = 0; current && current !== root && depth < 9; depth += 1, current = current.parentElement) {
      const siblings = current.parentElement ? [...current.parentElement.children].filter((sibling) => sibling.tagName === current.tagName) : [current];
      const position = Math.max(0, siblings.indexOf(current)) + 1;
      const role = current.getAttribute("role");
      const type = current.getAttribute("type");
      parts.unshift(`${current.tagName.toLowerCase()}${role ? `[role=${role}]` : ""}${type ? `[type=${type}]` : ""}:nth(${position})`);
    }
    return parts.join(">");
  }

  function stableSvgSignature(svg) {
    const clone = svg.cloneNode(true);
    clone.querySelectorAll("title, desc").forEach((node) => {
      node.textContent = comparableText(node.textContent);
    });
    clone.querySelectorAll("*").forEach((element) => {
      for (const attribute of [...element.attributes]) {
        if (/^(?:id|class|style|data-|aria-describedby)/i.test(attribute.name)) element.removeAttribute(attribute.name);
      }
    });
    for (const attribute of [...clone.attributes]) {
      if (/^(?:id|class|style|data-|aria-describedby)/i.test(attribute.name)) clone.removeAttribute(attribute.name);
    }
    return clone.outerHTML.replace(/\s+/g, " ").slice(0, 12000);
  }

  function nodePathFromRoot(node, root) {
    const path = [];
    let current = node;
    while (current && current !== root) {
      const parent = current.parentNode;
      if (!parent) return null;
      path.unshift([...parent.childNodes].indexOf(current));
      current = parent;
    }
    return current === root ? path : null;
  }

  function nodeAtClonePath(cloneRoot, path) {
    let current = cloneRoot;
    for (const index of path || []) {
      current = current?.childNodes?.[index];
      if (!current) return null;
    }
    return current;
  }

  function targetNeutralQuestionClone(context) {
    const clone = context.root.cloneNode(true);
    const replacements = [];
    const removals = [];
    for (const target of context.targets) {
      let replacement = target;
      const wrappingLabel = target.closest("label");
      if (wrappingLabel && context.root.contains(wrappingLabel) && context.targets.filter((candidate) => wrappingLabel.contains(candidate)).length === 1) replacement = wrappingLabel;
      const replacementPath = nodePathFromRoot(replacement, context.root);
      if (replacementPath) replacements.push(replacementPath);
      if (target.id) {
        try {
          for (const label of context.root.querySelectorAll(`label[for="${CSS.escape(target.id)}"]`)) {
            if (label !== replacement) {
              const labelPath = nodePathFromRoot(label, context.root);
              if (labelPath) removals.push(labelPath);
            }
          }
        } catch (_error) { /* Ignore an invalid generated id. */ }
      }
    }
    const replacementNodes = replacements.map((path) => nodeAtClonePath(clone, path)).filter(Boolean);
    const removalNodes = removals.map((path) => nodeAtClonePath(clone, path)).filter(Boolean);
    for (const node of replacementNodes) {
      if (!node.isConnected && node !== clone && !clone.contains(node)) continue;
      node.replaceWith(document.createTextNode(" [answer-control] "));
    }
    for (const node of removalNodes) {
      if (node.isConnected || clone.contains(node)) node.remove();
    }
    clone.querySelectorAll(`script, style, link, noscript, iframe, #${PANEL_ID}`).forEach((node) => node.remove());
    clone.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]').forEach((element) => {
      const label = comparableText(element.getAttribute("aria-label") || element.getAttribute("value") || normalizedText(element));
      if (UTILITY_BUTTON_RE.test(label)) element.remove();
    });
    return clone;
  }

  function canonicalQuestionMarkup(root) {
    const clone = root.cloneNode(true);
    clone.querySelectorAll(`script, style, link, noscript, iframe, #${PANEL_ID}`).forEach((node) => node.remove());
    clone.querySelectorAll('button, input[type="submit"], [role="button"]').forEach((element) => {
      if (UTILITY_BUTTON_RE.test(getAccessibleName(element))) element.remove();
    });
    for (const element of [clone, ...clone.querySelectorAll("*")]) {
      for (const attribute of [...element.attributes]) {
        const name = attribute.name.toLowerCase();
        if (["id", "class", "style", "value", "checked", "selected", "tabindex", "aria-checked", "aria-selected", "aria-pressed", "aria-describedby", "aria-controls"].includes(name)
          || (/^data-/i.test(name) && !["data-cy", "data-testid", "data-latex"].includes(name))
          || /^on/i.test(name)) element.removeAttribute(attribute.name);
      }
      if (element.tagName === "IMG" && element.getAttribute("src")) {
        try { element.setAttribute("src", new URL(element.getAttribute("src"), location.href).pathname); } catch (_error) { /* Keep the original source. */ }
      }
    }
    return clone.outerHTML.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ").trim().slice(0, 60000);
  }

  function extractTableDetails(root) {
    return [...root.querySelectorAll("table")].slice(0, 20).map((table) => [...table.rows].map((row) => [...row.cells].map((cell) => ({
      tag: cell.tagName.toLowerCase(),
      text: comparableText(normalizedText(cell)),
      rowSpan: Number(cell.rowSpan) || 1,
      colSpan: Number(cell.colSpan) || 1,
      scope: cell.getAttribute("scope") || null,
    }))));
  }

  function questionPageContext(root) {
    const breadcrumbs = [...document.querySelectorAll('nav a, [aria-label*="breadcrumb" i] a, [class*="breadcrumb" i] a')]
      .filter((element) => isVisible(element) && !root.contains(element))
      .map((element) => comparableText(getAccessibleName(element)))
      .filter(Boolean)
      .slice(-12);
    const heading = [...document.querySelectorAll("h1, h2")]
      .filter((element) => isVisible(element) && !root.contains(element) && !element.closest(`#${PANEL_ID}`))
      .map((element) => comparableText(normalizedText(element)))
      .find(Boolean) || "";
    return { path: location.pathname, breadcrumbs, heading };
  }

  function makeQuestionIdentityDetails(context) {
    const neutral = targetNeutralQuestionClone(context);
    const targetSignature = cacheTargetSignature(context);
    const canvases = [...context.root.querySelectorAll("canvas")]
      .map((canvas) => ({ signature: canvasSignature(canvas), width: canvas.width, height: canvas.height }))
      .filter((entry) => entry.signature)
      .sort((left, right) => safeStringify(left).localeCompare(safeStringify(right)));
    const images = [...context.root.querySelectorAll("img")].map((image) => ({
      src: (() => { try { return new URL(image.currentSrc || image.src, location.href).pathname; } catch (_error) { return image.currentSrc || image.src || ""; } })(),
      alt: comparableText(image.alt || image.getAttribute("aria-label") || image.title || ""),
      width: image.naturalWidth || image.width || null,
      height: image.naturalHeight || image.height || null,
    })).sort((left, right) => safeStringify(left).localeCompare(safeStringify(right)));
    const svgs = [...context.root.querySelectorAll("svg")].slice(0, 20)
      .map((svg) => stableSvgSignature(svg))
      .sort();
    return {
      schema: 4,
      page: questionPageContext(context.root),
      subject: context.subject,
      questionType: context.questionType,
      readingArticle: context.readingPassage?.fingerprint ? {
        fingerprint: context.readingPassage.fingerprint,
        title: comparableText(context.readingPassage.title || ""),
        text: comparableText(context.readingPassage.text || ""),
      } : null,
      promptText: comparableText(normalizedText(neutral)),
      math: comparableText(extractMath(neutral)),
      tables: extractTableDetails(neutral),
      targets: canonicalTargetSet(targetSignature),
      canvases,
      images,
      svgs,
    };
  }

  function legacyCacheTargetSignature(context) {
    return cacheTargetSignature(context).map(({ contextText: _contextText, ...target }) => target);
  }

  function makeLegacyQuestionDetails(context) {
    const canvases = [...context.root.querySelectorAll("canvas")].map((canvas, index) => ({ index, signature: canvasSignature(canvas), width: canvas.width, height: canvas.height })).filter((entry) => entry.signature);
    const images = [...context.root.querySelectorAll("img")].map((image, index) => ({
      index,
      src: (() => { try { return new URL(image.currentSrc || image.src, location.href).pathname; } catch (_error) { return image.currentSrc || image.src || ""; } })(),
      alt: comparableText(image.alt || image.getAttribute("aria-label") || image.title || ""),
      width: image.naturalWidth || image.width || null,
      height: image.naturalHeight || image.height || null,
    }));
    const svgs = [...context.root.querySelectorAll("svg")].slice(0, 20).map((svg, index) => ({ index, signature: stableSvgSignature(svg) }));
    return {
      schema: 2,
      page: questionPageContext(context.root),
      questionText: comparableText(context.questionText),
      math: comparableText(context.math),
      tables: extractTableDetails(context.root),
      targets: legacyCacheTargetSignature(context),
      canonicalMarkup: canonicalQuestionMarkup(context.root),
      canvases,
      images,
      svgs,
    };
  }

  function makeQuestionDetails(context, identityDetails = makeQuestionIdentityDetails(context)) {
    const canvases = [...context.root.querySelectorAll("canvas")].map((canvas, index) => ({ index, signature: canvasSignature(canvas), width: canvas.width, height: canvas.height })).filter((entry) => entry.signature);
    const images = [...context.root.querySelectorAll("img")].map((image, index) => ({
      index,
      src: (() => { try { return new URL(image.currentSrc || image.src, location.href).pathname; } catch (_error) { return image.currentSrc || image.src || ""; } })(),
      alt: comparableText(image.alt || image.getAttribute("aria-label") || image.title || ""),
      width: image.naturalWidth || image.width || null,
      height: image.naturalHeight || image.height || null,
    }));
    const svgs = [...context.root.querySelectorAll("svg")].slice(0, 20).map((svg, index) => ({ index, signature: stableSvgSignature(svg) }));
    return {
      schema: 4,
      identity: identityDetails,
      page: questionPageContext(context.root),
      solverProfile: context.solverProfile || "adaptive",
      subject: context.subject,
      questionType: context.questionType,
      readingArticle: context.readingPassage?.fingerprint ? {
        activityKey: context.readingPassage.activityKey,
        fingerprint: context.readingPassage.fingerprint,
        title: context.readingPassage.title || "",
        text: context.readingPassage.text || "",
        source: context.readingPassage.source || "",
        sourceUrl: context.readingPassage.sourceUrl || "",
        currentPage: Boolean(context.readingPassage.currentPage),
      } : null,
      questionText: comparableText(context.questionText),
      math: comparableText(context.math),
      tables: extractTableDetails(context.root),
      targets: cacheTargetSignature(context),
      canonicalMarkup: canonicalQuestionMarkup(context.root),
      canvases,
      images,
      svgs,
    };
  }

  function makeQuestionSignature(context) {
    return JSON.stringify(makeQuestionIdentityDetails(context));
  }

  async function sha256Hex(text) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch (_error) {
      let hash = 2166136261;
      for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619) >>> 0;
      return `fnv1a-${hash.toString(16).padStart(8, "0")}-${text.length}`;
    }
  }

  async function identifyQuestion(context, problemIR = buildProblemIR(context)) {
    const identityDetails = makeQuestionIdentityDetails(context);
    const details = { ...makeQuestionDetails(context, identityDetails), problemIR: semanticProblemShape(problemIR) };
    const signature = JSON.stringify(identityDetails);
    const semanticHash = await sha256Hex(JSON.stringify(semanticProblemShape(problemIR)));
    // Schema-2 records predate passage fingerprints. Never consult them for
    // reading/ELA, because identical prompts can belong to different articles.
    const allowLegacy = context.subject !== "reading-language-arts" && !identityDetails.readingArticle;
    const legacySignature = allowLegacy ? JSON.stringify(makeLegacyQuestionDetails(context)) : "";
    const modernHash = await sha256Hex(signature);
    const legacyHash = allowLegacy ? await sha256Hex(legacySignature) : "";
    if (context.solverProfile === "math-legacy" && legacyHash) {
      return {
        hash: legacyHash,
        signature: legacySignature,
        details: { ...makeLegacyQuestionDetails(context), solverProfile: "math-legacy" },
        targetSignature: legacyCacheTargetSignature(context),
        questionText: context.questionText.slice(0, 20000),
        legacyHash,
        legacySignature,
        legacyPrimary: true,
        modernHash,
        modernSignature: signature,
        semanticHash,
        problemIR,
      };
    }
    return {
      hash: modernHash,
      signature,
      details,
      targetSignature: cacheTargetSignature(context),
      questionText: context.questionText.slice(0, 20000),
      legacyHash,
      legacySignature,
      legacyPrimary: false,
      semanticHash,
      problemIR,
    };
  }

  function readLocalAnswerCache() {
    try {
      let cache = GM_getValue(ANSWER_CACHE_KEY, {}) || {};
      if (typeof cache === "string") cache = JSON.parse(cache);
      return cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
    } catch (_error) {
      return {};
    }
  }

  function saveLocalAnswerRecord(record) {
    if (!config.localAnswerCache) return;
    const cache = readLocalAnswerCache();
    cache[record.question_hash] = record;
    const entries = Object.entries(cache).sort((left, right) => Number(right[1]?.last_verified_ms || 0) - Number(left[1]?.last_verified_ms || 0));
    GM_setValue(ANSWER_CACHE_KEY, Object.fromEntries(entries.slice(0, ANSWER_CACHE_LIMIT)));
  }

  function deleteLocalAnswerRecord(questionHash) {
    const cache = readLocalAnswerCache();
    if (!(questionHash in cache)) return;
    delete cache[questionHash];
    GM_setValue(ANSWER_CACHE_KEY, cache);
  }

  function validSupabaseSettings() {
    if (!config.supabaseEnabled) return false;
    if (!/^https:\/\/[^/]+/i.test(config.supabaseUrl || "")) return false;
    if (!config.supabasePublishableKey || isUnsafeSupabaseKey(config.supabasePublishableKey)) return false;
    return /^[a-z_][a-z0-9_]*$/i.test(config.supabaseTable || "");
  }

  function isUnsafeSupabaseKey(key) {
    if (/^sb_secret_/i.test(key || "")) return true;
    const parts = String(key || "").split(".");
    if (parts.length !== 3) return false;
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=")));
      return comparableText(payload.role) === "service_role";
    } catch (_error) {
      return false;
    }
  }

  function updateSupabaseTableHealthUi() {
    if (!ui?.cacheTableStatus) return;
    const status = supabaseTableHealth.status;
    ui.cacheTableStatus.classList.remove("success", "error", "warning");
    if (status === "ready") ui.cacheTableStatus.classList.add("success");
    else if (["missing", "access-error", "invalid"].includes(status)) ui.cacheTableStatus.classList.add("error");
    else if (["unavailable", "checking"].includes(status)) ui.cacheTableStatus.classList.add("warning");
    ui.cacheTableStatus.textContent = `Supabase table: ${supabaseTableHealth.message}`;
  }

  function describeSupabaseTableError(error) {
    let payload = null;
    try { payload = JSON.parse(error?.responseText || ""); } catch (_error) { /* Use the status/message fallback. */ }
    const code = String(payload?.code || "").toUpperCase();
    const detail = `${payload?.message || ""} ${payload?.details || ""} ${payload?.hint || ""} ${error?.message || ""}`;
    const missing = ["42P01", "PGRST205"].includes(code)
      || /(?:could not find|unknown|undefined|missing)[^.]{0,80}(?:table|relation)|relation[^.]{0,80}does not exist|schema cache[^.]{0,100}(?:table|relation)/i.test(detail);
    if (missing) {
      return {
        status: "missing",
        message: `public.${config.supabaseTable} was not found or is not exposed through the Data API. Local caching remains available.`,
      };
    }
    if ([401, 403].includes(Number(error?.status)) || code === "42501") {
      return {
        status: "access-error",
        message: `public.${config.supabaseTable} could not be verified because the publishable key or table grants were rejected (${error?.status || code}).`,
      };
    }
    if (["PGRST000", "PGRST001", "PGRST002", "PGRST003"].includes(code) || Number(error?.status) >= 500) {
      return {
        status: "unavailable",
        message: `the Supabase Data API is temporarily unavailable${code ? ` (${code})` : ""}; it will be checked again automatically.`,
      };
    }
    return {
      status: "unavailable",
      message: `could not be checked${error?.status ? ` (HTTP ${error.status})` : ""}; local caching remains available.`,
    };
  }

  async function checkSupabaseCacheTable(options = {}) {
    const { force = false, announce = false } = options;
    if (!config.supabaseEnabled) {
      supabaseTableHealth = { status: "disabled", checkedAt: Date.now(), message: "sync is disabled; local caching is active." };
      updateSupabaseTableHealthUi();
      return false;
    }
    if (!validSupabaseSettings()) {
      supabaseTableHealth = { status: "invalid", checkedAt: Date.now(), message: "settings are incomplete or use an unsafe key." };
      updateSupabaseTableHealthUi();
      if (announce) setStatus("Supabase table check failed: configure an HTTPS project URL, a publishable/anon key, and a valid table name.", "error");
      return false;
    }
    const age = Date.now() - Number(supabaseTableHealth.checkedAt || 0);
    const freshFor = supabaseTableHealth.status === "ready" ? 5 * 60 * 1000 : 60 * 1000;
    if (!force && supabaseTableHealth.status !== "unknown" && age < freshFor) return supabaseTableHealth.status === "ready";

    supabaseTableHealth = { status: "checking", checkedAt: Date.now(), message: `checking public.${config.supabaseTable}…` };
    updateSupabaseTableHealthUi();
    try {
      await supabaseRestRequest("GET", "?select=question_hash&limit=1");
      await supabaseRestRequest("GET", "?select=widget_signature&limit=1", null, "", "ixl_widget_strategies");
      await supabaseRestRequest("GET", "?select=attempt_id&limit=1", null, "", "ixl_solve_attempts");
      supabaseTableHealth = { status: "ready", checkedAt: Date.now(), message: `answer memory, widget learning, and solve diagnostics tables detected and reachable.` };
      updateSupabaseTableHealthUi();
      log("Supabase answer-cache table detected through the Data API.", { table: `public.${config.supabaseTable}` });
      if (announce) setStatus(`All three Supabase v14 tables exist and are reachable.`, "success");
      return true;
    } catch (error) {
      const described = describeSupabaseTableError(error);
      supabaseTableHealth = { ...described, checkedAt: Date.now() };
      updateSupabaseTableHealthUi();
      log("Supabase answer-cache table check failed; local cache fallback remains active.", { table: `public.${config.supabaseTable}`, status: described.status, message: described.message });
      if (announce || described.status === "missing") setStatus(`Supabase table check: ${described.message}`, described.status === "unavailable" ? "" : "error");
      return false;
    }
  }

  async function ensureSupabaseCacheTableAvailable() {
    return checkSupabaseCacheTable({ force: false, announce: false });
  }

  function supabaseRestRequest(method, query, body = null, prefer = "", table = config.supabaseTable) {
    return new Promise((resolve, reject) => {
      if (!validSupabaseSettings()) {
        reject(new Error("Supabase cache settings are incomplete or unsafe. Use a publishable/anon key, never a secret key."));
        return;
      }
      const headers = {
        apikey: config.supabasePublishableKey,
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-ixl-cache-namespace": config.supabaseNamespace,
      };
      if (prefer) headers.Prefer = prefer;
      GM_xmlhttpRequest({
        method,
        url: `${config.supabaseUrl.replace(/\/$/, "")}/rest/v1/${table}${query || ""}`,
        headers,
        data: body === null ? undefined : JSON.stringify(body),
        timeout: 15000,
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            if (!response.responseText) resolve(null);
            else {
              try { resolve(JSON.parse(response.responseText)); } catch (_error) { resolve(response.responseText); }
            }
            return;
          }
          const error = new Error(`Supabase cache request failed (${response.status}).`);
          error.status = response.status;
          error.responseText = response.responseText;
          reject(error);
        },
        ontimeout: () => reject(new Error("Supabase cache request timed out.")),
        onerror: () => reject(new Error("Could not reach the Supabase answer cache.")),
      });
    });
  }

  async function readSupabaseAnswerRecord(questionHash) {
    if (!validSupabaseSettings()) return null;
    if (!(await ensureSupabaseCacheTableAvailable())) return null;
    const filter = `?cache_namespace=eq.${encodeURIComponent(config.supabaseNamespace)}&question_hash=eq.${encodeURIComponent(questionHash)}&select=question_hash,semantic_hash,question_signature,question_text,question_details,target_signature,answer_json,answer_details,answer_source,cache_status,failure_count,provenance,verified_count,created_at,last_verified_at&limit=1`;
    try {
      const rows = await supabaseRestRequest("GET", filter);
      return Array.isArray(rows) ? rows[0] || null : null;
    } catch (error) {
      log("Supabase cache lookup failed; continuing with the local cache/API.", error.message || String(error));
      return null;
    }
  }

  async function writeSupabaseAnswerRecord(record) {
    if (!validSupabaseSettings()) return false;
    if (!(await ensureSupabaseCacheTableAvailable())) return false;
    const payload = {
      cache_namespace: config.supabaseNamespace,
      question_hash: record.question_hash,
      semantic_hash: record.semantic_hash || record.question_hash,
      question_signature: record.question_signature,
      question_text: record.question_text,
      question_details: record.question_details || {},
      target_signature: record.target_signature,
      answer_json: record.answer_json,
      answer_details: record.answer_details || {},
      answer_source: record.answer_source,
      cache_status: record.cache_status || "active",
      failure_count: Math.max(0, Number(record.failure_count) || 0),
      provenance: record.provenance || {},
      verified_count: Math.max(1, Number(record.verified_count) || 1),
      last_verified_at: new Date().toISOString(),
    };
    try {
      await supabaseRestRequest("POST", "?on_conflict=cache_namespace,question_hash", payload, "resolution=merge-duplicates,return=minimal");
      return true;
    } catch (error) {
      log("Supabase cache save failed; the local cache was still updated.", error.message || String(error));
      return false;
    }
  }

  async function deleteSupabaseAnswerRecord(questionHash) {
    if (!validSupabaseSettings()) return;
    if (!(await ensureSupabaseCacheTableAvailable())) return;
    const filter = `?cache_namespace=eq.${encodeURIComponent(config.supabaseNamespace)}&question_hash=eq.${encodeURIComponent(questionHash)}`;
    try { await supabaseRestRequest("DELETE", filter, null, "return=minimal"); } catch (error) { log("Could not remove an invalid Supabase cache entry.", error.message || String(error)); }
  }

  function sameCanonicalTargetSet(left, right) {
    return safeStringify(canonicalTargetSet(left)) === safeStringify(canonicalTargetSet(right));
  }

  function targetMatchScore(saved, current, action = {}) {
    const choiceKinds = new Set(["choice", "single-choice", "multi-choice", "grid-cell"]);
    const savedKind = comparableText(action.targetKind || saved?.kind || "");
    const currentKind = comparableText(current?.kind || "");
    if (savedKind && currentKind && savedKind !== currentKind && !(choiceKinds.has(savedKind) && choiceKinds.has(currentKind))) return -Infinity;
    let score = savedKind && currentKind ? 10 : 0;
    const savedLabel = comparableText(action.targetLabel || saved?.label || "");
    const currentLabel = comparableText(current?.label || "");
    if (savedLabel && currentLabel) {
      if (savedLabel === currentLabel) score += 30;
      else if (savedLabel.includes(currentLabel) || currentLabel.includes(savedLabel)) score += 8;
      else if (choiceKinds.has(savedKind || currentKind)) return -Infinity;
    }
    const actionValue = comparableText(action.value || "");
    if (choiceKinds.has(currentKind) && actionValue && !["true", "false"].includes(actionValue)) {
      if (actionValue === currentLabel) score += 50;
      else if (currentLabel.includes(actionValue) || actionValue.includes(currentLabel)) score += 12;
    }
    const savedContext = comparableText(action.targetContextText || saved?.contextText || "");
    const currentContext = comparableText(current?.contextText || "");
    if (savedContext && currentContext) {
      if (savedContext === currentContext) score += 24;
      else if (savedContext.includes(currentContext) || currentContext.includes(savedContext)) score += 6;
    }
    const listKey = (values) => safeStringify((values || []).map(comparableText).filter(Boolean).sort());
    if ((saved?.options?.length || action.targetOptions?.length) && listKey(action.targetOptions || saved.options) === listKey(current.options)) score += 14;
    if ((saved?.items?.length || action.targetItems?.length) && listKey(action.targetItems || saved.items) === listKey(current.items)) score += 14;
    const savedGraph = comparableText(action.targetGraphDescription || saved?.graphDescription || "");
    const currentGraph = comparableText(current?.graphDescription || "");
    if (savedGraph && savedGraph === currentGraph) score += 18;
    if (saved?.inputType && comparableText(saved.inputType) === comparableText(current?.inputType || "")) score += 3;
    if ((action.targetDomPath || saved?.domPath) && (action.targetDomPath || saved.domPath) === current?.domPath) score += 1;
    return score;
  }

  function bestSemanticTargetIndex(saved, currentSignature, action, used, allowUsed = false) {
    const ranked = currentSignature
      .map((current, index) => ({ index, score: (!allowUsed && used.has(index)) ? -Infinity : targetMatchScore(saved, current, action) }))
      .filter((entry) => Number.isFinite(entry.score))
      .sort((left, right) => right.score - left.score);
    if (!ranked.length || ranked[0].score < 1) return null;
    if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
    return ranked[0].index;
  }

  function remapCachedAnswerActions(record, answer, context) {
    const savedSignature = Array.isArray(record.target_signature) ? record.target_signature : [];
    const currentSignature = cacheTargetSignature(context);
    if (!sameCanonicalTargetSet(savedSignature, currentSignature)) return null;
    const used = new Set();
    const mappedTargets = new Map();
    const remapped = [];
    for (const originalAction of answer.actions) {
      const action = { ...originalAction };
      const oldIndex = Number(action.target);
      const saved = savedSignature[oldIndex] || {
        kind: action.targetKind,
        label: action.targetLabel,
        contextText: action.targetContextText,
        options: action.targetOptions,
        items: action.targetItems,
        graphDescription: action.targetGraphDescription,
        domPath: action.targetDomPath,
      };
      let newIndex = mappedTargets.get(oldIndex);
      if (!Number.isInteger(newIndex)) {
        newIndex = bestSemanticTargetIndex(saved, currentSignature, action, used);
        if (!Number.isInteger(newIndex)) return null;
        mappedTargets.set(oldIndex, newIndex);
        used.add(newIndex);
      }
      action.target = newIndex;

      if (actionType(action) === "drag" && Number.isInteger(Number(action.optionIndex))) {
        const oldDestination = Number(action.optionIndex);
        let newDestination = mappedTargets.get(oldDestination);
        if (!Number.isInteger(newDestination)) {
          const savedDestination = savedSignature[oldDestination] || {
            kind: action.destinationTargetKind,
            label: action.destinationTargetLabel,
            contextText: action.destinationTargetContextText,
            domPath: action.destinationTargetDomPath,
          };
          const destinationHint = {
            targetKind: action.destinationTargetKind,
            targetLabel: action.destinationTargetLabel,
            targetContextText: action.destinationTargetContextText,
            targetDomPath: action.destinationTargetDomPath,
          };
          newDestination = bestSemanticTargetIndex(savedDestination, currentSignature, destinationHint, used);
          if (!Number.isInteger(newDestination)) return null;
          mappedTargets.set(oldDestination, newDestination);
          used.add(newDestination);
        }
        action.optionIndex = newDestination;
      }

      if (actionType(action) === "reorder" && Array.isArray(action.orderedItemLabels) && action.orderedItemLabels.length) {
        const currentItems = currentSignature[newIndex]?.items || [];
        const remaining = currentItems.map((label, index) => ({ label: comparableText(label), index, used: false }));
        const desired = [];
        for (const label of action.orderedItemLabels.map(comparableText)) {
          const match = remaining.find((entry) => !entry.used && entry.label === label);
          if (!match) return null;
          match.used = true;
          desired.push(match.index);
        }
        if (desired.length !== currentItems.length) return null;
        action.value = desired.join(",");
      }
      remapped.push(action);
    }
    return { ...answer, actions: remapped };
  }

  function answerFromCacheRecord(record, context) {
    if (!record || record.cache_status === "quarantined" || Number(record.failure_count || 0) >= 2 || record.question_signature !== makeQuestionSignature(context)) return null;
    let answer;
    try { answer = parseAnswerJson(JSON.stringify(record.answer_json), context); } catch (_error) { return null; }
    if (!answer.actions.length) return null;
    answer = remapCachedAnswerActions(record, answer, context);
    if (!answer) return null;
    const allowed = new Set(["fill", "click", "choose", "toggle", "set-slider", "reorder", "drag", "graph-point", "graph-path", "click-relative", "drag-relative", "press"]);
    if (!answer.actions.every((action) => allowed.has(actionType(action)) && resolveActionElement(action, context))) return null;
    answer.confidence = 1;
    answer.explanation = `Reused an exact ${record.answer_source === "ixl-correction" ? "IXL-confirmed correction" : "IXL-accepted answer"} from the answer cache. No AI API request was used.`;
    return answer;
  }

  function answerFromLegacyCacheRecord(record, identity, context) {
    if (!record || record.question_signature !== identity.legacySignature) return null;
    if (safeStringify(record.target_signature) !== safeStringify(legacyCacheTargetSignature(context))) return null;
    let answer;
    try { answer = parseAnswerJson(JSON.stringify(record.answer_json), context); } catch (_error) { return null; }
    if (!answer.actions.length) return null;
    const allowed = new Set(["fill", "click", "choose", "toggle", "set-slider", "reorder", "drag", "graph-point", "graph-path", "click-relative", "drag-relative", "press"]);
    if (!answer.actions.every((action) => allowed.has(actionType(action)) && resolveActionElement(action, context))) return null;
    answer.confidence = 1;
    answer.explanation = `Reused a legacy ${record.answer_source === "ixl-correction" ? "IXL-confirmed correction" : "IXL-accepted answer"}; IXL acceptance will migrate it to the new order-independent cache format.`;
    return answer;
  }

  async function lookupAnswerCache(identity, context) {
    const localCache = config.localAnswerCache ? readLocalAnswerCache() : {};
    if (identity.legacyPrimary) {
      if (config.localAnswerCache) {
        const legacyLocal = localCache[identity.hash];
        const legacyAnswer = answerFromLegacyCacheRecord(legacyLocal, identity, context);
        if (legacyAnswer) return { answer: legacyAnswer, record: legacyLocal, location: "legacy math local" };
        if (legacyLocal) deleteLocalAnswerRecord(identity.hash);
        const modernLocal = identity.modernHash ? localCache[identity.modernHash] : null;
        const modernAnswer = answerFromCacheRecord(modernLocal, context);
        if (modernAnswer) return { answer: modernAnswer, record: modernLocal, location: "modern local fallback" };
      }
      const legacyRemote = await readSupabaseAnswerRecord(identity.hash);
      const legacyRemoteAnswer = answerFromLegacyCacheRecord(legacyRemote, identity, context);
      if (legacyRemoteAnswer) {
        const normalizedLegacy = { ...legacyRemote, last_verified_ms: Date.now() };
        saveLocalAnswerRecord(normalizedLegacy);
        return { answer: legacyRemoteAnswer, record: normalizedLegacy, location: "legacy math Supabase" };
      }
      if (identity.modernHash) {
        const modernRemote = await readSupabaseAnswerRecord(identity.modernHash);
        const modernRemoteAnswer = answerFromCacheRecord(modernRemote, context);
        if (modernRemoteAnswer) {
          const normalizedModern = { ...modernRemote, last_verified_ms: Date.now() };
          saveLocalAnswerRecord(normalizedModern);
          return { answer: modernRemoteAnswer, record: normalizedModern, location: "modern Supabase fallback" };
        }
      }
      return null;
    }
    if (config.localAnswerCache) {
      const local = localCache[identity.hash];
      const answer = answerFromCacheRecord(local, context);
      if (answer) return { answer, record: local, location: "local" };
      if (local) deleteLocalAnswerRecord(identity.hash);
      if (identity.legacyHash && identity.legacyHash !== identity.hash) {
        const legacyLocal = localCache[identity.legacyHash];
        const legacyAnswer = answerFromLegacyCacheRecord(legacyLocal, identity, context);
        if (legacyAnswer) return { answer: legacyAnswer, record: legacyLocal, location: "legacy local", legacyMigration: true };
      }
    }
    const remote = await readSupabaseAnswerRecord(identity.hash);
    const answer = answerFromCacheRecord(remote, context);
    if (answer) {
      const normalized = { ...remote, last_verified_ms: Date.now() };
      saveLocalAnswerRecord(normalized);
      return { answer, record: normalized, location: "Supabase" };
    }
    if (identity.legacyHash && identity.legacyHash !== identity.hash) {
      const legacyRemote = await readSupabaseAnswerRecord(identity.legacyHash);
      const legacyAnswer = answerFromLegacyCacheRecord(legacyRemote, identity, context);
      if (legacyAnswer) {
        const normalizedLegacy = { ...legacyRemote, last_verified_ms: Date.now() };
        saveLocalAnswerRecord(normalizedLegacy);
        return { answer: legacyAnswer, record: normalizedLegacy, location: "legacy Supabase", legacyMigration: true };
      }
    }
    return null;
  }

  function semanticSolutionFromCacheRecord(record, identity) {
    if (!record || record.cache_status === "quarantined" || Number(record.failure_count || 0) >= 2 || record.semantic_hash !== identity.semanticHash) return null;
    const solution = record.answer_details?.semanticSolution;
    if (!solution || typeof solution !== "object") return null;
    const expectedArticle = identity.problemIR?.passage?.fingerprint || null;
    const savedArticle = record.answer_details?.articleFingerprint || record.provenance?.articleFingerprint || null;
    if (expectedArticle !== savedArticle) return null;
    try { return parseSemanticSolution(JSON.stringify(solution)); } catch (_error) { return null; }
  }

  async function lookupSemanticAnswerCache(identity) {
    if (!config.semanticCache || !identity.semanticHash) return null;
    if (config.localAnswerCache) {
      const record = Object.values(readLocalAnswerCache()).find((candidate) => candidate?.semantic_hash === identity.semanticHash && candidate.question_hash !== identity.hash);
      const solution = semanticSolutionFromCacheRecord(record, identity);
      if (solution) return { solution, record, location: "semantic local candidate" };
    }
    if (!validSupabaseSettings() || !(await ensureSupabaseCacheTableAvailable())) return null;
    try {
      const query = `?cache_namespace=eq.${encodeURIComponent(config.supabaseNamespace)}&semantic_hash=eq.${encodeURIComponent(identity.semanticHash)}&cache_status=eq.active&failure_count=lt.2&select=question_hash,semantic_hash,question_signature,question_text,question_details,target_signature,answer_json,answer_details,answer_source,cache_status,failure_count,provenance,verified_count,created_at,last_verified_at&order=verified_count.desc&limit=3`;
      const rows = await supabaseRestRequest("GET", query);
      for (const record of Array.isArray(rows) ? rows : []) {
        if (record.question_hash === identity.hash) continue;
        const solution = semanticSolutionFromCacheRecord(record, identity);
        if (solution) { saveLocalAnswerRecord({ ...record, last_verified_ms: Date.now() }); return { solution, record, location: "semantic Supabase candidate" }; }
      }
    } catch (error) { log("Semantic Supabase lookup failed; continuing with an exact solve.", error.message || String(error)); }
    return null;
  }

  function makeAnswerCacheRecord(identity, answer, source = "ixl-accepted", priorVerifiedCount = 0) {
    const savedAt = new Date().toISOString();
    return {
      question_hash: identity.hash,
      semantic_hash: identity.semanticHash || identity.hash,
      question_signature: identity.signature,
      question_text: identity.questionText,
      question_details: identity.details || {},
      target_signature: identity.targetSignature,
      answer_json: {
        actions: answer.actions.map((action) => {
          const target = identity.targetSignature[Number(action.target)] || {};
          const destination = actionType(action) === "drag" ? identity.targetSignature[Number(action.optionIndex)] || {} : {};
          let orderedItemLabels;
          if (actionType(action) === "reorder" && Array.isArray(target.items)) {
            const desired = String(action.value ?? "").split(/[|,;\s]+/).filter(Boolean).map(Number);
            if (desired.length === target.items.length && desired.every((index) => Number.isInteger(index) && target.items[index] !== undefined)) {
              orderedItemLabels = desired.map((index) => target.items[index]);
            }
          }
          return {
            ...action,
            targetKind: target.kind || null,
            targetLabel: target.label || null,
            targetContextText: target.contextText || null,
            targetOptions: target.options || null,
            targetItems: target.items || null,
            targetGraphDescription: target.graphDescription || null,
            targetDomPath: target.domPath || null,
            destinationTargetKind: destination.kind || null,
            destinationTargetLabel: destination.label || null,
            destinationTargetContextText: destination.contextText || null,
            destinationTargetDomPath: destination.domPath || null,
            orderedItemLabels,
          };
        }),
        finalAnswer: answer.finalAnswer,
        explanation: answer.explanation,
        confidence: 1,
        acceptedAlternatives: Array.isArray(answer.acceptedAlternatives) ? answer.acceptedAlternatives : undefined,
      },
      answer_source: source,
      cache_status: "active",
      failure_count: 0,
      provenance: {
        scriptVersion: "14.0.0",
        solverSource: answer.semanticSolution?.source || (source === "ixl-correction" ? "ixl-correction" : "semantic-ai"),
        solverModel: source === "ixl-correction" ? null : (lastSolveProvider?.model || config.model),
        verifier: answer.semanticSolution?.verification || (config.verifyBeforeSubmit ? "legacy-action-verifier" : "disabled"),
        ixlConfirmation: source,
        articleFingerprint: identity.problemIR?.passage?.fingerprint || identity.details?.readingArticle?.fingerprint || null,
        savedAt,
      },
      answer_details: {
        schema: 3,
        solverProfile: identity.details?.solverProfile || (identity.legacyPrimary ? "math-legacy" : "adaptive"),
        subject: identity.details?.subject || "general-academic",
        questionType: identity.details?.questionType || "constructed-response",
        articleFingerprint: identity.details?.readingArticle?.fingerprint || null,
        articleTitle: identity.details?.readingArticle?.title || null,
        articleSourceUrl: identity.details?.readingArticle?.sourceUrl || null,
        actionCount: answer.actions.length,
        actionTypes: answer.actions.map(actionType),
        acceptedAlternatives: Array.isArray(answer.acceptedAlternatives) ? answer.acceptedAlternatives : [],
        finalAnswer: answer.finalAnswer,
        confirmation: source,
        semanticSolution: answer.semanticSolution || {
          finalAnswer: answer.finalAnswer,
          answerValues: answer.actions.map((action) => String(action.value ?? "")).filter(Boolean),
          explanation: answer.explanation,
          confidence: 1,
          evidence: [],
          graphObjects: [],
          source,
        },
        evidence: answer.semanticSolution?.evidence || [],
        model: source === "ixl-correction" ? null : (lastSolveProvider?.model || config.model),
        providerProfile: source === "ixl-correction" ? null : (lastSolveProvider?.kind || "cache-or-primary"),
        endpointOrigin: source === "ixl-correction" ? null : (() => { try { return new URL(lastSolveProvider?.endpoint || config.endpoint).origin; } catch (_error) { return ""; } })(),
        savedAt,
      },
      verified_count: Math.max(1, Number(priorVerifiedCount) + 1),
      last_verified_ms: Date.now(),
    };
  }

  async function saveConfirmedAnswer(identity, answer, source = "ixl-accepted", priorVerifiedCount = 0) {
    const record = makeAnswerCacheRecord(identity, answer, source, priorVerifiedCount);
    saveLocalAnswerRecord(record);
    const remoteSaved = await writeSupabaseAnswerRecord(record);
    log("Saved confirmed answer for exact reuse.", { questionHash: identity.hash, source, local: Boolean(config.localAnswerCache), supabase: remoteSaved, actions: answer.actions.length });
    return record;
  }

  async function invalidateCachedAnswer(questionHash, reason = "IXL controls or feedback rejected the cached answer") {
    const local = readLocalAnswerCache();
    const record = local[questionHash];
    if (record) {
      record.failure_count = Math.max(1, Number(record.failure_count || 0) + 1);
      record.cache_status = "quarantined";
      record.provenance = { ...(record.provenance || {}), lastFailure: reason, quarantinedAt: new Date().toISOString() };
      saveLocalAnswerRecord(record);
    }
    if (validSupabaseSettings() && await ensureSupabaseCacheTableAvailable()) {
      const filter = `?cache_namespace=eq.${encodeURIComponent(config.supabaseNamespace)}&question_hash=eq.${encodeURIComponent(questionHash)}`;
      try { await supabaseRestRequest("PATCH", filter, { cache_status: "quarantined", failure_count: Math.max(1, Number(record?.failure_count || 1)), provenance: record?.provenance || { lastFailure: reason, quarantinedAt: new Date().toISOString() } }, "return=minimal"); }
      catch (error) { log("Could not quarantine the remote cache entry; local quarantine remains active.", error.message || String(error)); }
    }
  }

  function snapshotTargets(context) {
    return context.targets.map((element, target) => {
      const kind = targetKind(element);
      return {
        target,
        value: "value" in element ? element.value : element.textContent,
        checked: ["single-choice", "multi-choice"].includes(kind) && "checked" in element ? element.checked : null,
        ariaChecked: element.getAttribute("aria-checked"),
        ariaPressed: element.getAttribute("aria-pressed"),
        selectedIndex: element.tagName === "SELECT" ? element.selectedIndex : null,
      };
    });
  }

  function makeSemanticSolvePrompt(ir, provider = primaryApiProvider(), mode = "solve") {
    const localModel = isLoopbackEndpoint(provider.endpoint);
    const compactIr = {
      ...ir,
      passage: ir.passage ? {
        ...ir.passage,
        segments: ir.passage.segments.slice(0, localModel ? 180 : 500),
      } : null,
    };
    return [
      mode === "verify"
        ? "Independently solve and verify this structured academic problem. Do not trust a proposed answer unless it follows from the problem."
        : "Solve this structured academic problem semantically. Do not plan browser clicks and do not refer to target numbers.",
      ir.subject === "mathematics"
        ? "For word problems, identify the requested unknown, preserve units, translate every stated relationship into arithmetic/algebra, compute exactly, then obey the required form and rounding constraints."
        : "For passage-dependent reading questions, use only the bound passage. Cite evidence as segmentId plus a short exact quote. Never use a different article.",
      "Return only JSON with finalAnswer, answerValues, answerBindings, explanation, confidence, evidence, and graphObjects.",
      "answerValues must contain every required blank/selected answer in semantic order. answerBindings must pair stable semantic roles (for example x-coordinate, numerator, first sentence, width) with values so reordered blanks remain safe; use [] when roles do not apply. For multiple correct choices include each chosen label. For graphs, graphObjects must describe points/lines/segments/rays using mathematical coordinates.",
      `Problem IR:\n${JSON.stringify(compactIr, null, localModel ? 0 : 2)}`,
      loopRetryFeedback ? `Previous safe failure to correct: ${loopRetryFeedback.slice(0, 1200)}` : "",
    ].filter(Boolean).join("\n\n");
  }

  function parseSemanticSolution(rawText) {
    const text = String(rawText || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_error) {
      const start = text.indexOf("{"); const end = text.lastIndexOf("}");
      if (start >= 0 && end > start) try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (_nestedError) { parsed = null; }
    }
    if (!parsed || typeof parsed !== "object") throw Object.assign(new Error("The semantic solver returned malformed JSON; retrying."), { retryableAi: true });
    parsed.finalAnswer = String(parsed.finalAnswer ?? parsed.answer ?? "").trim();
    parsed.answerValues = Array.isArray(parsed.answerValues) ? parsed.answerValues.map((value) => String(value).trim()).filter(Boolean) : (parsed.finalAnswer ? [parsed.finalAnswer] : []);
    parsed.answerBindings = Array.isArray(parsed.answerBindings) ? parsed.answerBindings.map((binding) => ({ role: String(binding?.role || "").trim(), value: String(binding?.value ?? "").trim() })).filter((binding) => binding.role && binding.value) : [];
    parsed.explanation = String(parsed.explanation ?? parsed.reasoning ?? "").slice(0, 5000);
    parsed.confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    parsed.evidence = Array.isArray(parsed.evidence) ? parsed.evidence.map((item) => ({ segmentId: String(item?.segmentId ?? item?.id ?? ""), quote: String(item?.quote ?? "").slice(0, 300) })).filter((item) => item.segmentId) : [];
    parsed.graphObjects = Array.isArray(parsed.graphObjects) ? parsed.graphObjects.filter((object) => object && typeof object === "object") : [];
    parsed.source ||= "semantic-ai";
    if (!parsed.finalAnswer && !parsed.answerValues.length && !parsed.graphObjects.length) throw Object.assign(new Error("The semantic solver returned no usable answer; retrying."), { retryableAi: true });
    return parsed;
  }

  function normalizeSemanticAnswer(solution) {
    const values = (solution.answerValues?.length ? solution.answerValues : [solution.finalAnswer]).map((value) => comparableText(value)).filter(Boolean).sort();
    const graph = (solution.graphObjects || []).map((object) => safeStringify(object)).sort();
    const bindings = (solution.answerBindings || []).map((binding) => ({ role: comparableText(binding.role), value: comparableText(binding.value) })).sort((left, right) => safeStringify(left).localeCompare(safeStringify(right)));
    return safeStringify({ values, bindings, graph });
  }

  async function independentlyVerifySemanticSolution(solution, context, ir, imageDataUrl, providerSession) {
    solution = verifyReadingEvidence(solution, ir);
    if (!config.verifyBeforeSubmit) return solution;
    if (solution.source?.startsWith("deterministic:") || solution.source?.startsWith("word-problem:")) {
      const recalculated = solveDeterministicMath(ir);
      if (!recalculated || normalizeSemanticAnswer(recalculated) !== normalizeSemanticAnswer(solution)) throw Object.assign(new Error("Deterministic recalculation disagreed; retrying safely."), { retryableAi: true });
      return { ...solution, confidence: Math.max(solution.confidence, 0.99), verification: "deterministic-recalculation" };
    }
    const verifierModel = config.verifierModel || providerSession.current.model || config.model;
    const prompt = `${makeSemanticSolvePrompt(ir, providerSession.current, "verify")}\n\nProposed answer (use only for comparison after solving independently):\n${JSON.stringify(solution)}`;
    const response = await requestWithUsageFailover(prompt, imageDataUrl, providerSession, verifierModel, "semantic verifier", "semantic");
    const verified = verifyReadingEvidence(parseSemanticSolution(extractResponseText(response)), ir);
    if (normalizeSemanticAnswer(verified) !== normalizeSemanticAnswer(solution)) {
      const error = new Error("The semantic solver and independent verifier disagreed; the loop will retry instead of submitting.");
      error.retryableAi = true;
      throw error;
    }
    return { ...solution, confidence: Math.min(solution.confidence || 0.8, verified.confidence || 0.8), verification: "independent-model-agreement", evidence: solution.evidence?.length ? solution.evidence : verified.evidence };
  }

  function makeActionPlannerPrompt(solution, ir) {
    return [
      "Map the already-solved semantic answer to the current IXL controls. Do not change or re-solve the answer.",
      "Return only the action JSON. Use every necessary action for multiple selections, multiple blanks, multi-step widgets, and graphs.",
      `Semantic answer: ${JSON.stringify(solution)}`,
      `Visible targets: ${JSON.stringify(ir.targets)}`,
      "Allowed actions: fill, click, choose, toggle, set-slider, reorder, drag, graph-point, graph-path, click-relative, drag-relative, press.",
    ].join("\n\n");
  }

  async function planSemanticAnswerActions(solution, context, ir, providerSession) {
    let answer = planActionsFromSemanticSolution(solution, context);
    if (answer.actions.length) return answer;
    const response = await requestWithUsageFailover(makeActionPlannerPrompt(solution, ir), null, providerSession, providerSession.current.model, "UI action planner", "answer");
    answer = parseAnswerJson(extractResponseText(response), context);
    answer.finalAnswer = solution.finalAnswer;
    answer.explanation = solution.explanation;
    answer.confidence = Math.min(solution.confidence, answer.confidence || solution.confidence);
    answer.semanticSolution = solution;
    return answer;
  }

  function makePrompt(context, provider = primaryApiProvider()) {
    const localModel = isLoopbackEndpoint(provider.endpoint);
    const mathLegacy = context.solverProfile === "math-legacy";
    const readingProfile = context.solverProfile === "reading" || context.subject === "reading-language-arts";
    const questionText = context.questionText.slice(0, localModel ? 8000 : 20000);
    const mathText = (context.math || "(none)").slice(0, localModel ? 4000 : 12000);
    const targetsText = localModel
      ? JSON.stringify(context.descriptors)
      : JSON.stringify(context.descriptors, null, 2);
    const htmlText = context.html.slice(0, localModel ? 6000 : 35000);
    const passageText = (context.readingPassage?.text || "").slice(0, localModel ? 10000 : 30000);
    const passageTitle = context.readingPassage?.title || "(untitled)";
    const retryGuidance = loopRetryFeedback
      ? `A previous attempt on this same question failed safely. Re-solve and choose a different valid action/target mapping. Failure details: ${loopRetryFeedback.slice(0, 1200)}`
      : "";
    return [
      mathLegacy
        ? "LEGACY MATH PROFILE: Solve the current IXL mathematics question and return only one JSON object. Prioritize exact arithmetic, algebra, geometry, tables, graphs, and symbolic input formatting."
        : readingProfile
          ? "READING / ELA PROFILE: Solve the current IXL reading or language-arts question and return only one JSON object. Treat the bound passage as the only source for passage-dependent answers."
          : "ADAPTIVE PROFILE: Solve the current IXL academic question and return only one JSON object.",
      `Selected solver profile: ${context.solverProfile || "adaptive"}.`,
      `Detected subject: ${context.subject}. Detected question type: ${context.questionType}.`,
      "Use the answer target list to describe exactly what the page should do.",
      "Never return JavaScript, CSS selectors, markdown fences, or commentary outside JSON.",
      "Action schema:",
      '{"actions":[{"type":"fill|click|choose|toggle|set-slider|reorder|drag|graph-point|graph-path|click-relative|drag-relative|press","target":0,"value":"text/value/instructions","optionIndex":0}],"finalAnswer":"short answer","explanation":"brief solution","confidence":0.0}',
      "Rules:",
      "- fill: text input, textarea, or contenteditable. Create one action per blank.",
      "- For symbolic math inputs, use plain keyboard syntax such as 15(3+5), x^2, or 1/2. Do not use LaTeX commands or markdown.",
      "- click/choose: a visible choice target. Use the exact target number supplied below.",
      "- For every click/choose choice action, also put the exact visible choice label in value. It is used to verify and repair target mapping.",
      "- toggle: checkbox or multi-select target; value must be true or false.",
      "- dropdown: use choose on the dropdown target with value equal to visible option text, plus optionIndex when known.",
      "- set-slider: slider target with the numeric value.",
      "- reorder: an ordering/listbox target. value is the desired comma-separated ORIGINAL item indexes, such as 1,0,2.",
      "- drag: a draggable source target. optionIndex is the destination target number; value may be null.",
      "- graph-point: a graph/application target. value is one coordinate as x,y. Return one action per point.",
      "- graph-path: a graph/application target that needs two or more points for a line, ray, segment, or polygon. value is semicolon-separated coordinates such as -2,1;3,4.",
      "- click-relative: last-resort canvas/application click. value is horizontal,vertical fractions from 0 to 1, measured from the target's top-left.",
      "- drag-relative: last-resort canvas/application drag. value is startX,startY,endX,endY as fractions from 0 to 1.",
      "- Number-line tick marks usually appear as checkbox targets; toggle the exact tick targets instead of using graph-point.",
      "- press: a keyboard-driven widget target. value is comma-separated keys such as ArrowRight,ArrowRight,Enter.",
      "- If several choices are required, return several actions.",
      readingProfile ? "- For reading comprehension, answer only from the supplied article/passage. Keep the author, narrator, speaker, characters, and separately quoted sources distinct." : "",
      readingProfile ? "- Use the exact passage fingerprint as the article boundary. Never import facts or an answer from a different article, even if its question wording looks similar." : "",
      readingProfile ? "- For vocabulary and grammar, preserve the surrounding sentence and choose the answer that fits that exact context." : "",
      "- Never click or return an action for Check, Submit, Next, Done, or another navigation button.",
      "- Do not guess a target number that is not in the list.",
      "- If the UI cannot express the answer, return actions: [] and explain why.",
      retryGuidance,
      "",
      `Page URL: ${location.href}`,
      `Question text:\n${questionText}`,
      mathLegacy ? "" : `Bound reading article fingerprint: ${context.readingPassage?.fingerprint || "none"}`,
      mathLegacy ? "" : `Bound reading article title: ${passageTitle}`,
      mathLegacy ? "" : `Bound reading article text:\n${passageText || "(none securely bound)"}`,
      `Math/accessibility extraction:\n${mathText}`,
      `Answer targets:\n${targetsText}`,
      `Sanitized question HTML:\n${htmlText}`,
    ].join("\n");
  }

  function makeVerificationPrompt(context, candidate, provider = primaryApiProvider()) {
    const mathLegacy = context.solverProfile === "math-legacy";
    const readingProfile = context.solverProfile === "reading" || context.subject === "reading-language-arts";
    return [
      makePrompt(context, provider),
      "",
      "INDEPENDENT VERIFICATION PASS:",
      "The JSON below is another solver's candidate, not a trusted answer.",
      "Re-solve the problem from scratch using the question, bound article/passage, table values, graph, labels, and screenshot.",
      readingProfile ? "For reading questions, verify every claim against the exact bound article fingerprint and do not use another article or outside memory." : "",
      mathLegacy ? "For legacy math, independently recompute the result and check symbolic formatting, every intermediate operation, and every graph coordinate." : "",
      "Check every arithmetic operation and every action-to-control mapping.",
      "For tables, explicitly compare the relevant differences, ratios, or slopes before deciding.",
      "If the candidate is correct, return the same answer as a complete JSON object using the required schema.",
      "If it is wrong, return a corrected complete JSON object. Do not merely critique it.",
      "Lower confidence below 0.75 if any required information is missing or unreadable.",
      `Untrusted candidate:\n${JSON.stringify(candidate)}`,
    ].join("\n");
  }

  function normalizedAnswerValue(value) {
    const text = comparableText(value).replace(/[,$%]/g, "");
    const fraction = text.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)$/);
    if (fraction && Number(fraction[2])) return `number:${Number(fraction[1]) / Number(fraction[2])}`;
    if (/^-?\d+(?:\.\d+)?$/.test(text)) return `number:${Number(text)}`;
    return text;
  }

  function answerMeaningSignature(answer) {
    const actionValues = answer.actions.map((action) => `${actionType(action)}:${normalizedAnswerValue(action.value)}`).join("|");
    return `${normalizedAnswerValue(answer.finalAnswer)}||${actionValues}`;
  }

  function assertModelResponseIsUsable(rawText, phase = "AI") {
    const text = String(rawText || "").trim();
    let parsed = null;
    try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")); } catch (_error) { /* Plain text is checked below. */ }
    const declaredError = parsed && typeof parsed === "object" && !Array.isArray(parsed.actions)
      ? parsed.error || parsed.errors || parsed.failure || parsed.status === "error" && parsed.message
      : null;
    const plainError = /^(?:error|api error|model error|verifier error|verification error|request failed|failed to (?:solve|verify)|unable to (?:solve|verify)|i (?:cannot|can't) (?:solve|verify))\b/i.test(text);
    if (!declaredError && !plainError) return;
    const detail = typeof declaredError === "string" ? declaredError : safeStringify(declaredError || text.slice(0, 500));
    const error = new Error(`${phase} reported an error: ${detail}`);
    error.retryableAi = true;
    throw error;
  }

  async function independentlyVerifyAnswer(candidate, context, imageDataUrl, providerSession = createApiProviderSession()) {
    if (!config.verifyBeforeSubmit) return candidate;
    const verifierModel = providerSession.current.kind === "backup"
      ? providerSession.current.model
      : (config.verifierModel || config.model);
    setStatus(`Independently checking the answer with ${verifierModel}…`);
    log("Starting independent answer verification.", { solverModel: lastSolveProvider?.model || config.model, verifierModel, provider: providerSession.current.label });
    const prompt = makeVerificationPrompt(context, candidate, providerSession.current);
    const response = await requestWithUsageFailover(prompt, imageDataUrl, providerSession, config.verifierModel || config.model, "verifier");
    const raw = extractResponseText(response);
    log("Verifier response received.", raw);
    assertModelResponseIsUsable(raw, "Verifier");
    const verified = parseAnswerJson(raw, context);
    if (!verified.actions.length) throw new Error("The independent verifier could not map a safe answer to the page. Nothing was submitted.");

    const candidateSignature = answerMeaningSignature(candidate);
    const verifierSignature = answerMeaningSignature(verified);
    if (candidateSignature === verifierSignature) {
      verified.confidence = Math.min(Number(candidate.confidence) || 0, Number(verified.confidence) || 0);
      verified.explanation ||= candidate.explanation;
      log("Independent verification agreed with the original answer.", { confidence: verified.confidence });
      return verified;
    }

    log("Independent verification corrected the original answer.", {
      original: candidate.finalAnswer,
      corrected: verified.finalAnswer,
      verifierConfidence: verified.confidence,
    });
    if (verified.confidence < 0.82) {
      throw new Error(`The solver and verifier disagreed (“${candidate.finalAnswer}” vs. “${verified.finalAnswer}”), and verification confidence was only ${Math.round(verified.confidence * 100)}%. Nothing was submitted.`);
    }
    verified.confidence = Math.min(0.92, verified.confidence);
    return verified;
  }

  function isResponsesEndpoint(endpoint) {
    return /\/responses\/?(?:\?|$)/i.test(endpoint);
  }

  function isOfficialOpenAIEndpoint(endpoint) {
    try {
      return new URL(endpoint).hostname.toLowerCase() === "api.openai.com";
    } catch (_error) {
      return false;
    }
  }

  function isLocalOllamaEndpoint(endpoint) {
    try {
      const url = new URL(endpoint);
      return ["127.0.0.1", "localhost", "::1"].includes(url.hostname.toLowerCase())
        && url.port === "11434";
    } catch (_error) {
      return false;
    }
  }

  function isLoopbackEndpoint(endpoint) {
    try { return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(endpoint).hostname.toLowerCase()); } catch (_error) { return false; }
  }

  function isNativeOllamaEndpoint(endpoint) {
    try { return /\/api\/(?:chat|generate)\/?$/i.test(new URL(endpoint).pathname); } catch (_error) { return false; }
  }

  function getOllamaModelCapabilities(provider = primaryApiProvider()) {
    if (!isLocalOllamaEndpoint(provider.endpoint) && !isNativeOllamaEndpoint(provider.endpoint)) {
      return Promise.resolve({ supportsVision: true, capabilities: [], checked: false });
    }
    const cacheKey = `${new URL(provider.endpoint).origin}|${provider.model}`;
    if (ollamaCapabilityCache.has(cacheKey)) return Promise.resolve(ollamaCapabilityCache.get(cacheKey));
    return new Promise((resolve) => {
      const endpoint = `${new URL(provider.endpoint).origin}/api/show`;
      const headers = { "Content-Type": "application/json" };
      if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
      GM_xmlhttpRequest({
        method: "POST",
        url: endpoint,
        headers,
        data: JSON.stringify({ model: provider.model }),
        timeout: 8000,
        onload(response) {
          try {
            const data = JSON.parse(response.responseText);
            const capabilities = Array.isArray(data.capabilities) ? data.capabilities.map((value) => String(value).toLowerCase()) : [];
            const result = {
              supportsVision: response.status >= 200 && response.status < 300 && capabilities.includes("vision"),
              capabilities,
              checked: true,
            };
            ollamaCapabilityCache.set(cacheKey, result);
            resolve(result);
          } catch (_error) {
            resolve({ supportsVision: false, capabilities: [], checked: false });
          }
        },
        ontimeout: () => resolve({ supportsVision: false, capabilities: [], checked: false }),
        onerror: () => resolve({ supportsVision: false, capabilities: [], checked: false }),
      });
    });
  }

  function isAnthropicEndpoint(endpoint) {
    try { return new URL(endpoint).hostname.toLowerCase().endsWith("anthropic.com"); } catch (_error) { return false; }
  }

  function isGeminiEndpoint(endpoint) {
    try { return new URL(endpoint).hostname.toLowerCase().endsWith("googleapis.com"); } catch (_error) { return false; }
  }

  function primaryApiProvider() {
    return { kind: "primary", label: "Primary API", endpoint: config.endpoint || "", apiKey: config.apiKey || "", model: config.model || "" };
  }

  function backupApiProvider() {
    return { kind: "backup", label: "Backup API", endpoint: config.backupEndpoint || "", apiKey: config.backupApiKey || "", model: config.backupModel || "" };
  }

  function apiProviderConfigured(provider, requireEnabled = false) {
    if (!provider?.endpoint || !provider?.model) return false;
    if (requireEnabled && (provider.kind !== "backup" || !config.backupEnabled)) return false;
    return !requiresApiKey(provider.endpoint) || Boolean(provider.apiKey);
  }

  function createApiProviderSession() {
    const primary = primaryApiProvider();
    const backup = backupApiProvider();
    const backupReady = apiProviderConfigured(backup, true);
    const useBackupCooldown = backupReady && primaryUsageLimitedUntil > Date.now() && backupUsageLimitedUntil <= Date.now();
    return { primary, backup, backupReady, current: useBackupCooldown ? backup : primary };
  }

  function effectiveEndpoint(endpoint = config.endpoint, model = config.model) {
    try {
      const url = new URL(endpoint);
      const cleanPath = url.pathname.replace(/\/+$/, "");
      if (isGeminiEndpoint(endpoint) && !/:generateContent$/i.test(cleanPath)) {
        url.pathname = `${cleanPath || "/v1beta"}/models/${encodeURIComponent(model)}:generateContent`;
      } else if (isAnthropicEndpoint(endpoint) && !/\/messages$/i.test(cleanPath)) {
        url.pathname = `${cleanPath || "/v1"}/messages`;
      } else if (/^\/?v1$/i.test(cleanPath) || !cleanPath) {
        url.pathname = `${cleanPath || "/v1"}/chat/completions`;
      }
      return url.toString();
    } catch (_error) {
      return endpoint;
    }
  }

  function requiresApiKey(endpoint) {
    return !isLoopbackEndpoint(endpoint);
  }

  function answerJsonSchema() {
    return {
      type: "object",
      additionalProperties: false,
      required: ["actions", "finalAnswer", "explanation", "confidence"],
      properties: {
        actions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "target", "value", "optionIndex"],
            properties: {
              type: { type: "string", enum: ["fill", "click", "choose", "toggle", "set-slider", "reorder", "drag", "graph-point", "graph-path", "click-relative", "drag-relative", "press"] },
              target: { type: "integer", minimum: 0 },
              value: { type: ["string", "number", "boolean", "null"] },
              optionIndex: { type: ["integer", "null"] },
            },
          },
        },
        finalAnswer: { type: "string" },
        explanation: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    };
  }

  function semanticSolutionJsonSchema() {
    return {
      type: "object",
      additionalProperties: false,
      required: ["finalAnswer", "answerValues", "answerBindings", "explanation", "confidence", "evidence", "graphObjects"],
      properties: {
        finalAnswer: { type: "string" },
        answerValues: { type: "array", items: { type: "string" } },
        answerBindings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["role", "value"],
            properties: { role: { type: "string" }, value: { type: "string" } },
          },
        },
        explanation: { type: "string" },
        confidence: { type: "number", minimum: 0, maximum: 1 },
        evidence: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["segmentId", "quote"],
            properties: { segmentId: { type: "string" }, quote: { type: "string" } },
          },
        },
        graphObjects: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "points", "x", "y"],
            properties: {
              type: { type: "string", enum: ["point", "line", "segment", "ray", "path"] },
              points: { type: "array", items: { type: "object", additionalProperties: false, required: ["x", "y"], properties: { x: { type: "number" }, y: { type: "number" } } } },
              x: { type: ["number", "null"] },
              y: { type: ["number", "null"] },
            },
          },
        },
      },
    };
  }

  function splitDataUrl(imageDataUrl) {
    const match = String(imageDataUrl || "").match(/^data:([^;,]+);base64,(.+)$/s);
    return match ? { mediaType: match[1], base64: match[2] } : null;
  }

  function buildRequest(prompt, imageDataUrl, structured = true, model = config.model, provider = primaryApiProvider(), schemaKind = "answer") {
    const endpoint = provider.endpoint;
    const official = isOfficialOpenAIEndpoint(endpoint);
    const localOllama = isLocalOllamaEndpoint(endpoint);
    const image = splitDataUrl(imageDataUrl);
    const schema = schemaKind === "semantic" ? semanticSolutionJsonSchema() : answerJsonSchema();
    const schemaName = schemaKind === "semantic" ? "ixl_semantic_solution" : "ixl_answer";

    if (isNativeOllamaEndpoint(endpoint)) {
      const nativeGenerate = /\/api\/generate\/?$/i.test(new URL(endpoint).pathname);
      const userMessage = { role: "user", content: prompt };
      if (image) userMessage.images = [image.base64];
      const body = nativeGenerate
        ? {
            model,
            stream: false,
            system: "You are a precise multi-subject academic tutor and UI action planner. Return the requested JSON only.",
            prompt,
            images: image ? [image.base64] : undefined,
            options: { temperature: 0.2, num_predict: 1200 },
          }
        : {
            model,
            stream: false,
            messages: [
              { role: "system", content: "You are a precise multi-subject academic tutor and UI action planner. Return the requested JSON only." },
              userMessage,
            ],
            options: { temperature: 0.2, num_predict: 1200 },
          };
      if (structured) body.format = schema;
      return body;
    }

    if (isAnthropicEndpoint(endpoint)) {
      const content = [{ type: "text", text: prompt }];
      if (image) content.push({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.base64 } });
      return {
        model,
        max_tokens: 1400,
        temperature: 0.2,
        system: "You are a precise multi-subject academic tutor and UI action planner. Return the requested JSON only.",
        messages: [{ role: "user", content }],
      };
    }

    if (isGeminiEndpoint(endpoint)) {
      const parts = [{ text: `You are a precise multi-subject academic tutor and UI action planner. Return the requested JSON only.\n\n${prompt}` }];
      if (image) parts.push({ inlineData: { mimeType: image.mediaType, data: image.base64 } });
      return {
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 1400, responseMimeType: structured ? "application/json" : "text/plain" },
      };
    }

    if (isResponsesEndpoint(endpoint)) {
      const content = [{ type: "input_text", text: prompt }];
      if (imageDataUrl) content.push({ type: "input_image", image_url: imageDataUrl, detail: "high" });
      const body = {
        model,
        instructions: "You are a precise multi-subject academic tutor and UI action planner. Return the requested JSON only.",
        input: [{ role: "user", content }],
      };
      if (official && structured) {
        body.text = { format: { type: "json_schema", name: schemaName, strict: true, schema } };
      }
      return body;
    }

    const userContent = imageDataUrl
      ? [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: imageDataUrl, detail: "high" } }]
      : prompt;
    const body = {
      model,
      messages: [
        { role: "system", content: "You are a precise multi-subject academic tutor and UI action planner. Return the requested JSON only." },
        { role: "user", content: userContent },
      ],
    };
    if (structured && (official || localOllama)) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema },
      };
    }
    if (localOllama) {
      body.temperature = 0.2;
      body.max_tokens = 700;
    } else {
      body.temperature = 0.1;
      body.max_tokens = 1400;
    }
    return body;
  }

  function requestApi(body, provider = primaryApiProvider()) {
    return new Promise((resolve, reject) => {
      const headers = { "Content-Type": "application/json" };
      if (provider.apiKey && isAnthropicEndpoint(provider.endpoint)) {
        headers["x-api-key"] = provider.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else if (provider.apiKey && isGeminiEndpoint(provider.endpoint)) {
        headers["x-goog-api-key"] = provider.apiKey;
      } else if (provider.apiKey) {
        headers.Authorization = `Bearer ${provider.apiKey}`;
      }
      GM_xmlhttpRequest({
        method: "POST",
        url: effectiveEndpoint(provider.endpoint, body?.model || provider.model),
        headers,
        data: JSON.stringify(body),
        timeout: 90000,
        onload(response) {
          let data;
          try {
            data = JSON.parse(response.responseText);
          } catch (_error) {
            const error = new Error(`API returned non-JSON data (HTTP ${response.status}).`);
            error.status = response.status;
            error.responseText = String(response.responseText || "").slice(0, 2000);
            reject(error);
            return;
          }
          if (response.status < 200 || response.status >= 300) {
            const error = new Error(data?.error?.message || data?.error?.status || `API request failed with HTTP ${response.status}.`);
            error.status = response.status;
            error.responseData = data;
            reject(error);
            return;
          }
          resolve(data);
        },
        ontimeout: () => reject(new Error("API request timed out after 90 seconds.")),
        onerror: (error) => reject(new Error(`Network/API request failed: ${safeStringify(error)}`)),
      });
    });
  }

  function isUsageLimitError(error) {
    const status = Number(error?.status);
    if (status === 429 || status === 402) return true;
    const details = `${error?.message || ""} ${safeStringify(error?.responseData || "")} ${error?.responseText || ""}`;
    return /(?:rate[\s_-]*limit|usage[\s_-]*(?:limit|cap)|quota|insufficient[\s_-]*(?:quota|credits?|funds)|credits?[^.]{0,60}(?:exhausted|depleted|used|remaining|balance)|resource[\s_-]*exhausted|too many requests|payment required|billing limit|monthly limit|daily limit|token limit reached)/i.test(details);
  }

  function isRetryableAiError(error, stage = "") {
    if (!error || isUsageLimitError(error)) return false;
    if (error.retryableAi || error.retryableAction) return true;
    const status = Number(error.status);
    if ([408, 425].includes(status) || status >= 500) return true;
    if ([400, 401, 403, 404, 405, 415, 422].includes(status)) return false;
    const details = `${error.message || error.reason || ""} ${error.responseText || ""}`;
    if (/network|timed?\s*out|connection|socket|fetch|non-json|malformed|invalid json|assistant text|model response|provider response|verifier|verification|solver and verifier disagreed|could not map a safe answer/i.test(details)) return true;
    return ["solver", "verifier", "answer-mapping"].includes(stage) && !status;
  }

  function isRetryableTargetError(error, stage = "") {
    if (!error || isUsageLimitError(error)) return false;
    if (error.retryableAction) return true;
    // Once application starts, every DOM/control failure is transient from the
    // auto loop's perspective: IXL may have re-rendered, renumbered, replaced,
    // or not yet committed one of the targets.
    if (stage === "apply") return true;
    const details = `${error.message || error.reason || ""} ${error.responseText || ""}`;
    return /(?:\btarget\s*#?\s*\d+\b|\btarget\b[^.]{0,80}\b(?:failed|missing|unavailable|unmatched|not found|not visible|not confirmed|could not|no longer)\b|\b(?:failed|missing|unavailable|unmatched|not found|not visible|not confirmed|could not|no longer)\b[^.]{0,80}\btarget\b|did not confirm action|answer control|visible control|action\s+\d+\s+on\s+target)/i.test(details);
  }

  function extractResponseText(data) {
    if (typeof data?.output_text === "string") return data.output_text;
    if (typeof data?.message?.content === "string" && data.message.content.trim()) return data.message.content;
    if (typeof data?.message?.thinking === "string" && data.message.thinking.trim()) return data.message.thinking;
    if (typeof data?.response === "string") return data.response;
    if (typeof data?.choices?.[0]?.message?.content === "string" && data.choices[0].message.content.trim()) return data.choices[0].message.content;
    if (typeof data?.choices?.[0]?.message?.reasoning_content === "string") return data.choices[0].message.reasoning_content;
    if (typeof data?.choices?.[0]?.text === "string") return data.choices[0].text;
    if (typeof data?.text === "string") return data.text;
    if (Array.isArray(data?.choices?.[0]?.message?.content)) {
      return data.choices[0].message.content.map((part) => part?.text || part?.content || "").join("");
    }
    if (Array.isArray(data?.output)) {
      return data.output
        .flatMap((item) => item?.content || [])
        .map((part) => part?.text || part?.output_text || "")
        .join("");
    }
    if (Array.isArray(data?.content)) {
      return data.content.map((part) => part?.text || "").join("");
    }
    if (Array.isArray(data?.candidates?.[0]?.content?.parts)) {
      return data.candidates[0].content.parts.map((part) => part?.text || "").join("");
    }
    if (typeof data?.generations?.[0]?.text === "string") return data.generations[0].text;
    throw new Error(data?.error?.message || "The API response did not contain assistant text.");
  }

  async function requestWithCompatibilityFallback(prompt, imageDataUrl, model = config.model, provider = primaryApiProvider(), schemaKind = "answer") {
    const attempts = [
      { structured: true, image: imageDataUrl, label: "configured multimodal request" },
      { structured: false, image: imageDataUrl, label: "prompt-only JSON request" },
      { structured: false, image: null, label: "text-only compatibility request" },
    ];
    const seen = new Set();
    let lastError = null;
    let imageRejected = false;
    for (const attempt of attempts) {
      if (imageRejected && attempt.image) continue;
      const body = buildRequest(prompt, attempt.image, attempt.structured, model, provider, schemaKind);
      const signature = JSON.stringify(body);
      if (seen.has(signature)) continue;
      seen.add(signature);
      try {
        return await requestApi(body, provider);
      } catch (error) {
        lastError = error;
        if (isUsageLimitError(error)) throw error;
        const retryableShapeError = [400, 404, 415, 422].includes(Number(error.status));
        if (!retryableShapeError) throw error;
        const errorText = `${error?.message || ""} ${safeStringify(error?.responseData || "")}`;
        if (attempt.image && /multimodal|vision|image(?:s| data)?[^.]{0,80}(?:unsupported|not supported|does not support)|does not support[^.]{0,80}(?:multimodal|vision|image)/i.test(errorText)) {
          imageRejected = true;
          log("The selected model is text-only; retrying immediately without the screenshot.");
          continue;
        }
        log(`Provider rejected ${attempt.label}; trying a more compatible payload.`, error.message || String(error));
      }
    }
    throw lastError || new Error("All compatible API request formats failed.");
  }

  async function requestWithUsageFailover(prompt, imageDataUrl, providerSession, primaryRequestedModel = "", purpose = "solver", schemaKind = "answer") {
    const session = providerSession || createApiProviderSession();
    let provider = session.current;
    const requestFor = async (selected) => {
      const model = selected.kind === "backup" ? selected.model : (primaryRequestedModel || selected.model);
      if (!apiProviderConfigured(selected)) throw new Error(`${selected.label} endpoint, model, or API key is incomplete.`);
      log(`Sending ${purpose} request through ${selected.label}.`, { endpoint: selected.endpoint, model, hasImage: Boolean(imageDataUrl) });
      const data = await requestWithCompatibilityFallback(prompt, imageDataUrl, model, selected, schemaKind);
      session.current = selected;
      lastSolveProvider = { ...selected, model };
      return data;
    };

    try {
      return await requestFor(provider);
    } catch (error) {
      if (!isUsageLimitError(error)) throw error;
      if (provider.kind === "primary") {
        primaryUsageLimitedUntil = Date.now() + USAGE_RETRY_MS;
        if (session.backupReady && backupUsageLimitedUntil <= Date.now()) {
          provider = session.backup;
          session.current = provider;
          setStatus(`Primary API usage limit reached. Switching immediately to ${provider.label}…`);
          log("Primary API usage limit reached; failing over to the configured backup API.", {
            primaryEndpoint: session.primary.endpoint,
            backupEndpoint: provider.endpoint,
            backupModel: provider.model,
          });
          try {
            return await requestFor(provider);
          } catch (backupError) {
            if (isUsageLimitError(backupError)) {
              backupUsageLimitedUntil = Date.now() + USAGE_RETRY_MS;
              backupError.message = `Primary and backup API usage limits were reached. ${backupError.message || ""}`.trim();
            }
            throw backupError;
          }
        }
      } else {
        backupUsageLimitedUntil = Date.now() + USAGE_RETRY_MS;
      }
      throw error;
    }
  }

  function makeLegacyActions(finalAnswer, context) {
    if (!context) return [];
    const textTargets = context.descriptors.filter((target) => target.kind === "text");
    if (textTargets.length === 1) return [{ type: "fill", target: textTargets[0].target, value: finalAnswer, optionIndex: null }];
    if (textTargets.length > 1) {
      let values = [];
      try {
        const parsed = JSON.parse(finalAnswer);
        if (Array.isArray(parsed)) values = parsed.map(String);
      } catch (_error) {
        values = finalAnswer.split(/\s*(?:\|\||;|\n)\s*/).filter(Boolean);
      }
      if (values.length === textTargets.length) {
        return textTargets.map((target, index) => ({ type: "fill", target: target.target, value: values[index], optionIndex: null }));
      }
    }

    const wanted = finalAnswer.replace(/\s+/g, " ").trim().toLowerCase();
    const choice = context.descriptors.find((target) => ["choice", "single-choice", "grid-cell"].includes(target.kind)
      && target.label.replace(/\s+/g, " ").trim().toLowerCase() === wanted);
    if (choice) return [{ type: "click", target: choice.target, value: null, optionIndex: null }];
    const dropdown = context.descriptors.find((target) => target.kind === "dropdown"
      && target.options?.some((option) => `${option.text}`.replace(/\s+/g, " ").trim().toLowerCase() === wanted));
    if (dropdown) return [{ type: "choose", target: dropdown.target, value: finalAnswer, optionIndex: null }];
    return [];
  }

  function parseAnswerJson(rawText, context = null) {
    const text = String(rawText || "").trim();
    const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(unfenced);
    } catch (_error) {
      const start = unfenced.indexOf("{");
      const end = unfenced.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { parsed = JSON.parse(unfenced.slice(start, end + 1)); } catch (_nestedError) { parsed = null; }
      }
    }

    if (!parsed || typeof parsed !== "object") {
      const answerTag = unfenced.match(/<answer>([\s\S]*?)<\/answer>/i);
      const finalAnswer = (answerTag?.[1] || unfenced).replace(/<[^>]+>/g, "").trim();
      if (!finalAnswer) throw new Error("The model did not return a usable answer.");
      return {
        actions: makeLegacyActions(finalAnswer, context),
        finalAnswer,
        explanation: answerTag ? unfenced.replace(answerTag[0], "").replace(/<[^>]+>/g, "").trim().slice(0, 2000) : "Provider returned a legacy/plain-text answer.",
        confidence: 0.35,
      };
    }
    parsed.finalAnswer ??= parsed.answer ?? parsed.final_answer ?? "";
    parsed.explanation ??= parsed.reasoning ?? parsed.solution ?? "";
    if (!Array.isArray(parsed.actions)) parsed.actions = makeLegacyActions(String(parsed.finalAnswer), context);
    parsed.finalAnswer = String(parsed.finalAnswer ?? "");
    parsed.explanation = String(parsed.explanation ?? "");
    parsed.confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    parsed.actions = parsed.actions
      .filter((action) => action && Number.isInteger(Number(action.target)))
      .map((action) => ({ ...action, target: Number(action.target), optionIndex: action.optionIndex === null || action.optionIndex === undefined ? null : Number(action.optionIndex) }));
    return parsed;
  }

  function setNativeValue(element, value) {
    const stringValue = String(value ?? "");
    if (element.isContentEditable || (element.getAttribute("role") === "textbox" && !(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement))) {
      element.focus();
      element.textContent = stringValue;
    } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      const previousValue = element.value;
      if (setter) setter.call(element, stringValue);
      else element.value = stringValue;
      // React and similar controlled-input frameworks compare against this tracker.
      // Restoring its previous value makes the synthetic input event observable.
      element._valueTracker?.setValue?.(previousValue);
      element.focus();
    } else {
      element.focus?.();
      if ("value" in element) element.value = stringValue;
      else element.setAttribute("aria-valuenow", stringValue);
    }
    try {
      element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: stringValue }));
    } catch (_error) {
      // Older browsers may not construct InputEvent.
    }
    try {
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: stringValue }));
    } catch (_error) {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function isIxlSympadInput(element) {
    return element instanceof HTMLInputElement && (
      element.classList.contains("proxy-input")
      || element.getAttribute("data-testid") === "testing-fill-in"
      || Boolean(element.getAttribute("aria-controls") && element.closest('[class*="sympadfiwidget" i]'))
    );
  }

  function ixlSympadField(element) {
    return element.closest('[class*="sympadfiwidget-content" i]') || element.parentElement?.parentElement || null;
  }

  function renderedSympadText(element) {
    const field = ixlSympadField(element);
    if (!field) return "";
    const clone = field.cloneNode(true);
    clone.querySelectorAll('.secret, .hidden, #symPadCursor, [class*="cursor" i], [aria-live], .sympad-instructions').forEach((node) => node.remove());
    return String(clone.textContent || "").replace(/\s+/g, "").replace(/[−–—]/g, "-");
  }

  function sympadRenderedValueMatches(element, desiredValue) {
    const rendered = renderedSympadText(element).toLowerCase();
    const desired = String(desiredValue ?? "").replace(/\s+/g, "").replace(/[−–—]/g, "-").toLowerCase();
    if (!desired || !rendered) return false;
    if (rendered === desired || rendered.includes(desired)) return true;
    const tokens = desired.match(/[a-z]+|\d+(?:\.\d+)?|[+\-×÷=*()]/g) || [];
    let cursor = 0;
    return tokens.length > 0 && tokens.every((token) => {
      const variants = token === "*" ? ["*", "×", "·"] : token === "/" ? ["/", "÷"] : [token];
      const positions = variants.map((variant) => rendered.indexOf(variant, cursor)).filter((position) => position >= 0);
      if (!positions.length) return token === "/";
      const position = Math.min(...positions);
      cursor = position + token.length;
      return true;
    });
  }

  function keyboardMetadata(rawKey) {
    const key = String(rawKey);
    if (/^\d$/.test(key)) return { key, code: `Digit${key}`, keyCode: 48 + Number(key), shiftKey: false };
    if (/^[a-z]$/i.test(key)) return { key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), shiftKey: key !== key.toLowerCase() };
    const special = {
      "+": { code: "Equal", keyCode: 187, shiftKey: true },
      "=": { code: "Equal", keyCode: 187, shiftKey: false },
      "-": { code: "Minus", keyCode: 189, shiftKey: false },
      "*": { code: "Digit8", keyCode: 56, shiftKey: true },
      "^": { code: "Digit6", keyCode: 54, shiftKey: true },
      "%": { code: "Digit5", keyCode: 53, shiftKey: true },
      "/": { code: "Slash", keyCode: 191, shiftKey: false },
      ".": { code: "Period", keyCode: 190, shiftKey: false },
      ",": { code: "Comma", keyCode: 188, shiftKey: false },
      "(": { code: "Digit9", keyCode: 57, shiftKey: true },
      ")": { code: "Digit0", keyCode: 48, shiftKey: true },
      "[": { code: "BracketLeft", keyCode: 219, shiftKey: false },
      "]": { code: "BracketRight", keyCode: 221, shiftKey: false },
      " ": { code: "Space", keyCode: 32, shiftKey: false },
      Backspace: { code: "Backspace", keyCode: 8, shiftKey: false },
      Delete: { code: "Delete", keyCode: 46, shiftKey: false },
      Enter: { code: "Enter", keyCode: 13, shiftKey: false },
      ArrowLeft: { code: "ArrowLeft", keyCode: 37, shiftKey: false },
      ArrowRight: { code: "ArrowRight", keyCode: 39, shiftKey: false },
    };
    return { key, ...(special[key] || { code: key, keyCode: 0, shiftKey: false }) };
  }

  function dispatchLegacyKeystroke(element, rawKey, modifiers = {}) {
    const metadata = keyboardMetadata(rawKey);
    const baseInit = {
      bubbles: true,
      cancelable: true,
      key: metadata.key,
      code: metadata.code,
      shiftKey: metadata.shiftKey,
      ctrlKey: Boolean(modifiers.ctrlKey),
      altKey: Boolean(modifiers.altKey),
      metaKey: Boolean(modifiers.metaKey),
    };
    const printableCode = metadata.key.length === 1 ? metadata.key.charCodeAt(0) : 0;
    const dispatch = (type) => {
      const isPress = type === "keypress";
      const legacy = {
        keyCode: isPress && printableCode ? printableCode : metadata.keyCode,
        which: isPress && printableCode ? printableCode : metadata.keyCode,
        charCode: isPress ? printableCode : 0,
      };
      const event = new KeyboardEvent(type, { ...baseInit, ...legacy });
      // KeyboardEventInit does not reliably populate these deprecated fields in
      // Chromium. IXL's older YUI sympad still reads them, so expose them on the
      // event instance exactly as a physical keyboard event would.
      for (const [name, value] of Object.entries(legacy)) {
        try { Object.defineProperty(event, name, { configurable: true, get: () => value }); } catch (_error) { /* Use the browser value. */ }
      }
      element.dispatchEvent(event);
    };
    dispatch("keydown");
    if (metadata.key.length === 1) dispatch("keypress");
    dispatch("keyup");
  }

  async function clearIxlSympad(element) {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.focus({ preventScroll: true });
    dispatchLegacyKeystroke(element, "a", { ctrlKey: true });
    dispatchLegacyKeystroke(element, "Backspace");
    await delay(40);
    if (renderedSympadText(element)) {
      for (let index = 0; index < 80 && renderedSympadText(element); index += 1) dispatchLegacyKeystroke(element, "Backspace");
    }
  }

  async function fillIxlSympad(element, value) {
    const stringValue = String(value ?? "").replace(/\s+/g, "");
    await clearIxlSympad(element);
    for (const character of stringValue) {
      dispatchLegacyKeystroke(element, character);
      await delay(12);
    }
    await delay(100);
    if (sympadRenderedValueMatches(element, stringValue)) return;

    // Some IXL builds accept browser-native editing commands while ignoring
    // constructed input events. This path produces the normal editing event
    // sequence without trusting the hidden proxy-input's value as success.
    await clearIxlSympad(element);
    element.focus({ preventScroll: true });
    if (typeof document.execCommand === "function") {
      for (const character of stringValue) {
        try { document.execCommand("insertText", false, character); } catch (_error) { break; }
        await delay(12);
      }
      await delay(120);
      if (sympadRenderedValueMatches(element, stringValue)) return;
    }

    // Last compatibility attempt for versions that consume one proxy-input
    // event per symbol. Visible math rendering is still mandatory afterward.
    await clearIxlSympad(element);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    for (const character of stringValue) {
      if (setter) setter.call(element, character);
      else element.value = character;
      try {
        element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: character }));
      } catch (_error) {
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }
      await delay(12);
    }
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(120);
    if (!sympadRenderedValueMatches(element, stringValue)) {
      if (setter) setter.call(element, "");
      else element.value = "";
      throw new Error(`IXL's symbolic editor did not visibly render “${stringValue}”. Submission was blocked.`);
    }
  }

  async function fillTextAdaptively(element, value) {
    if (isIxlSympadInput(element)) {
      await fillIxlSympad(element, value);
      return;
    }
    setNativeValue(element, value);
    await delay(80);
    if (comparableText(currentControlValue(element)) === comparableText(value)) return;
    element.focus?.({ preventScroll: true });
    element.select?.();
    try { document.execCommand("insertText", false, String(value ?? "")); } catch (_error) { /* Continue to the verified fallback. */ }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(80);
    if (comparableText(currentControlValue(element)) !== comparableText(value)) {
      throw new Error(`IXL did not retain the value “${value}” in the answer field. Submission was blocked.`);
    }
  }

  function setSliderValue(element, value) {
    if (element instanceof HTMLInputElement) {
      setNativeValue(element, value);
      return;
    }
    const desired = Number(value);
    const current = Number(element.getAttribute("aria-valuenow"));
    const step = Number(element.getAttribute("aria-valuestep") || element.getAttribute("data-step") || 1);
    if (Number.isFinite(desired) && Number.isFinite(current) && Number.isFinite(step) && step > 0) {
      const count = Math.min(250, Math.round(Math.abs(desired - current) / step));
      const key = desired >= current ? "ArrowRight" : "ArrowLeft";
      dispatchKeyboardSequence(element, Array(count).fill(key));
    } else {
      setNativeValue(element, value);
    }
  }

  function clickElement(element) {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.focus?.({ preventScroll: true });
    if (typeof PointerEvent === "function") {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    }
    element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    if (typeof PointerEvent === "function") {
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
    }
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    element.click();
  }

  function closestTextMatch(elements, wanted) {
    const normalizedWanted = String(wanted ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalizedWanted) return null;
    return elements.find((element) => getAccessibleName(element).replace(/\s+/g, " ").trim().toLowerCase() === normalizedWanted)
      || elements.find((element) => getAccessibleName(element).replace(/\s+/g, " ").trim().toLowerCase().includes(normalizedWanted))
      || null;
  }

  function comparableText(value) {
    return String(value ?? "").replace(/[−–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function selectedState(element) {
    if (!element) return null;
    if ("checked" in element && typeof element.checked === "boolean") return Boolean(element.checked);
    for (const attribute of ["aria-checked", "aria-selected", "aria-pressed"]) {
      const value = element.getAttribute(attribute);
      if (value === "true") return true;
      if (value === "false") return false;
    }
    const nested = element.querySelector?.('input[type="radio"], input[type="checkbox"], [aria-checked], [aria-selected], [aria-pressed]');
    if (nested && nested !== element) {
      const nestedState = selectedState(nested);
      if (nestedState !== null) return nestedState;
    }
    const stateText = `${element.getAttribute("data-state") || ""} ${element.getAttribute("data-selected") || ""} ${element.className?.baseVal ?? element.className ?? ""}`.toLowerCase();
    if (/(^|[\s_-])(selected|checked|chosen)([\s_-]|$)/.test(stateText) || /\bactive\b/.test(stateText)) return true;
    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
      const ancestorClass = String(ancestor.className?.baseVal ?? ancestor.className ?? "").toLowerCase();
      const choiceWrapper = ancestor.matches?.('label, button, [role="radio"], [role="checkbox"], [role="option"], [role="button"]')
        || /(?:choice|answer-option|radio|checkbox|option)/i.test(ancestorClass);
      if (!choiceWrapper) continue;
      for (const attribute of ["aria-checked", "aria-selected", "aria-pressed"]) {
        const value = ancestor.getAttribute(attribute);
        if (value === "true") return true;
      }
      const ancestorState = `${ancestor.getAttribute("data-state") || ""} ${ancestor.getAttribute("data-selected") || ""} ${ancestorClass}`.toLowerCase();
      if (/(^|[\s_-])(selected|checked|chosen)([\s_-]|$)/.test(ancestorState) || /\bactive\b/.test(ancestorState)) return true;
    }
    return null;
  }

  function canvasSignature(element) {
    const scope = element.tagName === "CANVAS"
      ? element
      : element.closest?.('[class*="graph" i], [role="application"]')?.querySelector?.("canvas") || element.querySelector?.("canvas");
    if (!(scope instanceof HTMLCanvasElement) || !scope.width || !scope.height) return null;
    try {
      const context = scope.getContext("2d", { willReadFrequently: true });
      if (!context) return null;
      let hash = 2166136261;
      const columns = 12;
      const rows = 12;
      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const x = Math.min(scope.width - 1, Math.floor(((column + 0.5) / columns) * scope.width));
          const y = Math.min(scope.height - 1, Math.floor(((row + 0.5) / rows) * scope.height));
          const pixel = context.getImageData(x, y, 1, 1).data;
          for (const byte of pixel) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
        }
      }
      return `${scope.width}x${scope.height}:${hash}`;
    } catch (_error) {
      return null;
    }
  }

  function captureActionState(element, context) {
    const root = context.root?.isConnected ? context.root : findQuestionRoot();
    const answerStates = root
      ? collectTargets(root).slice(0, 120).map((target) => ({
        kind: targetKind(target),
        label: getAccessibleName(target).slice(0, 120),
        value: "value" in target ? String(target.value ?? "") : "",
        selected: selectedState(target),
        ariaValueNow: target.getAttribute("aria-valuenow"),
        selectedIndex: target.tagName === "SELECT" ? target.selectedIndex : null,
      }))
      : [];
    const graphScope = targetKind(element) === "graph"
      ? element.closest?.('[class*="graph" i], [role="application"]') || element
      : null;
    return {
      value: "value" in element ? String(element.value ?? "") : comparableText(element.textContent).slice(0, 1000),
      mathRendered: isIxlSympadInput(element) ? renderedSympadText(element) : null,
      selected: selectedState(element),
      selectedIndex: element.tagName === "SELECT" ? element.selectedIndex : null,
      ariaValueNow: element.getAttribute("aria-valuenow"),
      attributes: ["aria-checked", "aria-selected", "aria-pressed", "data-state", "data-selected", "class"]
        .map((name) => `${name}=${element.getAttribute(name) || ""}`).join("|"),
      markup: element.outerHTML?.slice(0, 5000) || "",
      answers: safeStringify(answerStates),
      canvas: canvasSignature(element),
      graphText: graphScope ? comparableText(normalizedText(graphScope)).slice(0, 6000) : null,
      graphSvg: graphScope?.querySelector?.("svg") ? stableSvgSignature(graphScope.querySelector("svg")) : null,
    };
  }

  function actionStateChanged(before, after) {
    return before.value !== after.value
      || before.mathRendered !== after.mathRendered
      || before.selected !== after.selected
      || before.selectedIndex !== after.selectedIndex
      || before.ariaValueNow !== after.ariaValueNow
      || before.attributes !== after.attributes
      || before.markup !== after.markup
      || before.answers !== after.answers
      || before.graphText !== after.graphText
      || before.graphSvg !== after.graphSvg
      || (before.canvas !== null && after.canvas !== null && before.canvas !== after.canvas);
  }

  function actionType(action) {
    const aliases = { type: "fill", select: "choose", check: "toggle", plot: "graph-point", sort: "reorder", move: "drag", key: "press" };
    const raw = comparableText(action.type);
    return aliases[raw] || raw;
  }

  function currentControlValue(element) {
    if (isIxlSympadInput(element)) return renderedSympadText(element);
    if (element.isContentEditable) return element.textContent || "";
    if ("value" in element) return String(element.value ?? "");
    return element.getAttribute("aria-valuenow") || element.textContent || "";
  }

  function actionSatisfied(action, element, before, after) {
    const type = actionType(action);
    if (type === "fill") {
      if (isIxlSympadInput(element)) return sympadRenderedValueMatches(element, action.value);
      return comparableText(currentControlValue(element)) === comparableText(action.value);
    }
    if (type === "toggle") {
      const desired = typeof action.value === "boolean" ? action.value : comparableText(action.value) !== "false";
      return selectedState(element) === desired;
    }
    if (type === "set-slider") return Number(currentControlValue(element)) === Number(action.value);
    if (type === "choose" && targetKind(element) === "dropdown") {
      if (element.tagName === "SELECT") {
        const option = element.options[element.selectedIndex];
        return Boolean(option) && (
          comparableText(option.textContent) === comparableText(action.value)
          || comparableText(option.value) === comparableText(action.value)
          || (Number.isInteger(action.optionIndex) && element.selectedIndex === action.optionIndex)
        );
      }
      return actionStateChanged(before, after);
    }
    if (["click", "choose"].includes(type) && ["single-choice", "multi-choice", "choice", "grid-cell"].includes(targetKind(element))) {
      return selectedState(element) === true;
    }
    if (type === "reorder") {
      const desired = String(action.value ?? "").split(/[|,;\s]+/).filter(Boolean).map(Number);
      const original = before.orderLabels || [];
      const current = [...element.querySelectorAll(':scope > [role="option"], :scope > .order-items-item, :scope > [data-testid="listItem"]')]
        .map((item) => comparableText(getAccessibleName(item)));
      return desired.length === current.length && desired.every((index, position) => current[position] === original[index]);
    }
    return actionStateChanged(before, after);
  }

  function liveTargetCandidates(context) {
    const root = context.root?.isConnected ? context.root : findQuestionRoot();
    return root ? collectTargets(root) : [];
  }

  function resolveActionElement(action, context) {
    const targetIndex = Number(action.target);
    const original = context.targets[targetIndex];
    const descriptor = context.descriptors[targetIndex];
    const candidates = liveTargetCandidates(context);
    const type = actionType(action);
    const expectedKind = descriptor?.kind || (original ? targetKind(original) : null);

    if (["click", "choose", "toggle"].includes(type) && ["single-choice", "multi-choice", "choice", "grid-cell"].includes(expectedKind)) {
      const wanted = comparableText(action.value);
      if (wanted && !["true", "false"].includes(wanted)) {
        const exact = candidates.find((candidate) => comparableText(getAccessibleName(candidate)) === wanted);
        if (exact) return exact;
        const contained = candidates.find((candidate) => comparableText(getAccessibleName(candidate)).includes(wanted));
        if (contained) return contained;
      }
      if (Number.isInteger(action.optionIndex)) {
        const indexed = candidates[action.optionIndex];
        if (indexed && ["single-choice", "multi-choice", "choice", "grid-cell"].includes(targetKind(indexed))) return indexed;
      }
    }

    if (original?.isConnected && isVisible(original)) return original;
    if (descriptor) {
      const sameKind = candidates.filter((candidate) => targetKind(candidate) === descriptor.kind);
      const exactLabel = sameKind.find((candidate) => comparableText(getAccessibleName(candidate)) === comparableText(descriptor.label));
      if (exactLabel) return exactLabel;
      const nearLabel = sameKind.find((candidate) => {
        const label = comparableText(getAccessibleName(candidate));
        const wanted = comparableText(descriptor.label);
        return label && wanted && (label.includes(wanted) || wanted.includes(label));
      });
      if (nearLabel) return nearLabel;
      if (sameKind.length === 1) return sameKind[0];
    }
    return null;
  }

  function choiceActivationCandidates(element, action, context) {
    const candidates = [];
    const seen = new Set();
    const root = context.root?.isConnected ? context.root : findQuestionRoot();
    const wanted = comparableText(action.value);
    const add = (candidate) => {
      if (!(candidate instanceof Element) || !candidate.isConnected || seen.has(candidate)) return;
      seen.add(candidate);
      candidates.push(candidate);
    };
    const addRelated = (candidate) => {
      add(candidate);
      if (candidate instanceof HTMLInputElement && candidate.id) {
        try { add(document.querySelector(`label[for="${CSS.escape(candidate.id)}"]`)); } catch (_error) { /* Continue. */ }
      }
      add(candidate.closest?.('label, button, [role="radio"], [role="checkbox"], [role="option"], [role="button"]'));
      let ancestor = candidate.parentElement;
      for (let depth = 0; ancestor && depth < 5; depth += 1, ancestor = ancestor.parentElement) {
        const className = String(ancestor.className?.baseVal ?? ancestor.className ?? "");
        if (ancestor.matches?.('label, button, [role="radio"], [role="checkbox"], [role="option"], [role="button"]')
          || /choice|answer-option|radio|checkbox/i.test(className)) add(ancestor);
        if (ancestor === root) break;
      }
      const nested = candidate.querySelectorAll?.('input[type="radio"], input[type="checkbox"], label, button, [role="radio"], [role="checkbox"]') || [];
      for (const child of nested) add(child);
    };
    addRelated(element);
    if (root && wanted && !["true", "false"].includes(wanted)) {
      const labelMatches = [...root.querySelectorAll('input, label, button, [role="radio"], [role="checkbox"], [role="option"], [role="button"], [class*="choice" i], [class*="answer-option" i]')]
        .filter((candidate) => comparableText(getAccessibleName(candidate)) === wanted || comparableText(normalizedText(candidate)) === wanted);
      for (const candidate of labelMatches.slice(0, 12)) addRelated(candidate);
    }
    const rect = element.getBoundingClientRect();
    if (rect.width && rect.height) add(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2));
    return candidates.slice(0, 24);
  }

  async function adaptiveChoiceRetry(element, action, context, before) {
    const attempts = [];
    const rect = element.getBoundingClientRect();
    if (rect.width && rect.height) {
      attempts.push(() => {
        const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        dispatchPointerLike(element, "pointerdown", point, 1);
        dispatchPointerLike(element, "mousedown", point, 1);
        dispatchPointerLike(element, "pointerup", point, 0);
        dispatchPointerLike(element, "mouseup", point, 0);
        dispatchPointerLike(element, "click", point, 0);
      });
    }
    const wrapper = element.closest("label") || element.parentElement?.closest('label, [role="radio"], [role="checkbox"], [role="option"], button');
    if (wrapper && wrapper !== element) attempts.push(() => clickElement(wrapper));
    for (const candidate of choiceActivationCandidates(element, action, context)) {
      attempts.push(() => clickElement(candidate));
    }
    if (element instanceof HTMLInputElement && ["radio", "checkbox"].includes(element.type)) {
      attempts.push(() => {
        const desired = actionType(action) === "toggle"
          ? (typeof action.value === "boolean" ? action.value : comparableText(action.value) !== "false")
          : true;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "checked")?.set;
        if (setter) setter.call(element, desired);
        else element.checked = desired;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }
    attempts.push(() => dispatchKeyboardSequence(element, [" "]));
    attempts.push(() => dispatchKeyboardSequence(element, ["Enter"]));

    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      const current = resolveActionElement(action, context) || element;
      const currentState = captureActionState(current, context);
      if (actionSatisfied(action, current, before, currentState)) return { element: current, after: currentState };
      const attempt = attempts[attemptIndex];
      attempt();
      await delay(attemptIndex < 4 ? 180 : 260);
      const live = resolveActionElement(action, context) || element;
      const after = captureActionState(live, context);
      if (actionSatisfied(action, live, before, after)) return { element: live, after };
    }
    return null;
  }

  async function chooseDropdown(element, action) {
    if (element.tagName === "SELECT") {
      const options = [...element.options];
      let option = null;
      if (Number.isInteger(action.optionIndex) && options[action.optionIndex]) option = options[action.optionIndex];
      option ||= options.find((item) => item.value === String(action.value));
      option ||= options.find((item) => normalizedText(item).toLowerCase() === String(action.value).trim().toLowerCase());
      if (!option) throw new Error(`Dropdown target ${action.target} has no matching option for “${action.value}”.`);
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      if (setter) setter.call(element, option.value);
      else element.value = option.value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    clickElement(element);
    await delay(180);
    const options = [...document.querySelectorAll('[role="option"], [data-testid*="option" i], [class*="option" i]')].filter(isVisible);
    let option = Number.isInteger(action.optionIndex) ? options[action.optionIndex] : null;
    option ||= closestTextMatch(options, action.value);
    if (!option) throw new Error(`Custom dropdown target ${action.target} opened, but its option was not found.`);
    clickElement(option);
  }

  function dispatchKeyboardSequence(element, keys) {
    element.focus?.({ preventScroll: true });
    for (const rawKey of keys) {
      const key = rawKey.trim();
      if (!key) continue;
      const init = { bubbles: true, cancelable: true, key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key };
      element.dispatchEvent(new KeyboardEvent("keydown", init));
      if (key.length === 1) element.dispatchEvent(new KeyboardEvent("keypress", init));
      element.dispatchEvent(new KeyboardEvent("keyup", init));
    }
  }

  function dispatchPointerLike(element, type, point, buttons = 1) {
    const init = { bubbles: true, cancelable: true, composed: true, clientX: point.x, clientY: point.y, screenX: point.x, screenY: point.y, button: 0, buttons, detail: type === "click" ? 1 : 0 };
    if (type.startsWith("pointer") && typeof PointerEvent === "function") {
      element.dispatchEvent(new PointerEvent(type, { ...init, pointerId: 1, pointerType: "mouse", isPrimary: true, pressure: buttons ? 0.5 : 0 }));
    } else {
      element.dispatchEvent(new MouseEvent(type, init));
    }
  }

  async function dragBetween(source, destination) {
    source.scrollIntoView({ block: "center", inline: "center" });
    destination.scrollIntoView({ block: "center", inline: "center" });
    await delay(50);
    const sourceRect = source.getBoundingClientRect();
    const destinationRect = destination.getBoundingClientRect();
    const from = { x: sourceRect.left + sourceRect.width / 2, y: sourceRect.top + sourceRect.height / 2 };
    const to = { x: destinationRect.left + destinationRect.width / 2, y: destinationRect.top + destinationRect.height / 2 };
    const steps = Array.from({ length: 8 }, (_unused, index) => ({
      x: from.x + ((to.x - from.x) * (index + 1)) / 8,
      y: from.y + ((to.y - from.y) * (index + 1)) / 8,
    }));

    dispatchPointerLike(source, "pointerdown", from, 1);
    dispatchPointerLike(source, "mousedown", from, 1);
    let dataTransfer = null;
    try { dataTransfer = new DataTransfer(); } catch (_error) { /* Optional in older browsers. */ }
    try { source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, dataTransfer, clientX: from.x, clientY: from.y })); } catch (_error) { /* Pointer path remains available. */ }
    for (const point of steps) {
      const receiver = document.elementFromPoint(point.x, point.y) || destination;
      dispatchPointerLike(receiver, "pointermove", point, 1);
      dispatchPointerLike(receiver, "mousemove", point, 1);
    }
    try {
      destination.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer, clientX: to.x, clientY: to.y }));
      destination.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer, clientX: to.x, clientY: to.y }));
      destination.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer, clientX: to.x, clientY: to.y }));
      source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, dataTransfer, clientX: to.x, clientY: to.y }));
    } catch (_error) {
      // Pointer/mouse events above support non-HTML5 drag implementations.
    }
    dispatchPointerLike(destination, "pointerup", to, 0);
    dispatchPointerLike(destination, "mouseup", to, 0);
    await delay(180);
  }

  async function reorderList(element, value) {
    const desired = String(value ?? "").split(/[|,;\s]+/).filter(Boolean).map(Number);
    let items = [...element.querySelectorAll(':scope > [role="option"], :scope > .order-items-item, :scope > [data-testid="listItem"]')];
    if (!items.length) throw new Error("The ordering target has no detectable items.");
    if (desired.length !== items.length || desired.some((index) => !Number.isInteger(index) || index < 0 || index >= items.length) || new Set(desired).size !== items.length) {
      throw new Error(`Reorder value must contain every original item index once (expected ${items.map((_item, index) => index).join(",")}).`);
    }
    const originalItems = [...items];
    for (let position = 0; position < desired.length; position += 1) {
      items = [...element.querySelectorAll(':scope > [role="option"], :scope > .order-items-item, :scope > [data-testid="listItem"]')];
      const source = originalItems[desired[position]];
      const currentPosition = items.indexOf(source);
      if (currentPosition === position) continue;
      const destination = items[position];
      await dragBetween(source, destination);
    }
  }

  function parseGraphNumber(element) {
    const text = `${element.getAttribute("aria-label") || ""} ${normalizedText(element)}`.replace(/[−–—]/g, "-");
    const numerator = text.match(/numerator\s*(-?\d+(?:\.\d+)?)/i)?.[1];
    const denominator = text.match(/denominator\s*(-?\d+(?:\.\d+)?)/i)?.[1];
    if (numerator && denominator && Number(denominator)) return Number(numerator) / Number(denominator);
    const mixed = text.match(/(-?\d+)\s+(\d+)\s*\/\s*(\d+)/);
    if (mixed) return Number(mixed[1]) + Math.sign(Number(mixed[1]) || 1) * Number(mixed[2]) / Number(mixed[3]);
    const fraction = text.match(/(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
    if (fraction && Number(fraction[2])) return Number(fraction[1]) / Number(fraction[2]);
    const number = text.match(/-?\d+(?:\.\d+)?/);
    return number ? Number(number[0]) : null;
  }

  function fitAxis(samples) {
    const valid = samples.filter((sample) => Number.isFinite(sample.value) && Number.isFinite(sample.pixel));
    if (valid.length < 2) return null;
    const meanValue = valid.reduce((sum, sample) => sum + sample.value, 0) / valid.length;
    const meanPixel = valid.reduce((sum, sample) => sum + sample.pixel, 0) / valid.length;
    const denominator = valid.reduce((sum, sample) => sum + (sample.value - meanValue) ** 2, 0);
    if (!denominator) return null;
    const slope = valid.reduce((sum, sample) => sum + (sample.value - meanValue) * (sample.pixel - meanPixel), 0) / denominator;
    if (!Number.isFinite(slope) || Math.abs(slope) < 0.05) return null;
    return { slope, intercept: meanPixel - slope * meanValue };
  }

  function graphCoordinateToPixel(element, x, y) {
    const graphBase = element.closest('[class*="graphingBaseContainer" i]') || element.parentElement;
    const xSamples = [...graphBase.querySelectorAll('.xAxisScaleLabel, [class*="xAxis" i][class*="label" i], [data-axis="x"]')].map((label) => {
      const holder = label.closest('.diagramLabel') || label;
      const rect = holder.getBoundingClientRect();
      return { value: parseGraphNumber(label), pixel: rect.left + rect.width / 2 };
    });
    const ySamples = [...graphBase.querySelectorAll('.yAxisScaleLabel, [class*="yAxis" i][class*="label" i], [data-axis="y"]')].map((label) => {
      const holder = label.closest('.diagramLabel') || label;
      const rect = holder.getBoundingClientRect();
      return { value: parseGraphNumber(label), pixel: rect.top + rect.height / 2 };
    });
    const xFit = fitAxis(xSamples);
    const yFit = fitAxis(ySamples);
    if (xFit && yFit) return { x: xFit.slope * x + xFit.intercept, y: yFit.slope * y + yFit.intercept };

    const description = normalizedText(graphBase.querySelector('.hiddenCoordinatePlaneDescription')) || graphBase.getAttribute("aria-label") || "";
    const bounds = description.match(/x-axis coordinates from\s*(-?\d+(?:\.\d+)?)\s*to\s*(-?\d+(?:\.\d+)?).*?y-axis coordinates from\s*(-?\d+(?:\.\d+)?)\s*to\s*(-?\d+(?:\.\d+)?)/i);
    if (!bounds) throw new Error("Could not determine the graph's coordinate scale.");
    const [, minX, maxX, minY, maxY] = bounds.map(Number);
    const rect = graphInteractionSurface(element).getBoundingClientRect();
    return {
      x: rect.left + ((x - minX) / (maxX - minX)) * rect.width,
      y: rect.bottom - ((y - minY) / (maxY - minY)) * rect.height,
    };
  }

  function graphInteractionSurface(element) {
    const graphBase = element.closest?.('[class*="graphingBaseContainer" i], [class*="graph" i], [role="application"]') || element.parentElement || element;
    const candidates = [
      element.matches?.('[class*="graphingPointerOverlay" i], [role="application"], canvas') ? element : null,
      graphBase.querySelector?.('[class*="graphingPointerOverlay" i]'),
      graphBase.querySelector?.('[role="application"]'),
      graphBase.querySelector?.('canvas'),
      element,
    ].filter((candidate) => candidate?.isConnected && isVisible(candidate));
    return candidates.sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return rightRect.width * rightRect.height - leftRect.width * leftRect.height;
    })[0] || element;
  }

  function dispatchGraphClick(surface, point) {
    const receiver = document.elementFromPoint(point.x, point.y) || surface;
    receiver.focus?.({ preventScroll: true });
    dispatchPointerLike(receiver, "pointermove", point, 0);
    dispatchPointerLike(receiver, "mousemove", point, 0);
    dispatchPointerLike(receiver, "pointerdown", point, 1);
    dispatchPointerLike(receiver, "mousedown", point, 1);
    dispatchPointerLike(receiver, "pointerup", point, 0);
    dispatchPointerLike(receiver, "mouseup", point, 0);
    dispatchPointerLike(receiver, "click", point, 0);
  }

  function plotGraphPoint(element, value) {
    const numbers = String(value ?? "").replace(/[()\[\]]/g, "").split(/[,;\s]+/).filter(Boolean).map(Number);
    if (numbers.length < 2 || !numbers.slice(0, 2).every(Number.isFinite)) throw new Error(`Graph point must be written as x,y; received “${value}”.`);
    const surface = graphInteractionSurface(element);
    surface.scrollIntoView({ block: "center", inline: "center" });
    const point = graphCoordinateToPixel(surface, numbers[0], numbers[1]);
    dispatchGraphClick(surface, point);
  }

  async function plotGraphPath(element, value) {
    const points = String(value ?? "").split(/[|;]/).map((part) => part.replace(/[()\[\]]/g, "").trim()).filter(Boolean);
    if (points.length < 2) throw new Error(`Graph path requires at least two coordinate pairs separated by semicolons; received “${value}”.`);
    for (const point of points) {
      plotGraphPoint(element, point);
      await delay(180);
    }
  }

  function parseRelativeValues(value, expected) {
    const numbers = String(value ?? "").split(/[,;\s]+/).filter(Boolean).map(Number);
    if (numbers.length !== expected || numbers.some((number) => !Number.isFinite(number) || number < 0 || number > 1)) {
      throw new Error(`Relative action requires ${expected} values between 0 and 1; received “${value}”.`);
    }
    return numbers;
  }

  function clickRelative(element, value) {
    const [horizontal, vertical] = parseRelativeValues(value, 2);
    const rect = element.getBoundingClientRect();
    const point = { x: rect.left + horizontal * rect.width, y: rect.top + vertical * rect.height };
    dispatchPointerLike(element, "pointerdown", point, 1);
    dispatchPointerLike(element, "mousedown", point, 1);
    dispatchPointerLike(element, "pointerup", point, 0);
    dispatchPointerLike(element, "mouseup", point, 0);
    dispatchPointerLike(element, "click", point, 0);
  }

  async function dragRelative(element, value) {
    const [startX, startY, endX, endY] = parseRelativeValues(value, 4);
    const rect = element.getBoundingClientRect();
    const from = { x: rect.left + startX * rect.width, y: rect.top + startY * rect.height };
    const to = { x: rect.left + endX * rect.width, y: rect.top + endY * rect.height };
    dispatchPointerLike(element, "pointerdown", from, 1);
    dispatchPointerLike(element, "mousedown", from, 1);
    for (let step = 1; step <= 10; step += 1) {
      const point = { x: from.x + ((to.x - from.x) * step) / 10, y: from.y + ((to.y - from.y) * step) / 10 };
      dispatchPointerLike(document.elementFromPoint(point.x, point.y) || element, "pointermove", point, 1);
      dispatchPointerLike(document.elementFromPoint(point.x, point.y) || element, "mousemove", point, 1);
    }
    dispatchPointerLike(document.elementFromPoint(to.x, to.y) || element, "pointerup", to, 0);
    dispatchPointerLike(document.elementFromPoint(to.x, to.y) || element, "mouseup", to, 0);
    await delay(80);
  }

  async function applyAction(action, context, resolvedElement = null) {
    const targetIndex = Number(action.target);
    const element = resolvedElement || resolveActionElement(action, context);
    if (!element?.isConnected) throw new Error(`Answer target ${targetIndex} is no longer on the page and could not be remapped.`);
    const type = actionType(action);

    if (type === "fill") {
      await fillTextAdaptively(element, action.value);
      return element;
    }
    if (type === "choose" && targetKind(element) === "dropdown") {
      await chooseDropdown(element, action);
      return element;
    }
    if (type === "toggle") {
      const desired = typeof action.value === "boolean" ? action.value : String(action.value).toLowerCase() !== "false";
      const current = "checked" in element ? Boolean(element.checked) : element.getAttribute("aria-checked") === "true";
      if (current !== desired) clickElement(element);
      return element;
    }
    if (type === "set-slider") {
      setSliderValue(element, action.value);
      return element;
    }
    if (type === "reorder") {
      await reorderList(element, action.value);
      return element;
    }
    if (type === "drag") {
      const destinationAction = { type: "drag-destination", target: Number(action.optionIndex) };
      const destination = resolveActionElement(destinationAction, context) || context.targets[Number(action.optionIndex)];
      if (!destination?.isConnected) throw new Error(`Drag destination target ${action.optionIndex} is unavailable.`);
      await dragBetween(element, destination);
      return element;
    }
    if (type === "graph-point") {
      plotGraphPoint(element, action.value);
      return element;
    }
    if (type === "graph-path") {
      await plotGraphPath(element, action.value);
      return element;
    }
    if (type === "click-relative") {
      clickRelative(element, action.value);
      return element;
    }
    if (type === "drag-relative") {
      await dragRelative(element, action.value);
      return element;
    }
    if (type === "press") {
      const keys = String(action.value ?? "").split(/[,|]+/).map((key) => key.trim()).filter(Boolean);
      if (!keys.length) throw new Error("Press action did not include any keys.");
      dispatchKeyboardSequence(element, keys);
      return element;
    }
    if (type === "click" || type === "choose") {
      clickElement(element);
      return element;
    }
    throw new Error(`Unsupported action type “${action.type}”.`);
  }

  function transitionLoopState(next, details = {}) {
    const previous = loopState;
    loopState = next;
    if (previous !== next) log("Solver state transition.", { from: previous, to: next, ...details });
    if (lastContext) updateAdaptiveDebugger(lastContext, { loopState, stateTransition: { from: previous, to: next, ...details }, solveTrace: currentSolveTrace });
  }

  function readJsonValue(key, fallback) {
    try {
      let value = GM_getValue(key, fallback);
      if (typeof value === "string") value = JSON.parse(value);
      return value && typeof value === "object" ? value : fallback;
    } catch (_error) { return fallback; }
  }

  function beginSolveTrace(context, ir) {
    currentSolveTrace = {
      attemptId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
      startedAt: new Date().toISOString(),
      subject: ir.subject,
      questionType: ir.questionType,
      articleFingerprint: ir.passage?.fingerprint || null,
      targetKinds: context.descriptors.map((target) => target.kind),
      stages: [],
    };
    return currentSolveTrace;
  }

  function traceSolveStage(stage, details = {}) {
    if (!currentSolveTrace) return;
    const sanitized = JSON.parse(JSON.stringify(details, (key, value) => /apiKey|token|passageText|prompt|html/i.test(key) ? undefined : value));
    currentSolveTrace.stages.push({ stage, at: new Date().toISOString(), details: sanitized });
  }

  function saveSolveAttempt(outcome, details = {}) {
    if (!currentSolveTrace || !config.attemptDiagnostics) { currentSolveTrace = null; return; }
    const trace = { ...currentSolveTrace, outcome, finishedAt: new Date().toISOString(), details };
    const attempts = readJsonValue(SOLVE_ATTEMPT_CACHE_KEY, []);
    const next = Array.isArray(attempts) ? attempts : [];
    next.unshift(trace);
    GM_setValue(SOLVE_ATTEMPT_CACHE_KEY, next.slice(0, 100));
    if (validSupabaseSettings()) void supabaseRestRequest("POST", "?on_conflict=cache_namespace,attempt_id", {
      cache_namespace: config.supabaseNamespace,
      attempt_id: trace.attemptId,
      question_hash: details.questionHash || null,
      semantic_hash: details.semanticHash || null,
      subject: trace.subject,
      stage: trace.stages.at(-1)?.stage || "complete",
      outcome,
      details: trace,
    }, "resolution=merge-duplicates,return=minimal", "ixl_solve_attempts").catch((error) => log("Solve trace stayed local because Supabase diagnostics were unavailable.", error.message || String(error)));
    currentSolveTrace = null;
  }

  function widgetKindForAction(action, element) {
    const type = actionType(action);
    if (["graph-point", "graph-path", "click-relative", "drag-relative"].includes(type)) return "graph";
    if (type === "fill") return isIxlSympadInput(element) ? "symbolic" : "text";
    if (["click", "toggle"].includes(type)) return "choice";
    if (type === "choose") return targetKind(element) === "dropdown" ? "dropdown" : "choice";
    if (type === "set-slider") return "slider";
    if (type === "reorder") return "ordering";
    if (type === "drag") return "drag";
    if (type === "press") return "press";
    return "choice";
  }

  async function widgetSignatureFor(action, element) {
    const kind = widgetKindForAction(action, element);
    const details = {
      kind,
      tag: element?.tagName?.toLowerCase() || "",
      role: element?.getAttribute?.("role") || "",
      type: element?.getAttribute?.("type") || "",
      classes: String(element?.className || "").split(/\s+/).filter((name) => /sympad|graph|choice|radio|checkbox|input|select|drag|order|slider/i.test(name)).sort().slice(0, 8),
      testid: element?.getAttribute?.("data-testid") || element?.getAttribute?.("data-cy") || "",
    };
    return { kind, signature: await sha256Hex(JSON.stringify(details)), details };
  }

  function rankedWidgetStrategies(widget) {
    const memory = readJsonValue(WIDGET_STRATEGY_CACHE_KEY, {});
    const learned = Object.values(memory).filter((entry) => entry.widgetSignature === widget.signature && entry.successCount > entry.failureCount)
      .sort((left, right) => (right.successCount - right.failureCount) - (left.successCount - left.failureCount)).map((entry) => entry.strategyName);
    return [...new Set([...learned, ...(WIDGET_CAPABILITY_REGISTRY[widget.kind] || ["direct-click"])])];
  }

  function recordWidgetStrategy(widget, strategyName, success, details = {}) {
    if (!config.learnWidgetStrategies || !widget?.signature) return;
    const memory = readJsonValue(WIDGET_STRATEGY_CACHE_KEY, {});
    const key = `${widget.signature}:${strategyName}`;
    const prior = memory[key] || { widgetSignature: widget.signature, widgetKind: widget.kind, strategyName, successCount: 0, failureCount: 0 };
    prior.successCount += success ? 1 : 0;
    prior.failureCount += success ? 0 : 1;
    prior.lastResult = success ? "success" : "failure";
    prior.updatedAt = new Date().toISOString();
    prior.details = { ...widget.details, ...details };
    memory[key] = prior;
    GM_setValue(WIDGET_STRATEGY_CACHE_KEY, memory);
    if (validSupabaseSettings()) void supabaseRestRequest("POST", "?on_conflict=cache_namespace,widget_signature,strategy_name", {
      cache_namespace: config.supabaseNamespace,
      widget_signature: widget.signature,
      widget_kind: widget.kind,
      strategy_name: strategyName,
      strategy_details: prior.details,
      success_count: prior.successCount,
      failure_count: prior.failureCount,
      last_result: prior.lastResult,
    }, "resolution=merge-duplicates,return=minimal", "ixl_widget_strategies").catch(() => {});
  }

  async function applyActionWithStrategy(action, context, element, strategy) {
    if (strategy === "keyboard-activate") {
      element.focus?.();
      dispatchKeyboardSequence(element, ["Enter"]);
      return element;
    }
    if (strategy === "nested-click") {
      clickElement(element.querySelector?.('button,[role="radio"],[role="checkbox"],[role="option"],[tabindex]') || element);
      return element;
    }
    if (strategy === "label-remap") {
      const matched = resolveActionElement({ ...action, value: action.value || getAccessibleName(element) }, context) || element;
      clickElement(matched);
      return matched;
    }
    if (["keyboard-entry", "input-events", "sympad-input-events"].includes(strategy)) {
      await fillTextAdaptively(element, action.value);
      return element;
    }
    return applyAction(action, context, element);
  }

  async function applyActions(answer, context) {
    const errors = [];
    let applied = 0;
    let verified = 0;
    let changed = 0;
    const verifications = [];
    for (const originalAction of answer.actions) {
      const action = { ...originalAction };
      let widget = null;
      let strategyUsed = "default";
      if (["click", "choose"].includes(actionType(action)) && !comparableText(action.value)) action.value = answer.finalAnswer;
      try {
        let element = resolveActionElement(action, context);
        if (!element) throw new Error(`Answer target ${action.target} could not be matched to a visible control.`);
        widget = await widgetSignatureFor(action, element);
        strategyUsed = rankedWidgetStrategies(widget)[0] || "default";
        const before = captureActionState(element, context);
        if (actionType(action) === "reorder") {
          before.orderLabels = [...element.querySelectorAll(':scope > [role="option"], :scope > .order-items-item, :scope > [data-testid="listItem"]')]
            .map((item) => comparableText(getAccessibleName(item)));
        }
        element = await applyActionWithStrategy(action, context, element, strategyUsed);
        applied += 1;
        await delay(140);
        let live = resolveActionElement(action, context) || element;
        let after = captureActionState(live, context);
        let satisfied = actionSatisfied(action, live, before, after);
        if (!satisfied && ["click", "choose", "toggle"].includes(actionType(action))) {
          const retry = await adaptiveChoiceRetry(live, action, context, before);
          if (retry) {
            live = retry.element;
            after = retry.after;
            satisfied = true;
            strategyUsed = "adaptive-choice-ladder";
          }
        }
        if (!satisfied
          && ["graph-point", "graph-path", "click-relative", "drag-relative"].includes(actionType(action))
          && !actionStateChanged(before, after)) {
          log("Graph action produced no detectable state change; retrying against the live interaction surface.", { type: actionType(action), target: action.target });
          await delay(220);
          live = resolveActionElement(action, context) || live;
          await applyAction(action, context, live);
          await delay(260);
          live = resolveActionElement(action, context) || live;
          after = captureActionState(live, context);
          satisfied = actionSatisfied(action, live, before, after);
          if (satisfied) strategyUsed = "coordinate-overlay-retry";
        }
        const didChange = actionStateChanged(before, after);
        if (!satisfied) throw new Error(`IXL did not confirm action ${applied} on target ${action.target}; submission was blocked.`);
        verified += 1;
        recordWidgetStrategy(widget, strategyUsed, true, { actionType: actionType(action) });
        if (didChange) changed += 1;
        verifications.push({ action, element: live, before, after });
        log("Answer action verified.", { type: actionType(action), target: action.target, label: getAccessibleName(live).slice(0, 160), changed: didChange });
      } catch (error) {
        recordWidgetStrategy(widget, strategyUsed, false, { actionType: actionType(action), error: String(error?.message || error).slice(0, 240) });
        errors.push(error.message || String(error));
      }
    }
    return { requested: answer.actions.length, applied, verified, changed, errors, verifications };
  }

  function findSubmitButton(context) {
    const scopes = [context.root, context.root.parentElement, context.root.closest("section"), document.querySelector("main")].filter(Boolean);
    for (const scope of scopes) {
      const buttons = [...scope.querySelectorAll('button, input[type="submit"], [role="button"]')].filter(isVisible);
      const currentIxl = buttons.find((button) => button.getAttribute("data-cy") === "question-submit-button" && !button.disabled && button.getAttribute("aria-disabled") !== "true");
      if (currentIxl) return currentIxl;
      const exact = buttons.find((button) => SUBMIT_BUTTON_RE.test(getAccessibleName(button)) && !button.disabled && button.getAttribute("aria-disabled") !== "true");
      if (exact) return exact;
      const semantic = buttons.find((button) => /submit|check-answer/i.test(`${button.className} ${button.dataset?.testid || ""} ${button.dataset?.cy || ""}`) && !button.disabled);
      if (semantic) return semantic;
    }
    return null;
  }

  async function autoSubmit(context, result) {
    if (!result || result.requested < 1 || result.verified !== result.requested) {
      throw new Error("Auto-submit was blocked because not every answer action was verified.");
    }
    if (result.changed < 1) {
      throw new Error("Auto-submit was blocked because no answer control visibly changed.");
    }
    for (const verification of result.verifications) {
      const element = resolveActionElement(verification.action, context) || verification.element;
      if (!element?.isConnected) throw new Error("Auto-submit was blocked because an answered control disappeared.");
      const current = captureActionState(element, context);
      if (!actionSatisfied(verification.action, element, verification.before, current)) {
        throw new Error(`Auto-submit was blocked because target ${verification.action.target} is no longer in the intended state.`);
      }
    }
    await delay(350);
    const button = findSubmitButton(context);
    if (!button) throw new Error("The answer was filled, but no enabled Check/Submit button was found.");
    clickElement(button);
  }

  function showAnswer(answer) {
    ui.answer.style.display = "block";
    ui.final.textContent = answer.finalAnswer || "(No short answer supplied)";
    ui.explanation.textContent = answer.explanation || "";
  }

  function loopQuestionSignature(context) {
    return safeStringify({
      path: `${location.pathname}${location.search}`,
      solverProfile: context.solverProfile || "adaptive",
      subject: context.subject,
      questionType: context.questionType,
      articleFingerprint: context.readingPassage?.fingerprint || null,
      text: context.questionText.slice(0, 6000),
      targets: context.descriptors.map((target) => ({
        kind: target.kind,
        label: target.label,
        options: target.options?.map((option) => option.text),
        items: target.items?.map((item) => item.label),
        graphDescription: target.graphDescription,
      })),
    });
  }

  function normalizedAdvanceLabel(element) {
    return comparableText(getAccessibleName(element)).replace(/[.!…›»]+$/g, "").trim();
  }

  function querySelectorAllDeep(selector, root = document) {
    const results = [];
    const visited = new Set();
    const visit = (scope) => {
      if (!scope || visited.has(scope)) return;
      visited.add(scope);
      try { results.push(...scope.querySelectorAll(selector)); } catch (_error) { return; }
      for (const element of scope.querySelectorAll("*")) {
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(root);
    return [...new Set(results)];
  }

  function normalizedGotItLabel(element) {
    return comparableText(getAccessibleName(element) || normalizedText(element))
      .replace(/[.!…›»:]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isGotItLabel(value) {
    return /^got\s*it(?:\s*[,;:\-–—]?\s*(?:button|continue|next))?$/.test(comparableText(value).replace(/[.!…›»:]+$/g, "").trim());
  }

  function findGotItButtons() {
    const scope = document;
    const selectors = [
      "button",
      "a",
      '[role="button"]',
      'input[type="button"]',
      'input[type="submit"]',
      '[data-cy*="got" i]',
      '[data-testid*="got" i]',
      '[class*="got-it" i]',
      '[class*="gotit" i]',
      '[class*="button" i]',
      "[tabindex]",
      "span",
      "div",
    ].join(",");
    const seen = new Set();
    const candidates = [];
    const add = (element) => {
      if (!(element instanceof Element) || seen.has(element) || !isVisible(element) || element.closest(`#${PANEL_ID}`)) return;
      if (element.disabled || element.getAttribute("aria-disabled") === "true") return;
      if (!isGotItLabel(normalizedGotItLabel(element)) && !isGotItLabel(normalizedText(element))) return;
      seen.add(element);
      candidates.push(element);
    };
    for (const element of querySelectorAllDeep(selectors, scope)) {
      add(element);
      add(element.closest('button, a, [role="button"], input[type="button"], input[type="submit"], [data-cy], [data-testid], [class*="button" i], [tabindex]'));
    }
    candidates.sort((left, right) => {
      const semantic = (element) => element.matches('button, input[type="button"], input[type="submit"]') ? 5
        : element.matches('a, [role="button"]') ? 4
          : element.matches('[data-cy], [data-testid], [class*="button" i], [tabindex]') ? 2 : 1;
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      const leftExact = normalizedGotItLabel(left) === "got it" ? 1 : 0;
      const rightExact = normalizedGotItLabel(right) === "got it" ? 1 : 0;
      return semantic(right) - semantic(left)
        || rightExact - leftExact
        || (rightRect.width * rightRect.height) - (leftRect.width * leftRect.height);
    });
    return candidates;
  }

  function findGotItButton() {
    return findGotItButtons()[0] || null;
  }

  function findNextQuestionButton() {
    const gotIt = findGotItButton();
    if (gotIt) return gotIt;
    const scopes = [document.querySelector("main"), document.body].filter(Boolean);
    for (const scope of scopes) {
      const buttons = [...scope.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]')]
        .filter((button) => isVisible(button) && !button.disabled && button.getAttribute("aria-disabled") !== "true" && !button.closest(`#${PANEL_ID}`));
      const exact = buttons.find((button) => /^(next|next question|continue|continue practicing|go on)$/i.test(normalizedAdvanceLabel(button)));
      if (exact) return exact;
      const semantic = buttons.find((button) => /next-question|question-next|continue-button/i.test(`${button.dataset?.cy || ""} ${button.dataset?.testid || ""} ${button.className || ""}`));
      if (semantic) return semantic;
    }
    return null;
  }

  function isIncorrectAdvanceButton(button) {
    return Boolean(button && (isGotItLabel(normalizedGotItLabel(button)) || detectIncorrectReviewState().active));
  }

  function findCorrectionLabel() {
    return querySelectorAllDeep('h1, h2, h3, h4, p, div, span, label, [role="heading"], [role="alert"], [aria-live]')
      .filter(isVisible)
      .find((element) => /^the correct answer is:?$/i.test(normalizedText(element)));
  }

  function detectIncorrectReviewState() {
    const gotIt = findGotItButton();
    // A visible Got it control is sufficient and is the most important fast
    // path. Avoid walking every review text node on each watchdog tick.
    if (gotIt) {
      return {
        active: true,
        gotIt,
        correctionLabel: null,
        incorrectMarker: null,
        explanationMarker: null,
      };
    }
    let correctionLabel = null;
    const markerSelectors = [
      "h1", "h2", "h3", "h4", "p", "div", "span",
      '[role="heading"]', '[role="alert"]', '[aria-live]'
    ].join(",");
    let incorrectMarker = null;
    let explanationMarker = null;
    for (const element of querySelectorAllDeep(markerSelectors)) {
      if (!isVisible(element) || element.closest(`#${PANEL_ID}`)) continue;
      const text = normalizedText(element);
      if (!text || text.length > 240) continue;
      if (!correctionLabel && /^the correct answer is:?$/i.test(text)) correctionLabel = element;
      if (!incorrectMarker && /(?:^|\b)sorry[,! ]*incorrect(?:\b|[.!…])/i.test(text)) incorrectMarker = element;
      if (!explanationMarker && /^(?:answer review|explanation)$/i.test(text)) explanationMarker = element;
      if (correctionLabel && incorrectMarker && explanationMarker) break;
    }
    return {
      active: Boolean(gotIt || correctionLabel || incorrectMarker),
      gotIt,
      correctionLabel,
      incorrectMarker,
      explanationMarker,
    };
  }

  function correctionBoundaryAfter(label) {
    const candidates = [...document.querySelectorAll("main *, article *, [role=main] *")]
      .filter((element) => isVisible(element) && element !== label && (element.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_PRECEDING))
      .filter((element) => /^(?:explanation|got it)$/i.test(normalizedText(element)));
    return candidates[0] || null;
  }

  function elementBetween(element, start, end) {
    if (!element || element === start || start.contains(element)) return false;
    const afterStart = Boolean(start.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
    const beforeEnd = !end || Boolean(end.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING);
    return afterStart && beforeEnd;
  }

  function correctionMarkerScore(element, correctionLabel) {
    let score = selectedState(element) === true ? 8 : 0;
    let current = element;
    for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
      const marker = `${current.className?.baseVal ?? current.className ?? ""} ${current.getAttribute?.("data-state") || ""} ${current.getAttribute?.("data-correct") || ""} ${current.getAttribute?.("aria-label") || ""}`.toLowerCase();
      if (/(?:^|[\s_-])(correct|right|solution)(?:[\s_-]|$)|correctanswer|answercorrect/.test(marker)) score += 7;
      if (/(?:^|[\s_-])(incorrect|wrong|error)(?:[\s_-]|$)/.test(marker)) score -= 9;
      if (current.querySelector?.('[aria-label*="correct" i], [title*="correct" i], [data-correct="true"]')) score += 4;
      if (current === correctionLabel.parentElement) break;
    }
    try {
      const style = getComputedStyle(element.closest("button, label, [role=radio], [role=checkbox], [role=option]") || element);
      const colors = `${style.borderColor} ${style.backgroundColor}`.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/g) || [];
      for (const color of colors) {
        const values = color.match(/\d+/g).slice(0, 3).map(Number);
        const saturation = Math.max(...values) - Math.min(...values);
        if (saturation > 80) score += saturation / 100;
      }
    } catch (_error) {
      // Visual scoring is only a fallback for custom IXL review controls.
    }
    return score;
  }

  function matchingCorrectionElement(labelText, correctionLabel, boundary) {
    const wanted = comparableText(labelText);
    const candidates = [...document.querySelectorAll('button, label, [role="radio"], [role="checkbox"], [role="option"], [data-testid*="choice" i], [class*="choice" i], [class*="answer-option" i], span, div')]
      .filter((element) => isVisible(element) && elementBetween(element, correctionLabel, boundary))
      .filter((element) => comparableText(getAccessibleName(element)) === wanted || comparableText(normalizedText(element)) === wanted);
    candidates.sort((left, right) => {
      const leftSemantic = left.matches('button, label, [role="radio"], [role="checkbox"], [role="option"], [data-testid*="choice" i], [class*="choice" i], [class*="answer-option" i]') ? 1 : 0;
      const rightSemantic = right.matches('button, label, [role="radio"], [role="checkbox"], [role="option"], [data-testid*="choice" i], [class*="choice" i], [class*="answer-option" i]') ? 1 : 0;
      return rightSemantic - leftSemantic || correctionMarkerScore(right, correctionLabel) - correctionMarkerScore(left, correctionLabel);
    });
    return candidates[0] || null;
  }

  function correctionRegionText(correctionLabel, boundary) {
    try {
      const range = document.createRange();
      range.setStartAfter(correctionLabel);
      if (boundary) range.setEndBefore(boundary);
      else range.setEndAfter(correctionLabel.parentElement || correctionLabel);
      return range.toString().replace(/^\s+|\s+$/g, "");
    } catch (_error) {
      return "";
    }
  }

  function correctionTextValues(correctionLabel, boundary, count) {
    const explicitElements = [...document.querySelectorAll('input, textarea, [role="textbox"], [data-latex], math, mjx-container')]
      .filter((element) => isVisible(element) && elementBetween(element, correctionLabel, boundary));
    const values = [];
    const add = (value) => {
      const clean = String(value || "").replace(/^the correct answer is:?\s*/i, "").replace(/\s+/g, " ").trim();
      if (clean && !/^(?:explanation|got it)$/i.test(clean) && !values.some((item) => comparableText(item) === comparableText(clean))) values.push(clean);
    };
    for (const element of explicitElements) {
      const value = element.dataset?.latex || element.getAttribute("aria-label") || currentControlValue(element) || normalizedText(element);
      if (String(value || "").length <= 500) add(value);
    }
    if (values.length < count) {
      const fallbackElements = [...document.querySelectorAll('[class*="correct" i], [class*="answer" i], [class*="math" i]')]
        .filter((element) => isVisible(element) && elementBetween(element, correctionLabel, boundary))
        .filter((element) => !element.querySelector('input, textarea, [role="textbox"], [data-latex], math, mjx-container'));
      for (const element of fallbackElements) {
        const value = element.dataset?.latex || element.getAttribute("aria-label") || normalizedText(element);
        if (String(value || "").length <= 500) add(value);
      }
    }
    if (values.length < count) {
      const rangeText = correctionRegionText(correctionLabel, boundary);
      if (count > 1) {
        for (const part of rangeText.split(/\n+|\s*\|\s*|\s*;\s*/)) add(part);
      } else add(rangeText);
    }
    return values;
  }

  function buildIxlCorrectionAnswer(pending) {
    const correctionLabel = findCorrectionLabel();
    if (!correctionLabel) return null;
    const boundary = correctionBoundaryAfter(correctionLabel);
    const context = pending.context;
    const descriptors = context.descriptors;
    const actions = [];
    const choiceKinds = new Set(["choice", "single-choice", "multi-choice", "grid-cell"]);
    const choiceDescriptors = descriptors.filter((descriptor) => choiceKinds.has(descriptor.kind));
    const markedChoices = choiceDescriptors.map((descriptor) => {
      const element = matchingCorrectionElement(descriptor.label, correctionLabel, boundary);
      return { descriptor, element, score: element ? correctionMarkerScore(element, correctionLabel) : -Infinity };
    }).filter((entry) => entry.element);
    const strongestChoiceScore = Math.max(-Infinity, ...markedChoices.map((entry) => entry.score));
    const positiveChoices = markedChoices.filter((entry) => entry.score >= Math.max(2.5, strongestChoiceScore - 1.25));

    if (choiceDescriptors.length) {
      if (!positiveChoices.length) return null;
      for (const entry of positiveChoices) {
        actions.push({
          type: entry.descriptor.kind === "multi-choice" ? "toggle" : "click",
          target: entry.descriptor.target,
          value: entry.descriptor.kind === "multi-choice" ? true : entry.descriptor.label,
          optionIndex: null,
        });
      }
      for (const entry of markedChoices) {
        if (entry.descriptor.kind === "multi-choice" && !positiveChoices.includes(entry)) {
          actions.push({ type: "toggle", target: entry.descriptor.target, value: false, optionIndex: null });
        }
      }
    }

    const textDescriptors = descriptors.filter((descriptor) => descriptor.kind === "text");
    const dropdownDescriptors = descriptors.filter((descriptor) => descriptor.kind === "dropdown");
    const neededValues = textDescriptors.length + dropdownDescriptors.length;
    const values = correctionTextValues(correctionLabel, boundary, neededValues);
    let valueIndex = 0;
    for (const descriptor of textDescriptors) {
      const value = values[valueIndex++];
      if (!value) return null;
      actions.push({ type: "fill", target: descriptor.target, value, optionIndex: null });
    }
    for (const descriptor of dropdownDescriptors) {
      const remaining = values.slice(valueIndex);
      const match = remaining.find((value) => descriptor.options?.some((option) => comparableText(option.text) === comparableText(value)));
      if (!match) return null;
      valueIndex += Math.max(1, remaining.indexOf(match) + 1);
      actions.push({ type: "choose", target: descriptor.target, value: match, optionIndex: null });
    }

    const unsupported = descriptors.filter((descriptor) => !choiceKinds.has(descriptor.kind) && !["text", "dropdown"].includes(descriptor.kind));
    if (unsupported.length) {
      // Reuse an IXL correction for complex widgets only if their full corrected
      // state can be expressed by the same number and types of submitted actions.
      const submittedComplex = pending.answer.actions.filter((action) => unsupported.some((descriptor) => descriptor.target === Number(action.target)));
      if (!submittedComplex.length || !submittedComplex.every((action) => ["reorder", "graph-point", "graph-path", "click-relative", "drag-relative", "set-slider", "press"].includes(actionType(action)))) return null;
      return null;
    }
    if (!actions.length) return null;
    const finalAnswer = actions.map((action) => action.type === "toggle" && action.value === false ? null : action.value).filter((value) => value !== null && value !== undefined).join(" | ");
    return {
      actions,
      finalAnswer,
      explanation: "IXL displayed this as the correct answer after the previous attempt.",
      confidence: 1,
      acceptedAlternatives: textDescriptors.length === 1 && values.length > 1 ? values : undefined,
    };
  }

  async function commitPendingAnswerCache(reason = "IXL accepted the answer") {
    const pending = pendingAnswerCache;
    pendingAnswerCache = null;
    if (!pending) return false;
    const source = pending.cacheSource === "ixl-correction" ? "ixl-correction" : "ixl-accepted";
    const record = makeAnswerCacheRecord(pending.identity, pending.answer, source, pending.cacheRecord?.verified_count || 0);
    saveLocalAnswerRecord(record);
    void writeSupabaseAnswerRecord(record).then((remoteSaved) => {
      log("Background Supabase accepted-answer sync finished.", { questionHash: pending.identity.hash, supabase: remoteSaved, actions: pending.answer.actions.length });
    });
    log("IXL acceptance confirmed; pending answer committed to the cache.", { reason, questionHash: pending.identity.hash, actions: pending.answer.actions.length });
    return true;
  }

  async function learnFromIncorrectFeedback() {
    const pending = pendingAnswerCache;
    pendingAnswerCache = null;
    if (!pending) return false;
    await invalidateCachedAnswer(pending.cacheRecord?.question_hash || pending.identity.hash, "IXL marked the submitted answer incorrect");
    const correction = buildIxlCorrectionAnswer(pending);
    if (!correction) {
      log("IXL showed an incorrect result, but its full correction could not be mapped safely; the attempted memory was quarantined and no partial correction was cached.", { questionHash: pending.identity.hash });
      return false;
    }
    const record = makeAnswerCacheRecord(pending.identity, correction, "ixl-correction", pending.cacheRecord?.verified_count || 0);
    saveLocalAnswerRecord(record);
    void writeSupabaseAnswerRecord(record).then((remoteSaved) => {
      log("Background Supabase correction sync finished.", { questionHash: pending.identity.hash, supabase: remoteSaved, actions: correction.actions.length });
    });
    showAnswer(correction);
    setStatus(`IXL correction learned and saved (${correction.actions.length} action${correction.actions.length === 1 ? "" : "s"}). Advancing…`, "success");
    log("Learned IXL's displayed correct answer after an incorrect submission.", { questionHash: pending.identity.hash, finalAnswer: correction.finalAnswer, actions: correction.actions });
    return true;
  }

  async function activateNextQuestionButton(button) {
    if (!button?.isConnected) return false;
    const label = normalizedAdvanceLabel(button);
    const isGotIt = isGotItLabel(normalizedGotItLabel(button));
    const sameAdvanceStillVisible = () => {
      const current = isGotIt ? findGotItButton() : findNextQuestionButton();
      return Boolean(current && (isGotIt ? isGotItLabel(normalizedGotItLabel(current)) : normalizedAdvanceLabel(current) === label));
    };
    const candidates = [];
    const seen = new Set();
    const add = (element) => {
      if (!(element instanceof Element) || seen.has(element) || !element.isConnected || !isVisible(element)) return;
      seen.add(element);
      candidates.push(element);
    };
    add(button);
    add(button.closest('button, a, [role="button"], input[type="button"], input[type="submit"], [data-cy], [data-testid], [class*="button" i], [tabindex]'));
    if (isGotIt) {
      for (const candidate of findGotItButtons()) {
        add(candidate);
        add(candidate.closest('button, a, [role="button"], input[type="button"], input[type="submit"], [data-cy], [data-testid], [class*="button" i], [tabindex]'));
      }
    }
    button.querySelectorAll?.('button, a, [role="button"], input, [tabindex], span').forEach(add);
    const buttonRect = button.getBoundingClientRect();
    const pointTarget = document.elementFromPoint(buttonRect.left + buttonRect.width / 2, buttonRect.top + buttonRect.height / 2);
    if (pointTarget && (button.contains(pointTarget) || pointTarget.contains(button))) {
      add(pointTarget);
      add(pointTarget.closest?.('button, a, [role="button"], input[type="button"], input[type="submit"], [data-cy], [data-testid], [class*="button" i], [tabindex]'));
    }
    let ancestor = button.parentElement;
    for (let depth = 0; ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
      const marker = `${ancestor.className?.baseVal ?? ancestor.className ?? ""} ${ancestor.getAttribute("role") || ""} ${ancestor.dataset?.cy || ""} ${ancestor.dataset?.testid || ""}`;
      if (ancestor.matches('button, a, [role="button"], [tabindex]') || /button|got.?it|continue|next/i.test(marker) || normalizedAdvanceLabel(ancestor) === label) add(ancestor);
    }

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!candidate.isConnected || !isVisible(candidate)) continue;
      if (index > 0) log("IXL kept the advance control visible; trying an alternate activation target.", { label, attempt: index + 1, tag: candidate.tagName, role: candidate.getAttribute("role") });
      clickElement(candidate);
      await delay(index === 0 ? 280 : 190);
      if (!sameAdvanceStillVisible()) return true;
    }

    const replacement = isGotIt ? findGotItButton() : findNextQuestionButton();
    if (replacement?.isConnected && isVisible(replacement)) {
      log("IXL still shows the advance control; trying Enter and Space before the next observer retry.", label);
      replacement.focus?.({ preventScroll: true });
      dispatchKeyboardSequence(replacement, ["Enter", " "]);
      await delay(240);
    }
    return !sameAdvanceStillVisible();
  }

  async function handleGotItAdvance(button, source = "auto loop") {
    transitionLoopState(LOOP_STATES.HANDLING_CORRECTION, { source });
    if (gotItHandling || !button?.isConnected) return false;
    gotItHandling = true;
    try {
      if (pendingAnswerCache) await learnFromIncorrectFeedback();
      gotItWatchAttempts += 1;
      log("Got it watchdog activating the incorrect-review control.", { source, attempt: gotItWatchAttempts, tag: button.tagName, label: getAccessibleName(button) });
      const advanced = await activateNextQuestionButton(button);
      if (advanced) {
        gotItWatchAttempts = 0;
        loopNextClicked = false;
        loopSawSubmitUnavailable = true;
        setStatus("Got it confirmed. Waiting for IXL's next question…", "success");
        wakeAutoLoop(100);
        return true;
      }
      loopNextClicked = false;
      setStatus("Got it is still visible. The watchdog will keep retrying automatically…");
      log("Got it remained visible after adaptive activation; watchdog retry remains armed.", { attempt: gotItWatchAttempts });
      return false;
    } finally {
      gotItHandling = false;
    }
  }

  function startGotItWatchdog() {
    if (gotItWatchTimer) clearInterval(gotItWatchTimer);
    gotItWatchTimer = setInterval(() => {
      if (!loopActive || busy || loopCycleRunning || gotItHandling) return;
      const review = detectIncorrectReviewState();
      if (review.active && review.gotIt) {
        loopWaitingForNext = true;
        loopSawSubmitUnavailable = true;
        void handleGotItAdvance(review.gotIt, "independent watchdog");
      }
    }, GOT_IT_WATCH_MS);
  }

  function stopGotItWatchdog() {
    if (gotItWatchTimer) clearInterval(gotItWatchTimer);
    gotItWatchTimer = null;
    gotItHandling = false;
    gotItWatchAttempts = 0;
  }

  function stopManualFeedbackWatch() {
    manualFeedbackObserver?.disconnect();
    manualFeedbackObserver = null;
    if (manualFeedbackTimeout) clearTimeout(manualFeedbackTimeout);
    manualFeedbackTimeout = null;
  }

  function watchManualSubmissionFeedback() {
    stopManualFeedbackWatch();
    let handling = false;
    const attempt = async () => {
      if (handling || !pendingAnswerCache) return;
      const next = findNextQuestionButton();
      const smartScore = findSmartScoreInfo();
      if (!next && smartScore?.score !== 100) return;
      handling = true;
      stopManualFeedbackWatch();
      if (next && isIncorrectAdvanceButton(next)) await learnFromIncorrectFeedback();
      else await commitPendingAnswerCache(smartScore?.score === 100 ? "SmartScore reached 100" : getAccessibleName(next));
    };
    manualFeedbackObserver = new MutationObserver(() => { void attempt(); });
    manualFeedbackObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden", "disabled", "aria-disabled", "aria-checked", "aria-selected"] });
    manualFeedbackTimeout = setTimeout(() => {
      stopManualFeedbackWatch();
      pendingAnswerCache = null;
      log("Manual submission feedback was not detected within 90 seconds; the unconfirmed answer was not cached.");
    }, 90000);
    void attempt();
  }

  function targetsLookResetForNextQuestion(targets) {
    return targets.every((target) => {
      const kind = targetKind(target);
      if (kind === "text") return comparableText(currentControlValue(target)) === "";
      if (["single-choice", "multi-choice", "choice", "grid-cell"].includes(kind)) return selectedState(target) !== true;
      if (kind === "dropdown" && target.tagName === "SELECT") return target.selectedIndex <= 0;
      return true;
    });
  }

  function questionReadyForAutoSolve(context) {
    const submit = findSubmitButton(context);
    if (!submit) {
      loopReadySignature = "";
      loopReadySince = 0;
      setStatus("New question content detected. Waiting for IXL to render its answer controls…");
      return false;
    }
    const signature = loopQuestionSignature(context);
    if (signature !== loopReadySignature) {
      loopReadySignature = signature;
      loopReadySince = Date.now();
      setStatus("Answer controls detected. Waiting briefly for IXL to finish attaching them…");
      return false;
    }
    const onlyPassiveCanvases = context.targets.length > 0
      && context.targets.every((element) => element.tagName === "CANVAS" && !isInteractiveGraphControl(element));
    const requiredStableTime = onlyPassiveCanvases ? 1800 : QUESTION_STABLE_MS;
    if (Date.now() - loopReadySince < requiredStableTime) return false;
    return true;
  }

  function findSmartScoreInfo() {
    const containers = new Set([
      ...document.querySelectorAll('[data-cy*="smartscore" i], [data-testid*="smartscore" i], [class*="smartscore" i], [aria-label*="smartscore" i]'),
    ]);
    const labels = [...document.querySelectorAll('aside *, main *, [role="main"] *')]
      .filter((element) => isVisible(element) && /^smart\s*score(?:\s*out of\s*100)?$/i.test(normalizedText(element)));
    for (const label of labels) {
      let container = label;
      for (let depth = 0; depth < 6 && container?.parentElement; depth += 1) {
        container = container.parentElement;
        if ([...container.querySelectorAll("*")].some((node) => /^\d{1,3}$/.test(normalizedText(node)))) {
          containers.add(container);
          break;
        }
      }
    }

    for (const container of containers) {
      if (!isVisible(container)) continue;
      const ariaText = `${container.getAttribute("aria-label") || ""} ${container.getAttribute("title") || ""}`;
      const ariaMatch = ariaText.match(/smart\s*score\D{0,30}(\d{1,3})\D+out of\D*100/i);
      if (ariaMatch && Number(ariaMatch[1]) <= 100) return { score: Number(ariaMatch[1]), element: container };

      const numericLeaves = [container, ...container.querySelectorAll("*")]
        .filter((node) => isVisible(node) && /^\d{1,3}$/.test(normalizedText(node)) && Number(normalizedText(node)) <= 100)
        .map((node) => {
          const rect = node.getBoundingClientRect();
          const fontSize = Number.parseFloat(getComputedStyle(node).fontSize) || 0;
          return { node, score: Number(normalizedText(node)), rank: fontSize * 4 + rect.height + rect.width / 10 };
        })
        .sort((left, right) => right.rank - left.rank);
      if (numericLeaves.length) return { score: numericLeaves[0].score, element: numericLeaves[0].node };
    }
    return null;
  }

  function findTeacherTarget() {
    const candidates = [...document.querySelectorAll('a, button, [role="button"], [role="tab"], h1, h2, h3, h4, div, span')]
      .filter((element) => isVisible(element) && !element.closest(`#${PANEL_ID}, #${COMPLETION_MODAL_ID}`));
    const label = candidates.find((element) => /^from your teacher$/i.test(getAccessibleName(element).replace(/\s+/g, " ").trim()))
      || candidates.find((element) => /^from your teacher$/i.test(normalizedText(element)));
    if (!label) return null;
    const clickable = label.matches('a, button, [role="button"], [role="tab"]')
      ? label
      : label.closest('a, button, [role="button"], [role="tab"]') || label;
    const highlight = clickable.closest('section, article, li, [class*="teacher" i], [data-testid*="teacher" i]') || clickable;
    return {
      clickable,
      highlight,
      kind: "teacher",
      label: "From your teacher",
      buttonText: "Open From your teacher",
      note: "",
    };
  }

  function findMyIxlTarget() {
    const candidates = [...document.querySelectorAll('a, button, [role="button"], [role="link"], [role="tab"]')]
      .filter((element) => isVisible(element)
        && !element.disabled
        && element.getAttribute("aria-disabled") !== "true"
        && !element.closest(`#${PANEL_ID}, #${COMPLETION_MODAL_ID}`));
    return candidates.find((element) => /^my ixl$/i.test(getAccessibleName(element).replace(/\s+/g, " ").trim()))
      || candidates.find((element) => /\/dashboard\/?(?:[?#].*)?$/i.test(element.href || element.getAttribute("href") || ""))
      || null;
  }

  function saveTeacherHandoff() {
    GM_setValue(TEACHER_HANDOFF_KEY, {
      pending: true,
      createdAt: Date.now(),
      expiresAt: Date.now() + 2 * 60 * 1000,
    });
  }

  function readTeacherHandoff() {
    try {
      const value = GM_getValue(TEACHER_HANDOFF_KEY, null);
      if (!value?.pending || Number(value.expiresAt) <= Date.now()) {
        if (value) GM_setValue(TEACHER_HANDOFF_KEY, null);
        return null;
      }
      return value;
    } catch (_error) {
      return null;
    }
  }

  function clearTeacherHandoff() {
    try { GM_setValue(TEACHER_HANDOFF_KEY, null); } catch (_error) { /* Ignore unavailable storage. */ }
  }

  function resumeTeacherHandoff() {
    const pending = readTeacherHandoff();
    if (!pending || !/^\/dashboard\/?$/i.test(location.pathname)) return;
    setStatus("My IXL opened. Waiting for From your teacher…", "success");
    let finished = false;
    let observer = null;
    let timeout = null;
    const attempt = () => {
      if (finished) return true;
      const teacher = findTeacherTarget();
      if (!teacher?.clickable?.isConnected) return false;
      finished = true;
      observer?.disconnect();
      if (timeout) clearTimeout(timeout);
      clearTeacherHandoff();
      teacher.highlight.classList.add("iah-teacher-highlight");
      teacher.highlight.scrollIntoView({ block: "center", inline: "nearest" });
      clickElement(teacher.clickable);
      setStatus("Opened My IXL → From your teacher. Auto loop is stopped; choose the next assigned IXL, then start the loop manually.", "success");
      log("Completed the confirmed My IXL → From your teacher handoff; auto loop remains stopped.");
      return true;
    };
    if (attempt()) return;
    observer = new MutationObserver(attempt);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "class", "aria-selected"] });
    timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTeacherHandoff();
      setStatus('My IXL opened, but “From your teacher” did not appear within 45 seconds. Auto loop remains stopped.', "error");
      log("Teacher handoff expired because the dashboard button did not appear.");
    }, 45000);
  }

  function findCompletionNavigationTarget() {
    const myIxl = findMyIxlTarget();
    if (myIxl) {
      return {
        clickable: myIxl,
        highlight: myIxl,
        kind: "my-ixl-teacher",
        label: "My IXL → From your teacher",
        buttonText: "Open My IXL → From your teacher",
        note: "After confirmation, the helper will open My IXL and then click From your teacher. The answer loop will remain stopped.",
      };
    }
    return null;
  }

  function clearCompletionPrompt() {
    document.getElementById(COMPLETION_MODAL_ID)?.remove();
    document.querySelectorAll(".iah-teacher-highlight").forEach((element) => element.classList.remove("iah-teacher-highlight"));
  }

  function showCompletionPrompt(completionTarget) {
    document.getElementById(COMPLETION_MODAL_ID)?.remove();
    const modal = document.createElement("div");
    modal.id = COMPLETION_MODAL_ID;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", `${COMPLETION_MODAL_ID}-title`);
    modal.innerHTML = `
      <div class="iah-modal-card">
        <h2 id="${COMPLETION_MODAL_ID}-title">SmartScore 100 reached</h2>
        <p>Do you want to start another IXL?</p>
        <div class="iah-modal-actions">
          <button type="button" data-choice="no">Stay here</button>
          <button type="button" data-choice="yes"${completionTarget ? "" : " disabled"}>${completionTarget?.buttonText || "No next IXL found"}</button>
        </div>
        ${completionTarget?.note ? `<p style="margin-top:12px">${completionTarget.note}</p>` : ""}
        ${completionTarget ? "" : '<p style="margin-top:12px;color:#b42318">The My IXL link was not found on this page.</p>'}
      </div>`;
    document.body.appendChild(modal);
    modal.querySelector('[data-choice="no"]').addEventListener("click", () => {
      modal.remove();
      setStatus("SmartScore 100 reached. Auto loop is stopped.", "success");
    });
    const yes = modal.querySelector('[data-choice="yes"]');
    yes.addEventListener("click", () => {
      if (!completionTarget?.clickable?.isConnected) return;
      if (completionTarget.kind === "my-ixl-teacher") saveTeacherHandoff();
      modal.remove();
      completionTarget.highlight?.classList.remove("iah-teacher-highlight");
      clickElement(completionTarget.clickable);
      setStatus(`Opened ${completionTarget.label}. Auto loop is still stopped; start it manually on the next IXL.`, "success");
      log(`Manual confirmation opened ${completionTarget.label}; the answer loop remains stopped.`, { kind: completionTarget.kind });
    });
    (yes.disabled ? modal.querySelector('[data-choice="no"]') : yes).focus();
  }

  function handleSmartScoreCompletion() {
    const smartScore = findSmartScoreInfo();
    if (!smartScore || smartScore.score !== 100) return false;
    if (completionPromptShown) return true;
    completionPromptShown = true;
    transitionLoopState(LOOP_STATES.SMARTSCORE_COMPLETE);
    void commitPendingAnswerCache("SmartScore reached 100");
    stopAutoLoop("SmartScore 100 reached. Auto loop stopped for manual confirmation.", "success");
    const completionTarget = findCompletionNavigationTarget();
    if (completionTarget) {
      completionTarget.highlight.classList.add("iah-teacher-highlight");
      completionTarget.highlight.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
    showCompletionPrompt(completionTarget);
    log("SmartScore 100 detected; waiting for manual confirmation.", {
      navigationTarget: completionTarget?.kind || "none",
      navigationLabel: completionTarget?.label || null,
    });
    return true;
  }

  function updateLoopUi() {
    if (!ui?.loop) return;
    ui.loop.textContent = loopActive ? "Stop auto loop" : "Start auto loop";
    ui.loop.classList.toggle("iah-primary", loopActive);
  }

  function scheduleAutoLoop(milliseconds = 0) {
    if (!loopActive) return;
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = setTimeout(() => {
      loopTimer = null;
      runAutoLoopCycle();
    }, Math.max(0, milliseconds));
  }

  function wakeAutoLoop(milliseconds = 120) {
    if (!loopActive || loopCycleRunning || loopTimer) return;
    scheduleAutoLoop(milliseconds);
  }

  function startLoopObserver() {
    loopObserver?.disconnect();
    loopObserver = new MutationObserver((mutations) => {
      const relevant = mutations.some((mutation) => {
        const target = mutation.target?.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target?.parentElement;
        return !target?.closest?.(`#${PANEL_ID}`);
      });
      if (relevant) wakeAutoLoop(120);
    });
    loopObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["disabled", "aria-disabled", "aria-checked", "aria-selected", "hidden", "class"],
    });
  }

  function clearUsageRetryCountdown() {
    if (usageCountdownTimer) clearInterval(usageCountdownTimer);
    usageCountdownTimer = null;
    usageRetryAt = 0;
  }

  function usageRetryCountdownText() {
    const remainingSeconds = Math.max(0, Math.ceil((usageRetryAt - Date.now()) / 1000));
    const minutes = Math.floor(remainingSeconds / 60);
    const seconds = remainingSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function updateUsageRetryStatus() {
    if (!loopActive || !usageRetryAt) return;
    setStatus(`API usage limit reached. Retrying this question in ${usageRetryCountdownText()}. Auto loop remains active.`);
  }

  function scheduleUsageLimitRetry(outcome = {}) {
    transitionLoopState(LOOP_STATES.USAGE_LIMIT_WAIT, { reason: outcome.reason || "usage limit" });
    if (!loopActive) return;
    if (loopTimer) clearTimeout(loopTimer);
    clearUsageRetryCountdown();
    usageRetryAt = Date.now() + USAGE_RETRY_MS;
    updateUsageRetryStatus();
    usageCountdownTimer = setInterval(updateUsageRetryStatus, 1000);
    loopTimer = setTimeout(() => {
      loopTimer = null;
      clearUsageRetryCountdown();
      if (!loopActive) return;
      setStatus("One-minute API wait finished. Retrying the same question now…", "success");
      log("One-minute API usage wait finished; retrying the same question.");
      runAutoLoopCycle();
    }, USAGE_RETRY_MS);
    log("API usage limit reached; auto loop will retry in one minute and will keep retrying.", {
      status: outcome.status || null,
      reason: outcome.reason || "Provider usage limit",
      retryMilliseconds: USAGE_RETRY_MS,
    });
  }

  function scheduleAiOrActionRetry(outcome = {}) {
    transitionLoopState(LOOP_STATES.WAITING_FOR_QUESTION, { retry: true, reason: outcome.reason || "retryable failure" });
    if (!loopActive) return;
    if (outcome.partialFill && lastContext && lastSnapshot) rollback();
    loopAiRetryCount += 1;
    const retryMilliseconds = Math.min(AI_RETRY_MAX_MS, 1500 * (2 ** Math.min(4, loopAiRetryCount - 1)));
    const reason = outcome.reason || outcome.message || "The solver/verifier did not produce a usable confirmed action.";
    loopRetryFeedback = reason;
    if (lastContext) updateAdaptiveDebugger(lastContext, {
      state: "retry-scheduled",
      lastFailure: { reason, stage: outcome.stage || null, retryableActionError: Boolean(outcome.retryableActionError), attempt: loopAiRetryCount },
    });
    const seconds = Math.max(1, Math.ceil(retryMilliseconds / 1000));
    setStatus(`${outcome.retryableActionError ? "IXL did not confirm the answer action" : "AI/verifier attempt failed"}. Retrying the same question in ${seconds} second${seconds === 1 ? "" : "s"}. Auto loop remains active.`);
    log("Retryable solver/verifier/action failure; auto loop will try the same question again.", {
      attempt: loopAiRetryCount,
      retryMilliseconds,
      retryType: outcome.retryableActionError ? "IXL action confirmation" : "AI/verifier",
      reason,
    });
    scheduleAutoLoop(retryMilliseconds);
  }

  function persistAutoLoopSession(active) {
    if (!active) {
      try { sessionStorage.removeItem(AUTO_LOOP_SESSION_KEY); } catch (_error) { /* Ignore locked storage. */ }
      return;
    }
    writeSessionObject(AUTO_LOOP_SESSION_KEY, {
      active: true,
      savedAt: Date.now(),
      hostname: location.hostname,
      path: location.pathname,
    });
  }

  function resumeAutoLoopAcrossPageNavigation() {
    const state = readSessionObject(AUTO_LOOP_SESSION_KEY);
    if (!state.active || state.hostname !== location.hostname || Date.now() - Number(state.savedAt || 0) > 4 * 60 * 60 * 1000) {
      persistAutoLoopSession(false);
      return;
    }
    setTimeout(() => {
      if (!loopActive && !completionPromptShown) startAutoLoop({ resumed: true });
    }, 800);
  }

  function stopAutoLoop(message = "Auto loop stopped.", tone = "") {
    loopActive = false;
    loopWaitingForNext = false;
    loopCycleRunning = false;
    loopSawSubmitUnavailable = false;
    loopNextClicked = false;
    loopSubmittedAt = 0;
    loopReadySignature = "";
    loopReadySince = 0;
    loopAiRetryCount = 0;
    loopRetryFeedback = "";
    pendingAnswerCache = null;
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = null;
    clearUsageRetryCountdown();
    stopGotItWatchdog();
    loopObserver?.disconnect();
    loopObserver = null;
    transitionLoopState(LOOP_STATES.STOPPED);
    persistAutoLoopSession(false);
    updateLoopUi();
    if (message) setStatus(message, tone);
    log(message || "Auto loop stopped.");
  }

  function startAutoLoop(options = {}) {
    readConfigFromPanel();
    if (!config.endpoint || !config.model || (requiresApiKey(config.endpoint) && !config.apiKey)) {
      ui.settings.classList.add("open");
      setStatus(requiresApiKey(config.endpoint) ? "Add the API key, endpoint, and model before starting the loop." : "Add the endpoint and model before starting the loop.", "error");
      return;
    }
    config.mode = "fill";
    config.autoSubmit = true;
    config.verifyBeforeSubmit = true;
    ui.fields.mode.value = "fill";
    ui.fields.autoSubmit.checked = true;
    ui.fields.verifyBeforeSubmit.checked = true;
    saveConfig();
    clearCompletionPrompt();
    completionPromptShown = false;
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = null;
    clearUsageRetryCountdown();
    loopActive = true;
    transitionLoopState(LOOP_STATES.WAITING_FOR_PAGE, { resumed: Boolean(options.resumed) });
    persistAutoLoopSession(true);
    loopWaitingForNext = false;
    loopLastRoot = null;
    loopLastQuestionSignature = "";
    loopSawSubmitUnavailable = false;
    loopNextClicked = false;
    loopSubmittedAt = 0;
    loopReadySignature = "";
    loopReadySince = 0;
    loopAiRetryCount = 0;
    loopRetryFeedback = "";
    startLoopObserver();
    startGotItWatchdog();
    updateLoopUi();
    setStatus(options.resumed ? "Auto loop resumed after page navigation. Looking for the current question…" : "Auto loop started. Looking for the current question…", "success");
    log(options.resumed ? "Auto loop resumed across an IXL page navigation." : "Auto loop started.", { nextQuestionDetection: "DOM observer", verifiedSubmissionRequired: true, crossPageSession: true });
    scheduleAutoLoop(0);
  }

  async function runAutoLoopCycle() {
    if (!loopActive || loopCycleRunning) return;
    if (busy) {
      scheduleAutoLoop(300);
      return;
    }
    loopCycleRunning = true;
    try {
      if (handleSmartScoreCompletion()) return;

      // Feedback/review screens can retain the previous question's controls.
      // Always classify and clear them before looking for an answer root so the
      // solver can never send IXL's correction page to the AI as a new problem.
      const review = detectIncorrectReviewState();
      if (review.active) {
        transitionLoopState(LOOP_STATES.HANDLING_CORRECTION);
        loopWaitingForNext = true;
        loopNextClicked = false;
        loopSawSubmitUnavailable = true;
        loopReadySignature = "";
        loopReadySince = 0;
        if (review.gotIt) {
          const advanced = await handleGotItAdvance(review.gotIt, "pre-solve review gate");
          scheduleAutoLoop(advanced ? 150 : 450);
        } else {
          setStatus("IXL's incorrect-answer review is open. Waiting for its Got it control…");
          scheduleAutoLoop(450);
        }
        return;
      }

      const root = findQuestionRoot();
      const targets = root ? collectTargets(root) : [];

      if (loopWaitingForNext) {
        transitionLoopState(LOOP_STATES.WAITING_FOR_NEXT);
        if (loopSubmittedAt && Date.now() - loopSubmittedAt > 90000) {
          const stuckGotIt = findGotItButton();
          if (stuckGotIt) {
            loopSubmittedAt = Date.now();
            loopNextClicked = false;
            log("The next-question timeout was suppressed because Got it is still visible; watchdog retries will continue.");
            await handleGotItAdvance(stuckGotIt, "timeout recovery");
            scheduleAutoLoop(450);
            return;
          }
          stopAutoLoop("Auto loop stopped: IXL did not present another question within 90 seconds.", "error");
          return;
        }
        const next = findNextQuestionButton();
        if (next && !loopNextClicked) {
          const incorrectAdvance = isIncorrectAdvanceButton(next);
          loopNextClicked = true;
          loopSawSubmitUnavailable = true;
          if (incorrectAdvance) {
            const advanced = await handleGotItAdvance(next, "main loop cycle");
            if (!advanced) loopNextClicked = false;
            scheduleAutoLoop(advanced ? 150 : 450);
            return;
          }
          await commitPendingAnswerCache(getAccessibleName(next));
          log("Auto loop advancing to the next question.", getAccessibleName(next));
          const advanced = await activateNextQuestionButton(next);
          if (!advanced) {
            loopNextClicked = false;
            setStatus(`${incorrectAdvance ? "Got it" : "Next"} is still visible. Retrying automatically…`);
            log("IXL did not dismiss the advance control; the loop will retry instead of marking it complete.", { label: getAccessibleName(next) });
            scheduleAutoLoop(450);
            return;
          }
          scheduleAutoLoop(150);
          return;
        }

        if (detectIncorrectReviewState().active) {
          loopWaitingForNext = true;
          loopNextClicked = false;
          loopSawSubmitUnavailable = true;
          setStatus("IXL's incorrect-review screen is still open. Waiting for the Got it watchdog…");
          scheduleAutoLoop(450);
          return;
        }

        if (!root || !targets.length) {
          loopSawSubmitUnavailable = true;
          if (await advanceStandaloneReadingPageIfReady()) {
            scheduleAutoLoop(700);
            return;
          }
          scheduleAutoLoop(1000);
          return;
        }

        const context = makeContext(root, targets);
        const signature = loopQuestionSignature(context);
        const submitReady = Boolean(findSubmitButton(context));
        if (!submitReady) loopSawSubmitUnavailable = true;
        const freshQuestion = root !== loopLastRoot
          || (loopNextClicked && signature !== loopLastQuestionSignature)
          || (loopSawSubmitUnavailable && submitReady)
          || (Date.now() - loopSubmittedAt > 1500 && signature !== loopLastQuestionSignature && targetsLookResetForNextQuestion(targets));
        if (!freshQuestion) {
          scheduleAutoLoop(1000);
          return;
        }
        await commitPendingAnswerCache("a new question appeared");
        loopWaitingForNext = false;
        loopSawSubmitUnavailable = false;
        loopNextClicked = false;
        loopReadySignature = "";
        loopReadySince = 0;
        setStatus("Next question detected. Solving now…", "success");
        scheduleAutoLoop(150);
        return;
      }

      if (!root || !targets.length) {
        transitionLoopState(LOOP_STATES.WAITING_FOR_QUESTION);
        if (await advanceStandaloneReadingPageIfReady()) {
          scheduleAutoLoop(700);
          return;
        }
        setStatus("Auto loop is waiting for a visible question…");
        scheduleAutoLoop(1000);
        return;
      }

      const context = makeContext(root, targets);
      if (!questionReadyForAutoSolve(context)) {
        scheduleAutoLoop(Math.max(120, QUESTION_STABLE_MS - Math.max(0, Date.now() - loopReadySince)));
        return;
      }
      loopLastRoot = root;
      loopLastQuestionSignature = loopQuestionSignature(context);
      await startAnswer({ fromLoop: true });
      if (!loopActive) return;
      if (lastSolveOutcome?.reviewHandled) {
        loopWaitingForNext = true;
        loopSawSubmitUnavailable = true;
        loopNextClicked = false;
        scheduleAutoLoop(lastSolveOutcome.advanced ? 150 : 450);
        return;
      }
      if (!lastSolveOutcome?.ok || !lastSolveOutcome.submitted) {
        if (lastSolveOutcome?.retryableUsageLimit) {
          scheduleUsageLimitRetry(lastSolveOutcome);
          return;
        }
        if (lastSolveOutcome?.retryableAiError || lastSolveOutcome?.retryableActionError) {
          scheduleAiOrActionRetry(lastSolveOutcome);
          return;
        }
        const reason = lastSolveOutcome?.reason || "The question was not safely submitted.";
        stopAutoLoop(`Auto loop stopped: ${reason}`, "error");
        return;
      }
      loopWaitingForNext = true;
      loopSawSubmitUnavailable = false;
      loopNextClicked = false;
      loopSubmittedAt = Date.now();
      loopReadySignature = "";
      loopReadySince = 0;
      loopAiRetryCount = 0;
      loopRetryFeedback = "";
      setStatus("Answer verified and submitted. Waiting for the next question…", "success");
      transitionLoopState(LOOP_STATES.WAITING_FOR_FEEDBACK);
      scheduleAutoLoop(250);
    } catch (error) {
      if (isUsageLimitError(error)) {
        scheduleUsageLimitRetry({ status: error?.status, reason: error?.message || String(error) });
      } else if (isRetryableTargetError(error)) {
        scheduleAiOrActionRetry({ reason: error?.message || String(error), retryableActionError: true, partialFill: true });
      } else if (isRetryableAiError(error)) {
        scheduleAiOrActionRetry({ reason: error?.message || String(error), retryableAiError: true });
      } else {
        stopAutoLoop(`Auto loop stopped: ${error?.message || error}`, "error");
      }
    } finally {
      loopCycleRunning = false;
    }
  }

  async function startAnswer(options = {}) {
    if (busy) return;
    let solveStage = "setup";
    lastSolveOutcome = { ok: false, submitted: false, reason: "Solve did not complete." };
    readConfigFromPanel();

    // The review can appear during the short gap between the loop's pre-solve
    // gate and this function. Guard the manual Solve button as well, so no
    // entry point can send feedback/explanation content to the provider.
    const review = detectIncorrectReviewState();
    if (review.active) {
      let advanced = false;
      if (review.gotIt) advanced = await handleGotItAdvance(review.gotIt, options.fromLoop ? "solve race guard" : "manual solve review guard");
      else setStatus("This is IXL's incorrect-answer review, not a new academic question. Waiting for the Got it control…");
      lastSolveOutcome = {
        ok: false,
        submitted: false,
        reviewHandled: true,
        advanced,
        reason: "IXL's incorrect-answer review was handled before solving.",
      };
      return;
    }

    const root = findQuestionRoot();
    if (!root) {
      setStatus("Could not find a visible IXL answer area. Open a practice question and try again.", "error");
      lastSolveOutcome.reason = "No visible IXL answer area was found.";
      return;
    }
    const targets = collectTargets(root);
    if (!targets.length) {
      setStatus("The question was found, but no supported answer controls were visible.", "error");
      lastSolveOutcome.reason = "No supported answer controls were visible.";
      return;
    }

    const context = makeContext(root, targets);
    lastContext = context;
    lastSnapshot = snapshotTargets(context);
    busy = true;
    ui.start.disabled = true;
    ui.answer.style.display = "none";
    startProgress();
    setStatus(`Reading question (${targets.length} answer target${targets.length === 1 ? "" : "s"})…`);
    log("Question root and targets detected.", { root: root.tagName, targets: context.descriptors });
    let solveIdentity = null;

    try {
      transitionLoopState(LOOP_STATES.EXTRACTING, { targets: targets.length });
      const problemIR = buildProblemIR(context);
      beginSolveTrace(context, problemIR);
      traceSolveStage("structured-extraction", { subject: problemIR.subject, questionType: problemIR.questionType, quantities: problemIR.quantities.length, targetKinds: problemIR.targets.map((target) => target.kind), articleFingerprint: problemIR.passage?.fingerprint || null });
      solveStage = "cache";
      transitionLoopState(LOOP_STATES.CACHE_LOOKUP);
      setStatus("Identifying the exact question and checking the answer cache…");
      const identity = await identifyQuestion(context, problemIR);
      solveIdentity = identity;
      const cacheHit = await lookupAnswerCache(identity, context);
      let imageDataUrl = null;
      let answer = cacheHit?.answer || null;
      const providerSession = createApiProviderSession();
      lastSolveProvider = null;
      if (answer) {
        traceSolveStage("exact-cache-hit", { location: cacheHit.location, source: cacheHit.record.answer_source });
        log("Exact answer-cache hit; skipping the solver and verifier APIs.", { questionHash: identity.hash, cache: cacheHit.location, source: cacheHit.record.answer_source, actions: answer.actions.length });
        setStatus(`Exact question found in the ${cacheHit.location} cache. No AI API request used.`, "success");
      } else {
        const semanticHit = await lookupSemanticAnswerCache(identity);
        const shouldCaptureScreenshot = Boolean(config.includeScreenshot
          || (config.screenshotFallback !== false && context.domEvidence?.screenshotRecommended));
        if (shouldCaptureScreenshot) {
          const capability = await getOllamaModelCapabilities(providerSession.current);
          if (capability.supportsVision) {
            imageDataUrl = config.includeScreenshot ? await captureQuestionImage(context.captureRoot || root, true) : await captureTargetedQuestionImage(context);
          } else {
            const capabilities = capability.capabilities.length ? capability.capabilities.join(", ") : "vision not reported";
            log(`Screenshot skipped: Ollama model "${providerSession.current.model}" is text-only.`, { capabilities, provider: providerSession.current.label });
          }
        } else {
          log("DOM evidence is sufficient; screenshot fallback was not used.", { score: context.domEvidence?.score, reason: context.domEvidence?.reason });
        }
        updateAdaptiveDebugger(context, {
          screenshotDecision: {
            requested: shouldCaptureScreenshot,
            captured: Boolean(imageDataUrl),
            domEvidenceScore: context.domEvidence?.score,
            reason: context.domEvidence?.reason,
          },
        });
        let solution = semanticHit?.solution || solveDeterministicMath(problemIR);
        if (semanticHit) traceSolveStage("semantic-cache-candidate", { location: semanticHit.location, source: semanticHit.record.answer_source });
        if (solution && !semanticHit) traceSolveStage("deterministic-solve", { source: solution.source, answer: solution.finalAnswer });
        if (!solution) {
          if (requiresApiKey(config.endpoint) && !config.apiKey) {
            ui.settings.classList.add("open");
            throw new Error("No verified cached or deterministic answer was found, and the API key is missing.");
          }
          if (!config.endpoint || !config.model) {
            ui.settings.classList.add("open");
            throw new Error("No verified cached or deterministic answer was found, and the API endpoint or model is missing.");
          }
          transitionLoopState(LOOP_STATES.SOLVING);
          solveStage = "solver";
          setStatus(imageDataUrl ? "Targeted visual evidence captured. Solving the structured problem…" : "Structured question extracted. Solving semantically…");
          const response = await requestWithUsageFailover(makeSemanticSolvePrompt(problemIR, providerSession.current), imageDataUrl, providerSession, config.model, "semantic solver", "semantic");
          const raw = extractResponseText(response);
          assertModelResponseIsUsable(raw, "Semantic solver");
          solution = parseSemanticSolution(raw);
          traceSolveStage("semantic-ai-solve", { answer: solution.finalAnswer, confidence: solution.confidence });
        }
        transitionLoopState(LOOP_STATES.VERIFYING);
        solveStage = "verifier";
        solution = await independentlyVerifySemanticSolution(solution, context, problemIR, imageDataUrl, providerSession);
        traceSolveStage("semantic-verification", { verification: solution.verification, confidence: solution.confidence, evidenceIds: solution.evidence?.map((item) => item.segmentId) || [] });
        transitionLoopState(LOOP_STATES.PLANNING_ACTIONS);
        solveStage = "answer-mapping";
        answer = await planSemanticAnswerActions(solution, context, problemIR, providerSession);
        traceSolveStage("action-plan", { actions: answer.actions.map((action) => ({ type: actionType(action), target: action.target })) });
      }
      showAnswer(answer);

      if (options.fromLoop && !loopActive) throw new Error("Auto loop was stopped before the answer could be applied.");

      if (config.mode === "display") {
        setStatus(`Answer ready (${Math.round(answer.confidence * 100)}% model confidence).`, "success");
        lastSolveOutcome = { ok: true, submitted: false, reason: "Display-only mode does not submit answers." };
        return;
      }
      if (!answer.actions.length) {
        setStatus("The answer is displayed, but the model could not map it to a visible control.", "error");
        lastSolveOutcome = {
          ok: false,
          submitted: false,
          reason: "The model did not map the answer to a visible control.",
          retryableAiError: !cacheHit,
        };
        return;
      }

      solveStage = "apply";
      transitionLoopState(LOOP_STATES.APPLYING);
      const result = await applyActions(answer, context);
      if (result.errors.length || result.verified !== answer.actions.length) {
        if (cacheHit) {
          const invalidHash = cacheHit.record?.question_hash || identity.hash;
          await invalidateCachedAnswer(invalidHash, result.errors.join(" ") || "live action mismatch");
          log("Quarantined a cache entry because its actions no longer matched IXL's live controls.", { questionHash: invalidHash });
        }
        log("Some answer actions failed.", result.errors);
        setStatus(`Verified ${result.verified}/${answer.actions.length} answer action(s). Nothing was submitted. ${result.errors.join(" ")}`, "error");
        lastSolveOutcome = {
          ok: false,
          submitted: false,
          reason: result.errors.join(" ") || "Not every answer action was verified.",
          retryableActionError: true,
          partialFill: result.applied > 0,
        };
        return;
      }

      if (config.autoSubmit) {
        const minimumConfidence = config.verifyBeforeSubmit ? 0.72 : 0.65;
        if (answer.confidence < minimumConfidence) {
          setStatus(`Filled ${result.applied} action(s), but did not auto-submit because confidence was only ${Math.round(answer.confidence * 100)}%.`, "success");
          lastSolveOutcome = {
            ok: false,
            submitted: false,
            reason: `Model confidence was only ${Math.round(answer.confidence * 100)}%.`,
            retryableAiError: !cacheHit,
            retryableActionError: Boolean(cacheHit),
            partialFill: result.applied > 0,
          };
          return;
        }
        if (options.fromLoop && !loopActive) throw new Error("Auto loop was stopped before submission.");
        transitionLoopState(LOOP_STATES.SUBMITTING);
        await autoSubmit(context, result);
        pendingAnswerCache = {
          identity,
          answer,
          context,
          cacheSource: cacheHit?.record?.answer_source || "model",
          cacheRecord: cacheHit?.record || null,
          submittedAt: Date.now(),
        };
        if (!options.fromLoop) watchManualSubmissionFeedback();
        setStatus(`Verified, filled, and submitted ${result.verified} action(s).`, "success");
        lastSolveOutcome = { ok: true, submitted: true, reason: cacheHit ? "Cached answer applied and submitted without an AI request." : "Answer verified and submitted.", fingerprint: context.fingerprint, questionHash: identity.hash, cacheHit: Boolean(cacheHit) };
        transitionLoopState(LOOP_STATES.WAITING_FOR_FEEDBACK);
      } else {
        setStatus(`Verified and filled ${result.verified} action(s). Review it, then press Check.`, "success");
        lastSolveOutcome = { ok: true, submitted: false, reason: "Auto-submit is disabled." };
      }
    } catch (error) {
      const message = error?.message || String(error);
      const retryableActionError = isRetryableTargetError(error, solveStage);
      log("Solve failed.", message);
      setStatus(message, "error");
      lastSolveOutcome = {
        ok: false,
        submitted: false,
        reason: message,
        status: Number(error?.status) || null,
        retryableUsageLimit: isUsageLimitError(error),
        retryableActionError,
        retryableAiError: !retryableActionError && isRetryableAiError(error, solveStage),
        partialFill: retryableActionError && solveStage === "apply",
        stage: solveStage,
      };
    } finally {
      saveSolveAttempt(lastSolveOutcome?.ok ? (lastSolveOutcome.submitted ? "submitted" : "completed") : "failed", { questionHash: solveIdentity?.hash || null, semanticHash: solveIdentity?.semanticHash || null, stage: solveStage, reason: lastSolveOutcome?.reason || "" });
      busy = false;
      ui.start.disabled = false;
      stopProgress();
    }
  }

  function rollback() {
    if (!lastContext || !lastSnapshot) {
      setStatus("Nothing has been filled yet.", "error");
      return;
    }
    let restored = 0;
    for (const state of lastSnapshot) {
      const element = lastContext.targets[state.target];
      if (!element?.isConnected) continue;
      try {
        if (state.selectedIndex !== null && element.tagName === "SELECT") {
          element.selectedIndex = state.selectedIndex;
          element.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (state.checked !== null && "checked" in element) {
          if (Boolean(element.checked) !== Boolean(state.checked)) clickElement(element);
        } else if (targetKind(element) === "text" || targetKind(element) === "slider") {
          setNativeValue(element, state.value ?? "");
        } else {
          const nowSelected = element.getAttribute("aria-checked") === "true" || element.getAttribute("aria-pressed") === "true";
          const wasSelected = state.ariaChecked === "true" || state.ariaPressed === "true";
          if (nowSelected !== wasSelected) clickElement(element);
        }
        restored += 1;
      } catch (error) {
        log("Rollback target failed.", { target: state.target, error: String(error) });
      }
    }
    setStatus(`Rolled back ${restored} answer control(s).`, restored ? "success" : "error");
  }

  async function runBuiltInReplayTests() {
    const results = [];
    const check = (name, run) => {
      try {
        const value = run();
        const ok = value && typeof value === "object" && "actual" in value && "expected" in value ? value.actual === value.expected : Boolean(value);
        results.push({ name, ok, value });
      }
      catch (error) { results.push({ name, ok: false, error: String(error?.message || error) }); }
    };
    const baseIr = (prompt, overrides = {}) => ({ schema: 1, solverProfile: "adaptive", subject: "mathematics", questionType: "constructed-response", prompt, math: prompt, tables: [], quantities: [], constraints: extractQuestionConstraints(prompt), targets: [{ id: "t0", target: 0, kind: "text", role: "answer", label: "", options: [], items: [], graphDescription: "" }], passage: null, visualDependency: false, ...overrides });
    check("arithmetic order of operations", () => solveDeterministicMath(baseIr("What is 8 + 3 × 4?"))?.finalAnswer === "20");
    check("GCF factoring and symbolic form", () => solveDeterministicMath(baseIr("Factor 45 + 75. Write your answer in the form a(b + c) where a is the GCF."))?.finalAnswer === "15(3+5)");
    check("percent", () => solveDeterministicMath(baseIr("What is 35% of 240?"))?.finalAnswer === "84");
    check("word problem: constant rate", () => solveDeterministicMath(baseIr("A train travels 120 miles in 3 hours. At the same rate, how far does it travel in 5 hours?"))?.finalAnswer === "200");
    check("word problem: rectangle", () => solveDeterministicMath(baseIr("A rectangle has length 12 feet and width 7 feet. What is its area?"))?.finalAnswer === "84");
    check("linear table", () => ({ actual: solveDeterministicMath(baseIr("Is the function linear or nonlinear?", {
      tables: [[
        [{ text: "x" }, { text: "y" }],
        [{ text: "0" }, { text: "5" }],
        [{ text: "8" }, { text: "9" }],
        [{ text: "20" }, { text: "15" }],
      ]],
    }))?.finalAnswer, expected: "linear" }));
    const readingA = { ...baseIr("According to the article, why did Maya leave?"), subject: "reading-language-arts", questionType: "reading-comprehension", passage: { fingerprint: "article-a", title: "A", segments: [{ id: "p1-s1", text: "Maya left because the storm was approaching." }] } };
    const readingB = { ...readingA, passage: { fingerprint: "article-b", title: "B", segments: [{ id: "p1-s1", text: "Maya stayed home to finish her project." }] } };
    check("reading evidence binding", () => verifyReadingEvidence({ finalAnswer: "the storm", answerValues: ["the storm"], explanation: "The storm approached.", confidence: .9, evidence: [{ segmentId: "p1-s1", quote: "storm was approaching" }], graphObjects: [] }, readingA).evidence.length === 1);
    const hashA = await sha256Hex(JSON.stringify(semanticProblemShape(readingA)));
    const hashB = await sha256Hex(JSON.stringify(semanticProblemShape(readingB)));
    check("article fingerprints cannot mix", () => hashA !== hashB);
    const choiceContext = { descriptors: [{ target: 0, kind: "single-choice", label: "nonlinear" }, { target: 1, kind: "single-choice", label: "linear" }] };
    check("reordered choice planning", () => ({ actual: planActionsFromSemanticSolution(semanticSolution("linear", "", { answerValues: ["linear"] }), choiceContext).actions[0]?.target, expected: 1 }));
    const blanks = { descriptors: [{ target: 0, kind: "text", label: "", contextText: "denominator" }, { target: 1, kind: "text", label: "", contextText: "numerator" }], targets: [], root: document.body };
    check("multiple blank planning", () => planActionsFromSemanticSolution(semanticSolution("3 | 5", "", { answerValues: ["3", "5"] }), blanks).actions.length === 2);
    check("reordered blank role binding", () => {
      const planned = planActionsFromSemanticSolution(semanticSolution("3/5", "", { answerValues: ["3", "5"], answerBindings: [{ role: "numerator", value: "3" }, { role: "denominator", value: "5" }] }), blanks).actions;
      return planned.some((action) => action.target === 1 && action.value === "3") && planned.some((action) => action.target === 0 && action.value === "5");
    });
    const graph = { descriptors: [{ target: 0, kind: "graph", label: "" }] };
    check("graph path planning", () => planActionsFromSemanticSolution(semanticSolution("line through (0,1) and (2,5)", "", { graphObjects: [{ type: "line", points: [{ x: 0, y: 1 }, { x: 2, y: 5 }] }] }), graph).actions[0]?.type === "graph-path");
    const passed = results.filter((result) => result.ok).length;
    lastDebugReport = { generatedAt: new Date().toISOString(), state: "replay-tests", passed, total: results.length, results };
    if (ui?.debugReport) ui.debugReport.textContent = JSON.stringify(lastDebugReport, null, 2);
    ui?.debugger?.classList.add("open");
    setStatus(`Replay tests: ${passed}/${results.length} passed.`, passed === results.length ? "success" : "error");
    log("Built-in structured solver replay tests completed.", { passed, total: results.length, failures: results.filter((result) => !result.ok) });
    return results;
  }

  async function testApi() {
    readConfigFromPanel();
    const provider = primaryApiProvider();
    if (!apiProviderConfigured(provider)) {
      setStatus(requiresApiKey(config.endpoint) ? "API key, endpoint, and model are required." : "Endpoint and model are required.", "error");
      return;
    }
    setStatus("Testing primary API…");
    try {
      const prompt = "Return only this JSON object: {\"actions\":[],\"finalAnswer\":\"test success\",\"explanation\":\"\",\"confidence\":1}";
      const response = await requestWithCompatibilityFallback(prompt, null, provider.model, provider);
      const answer = parseAnswerJson(extractResponseText(response));
      if (answer.finalAnswer.toLowerCase().includes("test success")) setStatus("Primary API connection works.", "success");
      else setStatus("Primary API responded, but did not follow the requested JSON format.", "error");
    } catch (error) {
      setStatus(`Primary API test failed: ${error.message || error}`, "error");
    }
  }

  async function testBackupApi() {
    readConfigFromPanel();
    const provider = backupApiProvider();
    if (!apiProviderConfigured(provider)) {
      setStatus(requiresApiKey(provider.endpoint) ? "Backup API key, endpoint, and model are required." : "Backup endpoint and model are required.", "error");
      return;
    }
    setStatus("Testing backup API directly…");
    try {
      const prompt = "Return only this JSON object: {\"actions\":[],\"finalAnswer\":\"backup test success\",\"explanation\":\"\",\"confidence\":1}";
      const response = await requestWithCompatibilityFallback(prompt, null, provider.model, provider);
      const answer = parseAnswerJson(extractResponseText(response));
      if (answer.finalAnswer.toLowerCase().includes("backup test success")) setStatus(config.backupEnabled ? "Backup API connection works and automatic failover is enabled." : "Backup API connection works. Enable automatic backup to use it on primary usage limits.", "success");
      else setStatus("Backup API responded, but did not follow the requested JSON format.", "error");
    } catch (error) {
      setStatus(`Backup API test failed: ${error.message || error}`, "error");
    }
  }

  async function testAnswerCache() {
    readConfigFromPanel();
    if (!config.localAnswerCache && !config.supabaseEnabled) {
      setStatus("Enable the local or Supabase answer cache first.", "error");
      return;
    }
    if (config.supabaseEnabled && !validSupabaseSettings()) {
      setStatus("Supabase cache settings are incomplete or unsafe. Use the HTTPS project URL, table name, and a publishable/anon key—never a secret key.", "error");
      return;
    }
    if (config.supabaseEnabled && !(await checkSupabaseCacheTable({ force: true, announce: true }))) return;
    setStatus("Testing the answer cache…");
    const questionHash = `cache-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const probe = {
      question_hash: questionHash,
      question_signature: "IXL answer-cache connection test",
      question_text: "IXL answer-cache connection test",
      question_details: {
        schema: 4,
        subject: "reading-language-arts",
        questionType: "reading-comprehension",
        readingArticle: { fingerprint: "cache-test-article", title: "Cache test", text: "Fingerprint-isolated article test." },
      },
      target_signature: [],
      answer_json: { actions: [{ type: "fill", target: 0, value: "test" }], finalAnswer: "test", explanation: "", confidence: 1 },
      answer_details: { schema: 3, subject: "reading-language-arts", questionType: "reading-comprehension", articleFingerprint: "cache-test-article" },
      answer_source: "connection-test",
      verified_count: 1,
      last_verified_ms: Date.now(),
    };
    try {
      if (config.localAnswerCache) {
        saveLocalAnswerRecord(probe);
        if (readLocalAnswerCache()[questionHash]?.answer_json?.finalAnswer !== "test") throw new Error("The local cache did not return its test record.");
        deleteLocalAnswerRecord(questionHash);
      }
      if (config.supabaseEnabled) {
        const saved = await writeSupabaseAnswerRecord(probe);
        if (!saved) throw new Error("The Supabase test record could not be saved.");
        const returned = await readSupabaseAnswerRecord(questionHash);
        if (returned?.answer_json?.finalAnswer !== "test"
          || returned?.question_details?.readingArticle?.fingerprint !== "cache-test-article"
          || returned?.answer_details?.articleFingerprint !== "cache-test-article") {
          throw new Error("Supabase did not round-trip the schema-4 reading article metadata. Check that question_details and answer_details are JSONB and that grants/RLS permit reads and writes.");
        }
        await deleteSupabaseAnswerRecord(questionHash);
      }
      setStatus(`Answer cache works${config.supabaseEnabled ? " locally and in Supabase" : " locally"}.`, "success");
      log("Answer-cache read/write/delete test passed.", { local: Boolean(config.localAnswerCache), supabase: Boolean(config.supabaseEnabled) });
    } catch (error) {
      deleteLocalAnswerRecord(questionHash);
      await deleteSupabaseAnswerRecord(questionHash);
      setStatus(`Answer-cache test failed: ${error.message || error}`, "error");
    }
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function init() {
    addStyles();
    createPanel();
    document.removeEventListener("keydown", handleGlobalUiHotkey, true);
    document.addEventListener("keydown", handleGlobalUiHotkey, true);
    document.removeEventListener("click", handleReadingNavigationHandoff, true);
    document.addEventListener("click", handleReadingNavigationHandoff, true);
    saveConfig();
    log("Fixed userscript loaded.");
    resumeTeacherHandoff();
    setTimeout(() => { rememberStandaloneReadingContext(); }, 350);
    resumeAutoLoopAcrossPageNavigation();
    scheduleFirstLoginTutorial();
    setTimeout(() => { void checkSupabaseCacheTable({ force: true, announce: false }); }, 700);
    setInterval(() => { void checkSupabaseCacheTable({ force: false, announce: false }); }, SUPABASE_TABLE_RECHECK_MS);
  }

  if (document.body) init();
  else window.addEventListener("DOMContentLoaded", init, { once: true });
})();
