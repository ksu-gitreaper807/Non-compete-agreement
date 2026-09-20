/**
 * Layer 2: local semantic embeddings (BGE-small-en-v1.5).
 *
 *   positiveSimilarity = max cosine(title, positiveAnchors ∪ {goal})
 *   negativeSimilarity = max cosine(title, negativeAnchors)
 *   rawScore           = positiveSimilarity - negativeSimilarity           (roughly [-0.4, 0.4])
 *   score              = 0.5 + rawScore * SCORE_GAIN, clamped to [0, 1]    (0.5 = tie)
 *
 * The rescaling is purely presentational; thresholds are applied to `score` and come from settings.
 */
import { Classifier, makeResult } from './classifier.js';
import { cosineSimilarity, maxSimilarity, clamp } from './similarity.js';
import { CLASSIFICATION } from '../storage/schema.js';

/** How strongly a positive/negative similarity gap moves the score away from 0.5. */
export const SCORE_GAIN = 2.5;

export function scoreFromSimilarities(positiveSimilarity, negativeSimilarity) {
  const raw = positiveSimilarity - negativeSimilarity;
  return clamp(0.5 + raw * SCORE_GAIN, 0, 1);
}

/** Pure threshold logic, separated from embedding computation for testability and calibration. */
export function classifyScore(score, { relevantThreshold, questionableThreshold }) {
  if (score >= relevantThreshold) return CLASSIFICATION.RELEVANT;
  if (score >= questionableThreshold) return CLASSIFICATION.QUESTIONABLE;
  return CLASSIFICATION.IRRELEVANT;
}

export class EmbeddingClassifier extends Classifier {
  /**
   * @param {{ embed: (text: string) => Promise<Float32Array>, isAvailable?: () => boolean }} model
   */
  constructor(model) {
    super();
    this.model = model;
    this.anchorCache = { key: null, positive: [], negative: [], goal: null, labels: { positive: [], negative: [] } };
  }

  get name() {
    return 'embedding';
  }

  async prepareAnchors(goal, anchors) {
    const positiveLabels = uniqueStrings([...(anchors?.positive ?? []), goal].filter(Boolean));
    const negativeLabels = uniqueStrings(anchors?.negative ?? []);
    const key = JSON.stringify([goal, positiveLabels, negativeLabels]);
    if (key === this.anchorCache.key) return this.anchorCache;
    const positive = [];
    for (const label of positiveLabels) positive.push(await this.model.embed(label));
    const negative = [];
    for (const label of negativeLabels) negative.push(await this.model.embed(label));
    const goalVec = goal ? await this.model.embed(goal) : null;
    this.anchorCache = { key, positive, negative, goal: goalVec, labels: { positive: positiveLabels, negative: negativeLabels } };
    return this.anchorCache;
  }

  async classify(context) {
    const { text, goal, anchors, settings } = context;
    if (!text || !goal) return null;
    if (this.model.isAvailable && !this.model.isAvailable()) return null;

    const prepared = await this.prepareAnchors(goal, anchors);
    if (prepared.positive.length === 0) return null;

    const vector = await this.model.embed(text);
    const pos = maxSimilarity(vector, prepared.positive);
    const neg = prepared.negative.length ? maxSimilarity(vector, prepared.negative) : { similarity: 0, index: -1 };
    const goalSimilarity = prepared.goal ? cosineSimilarity(vector, prepared.goal) : null;
    const score = scoreFromSimilarities(pos.similarity, neg.similarity);
    const classification = classifyScore(score, settings);

    return makeResult(classification, 'embedding', explain(classification, prepared.labels, pos, neg), {
      score: round(score),
      positiveSimilarity: round(pos.similarity),
      negativeSimilarity: round(neg.similarity),
      goalSimilarity: goalSimilarity === null ? null : round(goalSimilarity),
      nearestPositive: prepared.labels.positive[pos.index] ?? null,
      nearestNegative: prepared.labels.negative[neg.index] ?? null,
      confident: classification !== CLASSIFICATION.QUESTIONABLE,
    });
  }
}

function explain(classification, labels, pos, neg) {
  const p = labels.positive[pos.index] ?? 'goal';
  const n = labels.negative[neg.index];
  if (classification === CLASSIFICATION.RELEVANT) return `Semantically close to "${p}"`;
  if (classification === CLASSIFICATION.IRRELEVANT) return n ? `Closer to "${n}" than to your goal` : 'Far from your goal topics';
  return `Between "${p}" and ${n ? `"${n}"` : 'unrelated topics'}`;
}

function uniqueStrings(list) {
  return [...new Set(list.map((s) => String(s).trim()).filter(Boolean))];
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}
