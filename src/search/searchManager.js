/**
 * SearchManager: the only entry point the decision pipeline uses for web context.
 *
 *   title ──► queryBuilder ──► searchCache (hit?) ──► rateLimiter ──► provider ──► resultParser
 *
 * Guarantees:
 *  - never throws: every failure yields `{ status: 'error'|'rate-limited'|..., results: [] }`;
 *  - identical concurrent queries share one network request (cache in-flight map);
 *  - cached entries carry the original query and timestamp, are TTL-bounded and LRU-evicted;
 *  - results are normalised/ranked before being returned; raw provider output never leaks.
 */
import { retrievalKey } from '../storage/cacheKeys.js';
import { buildSearchQuery } from './queryBuilder.js';
import { normalizeResults, rankResults, assessEvidence, DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS } from './resultParser.js';
import { RateLimiter } from './rateLimiter.js';

export const SEARCH_STATUS = Object.freeze({
  OK: 'ok',
  CACHED: 'cached',
  EMPTY: 'empty',
  UNAVAILABLE: 'unavailable',
  RATE_LIMITED: 'rate-limited',
  TIMEOUT: 'timeout',
  ERROR: 'error',
  SKIPPED: 'skipped',
});

const DEFAULT_TIMEOUT_MS = 6000;

export class SearchManager {
  /**
   * @param {Object} deps
   * @param {import('./searchProvider.js').SearchProvider} deps.provider
   * @param {import('../storage/cacheStore.js').PersistentCache} deps.cache   retrieval namespace
   * @param {RateLimiter} [deps.rateLimiter]
   * @param {(text: string) => Promise<Float32Array>} [deps.embed]  optional reranker
   * @param {number} [deps.timeoutMs]
   * @param {() => number} [deps.now]
   */
  constructor({ provider, cache, rateLimiter = new RateLimiter(), embed = null, timeoutMs = DEFAULT_TIMEOUT_MS, now = () => Date.now() }) {
    this.provider = provider;
    this.cache = cache;
    this.rateLimiter = rateLimiter;
    this.embed = embed;
    this.timeoutMs = timeoutMs;
    this.now = now;
    this.lastError = null;
    this.stats = { requests: 0, cacheHits: 0, dedupeHits: 0, failures: 0, rateLimited: 0, totalLatencyMs: 0 };
  }

  get name() {
    return this.provider.name;
  }

  /**
   * @param {{ title: string, domain?: string }} page
   * @param {{ maxResults?: number, ttlMs?: number, rerank?: boolean }} [options]
   * @returns {Promise<{ status: string, query: string|null, results: Array, evidenceQuality: string, cached: boolean, latencyMs: number, usedDomain: boolean }>}
   */
  async search(page, { maxResults = DEFAULT_MAX_RESULTS, ttlMs, rerank = true } = {}) {
    const started = this.now();
    const built = buildSearchQuery(page);
    if (!built) return this.finish({ status: SEARCH_STATUS.SKIPPED, query: null, results: [], cached: false, usedDomain: false }, started);
    const { query, usedDomain } = built;
    const limit = Math.min(Math.max(1, Number(maxResults) || DEFAULT_MAX_RESULTS), HARD_MAX_RESULTS);
    const key = retrievalKey({ provider: this.provider.name, query });

    let entry;
    let cached = false;
    try {
      const outcome = await this.fetchThroughCache(key, query, ttlMs);
      entry = outcome.value;
      cached = outcome.cached;
      if (cached) this.stats.cacheHits++;
      if (outcome.deduplicated) this.stats.dedupeHits++;
    } catch (e) {
      this.stats.failures++;
      this.lastError = String(e?.message ?? e);
      return this.finish({ status: statusForError(e), query, results: [], cached: false, usedDomain, error: this.lastError }, started);
    }

    if (!entry) return this.finish({ status: SEARCH_STATUS.UNAVAILABLE, query, results: [], cached: false, usedDomain, error: this.lastError }, started);

    const ranked = rerank ? await rankResults(page.title, entry.results, { embed: this.embed, maxResults: limit }) : entry.results.slice(0, limit).map((r) => ({ ...r, relevance: null }));
    const evidenceQuality = assessEvidence(ranked, { usedEmbeddings: Boolean(this.embed) && rerank });
    const status = ranked.length ? (cached ? SEARCH_STATUS.CACHED : SEARCH_STATUS.OK) : SEARCH_STATUS.EMPTY;
    return this.finish({ status, query, results: ranked, cached, usedDomain, evidenceQuality, fetchedAt: entry.timestamp }, started);
  }

  /** Cache-aside with in-flight deduplication; the compute step applies the rate limiter. */
  async fetchThroughCache(key, query, ttlMs) {
    const { value, cached, deduplicated } = await this.cache.getOrCompute(
      key,
      async () => {
        if (!(await this.provider.isAvailable())) {
          this.lastError = 'search provider unavailable';
          return null;
        }
        const gate = this.rateLimiter.check();
        if (!gate.ok) {
          this.stats.rateLimited++;
          throw Object.assign(new Error(gate.reason), { code: SEARCH_STATUS.RATE_LIMITED });
        }
        this.rateLimiter.record();
        this.stats.requests++;
        const t0 = this.now();
        const raw = await withTimeout(this.provider.search(query, { maxResults: HARD_MAX_RESULTS }), this.timeoutMs);
        this.stats.totalLatencyMs += this.now() - t0;
        this.lastError = null;
        // Only structured fields are persisted; capped at the hard maximum.
        return { query, timestamp: this.now(), results: normalizeResults(raw, HARD_MAX_RESULTS) };
      },
      { ttlMs }
    );
    return { value: value ?? null, cached: Boolean(cached), deduplicated: Boolean(deduplicated) };
  }

  finish(out, started) {
    return { evidenceQuality: 'none', ...out, latencyMs: Math.max(0, this.now() - started) };
  }

  getStatus() {
    return {
      provider: this.provider.name,
      ...this.stats,
      averageLatencyMs: this.stats.requests ? Math.round(this.stats.totalLatencyMs / this.stats.requests) : null,
      lastError: this.lastError,
      rateLimiter: this.rateLimiter.getStats(),
    };
  }
}

function statusForError(e) {
  if (e?.code === SEARCH_STATUS.RATE_LIMITED) return SEARCH_STATUS.RATE_LIMITED;
  if (e?.name === 'AbortError' || /timed? ?out/i.test(String(e?.message))) return SEARCH_STATUS.TIMEOUT;
  return SEARCH_STATUS.ERROR;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('search timed out')), ms); }),
  ]);
}
