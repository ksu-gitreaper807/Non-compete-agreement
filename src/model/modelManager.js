/**
 * Lazy, single-instance lifecycle for the embedding model plus an LRU embedding cache.
 *
 * Status transitions:  idle -> loading -> ready
 *                                     \-> unavailable (after failure; retried after a cool-down)
 */
import { loadEmbeddingModel } from './embeddingModel.js';
import { hashString, normalizeTitle } from '../utils/text.js';
import { LruCache } from '../utils/lruCache.js';

export const MODEL_STATUS = Object.freeze({
  IDLE: 'idle',
  LOADING: 'loading',
  READY: 'ready',
  UNAVAILABLE: 'unavailable',
});

const RETRY_COOLDOWN_MS = 5 * 60 * 1000;

export class ModelManager {
  /**
   * @param {Object} options
   * @param {() => Promise<import('./embeddingModel.js').EmbeddingModel>} options.loader
   * @param {number} [options.cacheSize]
   * @param {(entries: Array) => Promise<void>} [options.persistCache]
   * @param {Array} [options.initialCache]
   */
  constructor({ loader, cacheSize = 500, persistCache = null, initialCache = [] }) {
    this.loader = loader;
    this.status = MODEL_STATUS.IDLE;
    this.error = null;
    this.model = null;
    this.loadPromise = null;
    this.lastFailureAt = 0;
    this.loadTimeMs = null;
    this.stats = { inferences: 0, totalInferenceMs: 0, cacheHits: 0 };
    this.cache = new LruCache(cacheSize);
    for (const [key, value] of initialCache) this.cache.set(key, Float32Array.from(value));
    this.persistCache = persistCache;
    this.persistTimer = null;
  }

  getStatus() {
    return {
      status: this.status,
      error: this.error,
      loadTimeMs: this.loadTimeMs,
      inferences: this.stats.inferences,
      averageInferenceMs: this.stats.inferences ? Math.round(this.stats.totalInferenceMs / this.stats.inferences) : null,
      cacheHits: this.stats.cacheHits,
      cacheSize: this.cache.size,
    };
  }

  isAvailable() {
    if (this.status === MODEL_STATUS.UNAVAILABLE) {
      return Date.now() - this.lastFailureAt > RETRY_COOLDOWN_MS;
    }
    return true;
  }

  /** Loads the model once; concurrent callers share the same promise. */
  async ensureLoaded() {
    if (this.model) return this.model;
    if (this.loadPromise) return this.loadPromise;
    if (!this.isAvailable()) throw new Error(`Model unavailable: ${this.error}`);

    this.status = MODEL_STATUS.LOADING;
    const started = Date.now();
    this.loadPromise = (async () => {
      try {
        const model = await this.loader();
        this.model = model;
        this.status = MODEL_STATUS.READY;
        this.error = null;
        this.loadTimeMs = Date.now() - started;
        return model;
      } catch (e) {
        this.status = MODEL_STATUS.UNAVAILABLE;
        this.error = String(e?.message ?? e);
        this.lastFailureAt = Date.now();
        console.warn('[GoalGuard] embedding model failed to load:', e);
        throw e;
      } finally {
        this.loadPromise = null;
      }
    })();
    return this.loadPromise;
  }

  static cacheKey(text) {
    return hashString(normalizeTitle(text).toLowerCase());
  }

  /** Embed with cache. Throws if the model cannot be loaded. */
  async embed(text) {
    const key = ModelManager.cacheKey(text);
    const cached = this.cache.get(key);
    if (cached) {
      this.stats.cacheHits++;
      return cached;
    }
    const model = await this.ensureLoaded();
    const started = performance.now();
    const vector = await model.embed(text);
    this.stats.inferences++;
    this.stats.totalInferenceMs += performance.now() - started;
    this.cache.set(key, vector);
    this.schedulePersist();
    return vector;
  }

  schedulePersist() {
    if (!this.persistCache || this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      const entries = this.cache.entries().map(([k, v]) => [k, Array.from(v, (x) => Math.round(x * 1e4) / 1e4)]);
      this.persistCache(entries).catch((e) => console.warn('[GoalGuard] cache persist failed', e));
    }, 5000);
  }

  async unload() {
    if (this.model) await this.model.dispose();
    this.model = null;
    this.status = MODEL_STATUS.IDLE;
  }
}

/** Default loader for the extension runtime (uses moz-extension:// URLs). */
export function createExtensionLoader(runtime) {
  return () =>
    loadEmbeddingModel({
      transformersUrl: runtime.getURL('vendor/transformers.min.js'),
      modelsUrl: runtime.getURL('models/'),
      wasmUrl: runtime.getURL('vendor/ort/'),
    });
}
