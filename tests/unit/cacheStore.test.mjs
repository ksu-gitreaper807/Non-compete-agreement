import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PersistentCache, float32Codec, CACHE_SCHEMA_VERSION } from '../../src/storage/cacheStore.js';
import { classificationKey, embeddingKey, retrievalKey, classificationConfigFingerprint } from '../../src/storage/cacheKeys.js';
import { normalizeTitleForKey, stripTrackingParams } from '../../src/utils/text.js';
import { getValue } from '../../src/storage/storage.js';

// storage.js falls back to an in-process memory store when no browser API exists, which
// behaves like storage.local across "restarts" within this process.
function make(ns, opts = {}) {
  let now = 1_000_000;
  const logs = [];
  const cache = new PersistentCache(ns, { now: () => now, log: (l) => logs.push(l), ...opts });
  return { cache, logs, advance: (ms) => { now += ms; }, now: () => now };
}

test('cache keys are deterministic and normalise domain/title', () => {
  const a = classificationKey({ domain: 'YouTube.com', text: '  C++  Memory Management — Tutorial ', fingerprint: 'f' });
  const b = classificationKey({ domain: 'youtube.com', text: 'c++ memory management - tutorial', fingerprint: 'f' });
  assert.equal(a, b);
  assert.match(a, /^cls:v1:f:youtube\.com:c\+\+ memory management - tutorial$/);
  assert.notEqual(classificationKey({ domain: 'youtube.com', text: 'C++ tutorial', fingerprint: 'f' }), classificationKey({ domain: 'youtube.com', text: 'C tutorial', fingerprint: 'f' }));
  assert.notEqual(classificationKey({ domain: 'youtube.com', text: 'x', fingerprint: 'f' }), classificationKey({ domain: 'vimeo.com', text: 'x', fingerprint: 'f' }));
});

test('normalizeTitleForKey unifies unicode and edge punctuation only', () => {
  assert.equal(normalizeTitleForKey('“Ｃ＋＋” Tips…'), '"c++" tips');
  assert.equal(normalizeTitleForKey(' - Hello, World! - '), 'hello, world');
});

test('stripTrackingParams removes utm/fbclid but keeps content params', () => {
  assert.equal(stripTrackingParams('https://youtube.com/watch?v=abc&utm_source=x&si=123#t=1'), 'https://youtube.com/watch?v=abc');
});

test('embedding and retrieval keys are versioned', () => {
  assert.notEqual(embeddingKey({ modelVersion: 'bge-v1', text: 'x' }), embeddingKey({ modelVersion: 'bge-v2', text: 'x' }));
  assert.match(retrievalKey({ provider: 'ddg', query: 'C++  Tutorial' }), /^ret:v1:ddg:c\+\+ tutorial$/);
});

test('config fingerprint changes with goal, thresholds, rules, anchors and model', () => {
  const base = { settings: { weeklyGoal: 'a', relevantThreshold: 0.6, questionableThreshold: 0.4 }, rules: { allow: [], block: [] }, anchors: { positive: [], negative: [] }, modelVersion: 'm1' };
  const f = classificationConfigFingerprint(base);
  assert.equal(f, classificationConfigFingerprint(structuredClone(base)));
  assert.notEqual(f, classificationConfigFingerprint({ ...base, modelVersion: 'm2' }));
  assert.notEqual(f, classificationConfigFingerprint({ ...base, settings: { ...base.settings, relevantThreshold: 0.7 } }));
  assert.notEqual(f, classificationConfigFingerprint({ ...base, rules: { allow: ['x'], block: [] } }));
  assert.notEqual(f, classificationConfigFingerprint({ ...base, settings: { ...base.settings, llmEnabled: true } }));
});

test('hit / miss / expired', async () => {
  const { cache, advance, logs } = make('t1', { ttlMs: 1000, persist: false });
  assert.equal(await cache.get('k'), undefined);
  await cache.set('k', { v: 1 });
  assert.deepEqual(await cache.get('k'), { v: 1 });
  advance(1000);
  assert.equal(await cache.get('k'), undefined);
  assert.equal(cache.stats.expired, 1);
  assert.ok(logs.some((l) => l.includes('MISS')) && logs.some((l) => l.includes('HIT')) && logs.some((l) => l.includes('expired')));
});

test('LRU eviction keeps recently used entries', async () => {
  const { cache } = make('t2', { maxEntries: 2, persist: false });
  await cache.set('a', 1);
  await cache.set('b', 2);
  await cache.get('a');
  await cache.set('c', 3);
  assert.equal(await cache.get('b'), undefined);
  assert.equal(await cache.get('a'), 1);
  assert.equal(cache.stats.evicted, 1);
});

test('expired entries are dropped before LRU when over capacity', async () => {
  const { cache, advance } = make('t3', { maxEntries: 2, ttlMs: 500, persist: false });
  await cache.set('old', 1);
  advance(600);
  await cache.set('b', 2);
  await cache.set('c', 3);
  assert.equal(cache.size, 2);
  assert.equal(await cache.get('b'), 2);
});

test('persists and survives a restart (new instance, same storage)', async () => {
  const { cache } = make('persist1');
  await cache.set('k', { decision: 'irrelevant' });
  await cache.flush();
  const stored = await getValue('cache:persist1');
  assert.equal(stored.schemaVersion, CACHE_SCHEMA_VERSION);
  const { cache: reborn } = make('persist1');
  assert.deepEqual(await reborn.get('k'), { decision: 'irrelevant' });
});

test('schema version mismatch on disk is ignored', async () => {
  const { cache } = make('persist2');
  await cache.set('k', 1);
  await cache.flush();
  const { setValue } = await import('../../src/storage/storage.js');
  const stored = await getValue('cache:persist2');
  await setValue('cache:persist2', { ...stored, schemaVersion: 999 });
  const { cache: reborn } = make('persist2');
  assert.equal(await reborn.get('k'), undefined);
});

test('float32 codec round-trips embeddings compactly', async () => {
  const { cache } = make('emb1', float32Codec);
  await cache.set('e', Float32Array.from([0.123456, -1]));
  await cache.flush();
  const { cache: reborn } = make('emb1', float32Codec);
  const v = await reborn.get('e');
  assert.ok(v instanceof Float32Array);
  assert.ok(Math.abs(v[0] - 0.1235) < 1e-6);
});

test('getOrCompute deduplicates concurrent identical requests', async () => {
  const { cache } = make('dedupe', { persist: false });
  let calls = 0;
  const compute = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return 'v'; };
  const [a, b, c] = await Promise.all([cache.getOrCompute('k', compute), cache.getOrCompute('k', compute), cache.getOrCompute('k', compute)]);
  assert.equal(calls, 1);
  assert.equal(a.cached, false);
  assert.equal(b.deduplicated, true);
  assert.equal(c.value, 'v');
  assert.equal((await cache.getOrCompute('k', compute)).cached, true);
  assert.equal(calls, 1);
});

test('invalidatePrefix removes matching keys only', async () => {
  const { cache } = make('prefix', { persist: false });
  await cache.set('cls:v1:a', 1);
  await cache.set('cls:v1:b', 2);
  await cache.set('cls:v2:a', 3);
  assert.equal(await cache.invalidatePrefix('cls:v1:'), 2);
  assert.equal(cache.size, 1);
});
