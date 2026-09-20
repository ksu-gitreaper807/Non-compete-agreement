/**
 * Persistent, bounded, TTL + LRU cache namespaces backed by the existing storage wrapper.
 *
 * Design:
 *  - One storage key per namespace (`cache:<namespace>`), loaded lazily into a Map ordered by
 *    recency. Reads are in-memory; writes are debounced and batched so navigation never
 *    triggers a synchronous disk write.
 *  - Keys are versioned by the caller (see `cacheKeys.js`), so schema/model changes never
 *    reuse incompatible entries. `CACHE_SCHEMA_VERSION` guards the on-disk envelope itself.
 *  - Eviction on insert only: drop expired entries first, then least-recently-used, until the
 *    namespace is under its `maxEntries`. No periodic full scans.
 *  - `getOrCompute` deduplicates concurrent identical requests via an in-flight promise map.
 */
import { getValue, setValue } from './storage.js';

export const CACHE_SCHEMA_VERSION = 1;

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** Tunables. Change here (or pass overrides) rather than scattering constants. */
export const CACHE_DEFAULTS = Object.freeze({
  classification: { ttlMs: 7 * DAY, maxEntries: 2000 },
  embedding: { ttlMs: 30 * DAY, maxEntries: 500 },
  retrieval: { ttlMs: 24 * HOUR, maxEntries: 300 },
  llm: { ttlMs: 7 * DAY, maxEntries: 1000 },
});

export const FINAL_CLASSIFICATION_TTL = CACHE_DEFAULTS.classification.ttlMs;
export const EMBEDDING_TTL = CACHE_DEFAULTS.embedding.ttlMs;
export const SEARCH_RESULT_TTL = CACHE_DEFAULTS.retrieval.ttlMs;
export const MAX_CLASSIFICATION_CACHE_ENTRIES = CACHE_DEFAULTS.classification.maxEntries;
export const MAX_EMBEDDING_CACHE_ENTRIES = CACHE_DEFAULTS.embedding.maxEntries;
export const MAX_SEARCH_CACHE_ENTRIES = CACHE_DEFAULTS.retrieval.maxEntries;

const PERSIST_DEBOUNCE_MS = 3000;

export class PersistentCache {
  /**
   * @param {string} namespace
   * @param {Object} [options]
   * @param {number} [options.ttlMs]
   * @param {number} [options.maxEntries]
   * @param {(value:any)=>any} [options.serialize]     value → JSON-friendly form
   * @param {(stored:any)=>any} [options.deserialize]  stored form → value
   * @param {() => number} [options.now]
   * @param {(line: string) => void} [options.log]     debug sink; undefined = silent
   * @param {boolean} [options.persist=true]
   */
  constructor(namespace, options = {}) {
    const defaults = CACHE_DEFAULTS[namespace] ?? { ttlMs: DAY, maxEntries: 500 };
    this.namespace = namespace;
    this.storageKey = `cache:${namespace}`;
    this.ttlMs = options.ttlMs ?? defaults.ttlMs;
    this.maxEntries = Math.max(1, options.maxEntries ?? defaults.maxEntries);
    this.serialize = options.serialize ?? ((v) => v);
    this.deserialize = options.deserialize ?? ((v) => v);
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? null;
    this.persistEnabled = options.persist !== false;
    this.map = new Map(); // key -> { value, createdAt, lastAccessedAt, expiresAt }
    this.inFlight = new Map(); // key -> Promise
    this.loaded = null;
    this.dirty = false;
    this.persistTimer = null;
    this.stats = { hits: 0, misses: 0, expired: 0, evicted: 0, dedupeHits: 0, writes: 0 };
  }

  setLogger(log) {
    this.log = log ?? null;
  }

  debug(event, key) {
    if (this.log) this.log(`[CACHE] ${this.namespace} ${event}${key ? ` ${key}` : ''}`);
  }

  async ensureLoaded() {
    if (this.loaded) return this.loaded;
    this.loaded = (async () => {
      if (!this.persistEnabled) return;
      const stored = await getValue(this.storageKey, null);
      if (!stored || stored.schemaVersion !== CACHE_SCHEMA_VERSION || !Array.isArray(stored.entries)) return;
      const now = this.now();
      // Stored oldest → newest so re-insertion preserves recency order.
      for (const [key, entry] of stored.entries) {
        if (!entry || entry.expiresAt <= now) continue;
        this.map.set(key, { ...entry, value: this.deserialize(entry.value) });
      }
    })().catch((e) => console.warn(`[GoalGuard] cache ${this.namespace} load failed`, e));
    return this.loaded;
  }

  get size() {
    return this.map.size;
  }

  /** @returns {Promise<any|undefined>} */
  async get(key) {
    await this.ensureLoaded();
    const entry = this.map.get(key);
    if (!entry) {
      this.stats.misses++;
      this.debug('MISS', key);
      return undefined;
    }
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.map.delete(key);
      this.stats.expired++;
      this.stats.misses++;
      this.debug('expired', key);
      this.markDirty();
      return undefined;
    }
    // Refresh recency (Map order) without a disk write per hit; the batch persists later.
    this.map.delete(key);
    entry.lastAccessedAt = now;
    this.map.set(key, entry);
    this.stats.hits++;
    this.debug('HIT', key);
    this.markDirty(true);
    return entry.value;
  }

  async set(key, value, { ttlMs = this.ttlMs } = {}) {
    await this.ensureLoaded();
    const now = this.now();
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, createdAt: now, lastAccessedAt: now, expiresAt: now + ttlMs });
    this.evictIfNeeded();
    this.markDirty();
    return value;
  }

  async delete(key) {
    await this.ensureLoaded();
    const existed = this.map.delete(key);
    if (existed) this.markDirty();
    return existed;
  }

  /**
   * Cache-aside with request deduplication: concurrent callers for the same key share one
   * in-flight promise, so an expensive computation runs at most once.
   */
  async getOrCompute(key, compute, { ttlMs } = {}) {
    const cached = await this.get(key);
    if (cached !== undefined) return { value: cached, cached: true };
    if (this.inFlight.has(key)) {
      this.stats.dedupeHits++;
      this.debug('in-flight join', key);
      return { value: await this.inFlight.get(key), cached: false, deduplicated: true };
    }
    const promise = (async () => {
      const value = await compute();
      if (value !== undefined && value !== null) await this.set(key, value, { ttlMs });
      return value;
    })();
    this.inFlight.set(key, promise);
    try {
      return { value: await promise, cached: false };
    } finally {
      this.inFlight.delete(key);
    }
  }

  evictIfNeeded() {
    if (this.map.size <= this.maxEntries) return;
    const now = this.now();
    for (const [key, entry] of this.map) {
      if (entry.expiresAt <= now) {
        this.map.delete(key);
        this.stats.expired++;
        this.debug('expired', key);
      }
    }
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value; // least recently used
      this.map.delete(oldest);
      this.stats.evicted++;
      this.debug('evicted', oldest);
    }
  }

  /** Drop every entry whose key starts with `prefix` (used for version/goal invalidation). */
  async invalidatePrefix(prefix) {
    await this.ensureLoaded();
    let removed = 0;
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) {
        this.map.delete(key);
        removed++;
      }
    }
    if (removed) this.markDirty();
    return removed;
  }

  async clear() {
    await this.ensureLoaded();
    this.map.clear();
    this.inFlight.clear();
    this.markDirty();
    await this.flush();
  }

  markDirty(recencyOnly = false) {
    if (!this.persistEnabled) return;
    this.dirty = true;
    if (this.persistTimer) return;
    // Recency-only updates are persisted lazily with a longer delay to limit disk writes.
    this.persistTimer = setTimeout(() => this.flush().catch(() => {}), recencyOnly ? PERSIST_DEBOUNCE_MS * 5 : PERSIST_DEBOUNCE_MS);
  }

  async flush() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.dirty || !this.persistEnabled) return;
    this.dirty = false;
    const entries = [];
    for (const [key, entry] of this.map) {
      entries.push([key, { ...entry, value: this.serialize(entry.value) }]);
    }
    this.stats.writes++;
    await setValue(this.storageKey, { schemaVersion: CACHE_SCHEMA_VERSION, savedAt: this.now(), entries });
  }

  getStats() {
    return { namespace: this.namespace, size: this.map.size, maxEntries: this.maxEntries, ttlMs: this.ttlMs, ...this.stats };
  }
}

/** Compact Float32Array ↔ number[] with 4-decimal rounding (≈2.5 KB per 384-d vector). */
export const float32Codec = {
  serialize: (vec) => Array.from(vec, (x) => Math.round(x * 1e4) / 1e4),
  deserialize: (arr) => Float32Array.from(arr),
};
