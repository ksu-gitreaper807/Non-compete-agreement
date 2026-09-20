/**
 * Layer 4: local LLM judge over structured context (goal, page, similarity numbers, ranked web
 * snippets). Invoked by the DecisionPipeline only for pages the cheaper layers could not decide.
 *
 * Results are cached per (model, goal, title, domain, context-hash) so a page seen again does
 * not cost another generation. Any runtime/parse failure returns null; the caller keeps the
 * embedding verdict.
 */
import { Classifier, makeResult } from '../classifier/classifier.js';
import { buildLlmPayload, payloadText } from './promptBuilder.js';
import { parseLlmResponse } from './responseParser.js';
import { llmKey } from '../storage/cacheKeys.js';
import { PersistentCache } from '../storage/cacheStore.js';

export class LlmClassifier extends Classifier {
  /**
   * @param {{ llm: import('./llmManager.js').LlmManager, cache?: PersistentCache }} deps
   */
  constructor({ llm, cache = null }) {
    super();
    this.llm = llm;
    this.cache = cache ?? new PersistentCache('llm', { persist: false });
    this.stats = { judgments: 0, cacheHits: 0, invalidResponses: 0, failures: 0 };
  }

  get name() {
    return 'llm';
  }

  /**
   * @param {Object} context  ClassificationContext + `previous` (embedding result) + `search`
   *   (SearchManager output or null)
   */
  async classify(context) {
    const { settings, previous, text, goal, domain, search } = context;
    if (!settings?.llmEnabled) return null;
    if (!goal || !text) return null;
    if (this.llm.isAvailable && !this.llm.isAvailable()) return null;

    const webContext = search?.results ?? [];
    const payload = buildLlmPayload({
      goal,
      title: text,
      domain,
      semantic: previous ? { goalSimilarity: previous.goalSimilarity, positiveSimilarity: previous.positiveSimilarity, negativeSimilarity: previous.negativeSimilarity } : null,
      webContext,
    });
    const key = llmKey({ modelVersion: this.llm.modelVersion, goal, title: text, domain, contextVersion: contextVersion(webContext) });

    const { value: verdict, cached } = await this.cache.getOrCompute(key, () => this.judge(payload));
    if (!verdict) return null;
    if (cached) this.stats.cacheHits++;

    const source = webContext.length ? 'llm+search' : 'llm';
    return makeResult(verdict.classification, source, verdict.reason || `Local model answered ${verdict.classification}`, {
      score: previous?.score ?? null,
      positiveSimilarity: previous?.positiveSimilarity ?? null,
      negativeSimilarity: previous?.negativeSimilarity ?? null,
      goalSimilarity: previous?.goalSimilarity ?? null,
      nearestPositive: previous?.nearestPositive ?? null,
      nearestNegative: previous?.nearestNegative ?? null,
      confidence: verdict.confidence,
      llm: { ...verdict, model: this.llm.modelVersion, cached, latencyMs: cached ? 0 : verdict.latencyMs },
      confident: true,
    });
  }

  /** One generation + strict parse. Returns null (not cached) on invalid output. */
  async judge(payload) {
    let raw;
    let latencyMs = 0;
    try {
      ({ raw, latencyMs } = await this.llm.complete(payload));
    } catch (e) {
      this.stats.failures++;
      throw e;
    }
    this.stats.judgments++;
    const parsed = parseLlmResponse(raw, { contextText: payloadText(payload) });
    if (!parsed) {
      this.stats.invalidResponses++;
      return null;
    }
    return { ...parsed, latencyMs };
  }

  getStats() {
    return { ...this.stats, cacheSize: this.cache.size };
  }
}

/** Stable digest of the context the model saw, so new search results invalidate old verdicts. */
function contextVersion(webContext) {
  return webContext.map((r) => `${r.domain}|${r.title}`).join('\n');
}
