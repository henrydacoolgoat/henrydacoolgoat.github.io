import EpoxyTransport from "./transport/epoxy.mjs";

const $ = (id) => document.getElementById(id);
const config = globalThis.ASTEROID_SCRAMJET_CONFIG || {};
const LIBCURL_TRANSPORT_VERSION = String(config.libcurlTransportVersion || "2.0.5");
const LIBCURL_SCRIPT_URLS = Array.isArray(config.libcurlScriptUrls) && config.libcurlScriptUrls.length
  ? config.libcurlScriptUrls.map(String)
  : [
      `https://cdn.jsdelivr.net/npm/@mercuryworkshop/libcurl-transport@${LIBCURL_TRANSPORT_VERSION}/dist/index.js`,
      `https://unpkg.com/@mercuryworkshop/libcurl-transport@${LIBCURL_TRANSPORT_VERSION}/dist/index.js`
    ];
const basePath = new URL("./", location.href).pathname;
const HOME = "asteroid://newtab";
const SETTINGS = "asteroid://settings/connection";
const STORAGE = "asteroid:browser:settings:v2";
const BOOKMARKS = "asteroid:browser:bookmarks:v2";
const HISTORY = "asteroid:browser:history:v2";
const METRICS = "asteroid:browser:metrics:v2";
const ASSET_DB = "asteroid-browser-assets-v1";
const ASSET_STORE = "assets";
const WALLPAPER_KEY = "wallpaper";
const WALLPAPER_TOKEN = "idb:wallpaper";
const COMPATIBILITY_STORAGE = "asteroid:browser:compatibility:v1";
const COMPATIBILITY_MATRIX_VERSION = 1;
const COMPATIBILITY_SETTLE_MS = 4500;
const COMPATIBILITY_HARD_TIMEOUT_MS = 15000;
const GOOGLE_SEARCH_URL = "https://www.google.com/search?q=";
const IXL_ANSWER_HELPER_BUILD = "14.0.0-asteroid.1";
const IXL_ANSWER_HELPER_URL = new URL("./userscripts/ixl-answer-helper.user.js", import.meta.url);
const IXL_HTML2CANVAS_URL = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
const IXL_USERSCRIPT_STORAGE_PREFIX = "asteroid:userscript:ixl-answer-helper:";
let ixlAnswerHelperAssetsPromise = null;

const ASTEROID_LAUNCH = (() => {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  let parentOrigin = "";
  try {
    const parsedParentOrigin = new URL(String(params.get("asteroid-parent-origin") || ""));
    if (/^https?:$/.test(parsedParentOrigin.protocol)) parentOrigin = parsedParentOrigin.origin;
  } catch {}
  const context = Object.freeze({
    token: String(params.get("asteroid-access") || "").slice(0, 160),
    parentOrigin,
    appMode: params.get("asteroid-app") === "1",
    target: String(params.get("target") || "").slice(0, 2048),
    name: String(params.get("name") || "").slice(0, 120),
    serviceWorkerReloaded: params.get("asteroid-sw-ready") === "1"
  });
  if (context.appMode) document.documentElement.dataset.asteroidAppMode = "1";
  if (location.hash) history.replaceState(null, "", `${location.pathname}${location.search}`);
  return context;
})();
const ASTEROID_LOCAL_STANDALONE = /^(?:localhost|127[.]0[.]0[.]1|\[::1\])$/i.test(location.hostname)
  && (parent === window || !ASTEROID_LAUNCH.token);
let pendingAsteroidTarget = ASTEROID_LAUNCH.target;
let asteroidRemoteAccessDeadline = 0;

function asteroidAccessAllowed() {
  if (ASTEROID_LOCAL_STANDALONE) return true;
  if (!ASTEROID_LAUNCH.token || parent === window) return false;
  try {
    if (parent.AsteroidBrowserAccessBridge?.validate?.(ASTEROID_LAUNCH.token) === true) return true;
  } catch {}
  return asteroidRemoteAccessDeadline > performance.now();
}

async function requestAsteroidAccess() {
  if (asteroidAccessAllowed()) return true;
  if (!ASTEROID_LAUNCH.token || !ASTEROID_LAUNCH.parentOrigin || parent === window) return false;
  const requestId = globalThis.crypto?.randomUUID?.() || `asteroid-access-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (allowed, remaining = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      const seconds = Math.max(0, Number(remaining) || 0);
      asteroidRemoteAccessDeadline = allowed && seconds > 0 ? performance.now() + seconds * 1000 : 0;
      resolve(asteroidRemoteAccessDeadline > performance.now());
    };
    const onMessage = (event) => {
      if (event.source !== parent || event.origin !== ASTEROID_LAUNCH.parentOrigin) return;
      const data = event.data && typeof event.data === "object" ? event.data : {};
      if (data.type !== "asteroid-browser-access-result" || data.requestId !== requestId) return;
      finish(data.allowed === true, data.remaining);
    };
    const timer = setTimeout(() => finish(false), 4000);
    window.addEventListener("message", onMessage);
    try {
      parent.postMessage({
        type: "asteroid-browser-access-check",
        requestId,
        token: ASTEROID_LAUNCH.token
      }, ASTEROID_LAUNCH.parentOrigin);
    } catch {
      finish(false);
    }
  });
}

window.addEventListener("message", (event) => {
  if (event.source !== parent || !asteroidAccessAllowed()) return;
  const data = event.data && typeof event.data === "object" ? event.data : {};
  if (data.type !== "asteroid-browser-command" || data.action !== "navigate") return;
  const target = String(data.value || "").trim().slice(0, 2048);
  if (!/^https?:\/\//i.test(target)) return;
  if (!controller) {
    pendingAsteroidTarget = target;
    return;
  }
  const tab = activeTab() || createTab(null, true);
  navigate(tab, target);
});

const defaults = Object.freeze({
  wispUrl: config.wispUrl || "wss://anura.pro/",
  fallbackWispUrl: config.fallbackWispUrl || "wss://wisp.mercurywork.shop/wisp/",
  fallbackEnabled: true,
  mainRetries: 2,
  fallbackRetries: 2,
  retryDelay: 1,
  fallback5xx: true,
  fallbackTimeout: true,
  fallbackDns: true,
  timeoutSeconds: 18,
  searchEngine: GOOGLE_SEARCH_URL,
  searchEngineName: "Google",
  customSearchName: "Custom",
  customSearchUrl: "https://www.google.com/search?q={q}",
  idleThreads: 3,
  activeThreads: 6,
  webrtcBlock: false,
  smartHeaders: true,
  spellcheck: false,
  adblock: false,
  allowlist: [],
  requestUA: "",
  pageUA: "",
  customFilters: [],
  tabCache: true,
  fontScale: 1,
  rememberPanelWidths: true,
  panelsLeft: false,
  autoFullscreen: false,
  shortcutsEnabled: true,
  bookmarksBar: true,
  wallpaper: "",
  showClock: true,
  clock24: false,
  language: "",
  aiContextDefault: false,
  compatibilityLearning: true,
  mediaRange: true,
  mediaDownloadUnknown: false,
  mediaPdf: true,
  mediaImg: true,
  mediaVideo: true,
  mediaAudio: true,
  mediaText: true,
  shortcuts: {
    newTab: "t", closeTab: "w", reload: "r", bookmark: "d", focusUrl: "l",
    settings: ",", logs: "g", inspector: "i", history: "h", metrics: "m",
    fullscreen: "k", find: "f", ai: "a"
  }
});

function safeGetItem(key) {
  try { return localStorage.getItem(key); }
  catch (error) { console.warn(`Storage read failed for ${key}:`, error); return null; }
}
function safeSetItem(key, value) {
  try { localStorage.setItem(key, String(value)); return true; }
  catch (error) { console.warn(`Storage write failed for ${key}:`, error); return false; }
}
function safeJson(key, fallback) {
  try {
    const parsed = JSON.parse(safeGetItem(key) || "null");
    return parsed ?? fallback;
  } catch { return fallback; }
}
function safeSetJson(key, value) {
  try { return safeSetItem(key, JSON.stringify(value)); }
  catch (error) { console.warn(`Storage serialization failed for ${key}:`, error); return false; }
}
function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
function normalizedHostList(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const entry of value) {
    let host = String(entry || "").trim().toLowerCase().replace(/^\.+|\.+$/g, "");
    try { if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) host = new URL(host).hostname.toLowerCase(); } catch {}
    if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i.test(host) && !result.includes(host)) result.push(host);
  }
  return result.slice(0, 500);
}
function normalizeSocketUrl(value, fallback) {
  try {
    const url = new URL(String(value || "").trim());
    if (!/^wss?:$/.test(url.protocol)) return fallback;
    if (location.protocol === "https:" && url.protocol !== "wss:") return fallback;
    return url.href;
  } catch { return fallback; }
}
function normalizeSearchUrl(value, fallback, requirePlaceholder = false) {
  try {
    const text = String(value || "").trim();
    const probe = new URL(text.replace("{q}", "test"));
    if (!/^https?:$/.test(probe.protocol) || (requirePlaceholder && !text.includes("{q}"))) return fallback;
    return text;
  } catch { return fallback; }
}
function sanitizeBookmarks(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const output = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    let url;
    try { url = new URL(String(item.url || "")); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || seen.has(url.href)) continue;
    seen.add(url.href);
    output.push({
      id: typeof item.id === "string" && item.id ? item.id : `${Date.now()}-${Math.random()}`,
      url: url.href,
      name: String(item.name || "").trim().slice(0, 80)
    });
    if (output.length >= 200) break;
  }
  return output;
}
function sanitizeHistory(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const output = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    let url;
    try { url = new URL(String(item.url || "")); } catch { continue; }
    if (!/^https?:$/.test(url.protocol) || seen.has(url.href)) continue;
    seen.add(url.href);
    output.push({
      url: url.href,
      title: String(item.title || "").trim().slice(0, 200),
      time: clampNumber(item.time, Date.now(), 0, Date.now())
    });
    if (output.length >= 100) break;
  }
  return output;
}
function mergeSettings(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const merged = {
    ...defaults,
    ...source,
    shortcuts: { ...defaults.shortcuts, ...(source.shortcuts && typeof source.shortcuts === "object" ? source.shortcuts : {}) }
  };
  merged.mainRetries = Math.round(clampNumber(merged.mainRetries, defaults.mainRetries, 0, 5));
  merged.fallbackRetries = Math.round(clampNumber(merged.fallbackRetries, defaults.fallbackRetries, 0, 5));
  merged.retryDelay = clampNumber(merged.retryDelay, defaults.retryDelay, 0.1, 10);
  merged.timeoutSeconds = clampNumber(merged.timeoutSeconds, defaults.timeoutSeconds, 3, 120);
  merged.idleThreads = Math.round(clampNumber(merged.idleThreads, defaults.idleThreads, 1, 16));
  merged.activeThreads = Math.round(clampNumber(merged.activeThreads, defaults.activeThreads, 1, 32));
  merged.fontScale = clampNumber(merged.fontScale, defaults.fontScale, 0.75, 1.5);
  merged.allowlist = normalizedHostList(merged.allowlist);
  merged.customFilters = Array.isArray(merged.customFilters) ? merged.customFilters.map(String).map((item) => item.trim()).filter(Boolean).slice(0, 500) : [];
  merged.wallpaper = typeof merged.wallpaper === "string" ? merged.wallpaper : "";
  for (const key of ["wispUrl", "fallbackWispUrl", "searchEngine", "searchEngineName", "customSearchName", "customSearchUrl", "requestUA", "pageUA", "language"]) {
    if (typeof merged[key] !== "string") merged[key] = defaults[key];
  }
  for (const [key, fallback] of Object.entries(defaults)) {
    if (typeof fallback === "boolean") merged[key] = typeof merged[key] === "boolean" ? merged[key] : fallback;
  }
  merged.wispUrl = normalizeSocketUrl(merged.wispUrl, defaults.wispUrl);
  merged.fallbackWispUrl = normalizeSocketUrl(merged.fallbackWispUrl, defaults.fallbackWispUrl);
  // Asteroid Browser intentionally uses one predictable search provider.
  // This also migrates installations that previously persisted Brave or a
  // custom engine in local storage.
  merged.searchEngine = GOOGLE_SEARCH_URL;
  merged.customSearchUrl = normalizeSearchUrl(merged.customSearchUrl, defaults.customSearchUrl, true);
  merged.searchEngineName = "Google";
  merged.customSearchName = merged.customSearchName.trim().slice(0, 40) || defaults.customSearchName;
  merged.requestUA = merged.requestUA.replace(/[\r\n]/g, " ").trim().slice(0, 512);
  merged.pageUA = merged.pageUA.replace(/[\r\n]/g, " ").trim().slice(0, 512);
  for (const [action, fallback] of Object.entries(defaults.shortcuts)) {
    const key = String(merged.shortcuts[action] || fallback).toLowerCase();
    merged.shortcuts[action] = key.length === 1 ? key : fallback;
  }
  return merged;
}
const storedSettings = safeJson(STORAGE, {});
const storedBookmarks = safeJson(BOOKMARKS, []);
const storedHistory = safeJson(HISTORY, []);
const storedMetrics = safeJson(METRICS, {});
const storedCompatibility = safeJson(COMPATIBILITY_STORAGE, {});
let settings = mergeSettings(storedSettings);
let bookmarks = sanitizeBookmarks(storedBookmarks);
let historyItems = sanitizeHistory(storedHistory);
let metrics = {
  requests: clampNumber(storedMetrics?.requests, 0, 0, Number.MAX_SAFE_INTEGER),
  blocked: clampNumber(storedMetrics?.blocked, 0, 0, Number.MAX_SAFE_INTEGER),
  errors: clampNumber(storedMetrics?.errors, 0, 0, Number.MAX_SAFE_INTEGER),
  fallbackSwitches: clampNumber(storedMetrics?.fallbackSwitches, 0, 0, Number.MAX_SAFE_INTEGER),
  bytes: clampNumber(storedMetrics?.bytes, 0, 0, Number.MAX_SAFE_INTEGER),
  startedAt: Date.now()
};
let metricsSaveTimer = 0;
function saveSettings() { return safeSetJson(STORAGE, settings); }
function saveBookmarks() { return safeSetJson(BOOKMARKS, bookmarks.slice(0, 200)); }
function saveHistory() { return safeSetJson(HISTORY, historyItems.slice(0, 100)); }
function flushMetrics() { return safeSetJson(METRICS, metrics); }
function saveMetrics() {
  clearTimeout(metricsSaveTimer);
  metricsSaveTimer = setTimeout(() => { metricsSaveTimer = 0; flushMetrics(); }, 250);
  return true;
}
function updateSetting(key, value) {
  const previous = settings[key];
  settings[key] = value;
  if (!saveSettings()) {
    settings[key] = previous;
    notify("This browser could not save the setting.", "err");
  }
  applySettingsToUI();
}

const COMPATIBILITY_MATRIX = Object.freeze([
  { id: "a0-w0-h1-r1", label: "Balanced", adblock: false, webrtcBlock: false, smartHeaders: true,  mediaRange: true },
  { id: "a0-w0-h0-r1", label: "Native headers", adblock: false, webrtcBlock: false, smartHeaders: false, mediaRange: true },
  { id: "a0-w0-h1-r0", label: "No range requests", adblock: false, webrtcBlock: false, smartHeaders: true,  mediaRange: false },
  { id: "a0-w0-h0-r0", label: "Minimal request changes", adblock: false, webrtcBlock: false, smartHeaders: false, mediaRange: false },
  { id: "a0-w1-h1-r1", label: "WebRTC blocked", adblock: false, webrtcBlock: true,  smartHeaders: true,  mediaRange: true },
  { id: "a1-w0-h1-r1", label: "Blocking enabled", adblock: true,  webrtcBlock: false, smartHeaders: true,  mediaRange: true },
  { id: "a0-w1-h0-r1", label: "WebRTC blocked + native headers", adblock: false, webrtcBlock: true,  smartHeaders: false, mediaRange: true },
  { id: "a1-w0-h0-r1", label: "Blocking + native headers", adblock: true,  webrtcBlock: false, smartHeaders: false, mediaRange: true },
  { id: "a1-w1-h1-r1", label: "Privacy maximum", adblock: true,  webrtcBlock: true,  smartHeaders: true,  mediaRange: true },
  { id: "a0-w1-h1-r0", label: "WebRTC blocked + no range", adblock: false, webrtcBlock: true,  smartHeaders: true,  mediaRange: false },
  { id: "a1-w0-h1-r0", label: "Blocking + no range", adblock: true,  webrtcBlock: false, smartHeaders: true,  mediaRange: false },
  { id: "a0-w1-h0-r0", label: "WebRTC blocked + minimal", adblock: false, webrtcBlock: true,  smartHeaders: false, mediaRange: false },
  { id: "a1-w0-h0-r0", label: "Blocking + minimal", adblock: true,  webrtcBlock: false, smartHeaders: false, mediaRange: false },
  { id: "a1-w1-h0-r1", label: "Privacy + native headers", adblock: true,  webrtcBlock: true,  smartHeaders: false, mediaRange: true },
  { id: "a1-w1-h1-r0", label: "Privacy + no range", adblock: true,  webrtcBlock: true,  smartHeaders: true,  mediaRange: false },
  { id: "a1-w1-h0-r0", label: "Strict minimal", adblock: true,  webrtcBlock: true,  smartHeaders: false, mediaRange: false }
]);
const COMPATIBILITY_IDS = new Set(COMPATIBILITY_MATRIX.map((item) => item.id));
let lastCompatibilitySiteUrl = "";

function compatibilityHost(value) {
  try { return new URL(String(value || "")).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}
function compatibilityRecordTemplate(host) {
  return {
    host,
    matrixVersion: COMPATIBILITY_MATRIX_VERSION,
    failed: [],
    winner: null,
    incompatible: false,
    lastTestedAt: 0,
    lastReason: ""
  };
}
function sanitizeCompatibilityState(raw) {
  const state = { version: COMPATIBILITY_MATRIX_VERSION, sites: {} };
  const sites = raw && typeof raw === "object" && raw.sites && typeof raw.sites === "object" ? raw.sites : {};
  for (const [hostKey, value] of Object.entries(sites).slice(0, 500)) {
    const host = compatibilityHost(`https://${hostKey}`);
    if (!host || !value || typeof value !== "object") continue;
    const record = compatibilityRecordTemplate(host);
    record.matrixVersion = Number(value.matrixVersion) || COMPATIBILITY_MATRIX_VERSION;
    record.failed = Array.isArray(value.failed) ? [...new Set(value.failed.map(String).filter((id) => COMPATIBILITY_IDS.has(id)))].slice(0, COMPATIBILITY_MATRIX.length) : [];
    record.winner = COMPATIBILITY_IDS.has(String(value.winner || "")) ? String(value.winner) : null;
    record.incompatible = value.incompatible === true;
    record.lastTestedAt = clampNumber(value.lastTestedAt, 0, 0, Date.now());
    record.lastReason = String(value.lastReason || "").slice(0, 240);
    state.sites[host] = record;
  }
  return state;
}
let compatibilityState = sanitizeCompatibilityState(storedCompatibility);
function saveCompatibilityState() { return safeSetJson(COMPATIBILITY_STORAGE, compatibilityState); }
function compatibilityCombinationById(id) { return COMPATIBILITY_MATRIX.find((item) => item.id === id) || null; }
function compatibilityRecord(host, create = false) {
  if (!host) return null;
  if (!compatibilityState.sites[host] && create) compatibilityState.sites[host] = compatibilityRecordTemplate(host);
  return compatibilityState.sites[host] || null;
}
function resetCompatibilityRecord(host) {
  if (!host) return;
  delete compatibilityState.sites[host];
  saveCompatibilityState();
}
function nextCompatibilityCombination(record) {
  const failed = new Set(record?.matrixVersion === COMPATIBILITY_MATRIX_VERSION ? record.failed : []);
  return COMPATIBILITY_MATRIX.find((item) => !failed.has(item.id)) || null;
}
function compatibilityCombinationLabel(combo) {
  if (!combo) return "Default settings";
  return `${combo.label} · ads ${combo.adblock ? "on" : "off"} · WebRTC ${combo.webrtcBlock ? "blocked" : "allowed"} · headers ${combo.smartHeaders ? "smart" : "native"} · range ${combo.mediaRange ? "on" : "off"}`;
}
function compatibilityEffectiveSetting(key, tab = activeTab()) {
  if (tab?.compatibilityCombination && Object.prototype.hasOwnProperty.call(tab.compatibilityCombination, key)) return tab.compatibilityCombination[key];
  return settings[key];
}
function compatibilityTabForRemote(remote) {
  let host = "";
  try { host = (remote instanceof URL ? remote : new URL(String(remote))).hostname.toLowerCase().replace(/^www\./, ""); } catch {}
  const trials = [...tabs.values()].filter((tab) => tab.compatibilityTrial);
  const direct = trials.find((tab) => host && (host === tab.compatibilityHost || host.endsWith(`.${tab.compatibilityHost}`)));
  return direct || (trials.length === 1 ? trials[0] : activeTab());
}
function compatibilityRequestSetting(key, remote) { return compatibilityEffectiveSetting(key, compatibilityTabForRemote(remote)); }
function clearCompatibilityTimers(tab) {
  if (!tab) return;
  if (tab.compatibilityEvalTimer) clearTimeout(tab.compatibilityEvalTimer);
  if (tab.compatibilityHardTimer) clearTimeout(tab.compatibilityHardTimer);
  if (tab.compatibilityRetryTimer) clearTimeout(tab.compatibilityRetryTimer);
  tab.compatibilityEvalTimer = 0;
  tab.compatibilityHardTimer = 0;
  tab.compatibilityRetryTimer = 0;
}
function currentCompatibilityUrl() {
  const tab = activeTab();
  if (/^https?:/i.test(tab?.url || "")) return tab.url;
  return lastCompatibilitySiteUrl;
}
function currentCompatibilityRecord() { return compatibilityRecord(compatibilityHost(currentCompatibilityUrl()), false); }
function beginCompatibilityNavigation(tab, url) {
  clearCompatibilityTimers(tab);
  tab.compatibilityTrial = null;
  tab.compatibilityCombination = null;
  tab.compatibilityStatus = "default";
  tab.compatibilityHost = compatibilityHost(url);
  if (!tab.compatibilityHost) return;
  lastCompatibilitySiteUrl = url;
  let record = compatibilityRecord(tab.compatibilityHost, false);
  if (record?.matrixVersion !== COMPATIBILITY_MATRIX_VERSION) {
    record = compatibilityRecordTemplate(tab.compatibilityHost);
    compatibilityState.sites[tab.compatibilityHost] = record;
    saveCompatibilityState();
  }
  const winner = compatibilityCombinationById(record?.winner);
  if (winner) {
    tab.compatibilityCombination = winner;
    tab.compatibilityStatus = "learned";
    renderCompatibilityUI();
    return;
  }
  if (!settings.compatibilityLearning) {
    tab.compatibilityCombination = COMPATIBILITY_MATRIX[0];
    tab.compatibilityStatus = "learning-off";
    renderCompatibilityUI();
    return;
  }
  if (record?.incompatible) {
    tab.compatibilityCombination = COMPATIBILITY_MATRIX[0];
    tab.compatibilityStatus = "incompatible";
    renderCompatibilityUI();
    return;
  }
  record = record || compatibilityRecord(tab.compatibilityHost, true);
  const combination = nextCompatibilityCombination(record);
  if (!combination) {
    record.incompatible = true;
    record.lastTestedAt = Date.now();
    saveCompatibilityState();
    tab.compatibilityCombination = COMPATIBILITY_MATRIX[0];
    tab.compatibilityStatus = "incompatible";
    renderCompatibilityUI();
    return;
  }
  tab.compatibilityGeneration = (tab.compatibilityGeneration || 0) + 1;
  tab.compatibilityCombination = combination;
  tab.compatibilityStatus = "testing";
  tab.compatibilityTrial = {
    generation: tab.compatibilityGeneration,
    host: tab.compatibilityHost,
    url,
    combinationId: combination.id,
    startedAt: Date.now(),
    requests: 0,
    transportErrors: 0,
    pageErrors: 0,
    evaluations: 0,
    lastError: ""
  };
  tab.compatibilityHardTimer = setTimeout(() => failCompatibilityTrial(tab, "Page did not finish loading before the compatibility timeout"), COMPATIBILITY_HARD_TIMEOUT_MS);
  const trialNumber = Math.min(COMPATIBILITY_MATRIX.length, (record.failed?.length || 0) + 1);
  if (tab.id === activeTabId) setStatus("loading", `Testing ${trialNumber}/${COMPATIBILITY_MATRIX.length}`);
  log(`Compatibility test ${trialNumber}/${COMPATIBILITY_MATRIX.length} for ${tab.compatibilityHost}: ${compatibilityCombinationLabel(combination)}`, "info");
  renderCompatibilityUI();
}
function compatibilityTrialForRemote(remote) {
  const tab = compatibilityTabForRemote(remote);
  return tab?.compatibilityTrial ? { tab, trial: tab.compatibilityTrial } : null;
}
function noteCompatibilityRequest(remote) {
  const match = compatibilityTrialForRemote(remote);
  if (match) match.trial.requests += 1;
}
function noteCompatibilityTransportError(remote, error) {
  const match = compatibilityTrialForRemote(remote);
  if (!match) return;
  match.trial.transportErrors += 1;
  match.trial.lastError = textError(error).slice(0, 240);
}
function noteCompatibilityPageError(tab, error) {
  if (!tab?.compatibilityTrial) return;
  tab.compatibilityTrial.pageErrors += 1;
  tab.compatibilityTrial.lastError = textError(error).slice(0, 240);
}
function scheduleCompatibilityEvaluation(tab, delay = COMPATIBILITY_SETTLE_MS) {
  if (!tab?.compatibilityTrial) return;
  if (tab.compatibilityEvalTimer) clearTimeout(tab.compatibilityEvalTimer);
  const generation = tab.compatibilityTrial.generation;
  tab.compatibilityEvalTimer = setTimeout(() => evaluateCompatibilityTrial(tab, generation), delay);
}
function compatibilityPageSignals(tab) {
  const doc = tab.iframe.contentDocument;
  if (!doc?.documentElement || !doc.body) return { ready: false, blank: true, fatal: false, challenge: false, detail: "Document unavailable" };
  const title = String(doc.title || "").trim();
  const text = String(doc.body.innerText || "").replace(/\s+/g, " ").trim().slice(0, 20000);
  const lowered = `${title} ${text}`.toLowerCase();
  const elementCount = doc.body.querySelectorAll("main,article,section,nav,header,footer,form,button,input,textarea,select,a,p,h1,h2,h3,li,table,canvas,video,audio,img,svg,iframe,[role]").length;
  const visualCount = doc.querySelectorAll("canvas,video,audio,img,svg,iframe,[role='main'],main").length;
  const blank = text.length < 24 && elementCount < 5 && visualCount === 0;
  const challengePattern = /just a moment|checking your browser|verify you are human|captcha|robot check|enter the characters you see|not a robot/;
  const fatalPattern = /this site can.?t be reached|err_[a-z_]+|application error|internal server error|bad gateway|proxy error|unsupported browser|access denied|request blocked|failed to fetch|network error/;
  const challenge = challengePattern.test(title.toLowerCase()) || (challengePattern.test(lowered) && text.length < 1800);
  const fatal = fatalPattern.test(title.toLowerCase()) || (fatalPattern.test(lowered) && text.length < 1400 && elementCount < 16);
  return { ready: doc.readyState === "complete" || doc.readyState === "interactive", blank, fatal, challenge, title, textLength: text.length, elementCount, visualCount, detail: title || `${elementCount} elements` };
}
function evaluateCompatibilityTrial(tab, generation) {
  const trial = tab?.compatibilityTrial;
  if (!trial || trial.generation !== generation) return;
  trial.evaluations += 1;
  let signals;
  try { signals = compatibilityPageSignals(tab); }
  catch (error) { failCompatibilityTrial(tab, `Could not inspect the loaded page: ${textError(error)}`); return; }
  const age = Date.now() - trial.startedAt;
  const errorRatio = trial.requests ? trial.transportErrors / trial.requests : 0;
  if (signals.challenge && age < COMPATIBILITY_HARD_TIMEOUT_MS - 1500) {
    scheduleCompatibilityEvaluation(tab, 2500);
    return;
  }
  if (signals.fatal) { failCompatibilityTrial(tab, `The page displayed a fatal error (${signals.detail})`); return; }
  if (signals.challenge) { failCompatibilityTrial(tab, "The site remained on an anti-bot or verification challenge"); return; }
  if (signals.blank && age < 10500) { scheduleCompatibilityEvaluation(tab, 2200); return; }
  if (signals.blank) { failCompatibilityTrial(tab, "The page remained blank after loading"); return; }
  if (trial.requests >= 4 && errorRatio >= 0.7 && signals.textLength < 300) { failCompatibilityTrial(tab, "Most network requests failed and the page did not render usable content"); return; }
  if (trial.pageErrors >= 12 && signals.textLength < 150 && signals.visualCount === 0) { failCompatibilityTrial(tab, "The page produced repeated script errors without rendering usable content"); return; }
  if (!signals.ready && age < 10500) { scheduleCompatibilityEvaluation(tab, 2200); return; }
  passCompatibilityTrial(tab, signals);
}
function passCompatibilityTrial(tab, signals = {}) {
  const trial = tab?.compatibilityTrial;
  if (!trial) return;
  clearCompatibilityTimers(tab);
  const record = compatibilityRecord(trial.host, true);
  record.matrixVersion = COMPATIBILITY_MATRIX_VERSION;
  record.winner = trial.combinationId;
  record.incompatible = false;
  record.lastTestedAt = Date.now();
  record.lastReason = `Settled with ${signals.textLength || 0} text characters and ${signals.elementCount || 0} elements`;
  saveCompatibilityState();
  tab.compatibilityTrial = null;
  tab.compatibilityStatus = "learned";
  const combo = compatibilityCombinationById(record.winner);
  log(`Compatibility winner learned for ${trial.host}: ${compatibilityCombinationLabel(combo)}`, "ok");
  if (tab.id === activeTabId) {
    setStatus("ready", "Compatible");
    notify(`Compatibility learned for ${trial.host}`, "ok");
  }
  renderCompatibilityUI();
}
function failCompatibilityTrial(tab, reason) {
  const trial = tab?.compatibilityTrial;
  if (!trial) return;
  clearCompatibilityTimers(tab);
  const record = compatibilityRecord(trial.host, true);
  record.matrixVersion = COMPATIBILITY_MATRIX_VERSION;
  if (!record.failed.includes(trial.combinationId)) record.failed.push(trial.combinationId);
  record.failed = record.failed.filter((id) => COMPATIBILITY_IDS.has(id)).slice(0, COMPATIBILITY_MATRIX.length);
  record.winner = null;
  record.lastTestedAt = Date.now();
  record.lastReason = String(reason || trial.lastError || "Compatibility test failed").slice(0, 240);
  record.incompatible = record.failed.length >= COMPATIBILITY_MATRIX.length;
  saveCompatibilityState();
  tab.compatibilityTrial = null;
  log(`Compatibility combination failed for ${trial.host}: ${trial.combinationId} — ${record.lastReason}`, "warn");
  if (record.incompatible) {
    tab.compatibilityCombination = COMPATIBILITY_MATRIX[0];
    tab.compatibilityStatus = "incompatible";
    if (tab.id === activeTabId) {
      setStatus("error", "Incompatible");
      notify(`${trial.host} failed all ${COMPATIBILITY_MATRIX.length} compatibility combinations`, "err");
    }
    renderCompatibilityUI();
    return;
  }
  const nextNumber = record.failed.length + 1;
  tab.compatibilityStatus = "testing";
  if (tab.id === activeTabId) setStatus("loading", `Testing ${nextNumber}/${COMPATIBILITY_MATRIX.length}`);
  renderCompatibilityUI();
  const failedGeneration = trial.generation;
  tab.compatibilityRetryTimer = setTimeout(() => {
    tab.compatibilityRetryTimer = 0;
    if (!tabs.has(tab.id) || !settings.compatibilityLearning || tab.compatibilityGeneration !== failedGeneration || tab.url !== trial.url) return;
    navigate(tab, trial.url, { fromHistory: true, compatibilityRetry: true });
  }, 450);
}
function clearCompatibilityForCurrentSite(retest = false) {
  const url = currentCompatibilityUrl();
  const host = compatibilityHost(url);
  if (!host) { notify("Open a website before retesting compatibility", "warn"); return; }
  resetCompatibilityRecord(host);
  for (const tab of tabs.values()) {
    if (tab.compatibilityHost !== host) continue;
    clearCompatibilityTimers(tab);
    tab.compatibilityTrial = null;
    tab.compatibilityCombination = null;
    tab.compatibilityStatus = "default";
  }
  renderCompatibilityUI();
  if (retest) {
    const current = activeTab();
    if (current && !current.isSettings && /^https?:/i.test(current.url || "")) navigate(current, current.url, { fromHistory: true, compatibilityRetry: true });
    else createTab(url, true);
  }
}
function clearAllCompatibilityResults() {
  compatibilityState = { version: COMPATIBILITY_MATRIX_VERSION, sites: {} };
  saveCompatibilityState();
  for (const tab of tabs.values()) {
    clearCompatibilityTimers(tab);
    tab.compatibilityTrial = null;
    tab.compatibilityCombination = null;
    tab.compatibilityStatus = "default";
  }
  renderCompatibilityUI();
  notify("Compatibility learning results cleared", "ok");
}
function compatibilityStatusForUrl(url) {
  const host = compatibilityHost(url);
  const record = compatibilityRecord(host, false);
  const tab = [...tabs.values()].find((item) => item.compatibilityHost === host && item.compatibilityTrial);
  if (tab?.compatibilityTrial) {
    const tested = record?.failed?.length || 0;
    return `Testing ${Math.min(COMPATIBILITY_MATRIX.length, tested + 1)}/${COMPATIBILITY_MATRIX.length}: ${compatibilityCombinationLabel(tab.compatibilityCombination)}`;
  }
  if (record?.winner) return `Learned winner: ${compatibilityCombinationLabel(compatibilityCombinationById(record.winner))}`;
  if (record?.incompatible) return `INCOMPATIBLE after ${record.failed.length}/${COMPATIBILITY_MATRIX.length} trials`;
  if (record?.failed?.length) return `${record.failed.length}/${COMPATIBILITY_MATRIX.length} combinations tested`;
  return settings.compatibilityLearning ? "Not tested yet — the next load will start automatically" : "Learning is off";
}
function renderCompatibilityUI() {
  setSwitch("compatibilityLearningSwitch", settings.compatibilityLearning);
  const records = Object.values(compatibilityState.sites || {});
  const winners = records.filter((record) => record.winner).length;
  const incompatible = records.filter((record) => record.incompatible).length;
  const partial = records.filter((record) => !record.winner && !record.incompatible && record.failed?.length).length;
  setText("compatLearningSummary", settings.compatibilityLearning
    ? `${winners} learned · ${partial} testing · ${incompatible} incompatible`
    : `Learning off · ${winners} saved winners retained`);
  const url = currentCompatibilityUrl();
  const host = compatibilityHost(url);
  setText("compatCurrentHost", host || "No website selected");
  setText("compatCurrentVerdict", host ? compatibilityStatusForUrl(url) : "Open a website, then return here to view or retest it.");
  const list = $("compatLearnedSites");
  if (list) {
    const lines = records.sort((a, b) => (b.lastTestedAt || 0) - (a.lastTestedAt || 0)).slice(0, 40).map((record) => {
      if (record.winner) return `${record.host}\n  ${compatibilityCombinationLabel(compatibilityCombinationById(record.winner))}`;
      if (record.incompatible) return `${record.host}\n  INCOMPATIBLE after ${record.failed.length}/${COMPATIBILITY_MATRIX.length}`;
      return `${record.host}\n  ${record.failed.length}/${COMPATIBILITY_MATRIX.length} tested${record.lastReason ? ` · ${record.lastReason}` : ""}`;
    });
    list.textContent = lines.join("\n\n") || "No compatibility results saved yet.";
  }
}

const tabStrip = $("tabStrip");
const addTabBtn = $("newTab");
const urlInput = $("url");
const homePage = $("newtab");
const settingsPage = $("settingsPage");
const overlay = $("overlay");
const frameRoot = $("frame");

let controller;
let transport;
let activeTabId = 1;
let nextTabId = 2;
let selectedElement = null;
let selectedElementTabId = null;
let contextTabId = null;
let contextElement = null;
let shortcutEditingAction = null;
let shortcutPendingKey = null;
let autoScrollLogs = true;
let currentLogFilter = "all";
let findIndex = 0;
let findCount = 0;
let lastFindQuery = "";
let tutorialState = null;
const tabs = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function textError(error) { return error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function setText(id, value) { const el = $(id); if (el) el.textContent = String(value); }
function setOverlay(text) { if (!overlay) return; setText("overlayText", text); overlay.classList.remove("asteroid-hidden"); }
function hideOverlay() { overlay?.classList.add("asteroid-hidden"); }
function showModal(id, display = "flex") { const el = $(id); if (el) el.style.display = display; }
function hideModal(id) { const el = $(id); if (el) el.style.display = "none"; }
function isSwitchOn(id) { return $(id)?.classList.contains("on") || false; }
function setSwitch(id, on) {
  const el = $(id); if (!el) return;
  el.classList.toggle("on", Boolean(on));
  el.setAttribute("role", "switch");
  el.setAttribute("tabindex", "0");
  el.setAttribute("aria-checked", String(Boolean(on)));
}
function bindSwitch(id, key, after) {
  const el = $(id); if (!el) return;
  const toggle = () => {
    const previous = settings[key];
    settings[key] = !settings[key];
    if (!saveSettings()) {
      settings[key] = previous;
      notify("This browser could not save the setting.", "err");
    }
    setSwitch(id, settings[key]);
    after?.(settings[key]);
  };
  el.addEventListener("click", toggle);
  el.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") { event.preventDefault(); toggle(); }
  });
}
function notify(message, type = "info") {
  log(message, type);
  setStatus(type === "err" ? "error" : "ready", message.length > 36 ? (type === "err" ? "Error" : "Ready") : message);
}
function setStatus(kind, label) {
  const loading = kind === "loading";
  const bad = kind === "error" || kind === "err";
  for (const id of ["titlebarStatusLabel", "statusText"]) setText(id, label);
  for (const id of ["titlebarStatusDot", "statusDot"]) {
    const el = $(id); if (!el) continue;
    el.classList.remove("idle", "active", "ok", "err", "loading");
    el.classList.add(bad ? "err" : loading ? "active" : "ok");
  }
  $("progressWrap")?.classList.toggle("hidden", !loading);
  $("reload")?.classList.toggle("hidden", loading);
  $("stop")?.classList.toggle("hidden", !loading);
}
function log(message, type = "info") {
  const box = $("logbox"); if (!box) return;
  $("logNoResults")?.remove();
  const row = document.createElement("div");
  row.className = `log-entry ${type}`;
  row.dataset.type = type;
  const time = document.createElement("span"); time.className = "log-time"; time.textContent = new Date().toLocaleTimeString();
  const body = document.createElement("span"); body.textContent = String(message);
  row.append(time, body); box.append(row);
  if (autoScrollLogs) box.scrollTop = box.scrollHeight;
  setText("logCountBadge", box.querySelectorAll(".log-entry").length);
  filterLogs();
}
function filterLogs() {
  const query = ($("logSearch")?.value || "").trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll("#logbox .log-entry").forEach((row) => {
    const typeMatch = currentLogFilter === "all" || row.dataset.type === currentLogFilter;
    const textMatch = !query || row.textContent.toLowerCase().includes(query);
    const show = typeMatch && textMatch;
    row.style.display = show ? "" : "none";
    if (show) visible += 1;
  });
  let empty = $("logNoResults");
  if (!visible) {
    if (!empty) { empty = document.createElement("div"); empty.id = "logNoResults"; empty.className = "log-no-results"; $("logbox")?.append(empty); }
    empty.textContent = "No matching entries";
  } else empty?.remove();
}
function normalize(value) {
  const raw = String(value || "").trim();
  if (!raw) return HOME;
  if (raw.startsWith("asteroid://")) return raw;
  try { const url = new URL(raw); if (/^https?:$/.test(url.protocol)) return url.href; } catch {}
  if (/^(localhost|127\.0\.0\.1)(:\d+)?([/?#].*)?$/i.test(raw)) return `http://${raw}`;
  if (/^[\w.-]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(raw)) return `https://${raw}`;
  return GOOGLE_SEARCH_URL + encodeURIComponent(raw);
}
function activeTab() { return tabs.get(activeTabId); }
function titleFor(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "New Tab"; } }
function currentHostname(tab = activeTab()) { try { return new URL(tab?.url || "").hostname; } catch { return ""; } }
function genericIcon() { return '<i class="fas fa-globe"></i>'; }
function tabIcon(tab) {
  if (tab.isHome) return '<i class="fas fa-earth-americas"></i>';
  if (tab.isSettings) return '<i class="fas fa-gear"></i>';
  if (tab.favicon) return `<img src="${escapeHtml(tab.favicon)}" alt="" style="width:16px;height:16px;border-radius:3px" onerror="this.replaceWith(Object.assign(document.createElement('i'),{className:'fas fa-globe'}))">`;
  return genericIcon();
}
function addHistory(url, title) {
  if (!/^https?:/i.test(url || "")) return;
  historyItems = historyItems.filter((item) => item.url !== url);
  historyItems.unshift({ url, title: title || titleFor(url), time: Date.now() });
  historyItems = historyItems.slice(0, 100);
  saveHistory();
}
function renderTabs() {
  if (!tabStrip || !addTabBtn) return;
  tabStrip.querySelectorAll(".tab").forEach((el) => el.remove());
  for (const tab of tabs.values()) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `tab${tab.id === activeTabId ? " active" : ""}`;
    el.dataset.tabId = String(tab.id);
    el.innerHTML = `<span class="tab-icon">${tabIcon(tab)}</span><span class="tab-title"></span><span class="tab-mute-icon" style="display:${tab.muted ? "inline" : "none"}"><i class="fas fa-volume-xmark"></i></span><span class="tab-close" role="button" aria-label="Close tab">×</span>`;
    el.querySelector(".tab-title").textContent = tab.title || "New Tab";
    el.addEventListener("click", (event) => { if (!event.target.closest(".tab-close")) activateTab(tab.id); });
    el.querySelector(".tab-close").addEventListener("click", (event) => { event.stopPropagation(); closeTab(tab.id); });
    el.addEventListener("contextmenu", (event) => openTabContextMenu(event, tab.id));
    tabStrip.insertBefore(el, addTabBtn);
  }
  updateNavigationButtons();
}
function showSurface(tab) {
  document.querySelectorAll(".scramjet-frame").forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.tabId) === tab.id && !tab.isHome && !tab.isSettings);
  });
  homePage?.classList.toggle("active", tab.isHome);
  if (homePage) homePage.style.display = tab.isHome ? "" : "none";
  if (settingsPage) {
    settingsPage.classList.toggle("active", tab.isSettings);
    settingsPage.style.display = tab.isSettings ? "block" : "none";
  }
  if (urlInput) urlInput.value = tab.isHome ? HOME : tab.isSettings ? SETTINGS : (tab.url || "");
  updateSecurity(tab);
  applyMuted(tab);
}
function updateSecurity(tab) {
  const chip = $("securityChip"), icon = $("securityIcon"), text = $("securityText");
  if (!chip) return;
  chip.className = `security-chip ${tab.isHome || tab.isSettings ? "neutral" : "secure"}`;
  if (icon) icon.className = tab.isHome || tab.isSettings ? "fas fa-earth-americas" : "fas fa-shield-halved";
  if (text) text.textContent = tab.isHome ? "" : tab.isSettings ? "Settings" : "Proxied";
}
function updateNavigationButtons() {
  const tab = activeTab();
  const disabled = !tab || tab.isHome || tab.isSettings;
  if ($("back")) $("back").disabled = disabled || tab.stackIndex <= 0;
  if ($("fwd")) $("fwd").disabled = disabled || tab.stackIndex >= tab.stack.length - 1;
}
function activateTab(id) {
  const previous = activeTab();
  const tab = tabs.get(id); if (!tab) return;
  if (previous && previous.id !== id && !settings.tabCache && !previous.isHome && !previous.isSettings) suspendTab(previous);
  activeTabId = id;
  if (tab.suspended) resumeTab(tab);
  renderTabs(); showSurface(tab);
  renderCompatibilityUI();
  const compatLabel = tab.compatibilityStatus === "testing" && tab.compatibilityTrial ? `Testing ${(compatibilityRecord(tab.compatibilityHost)?.failed?.length || 0) + 1}/${COMPATIBILITY_MATRIX.length}` : null;
  setStatus(tab.loading ? "loading" : "ready", compatLabel || (tab.loading ? "Loading" : tab.isSettings ? "Settings" : "Ready"));
  if (!$("elements")?.classList.contains("hidden")) refreshElements();
}
function createFrameElement(id) {
  const el = id === 1 ? frameRoot : frameRoot.cloneNode(false);
  el.id = id === 1 ? "frame" : `frame-${id}`;
  el.dataset.tabId = String(id);
  el.classList.add("scramjet-frame");
  el.classList.remove("active");
  el.removeAttribute("sandbox");
  el.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen; autoplay; camera; microphone; gamepad; picture-in-picture");
  if (id !== 1) frameRoot.parentNode.insertBefore(el, frameRoot.nextSibling);
  return el;
}

function isIxlPageUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase();
    return url.protocol === "https:" && (host === "ixl.com" || host.endsWith(".ixl.com"));
  } catch {
    return false;
  }
}

function ixlPageUrl(tab, pageWindow) {
  let liveFrameUrl = "";
  try { liveFrameUrl = decodeFrameUrl(tab, ""); } catch {}
  if (isIxlPageUrl(liveFrameUrl)) return liveFrameUrl;
  if (/^https?:\/\//i.test(liveFrameUrl)) return "";

  let liveWindowUrl = "";
  try { liveWindowUrl = String(pageWindow?.location?.href || ""); } catch {}
  if (isIxlPageUrl(liveWindowUrl)) return liveWindowUrl;
  if (/^https?:\/\//i.test(liveWindowUrl)) return "";

  return isIxlPageUrl(tab?.url) ? tab.url : "";
}

async function loadIxlAnswerHelperAssets() {
  if (ixlAnswerHelperAssetsPromise) return ixlAnswerHelperAssetsPromise;
  const pending = (async () => {
    const helperResponse = await fetch(IXL_ANSWER_HELPER_URL, { cache: "no-cache", credentials: "same-origin" });
    if (!helperResponse.ok) throw new Error(`IXL helper asset returned HTTP ${helperResponse.status}`);
    const helperSource = await helperResponse.text();
    if (!/IXL Answer Helper - Fixed DOM and Selection Support/.test(helperSource)
      || !/local\.codex\.ixl-helper/.test(helperSource)) {
      throw new Error("IXL helper asset did not contain the expected userscript metadata");
    }

    let html2canvasSource = "";
    try {
      const dependencyResponse = await fetch(IXL_HTML2CANVAS_URL, { cache: "force-cache", mode: "cors" });
      if (!dependencyResponse.ok) throw new Error(`HTTP ${dependencyResponse.status}`);
      html2canvasSource = await dependencyResponse.text();
    } catch (error) {
      log(`IXL screenshot helper could not preload: ${textError(error)}. Canvas-only capture remains available.`, "warn");
    }
    return { helperSource, html2canvasSource };
  })();
  ixlAnswerHelperAssetsPromise = pending;
  try {
    return await pending;
  } catch (error) {
    if (ixlAnswerHelperAssetsPromise === pending) ixlAnswerHelperAssetsPromise = null;
    throw error;
  }
}

function ixlUserscriptStorageKey(key) {
  return `${IXL_USERSCRIPT_STORAGE_PREFIX}${String(key || "").slice(0, 240)}`;
}

function createIxlUserscriptApi(tab, pageWindow, pageUrl) {
  const pageDocument = pageWindow.document;
  const getValue = (key, fallback) => {
    const stored = safeGetItem(ixlUserscriptStorageKey(key));
    if (stored === null) return fallback;
    try { return JSON.parse(stored); } catch { return fallback; }
  };
  const setValue = (key, value) => {
    const storageKey = ixlUserscriptStorageKey(key);
    try {
      if (value === undefined) localStorage.removeItem(storageKey);
      else if (!safeSetItem(storageKey, JSON.stringify(value))) throw new Error("Storage write was rejected");
    } catch (error) {
      log(`IXL helper storage write failed: ${textError(error)}`, "warn");
    }
  };
  const addStyle = (css) => {
    const style = pageDocument.createElement("style");
    style.dataset.asteroidUserscriptStyle = "ixl-answer-helper";
    style.textContent = String(css || "");
    (pageDocument.head || pageDocument.documentElement || pageDocument.body)?.append(style);
    return style;
  };
  const xmlhttpRequest = (details = {}) => {
    const abortController = new AbortController();
    const method = String(details.method || "GET").toUpperCase();
    const timeoutMs = clampNumber(details.timeout, 90000, 1000, 120000);
    let timedOut = false;
    let settled = false;
    const invoke = (name, payload) => {
      try { if (typeof details[name] === "function") details[name].call(pageWindow, payload); }
      catch (error) { log(`IXL helper ${name} callback failed: ${textError(error)}`, "warn"); }
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      abortController.abort(new DOMException("Userscript request timed out", "TimeoutError"));
    }, timeoutMs);

    Promise.resolve().then(async () => {
      const remote = new URL(String(details.url || ""), pageUrl);
      if (!/^https?:$/.test(remote.protocol)) throw new Error("Userscript requests must use HTTP or HTTPS");
      const requestHeaders = Object.entries(details.headers && typeof details.headers === "object" ? details.headers : {})
        .map(([name, value]) => [String(name), String(value)]);
      const requestBody = details.data === undefined || details.data === null
        ? null
        : new TextEncoder().encode(String(details.data)).buffer;
      invoke("onloadstart", { readyState: 1, finalUrl: remote.href });
      const response = await transport.request(
        remote,
        method,
        requestBody,
        requestHeaders,
        abortController.signal,
        Math.max(1, timeoutMs / 1000)
      );
      const responseText = await transportBodyText(response.body);
      const responseHeaders = Array.isArray(response.headers)
        ? response.headers.map((entry) => `${entry[0]}: ${entry[1]}`).join("\r\n")
        : "";
      let responseValue = responseText;
      if (details.responseType === "json") {
        try { responseValue = JSON.parse(responseText); } catch { responseValue = null; }
      } else if (details.responseType === "arraybuffer" && response.body instanceof ArrayBuffer) {
        responseValue = response.body;
      }
      const payload = {
        finalUrl: remote.href,
        readyState: 4,
        response: responseValue,
        responseHeaders,
        responseText,
        status: Number(response.status) || 0,
        statusText: String(response.statusText || "")
      };
      settled = true;
      invoke("onreadystatechange", payload);
      invoke("onload", payload);
      invoke("onloadend", payload);
    }).catch((error) => {
      if (settled) return;
      settled = true;
      const payload = { error, finalUrl: String(details.url || ""), readyState: 4, status: 0, statusText: textError(error) };
      invoke("onreadystatechange", payload);
      invoke(timedOut ? "ontimeout" : abortController.signal.aborted ? "onabort" : "onerror", payload);
      invoke("onloadend", payload);
    }).finally(() => clearTimeout(timeout));

    return {
      abort() {
        if (!settled) abortController.abort(new DOMException("Userscript request aborted", "AbortError"));
      }
    };
  };
  return { GM_addStyle: addStyle, GM_getValue: getValue, GM_setValue: setValue, GM_xmlhttpRequest: xmlhttpRequest };
}

async function injectIxlAnswerHelper(tab, pageWindow = tab?.iframe?.contentWindow) {
  if (!tab || tab.isHome || tab.isSettings || tab.suspended || !pageWindow) return false;
  const pageUrl = ixlPageUrl(tab, pageWindow);
  if (!pageUrl) return false;
  let pageDocument;
  try { pageDocument = pageWindow.document; } catch { return false; }
  const root = pageDocument?.documentElement;
  if (!root || root.dataset.asteroidIxlAnswerHelper) return false;
  root.dataset.asteroidIxlAnswerHelper = "loading";

  try {
    const { helperSource, html2canvasSource } = await loadIxlAnswerHelperAssets();
    if (pageWindow.document !== pageDocument || !isIxlPageUrl(ixlPageUrl(tab, pageWindow))) return false;
    let html2canvas = pageWindow.html2canvas;
    if (typeof html2canvas !== "function" && html2canvasSource) {
      const installHtml2Canvas = pageWindow.Function(`${html2canvasSource}\nreturn globalThis.html2canvas;\n//# sourceURL=asteroid-html2canvas-1.4.1.js`);
      html2canvas = installHtml2Canvas.call(pageWindow);
    }
    const userscriptApi = createIxlUserscriptApi(tab, pageWindow, pageUrl);
    const runUserscript = pageWindow.Function(
      "GM_xmlhttpRequest",
      "GM_addStyle",
      "GM_getValue",
      "GM_setValue",
      "html2canvas",
      `${helperSource}\n//# sourceURL=asteroid-ixl-answer-helper.user.js`
    );
    runUserscript.call(
      pageWindow,
      userscriptApi.GM_xmlhttpRequest,
      userscriptApi.GM_addStyle,
      userscriptApi.GM_getValue,
      userscriptApi.GM_setValue,
      html2canvas
    );
    root.dataset.asteroidIxlAnswerHelper = IXL_ANSWER_HELPER_BUILD;
    log(`IXL Answer Helper ${IXL_ANSWER_HELPER_BUILD} loaded for ${new URL(pageUrl).hostname}`, "ok");
    return true;
  } catch (error) {
    root.dataset.asteroidIxlAnswerHelper = "error";
    log(`IXL Answer Helper could not start: ${textError(error)}`, "err");
    return false;
  }
}

function installFrameHooks(tab) {
  const hook = tab.sj?.hooks?.init?.pre;
  if (!hook || !globalThis.$scramjet?.Tap?.tap) return;
  $scramjet.Tap.tap(hook, ({ window: pageWindow }) => {
    try {
      if (settings.pageUA) Object.defineProperty(pageWindow.navigator, "userAgent", { configurable: true, get: () => settings.pageUA });
      if (compatibilityEffectiveSetting("webrtcBlock", tab)) {
        const blocked = class { constructor() { throw new DOMException("WebRTC is blocked by Asteroid Browser", "SecurityError"); } };
        Object.defineProperty(pageWindow, "RTCPeerConnection", { configurable: true, value: blocked });
        Object.defineProperty(pageWindow, "webkitRTCPeerConnection", { configurable: true, value: blocked });
        if (pageWindow.navigator.mediaDevices?.getUserMedia) {
          Object.defineProperty(pageWindow.navigator.mediaDevices, "getUserMedia", {
            configurable: true,
            value: () => Promise.reject(new DOMException("WebRTC is blocked by Asteroid Browser", "SecurityError"))
          });
        }
      }
      pageWindow.addEventListener("error", (event) => noteCompatibilityPageError(tab, event.error || event.message || "Page script error"), true);
      pageWindow.addEventListener("unhandledrejection", (event) => noteCompatibilityPageError(tab, event.reason || "Unhandled promise rejection"));
      pageWindow.addEventListener("DOMContentLoaded", () => {
        applyPageEnhancements(tab);
        void injectIxlAnswerHelper(tab, pageWindow);
      }, { once: true });
    } catch (error) { console.warn("Asteroid Browser frame hook failed", error); }
  });
}
function createTab(initial = null, activate = true) {
  const id = tabs.size === 0 ? 1 : nextTabId++;
  const iframe = createFrameElement(id);
  const sj = controller.createFrame(iframe);
  const tab = { id, iframe, sj, title: "New Tab", url: "", isHome: true, isSettings: false, muted: false, favicon: "", stack: [], stackIndex: -1, suspended: false, loading: false };
  tabs.set(id, tab);
  installFrameHooks(tab);
  iframe.addEventListener("load", () => syncAfterLoad(tab));
  iframe.addEventListener("error", () => { metrics.errors += 1; saveMetrics(); setStatus("error", "Load error"); log(`Frame load error: ${tab.url}`, "err"); failCompatibilityTrial(tab, "Frame load error"); });
  renderTabs(); if (activate) activateTab(id); if (initial) navigate(tab, initial); return tab;
}
function closeTab(id) {
  const tab = tabs.get(id); if (!tab) return;
  clearCompatibilityTimers(tab);
  const order = [...tabs.keys()], index = order.indexOf(id);
  if (tab.iframe !== frameRoot) tab.iframe.remove(); else { tab.iframe.src = "about:blank"; tab.iframe.classList.remove("active"); }
  tabs.delete(id);
  if (controller?.frames) controller.frames = controller.frames.filter((frame) => frame !== tab.sj);
  if (!tabs.size) { createTab(); return; }
  if (activeTabId === id) activateTab(order[index + 1] && tabs.has(order[index + 1]) ? order[index + 1] : order[Math.max(0, index - 1)]);
  else renderTabs();
}
function clearTabFrame(tab) {
  if (!tab?.iframe) return;
  try { tab.iframe.contentWindow?.stop(); tab.iframe.src = "about:blank"; } catch {}
}
function showHome(tab = activeTab()) {
  if (!tab) return;
  clearCompatibilityTimers(tab); tab.compatibilityTrial = null;
  clearTabFrame(tab);
  tab.isHome = true; tab.isSettings = false; tab.title = "New Tab"; tab.url = ""; tab.loading = false; tab.favicon = "";
  activateTab(tab.id);
}
function showSettings(tab = activeTab(), section = "connection") {
  if (!tab) return;
  clearCompatibilityTimers(tab); tab.compatibilityTrial = null;
  clearTabFrame(tab);
  tab.isHome = false; tab.isSettings = true; tab.title = "Settings"; tab.url = `asteroid://settings/${section}`; tab.loading = false; tab.favicon = "";
  openSettingsSection(section);
  activateTab(tab.id);
}
function pushTabStack(tab, url) {
  if (tab.stack[tab.stackIndex] === url) return;
  tab.stack = tab.stack.slice(0, tab.stackIndex + 1);
  tab.stack.push(url); tab.stackIndex = tab.stack.length - 1;
}
function navigate(tab, value, options = {}) {
  if (!tab) return;
  const url = normalize(value);
  if (url === HOME) { showHome(tab); return; }
  if (url.startsWith("asteroid://settings")) { showSettings(tab, url.split("/").pop() || "connection"); return; }
  tab.isHome = false; tab.isSettings = false; tab.url = url; tab.title = "Loading…"; tab.loading = true; tab.suspended = false;
  beginCompatibilityNavigation(tab, url);
  if (!options.fromHistory) pushTabStack(tab, url);
  activateTab(tab.id); if (tab.compatibilityStatus !== "testing") setStatus("loading", "Loading");
  log(`Scramjet navigation: ${url}`, "info");
  try { tab.sj.go(url); } catch (error) { tab.loading = false; metrics.errors += 1; saveMetrics(); setStatus("error", "Error"); log(textError(error), "err"); failCompatibilityTrial(tab, `Navigation failed: ${textError(error)}`); }
}
function decodeFrameUrl(tab, fallback = tab.url) {
  try {
    const current = new URL(tab.iframe.contentWindow.location.href);
    const prefix = new URL(tab.sj.prefix, location.href).pathname;
    if (!current.pathname.startsWith(prefix)) return fallback;
    const encoded = current.pathname.slice(prefix.length) + current.search + current.hash;
    return controller.config.codec.decode(encoded);
  } catch { return fallback; }
}
function syncAfterLoad(tab) {
  if (!tabs.has(tab.id) || tab.isHome || tab.isSettings || tab.suspended) return;
  tab.loading = false;
  const decoded = decodeFrameUrl(tab);
  if (/^https?:/i.test(decoded)) {
    tab.url = decoded;
    if (tab.stack[tab.stackIndex] !== decoded) pushTabStack(tab, decoded);
  }
  try {
    const documentTitle = tab.iframe.contentDocument?.title?.trim();
    tab.title = documentTitle ? documentTitle.slice(0, 100) : titleFor(tab.url);
    const icon = tab.iframe.contentDocument?.querySelector('link[rel~="icon"],link[rel="shortcut icon"]')?.href;
    if (icon) tab.favicon = icon;
  } catch { tab.title = titleFor(tab.url); }
  addHistory(tab.url, tab.title);
  applyPageEnhancements(tab);
  void injectIxlAnswerHelper(tab);
  if (tab.compatibilityTrial) {
    if (tab.compatibilityHardTimer) clearTimeout(tab.compatibilityHardTimer);
    tab.compatibilityHardTimer = setTimeout(() => failCompatibilityTrial(tab, "The page never settled after loading"), COMPATIBILITY_HARD_TIMEOUT_MS);
    scheduleCompatibilityEvaluation(tab);
  }
  if (tab.id === activeTabId) { if (urlInput) urlInput.value = tab.url; setStatus(tab.compatibilityTrial ? "loading" : "ready", tab.compatibilityTrial ? `Testing ${(compatibilityRecord(tab.compatibilityHost)?.failed?.length || 0) + 1}/${COMPATIBILITY_MATRIX.length}` : "Ready"); }
  renderTabs(); renderCompatibilityUI();
}
function stopLoading(tab = activeTab()) {
  if (!tab || tab.isHome || tab.isSettings) return;
  try { tab.iframe.contentWindow.stop(); } catch {}
  tab.loading = false; clearCompatibilityTimers(tab); tab.compatibilityTrial = null; setStatus("ready", "Stopped"); renderTabs(); renderCompatibilityUI();
}
function goBack() {
  const tab = activeTab(); if (!tab || tab.stackIndex <= 0) return;
  tab.stackIndex -= 1; navigate(tab, tab.stack[tab.stackIndex], { fromHistory: true });
}
function goForward() {
  const tab = activeTab(); if (!tab || tab.stackIndex >= tab.stack.length - 1) return;
  tab.stackIndex += 1; navigate(tab, tab.stack[tab.stackIndex], { fromHistory: true });
}
function reloadTab(tab = activeTab()) {
  if (!tab) return;
  if (tab.isHome) { renderHome(); return; }
  if (tab.isSettings) { applySettingsToUI(); return; }
  tab.loading = true; setStatus("loading", "Reloading");
  try { tab.sj.reload(); } catch { navigate(tab, tab.url, { fromHistory: true }); }
}
function suspendTab(tab) {
  clearCompatibilityTimers(tab); tab.compatibilityTrial = null;
  try { tab.iframe.contentWindow.stop(); tab.iframe.src = "about:blank"; tab.suspended = true; } catch {}
}
function resumeTab(tab) {
  tab.suspended = false;
  if (tab.url) navigate(tab, tab.url, { fromHistory: true });
}
function applyMuted(tab) {
  if (!tab || tab.isHome || tab.isSettings) return;
  try {
    const doc = tab.iframe.contentDocument;
    doc?.querySelectorAll("audio,video").forEach((media) => { media.muted = tab.muted; });
    if (doc && !doc.documentElement.dataset.asteroidMuteHook) {
      doc.documentElement.dataset.asteroidMuteHook = "1";
      doc.addEventListener("play", (event) => {
        const media = event.target;
        const MediaElement = tab.iframe.contentWindow?.HTMLMediaElement;
        if (tab.muted && MediaElement && media instanceof MediaElement) media.muted = true;
      }, true);
    }
  } catch {}
}

const defaultBlockPatterns = [
  "doubleclick.net", "googlesyndication.com", "googleadservices.com", "adservice.google.", "amazon-adsystem.com",
  "scorecardresearch.com", "zedo.com", "taboola.com", "outbrain.com", "adsrvr.org", "adnxs.com",
  "facebook.net/tr/", "connect.facebook.net/en_US/fbevents", "analytics.google.com", "google-analytics.com",
  "googletagmanager.com/gtag", "hotjar.com", "clarity.ms/tag", "segment.io", "mixpanel.com/track"
];
function hostnameAllowed(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return settings.allowlist.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
  } catch { return false; }
}
function shouldBlockUrl(url) {
  if (!compatibilityRequestSetting("adblock", url) || hostnameAllowed(url)) return false;
  const lower = String(url).toLowerCase();
  return defaultBlockPatterns.some((pattern) => lower.includes(pattern));
}
function headersToMap(headers) {
  const map = new Map();
  for (const [key, value] of headers || []) map.set(String(key).toLowerCase(), [String(key), String(value)]);
  return map;
}
function mapToHeaders(map) { return [...map.values()]; }
function modifyRequestHeaders(remote, rawHeaders) {
  const map = headersToMap(rawHeaders);
  if (settings.requestUA) map.set("user-agent", ["user-agent", settings.requestUA]);
  if (!compatibilityRequestSetting("mediaRange", remote)) map.delete("range");
  if (compatibilityRequestSetting("smartHeaders", remote)) {
    const referer = map.get("referer")?.[1] || map.get("referrer")?.[1] || "";
    let site = "none";
    try { site = referer ? (new URL(referer).origin === remote.origin ? "same-origin" : "cross-site") : "none"; } catch {}
    map.set("sec-fetch-site", ["sec-fetch-site", site]);
    const accept = map.get("accept")?.[1] || "";
    if (!map.has("sec-fetch-mode")) map.set("sec-fetch-mode", ["sec-fetch-mode", accept.includes("text/html") ? "navigate" : "cors"]);
    if (!map.has("sec-fetch-dest")) map.set("sec-fetch-dest", ["sec-fetch-dest", accept.includes("text/html") ? "document" : "empty"]);
  }
  return mapToHeaders(map);
}
function cloneRawHeaders(headers) {
  return Array.from(headers || [], ([key, value]) => [String(key), String(value)]);
}
function firstHeader(headers, name) {
  const lower = String(name).toLowerCase();
  return headers.find(([key]) => String(key).toLowerCase() === lower)?.[1] || "";
}
function deleteRawHeader(headers, name) {
  const lower = String(name).toLowerCase();
  return headers.filter(([key]) => String(key).toLowerCase() !== lower);
}
function setRawHeader(headers, name, value) {
  return [...deleteRawHeader(headers, name), [String(name), String(value)]];
}
function responseContentType(headers) { return firstHeader(headers, "content-type").toLowerCase(); }
function forceDownloadForType(type) {
  if (type.includes("application/pdf")) return !settings.mediaPdf;
  if (type.startsWith("image/")) return !settings.mediaImg;
  if (type.startsWith("video/")) return !settings.mediaVideo;
  if (type.startsWith("audio/")) return !settings.mediaAudio;
  if (type.startsWith("text/") || /json|xml|javascript|csv/.test(type)) return !settings.mediaText;
  const known = /html|css|font|wasm/.test(type);
  return settings.mediaDownloadUnknown && (!type || type.includes("octet-stream") || !known);
}
function modifyResponse(response, remote) {
  let headers = cloneRawHeaders(response.headers);
  const type = responseContentType(headers);
  if (forceDownloadForType(type)) {
    let filename = remote.pathname.split("/").pop() || "download";
    try { filename = decodeURIComponent(filename); } catch {}
    filename = filename.replace(/["\\\r\n]/g, "_").slice(0, 180) || "download";
    headers = setRawHeader(headers, "content-disposition", `attachment; filename="${filename}"`);
  } else if (/application\/pdf|^image\/|^video\/|^audio\/|^text\//.test(type)) {
    const disposition = firstHeader(headers, "content-disposition");
    if (/attachment/i.test(disposition)) headers = deleteRawHeader(headers, "content-disposition");
  }
  return { ...response, headers };
}
function looksLikeDnsError(error) { return /dns|resolve|host|name not resolved|nxdomain/i.test(textError(error)); }
function isTimeoutError(error) {
  return error?.name === "TimeoutError" || /timeout|timed out/i.test(textError(error));
}
async function requestWithTimeout(client, remote, method, body, headers, signal, seconds) {
  if (signal?.aborted) throw signal.reason || new DOMException("The request was aborted", "AbortError");
  const controller = new AbortController();
  let timer = 0;
  let abortHandler = null;
  const requestPromise = Promise.resolve().then(() => client.request(remote, method, body, headers, controller.signal));
  const racers = [requestPromise];
  if (signal) {
    racers.push(new Promise((_, reject) => {
      abortHandler = () => {
        controller.abort(signal.reason);
        reject(signal.reason || new DOMException("The request was aborted", "AbortError"));
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    }));
  }
  if (seconds > 0) {
    racers.push(new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DOMException("Transport request timed out", "TimeoutError"));
      }, seconds * 1000);
    }));
  }
  try { return await Promise.race(racers); }
  finally {
    if (timer) clearTimeout(timer);
    if (abortHandler) signal?.removeEventListener("abort", abortHandler);
  }
}
class Semaphore {
  constructor(max) { this.max = Math.max(1, Number(max) || 1); this.active = 0; this.queue = []; }
  setMax(max) { this.max = Math.max(1, Number(max) || 1); this.drain(); }
  acquire() {
    if (this.active < this.max) { this.active += 1; return Promise.resolve(); }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() { if (this.active > 0) this.active -= 1; this.drain(); }
  drain() {
    while (this.active < this.max && this.queue.length) {
      this.active += 1;
      this.queue.shift()();
    }
  }
}
const externalScriptLoads = new Map();
function promiseWithTimeout(promise, milliseconds, message) {
  let timer = 0;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DOMException(message, "TimeoutError")), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}
function resolveLibcurlClient() {
  const bundle = globalThis.LibcurlTransport;
  const candidate = bundle?.LibcurlClient || bundle?.default || (typeof bundle === "function" ? bundle : null);
  return typeof candidate === "function" ? candidate : null;
}
function loadExternalScript(url, timeoutMs = 12000) {
  if (externalScriptLoads.has(url)) return externalScriptLoads.get(url);
  const promise = new Promise((resolve, reject) => {
    const existing = [...document.scripts].find((script) => script.src === url);
    const script = existing || document.createElement("script");
    let timer = 0;
    const cleanup = () => {
      clearTimeout(timer);
      script.removeEventListener("load", loaded);
      script.removeEventListener("error", failed);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error(`Could not load ${url}`)); };
    script.addEventListener("load", loaded, { once: true });
    script.addEventListener("error", failed, { once: true });
    timer = setTimeout(() => failed(), timeoutMs);
    if (!existing) {
      script.src = url;
      script.async = true;
      script.referrerPolicy = "no-referrer";
      document.head.append(script);
    } else if (resolveLibcurlClient()) {
      cleanup(); resolve();
    }
  });
  externalScriptLoads.set(url, promise);
  promise.catch(() => externalScriptLoads.delete(url));
  return promise;
}
async function loadLibcurlClient() {
  const ready = resolveLibcurlClient();
  if (ready) return ready;
  const errors = [];
  for (const rawUrl of LIBCURL_SCRIPT_URLS) {
    try {
      const url = new URL(rawUrl, location.href);
      if (!/^https?:$/.test(url.protocol) || (location.protocol === "https:" && url.protocol !== "https:")) throw new Error("Libcurl bundle URL must use HTTPS");
      await loadExternalScript(url.href);
      const Client = resolveLibcurlClient();
      if (Client) return Client;
      throw new Error("Libcurl bundle loaded without exporting LibcurlClient");
    } catch (error) {
      errors.push(textError(error));
      log(`Libcurl source failed: ${textError(error)}`, "warn");
    }
  }
  throw new Error(`Libcurl ${LIBCURL_TRANSPORT_VERSION} could not be loaded: ${errors.join(" | ")}`);
}
function transportDisplayName(name) {
  return name === "fallback" ? "Epoxy backup" : `Libcurl ${LIBCURL_TRANSPORT_VERSION}`;
}

class ResilientTransport {
  constructor() {
    this.ready = false;
    this.primary = null;
    this.fallback = null;
    this.activeName = "primary";
    this.primaryRetryAt = 0;
    this.semaphore = new Semaphore(settings.activeThreads);
    this.client_version = null;
  }
  async init() {
    let primaryError = null;
    try {
      const LibcurlClient = await loadLibcurlClient();
      this.primary = new LibcurlClient({ wisp: settings.wispUrl });
      await promiseWithTimeout(this.primary.init(), Math.max(30000, settings.timeoutSeconds * 1000), "Libcurl initialization timed out");
      if (!this.primary.ready) throw new Error("Libcurl initialized without becoming ready");
      this.client_version = { name: "libcurl-transport", version: LIBCURL_TRANSPORT_VERSION };
      log(`Libcurl ${LIBCURL_TRANSPORT_VERSION} initialized as the default transport`, "ok");
    } catch (error) {
      primaryError = error;
      this.primary = null;
      log(`Libcurl startup failed: ${textError(error)}`, "warn");
    }

    if (settings.fallbackEnabled) {
      const epoxyWisp = settings.fallbackWispUrl || settings.wispUrl;
      try {
        this.fallback = new EpoxyTransport({ wisp: epoxyWisp });
        await promiseWithTimeout(this.fallback.init(), Math.max(30000, settings.timeoutSeconds * 1000), "Epoxy initialization timed out");
        log("Epoxy initialized as the backup transport", "ok");
      } catch (error) {
        this.fallback = null;
        log(`Epoxy backup initialization failed: ${textError(error)}`, "warn");
      }
    }

    if (!this.primary && this.fallback) {
      this.activeName = "fallback";
      this.client_version = this.fallback.client_version || { name: "epoxy-transport", version: "3.0.1" };
      metrics.fallbackSwitches += 1; saveMetrics();
      log("Using Epoxy because Libcurl is unavailable", "warn");
    }
    if (!this.primary && !this.fallback) {
      throw new Error(`No proxy transport could start. Libcurl: ${textError(primaryError || "unavailable")}; Epoxy: unavailable or disabled.`);
    }
    this.ready = true;
  }
  async meta() {
    const active = this.activeName === "fallback" ? this.fallback : this.primary;
    return active?.meta?.();
  }
  candidates() {
    const keepBackupFirst = this.activeName === "fallback" && Date.now() < this.primaryRetryAt;
    const list = keepBackupFirst
      ? [{ name: "fallback", client: this.fallback }, { name: "primary", client: this.primary }]
      : [{ name: "primary", client: this.primary }, { name: "fallback", client: this.fallback }];
    return list.filter(({ client }) => client);
  }
  async request(remote, method, body, headers, signal, timeoutSeconds = settings.timeoutSeconds) {
    metrics.requests += 1; saveMetrics(); setText("stats", `${metrics.requests} requests`);
    noteCompatibilityRequest(remote);
    if (shouldBlockUrl(remote.href)) {
      metrics.blocked += 1; saveMetrics(); updateAdblockUI();
      log(`Blocked tracker: ${remote.hostname}`, "warn");
      return { body: new ArrayBuffer(0), headers: [["content-type", "text/plain"], ["x-asteroid-blocked", "1"]], status: 204, statusText: "Blocked by Asteroid Browser" };
    }
    this.semaphore.setMax([...tabs.values()].some((tab) => tab.loading) ? settings.activeThreads : settings.idleThreads);
    await this.semaphore.acquire();
    try {
      const requestHeaders = modifyRequestHeaders(remote, headers);
      const replaySafe = /^(GET|HEAD)$/i.test(String(method));
      const allCandidates = this.candidates();
      const candidates = replaySafe ? allCandidates : allCandidates.slice(0, 1);
      let lastError;
      candidateLoop: for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
        const { name, client } = candidates[candidateIndex];
        if (name === "fallback" && !settings.fallbackEnabled) continue;
        const retries = replaySafe ? (name === "primary" ? settings.mainRetries : settings.fallbackRetries) : 0;
        for (let attempt = 0; attempt <= retries; attempt += 1) {
          try {
            const response = await requestWithTimeout(
              client,
              remote,
              method,
              body,
              requestHeaders,
              signal,
              clampNumber(timeoutSeconds, settings.timeoutSeconds, 1, 120)
            );
            if (replaySafe && response.status >= 500 && settings.fallback5xx && name === "primary" && this.fallback) throw new Error(`Libcurl received HTTP ${response.status}`);
            if (this.activeName !== name) {
              this.activeName = name;
              this.primaryRetryAt = name === "fallback" ? Date.now() + 60000 : 0;
              metrics.fallbackSwitches += 1; saveMetrics();
              log(`Transport switched to ${transportDisplayName(name)}`, name === "fallback" ? "warn" : "ok");
            }
            return modifyResponse(response, remote);
          } catch (error) {
            if (signal?.aborted) throw error;
            lastError = error;
            const eligibleForFallback = (isTimeoutError(error) && settings.fallbackTimeout)
              || (looksLikeDnsError(error) && settings.fallbackDns)
              || (!isTimeoutError(error) && !looksLikeDnsError(error));
            log(`${transportDisplayName(name)} attempt ${attempt + 1} failed: ${textError(error)}`, "warn");
            if (attempt < retries) { await sleep(settings.retryDelay * 1000); continue; }
            if (name === "primary" && !eligibleForFallback) break candidateLoop;
          }
        }
      }
      metrics.errors += 1; saveMetrics();
      noteCompatibilityTransportError(remote, lastError || new Error("Libcurl and Epoxy both failed"));
      throw lastError || new Error("Libcurl and Epoxy both failed");
    } finally { this.semaphore.release(); }
  }
  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    const candidates = this.candidates().filter(({ name }) => name !== "fallback" || settings.fallbackEnabled);
    let send = () => {};
    let close = () => {};
    let closed = false;
    let opened = false;
    let candidateIndex = 0;
    let generation = 0;
    let lastError = null;
    const startNext = () => {
      if (closed) return;
      const candidate = candidates[candidateIndex++];
      if (!candidate) { const error = lastError || new Error("Libcurl and Epoxy WebSocket transports both failed"); noteCompatibilityTransportError(url, error); onerror(error); return; }
      const { name, client } = candidate;
      const token = ++generation;
      let localSend = () => {};
      let localClose = () => {};
      let openTimer = 0;
      let failed = false;
      const failBeforeOpen = (error) => {
        if (failed || opened || closed || token !== generation) return false;
        failed = true;
        lastError = error instanceof Error ? error : new Error(String(error || `${transportDisplayName(name)} WebSocket closed before opening`));
        if (openTimer) clearTimeout(openTimer);
        try { localClose(1000, "Trying another Wisp"); } catch {}
        if (candidateIndex < candidates.length) {
          metrics.fallbackSwitches += 1; saveMetrics();
          log(`${transportDisplayName(name)} WebSocket failed; trying ${transportDisplayName(candidates[candidateIndex].name)}`, "warn");
          startNext();
          return true;
        }
        noteCompatibilityTransportError(url, lastError);
        onerror(lastError);
        return false;
      };
      try {
        const pair = client.connect(
          url, protocols, modifyRequestHeaders(url, requestHeaders),
          (protocol, extensions) => {
            if (closed || failed || token !== generation) { try { localClose(1000, "Superseded transport"); } catch {} return; }
            if (openTimer) clearTimeout(openTimer);
            opened = true;
            this.activeName = name;
            this.primaryRetryAt = name === "fallback" ? Date.now() + 60000 : 0;
            send = localSend; close = localClose;
            onopen(protocol, extensions);
          },
          (data) => { if (opened && !closed && token === generation) onmessage(data); },
          (code, reason) => {
            if (!opened && failBeforeOpen(new Error(`${transportDisplayName(name)} WebSocket closed before opening (${code})`))) return;
            if (opened && !closed && token === generation) onclose(code, reason);
          },
          (error) => {
            if (!opened && failBeforeOpen(error)) return;
            if (opened && !closed && token === generation) onerror(error);
          }
        );
        localSend = pair?.[0] || localSend;
        localClose = pair?.[1] || localClose;
        send = localSend; close = localClose;
        if (!opened) openTimer = setTimeout(() => failBeforeOpen(new DOMException("WebSocket transport timed out", "TimeoutError")), Math.max(5, settings.timeoutSeconds) * 1000);
      } catch (error) { failBeforeOpen(error); }
    };
    startNext();
    return [
      (data) => { if (!closed) send(data); },
      (code, reason) => { if (closed) return; closed = true; generation += 1; try { close(code, reason); } catch {} }
    ];
  }
}

function applyPageEnhancements(tab) {
  if (!tab || tab.isHome || tab.isSettings) return;
  try {
    const doc = tab.iframe.contentDocument;
    if (!doc) return;
    doc.documentElement.lang = settings.language || doc.documentElement.lang || "en";
    doc.querySelectorAll("input,textarea").forEach((input) => { input.spellcheck = settings.spellcheck; });
    let style = doc.getElementById("asteroid-custom-filters");
    if (!style) { style = doc.createElement("style"); style.id = "asteroid-custom-filters"; doc.documentElement.append(style); }
    const defaultsCss = compatibilityEffectiveSetting("adblock", tab) && !hostnameAllowed(tab.url) ? [
      '[id*="advert" i]', '[class*="advert" i]', '[id^="ad-"]', '[class^="ad-"]', '[class*=" ad-"]',
      'iframe[src*="doubleclick"]', 'iframe[src*="googlesyndication"]', '[data-ad-client]', '[data-ad-slot]'
    ] : [];
    const validSelectors = [...defaultsCss, ...settings.customFilters].filter(Boolean).filter((selector) => {
      try { doc.querySelector(selector); return true; }
      catch { log(`Ignored invalid cosmetic filter: ${selector}`, "warn"); return false; }
    });
    style.textContent = validSelectors.map((selector) => `${selector}{display:none!important;visibility:hidden!important}`).join("\n");
    applyMuted(tab);
  } catch (error) { log(`Page enhancement skipped: ${textError(error)}`, "warn"); }
}

function renderBookmarks() {
  const bar = $("bookmarks"), favorites = $("ntFavorites");
  if (bar) {
    bar.querySelectorAll(".bookmark[data-generated='1']").forEach((el) => el.remove());
    for (const item of bookmarks) {
      const button = document.createElement("button"); button.className = "bookmark"; button.dataset.generated = "1";
      button.innerHTML = `<i class="fas fa-bookmark"></i><span></span>`; button.querySelector("span").textContent = item.name || titleFor(item.url);
      button.title = item.url; button.addEventListener("click", () => navigate(activeTab(), item.url));
      button.addEventListener("contextmenu", (event) => { event.preventDefault(); if (confirm(`Remove bookmark “${item.name || item.url}”?`)) { bookmarks = bookmarks.filter((x) => x.id !== item.id); saveBookmarks(); renderBookmarks(); } });
      bar.insertBefore(button, $("bookmarksToggle"));
    }
  }
  if (favorites) {
    favorites.innerHTML = "";
    for (const item of bookmarks.slice(0, 8)) {
      const button = document.createElement("button"); button.className = "nt-fav-box";
      button.innerHTML = `<i class="fas fa-bookmark"></i><span></span>`; button.querySelector("span").textContent = item.name || titleFor(item.url);
      button.title = item.url; button.addEventListener("click", () => navigate(activeTab(), item.url)); favorites.append(button);
    }
    const add = document.createElement("button"); add.className = "nt-fav-add"; add.innerHTML = '<i class="fas fa-plus"></i><span>Add</span>';
    add.addEventListener("click", openAddFavorite); favorites.append(add);
  }
  applyBookmarksBar();
}
function applyBookmarksBar() {
  const wrap = $("bookmarksWrap"); if (!wrap) return;
  wrap.style.display = settings.bookmarksBar ? "" : "none";
  if ($("showBookmarksBtn")) $("showBookmarksBtn").style.display = settings.bookmarksBar ? "none" : "";
}
function openBookmarkModal() {
  const tab = activeTab(); if (!tab || tab.isHome || tab.isSettings) { notify("Open a webpage before bookmarking", "warn"); return; }
  $("bookmarkUrlInput").value = tab.url; $("bookmarkNameInput").value = tab.title || titleFor(tab.url); showModal("bookmarkModal"); $("bookmarkNameInput")?.focus();
}
function openAddFavorite() {
  $("favoriteUrlInput").value = activeTab()?.url || ""; $("favoriteNameInput").value = activeTab()?.title || ""; showModal("addFavoriteModal"); $("favoriteUrlInput")?.focus();
}
function saveBookmark(url, name) {
  const normalized = normalize(url); if (!/^https?:/i.test(normalized)) { notify("Enter a valid webpage URL", "err"); return false; }
  bookmarks = bookmarks.filter((item) => item.url !== normalized);
  bookmarks.unshift({ id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, url: normalized, name: String(name || titleFor(normalized)).trim().slice(0, 80) });
  saveBookmarks(); renderBookmarks(); notify("Bookmark saved", "ok"); return true;
}
function renderHistory() {
  const list = $("historyList"); if (!list) return;
  list.innerHTML = "";
  if (!historyItems.length) { list.innerHTML = '<div style="padding:18px;color:var(--tx3);text-align:center">No history yet</div>'; return; }
  for (const item of historyItems.slice(0, 20)) {
    const button = document.createElement("button"); button.className = "site-info-btn"; button.style.cssText = "width:100%;display:flex;flex-direction:column;align-items:flex-start;gap:2px;margin:2px 0";
    const title = document.createElement("span"); title.textContent = item.title || titleFor(item.url); title.style.color = "var(--tx)";
    const meta = document.createElement("span"); meta.textContent = `${new Date(item.time).toLocaleString()} · ${item.url}`; meta.style.cssText = "font-size:10px;color:var(--tx3);max-width:100%;overflow:hidden;text-overflow:ellipsis";
    button.append(title, meta); button.addEventListener("click", () => { hideModal("historyPopup"); navigate(activeTab(), item.url); }); list.append(button);
  }
}
function toggleHistory() { renderHistory(); const popup = $("historyPopup"); if (popup) popup.style.display = popup.style.display === "flex" ? "none" : "flex"; }

function openFind() { $("findBar")?.classList.remove("hidden"); $("findInput")?.focus(); $("findInput")?.select(); runFind(false); }
function closeFind() { $("findBar")?.classList.add("hidden"); setText("findStatus", ""); findIndex = 0; findCount = 0; lastFindQuery = ""; try { activeTab()?.iframe.contentWindow?.getSelection?.()?.removeAllRanges(); } catch {} }
function buildFindRanges(doc, query) {
  if (!doc?.body || !query) return [];
  const lowerQuery = query.toLowerCase();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!node.nodeValue?.trim() || parent?.closest("script,style,noscript,template")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  const ranges = [];
  while (walker.nextNode() && ranges.length < 5000) {
    const node = walker.currentNode;
    const lower = (node.nodeValue || "").toLowerCase();
    let offset = 0;
    while ((offset = lower.indexOf(lowerQuery, offset)) !== -1 && ranges.length < 5000) {
      const range = doc.createRange();
      range.setStart(node, offset); range.setEnd(node, offset + query.length);
      ranges.push(range); offset += Math.max(1, query.length);
    }
  }
  return ranges;
}
function selectFindRange(tab, range) {
  const selection = tab?.iframe?.contentWindow?.getSelection?.();
  if (!selection) return false;
  selection.removeAllRanges(); selection.addRange(range);
  range.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}
function runFind(backwards = false) {
  const query = ($("findInput")?.value || "").trim();
  if (!query) { setText("findStatus", ""); findIndex = 0; findCount = 0; lastFindQuery = ""; return; }
  if (query !== lastFindQuery) { findIndex = 0; lastFindQuery = query; }
  const tab = activeTab(); if (!tab || tab.isHome || tab.isSettings) { setText("findStatus", "Not available on this page"); return; }
  try {
    const ranges = buildFindRanges(tab.iframe.contentDocument, query);
    findCount = ranges.length;
    if (!findCount) { findIndex = 0; setText("findStatus", "No matches"); return; }
    findIndex = backwards ? (findIndex <= 1 ? findCount : findIndex - 1) : (findIndex >= findCount ? 1 : findIndex + 1);
    selectFindRange(tab, ranges[findIndex - 1]);
    setText("findStatus", `${findIndex} of ${findCount}${findCount >= 5000 ? "+" : ""}`);
  } catch { setText("findStatus", "Page does not allow search"); }
}

function renderHome() {
  updateClock(); applyWallpaper(); renderBookmarks();
  const label = $("ntEngineLabel"); if (label) label.textContent = settings.searchEngineName;
  $("ntHeader")?.classList.toggle("hidden", !settings.showClock);
}
function updateClock() {
  const now = new Date();
  if ($("ntTime")) {
    const options = { hour: "numeric", minute: "2-digit", hour12: !settings.clock24 };
    $("ntTime").childNodes[0].nodeValue = `${now.toLocaleTimeString(settings.language || undefined, options)} `;
  }
  setText("ntDate", now.toLocaleDateString(settings.language || undefined, { weekday: "long", month: "long", day: "numeric" }));
  const hour = now.getHours(); if ($("ntTimeIcon")) $("ntTimeIcon").className = hour >= 6 && hour < 18 ? "fas fa-sun" : "fas fa-moon";
  const header = $("ntDate")?.parentElement; if (header) header.style.display = settings.showClock ? "" : "none";
}
let assetDbPromise = null;
let wallpaperObjectUrl = "";
function openAssetDb() {
  if (!assetDbPromise) {
    assetDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(ASSET_DB, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(ASSET_STORE)) request.result.createObjectStore(ASSET_STORE); };
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); assetDbPromise = null; };
        resolve(request.result);
      };
      request.onerror = () => reject(request.error || new Error("Could not open browser asset storage"));
      request.onblocked = () => reject(new Error("Browser asset storage is blocked by another tab"));
    }).catch((error) => { assetDbPromise = null; throw error; });
  }
  return assetDbPromise;
}
async function closeAssetDb() {
  try { (await assetDbPromise)?.close?.(); } catch {}
  assetDbPromise = null;
}
async function assetRequest(mode, operation) {
  const db = await openAssetDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(ASSET_STORE, mode);
    let result;
    const request = operation(transaction.objectStore(ASSET_STORE));
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error || new Error("Browser asset request failed"));
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error("Browser asset transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("Browser asset transaction aborted"));
  });
}
function revokeWallpaperObjectUrl() { if (wallpaperObjectUrl) URL.revokeObjectURL(wallpaperObjectUrl); wallpaperObjectUrl = ""; }
async function restoreWallpaperAsset() {
  if (settings.wallpaper !== WALLPAPER_TOKEN) return;
  if (!("indexedDB" in globalThis)) {
    settings.wallpaper = ""; saveSettings(); applyWallpaper();
    return;
  }
  try {
    const blob = await assetRequest("readonly", (store) => store.get(WALLPAPER_KEY));
    if (!(blob instanceof Blob)) throw new Error("Saved wallpaper is missing");
    revokeWallpaperObjectUrl(); wallpaperObjectUrl = URL.createObjectURL(blob); applyWallpaper();
  } catch (error) {
    settings.wallpaper = ""; saveSettings(); applyWallpaper();
    log(`Saved wallpaper could not be restored: ${textError(error)}`, "warn");
  }
}
async function deleteWallpaperAsset() {
  revokeWallpaperObjectUrl();
  if (!("indexedDB" in globalThis)) return;
  try { await assetRequest("readwrite", (store) => store.delete(WALLPAPER_KEY)); } catch {}
}
function activeWallpaperValue() { return settings.wallpaper === WALLPAPER_TOKEN ? wallpaperObjectUrl : settings.wallpaper; }
function applyWallpaper() {
  const bg = $("ntBg"); if (!bg) return;
  const wallpaper = activeWallpaperValue();
  if (wallpaper) {
    bg.style.display = "block"; bg.style.backgroundImage = `url("${wallpaper.replace(/"/g, "%22")}")`;
    bg.style.backgroundSize = "cover"; bg.style.backgroundPosition = "center";
  } else { bg.style.backgroundImage = "none"; bg.style.display = "none"; }
  const status = settings.wallpaper === WALLPAPER_TOKEN && !wallpaperObjectUrl ? "Loading saved background…" : settings.wallpaper ? "Custom background active" : "Default black background";
  setText("settingsWallpaperStatus", status);
}
async function setWallpaper(value) {
  const previous = settings.wallpaper;
  const next = String(value || "").trim();
  if (next && next !== WALLPAPER_TOKEN && !/^(?:https?:|data:image\/|blob:)/i.test(next)) {
    notify("Wallpaper URLs must use HTTP(S) or an image data URL.", "err");
    return;
  }
  settings.wallpaper = next;
  if (!saveSettings()) { settings.wallpaper = previous; notify("Wallpaper could not be saved in this browser profile.", "err"); return; }
  if (next !== WALLPAPER_TOKEN) await deleteWallpaperAsset();
  applyWallpaper(); hideModal("wallpaperModal");
}
async function setWallpaperFile(file) {
  if (!file) return;
  if (!file.type.startsWith("image/")) { notify("Choose an image file.", "err"); return; }
  if (file.size > 12_000_000) { notify("Wallpaper must be under 12 MB.", "err"); return; }
  if (!("indexedDB" in globalThis)) { notify("This browser cannot store wallpaper files.", "err"); return; }
  try {
    await assetRequest("readwrite", (store) => store.put(file, WALLPAPER_KEY));
    revokeWallpaperObjectUrl(); wallpaperObjectUrl = URL.createObjectURL(file);
    const previous = settings.wallpaper; settings.wallpaper = WALLPAPER_TOKEN;
    if (!saveSettings()) { settings.wallpaper = previous; await deleteWallpaperAsset(); throw new Error("Browser settings storage is unavailable"); }
    applyWallpaper(); hideModal("wallpaperModal");
  } catch (error) { notify(`Wallpaper could not be saved: ${textError(error)}`, "err"); }
}

function createRandomWallpaper() {
  const hue = Math.floor(Math.random() * 360), hue2 = (hue + 45 + Math.floor(Math.random() * 100)) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="hsl(${hue} 35% 8%)"/><stop offset="1" stop-color="hsl(${hue2} 45% 15%)"/></linearGradient><radialGradient id="r"><stop stop-color="hsla(${hue2} 90% 70% /.28)"/><stop offset="1" stop-color="transparent"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="25%" cy="25%" r="38%" fill="url(#r)"/><circle cx="80%" cy="75%" r="48%" fill="url(#r)"/></svg>`;
  setWallpaper(`data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`);
}

function updateAdblockUI() {
  setSwitch("settingsBlockSwitch", settings.adblock);
  setSwitch("adblockLargeToggle", settings.adblock);
  $("adblockLargeToggle")?.classList.toggle("on", settings.adblock);
  $("blockToggle")?.classList.toggle("on", settings.adblock);
  setText("blockState", settings.adblock ? "Protected" : "Off");
  setText("adblockStatusText", settings.adblock ? "Protection Active" : "Protection Off");
  setText("adblockStatsCount", metrics.blocked);
  const host = currentHostname(); const paused = host && settings.allowlist.includes(host);
  setText("adblockPauseSiteBtnText", paused ? "Resume for this site" : "Pause for this site");
}
function toggleAdblock() { settings.adblock = !settings.adblock; saveSettings(); updateAdblockUI(); for (const tab of tabs.values()) applyPageEnhancements(tab); }
function togglePauseCurrentSite() {
  const host = currentHostname(); if (!host) return;
  settings.allowlist = settings.allowlist.includes(host) ? settings.allowlist.filter((x) => x !== host) : [...settings.allowlist, host];
  saveSettings(); updateAdblockUI(); applyPageEnhancements(activeTab());
}

function openSiteInfo() {
  const tab = activeTab();
  const host = currentHostname(tab) || (tab?.isSettings ? "Asteroid Browser settings" : "Asteroid Browser home");
  let protocol = "Internal"; try { protocol = new URL(tab?.url || "").protocol.replace(":", "").toUpperCase(); } catch {}
  setText("siteInfoTitle", tab?.isHome || tab?.isSettings ? "Internal Page" : "Proxied Connection");
  setText("siteInfoSubtitle", `Using ${transportDisplayName(transport?.activeName || "primary")}`);
  setText("siteInfoHost", host || "-"); setText("siteInfoProtocol", protocol);
  setText("siteInfoBlock", compatibilityEffectiveSetting("adblock", tab) && !hostnameAllowed(tab?.url || "") ? "Active" : "Paused");
  setText("siteInfoCookies", "Isolated by Scramjet"); setText("siteInfoCache", settings.tabCache ? "Enabled" : "Reduced");
  showModal("siteInfoPopup");
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(String(text)); return true; }
  catch {
    const area = document.createElement("textarea"); area.value = String(text); area.style.position = "fixed"; area.style.opacity = "0"; document.body.append(area); area.select();
    const ok = document.execCommand("copy"); area.remove(); return ok;
  }
}
async function renderMetrics() {
  const body = $("metricsBody"); if (!body) return;
  let storage = "Unavailable";
  try { const estimate = await navigator.storage.estimate(); storage = `${formatBytes(estimate.usage || 0)} used of ${formatBytes(estimate.quota || 0)}`; } catch {}
  const rows = [
    ["Scramjet", globalThis.$scramjet?.versionInfo?.version || "Loaded"],
    ["Controller", globalThis.$scramjetController?.VERSION || "Loaded"],
    ["Transport", transportDisplayName(transport?.activeName || "primary")],
    ["Active Wisp", transport?.activeName === "fallback" ? settings.fallbackWispUrl : settings.wispUrl],
    ["Tabs", tabs.size], ["Requests", metrics.requests], ["Blocked", metrics.blocked], ["Errors", metrics.errors],
    ["Fallback switches", metrics.fallbackSwitches], ["Session uptime", formatDuration(Date.now() - metrics.startedAt)], ["Storage", storage]
  ];
  body.innerHTML = rows.map(([label, value]) => `<div style="display:flex;justify-content:space-between;gap:18px;border-bottom:1px solid var(--bd);padding:8px 0"><span style="color:var(--tx2)">${escapeHtml(label)}</span><strong style="text-align:right;overflow-wrap:anywhere">${escapeHtml(value)}</strong></div>`).join("");
}
function formatBytes(bytes) { if (!Number.isFinite(bytes) || bytes <= 0) return "0 B"; const units = ["B", "KB", "MB", "GB"]; const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024))); return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`; }
function formatDuration(ms) { const seconds = Math.floor(ms / 1000); const minutes = Math.floor(seconds / 60); const hours = Math.floor(minutes / 60); return hours ? `${hours}h ${minutes % 60}m` : minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`; }

function openContextMenu(event) {
  if (event.target.closest("input,textarea,[contenteditable='true']") || event.target.closest(".tab")) return;
  event.preventDefault();
  const menu = $("contextMenu"); if (!menu) return;
  contextElement = event.target;
  menu.style.display = "block"; menu.style.left = `${Math.min(event.clientX, innerWidth - 190)}px`; menu.style.top = `${Math.min(event.clientY, innerHeight - 310)}px`;
}
function openTabContextMenu(event, tabId) {
  event.preventDefault(); contextTabId = tabId;
  const tab = tabs.get(tabId), menu = $("tabContextMenu"); if (!tab || !menu) return;
  const label = menu.querySelector("#tabCtxMute span"); if (label) label.textContent = tab.muted ? "Unmute Tab" : "Mute Tab";
  menu.style.display = "block"; menu.style.left = `${Math.min(event.clientX, innerWidth - 190)}px`; menu.style.top = `${Math.min(event.clientY, innerHeight - 160)}px`;
}
function closeMenus() { if ($("contextMenu")) $("contextMenu").style.display = "none"; if ($("tabContextMenu")) $("tabContextMenu").style.display = "none"; $("ntEngineDropdown")?.classList.remove("show"); }

function cssEscape(value) {
  if (globalThis.CSS?.escape) return CSS.escape(String(value));
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char.codePointAt(0).toString(16)} `);
}
function cssSelector(element) {
  if (!element || element.nodeType !== 1) return "";
  if (element.id) return `#${cssEscape(element.id)}`;
  const parts = [];
  let node = element;
  while (node && node.nodeType === 1 && parts.length < 5) {
    let part = node.tagName.toLowerCase();
    const classes = [...node.classList].slice(0, 2).map((c) => `.${cssEscape(c)}`).join(""); part += classes;
    const siblings = node.parentElement ? [...node.parentElement.children].filter((x) => x.tagName === node.tagName) : [];
    if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
    parts.unshift(part); node = node.parentElement;
  }
  return parts.join(" > ");
}
function refreshElements() {
  const tree = $("elementsTree"); if (!tree) return; tree.innerHTML = "";
  const tab = activeTab();
  if (!tab || tab.isHome || tab.isSettings) { tree.innerHTML = '<li style="padding:12px;color:var(--tx3)">Open a webpage to inspect elements.</li>'; return; }
  try {
    const root = tab.iframe.contentDocument?.documentElement; if (!root) throw new Error("Document unavailable");
    let count = 0;
    const build = (element, depth = 0) => {
      if (count++ > 1200 || depth > 10) return null;
      const li = document.createElement("li"); li.style.paddingLeft = `${depth * 10}px`; li.className = "elem-tree-row";
      const button = document.createElement("button"); button.type = "button"; button.className = "ctx-item"; button.style.width = "100%";
      const id = element.id ? `#${element.id}` : ""; const classes = [...element.classList].slice(0, 3).map((c) => `.${c}`).join("");
      button.textContent = `<${element.tagName.toLowerCase()}${id}${classes}>`;
      button.addEventListener("click", () => selectElement(element, tab.id));
      button.addEventListener("contextmenu", (event) => { event.preventDefault(); selectElement(element, tab.id); openElementContext(event); });
      li.append(button);
      for (const child of [...element.children]) { const childLi = build(child, depth + 1); if (childLi) li.append(childLi); }
      return li;
    };
    tree.append(build(root));
  } catch (error) { tree.innerHTML = `<li style="padding:12px;color:var(--err)">${escapeHtml(textError(error))}</li>`; }
  filterElements();
}
function selectElement(element, tabId) {
  selectedElement = element; selectedElementTabId = tabId;
  setText("elementsBreadcrumb", cssSelector(element));
  showElementDetail("styles");
  try {
    const rect = element.getBoundingClientRect(), frameRect = tabs.get(tabId).iframe.getBoundingClientRect(), overlayEl = $("elemHighlightOverlay");
    if (overlayEl) { overlayEl.style.display = "block"; overlayEl.style.left = `${frameRect.left + rect.left}px`; overlayEl.style.top = `${frameRect.top + rect.top}px`; overlayEl.style.width = `${rect.width}px`; overlayEl.style.height = `${rect.height}px`; setTimeout(() => { overlayEl.style.display = "none"; }, 1400); }
  } catch {}
}
function showElementDetail(tabName = "styles") {
  const detail = $("elementsDetail"), content = $("elemDetailContent"); if (!detail || !content || !selectedElement) return;
  detail.style.display = isSwitchOn("elemDetailToggle") ? "block" : "none";
  try {
    if (tabName === "attrs") content.innerHTML = [...selectedElement.attributes].map((a) => `<div><b>${escapeHtml(a.name)}</b>="${escapeHtml(a.value)}"</div>`).join("") || "No attributes";
    else if (tabName === "box") { const rect = selectedElement.getBoundingClientRect(); const style = selectedElement.ownerDocument.defaultView.getComputedStyle(selectedElement); content.innerHTML = `<div>size: ${Math.round(rect.width)} × ${Math.round(rect.height)}</div><div>margin: ${escapeHtml(style.margin)}</div><div>padding: ${escapeHtml(style.padding)}</div><div>border: ${escapeHtml(style.border)}</div>`; }
    else { const style = selectedElement.ownerDocument.defaultView.getComputedStyle(selectedElement); const props = ["display", "position", "color", "background", "font", "width", "height", "margin", "padding", "z-index", "overflow"]; content.innerHTML = props.map((prop) => `<div><b>${prop}</b>: ${escapeHtml(style.getPropertyValue(prop))}</div>`).join(""); }
  } catch (error) { content.textContent = textError(error); }
}
function openElementContext(event) { const menu = $("elemCtxMenu"); if (!menu) return; menu.style.display = "block"; menu.style.left = `${Math.min(event.clientX, innerWidth - 180)}px`; menu.style.top = `${Math.min(event.clientY, innerHeight - 230)}px`; }
function filterElements() {
  const query = ($("elementsSearch")?.value || "").toLowerCase();
  document.querySelectorAll("#elementsTree .elem-tree-row").forEach((row) => { row.style.display = !query || row.firstElementChild?.textContent.toLowerCase().includes(query) ? "" : "none"; });
}

function aiAddMessage(role, text) {
  $("aiWelcome")?.remove();
  const row = document.createElement("div"); row.className = `ai-message ${role}`; row.style.cssText = "padding:10px 12px;border:1px solid var(--bd);border-radius:8px;margin:8px;white-space:pre-wrap;line-height:1.45";
  row.textContent = text; $("aiMessages")?.append(row); $("aiMessages").scrollTop = $("aiMessages").scrollHeight;
}
function pageContext() {
  if (!isSwitchOn("aiContextToggle")) return "";
  try { const tab = activeTab(); return `\n\nCurrent page title: ${tab.title}\nURL: ${tab.url}\nVisible text:\n${(tab.iframe.contentDocument?.body?.innerText || "").slice(0, 6000)}`; } catch { return ""; }
}
async function transportBodyText(body) {
  if (typeof body === "string") return body;
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body);
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body);
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.text();
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) return new Response(body).text();
  return String(body ?? "");
}
async function sendAi() {
  const textarea = $("aiTextarea"); const prompt = textarea?.value.trim(); if (!prompt) return;
  textarea.value = ""; $("aiSendBtn").disabled = true; aiAddMessage("user", prompt);
  const loading = document.createElement("div"); loading.className = "ai-message assistant"; loading.textContent = "Thinking…"; loading.style.cssText = "padding:10px 12px;margin:8px;color:var(--tx3)"; $("aiMessages")?.append(loading);
  try {
    const fullPrompt = `You are the concise Asteroid Browser browser assistant. Answer the user's question safely and directly.${pageContext()}

User: ${prompt}`;
    const endpoint = config.aiEndpoint || "https://text.pollinations.ai/{prompt}";
    const aiUrl = new URL(endpoint.replace("{prompt}", encodeURIComponent(fullPrompt)));
    const response = await transport.request(aiUrl, "GET", null, [["accept", "text/plain"]], undefined);
    if (response.status < 200 || response.status >= 300) throw new Error(`AI provider returned HTTP ${response.status}`);
    const text = await transportBodyText(response.body); loading.remove(); aiAddMessage("assistant", text.trim() || "No response received.");
  } catch (error) { loading.remove(); aiAddMessage("assistant", `Assistant error: ${textError(error)}`); }
}

function openSettingsSection(section) {
  const normalized = section === "tutorial" ? "tutorial-page" : section;
  let activeNav = null;
  document.querySelectorAll(".settings-nav-item").forEach((item) => {
    const selected = item.dataset.section === section;
    item.classList.toggle("active", selected);
    item.setAttribute("aria-selected", selected ? "true" : "false");
    if (selected) activeNav = item;
  });
  document.querySelectorAll(".settings-section").forEach((item) => item.style.display = item.dataset.section === normalized ? "block" : "none");
  if (matchMedia("(max-width:760px)").matches) {
    try { activeNav?.scrollIntoView({ block: "nearest", inline: "center", behavior: "auto" }); } catch {}
    const settingsMain = document.querySelector("#settingsPage .settings-main");
    if (settingsMain) settingsMain.scrollTop = 0;
  }
  if (activeTab()?.isSettings) { activeTab().url = `asteroid://settings/${section}`; if (urlInput) urlInput.value = activeTab().url; }
  if (section === "cache") updateStorageEstimate();
  if (section === "compatibility") renderCompatibilityUI();
}
function renderSearchEngines() {
  const root = $("settingsEngineRows"); if (!root) return;
  root.innerHTML = "";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-engine-btn active";
  button.setAttribute("aria-disabled", "true");
  button.innerHTML = `<div class="engine-radio"><div class="engine-radio-dot"></div></div><div><div class="engine-name"></div><div class="engine-url"></div></div>`;
  button.querySelector(".engine-name").textContent = "Google";
  button.querySelector(".engine-url").textContent = GOOGLE_SEARCH_URL;
  root.append(button);
}
const locales = [
  ["", "System default"], ["en-US", "English (United States)"], ["en-GB", "English (United Kingdom)"], ["es-US", "Español (Estados Unidos)"], ["es-ES", "Español (España)"], ["fr-FR", "Français"], ["de-DE", "Deutsch"], ["it-IT", "Italiano"], ["pt-BR", "Português (Brasil)"], ["ja-JP", "日本語"], ["ko-KR", "한국어"], ["zh-CN", "中文（简体）"]
];
function renderLanguages(filter = "") {
  const root = $("settingsLanguageList"); if (!root) return; root.innerHTML = "";
  for (const [code, label] of locales.filter(([, label]) => label.toLowerCase().includes(filter.toLowerCase()))) {
    const button = document.createElement("button"); button.className = "settings-engine-btn"; button.style.width = "100%"; button.textContent = label;
    button.addEventListener("click", () => { $("settingsLanguage").value = code; $("settingsLanguageTrigger").querySelector(".locale-dropdown-label").textContent = label; $("settingsLanguagePanel").style.display = "none"; }); root.append(button);
  }
}
function applySettingsToUI() {
  if ($("settingsWispInput")) $("settingsWispInput").value = settings.wispUrl;
  if ($("settingsFallbackWispInput")) $("settingsFallbackWispInput").value = settings.fallbackWispUrl;
  setText("settingsIdleVal", settings.idleThreads); setText("settingsActiveVal", settings.activeThreads);
  setText("mainRetryVal", settings.mainRetries); setText("fallbackRetryVal", settings.fallbackRetries); setText("fallbackDelayVal", settings.retryDelay);
  for (const [id, key] of [
    ["webrtcBlockSwitch", "webrtcBlock"], ["mediaHeadersSwitch", "smartHeaders"], ["settingsAiContextSwitch", "aiContextDefault"],
    ["settingsSpellSwitch", "spellcheck"], ["settingsBlockSwitch", "adblock"], ["settingsTabCacheSwitch", "tabCache"],
    ["settingsPanelWidthSwitch", "rememberPanelWidths"], ["settingsPanelsLeftSwitch", "panelsLeft"], ["settingsAutoFullscreenSwitch", "autoFullscreen"],
    ["settingsShortcutsEnabledSwitch", "shortcutsEnabled"], ["settingsBookmarksBarSwitch", "bookmarksBar"], ["settingsClockSwitch", "showClock"],
    ["settings24hrSwitch", "clock24"], ["fallbackEnabledSwitch", "fallbackEnabled"], ["fallback5xxSwitch", "fallback5xx"],
    ["fallbackTimeoutSwitch", "fallbackTimeout"], ["fallbackDnsSwitch", "fallbackDns"], ["mediaRangeSwitch", "mediaRange"],
    ["mediaDownloadSwitch", "mediaDownloadUnknown"], ["mediaPdfSwitch", "mediaPdf"], ["mediaImgSwitch", "mediaImg"],
    ["mediaVideoSwitch", "mediaVideo"], ["mediaAudioSwitch", "mediaAudio"], ["mediaTextSwitch", "mediaText"]
  ]) setSwitch(id, settings[key]);
  setSwitch("aiContextToggle", settings.aiContextDefault);
  if ($("settingsAllowlistTextarea")) $("settingsAllowlistTextarea").value = settings.allowlist.join("\n");
  if ($("settingsRequestUA")) $("settingsRequestUA").value = settings.requestUA;
  if ($("settingsPageUA")) $("settingsPageUA").value = settings.pageUA;
  if ($("settingsCustomFilters")) $("settingsCustomFilters").value = settings.customFilters.join("\n");
  if ($("customSearchNameInput")) $("customSearchNameInput").value = settings.customSearchName;
  if ($("customSearchUrlInput")) $("customSearchUrlInput").value = settings.customSearchUrl;
  if ($("settingsFontSlider")) $("settingsFontSlider").value = String(Math.round((settings.fontScale - 0.75) / 0.05));
  document.documentElement.style.fontSize = `${settings.fontScale * 100}%`;
  document.body.classList.toggle("panels-left", settings.panelsLeft);
  document.documentElement.lang = settings.language || "en";
  const localeLabel = locales.find(([code]) => code === settings.language)?.[1] || "System default";
  const languageLabel = $("settingsLanguageTrigger")?.querySelector(".locale-dropdown-label"); if (languageLabel) languageLabel.textContent = localeLabel;
  if ($("settingsLanguage")) $("settingsLanguage").value = settings.language;
  renderSearchEngines(); renderBookmarks(); renderHome(); updateAdblockUI(); updateShortcutDisplays(); renderCompatibilityUI();
}
async function updateStorageEstimate() {
  try { const estimate = await navigator.storage.estimate(); setText("settingsCacheSize", `${formatBytes(estimate.usage || 0)} used`); }
  catch { setText("settingsCacheSize", "Storage estimate unavailable"); }
}
async function clearCaches(resetAll = false) {
  try { const names = await caches.keys(); await Promise.all(names.map((name) => caches.delete(name))); } catch {}
  if (resetAll) {
    const preserve = { wispUrl: settings.wispUrl, fallbackWispUrl: settings.fallbackWispUrl };
    try { controller?.cookieJar?.clear?.(); await controller?.cookieJar?.persist?.(); } catch {}
    await deleteWallpaperAsset();
    await closeAssetDb();
    try { localStorage.clear(); } catch {}
    for (const databaseName of ["__scramjet_controller", ASSET_DB]) {
      try {
        await new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(databaseName);
          request.onsuccess = request.onerror = request.onblocked = () => resolve();
        });
      } catch {}
    }
    settings = mergeSettings(preserve); saveSettings();
    location.reload(); return;
  }
  notify("Browser caches cleared", "ok"); updateStorageEstimate();
}
function adjustNumber(key, delta, min, max, id) { settings[key] = Math.max(min, Math.min(max, Number(settings[key]) + delta)); saveSettings(); setText(id, settings[key]); }

const shortcutLabels = {
  "New Tab": "newTab", "Close Tab": "closeTab", "Reload Page": "reload", "Bookmark Page": "bookmark", "Focus URL Bar": "focusUrl",
  "Settings": "settings", "Toggle Logs": "logs", "Element Inspector": "inspector", "Recent History": "history", "Metrics": "metrics",
  "Toggle Fullscreen": "fullscreen", "Find in Page": "find", "AI Assistant": "ai"
};
function prepareShortcutRows() {
  for (const row of $("shortcutsList")?.children || []) {
    const label = row.querySelector("span")?.textContent?.trim(); const action = shortcutLabels[label]; if (!action) continue;
    row.dataset.shortcutAction = action;
    const code = row.querySelector("code"); if (code) { code.classList.add("shortcut-display"); code.dataset.shortcut = action; }
    const buttons = row.querySelectorAll("button");
    buttons[0]?.addEventListener("click", () => openShortcutEditor(action));
    buttons[1]?.addEventListener("click", () => { settings.shortcuts[action] = defaults.shortcuts[action]; saveSettings(); updateShortcutDisplays(); });
  }
}
function updateShortcutDisplays() { document.querySelectorAll(".shortcut-display[data-shortcut]").forEach((code) => { code.textContent = `Alt + ${String(settings.shortcuts[code.dataset.shortcut] || "").toUpperCase()}`; }); }
function openShortcutEditor(action) { shortcutEditingAction = action; shortcutPendingKey = null; $("shortcutSave").disabled = true; $("shortcutDisplay").innerHTML = '<span style="opacity:.5;font-size:14px">Press Alt + a key</span>'; showModal("shortcutEditModal"); }
function executeShortcut(action) {
  const actions = {
    newTab: () => createTab(), closeTab: () => closeTab(activeTabId), reload: () => reloadTab(), bookmark: openBookmarkModal,
    focusUrl: () => { urlInput?.focus(); urlInput?.select(); }, settings: () => showSettings(), logs: () => $("logs")?.classList.toggle("hidden"),
    inspector: () => { $("elements")?.classList.toggle("hidden"); refreshElements(); }, history: toggleHistory,
    metrics: async () => { await renderMetrics(); showModal("metricsModal"); }, fullscreen: toggleFullscreen, find: openFind,
    ai: () => $("aiSidebar")?.classList.toggle("hidden")
  };
  actions[action]?.();
}
async function toggleFullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); } catch (error) { log(`Fullscreen unavailable: ${textError(error)}`, "warn"); } }

function bindPanelResize(handleId, panelId, storageKey) {
  const handle = $(handleId), panel = $(panelId); if (!handle || !panel) return;
  const saved = Number(safeGetItem(storageKey)); if (settings.rememberPanelWidths && saved > 180) panel.style.width = `${Math.min(saved, innerWidth * 0.75)}px`;
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault(); handle.setPointerCapture(event.pointerId);
    const startX = event.clientX, startWidth = panel.getBoundingClientRect().width;
    const move = (moveEvent) => { const direction = settings.panelsLeft ? 1 : -1; const width = Math.max(220, Math.min(innerWidth * 0.75, startWidth + (moveEvent.clientX - startX) * direction)); panel.style.width = `${width}px`; };
    const up = () => { handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up); if (settings.rememberPanelWidths) safeSetItem(storageKey, panel.getBoundingClientRect().width); };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up);
  });
}

function startTutorial() {
  tutorialState?.overlay?.remove();
  const steps = [
    ["#url", "Address bar", "Enter a URL or search term here."], ["#newTab", "Tabs", "Open multiple isolated Scramjet tabs."],
    ["#bookmarkBtn", "Bookmarks", "Save the current page."], ["#blockToggle", "Shield", "Manage tracker blocking and site exceptions."],
    ["#historyBtn", "History", "Open your locally stored recent history."], ["#metricsBtn", "Metrics", "View transport, request, and storage details."],
    ["#devToggle", "Logs", "Inspect proxy and fallback events."], ["#codeBtn", "Inspector", "Inspect elements in the active proxied page."],
    ["#settingsBtn", "Settings", "Configure Wisp servers, privacy, media, and appearance."]
  ];
  const overlayEl = document.createElement("div"); overlayEl.style.cssText = "position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.68)";
  const card = document.createElement("div"); card.id = "tutorialCard"; card.style.cssText = "position:fixed;z-index:100003;width:min(360px,calc(100vw - 24px));background:#090909;color:#fff;border:1px solid #555;padding:18px;border-radius:8px";
  overlayEl.append(card); document.body.append(overlayEl); tutorialState = { overlay: overlayEl, card, steps, index: 0, render: null };
  const render = () => {
    const [selector, title, description] = steps[tutorialState.index]; const target = document.querySelector(selector); const rect = target?.getBoundingClientRect();
    document.querySelectorAll(".asteroid-tutorial-target").forEach((el) => el.classList.remove("asteroid-tutorial-target")); target?.classList.add("asteroid-tutorial-target");
    card.innerHTML = `<div style="font-size:11px;color:#888">${tutorialState.index + 1} / ${steps.length}</div><h3 style="margin:6px 0 8px">${escapeHtml(title)}</h3><p style="color:#ccc;line-height:1.5">${escapeHtml(description)}</p><div style="display:flex;justify-content:space-between;gap:8px"><button id="tutorialSkip" style="background:none;border:0;color:#aaa">Skip</button><button id="tutorialNext" style="background:#fff;color:#000;border:0;padding:8px 14px">${tutorialState.index === steps.length - 1 ? "Finish" : "Next"}</button></div>`;
    const left = rect ? Math.min(innerWidth - card.offsetWidth - 12, Math.max(12, rect.left)) : (innerWidth - card.offsetWidth) / 2;
    const top = rect && rect.bottom + card.offsetHeight + 12 < innerHeight ? rect.bottom + 10 : Math.max(12, (rect?.top || innerHeight / 2) - card.offsetHeight - 10);
    card.style.left = `${left}px`; card.style.top = `${top}px`;
    card.querySelector("#tutorialSkip").onclick = endTutorial;
    card.querySelector("#tutorialNext").onclick = () => { if (++tutorialState.index >= steps.length) endTutorial(); else render(); };
  };
  tutorialState.render = render;
  render();
}
function endTutorial() { document.querySelectorAll(".asteroid-tutorial-target").forEach((el) => el.classList.remove("asteroid-tutorial-target")); tutorialState?.overlay?.remove(); tutorialState = null; }

function applyAutoFullscreen() {
  if (!settings.autoFullscreen || document.fullscreenElement) return;
  const once = async () => { document.removeEventListener("click", once, true); document.removeEventListener("keydown", once, true); await toggleFullscreen(); };
  document.addEventListener("click", once, true); document.addEventListener("keydown", once, true);
}

async function activeWorker(registration) {
  if (registration.active) return registration.active;
  return new Promise((resolve, reject) => {
    const worker = registration.installing || registration.waiting;
    if (!worker) return reject(new Error("No service worker is installing"));
    const timer = setTimeout(() => reject(new Error("Service worker activation timed out")), 20000);
    worker.addEventListener("statechange", () => { if (worker.state === "activated") { clearTimeout(timer); resolve(worker); } });
  });
}

async function ensureScramjetRuntime() {
  if (globalThis.$scramjet) return;
  setOverlay("Loading the Asteroid Browser compatibility runtime…");
  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "./scramjet/scramjet_bundled.js";
    script.async = true;
    script.onload = resolve;
    script.onerror = () => reject(new Error("The bundled Scramjet compatibility runtime could not be loaded."));
    document.head.append(script);
  });
}

function reloadForServiceWorkerControl() {
  const params = new URLSearchParams({ "asteroid-sw-ready": "1" });
  if (ASTEROID_LAUNCH.token) params.set("asteroid-access", ASTEROID_LAUNCH.token);
  if (ASTEROID_LAUNCH.parentOrigin) params.set("asteroid-parent-origin", ASTEROID_LAUNCH.parentOrigin);
  if (ASTEROID_LAUNCH.appMode) params.set("asteroid-app", "1");
  if (ASTEROID_LAUNCH.target) params.set("target", ASTEROID_LAUNCH.target);
  if (ASTEROID_LAUNCH.name) params.set("name", ASTEROID_LAUNCH.name);
  location.replace(`${location.pathname}${location.search}#${params}`);
}

async function initialize() {
  if (!asteroidAccessAllowed()) throw new Error("Open Asteroid Browser through Asteroid OS. A current Asteroid access pass is required.");
  if (!isSecureContext) throw new Error("Scramjet requires HTTPS or localhost. GitHub Pages works; file:// does not.");
  if (!("serviceWorker" in navigator)) throw new Error("This browser does not support service workers.");
  await ensureScramjetRuntime();
  if (!globalThis.$scramjet) throw new Error("Scramjet 2 runtime failed to load.");
  if (!globalThis.$scramjetController?.Controller) throw new Error("Scramjet controller failed to load.");
  setOverlay("Registering Scramjet 2 service worker…");
  const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./", updateViaCache: "none" });
  try { await registration.update(); } catch (error) { log(`Service worker update check failed: ${textError(error)}`, "warn"); }
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await activeWorker(registration);
    if (ASTEROID_LAUNCH.serviceWorkerReloaded) throw new Error("The Asteroid Browser service worker activated but could not take control of this page.");
    setOverlay("Activating the Asteroid Browser service worker…");
    reloadForServiceWorkerControl();
    return;
  }
  const worker = navigator.serviceWorker.controller;
  setOverlay(`Starting Libcurl ${LIBCURL_TRANSPORT_VERSION}…`); transport = new ResilientTransport(); await transport.init();
  setOverlay("Starting Scramjet 2…");
  controller = new $scramjetController.Controller({
    serviceworker: worker,
    transport,
    config: {
      prefix: `${basePath}~/sj/`, scramjetPath: `${basePath}scramjet/scramjet.js`, injectPath: `${basePath}controller/controller.inject.js`,
      wasmPath: `${basePath}scramjet/scramjet.wasm`, virtualWasmPath: "scramjet.wasm.js"
    }
  });
  await controller.wait();
  void loadIxlAnswerHelperAssets().catch((error) => log(`IXL Answer Helper preload failed: ${textError(error)}`, "warn"));
  const initialTarget = /^https?:\/\//i.test(pendingAsteroidTarget) ? pendingAsteroidTarget : null;
  pendingAsteroidTarget = "";
  createTab(initialTarget);
  hideOverlay(); setStatus("ready", "Ready");
  log(`Scramjet ${$scramjet.versionInfo?.version || "2"} ready via ${transportDisplayName(transport?.activeName || "primary")}`, "ok");
  applyAutoFullscreen();
}
function fatal(error) {
  if (document.querySelector(".asteroid-fatal")) return;
  console.error(error); hideOverlay();
  const root = document.createElement("div"); root.className = "asteroid-fatal";
  root.innerHTML = '<div class="asteroid-fatal-card"><h2>Asteroid Browser could not start</h2><p>Serve this folder through GitHub Pages or localhost. Opening index.html directly with file:// cannot run a service worker.</p><pre></pre><button id="asteroidRetry" style="margin-top:12px;padding:9px 14px">Retry</button></div>';
  root.querySelector("pre").textContent = textError(error); root.querySelector("#asteroidRetry").onclick = () => location.reload(); document.body.append(root);
}

function bindEvents() {
  $("go")?.addEventListener("click", () => navigate(activeTab(), urlInput.value));
  urlInput?.addEventListener("keydown", (event) => { if (event.key === "Enter") navigate(activeTab(), urlInput.value); });
  urlInput?.addEventListener("dragover", (event) => { event.preventDefault(); $("omniDropHint")?.classList.add("show"); });
  urlInput?.addEventListener("dragleave", () => $("omniDropHint")?.classList.remove("show"));
  urlInput?.addEventListener("drop", (event) => { event.preventDefault(); $("omniDropHint")?.classList.remove("show"); const value = event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain"); if (value) navigate(activeTab(), value); });
  $("ntSearchBtn")?.addEventListener("click", () => navigate(activeTab(), $("ntSearch").value));
  $("ntSearch")?.addEventListener("keydown", (event) => { if (event.key === "Enter") navigate(activeTab(), event.currentTarget.value); });
  addTabBtn?.addEventListener("click", () => createTab());
  $("back")?.addEventListener("click", goBack); $("fwd")?.addEventListener("click", goForward); $("reload")?.addEventListener("click", () => reloadTab()); $("stop")?.addEventListener("click", () => stopLoading()); $("home")?.addEventListener("click", () => showHome());
  $("settingsBtn")?.addEventListener("click", () => showSettings()); $("fullscreenBtn")?.addEventListener("click", toggleFullscreen);
  $("devToggle")?.addEventListener("click", () => $("logs")?.classList.toggle("hidden"));
  $("codeBtn")?.addEventListener("click", () => { $("elements")?.classList.toggle("hidden"); refreshElements(); });
  $("aiBtn")?.addEventListener("click", () => $("aiSidebar")?.classList.toggle("hidden"));
  $("clear")?.addEventListener("click", () => { if ($("logbox")) $("logbox").innerHTML = ""; setText("logCountBadge", 0); filterLogs(); });
  $("copyLogs")?.addEventListener("click", async () => notify(await copyText($("logbox")?.innerText || "") ? "Logs copied" : "Copy failed", "ok"));
  $("logSearch")?.addEventListener("input", filterLogs);
  document.querySelectorAll("#logFilterBar .log-filter-btn").forEach((button) => button.addEventListener("click", () => { currentLogFilter = button.dataset.filter; document.querySelectorAll("#logFilterBar .log-filter-btn").forEach((x) => x.classList.toggle("active", x === button)); filterLogs(); }));
  $("logAutoScrollBtn")?.addEventListener("click", () => { autoScrollLogs = !autoScrollLogs; $("logAutoScrollBtn").classList.toggle("pinned", autoScrollLogs); });

  $("findOmniBtn")?.addEventListener("click", openFind); $("findClose")?.addEventListener("click", closeFind); $("findNext")?.addEventListener("click", () => runFind(false)); $("findPrev")?.addEventListener("click", () => runFind(true)); $("findInput")?.addEventListener("input", () => { findIndex = 0; runFind(false); }); $("findInput")?.addEventListener("keydown", (event) => { if (event.key === "Enter") runFind(event.shiftKey); if (event.key === "Escape") closeFind(); });
  $("bookmarkBtn")?.addEventListener("click", openBookmarkModal); $("bookmarkCancel")?.addEventListener("click", () => hideModal("bookmarkModal")); $("bookmarkSave")?.addEventListener("click", () => { if (saveBookmark($("bookmarkUrlInput").value, $("bookmarkNameInput").value)) hideModal("bookmarkModal"); });
  $("addFavoriteCancel")?.addEventListener("click", () => hideModal("addFavoriteModal")); $("addFavoriteSave")?.addEventListener("click", () => { if (saveBookmark($("favoriteUrlInput").value, $("favoriteNameInput").value)) hideModal("addFavoriteModal"); });
  $("bookmarksToggle")?.addEventListener("click", () => { settings.bookmarksBar = false; saveSettings(); applyBookmarksBar(); setSwitch("settingsBookmarksBarSwitch", false); }); $("showBookmarksBtn")?.addEventListener("click", () => { settings.bookmarksBar = true; saveSettings(); applyBookmarksBar(); setSwitch("settingsBookmarksBarSwitch", true); });

  $("historyBtn")?.addEventListener("click", toggleHistory); $("historyClose")?.addEventListener("click", () => hideModal("historyPopup")); $("historyClear")?.addEventListener("click", () => { historyItems = []; saveHistory(); renderHistory(); });
  $("metricsBtn")?.addEventListener("click", async () => { await renderMetrics(); showModal("metricsModal"); }); $("metricsRefresh")?.addEventListener("click", renderMetrics); $("metricsClose")?.addEventListener("click", () => hideModal("metricsModal"));
  $("securityChip")?.addEventListener("click", openSiteInfo); $("siteInfoClose")?.addEventListener("click", () => hideModal("siteInfoPopup")); $("siteInfoCopy")?.addEventListener("click", async () => notify(await copyText(activeTab()?.url || HOME) ? "URL copied" : "Copy failed", "ok"));

  $("blockToggle")?.addEventListener("click", () => { updateAdblockUI(); showModal("adblockModal"); }); $("adblockCloseBtn")?.addEventListener("click", () => hideModal("adblockModal")); $("adblockLargeToggle")?.addEventListener("click", toggleAdblock); $("adblockPauseSiteBtn")?.addEventListener("click", togglePauseCurrentSite); $("adblockManageBtn")?.addEventListener("click", () => { hideModal("adblockModal"); showSettings(activeTab(), "privacy"); });

  $("ntWallpaperBtn")?.addEventListener("click", () => showModal("wallpaperModal")); $("settingsWallpaperChange")?.addEventListener("click", () => showModal("wallpaperModal")); $("wallpaperCancel")?.addEventListener("click", () => hideModal("wallpaperModal")); $("wallpaperApply")?.addEventListener("click", () => setWallpaper($("wallpaperUrlInput").value.trim())); $("wallpaperDefault")?.addEventListener("click", () => setWallpaper("")); $("settingsWallpaperReset")?.addEventListener("click", () => setWallpaper(""));
  $("wallpaperRandom")?.addEventListener("click", createRandomWallpaper);
  $("wallpaperFileInput")?.addEventListener("change", async (event) => { const file = event.target.files?.[0]; event.target.value = ""; await setWallpaperFile(file); });

  $("tabScrollLeft")?.addEventListener("click", () => tabStrip.scrollBy({ left: -260, behavior: "smooth" })); $("tabScrollRight")?.addEventListener("click", () => tabStrip.scrollBy({ left: 260, behavior: "smooth" }));

  document.querySelectorAll(".settings-nav-item").forEach((nav) => nav.addEventListener("click", () => openSettingsSection(nav.dataset.section)));
  $("settingsWispSave")?.addEventListener("click", () => { const value = $("settingsWispInput")?.value.trim(); if (!/^wss?:\/\//i.test(value)) { setText("settingsWispStatus", "Enter a ws:// or wss:// URL"); return; } if (location.protocol === "https:" && value.startsWith("ws://")) { setText("settingsWispStatus", "HTTPS pages require a secure wss:// endpoint"); return; } settings.wispUrl = value; if (!saveSettings()) { setText("settingsWispStatus", "Could not save in this browser"); return; } setText("settingsWispStatus", "Saved. Reloading…"); location.reload(); });
  $("settingsWispReset")?.addEventListener("click", () => { settings.wispUrl = defaults.wispUrl; saveSettings(); location.reload(); });
  $("settingsFallbackWispSave")?.addEventListener("click", () => { const value = $("settingsFallbackWispInput")?.value.trim(); if (value && !/^wss?:\/\//i.test(value)) { setText("settingsFallbackWispStatus", "Enter a ws:// or wss:// URL"); return; } if (location.protocol === "https:" && value.startsWith("ws://")) { setText("settingsFallbackWispStatus", "HTTPS pages require a secure wss:// endpoint"); return; } settings.fallbackWispUrl = value; if (!saveSettings()) { setText("settingsFallbackWispStatus", "Could not save in this browser"); return; } setText("settingsFallbackWispStatus", "Saved. Reload to apply."); });
  $("settingsFallbackWispReset")?.addEventListener("click", () => { settings.fallbackWispUrl = defaults.fallbackWispUrl; saveSettings(); applySettingsToUI(); setText("settingsFallbackWispStatus", "Reset to default; reload to apply."); });
  $("settingsIdleMinus")?.addEventListener("click", () => adjustNumber("idleThreads", -1, 1, 12, "settingsIdleVal")); $("settingsIdlePlus")?.addEventListener("click", () => adjustNumber("idleThreads", 1, 1, 12, "settingsIdleVal")); $("settingsActiveMinus")?.addEventListener("click", () => adjustNumber("activeThreads", -1, 1, 24, "settingsActiveVal")); $("settingsActivePlus")?.addEventListener("click", () => adjustNumber("activeThreads", 1, 1, 24, "settingsActiveVal"));
  $("settingsThreadsSave")?.addEventListener("click", () => { saveSettings(); setText("settingsThreadsStatus", "Concurrency settings saved"); }); $("settingsThreadsReset")?.addEventListener("click", () => { settings.idleThreads = defaults.idleThreads; settings.activeThreads = defaults.activeThreads; saveSettings(); applySettingsToUI(); setText("settingsThreadsStatus", "Reset to defaults"); });
  $("mainRetryMinus")?.addEventListener("click", () => adjustNumber("mainRetries", -1, 0, 8, "mainRetryVal")); $("mainRetryPlus")?.addEventListener("click", () => adjustNumber("mainRetries", 1, 0, 8, "mainRetryVal")); $("fallbackRetryMinus")?.addEventListener("click", () => adjustNumber("fallbackRetries", -1, 0, 8, "fallbackRetryVal")); $("fallbackRetryPlus")?.addEventListener("click", () => adjustNumber("fallbackRetries", 1, 0, 8, "fallbackRetryVal")); $("fallbackDelayMinus")?.addEventListener("click", () => adjustNumber("retryDelay", -1, 0, 10, "fallbackDelayVal")); $("fallbackDelayPlus")?.addEventListener("click", () => adjustNumber("retryDelay", 1, 0, 10, "fallbackDelayVal"));

  bindSwitch("compatibilityLearningSwitch", "compatibilityLearning", (on) => { if (!on) { for (const tab of tabs.values()) { clearCompatibilityTimers(tab); tab.compatibilityTrial = null; } } renderCompatibilityUI(); });
    bindSwitch("webrtcBlockSwitch", "webrtcBlock", () => notify("Reload open pages to apply WebRTC changes", "warn")); bindSwitch("mediaHeadersSwitch", "smartHeaders"); bindSwitch("settingsAiContextSwitch", "aiContextDefault", (on) => setSwitch("aiContextToggle", on)); bindSwitch("settingsSpellSwitch", "spellcheck", () => tabs.forEach(applyPageEnhancements)); bindSwitch("settingsBlockSwitch", "adblock", () => { updateAdblockUI(); tabs.forEach(applyPageEnhancements); }); bindSwitch("settingsTabCacheSwitch", "tabCache"); bindSwitch("settingsPanelWidthSwitch", "rememberPanelWidths"); bindSwitch("settingsPanelsLeftSwitch", "panelsLeft", () => document.body.classList.toggle("panels-left", settings.panelsLeft)); bindSwitch("settingsAutoFullscreenSwitch", "autoFullscreen", applyAutoFullscreen); bindSwitch("settingsShortcutsEnabledSwitch", "shortcutsEnabled"); bindSwitch("settingsBookmarksBarSwitch", "bookmarksBar", applyBookmarksBar); bindSwitch("settingsClockSwitch", "showClock", updateClock); bindSwitch("settings24hrSwitch", "clock24", updateClock); bindSwitch("fallbackEnabledSwitch", "fallbackEnabled", async (on) => {
    if (on && transport && !transport.fallback) {
      try {
        transport.fallback = new EpoxyTransport({ wisp: settings.fallbackWispUrl || settings.wispUrl });
        await promiseWithTimeout(transport.fallback.init(), Math.max(30000, settings.timeoutSeconds * 1000), "Epoxy initialization timed out");
        notify("Epoxy backup initialized", "ok");
      }
      catch (error) { transport.fallback = null; settings.fallbackEnabled = false; saveSettings(); setSwitch("fallbackEnabledSwitch", false); notify(`Epoxy backup failed: ${textError(error)}`, "err"); }
    }
  }); bindSwitch("fallback5xxSwitch", "fallback5xx"); bindSwitch("fallbackTimeoutSwitch", "fallbackTimeout"); bindSwitch("fallbackDnsSwitch", "fallbackDns"); bindSwitch("mediaRangeSwitch", "mediaRange"); bindSwitch("mediaDownloadSwitch", "mediaDownloadUnknown"); bindSwitch("mediaPdfSwitch", "mediaPdf"); bindSwitch("mediaImgSwitch", "mediaImg"); bindSwitch("mediaVideoSwitch", "mediaVideo"); bindSwitch("mediaAudioSwitch", "mediaAudio"); bindSwitch("mediaTextSwitch", "mediaText");

  $("settingsSaveAllowlist")?.addEventListener("click", () => { settings.allowlist = $("settingsAllowlistTextarea").value.split(/\r?\n/).map((x) => x.trim().toLowerCase()).filter(Boolean); saveSettings(); setText("settingsAllowlistStatus", "Allowlist saved"); updateAdblockUI(); });
  $("settingsSaveUA")?.addEventListener("click", () => { settings.requestUA = $("settingsRequestUA").value.trim(); settings.pageUA = $("settingsPageUA").value.trim(); saveSettings(); setText("settingsUAStatus", "Saved. Reload open pages to apply page UA."); }); $("settingsResetUA")?.addEventListener("click", () => { settings.requestUA = ""; settings.pageUA = ""; saveSettings(); applySettingsToUI(); setText("settingsUAStatus", "Reset to browser defaults"); });
  $("settingsSaveFilters")?.addEventListener("click", () => { settings.customFilters = $("settingsCustomFilters").value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean); saveSettings(); tabs.forEach(applyPageEnhancements); notify("Custom filters saved", "ok"); });
  $("customSearchNameSaveBtn")?.addEventListener("click", () => { settings.customSearchName = $("customSearchNameInput").value.trim() || "Custom"; saveSettings(); renderSearchEngines(); }); $("customSearchNameResetBtn")?.addEventListener("click", () => { settings.customSearchName = defaults.customSearchName; saveSettings(); applySettingsToUI(); });
  $("customSearchSaveBtn")?.addEventListener("click", () => { const value = $("customSearchUrlInput").value.trim(); if (!/^https?:\/\//i.test(value) || !value.includes("{q}")) { notify("Custom search URL must be HTTP(S) and include {q}", "err"); return; } settings.customSearchUrl = value; if (settings.searchEngineName === settings.customSearchName) settings.searchEngine = value; saveSettings(); renderSearchEngines(); }); $("customSearchResetBtn")?.addEventListener("click", () => { settings.customSearchUrl = defaults.customSearchUrl; saveSettings(); applySettingsToUI(); });
  $("settingsClearCache")?.addEventListener("click", () => clearCaches(false)); $("settingsResetEverything")?.addEventListener("click", () => { if (confirm("Reset all Asteroid Browser settings, bookmarks, history, cookies, and caches?")) clearCaches(true); });
  $("settingsFontSlider")?.addEventListener("input", (event) => { settings.fontScale = 0.75 + Number(event.target.value) * 0.05; saveSettings(); document.documentElement.style.fontSize = `${settings.fontScale * 100}%`; }); $("settingsFontReset")?.addEventListener("click", () => { settings.fontScale = 1; saveSettings(); applySettingsToUI(); });
  $("settingsLanguageTrigger")?.addEventListener("click", () => { const panel = $("settingsLanguagePanel"); panel.style.display = panel.style.display === "none" ? "block" : "none"; renderLanguages($("settingsLanguageFilter")?.value || ""); }); $("settingsLanguageFilter")?.addEventListener("input", (event) => renderLanguages(event.target.value)); $("settingsLanguageSave")?.addEventListener("click", () => { settings.language = $("settingsLanguage").value; saveSettings(); applySettingsToUI(); setText("settingsLanguageStatus", "Language preference saved; interface labels remain English."); tabs.forEach(applyPageEnhancements); });
  $("compatRetestCurrent")?.addEventListener("click", () => clearCompatibilityForCurrentSite(true));
  $("compatClearCurrent")?.addEventListener("click", () => clearCompatibilityForCurrentSite(false));
  $("compatClearAll")?.addEventListener("click", () => { if (confirm("Clear all learned compatibility results?")) clearAllCompatibilityResults(); });
  $("restartTutorialBtn")?.addEventListener("click", startTutorial);

  $("refreshElements")?.addEventListener("click", refreshElements); $("elementsSearch")?.addEventListener("input", filterElements); setSwitch("elemDetailToggle", true); $("elemDetailToggle")?.addEventListener("click", () => { setSwitch("elemDetailToggle", !isSwitchOn("elemDetailToggle")); showElementDetail(); }); document.querySelectorAll(".elem-tab").forEach((button) => button.addEventListener("click", () => { document.querySelectorAll(".elem-tab").forEach((x) => x.classList.toggle("active", x === button)); showElementDetail(button.dataset.tab); }));
  $("ctxCopySelector")?.addEventListener("click", () => selectedElement && copyText(cssSelector(selectedElement))); $("ctxCopyHtml")?.addEventListener("click", () => selectedElement && copyText(selectedElement.outerHTML)); $("ctxCopyText")?.addEventListener("click", () => selectedElement && copyText(selectedElement.textContent || "")); $("ctxScrollTo")?.addEventListener("click", () => selectedElement?.scrollIntoView({ behavior: "smooth", block: "center" })); $("ctxHideElement")?.addEventListener("click", () => { if (selectedElement) selectedElement.style.setProperty("display", "none", "important"); });

  setSwitch("aiContextToggle", settings.aiContextDefault); $("aiContextToggle")?.addEventListener("click", () => { if (isSwitchOn("aiContextToggle")) setSwitch("aiContextToggle", false); else $("aiPermissionBar")?.classList.add("show"); }); $("permAllow")?.addEventListener("click", () => { setSwitch("aiContextToggle", true); $("aiPermissionBar")?.classList.remove("show"); }); $("permDeny")?.addEventListener("click", () => { setSwitch("aiContextToggle", false); $("aiPermissionBar")?.classList.remove("show"); }); $("aiTextarea")?.addEventListener("input", (event) => { $("aiSendBtn").disabled = !event.target.value.trim(); }); $("aiTextarea")?.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendAi(); } }); $("aiSendBtn")?.addEventListener("click", sendAi);

  $("ctxNewTab")?.addEventListener("click", () => createTab()); $("ctxSettings")?.addEventListener("click", () => showSettings()); $("ctxBookmark")?.addEventListener("click", openBookmarkModal); $("ctxCopyUrl")?.addEventListener("click", () => copyText(activeTab()?.url || HOME)); $("ctxReload")?.addEventListener("click", () => reloadTab()); $("ctxBack")?.addEventListener("click", goBack); $("ctxForward")?.addEventListener("click", goForward); $("ctxCloseTab")?.addEventListener("click", () => closeTab(activeTabId));
  $("tabCtxMute")?.addEventListener("click", () => { const tab = tabs.get(contextTabId); if (tab) { tab.muted = !tab.muted; applyMuted(tab); renderTabs(); } }); $("tabCtxReload")?.addEventListener("click", () => reloadTab(tabs.get(contextTabId))); $("tabCtxClose")?.addEventListener("click", () => closeTab(contextTabId));
  $("shortcutCancel")?.addEventListener("click", () => hideModal("shortcutEditModal")); $("shortcutSave")?.addEventListener("click", () => { if (shortcutEditingAction && shortcutPendingKey) { settings.shortcuts[shortcutEditingAction] = shortcutPendingKey; saveSettings(); updateShortcutDisplays(); hideModal("shortcutEditModal"); } });

  document.addEventListener("contextmenu", openContextMenu);
  document.addEventListener("click", (event) => { if (!event.target.closest("#contextMenu,#tabContextMenu,#ntEngine,#settingsLanguagePanel,#settingsLanguageTrigger")) closeMenus(); if (!event.target.closest("#elemCtxMenu")) $("elemCtxMenu") && ($("elemCtxMenu").style.display = "none"); });
  document.addEventListener("keydown", (event) => {
    if ($("shortcutEditModal")?.style.display !== "none" && shortcutEditingAction && event.altKey && event.key.length === 1) { event.preventDefault(); shortcutPendingKey = event.key.toLowerCase(); $("shortcutDisplay").textContent = `Alt + ${event.key.toUpperCase()}`; $("shortcutSave").disabled = false; return; }
    if (event.key === "Escape") { closeMenus(); closeFind(); ["bookmarkModal", "addFavoriteModal", "wallpaperModal", "metricsModal", "siteInfoPopup", "historyPopup", "adblockModal", "shortcutEditModal"].forEach(hideModal); }
    if (event.ctrlKey && event.key.toLowerCase() === "l") { event.preventDefault(); urlInput?.focus(); urlInput?.select(); }
    if (event.ctrlKey && event.key.toLowerCase() === "t") { event.preventDefault(); createTab(); }
    if (event.ctrlKey && event.key.toLowerCase() === "w") { event.preventDefault(); closeTab(activeTabId); }
    if (event.ctrlKey && event.key.toLowerCase() === "d") { event.preventDefault(); openBookmarkModal(); }
    if (event.ctrlKey && event.key.toLowerCase() === "r") { event.preventDefault(); reloadTab(); }
    if (event.key === "F11") { event.preventDefault(); toggleFullscreen(); }
    if (settings.shortcutsEnabled && event.altKey && !event.ctrlKey && !event.metaKey) {
      const key = event.key.toLowerCase(); const action = Object.entries(settings.shortcuts).find(([, mapped]) => mapped === key)?.[0];
      if (action) { event.preventDefault(); executeShortcut(action); }
    }
  });
  window.addEventListener("pagehide", () => { saveSettings(); saveBookmarks(); saveHistory(); if (metricsSaveTimer) clearTimeout(metricsSaveTimer); flushMetrics(); revokeWallpaperObjectUrl(); });
  window.addEventListener("resize", () => tutorialState?.render?.());
}

function injectRuntimeCss() {
  const style = document.createElement("style"); style.id = "asteroid-runtime-css";
  style.textContent = `
    body.panels-left .logs,body.panels-left .elements,body.panels-left .ai-sidebar{left:0!important;right:auto!important;border-left:0!important;border-right:1px solid var(--bd)!important}
    .asteroid-tutorial-target{position:relative!important;z-index:100004!important;outline:3px solid #fff!important;outline-offset:3px!important}
    #contextMenu,#tabContextMenu,#siteInfoPopup,#historyPopup{position:fixed;z-index:100000}
    .ai-message.user{background:#fff;color:#000;margin-left:28px}.ai-message.assistant{background:#111;color:#fff;margin-right:28px}
    #ntBg{position:absolute!important;inset:0!important;z-index:0!important}.nt-content{position:relative!important;z-index:2!important}
    .asteroid-hidden{display:none!important}
    .asteroid-fatal{position:fixed;inset:0;z-index:200000;display:grid;place-items:center;background:#050505;color:#fff;padding:18px}
    .asteroid-fatal-card{width:min(620px,100%);border:1px solid #444;border-radius:10px;background:#111;padding:24px;box-shadow:0 24px 80px rgba(0,0,0,.65)}
    .asteroid-fatal-card p{margin:10px 0;color:#bbb;line-height:1.5}.asteroid-fatal-card pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#ffabab;background:#090909;padding:12px;border-radius:6px}
    .compat-status-box{border:1px solid var(--bd);border-radius:8px;padding:12px;background:rgba(255,255,255,.025);overflow-wrap:anywhere}.compat-site-list{white-space:pre-wrap;font-family:var(--mono);font-size:11px;line-height:1.55;max-height:320px;overflow:auto;border:1px solid var(--bd);border-radius:8px;padding:12px;background:#090909}
    html[data-asteroid-app-mode="1"] .titlebar,html[data-asteroid-app-mode="1"] .navbar,html[data-asteroid-app-mode="1"] .bookmarks-bar-wrap{display:none!important}
  `;
  document.head.append(style);
}

injectRuntimeCss();
prepareShortcutRows();
bindPanelResize("logsResizeHandle", "logs", "asteroid:panel:logs"); bindPanelResize("elementsResizeHandle", "elements", "asteroid:panel:elements"); bindPanelResize("aiResizeHandle", "aiSidebar", "asteroid:panel:ai");
bindEvents();
applySettingsToUI();
restoreWallpaperAsset().catch((error) => log(`Wallpaper restore failed: ${textError(error)}`, "warn"));
renderLanguages();
setInterval(updateClock, 30_000);
requestAsteroidAccess().then((allowed) => {
  if (!allowed) throw new Error("Open Asteroid Browser through Asteroid OS. A current Asteroid access pass is required.");
  return initialize();
}).catch(fatal);
if (!ASTEROID_LOCAL_STANDALONE) {
  setInterval(() => {
    if (!asteroidAccessAllowed()) fatal(new Error("This Asteroid Browser access pass has expired. Reopen it from Asteroid OS."));
  }, 1000);
}
