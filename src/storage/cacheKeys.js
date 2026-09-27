/**
 * Deterministic, versioned cache keys. Bump a *_KEY_VERSION whenever the meaning of the cached
 * value changes; old entries then simply never match again and age out via TTL/LRU.
 */
import { hashString, normalizeTitleForKey } from '../utils/text.js';

export const CLASSIFICATION_KEY_VERSION = 'v1';
export const EMBEDDING_KEY_VERSION = 'v1';
export const RETRIEVAL_KEY_VERSION = 'v2'; // v2: results carry url + relevance
export const LLM_KEY_VERSION = 'v2'; // v2: prompt primer + user context are part of the identity

/**
 * Fingerprint of everything a final classification depends on besides the page itself:
 * the goal, anchors, thresholds, rules and the model. Changing any of these produces new keys,
 * so stale decisions can never be served after a settings change.
 */
export function classificationConfigFingerprint({ settings, rules, anchors, modelVersion }) {
  return hashString(
    JSON.stringify([
      modelVersion,
      settings?.weeklyGoal ?? '',
      settings?.relevantThreshold,
      settings?.questionableThreshold,
      Boolean(settings?.llmEnabled),
      Boolean(settings?.searchEnabled),
      settings?.searchMode ?? '',
      settings?.llmRuntime ?? '',
      Boolean(settings?.llmSecondOpinion),
      settings?.llmContextNotes ?? '',
      settings?.allowedDomains ?? [],
      settings?.blockedDomains ?? [],
      rules?.allow ?? [],
      rules?.block ?? [],
      anchors?.positive ?? [],
      anchors?.negative ?? [],
    ])
  );
}

/** `cls:v1:<config-fingerprint>:<domain>:<normalised title>` */
export function classificationKey({ domain, text, fingerprint }) {
  return `cls:${CLASSIFICATION_KEY_VERSION}:${fingerprint}:${(domain ?? '').toLowerCase()}:${normalizeTitleForKey(text)}`;
}

/** `emb:v1:<model-version>:<hash(normalised text)>` — hashed so keys stay short. */
export function embeddingKey({ modelVersion, text }) {
  return `emb:${EMBEDDING_KEY_VERSION}:${modelVersion}:${hashString(normalizeTitleForKey(text))}`;
}

/** `ret:v1:<provider>:<normalised query>` */
export function retrievalKey({ provider, query }) {
  return `ret:${RETRIEVAL_KEY_VERSION}:${provider}:${normalizeTitleForKey(query)}`;
}

/**
 * `llm:v2:<model>:<hash(prompt-version|goal|title|domain|context)>` — one verdict per page,
 * per context *and* per prompt. `promptVersion` folds in the primer version and the user's
 * own notes (see promptContext.promptFingerprint), so editing them re-judges instead of
 * replaying verdicts produced under different instructions.
 */
export function llmKey({ modelVersion, promptVersion = '', goal, title, domain, contextVersion }) {
  return `llm:${LLM_KEY_VERSION}:${modelVersion}:${hashString([promptVersion, goal, normalizeTitleForKey(title), (domain ?? '').toLowerCase(), contextVersion ?? ''].join('\u0000'))}`;
}
