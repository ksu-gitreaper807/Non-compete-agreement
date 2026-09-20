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
import { generateAnchors } from '../classifier/anchors.js';
import { ModelManager, createExtensionLoader } from '../model/modelManager.js';
import { FrictionManager } from '../blocking/frictionManager.js';
import { SessionTracker } from './sessionTracker.js';
import { Controller } from './controller.js';
import { TabMonitor } from './tabMonitor.js';
import { createMessageRouter } from './messageRouter.js';
import { buildBlockedPageUrl, isBlockedPageUrl, BLOCKED_PAGE_PATH } from '../blocking/blocker.js';
import { validatePattern } from '../utils/regex.js';
import { extractDomain } from '../utils/text.js';

const browserApi = globalThis.browser ?? globalThis.chrome;
const BLOCKED_BASE_URL = browserApi.runtime.getURL(BLOCKED_PAGE_PATH);
const ALARM_TICK = 'goalguard-tick';
const EMBEDDING_CACHE_KEY = 'embeddingCache';

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

  const friction = new FrictionManager({
    load: storage.getFrictionState,
    save: storage.saveFrictionState,
    onEvent: (event) => sessions.recordEvent(event).catch(() => {}),
  });

  const initialCache = await storage.getValue(EMBEDDING_CACHE_KEY, []);
  const modelManager = new ModelManager({
    // Tests may inject a Node-compatible loader; the extension always uses the bundled files.
    loader: globalThis.GOALGUARD_MODEL_LOADER ?? createExtensionLoader(browserApi.runtime),
    cacheSize: DEFAULT_LIMITS.embeddingCacheEntries,
    initialCache: Array.isArray(initialCache) ? initialCache : [],
    persistCache: (entries) => storage.setValue(EMBEDDING_CACHE_KEY, entries),
  });

  const classifiers = [
    new RegexClassifier(),
    new EmbeddingClassifier({
      embed: (text) => modelManager.embed(text),
      isAvailable: () => modelManager.isAvailable(),
    }),
    // Future: new LLMClassifier(...) for QUESTIONABLE results.
  ];

  const controller = new Controller({
    classifiers,
    friction,
    sessions,
    classificationCacheSize: DEFAULT_LIMITS.classificationCacheEntries,
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
  });

  const tabMonitor = new TabMonitor({ browser: browserApi, controller });
  tabMonitor.start();

  storage.onStorageChanged((changes) => {
    if (changes.settings || changes.rules || changes.anchors) {
      controller.invalidateConfig();
      tabMonitor.refreshActive().catch(() => {});
    }
  });

  browserApi.alarms.create(ALARM_TICK, { periodInMinutes: 1 });

  app = { sessions, friction, modelManager, controller, tabMonitor };
  return app;
}

function ensureBooted() {
  if (!bootPromise) bootPromise = boot().catch((e) => {
    bootPromise = null;
    throw e;
  });
  return bootPromise;
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
  if (alarm.name !== ALARM_TICK) return;
  const { sessions, friction, controller, tabMonitor } = await ensureBooted();
  await sessions.flush();
  const before = new Set((await friction.listGrants()).map((g) => g.domain));
  await friction.ensureLoaded();
  friction.pruneExpired();
  for (const domain of before) {
    if (!friction.state.grants[domain]) {
      await controller.onGrantExpired(domain);
      await tabMonitor.reevaluateDomain(domain);
    }
  }
});

// ---- Messages -------------------------------------------------------------------------------

const router = createMessageRouter({
  async getPopupState(_, sender) {
    const { sessions, modelManager, controller } = await ensureBooted();
    const settings = await storage.getSettings();
    const [tab] = await browserApi.tabs.query({ active: true, lastFocusedWindow: true });
    let current = tab ? controller.getTabResult(tab.id) : null;
    if (!current && tab?.url) current = await controller.handleActiveTab(tab).catch(() => null);
    const summary = await sessions.getSummary();
    return {
      settings,
      current: current && !current.ignored ? sanitizeOutcome(current) : null,
      tab: tab ? { title: tab.title, domain: extractDomain(tab.url) } : null,
      summary,
      model: modelManager.getStatus(),
    };
  },

  async classifyText({ title, url }) {
    const { controller } = await ensureBooted();
    return sanitizeOutcome(await controller.classifyPage({ title, url: url || 'https://example.invalid/' }));
  },

  async getFrictionState(payload) {
    const { controller } = await ensureBooted();
    return controller.getFrictionView(payload);
  },

  async continueFromFriction(payload) {
    const { controller } = await ensureBooted();
    return controller.continueFromFriction(payload);
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

  async revokeGrant({ domain }) {
    const { friction, controller, tabMonitor } = await ensureBooted();
    await friction.revokeGrant(domain);
    await controller.onGrantExpired(domain);
    await tabMonitor.reevaluateDomain(domain);
  },

  async resetAll() {
    await storage.resetAll();
    app?.controller.invalidateConfig();
    if (app) {
      app.friction.state = null;
      app.sessions.current = undefined;
    }
  },
});

browserApi.runtime.onMessage.addListener(router);

function sanitizeOutcome(outcome) {
  if (!outcome) return null;
  const { trace, ...rest } = outcome;
  return rest;
}

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
