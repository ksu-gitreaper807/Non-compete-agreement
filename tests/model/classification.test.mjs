/**
 * Functional tests with the real bundled BGE-small model. These verify the pipeline works
 * end to end on a tiny fixture set; the thresholds are heuristics, not validated science.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadNodeModel } from '../helpers/nodeModel.mjs';
import { ModelManager } from '../../src/model/modelManager.js';
import { EmbeddingClassifier } from '../../src/classifier/embeddingClassifier.js';
import { RegexClassifier } from '../../src/classifier/regexClassifier.js';
import { ClassifierPipeline } from '../../src/classifier/classifier.js';
import { generateAnchors } from '../../src/classifier/anchors.js';
import { cosineSimilarity } from '../../src/classifier/similarity.js';
import { DEFAULT_SETTINGS } from '../../src/storage/schema.js';

// Goal taken from the product example. Note: with the shorter goal "Study operating systems"
// the interview title scores 0.44 (just under the default questionable threshold) — a good
// illustration that these thresholds are heuristics and should be calibrated per user.
const fixtures = [
  ['Study operating systems and C++', 'OSTEP Processes', 'relevant'],
  ['Study operating systems and C++', 'Linux Virtual Memory', 'relevant'],
  ['Study operating systems and C++', 'Gaming PC Review', 'irrelevant'],
  ['Study operating systems and C++', 'Linus Torvalds Interview', 'questionable'],
];

let manager;
let pipeline;

before(async () => {
  const model = await loadNodeModel();
  manager = new ModelManager({ loader: async () => model });
  pipeline = new ClassifierPipeline([
    new RegexClassifier(),
    new EmbeddingClassifier({ embed: (t) => manager.embed(t), isAvailable: () => true }),
  ]);
});

test('model produces normalised 384-d embeddings', async () => {
  const v = await manager.embed('Linux Virtual Memory Explained');
  assert.equal(v.length, 384);
  assert.ok(Math.abs(cosineSimilarity(v, v) - 1) < 1e-5);
  let n = 0;
  for (const x of v) n += x * x;
  assert.ok(Math.abs(Math.sqrt(n) - 1) < 1e-3);
});

test('semantically close titles are more similar than unrelated ones', async () => {
  const os = await manager.embed('operating systems');
  const vm = await manager.embed('Linux Virtual Memory Explained');
  const gaming = await manager.embed('Best Gaming PCs of 2026');
  assert.ok(cosineSimilarity(os, vm) > cosineSimilarity(os, gaming));
});

test('embedding cache avoids repeat inference', async () => {
  const before = manager.stats.inferences;
  await manager.embed('  linux virtual memory explained ');
  assert.equal(manager.stats.inferences, before);
});

for (const [goal, title, expected] of fixtures) {
  test(`"${title}" → ${expected}`, async () => {
    const ctx = { url: 'https://example.com/', domain: 'example.com', title, text: title, goal, settings: DEFAULT_SETTINGS, rules: { allow: [], block: [] }, anchors: generateAnchors(goal) };
    const result = await pipeline.classify(ctx);
    assert.equal(result.classification, expected, JSON.stringify(result));
  });
}
