/**
 * Lazy single-instance lifecycle for the local LLM (mirrors ModelManager for embeddings), plus:
 *  - one in-flight completion per identical prompt (dedupe);
 *  - per-call timeout;
 *  - retry cool-down after a load failure;
 *  - optional idle unload: the LLM is heavier than BGE, so it is released after `idleUnloadMs`
 *    without a judgment (event-page termination releases it anyway).
 */
import { loadTransformersJsLLM, loadNliJudge, NLI_MODEL_VERSION } from './localLLM.js';
import { buildMessages } from './promptBuilder.js';
import { hashString } from '../utils/text.js';

export const LLM_STATUS = Object.freeze({ IDLE: 'idle', LOADING: 'loading', READY: 'ready', UNAVAILABLE: 'unavailable' });
const RETRY_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_IDLE_UNLOAD_MS = 10 * 60 * 1000;

export class LlmManager {
  /**
   * @param {Object} options
   * @param {(onProgress: Function) => Promise<import('./localLLM.js').LocalLLM>} options.loader
   * @param {string} [options.modelVersion]
   * @param {number} [options.timeoutMs]
   * @param {number} [options.idleUnloadMs]  0 disables idle unloading
   */
  constructor({ loader, modelVersion = NLI_MODEL_VERSION, timeoutMs = 30000, idleUnloadMs = DEFAULT_IDLE_UNLOAD_MS }) {
    this.loader = loader;
    this.modelVersion = modelVersion;
    this.timeoutMs = timeoutMs;
    this.idleUnloadMs = idleUnloadMs;
    this.status = LLM_STATUS.IDLE;
    this.error = null;
    this.progress = null;
    this.model = null;
    this.loadPromise = null;
    this.lastFailureAt = 0;
    this.loadTimeMs = null;
    this.idleTimer = null;
    this.inFlight = new Map();
    this.stats = { completions: 0, totalMs: 0, failures: 0, timeouts: 0, dedupeHits: 0 };
  }

  getStatus() {
    return {
      status: this.status,
      modelVersion: this.modelVersion,
      error: this.error,
      progress: this.progress,
      loadTimeMs: this.loadTimeMs,
      completions: this.stats.completions,
      averageMs: this.stats.completions ? Math.round(this.stats.totalMs / this.stats.completions) : null,
      failures: this.stats.failures,
      timeouts: this.stats.timeouts,
    };
  }

  /** Switch runtime/model identity (cache keys) and drop any loaded model. */
  async configure({ modelVersion }) {
    if (modelVersion && modelVersion !== this.modelVersion) {
      this.modelVersion = modelVersion;
      await this.unload();
      this.status = LLM_STATUS.IDLE;
      this.error = null;
    }
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
   * Run one completion for a structured payload; identical concurrent payloads share a call.
   * @param {import('./promptBuilder.js').LlmPayload} payload
   * @returns {Promise<{ raw: string, latencyMs: number }>}
   */
  async complete(payload) {
    const messages = buildMessages(payload);
    const key = hashString(JSON.stringify(messages));
    if (this.inFlight.has(key)) {
      this.stats.dedupeHits++;
      return this.inFlight.get(key);
    }
    const promise = (async () => {
      const model = await this.ensureLoaded();
      this.clearIdleTimer();
      const started = performance.now();
      try {
        const raw = await withTimeout(model.complete(messages), this.timeoutMs, 'LLM generation timed out');
        const latencyMs = performance.now() - started;
        this.stats.completions++;
        this.stats.totalMs += latencyMs;
        return { raw, latencyMs: Math.round(latencyMs) };
      } catch (e) {
        this.stats.failures++;
        if (/timed out/.test(String(e?.message))) this.stats.timeouts++;
        this.error = String(e?.message ?? e);
        throw e;
      } finally {
        this.scheduleIdleUnload();
      }
    })();
    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  scheduleIdleUnload() {
    this.clearIdleTimer();
    if (!this.idleUnloadMs || !this.model) return;
    this.idleTimer = setTimeout(() => this.unload().catch(() => {}), this.idleUnloadMs);
    this.idleTimer.unref?.();
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async unload() {
    this.clearIdleTimer();
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

/** In-extension loaders. `generative` selects the optional Qwen path; default is the NLI judge. */
export function createExtensionLlmLoader(runtime, { generative = false } = {}) {
  const load = generative ? loadTransformersJsLLM : loadNliJudge;
  return (onProgress) =>
    load({
      transformersUrl: runtime.getURL('vendor/transformers.min.js'),
      wasmUrl: runtime.getURL('vendor/ort/'),
      onProgress,
    });
}
