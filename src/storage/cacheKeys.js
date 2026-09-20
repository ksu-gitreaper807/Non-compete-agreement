/**
 * Deterministic, versioned cache keys. Bump a *_KEY_VERSION whenever the meaning of the cached
 * value changes; old entries then simply never match again and age out via TTL/LRU.
 */
import { hashString, normalizeTitleForKey } from '../utils/text.js';

export const CLASSIFICATION_KEY_VERSION = 'v1';
export const EMBEDDING_KEY_VERSION = 'v1';
export const RETRIEVAL_KEY_VERSION = 'v1';

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
