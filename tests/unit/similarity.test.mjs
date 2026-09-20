import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, normalize, maxSimilarity, dot } from '../../src/classifier/similarity.js';

test('cosine similarity of identical vectors is 1', () => {
  const v = Float32Array.from([1, 2, 3]);
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-6);
});

test('cosine similarity of orthogonal vectors is 0', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
});

test('cosine similarity of opposite vectors is -1', () => {
  assert.ok(Math.abs(cosineSimilarity([1, 1], [-1, -1]) + 1) < 1e-9);
});

test('zero vectors yield 0 instead of NaN', () => {
  assert.equal(cosineSimilarity([0, 0], [1, 2]), 0);
});

test('length mismatch throws', () => {
  assert.throws(() => dot([1], [1, 2]));
});

test('normalize returns unit vector', () => {
  const n = normalize([3, 4]);
  assert.ok(Math.abs(n[0] - 0.6) < 1e-6 && Math.abs(n[1] - 0.8) < 1e-6);
});

test('maxSimilarity picks the closest candidate', () => {
  const r = maxSimilarity([1, 0], [[0, 1], [0.9, 0.1], [-1, 0]]);
  assert.equal(r.index, 1);
});

test('maxSimilarity with no candidates returns 0', () => {
  assert.deepEqual(maxSimilarity([1, 0], []), { similarity: 0, index: -1 });
});
