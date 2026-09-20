/**
 * Thin wrapper around browser.storage.local with defaults, validation and an
 * in-memory fallback so the extension keeps working if storage fails.
 */
import {
  createDefaultState,
  DEFAULT_SETTINGS,
  DEFAULT_RULES,
  DEFAULT_ANCHORS,
  SCHEMA_VERSION,
} from './schema.js';

const storageArea = globalThis.browser?.storage?.local ?? globalThis.chrome?.storage?.local ?? null;
let memoryFallback = createDefaultState();

async function rawGet(keys) {
  if (!storageArea) return pick(memoryFallback, keys);
  try {
    return await storageArea.get(keys);
  } catch (e) {
    console.warn('[GoalGuard] storage.get failed, using memory fallback', e);
    return pick(memoryFallback, keys);
  }
}

async function rawSet(obj) {
  Object.assign(memoryFallback, structuredClone(obj));
  if (!storageArea) return;
  try {
    await storageArea.set(obj);
  } catch (e) {
    console.warn('[GoalGuard] storage.set failed, kept in memory only', e);
  }
}

function pick(source, keys) {
  const list = Array.isArray(keys) ? keys : [keys];
  const out = {};
  for (const k of list) if (k in source) out[k] = structuredClone(source[k]);
  return out;
}

export async function initStorage() {
  const existing = await rawGet(['schemaVersion']);
  if (existing.schemaVersion !== SCHEMA_VERSION) {
    const state = createDefaultState();
    const current = await rawGet(Object.keys(state));
    // Merge existing values over defaults so upgrades keep user data.
    for (const key of Object.keys(state)) {
      if (current[key] !== undefined && key !== 'schemaVersion') {
        state[key] = mergeDefaults(state[key], current[key]);
      }
    }
    await rawSet(state);
  }
}

function mergeDefaults(defaults, value) {
  if (Array.isArray(defaults)) return Array.isArray(value) ? value : defaults;
  if (defaults && typeof defaults === 'object') {
    const out = { ...defaults };
    if (value && typeof value === 'object') {
      for (const k of Object.keys(value)) out[k] = k in defaults ? mergeDefaults(defaults[k], value[k]) : value[k];
    }
    return out;
  }
  return value === undefined ? defaults : value;
}

export async function getSettings() {
  const { settings } = await rawGet('settings');
  return mergeDefaults(structuredClone(DEFAULT_SETTINGS), settings ?? {});
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = mergeDefaults(current, sanitizeSettings(patch));
  await rawSet({ settings: next });
  return next;
}

function sanitizeSettings(patch) {
  const out = { ...patch };
  const num = (v, min, max, fallback) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  if ('relevantThreshold' in out) out.relevantThreshold = num(out.relevantThreshold, 0, 1, DEFAULT_SETTINGS.relevantThreshold);
  if ('questionableThreshold' in out) out.questionableThreshold = num(out.questionableThreshold, 0, 1, DEFAULT_SETTINGS.questionableThreshold);
  if ('frictionSeconds' in out) out.frictionSeconds = Math.round(num(out.frictionSeconds, 1, 3600, DEFAULT_SETTINGS.frictionSeconds));
  if ('questionableFrictionSeconds' in out) out.questionableFrictionSeconds = Math.round(num(out.questionableFrictionSeconds, 1, 3600, DEFAULT_SETTINGS.questionableFrictionSeconds));
  if ('overrideMinutes' in out) out.overrideMinutes = num(out.overrideMinutes, 0.5, 1440, DEFAULT_SETTINGS.overrideMinutes);
  if ('weeklyTargetMinutes' in out) out.weeklyTargetMinutes = Math.round(num(out.weeklyTargetMinutes, 0, 100000, DEFAULT_SETTINGS.weeklyTargetMinutes));
  if ('weeklyGoal' in out) out.weeklyGoal = String(out.weeklyGoal ?? '').slice(0, 500);
  if ('searchMaxResults' in out) out.searchMaxResults = Math.round(num(out.searchMaxResults, 1, 10, DEFAULT_SETTINGS.searchMaxResults));
  if ('searchCacheHours' in out) out.searchCacheHours = Math.round(num(out.searchCacheHours, 1, 168, DEFAULT_SETTINGS.searchCacheHours));
  if ('llmMinConfidence' in out) out.llmMinConfidence = num(out.llmMinConfidence, 0, 1, DEFAULT_SETTINGS.llmMinConfidence);
  if ('searchMode' in out && !['uncertain', 'ambiguous'].includes(out.searchMode)) out.searchMode = DEFAULT_SETTINGS.searchMode;
  if ('overrideScope' in out && !['tab', 'domain'].includes(out.overrideScope)) out.overrideScope = DEFAULT_SETTINGS.overrideScope;
  if ('expiryAction' in out && !['friction', 'close', 'neutral'].includes(out.expiryAction)) out.expiryAction = DEFAULT_SETTINGS.expiryAction;
  if ('llmRuntime' in out && !['nli', 'transformers', 'ollama', 'llamacpp'].includes(out.llmRuntime)) out.llmRuntime = DEFAULT_SETTINGS.llmRuntime;
  if ('llmEndpoint' in out) out.llmEndpoint = String(out.llmEndpoint ?? '').trim().slice(0, 200);
  if ('llmModelName' in out) out.llmModelName = String(out.llmModelName ?? '').trim().slice(0, 100);
  if ('allowedDomains' in out) out.allowedDomains = cleanList(out.allowedDomains);
  if ('blockedDomains' in out) out.blockedDomains = cleanList(out.blockedDomains);
  return out;
}

function cleanList(list) {
  return (Array.isArray(list) ? list : [])
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 500);
}

export async function getRules() {
  const { rules } = await rawGet('rules');
  return mergeDefaults(structuredClone(DEFAULT_RULES), rules ?? {});
}

export async function saveRules(rules) {
  const next = {
    allow: cleanPatternList(rules?.allow),
    block: cleanPatternList(rules?.block),
  };
  await rawSet({ rules: next });
  return next;
}

function cleanPatternList(list) {
  return (Array.isArray(list) ? list : []).map((s) => String(s)).filter((s) => s.trim()).slice(0, 500);
}

export async function getAnchors() {
  const { anchors } = await rawGet('anchors');
  return mergeDefaults(structuredClone(DEFAULT_ANCHORS), anchors ?? {});
}

export async function saveAnchors(anchors) {
  const next = {
    positive: cleanList(anchors?.positive).slice(0, 50),
    negative: cleanList(anchors?.negative).slice(0, 50),
    generatedFromGoal: String(anchors?.generatedFromGoal ?? ''),
  };
  await rawSet({ anchors: next });
  return next;
}

export async function getFrictionState() {
  const { friction } = await rawGet('friction');
  return friction ?? { countdowns: {}, grants: {} };
}

export async function saveFrictionState(friction) {
  await rawSet({ friction });
}

export async function getStatistics() {
  const { statistics } = await rawGet('statistics');
  return statistics ?? { days: {} };
}

export async function saveStatistics(statistics) {
  await rawSet({ statistics });
}

export async function getSessions() {
  const { sessions } = await rawGet('sessions');
  return Array.isArray(sessions) ? sessions : [];
}

export async function saveSessions(sessions) {
  await rawSet({ sessions });
}

/** Generic key/value access for caches. */
export async function getValue(key, fallback = undefined) {
  const result = await rawGet(key);
  return result[key] === undefined ? fallback : result[key];
}

export async function setValue(key, value) {
  await rawSet({ [key]: value });
}

export async function resetAll() {
  const state = createDefaultState();
  if (storageArea) {
    try {
      await storageArea.clear();
    } catch (e) {
      console.warn('[GoalGuard] storage.clear failed', e);
    }
  }
  memoryFallback = createDefaultState();
  await rawSet(state);
}

export function onStorageChanged(callback) {
  const api = globalThis.browser?.storage ?? globalThis.chrome?.storage;
  if (!api?.onChanged) return () => {};
  const listener = (changes, area) => {
    if (area === 'local') callback(changes);
  };
  api.onChanged.addListener(listener);
  return () => api.onChanged.removeListener(listener);
}
