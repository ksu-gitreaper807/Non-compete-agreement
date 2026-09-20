/**
 * Background entry point (Firefox MV3 event page). Wires storage, model, classifiers,
 * friction manager, session tracker, tab monitor and the message router together.
 *
 * Everything that must survive an event-page restart is persisted through storage.js.
 */
import * as storage from '../storage/storage.js';
import { DEFAULT_LIMITS, FRICTION_STATE } from '../storage/schema.js';
import { RegexClassifier } from '../classifier/regexClassifier.js';
import { EmbeddingClassifier } from '../classifier/embeddingClassifier.js';
import { LlmClassifier } from '../llm/llmClassifier.js';
import { LlmManager, createExtensionLlmLoader } from '../llm/llmManager.js';
import { OllamaAdapter, LlamaCppAdapter, runtimeModelVersion } from '../llm/localLLM.js';
import { DuckDuckGoSearchProvider, DDG_ORIGIN_PATTERN } from '../search/duckduckgoProvider.js';
import { SearchManager } from '../search/searchManager.js';
import { DecisionPipeline } from '../intelligence/decisionPipeline.js';
import { generateAnchors } from '../classifier/anchors.js';
import { ModelManager, createExtensionLoader, MODEL_VERSION } from '../model/modelManager.js';
import { PersistentCache, float32Codec } from '../storage/cacheStore.js';
import { FrictionManager } from '../blocking/frictionManager.js';
import { SessionTracker } from './sessionTracker.js';
import { Controller } from './controller.js';
import { TabMonitor } from './tabMonitor.js';
import { createMessageRouter } from './messageRouter.js';
import { LedgerManager } from '../ledger/ledgerManager.js';
import { buildBlockedPageUrl, isBlockedPageUrl, BLOCKED_PAGE_PATH } from '../blocking/blocker.js';
import { validatePattern } from '../utils/regex.js';
import { extractDomain } from '../utils/text.js';

const browserApi = globalThis.browser ?? globalThis.chrome;
const BLOCKED_BASE_URL = browserApi.runtime.getURL(BLOCKED_PAGE_PATH);
const ALARM_TICK = 'goalguard-tick';
const ALARM_EXPIRE_PREFIX = 'goalguard-expire:';
const NEUTRAL_URL = 'about:newtab';
const DEBUG_CACHE = false; // flip to see [CACHE] HIT/MISS/expired/evicted lines in the background console

let bootPromise = null;
let app = null;

async function boot() {
  await storage.initStorage();

  const sessions = new SessionTracker({
    loadStats: storage.getStatistics,
    saveStats: storage.saveStatistics,
    loadSessions: storage.getSessions,
    saveSessions: storage.saveSessions,
    loadCurrent: () => storage.getValue('currentSession', null),
    saveCurrent: (cur) => storage.setValue('currentSession', cur),
    limits: DEFAULT_LIMITS,
  });

  const ledger = new LedgerManager({ load: storage.getLedger, save: storage.saveLedger });

  const friction = new FrictionManager({
    load: storage.getFrictionState,
    save: storage.saveFrictionState,
    onEvent: (event, payload) => sessions.recordEvent(event, payload).catch(() => {}),
    // One alarm per grant, fired exactly at expiresAt; the minute tick is only a safety net.
    scheduler: {
      schedule: (key, when) => browserApi.alarms.create(ALARM_EXPIRE_PREFIX + key, { when }),
      cancel: (key) => browserApi.alarms.clear(ALARM_EXPIRE_PREFIX + key).catch(() => {}),
    },
  });

  const cacheLog = DEBUG_CACHE || globalThis.GOALGUARD_DEBUG_CACHE ? (line) => console.debug(line) : null;
  const caches = {
    classification: new PersistentCache('classification', { log: cacheLog }),
    embedding: new PersistentCache('embedding', { log: cacheLog, ...float32Codec }),
    retrieval: new PersistentCache('retrieval', { log: cacheLog }),
    llm: new PersistentCache('llm', { log: cacheLog }),
  };
  await storage.setValue('embeddingCache', undefined).catch(() => {}); // drop pre-cache-layer blob

  const modelManager = new ModelManager({
    // Tests may inject a Node-compatible loader; the extension always uses the bundled files.
    loader: globalThis.GOALGUARD_MODEL_LOADER ?? createExtensionLoader(browserApi.runtime),
    cache: caches.embedding,
    modelVersion: MODEL_VERSION,
  });

  // The LLM runtime is chosen from settings at load time (in-browser Transformers.js by
  // default; Ollama / llama.cpp servers on localhost as alternatives). Tests may inject a loader.
  const llmManager = new LlmManager({
    loader: globalThis.GOALGUARD_LLM_LOADER ?? createRuntimeLoader(),
    modelVersion: runtimeModelVersion(await storage.getSettings()),
  });
  const searchManager = new SearchManager({
    provider: new DuckDuckGoSearchProvider({
      fetchImpl: globalThis.GOALGUARD_FETCH ?? globalThis.fetch?.bind(globalThis),
      hasPermission: () => hasOriginPermission(DDG_ORIGIN_PATTERN),
    }),
    cache: caches.retrieval,
    embed: (text) => modelManager.embed(text), // reranks snippets against the title
  });
  const llmClassifier = new LlmClassifier({ llm: llmManager, cache: caches.llm });

  const pipeline = new DecisionPipeline({
    regex: new RegexClassifier(),
    embedding: new EmbeddingClassifier({
      embed: (text) => modelManager.embed(text),
      isAvailable: () => modelManager.isAvailable(),
    }),
    search: searchManager,
    llm: llmClassifier,
  });

  const controller = new Controller({
    pipeline,
    friction,
    saveFeedback: async (entry) => {
      const list = await storage.getValue('feedback', []);
      list.push(entry);
      await storage.setValue('feedback', list.slice(-DEFAULT_LIMITS.maxFeedbackEntries));
    },
    sessions,
    classificationCache: caches.classification,
    modelVersion: () => MODEL_VERSION,
    loadConfig: async () => {
      const [settings, rules, anchors] = await Promise.all([storage.getSettings(), storage.getRules(), storage.getAnchors()]);
      return { settings, rules, anchors: await ensureAnchors(settings, anchors) };
    },
    navigate: async (tabId, url) => {
      try {
        await browserApi.tabs.update(tabId, { url, loadReplace: true });
      } catch (e) {
        console.warn('[GoalGuard] navigation failed', e);
      }
    },
    blockedPageUrl: (params) => buildBlockedPageUrl(BLOCKED_BASE_URL, params),
    isBlockedPage: (url) => isBlockedPageUrl(url, BLOCKED_BASE_URL),
    getTab: (tabId) => browserApi.tabs.get(tabId).catch(() => null),
    queryTabs: () => browserApi.tabs.query({}).catch(() => []),
    closeTab: (tabId) => browserApi.tabs.remove(tabId).catch(() => {}),
    pauseMedia: (tabId) => pauseMediaInTab(tabId),
    neutralUrl: NEUTRAL_URL,
  });

  const tabMonitor = new TabMonitor({ browser: browserApi, controller });
  tabMonitor.start();

  storage.onStorageChanged((changes) => {
    if (changes.settings || changes.rules || changes.anchors) {
      controller.invalidateConfig();
      const next = changes.settings?.newValue;
      const prev = changes.settings?.oldValue;
      if (next && prev && (next.llmRuntime !== prev.llmRuntime || next.llmEndpoint !== prev.llmEndpoint || next.llmModelName !== prev.llmModelName)) {
        // Next judgment loads the newly selected runtime under its own cache identity.
        llmManager.configure({ modelVersion: runtimeModelVersion(next) }).then(() => llmManager.unload()).catch(() => {});
      }
      tabMonitor.refreshActive().catch(() => {});
    }
  });

  browserApi.alarms.create(ALARM_TICK, { periodInMinutes: 1 });

  app = { sessions, friction, ledger, modelManager, llmManager, searchManager, llmClassifier, pipeline, controller, tabMonitor, caches };
  return app;
}

/** Picks the LocalLLM adapter from settings when the model is first needed. */
function createRuntimeLoader() {
  const nli = createExtensionLlmLoader(browserApi.runtime);
  const generative = createExtensionLlmLoader(browserApi.runtime, { generative: true });
  return async (onProgress) => {
    const settings = await storage.getSettings();
    if (settings.llmRuntime === 'ollama') return new OllamaAdapter({ endpoint: settings.llmEndpoint || undefined, model: settings.llmModelName || undefined });
    if (settings.llmRuntime === 'llamacpp') return new LlamaCppAdapter({ endpoint: settings.llmEndpoint || undefined, model: settings.llmModelName || undefined });
    if (settings.llmRuntime === 'transformers') return generative(onProgress);
    return nli(onProgress);
  };
}

function ensureBooted() {
  if (!bootPromise) bootPromise = boot().catch((e) => {
    bootPromise = null;
    throw e;
  });
  return bootPromise;
}

async function hasOriginPermission(origin) {
  try {
    return await browserApi.permissions.contains({ origins: [origin] });
  } catch {
    return false;
  }
}

/** Regenerates anchors when the goal changed and the user has not customised them. */
async function ensureAnchors(settings, anchors) {
  const goal = settings.weeklyGoal?.trim() ?? '';
  if (!goal) return anchors;
  if (anchors.generatedFromGoal === goal && anchors.positive.length) return anchors;
  const generated = generateAnchors(goal, { existingNegative: anchors.negative });
  const next = { positive: generated.positive, negative: generated.negative, generatedFromGoal: goal };
  await storage.saveAnchors(next);
  return next;
}

// ---- Alarms: flush screen time and expire grants ------------------------------------------

browserApi.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith(ALARM_EXPIRE_PREFIX)) {
    await expireGrant(alarm.name.slice(ALARM_EXPIRE_PREFIX.length));
    return;
  }
  if (alarm.name !== ALARM_TICK) return;
  const { sessions, friction, caches } = await ensureBooted();
  await sessions.flush();
  for (const cache of Object.values(caches)) cache.flush().catch(() => {});
  // Safety net: enforce any grant whose alarm was lost (e.g. cleared by the browser).
  for (const grant of await friction.overdueGrants()) await expireGrant(grant.key);
});

/** Removes the grant and intervenes on the tab(s) it covered, if they are still on the site. */
async function expireGrant(key) {
  const { friction, controller, tabMonitor } = await ensureBooted();
  const grant = await friction.expireGrant(key);
  if (!grant) return;
  try {
    await controller.onGrantExpired(grant);
  } catch (e) {
    console.warn('[GoalGuard] expiry enforcement failed', e);
  }
  // Any other tab on the domain that stayed open is re-evaluated when it becomes active.
  tabMonitor.reevaluateDomain(grant.domain).catch(() => {});
}

/**
 * Best-effort: pause <video>/<audio> before the redirect so playback stops even if the
 * navigation is slow. Requires the (optional) activeTab/host access; failure is ignored.
 */
async function pauseMediaInTab(tabId) {
  if (!browserApi.scripting?.executeScript) return;
  await browserApi.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => {
      for (const m of document.querySelectorAll('video, audio')) {
        try { m.pause(); } catch { /* cross-origin or detached */ }
      }
    },
  });
}

// ---- Messages -------------------------------------------------------------------------------

const router = createMessageRouter({
  async getPopupState() {
    const { sessions, modelManager, llmManager, searchManager, controller } = await ensureBooted();
    const settings = await storage.getSettings();
    const [tab] = await browserApi.tabs.query({ active: true, lastFocusedWindow: true });
    let current = tab ? controller.getTabResult(tab.id) : null;
    const analyzing = tab ? controller.getAnalyzing(tab.id) : null;
    if (!current && tab?.url && !analyzing) {
      // Do not block the popup on search/LLM: return quickly and let the popup poll.
      const pending = controller.handleActiveTab(tab).catch(() => null);
      current = await Promise.race([pending, sleep(300).then(() => null)]);
    }
    const summary = await sessions.getSummary();
    return {
      settings,
      current: current && !current.ignored ? sanitizeOutcome(current, settings.debugMode) : null,
      analyzing: tab ? controller.getAnalyzing(tab.id) : null,
      tab: tab ? { title: tab.title, domain: extractDomain(tab.url) } : null,
      summary,
      model: modelManager.getStatus(),
      ai: aiStatus({ llmManager, searchManager, settings, searchPermission: await hasOriginPermission(DDG_ORIGIN_PATTERN) }),
    };
  },

  async submitFeedback(payload) {
    const { controller } = await ensureBooted();
    if (!['relevant', 'questionable', 'irrelevant'].includes(payload?.userLabel)) return { error: 'Invalid label' };
    return controller.recordFeedback(payload);
  },

  async getFeedback() {
    await ensureBooted();
    return storage.getValue('feedback', []);
  },

  async clearFeedback() {
    await ensureBooted();
    await storage.setValue('feedback', []);
  },

  async getTelemetry() {
    const { pipeline, searchManager, llmManager, llmClassifier, caches } = await ensureBooted();
    return {
      pipeline: pipeline.getTelemetry(),
      search: searchManager.getStatus(),
      llm: { ...llmManager.getStatus(), ...llmClassifier.getStats() },
      caches: Object.fromEntries(Object.entries(caches).map(([k, c]) => [k, c.getStats()])),
    };
  },

  async classifyText({ title, url }) {
    const { controller } = await ensureBooted();
    const settings = await storage.getSettings();
    return sanitizeOutcome(await controller.classifyPage({ title, url: url || 'https://example.invalid/' }), settings.debugMode);
  },

  /** Full trace regardless of debug mode; used by the Options "Try a title" panel. */
  async debugClassify({ title, url }) {
    const { controller } = await ensureBooted();
    return controller.classifyPage({ title, url: url || 'https://example.invalid/' });
  },

  async getFrictionState(payload) {
    const { controller } = await ensureBooted();
    return controller.getFrictionView(payload);
  },

  // ---- Intent ledger ------------------------------------------------------------------------

  async ledgerList(payload = {}) {
    const { ledger } = await ensureBooted();
    return { entries: await ledger.listEntries(payload), counts: await ledger.counts(), session: await ledger.getSession() };
  },

  /** Friction page asks what the user already said about this domain. */
  async ledgerForDomain({ domain }) {
    const { ledger } = await ensureBooted();
    return { pending: await ledger.pendingForDomain(domain) };
  },

  async ledgerFindDuplicate({ domain, intent }) {
    const { ledger } = await ensureBooted();
    return { duplicate: await ledger.findDuplicate({ domain, intent }) };
  },

  async ledgerCreate({ domain, url, title, intent, source }) {
    const { ledger } = await ensureBooted();
    return { entry: await ledger.createEntry({ domain, url, title, intent, source }) };
  },

  async ledgerUpdate({ id, changes }) {
    const { ledger } = await ensureBooted();
    return { entry: await ledger.updateEntry(id, changes) };
  },

  async ledgerComplete({ id }) {
    const { ledger } = await ensureBooted();
    return { entry: await ledger.completeEntry(id) };
  },

  async ledgerReopen({ id }) {
    const { ledger } = await ensureBooted();
    return { entry: await ledger.reopenEntry(id) };
  },

  async ledgerDelete({ id }) {
    const { ledger } = await ensureBooted();
    return { removed: await ledger.deleteEntry(id) };
  },

  async ledgerClearCompleted() {
    const { ledger } = await ensureBooted();
    return { removed: await ledger.clearCompleted() };
  },

  /**
   * Open a task in a new tab. The tab goes through the ordinary tab monitor → classifier →
   * friction path; the ledger grants nothing. Falls back to the domain when no URL is stored
   * or the caller asks for it (stale link).
   */
  async ledgerOpen({ id, useDomain = false }) {
    const { ledger } = await ensureBooted();
    const entry = await ledger.getEntry(id);
    if (!entry) return { error: 'No such entry' };
    const url = !useDomain && entry.url ? entry.url : `https://${entry.domain}/`;
    await ledger.startEntry(id);
    const tab = await browserApi.tabs.create({ url, active: true });
    return { tabId: tab?.id ?? null, url };
  },

  async ledgerSession({ action }) {
    const { ledger } = await ensureBooted();
    if (action === 'start') return { session: await ledger.startSession() };
    if (action === 'skip') return { session: await ledger.skipCurrent() };
    if (action === 'end') { await ledger.endSession(); return { session: null }; }
    return { session: await ledger.getSession() };
  },

  async openLedgerPage() {
    await browserApi.tabs.create({ url: browserApi.runtime.getURL('ledger/ledger.html'), active: true });
  },

  async continueFromFriction(payload, sender) {
    const { controller } = await ensureBooted();
    // The sender tab is authoritative for tab/window identity; URL params are only a hint.
    const tabId = sender?.tab?.id ?? payload.tabId;
    return controller.continueFromFriction({ ...payload, tabId, windowId: sender?.tab?.windowId ?? null });
  },

  async leaveFriction(payload, sender) {
    const { controller } = await ensureBooted();
    await controller.leaveFriction(payload);
    if (payload.closeTab && sender?.tab?.id != null) {
      await browserApi.tabs.remove(sender.tab.id).catch(() => {});
    }
  },

  async getSettings() {
    await ensureBooted();
    const [settings, rules, anchors] = await Promise.all([storage.getSettings(), storage.getRules(), storage.getAnchors()]);
    return { settings, rules, anchors };
  },

  async saveSettings(patch) {
    await ensureBooted();
    if ('weeklyGoal' in patch) {
      const previous = await storage.getSettings();
      if (previous.weeklyGoal !== patch.weeklyGoal) patch.weeklyGoalSetAt = Date.now();
    }
    const saved = await storage.saveSettings(patch);
    if ('weeklyGoal' in patch) await ensureAnchors(saved, await storage.getAnchors());
    return saved;
  },

  async saveRules(rules) {
    await ensureBooted();
    const invalid = [...(rules.allow ?? []), ...(rules.block ?? [])]
      .map((p) => ({ pattern: p, ...validatePattern(p) }))
      .filter((r) => !r.valid);
    if (invalid.length) return { error: 'Invalid regex', invalid };
    return storage.saveRules(rules);
  },

  async saveAnchors(anchors) {
    await ensureBooted();
    const settings = await storage.getSettings();
    return storage.saveAnchors({ ...anchors, generatedFromGoal: settings.weeklyGoal });
  },

  async regenerateAnchors() {
    await ensureBooted();
    const settings = await storage.getSettings();
    const generated = generateAnchors(settings.weeklyGoal);
    return storage.saveAnchors({ ...generated, generatedFromGoal: settings.weeklyGoal });
  },

  async validateRegex({ pattern }) {
    return validatePattern(pattern);
  },

  async getModelStatus() {
    const { modelManager } = await ensureBooted();
    return modelManager.getStatus();
  },

  async getLayer3Status() {
    const { llmManager, searchManager } = await ensureBooted();
    const settings = await storage.getSettings();
    return {
      llm: llmManager.getStatus(),
      search: { ...searchManager.getStatus(), permission: await hasOriginPermission(DDG_ORIGIN_PATTERN) },
      ai: aiStatus({ llmManager, searchManager, settings, searchPermission: await hasOriginPermission(DDG_ORIGIN_PATTERN) }),
    };
  },

  async warmUpLlm() {
    const { llmManager } = await ensureBooted();
    try {
      await llmManager.ensureLoaded();
    } catch {
      /* status carries the error */
    }
    return llmManager.getStatus();
  },

  /** Direct probe of search + LLM for the Options "test" button; bypasses the confidence gate. */
  async testLayer3({ title, domain }) {
    const { llmClassifier, searchManager, controller } = await ensureBooted();
    const { settings } = await controller.getConfig();
    const out = { title };
    if (settings.searchEnabled) out.retrieval = await searchManager.search({ title, domain }, { maxResults: settings.searchMaxResults });
    if (settings.llmEnabled) {
      try {
        const { buildLlmPayload } = await import('../llm/promptBuilder.js');
        out.verdict = await llmClassifier.judge(buildLlmPayload({ goal: settings.weeklyGoal, title, domain, webContext: out.retrieval?.results ?? [] }));
        if (!out.verdict) out.llmError = 'Model did not return valid JSON';
      } catch (e) {
        out.llmError = String(e?.message ?? e);
      }
    }
    return out;
  },

  async warmUpModel() {
    const { modelManager } = await ensureBooted();
    try {
      await modelManager.ensureLoaded();
    } catch {
      /* status carries the error */
    }
    return modelManager.getStatus();
  },

  async getStatistics() {
    const { sessions, friction } = await ensureBooted();
    return { ...(await sessions.getSummary()), grants: await friction.listGrants() };
  },

  async getCacheStats() {
    const { caches } = await ensureBooted();
    return Object.fromEntries(Object.entries(caches).map(([k, c]) => [k, c.getStats()]));
  },

  async clearCaches({ namespaces } = {}) {
    const { caches, controller } = await ensureBooted();
    const targets = Array.isArray(namespaces) ? namespaces.filter((n) => caches[n]) : Object.keys(caches);
    await Promise.all(targets.map((n) => caches[n].clear()));
    controller.invalidateConfig();
    return { cleared: targets };
  },

  /** Manual revoke from the options page: enforced exactly like a natural expiry. */
  async revokeGrant({ domain, key }) {
    const { friction } = await ensureBooted();
    const targets = (await friction.listGrants()).filter((g) => (key ? g.key === key : g.domain === domain));
    for (const g of targets) await expireGrant(g.key);
  },

  async resetAll() {
    if (app) for (const c of Object.values(app.caches)) { c.map.clear(); c.inFlight.clear(); c.dirty = false; }
    await storage.resetAll();
    app?.controller.invalidateConfig();
    if (app) {
      app.friction.state = null;
      app.sessions.current = undefined;
    }
  },
});

browserApi.runtime.onMessage.addListener(router);

function sanitizeOutcome(outcome, debug = false) {
  if (!outcome) return null;
  if (debug) return outcome;
  const { trace, timings, ...rest } = outcome;
  return rest;
}

/** Compact "AI: local model ready / Semantic search: online" status for the popup. */
function aiStatus({ llmManager, searchManager, settings, searchPermission }) {
  const llm = llmManager.getStatus();
  const search = searchManager.getStatus();
  return {
    embeddings: settings.embeddingsEnabled !== false,
    llm: { enabled: Boolean(settings.llmEnabled), status: llm.status, model: llm.modelVersion, progress: llm.progress, error: llm.error },
    search: {
      enabled: Boolean(settings.searchEnabled),
      permission: searchPermission,
      online: typeof navigator === 'undefined' || navigator.onLine !== false,
      lastError: search.lastError,
      requests: search.requests,
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Lifecycle -------------------------------------------------------------------------------

browserApi.runtime.onInstalled.addListener(({ reason }) => {
  ensureBooted()
    .then(() => {
      if (reason === 'install') browserApi.runtime.openOptionsPage().catch(() => {});
    })
    .catch((e) => console.error('[GoalGuard] boot failed', e));
});

browserApi.runtime.onStartup.addListener(() => {
  ensureBooted().catch((e) => console.error('[GoalGuard] boot failed', e));
});

ensureBooted().catch((e) => console.error('[GoalGuard] boot failed', e));

export { FRICTION_STATE };
