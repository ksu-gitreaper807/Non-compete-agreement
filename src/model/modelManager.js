/**
 * Lazy, single-instance lifecycle for the embedding model plus an LRU embedding cache.
 *
 * Status transitions:  idle -> loading -> ready
 *                                     \-> unavailable (after failure; retried after a cool-down)
 */
import { loadEmbeddingModel, MODEL_ID } from './embeddingModel.js';
import { PersistentCache, float32Codec } from '../storage/cacheStore.js';
import { embeddingKey } from '../storage/cacheKeys.js';

/** Identifies the exact weights; part of every embedding cache key. */
export const MODEL_VERSION = `${MODEL_ID}-int8`;

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
   * @param {PersistentCache} [options.cache]   embedding cache (TTL + LRU, persistent)
   * @param {string} [options.modelVersion]
   */
  constructor({ loader, cache = null, modelVersion = MODEL_VERSION }) {
    this.loader = loader;
    this.status = MODEL_STATUS.IDLE;
    this.error = null;
    this.model = null;
    this.loadPromise = null;
    this.lastFailureAt = 0;
    this.loadTimeMs = null;
    this.stats = { inferences: 0, totalInferenceMs: 0, cacheHits: 0 };
    this.modelVersion = modelVersion;
    this.cache = cache ?? new PersistentCache('embedding', { persist: false, ...float32Codec });
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

  cacheKey(text) {
    return embeddingKey({ modelVersion: this.modelVersion, text });
  }

  /**
   * Embed with a persistent, model-versioned cache and in-flight deduplication.
   * Throws if the model cannot be loaded.
   */
  async embed(text) {
    const { value, cached } = await this.cache.getOrCompute(this.cacheKey(text), async () => {
      const model = await this.ensureLoaded();
      const started = performance.now();
      const vector = await model.embed(text);
      this.stats.inferences++;
      this.stats.totalInferenceMs += performance.now() - started;
      return vector;
    });
    if (cached) this.stats.cacheHits++;
    return value;
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
