/**
 * Common classifier interface. Every layer (regex, embedding, and a future local LLM)
 * implements `classify(context)` and returns a ClassificationResult or `null` when it
 * cannot make a decision, letting the pipeline fall through to the next layer.
 *
 * @typedef {Object} ClassificationContext
 * @property {string} url
 * @property {string} domain
 * @property {string} title           normalised page title
 * @property {string} text            text to classify (title or URL-derived words)
 * @property {string} goal            weekly goal
 * @property {Object} settings
 * @property {Object} rules
 * @property {Object} anchors
 *
 * @typedef {Object} ClassificationResult
 * @property {string} classification  relevant | questionable | irrelevant | unknown
 * @property {number|null} score      normalised relevance score in [0,1] when available
 * @property {number|null} positiveSimilarity
 * @property {number|null} negativeSimilarity
 * @property {number|null} goalSimilarity
 * @property {string} source          which layer decided (rule:block, rule:allow, embedding, ...)
 * @property {string} reason          human-readable explanation
 * @property {boolean} [confident]    false when the layer suggests escalation to a later layer
 */

export class Classifier {
  /** @returns {string} */
  get name() {
    return 'base';
  }

  /**
   * @param {ClassificationContext} context
   * @returns {Promise<ClassificationResult|null>}
   */
  // eslint-disable-next-line no-unused-vars
  async classify(context) {
    throw new Error('classify() not implemented');
  }
}

export function makeResult(classification, source, reason, extra = {}) {
  return {
    classification,
    score: null,
    positiveSimilarity: null,
    negativeSimilarity: null,
    goalSimilarity: null,
    source,
    reason,
    confident: true,
    ...extra,
  };
}

/**
 * Runs classifiers in order and returns the first non-null result. Any classifier that
 * throws is skipped so a failing model can never break browsing.
 */
export class ClassifierPipeline {
  constructor(classifiers, { fallback } = {}) {
    this.classifiers = classifiers;
    this.fallback = fallback ?? (() => makeResult('unknown', 'fallback', 'No classifier produced a result'));
  }

  async classify(context) {
    const trace = [];
    let tentative = null; // an unconfident result that later layers may refine
    for (const classifier of this.classifiers) {
      try {
        const result = await classifier.classify({ ...context, previous: tentative });
        if (!result) {
          trace.push({ classifier: classifier.name, decided: false });
          continue;
        }
        if (result.confident === false) {
          trace.push({ classifier: classifier.name, decided: true, tentative: true });
          tentative = result;
          continue;
        }
        trace.push({ classifier: classifier.name, decided: true });
        return { ...result, trace };
      } catch (e) {
        trace.push({ classifier: classifier.name, error: String(e?.message ?? e) });
      }
    }
    if (tentative) return { ...tentative, trace };
    return { ...this.fallback(context), trace };
  }
}
