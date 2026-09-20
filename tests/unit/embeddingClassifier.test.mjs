import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingClassifier, classifyScore, scoreFromSimilarities } from '../../src/classifier/embeddingClassifier.js';
import { DEFAULT_SETTINGS } from '../../src/storage/schema.js';

/** Deterministic fake embedder: maps known phrases to fixed directions. */
const fakeVectors = {
  'operating systems': [1, 0, 0],
  gaming: [0, 1, 0],
  'os lecture': [0.9, 0.1, 0],
  'gaming pc': [0.1, 0.9, 0],
  'linus torvalds': [0.5, 0.48, 0.3],
};
const fakeModel = {
  embed: async (text) => Float32Array.from(fakeVectors[text.toLowerCase()] ?? [0, 0, 1]),
  isAvailable: () => true,
};

const settings = { ...DEFAULT_SETTINGS, relevantThreshold: 0.65, questionableThreshold: 0.45 };
const anchors = { positive: ['operating systems'], negative: ['gaming'] };

test('threshold logic is pure and configurable', () => {
  assert.equal(classifyScore(0.7, settings), 'relevant');
  assert.equal(classifyScore(0.5, settings), 'questionable');
  assert.equal(classifyScore(0.2, settings), 'irrelevant');
  assert.equal(classifyScore(0.5, { relevantThreshold: 0.5, questionableThreshold: 0.3 }), 'relevant');
});

test('score is 0.5 at a tie and clamped', () => {
  assert.equal(scoreFromSimilarities(0.5, 0.5), 0.5);
  assert.equal(scoreFromSimilarities(1, 0), 1);
  assert.equal(scoreFromSimilarities(0, 1), 0);
});

test('classifies against positive and negative anchors', async () => {
  const c = new EmbeddingClassifier(fakeModel);
  const ctx = { goal: 'operating systems', anchors, settings };
  const rel = await c.classify({ ...ctx, text: 'OS lecture' });
  assert.equal(rel.classification, 'relevant');
  assert.ok(rel.positiveSimilarity > rel.negativeSimilarity);
  const irr = await c.classify({ ...ctx, text: 'Gaming PC' });
  assert.equal(irr.classification, 'irrelevant');
  const q = await c.classify({ ...ctx, text: 'Linus Torvalds' });
  assert.equal(q.classification, 'questionable');
  assert.equal(q.confident, false);
});

test('returns null when model unavailable or input empty', async () => {
  const c = new EmbeddingClassifier({ ...fakeModel, isAvailable: () => false });
  assert.equal(await c.classify({ text: 'x', goal: 'g', anchors, settings }), null);
  const c2 = new EmbeddingClassifier(fakeModel);
  assert.equal(await c2.classify({ text: '', goal: 'g', anchors, settings }), null);
});

test('anchor embeddings are cached across calls', async () => {
  let calls = 0;
  const counting = { embed: async (t) => { calls++; return fakeModel.embed(t); } };
  const c = new EmbeddingClassifier(counting);
  const ctx = { goal: 'operating systems', anchors, settings };
  await c.classify({ ...ctx, text: 'OS lecture' });
  const after = calls;
  await c.classify({ ...ctx, text: 'Gaming PC' });
  assert.equal(calls, after + 1);
});

test('ModelManager uses a model-versioned embedding cache and dedupes', async () => {
  const { ModelManager } = await import('../../src/model/modelManager.js');
  let calls = 0;
  const loader = async () => ({ embed: async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return Float32Array.from([1, 0, 0]); } });
  const m1 = new ModelManager({ loader, modelVersion: 'v1' });
  await Promise.all([m1.embed('Hello World'), m1.embed('hello   world')]);
  assert.equal(calls, 1);
  await m1.embed('Hello World');
  assert.equal(m1.stats.cacheHits, 1);
  assert.match(m1.cacheKey('x'), /^emb:v1:v1:/);
  assert.notEqual(m1.cacheKey('x'), new ModelManager({ loader, modelVersion: 'v2' }).cacheKey('x'));
});
