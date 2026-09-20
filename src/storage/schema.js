/**
 * Canonical data model and defaults. Every other module imports defaults from here so
 * threshold configuration stays separate from classification logic.
 */

export const SCHEMA_VERSION = 1;

export const CLASSIFICATION = Object.freeze({
  RELEVANT: 'relevant',
  QUESTIONABLE: 'questionable',
  IRRELEVANT: 'irrelevant',
  UNKNOWN: 'unknown', // no signal available (no title, model unavailable, ...)
});

export const DECISION = Object.freeze({
  ALLOW: 'allow',
  WARN: 'warn',
  BLOCK: 'block',
});

export const FRICTION_STATE = Object.freeze({
  BLOCKED: 'BLOCKED',
  COUNTING_DOWN: 'COUNTING_DOWN',
  UNLOCKED: 'UNLOCKED',
  TEMPORARILY_ALLOWED: 'TEMPORARILY_ALLOWED',
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  weeklyGoal: '',
  weeklyGoalSetAt: 0,
  weeklyTargetMinutes: 600,

  // Thresholds are applied to semanticScore = positiveSimilarity - negativeSimilarity,
  // rescaled to [0,1] (see embeddingClassifier). Defaults are heuristic, not validated.
  relevantThreshold: 0.65,
  questionableThreshold: 0.45,

  // Friction / override
  frictionSeconds: 10,
  questionableFrictionMode: 'short', // 'none' | 'short' | 'normal'
  questionableFrictionSeconds: 5,
  overrideMinutes: 5,
  overrideScope: 'tab', // 'tab' = only the tab that waited | 'domain' = every tab on the site
  expiryAction: 'friction', // when access expires: 'friction' | 'close' | 'neutral'

  // Policy: classification -> decision
  policy: {
    relevant: 'allow',
    questionable: 'warn',
    irrelevant: 'block',
    unknown: 'allow',
  },

  // Deterministic domain lists
  allowedDomains: [],
  blockedDomains: [],

  // Behaviour when the semantic model cannot run
  fallbackClassification: 'unknown',

  // AI layers (all opt-in except embeddings). See docs/CLASSIFICATION.md.
  embeddingsEnabled: true,
  llmEnabled: false,          // local LLM judges pages the cheaper layers could not decide
  searchEnabled: false,       // fetch web context (page title only) for the LLM
  searchMode: 'ambiguous',    // 'uncertain' = every questionable page | 'ambiguous' = only generic/low-information titles
  searchMaxResults: 5,        // 1..10
  searchCacheHours: 24,       // 1..168
  llmRuntime: 'nli',          // 'nli' (in-browser NLI judge, default) | 'transformers' (in-browser generative) | 'ollama' | 'llamacpp'
  llmEndpoint: '',            // localhost URL for ollama/llamacpp; empty = adapter default
  llmModelName: '',           // model tag for ollama/llamacpp; empty = adapter default
  llmMinConfidence: 0.6,      // below this the LLM verdict is downgraded to questionable
  debugMode: false,           // show per-classification trace in the popup
});

export const SEARCH_MODE = Object.freeze({ UNCERTAIN: 'uncertain', AMBIGUOUS: 'ambiguous' });
export const EVIDENCE_QUALITY = Object.freeze({ HIGH: 'high', MEDIUM: 'medium', LOW: 'low', NONE: 'none' });
export const SOURCE = Object.freeze({ EXPLICIT_RULE: 'explicit_rule', REGEX: 'regex', EMBEDDING: 'embedding', LOCAL_LLM: 'local_llm', FALLBACK: 'fallback' });

export const DEFAULT_RULES = Object.freeze({
  allow: [],
  block: [],
});

/** Generic distraction anchors used when the user has not edited anchors. */
export const DEFAULT_NEGATIVE_ANCHORS = Object.freeze([
  'video games and gaming',
  'entertainment and celebrity news',
  'online shopping and product deals',
  'social media feed',
  'memes and funny videos',
  'sports scores and highlights',
  'movie and TV show streaming',
  'gossip and viral news',
]);

export const DEFAULT_ANCHORS = Object.freeze({
  positive: [],
  negative: [...DEFAULT_NEGATIVE_ANCHORS],
  generatedFromGoal: '',
});

export const DEFAULT_LIMITS = Object.freeze({
  embeddingCacheEntries: 500,
  classificationCacheEntries: 1000,
  maxSessions: 2000,
  sessionRetentionDays: 14,
  maxFeedbackEntries: 2000,
});

export function createDefaultState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: structuredClone(DEFAULT_SETTINGS),
    rules: structuredClone(DEFAULT_RULES),
    anchors: structuredClone(DEFAULT_ANCHORS),
    sessions: [],
    statistics: { days: {} },
    friction: { countdowns: {}, grants: {} },
  };
}

/**
 * Session record. We intentionally do not store URLs, only domain + truncated title.
 * @typedef {Object} Session
 * @property {string} id
 * @property {string} domain
 * @property {string} title
 * @property {string} classification
 * @property {string} decision
 * @property {number} score
 * @property {number} startedAt
 * @property {number} endedAt
 * @property {boolean} overridden   true when time was spent under a temporary grant
 */

/**
 * Daily statistics bucket.
 * @typedef {Object} DayStats
 * @property {number} relevantMs
 * @property {number} questionableMs
 * @property {number} irrelevantMs
 * @property {number} overrideMs      time spent after an override (subset of irrelevant/questionable)
 * @property {number} frictionTriggered
 * @property {number} frictionCompleted
 * @property {number} frictionAbandoned
 * @property {number} frictionReset      running countdowns invalidated by tab switch / navigation
 * @property {number} overrides
 * @property {number} overrideGrantedMs  total access duration granted by overrides
 */
export function createDayStats() {
  return {
    relevantMs: 0,
    questionableMs: 0,
    irrelevantMs: 0,
    unknownMs: 0,
    overrideMs: 0,
    frictionTriggered: 0,
    frictionCompleted: 0,
    frictionAbandoned: 0,
    frictionReset: 0,
    overrides: 0,
    overrideGrantedMs: 0,
    overrideExpired: 0,
  };
}

export function dayKey(timestamp = Date.now()) {
  const d = new Date(timestamp);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** ISO week starts on Monday. Returns keys for the 7 days of the week containing `timestamp`. */
export function weekDayKeys(timestamp = Date.now()) {
  const d = new Date(timestamp);
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - dow);
  const keys = [];
  for (let i = 0; i < 7; i++) {
    keys.push(dayKey(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i).getTime()));
  }
  return keys;
}
