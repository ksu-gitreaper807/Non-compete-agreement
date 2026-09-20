import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMessages, parseVerdict } from '../../src/llm/prompt.js';
import { parseResultsHtml, buildQuery, DuckDuckGoRetriever } from '../../src/retrieval/duckduckgo.js';
import { LlmManager } from '../../src/llm/llmManager.js';
import { LLMClassifier } from '../../src/classifier/llmClassifier.js';
import { ClassifierPipeline, Classifier, makeResult } from '../../src/classifier/classifier.js';
import { PersistentCache } from '../../src/storage/cacheStore.js';
import { DEFAULT_SETTINGS } from '../../src/storage/schema.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleHtml = fs.readFileSync(path.join(here, '..', 'data', 'ddg-sample.html'), 'utf8');

test('parseVerdict extracts the verdict word and reason, ignores <think> blocks', () => {
  assert.deepEqual(parseVerdict('IRRELEVANT. This is celebrity gossip.'), { classification: 'irrelevant', reason: 'This is celebrity gossip.' });
  assert.equal(parseVerdict('<think>hmm relevant?</think>\nQUESTIONABLE — depends on the interview.').classification, 'questionable');
  assert.equal(parseVerdict('The page is relevant to the goal.').classification, 'relevant');
  assert.equal(parseVerdict('Not relevant at all').classification, 'irrelevant');
  assert.equal(parseVerdict('I cannot say.'), null);
  assert.equal(parseVerdict(undefined), null);
});

test('buildMessages includes goal, title, embedding hint and web context', () => {
  const msgs = buildMessages({ goal: 'Study OS', title: 'Linus Torvalds Interview', domain: 'youtube.com', previous: { nearestPositive: 'linux kernel', nearestNegative: 'gossip' }, retrieval: { results: [{ title: 'Wiki', snippet: 'Creator of Linux' }] } });
  assert.equal(msgs[0].role, 'system');
  const user = msgs[1].content;
  for (const needle of ['Goal: Study OS', 'Linus Torvalds Interview', 'youtube.com', 'linux kernel', 'Wiki: Creator of Linux']) assert.ok(user.includes(needle), needle);
});

test('DuckDuckGo HTML parser extracts title, domain and snippet from redirect links', () => {
  const results = parseResultsHtml(sampleHtml);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'Linus Torvalds - Wikipedia');
  assert.equal(results[0].domain, 'en.wikipedia.org');
  assert.match(results[0].snippet, /creator and lead developer of the Linux kernel/);
  assert.equal(results[1].title, 'Linus Torvalds interview: "Nvidia" & kernel dev');
  assert.equal(results[1].domain, 'youtube.com');
  assert.deepEqual(parseResultsHtml('<html>nothing</html>'), []);
});

test('buildQuery strips site suffixes and length-limits', () => {
  assert.equal(buildQuery('Linus Torvalds Interview - YouTube'), 'Linus Torvalds Interview');
  assert.ok(buildQuery('x'.repeat(500)).length <= 120);
});

function makeRetriever({ permission = true } = {}) {
  const calls = [];
  const fetchImpl = async (url) => { calls.push(url); return { ok: true, status: 200, text: async () => sampleHtml }; };
  const cache = new PersistentCache('retrieval', { persist: false });
  const r = new DuckDuckGoRetriever({ cache, fetchImpl, hasPermission: async () => permission });
  return { r, calls };
}

test('retriever caches results and sends only the query', async () => {
  const { r, calls } = makeRetriever();
  const a = await r.search('Linus Torvalds Interview - YouTube');
  const b = await r.search('linus torvalds interview');
  assert.equal(calls.length, 1, 'second search served from cache');
  assert.ok(calls[0].startsWith('https://html.duckduckgo.com/html/?q='));
  assert.ok(!calls[0].includes('youtube.com/watch'));
  assert.equal(a.results.length, 2);
  assert.equal(b.cached, true);
});

test('retriever deduplicates concurrent identical searches', async () => {
  const { r, calls } = makeRetriever();
  await Promise.all([r.search('same query'), r.search('same query')]);
  assert.equal(calls.length, 1);
});

test('retriever returns null without host permission or on network failure', async () => {
  const { r, calls } = makeRetriever({ permission: false });
  assert.equal(await r.search('anything'), null);
  assert.equal(calls.length, 0);
  const failing = new DuckDuckGoRetriever({ cache: new PersistentCache('retrieval', { persist: false }), fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await failing.search('anything'), null);
  assert.equal(failing.getStatus().lastError, 'offline');
});

function fakeLlm(answer = 'IRRELEVANT. Celebrity content.') {
  let chats = 0;
  const manager = new LlmManager({ loader: async () => ({ chat: async () => { chats++; await new Promise((r) => setTimeout(r, 5)); return typeof answer === 'function' ? answer() : answer; } }), modelVersion: 'fake-llm' });
  return { manager, chats: () => chats };
}

test('LlmManager loads lazily, judges, dedupes concurrent identical prompts', async () => {
  const { manager, chats } = fakeLlm();
  assert.equal(manager.getStatus().status, 'idle');
  const input = { goal: 'Study OS', title: 'Linus Torvalds Interview' };
  const [a, b] = await Promise.all([manager.judge(input), manager.judge(input)]);
  assert.equal(chats(), 1);
  assert.equal(a.classification, 'irrelevant');
  assert.equal(b.reason, 'Celebrity content.');
  assert.equal(manager.getStatus().status, 'ready');
  assert.equal(manager.stats.dedupeHits, 1);
});

test('LlmManager marks itself unavailable when loading fails', async () => {
  const manager = new LlmManager({ loader: async () => { throw new Error('no weights'); } });
  await assert.rejects(manager.judge({ goal: 'g', title: 't' }));
  assert.equal(manager.getStatus().status, 'unavailable');
  assert.equal(manager.isAvailable(), false);
});

const settingsOn = { ...DEFAULT_SETTINGS, weeklyGoal: 'Study OS', llmEnabled: true, searchEnabled: true };
const questionable = makeResult('questionable', 'embedding', 'meh', { score: 0.5, confident: false, nearestPositive: 'linux kernel', nearestNegative: 'gossip' });

test('LLMClassifier only runs for unconfident results and when enabled', async () => {
  const { manager, chats } = fakeLlm();
  const c = new LLMClassifier({ llm: manager });
  const base = { text: 'Linus Torvalds Interview', goal: 'Study OS', domain: 'youtube.com' };
  assert.equal(await c.classify({ ...base, settings: { ...settingsOn, llmEnabled: false }, previous: questionable }), null);
  assert.equal(await c.classify({ ...base, settings: settingsOn, previous: null }), null);
  assert.equal(await c.classify({ ...base, settings: settingsOn, previous: { ...questionable, confident: true } }), null);
  assert.equal(chats(), 0);
  const r = await c.classify({ ...base, settings: settingsOn, previous: questionable });
  assert.equal(r.classification, 'irrelevant');
  assert.equal(r.source, 'llm');
  assert.equal(r.score, 0.5, 'embedding score is preserved for transparency');
});

test('LLMClassifier uses retrieval when enabled and labels the source llm+search', async () => {
  const { manager } = fakeLlm('RELEVANT: it is about kernel development.');
  const { r: retriever, calls } = makeRetriever();
  const c = new LLMClassifier({ llm: manager, retriever });
  const r = await c.classify({ text: 'Linus Torvalds Interview', goal: 'Study OS', domain: 'youtube.com', settings: settingsOn, previous: questionable });
  assert.equal(r.source, 'llm+search');
  assert.equal(r.retrievalCount, 2);
  assert.equal(calls.length, 1);
  const noSearch = new LLMClassifier({ llm: manager, retriever });
  const r2 = await noSearch.classify({ text: 'Other title', goal: 'Study OS', settings: { ...settingsOn, searchEnabled: false }, previous: questionable });
  assert.equal(r2.source, 'llm');
  assert.equal(calls.length, 1, 'no search when disabled');
});

test('pipeline: embedding questionable → LLM final; LLM failure keeps embedding verdict', async () => {
  class Emb extends Classifier { get name() { return 'embedding'; } async classify() { return { ...questionable }; } }
  const { manager } = fakeLlm('QUESTIONABLE, could go either way');
  const ok = new ClassifierPipeline([new Emb(), new LLMClassifier({ llm: manager })]);
  const r = await ok.classify({ text: 't', goal: 'g', settings: settingsOn });
  assert.equal(r.source, 'llm');
  assert.equal(r.classification, 'questionable');
  const broken = new LlmManager({ loader: async () => ({ chat: async () => { throw new Error('oom'); } }) });
  const fallback = new ClassifierPipeline([new Emb(), new LLMClassifier({ llm: broken })]);
  const r2 = await fallback.classify({ text: 't', goal: 'g', settings: settingsOn });
  assert.equal(r2.source, 'embedding');
  assert.ok(r2.trace.some((t) => t.classifier === 'llm' && t.error));
});
