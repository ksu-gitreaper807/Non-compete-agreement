/**
 * Layer 3: local LLM judge, optionally grounded with DuckDuckGo context.
 *
 * Runs only when the embedding layer produced an unconfident (QUESTIONABLE) result — the
 * pipeline passes it as `context.previous`. Retrieval and LLM are each opt-in via settings;
 * any failure returns null so the embedding verdict stands.
 */
import { Classifier, makeResult } from './classifier.js';

export class LLMClassifier extends Classifier {
  /**
   * @param {{ llm: import('../llm/llmManager.js').LlmManager, retriever?: { search: (title: string) => Promise<Object|null> } }} deps
   */
  constructor({ llm, retriever = null }) {
    super();
    this.llm = llm;
    this.retriever = retriever;
  }

  get name() {
    return 'llm';
  }

  async classify(context) {
    const { settings, previous, text, goal, domain } = context;
    if (!settings?.llmEnabled) return null;
    if (!previous || previous.confident !== false) return null;
    if (!goal || !text) return null;
    if (this.llm.isAvailable && !this.llm.isAvailable()) return null;

    let retrieval = null;
    if (settings.searchEnabled && this.retriever) {
      retrieval = await this.retriever.search(text).catch(() => null);
    }

    const verdict = await this.llm.judge({ goal, title: text, domain, previous, retrieval });
    if (!verdict) return null;

    const source = retrieval?.results?.length ? 'llm+search' : 'llm';
    return makeResult(verdict.classification, source, verdict.reason, {
      score: previous.score ?? null,
      positiveSimilarity: previous.positiveSimilarity ?? null,
      negativeSimilarity: previous.negativeSimilarity ?? null,
      goalSimilarity: previous.goalSimilarity ?? null,
      nearestPositive: previous.nearestPositive ?? null,
      nearestNegative: previous.nearestNegative ?? null,
      retrievalQuery: retrieval?.query ?? null,
      retrievalCount: retrieval?.results?.length ?? 0,
      llmModel: this.llm.modelVersion,
      confident: true,
    });
  }
}
