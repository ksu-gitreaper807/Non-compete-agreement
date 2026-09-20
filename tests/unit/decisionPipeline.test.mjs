import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DecisionPipeline } from '../../src/intelligence/decisionPipeline.js';
import { RegexClassifier } from '../../src/classifier/regexClassifier.js';
import { Classifier, makeResult } from '../../src/classifier/classifier.js';
import { LlmClassifier } from '../../src/llm/llmClassifier.js';
import { LlmManager } from '../../src/llm/llmManager.js';
import { SearchManager } from '../../src/search/searchManager.js';
import { MockSearchProvider } from '../../src/search/searchProvider.js';
import { RateLimiter } from '../../src/search/rateLimiter.js';
import { PersistentCache } from '../../src/storage/cacheStore.js';
import { DEFAULT_SETTINGS, DEFAULT_ANCHORS } from '../../src/storage/schema.js';

class StubEmbedding extends Classifier {
  constructor(map, { fail = false } = {}) { super(); this.map = map; this.fail = fail; this.calls = 0; }
  get name() { return 'embedding'; }
  async classify({ text }) {
    this.calls++;
    if (this.fail) throw new Error('embedding model unavailable');
    const spec = this.map[text];
    if (!spec) return makeResult('questionable', 'embedding', 'unsure', { score: 0.5, positiveSimilarity: 0.5, negativeSimilarity: 0.5, confident: false });
    return makeResult(spec.c, 'embedding', 'stub', { score: spec.s, positiveSimilarity: spec.s, negativeSimilarity: 0.3, confident: spec.c !== 'questionable' });
  }
}

const fixtures = {
  'building better systems': [
    { title: 'Building Better Systems — distributed systems talk', domain: 'infoq.com', snippet: 'distributed systems and software architecture' },
    { title: 'Building Better Systems', domain: 'youtube.com', snippet: 'software architecture video' },
  ],
};

function llmAnswering(fn) {
  return new LlmManager({ loader: async () => ({ complete: async (msgs) => fn(JSON.parse(msgs[1].content)) }), idleUnloadMs: 0 });
}

function make({ embeddingMap = {}, embeddingFail = false, llm = null, provider = new MockSearchProvider({ fixtures }), settings = {} } = {}) {
  const embedding = new StubEmbedding(embeddingMap, { fail: embeddingFail });
  const search = new SearchManager({ provider, cache: new PersistentCache('retrieval', { persist: false }), rateLimiter: new RateLimiter({ minIntervalMs: 0 }) });
  const llmClassifier = llm ? new LlmClassifier({ llm, cache: new PersistentCache('llm', { persist: false }) }) : null;
  const pipeline = new DecisionPipeline({ regex: new RegexClassifier(), embedding, search, llm: llmClassifier });
  const merged = { ...DEFAULT_SETTINGS, weeklyGoal: 'Study operating systems and C++', ...settings };
  const ctx = (title, domain = 'example.com', extra = {}) => ({ url: `https://${domain}/p`, domain, title, text: title, goal: merged.weeklyGoal, settings: merged, rules: { allow: [], block: [] }, anchors: { ...DEFAULT_ANCHORS, positive: ['operating systems'] }, ...extra });
  return { pipeline, embedding, search, provider, llmClassifier, ctx };
}

test('obviously relevant/irrelevant pages never reach search or LLM', async () => {
  const llm = llmAnswering(() => { throw new Error('should not be called'); });
  const { pipeline, provider, ctx } = make({ embeddingMap: { 'Best Gaming PCs of 2026': { c: 'irrelevant', s: 0.1 } }, llm, settings: { llmEnabled: true, searchEnabled: true, searchMode: 'uncertain' } });
  const rel = await pipeline.classify(ctx('Operating Systems: Three Easy Pieces'));
  assert.equal(rel.source, 'auto:allow');
  assert.equal(rel.sourceKind, 'regex');
  const irr = await pipeline.classify(ctx('Best Gaming PCs of 2026'));
  assert.equal(irr.classification, 'irrelevant');
  assert.equal(irr.sourceKind, 'embedding');
  assert.equal(irr.searchUsed, false);
  assert.equal(provider.calls.length, 0);
  assert.ok(typeof irr.timings.totalMs === 'number');
});

test('explicit user rules win over every AI layer', async () => {
  const llm = llmAnswering(() => JSON.stringify({ classification: 'irrelevant', confidence: 0.99, reason: 'x', evidence: [] }));
  const { pipeline, ctx } = make({ llm, settings: { llmEnabled: true, allowedDomains: ['stackoverflow.com'], blockedDomains: ['reddit.com'] } });
  const a = await pipeline.classify(ctx('Weird question', 'stackoverflow.com'));
  assert.equal(a.classification, 'relevant');
  assert.equal(a.sourceKind, 'explicit_rule');
  const b = await pipeline.classify(ctx('Operating systems study group', 'reddit.com'));
  assert.equal(b.classification, 'irrelevant');
  assert.equal(b.sourceKind, 'explicit_rule');
});

test('ambiguous title → search context → LLM → relevant with evidence', async () => {
  const seen = [];
  const llm = llmAnswering((payload) => { seen.push(payload); return JSON.stringify({ classification: 'relevant', confidence: 0.9, reason: 'Talks about distributed systems.', evidence: ['distributed systems'] }); });
  const { pipeline, provider, ctx } = make({ llm, settings: { llmEnabled: true, searchEnabled: true, searchMode: 'uncertain' } });
  const r = await pipeline.classify(ctx('Building Better Systems', 'medium.com'));
  assert.equal(r.classification, 'relevant');
  assert.equal(r.source, 'llm+search');
  assert.equal(r.sourceKind, 'local_llm');
  assert.equal(r.searchUsed, true);
  assert.equal(r.searchQuery, 'Building Better Systems');
  assert.ok(['medium', 'high'].includes(r.evidenceQuality));
  assert.equal(r.confidence, 0.9);
  assert.equal(r.semanticScore, 0.5);
  assert.deepEqual(seen[0].page, { title: 'Building Better Systems', domain: 'medium.com' });
  assert.ok(!('url' in seen[0].page));
  assert.equal(seen[0].webContext.length, 2);
  assert.equal(provider.calls[0], 'Building Better Systems');
  assert.ok(r.trace.some((t) => t.stage === 'search' && t.results === 2));
});

test('searchMode "ambiguous" only searches generic titles; "uncertain" searches every questionable page', async () => {
  const llm = llmAnswering(() => JSON.stringify({ classification: 'questionable', confidence: 0.5, reason: 'x', evidence: [] }));
  const amb = make({ llm, settings: { llmEnabled: true, searchEnabled: true, searchMode: 'ambiguous' } });
  await amb.pipeline.classify(amb.ctx('A fairly descriptive but undecidable title'));
  assert.equal(amb.provider.calls.length, 0);
  await amb.pipeline.classify(amb.ctx('Episode 42', 'pod.example'));
  assert.equal(amb.provider.calls.length, 1);
  assert.equal(amb.provider.calls[0], 'Episode 42 pod.example');
  const unc = make({ llm, settings: { llmEnabled: true, searchEnabled: true, searchMode: 'uncertain' } });
  await unc.pipeline.classify(unc.ctx('A fairly descriptive but undecidable title'));
  assert.equal(unc.provider.calls.length, 1);
});

test('anti-hallucination: confident LLM verdict without evidence is downgraded to questionable', async () => {
  const llm = llmAnswering(() => JSON.stringify({ classification: 'relevant', confidence: 0.95, reason: 'Probably about kernels.', evidence: ['kernel scheduling deep dive'] }));
  const { pipeline, ctx } = make({ llm, settings: { llmEnabled: true, searchEnabled: true, searchMode: 'uncertain' } });
  const r = await pipeline.classify(ctx('Episode 42', 'pod.example'));
  assert.equal(r.classification, 'questionable');
  assert.equal(r.downgraded, true);
  assert.equal(r.evidenceQuality, 'none');
  assert.match(r.reason, /downgraded/);
  assert.equal(r.llm.unsupportedEvidence.length, 1);
});

test('low LLM confidence is downgraded to questionable; threshold is configurable', async () => {
  const llm = llmAnswering(() => JSON.stringify({ classification: 'irrelevant', confidence: 0.55, reason: 'meh', evidence: [] }));
  const strict = make({ llm, settings: { llmEnabled: true } });
  assert.equal((await strict.pipeline.classify(strict.ctx('Some descriptive undecidable article title'))).classification, 'questionable');
  const lenient = make({ llm, settings: { llmEnabled: true, llmMinConfidence: 0.5 } });
  assert.equal((await lenient.pipeline.classify(lenient.ctx('Some descriptive undecidable article title'))).classification, 'irrelevant');
});

test('search failure → LLM runs without context; LLM failure → embedding verdict; both off → embedding', async () => {
  const failingProvider = new MockSearchProvider({ failUnknown: true });
  const llm = llmAnswering((p) => JSON.stringify({ classification: p.webContext ? 'relevant' : 'questionable', confidence: 0.7, reason: 'no context', evidence: [] }));
  const a = make({ llm, provider: failingProvider, settings: { llmEnabled: true, searchEnabled: true, searchMode: 'uncertain' } });
  const ra = await a.pipeline.classify(a.ctx('Building Better Systems'));
  assert.equal(ra.source, 'llm');
  assert.equal(ra.searchStatus, 'error');
  assert.equal(ra.classification, 'questionable');

  const brokenLlm = new LlmManager({ loader: async () => { throw new Error('no runtime'); }, idleUnloadMs: 0 });
  const b = make({ llm: brokenLlm, settings: { llmEnabled: true, searchEnabled: true, searchMode: 'uncertain' } });
  const rb = await b.pipeline.classify(b.ctx('Building Better Systems'));
  assert.equal(rb.source, 'embedding');
  assert.equal(rb.classification, 'questionable');
  assert.equal(rb.searchUsed, true);
  assert.ok(rb.trace.some((t) => t.stage === 'llm' && t.error));

  const c = make({ llm });
  const rc = await c.pipeline.classify(c.ctx('Building Better Systems'));
  assert.equal(rc.source, 'embedding');
  assert.equal(c.provider.calls.length, 0);
});

test('embedding failure → LLM can still judge; everything failing → unknown fallback', async () => {
  const llm = llmAnswering(() => JSON.stringify({ classification: 'irrelevant', confidence: 0.8, reason: 'x', evidence: [] }));
  const a = make({ embeddingFail: true, llm, settings: { llmEnabled: true } });
  const ra = await a.pipeline.classify(a.ctx('Some descriptive title about cooking'));
  assert.equal(ra.sourceKind, 'local_llm');
  assert.equal(ra.classification, 'irrelevant');
  const b = make({ embeddingFail: true });
  const rb = await b.pipeline.classify(b.ctx('Some descriptive title about cooking'));
  assert.equal(rb.classification, 'unknown');
  assert.equal(rb.sourceKind, 'fallback');
});

test('stale signal stops the pipeline before expensive stages', async () => {
  const llm = llmAnswering(() => { throw new Error('should not run'); });
  const { pipeline, provider, ctx } = make({ llm, settings: { llmEnabled: true, searchEnabled: true, searchMode: 'uncertain' } });
  const stages = [];
  const r = await pipeline.classify(ctx('Building Better Systems'), { signal: { stale: true }, onStage: (s) => stages.push(s) });
  assert.equal(r.stale, true);
  assert.equal(provider.calls.length, 0);
  assert.deepEqual(stages, []);
});

test('telemetry counts stages, sources and LLM/search usage locally', async () => {
  const llm = llmAnswering(() => JSON.stringify({ classification: 'relevant', confidence: 0.9, reason: 'x', evidence: ['distributed systems'] }));
  const { pipeline, ctx } = make({ llm, settings: { llmEnabled: true, searchEnabled: true, searchMode: 'uncertain' } });
  await pipeline.classify(ctx('Building Better Systems'));
  await pipeline.classify(ctx('Building Better Systems'));
  const t = pipeline.getTelemetry();
  assert.equal(t.counters.searches, 2);
  assert.equal(t.counters.searchCacheHits, 1);
  assert.equal(t.counters.llmCalls, 1);
  assert.equal(t.counters.llmCacheHits, 1);
  assert.equal(t.stages.total.count, 2);
  assert.equal(t.bySource['llm+search'], 2);
});
