/**
 * Lazy single-instance lifecycle for the local LLM, mirroring ModelManager for embeddings.
 * Concurrent judgments for the same prompt share one in-flight generation.
 */
import { loadLlmModel, LLM_MODEL_VERSION } from './llmModel.js';
import { buildMessages, parseVerdict } from './prompt.js';
import { hashString } from '../utils/text.js';

export const LLM_STATUS = Object.freeze({ IDLE: 'idle', LOADING: 'loading', READY: 'ready', UNAVAILABLE: 'unavailable' });
const RETRY_COOLDOWN_MS = 10 * 60 * 1000;

export class LlmManager {
  /**
   * @param {{ loader: () => Promise<{chat: Function}>, modelVersion?: string, timeoutMs?: number }} options
   */
  constructor({ loader, modelVersion = LLM_MODEL_VERSION, timeoutMs = 20000 }) {
    this.loader = loader;
    this.modelVersion = modelVersion;
    this.timeoutMs = timeoutMs;
    this.status = LLM_STATUS.IDLE;
    this.error = null;
    this.progress = null;
    this.model = null;
    this.loadPromise = null;
    this.lastFailureAt = 0;
    this.loadTimeMs = null;
    this.inFlight = new Map();
    this.stats = { judgments: 0, totalMs: 0, failures: 0, dedupeHits: 0 };
  }

  getStatus() {
    return {
      status: this.status,
      modelVersion: this.modelVersion,
      error: this.error,
      progress: this.progress,
      loadTimeMs: this.loadTimeMs,
      judgments: this.stats.judgments,
      averageMs: this.stats.judgments ? Math.round(this.stats.totalMs / this.stats.judgments) : null,
      failures: this.stats.failures,
    };
  }

  isAvailable() {
    return this.status !== LLM_STATUS.UNAVAILABLE || Date.now() - this.lastFailureAt > RETRY_COOLDOWN_MS;
  }

  onProgress(p) {
    if (p?.status === 'progress' && typeof p.progress === 'number') this.progress = Math.round(p.progress);
  }

  async ensureLoaded() {
    if (this.model) return this.model;
    if (this.loadPromise) return this.loadPromise;
    if (!this.isAvailable()) throw new Error(`LLM unavailable: ${this.error}`);
    this.status = LLM_STATUS.LOADING;
    const started = Date.now();
    this.loadPromise = (async () => {
      try {
        this.model = await this.loader((p) => this.onProgress(p));
        this.status = LLM_STATUS.READY;
        this.error = null;
        this.loadTimeMs = Date.now() - started;
        return this.model;
      } catch (e) {
        this.status = LLM_STATUS.UNAVAILABLE;
        this.error = String(e?.message ?? e);
        this.lastFailureAt = Date.now();
        console.warn('[GoalGuard] LLM failed to load:', e);
        throw e;
      } finally {
        this.loadPromise = null;
      }
    })();
    return this.loadPromise;
  }

  /**
   * @returns {Promise<{ classification: string, reason: string, raw: string }|null>}
   */
  async judge(input) {
    const messages = buildMessages(input);
    const key = hashString(JSON.stringify(messages));
    if (this.inFlight.has(key)) {
      this.stats.dedupeHits++;
      return this.inFlight.get(key);
    }
    const promise = (async () => {
      const model = await this.ensureLoaded();
      const started = performance.now();
      try {
        const raw = await withTimeout(model.chat(messages), this.timeoutMs, 'LLM generation timed out');
        this.stats.judgments++;
        this.stats.totalMs += performance.now() - started;
        const verdict = parseVerdict(raw);
        return verdict ? { ...verdict, raw } : null;
      } catch (e) {
        this.stats.failures++;
        this.error = String(e?.message ?? e);
        throw e;
      }
    })();
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  async unload() {
    if (this.model) await this.model.dispose?.();
    this.model = null;
    this.status = LLM_STATUS.IDLE;
  }
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]);
}

export function createExtensionLlmLoader(runtime) {
  return (onProgress) =>
    loadLlmModel({
      transformersUrl: runtime.getURL('vendor/transformers.min.js'),
      wasmUrl: runtime.getURL('vendor/ort/'),
      onProgress,
    });
}
