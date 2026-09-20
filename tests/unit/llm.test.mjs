import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLlmPayload, buildMessages, payloadText, SYSTEM_PROMPT } from '../../src/llm/promptBuilder.js';
import { parseLlmResponse, extractJson } from '../../src/llm/responseParser.js';
import { LlmManager, LLM_STATUS } from '../../src/llm/llmManager.js';
import { LlmClassifier } from '../../src/llm/llmClassifier.js';
import { LocalLLM, OllamaAdapter, LlamaCppAdapter, assertLocal } from '../../src/llm/localLLM.js';
import { PersistentCache } from '../../src/storage/cacheStore.js';
import { DEFAULT_SETTINGS } from '../../src/storage/schema.js';

const good = '{"classification":"relevant","confidence":0.87,"reason":"Discusses distributed systems.","evidence":["distributed systems"]}';

// ---- prompt -------------------------------------------------------------------------------------

test('buildLlmPayload contains only goal, page, semantic numbers and trimmed web context', () => {
  const p = buildLlmPayload({
    goal: 'Study operating systems and C++',
    title: 'Building Better Systems',
    domain: 'example.com',
    semantic: { goalSimilarity: 0.5123, positiveSimilarity: 0.54, negativeSimilarity: 0.42 },
    webContext: Array.from({ length: 8 }, (_, i) => ({ title: `R${i}`, domain: 'd.com', snippet: 's', url: 'https://secret/url', relevance: 0.5 })),
  });
  assert.deepEqual(Object.keys(p), ['goal', 'page', 'semantic', 'webContext']);
  assert.equal(p.semantic.goalSimilarity, 0.51);
  assert.equal(p.webContext.length, 5);
  assert.deepEqual(Object.keys(p.webContext[0]), ['title', 'domain', 'snippet']);
  assert.ok(!JSON.stringify(p).includes('secret/url'));
  const msgs = buildMessages(p);
  assert.equal(msgs[0].content, SYSTEM_PROMPT);
  assert.match(SYSTEM_PROMPT, /Return ONLY valid JSON/);
  assert.match(SYSTEM_PROMPT, /Do not infer facts/);
  assert.ok(payloadText(p).includes('building better systems'));
});

// ---- response parsing ---------------------------------------------------------------------------

test('parseLlmResponse accepts valid JSON (also fenced / with prose / with <think>)', () => {
  assert.equal(parseLlmResponse(good).classification, 'relevant');
  assert.equal(parseLlmResponse('```json\n' + good + '\n```').confidence, 0.87);
  assert.equal(parseLlmResponse('Sure! Here it is: ' + good + ' Hope this helps.').reason, 'Discusses distributed systems.');
  assert.equal(parseLlmResponse('<think>hmm</think>' + good).classification, 'relevant');
  assert.equal(extractJson('{"a":"b}c","d":{"e":1}} trailing').a, 'b}c');
});

test('parseLlmResponse rejects invalid JSON, missing fields, bad classification and bad confidence', () => {
  assert.equal(parseLlmResponse('RELEVANT because reasons'), null);
  assert.equal(parseLlmResponse('{"classification":"relevant"}'), null);
  assert.equal(parseLlmResponse('{"confidence":0.5,"reason":"x"}'), null);
  assert.equal(parseLlmResponse('{"classification":"useful","confidence":0.5}'), null);
  assert.equal(parseLlmResponse('{"classification":"relevant","confidence":1.5}'), null);
  assert.equal(parseLlmResponse('{"classification":"relevant","confidence":"high"}'), null);
  assert.equal(parseLlmResponse('[1,2]'), null);
  assert.equal(parseLlmResponse(undefined), null);
});

test('parseLlmResponse drops evidence not present in the supplied context', () => {
  const ctx = 'goal: study os. title: episode 42. snippet: a podcast about cooking';
  const r = parseLlmResponse('{"classification":"relevant","confidence":0.9,"reason":"x","evidence":["cooking","linux kernel internals"]}', { contextText: ctx });
  assert.deepEqual(r.evidence, ['cooking']);
  assert.deepEqual(r.unsupportedEvidence, ['linux kernel internals']);
});

// ---- runtime adapters ---------------------------------------------------------------------------

test('adapters refuse non-local endpoints and speak their protocols', async () => {
  assert.throws(() => new OllamaAdapter({ endpoint: 'https://api.example.com' }), /must be local/);
  assert.throws(() => assertLocal('nonsense'), /Invalid/);
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => (url.includes('ollama') || url.includes('11434') ? { message: { content: good } } : { choices: [{ message: { content: good } }] }) }; };
  const ollama = new OllamaAdapter({ fetchImpl });
  assert.equal(await ollama.complete([{ role: 'user', content: 'hi' }]), good);
  assert.equal(calls[0].url, 'http://localhost:11434/api/chat');
  assert.equal(calls[0].body.format, 'json');
  const llama = new LlamaCppAdapter({ fetchImpl, endpoint: 'http://127.0.0.1:8080/' });
  assert.equal(await llama.complete([{ role: 'user', content: 'hi' }]), good);
  assert.equal(calls[1].url, 'http://127.0.0.1:8080/v1/chat/completions');
  assert.equal(ollama.modelVersion, 'ollama:qwen3:0.6b');
  await assert.rejects(new LocalLLM().complete([]), /not implemented/);
});

// ---- manager ------------------------------------------------------------------------------------

function fakeLlm(answer = good, { delay = 5, loadError = null } = {}) {
  let calls = 0;
  const manager = new LlmManager({
    loader: async () => {
      if (loadError) throw new Error(loadError);
      return { modelVersion: 'fake@1', complete: async () => { calls++; await new Promise((r) => setTimeout(r, delay)); return typeof answer === 'function' ? answer(calls) : answer; } };
    },
    timeoutMs: 100,
    idleUnloadMs: 0,
  });
  return { manager, calls: () => calls };
}

test('LlmManager loads lazily, dedupes identical prompts, times out, and cools down after load failure', async () => {
  const { manager, calls } = fakeLlm();
  assert.equal(manager.getStatus().status, LLM_STATUS.IDLE);
  const payload = { goal: 'g', page: { title: 't' } };
  const [a, b] = await Promise.all([manager.complete(payload), manager.complete(payload)]);
  assert.equal(calls(), 1);
  assert.equal(a.raw, good);
  assert.equal(b.raw, good);
  await manager.configure({ modelVersion: 'fake@2' });
  assert.equal(manager.modelVersion, 'fake@2');
  assert.equal(manager.model, null, 'reconfiguring drops the loaded model');
  assert.equal(manager.stats.dedupeHits, 1);

  const slow = fakeLlm(good, { delay: 500 });
  await assert.rejects(slow.manager.complete(payload), /timed out/);
  assert.equal(slow.manager.stats.timeouts, 1);

  const broken = fakeLlm(good, { loadError: 'no weights' });
  await assert.rejects(broken.manager.complete(payload), /no weights/);
  assert.equal(broken.manager.getStatus().status, LLM_STATUS.UNAVAILABLE);
  assert.equal(broken.manager.isAvailable(), false);
});

test('LlmManager unloads after idle period', async () => {
  const manager = new LlmManager({ loader: async () => ({ complete: async () => good, dispose: async () => {} }), idleUnloadMs: 20 });
  await manager.complete({ goal: 'g', page: { title: 't' } });
  assert.equal(manager.status, LLM_STATUS.READY);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(manager.status, LLM_STATUS.IDLE);
  assert.equal(manager.model, null);
});

// ---- classifier ---------------------------------------------------------------------------------

const settingsOn = { ...DEFAULT_SETTINGS, weeklyGoal: 'Study OS', llmEnabled: true };
const previous = { classification: 'questionable', score: 0.5, positiveSimilarity: 0.54, negativeSimilarity: 0.42, goalSimilarity: 0.5, nearestPositive: 'linux kernel', confident: false };
const base = { text: 'Building Better Systems', goal: 'Study OS', domain: 'example.com', previous };

test('LlmClassifier gates on settings/availability, returns structured verdict, caches per context', async () => {
  const { manager, calls } = fakeLlm();
  const c = new LlmClassifier({ llm: manager, cache: new PersistentCache('llm', { persist: false }) });
  assert.equal(await c.classify({ ...base, settings: { ...settingsOn, llmEnabled: false } }), null);
  assert.equal(await c.classify({ ...base, settings: settingsOn, goal: '' }), null);
  const r = await c.classify({ ...base, settings: settingsOn, search: { results: [{ title: 'Distributed systems talk', domain: 'infoq.com', snippet: 'distributed systems' }] } });
  assert.equal(r.classification, 'relevant');
  assert.equal(r.source, 'llm+search');
  assert.equal(r.confidence, 0.87);
  assert.equal(r.score, 0.5, 'embedding score preserved');
  assert.deepEqual(r.llm.evidence, ['distributed systems']);
  const again = await c.classify({ ...base, settings: settingsOn, search: { results: [{ title: 'Distributed systems talk', domain: 'infoq.com', snippet: 'distributed systems' }] } });
  assert.equal(again.llm.cached, true);
  assert.equal(calls(), 1);
  const noCtx = await c.classify({ ...base, settings: settingsOn });
  assert.equal(noCtx.source, 'llm');
  assert.equal(calls(), 2, 'different context → new judgment');
});

test('LlmClassifier: invalid JSON → null (not cached); runtime error → throws (pipeline skips it)', async () => {
  const { manager, calls } = fakeLlm((n) => (n === 1 ? 'I think it is relevant.' : good));
  const c = new LlmClassifier({ llm: manager, cache: new PersistentCache('llm', { persist: false }) });
  assert.equal(await c.classify({ ...base, settings: settingsOn }), null);
  assert.equal(c.getStats().invalidResponses, 1);
  const ok = await c.classify({ ...base, settings: settingsOn });
  assert.equal(ok.classification, 'relevant');
  assert.equal(calls(), 2);
  const broken = new LlmClassifier({ llm: fakeLlm(good, { loadError: 'oom' }).manager });
  await assert.rejects(broken.classify({ ...base, settings: settingsOn }), /oom/);
});

// ---- NLI judge (default in-browser runtime) ---------------------------------------------------

import { NliJudgeAdapter, runtimeModelVersion, NLI_MODEL_VERSION } from '../../src/llm/localLLM.js';

/** Fake entailment: high when premise mentions "kernel"/"operating", low when it mentions "gossip". */
const fakeEntail = async (premise) => (/kernel|operating|scheduling/i.test(premise) ? 0.9 : /gossip|celebrity|gaming/i.test(premise) ? 0.05 : 0.5);

test('NliJudgeAdapter maps entailment to strict verdict JSON with grounded evidence', async () => {
  const judge = new NliJudgeAdapter(fakeEntail);
  const msgs = (payload) => buildMessages(payload);
  const rel = parseLlmResponse(await judge.complete(msgs({ goal: 'Study OS', page: { title: 'Linus Torvalds Interview', domain: 'youtube.com' }, webContext: [{ title: 'Kernel dev talk', snippet: 'linux kernel scheduling' }, { title: 'Wiki', snippet: 'operating systems pioneer' }] })));
  assert.equal(rel.classification, 'relevant');
  assert.ok(rel.confidence >= 0.5, String(rel.confidence)); // (2·0.9 + 0.5)/3 = 0.77 entailment
  assert.deepEqual(rel.evidence, ['Kernel dev talk', 'Wiki']);

  const irr = parseLlmResponse(await judge.complete(msgs({ goal: 'Study OS', page: { title: 'Celebrity gossip roundup' } })));
  assert.equal(irr.classification, 'irrelevant');

  const unsure = parseLlmResponse(await judge.complete(msgs({ goal: 'Study OS', page: { title: 'Episode 42' } })));
  assert.equal(unsure.classification, 'questionable');
  assert.deepEqual(unsure.evidence, []);
  assert.equal(unsure.confidence, 0);

  assert.equal(parseLlmResponse(await judge.complete([{ role: 'system', content: 'x' }, { role: 'user', content: 'not json' }])).classification, 'questionable');
  assert.equal(judge.modelVersion, NLI_MODEL_VERSION);
});

test('runtimeModelVersion defaults to the NLI judge', () => {
  assert.equal(runtimeModelVersion({}), NLI_MODEL_VERSION);
  assert.equal(runtimeModelVersion({ llmRuntime: 'nli' }), NLI_MODEL_VERSION);
  assert.match(runtimeModelVersion({ llmRuntime: 'transformers' }), /Qwen/);
});

test('NLI judge through the classifier: web context outweighs an ambiguous title', async () => {
  const manager = new LlmManager({ loader: async () => new NliJudgeAdapter(fakeEntail), idleUnloadMs: 0 });
  const c = new LlmClassifier({ llm: manager, cache: new PersistentCache('llm', { persist: false }) });
  const r = await c.classify({ text: 'Episode 42', goal: 'Study OS', domain: 'pod.example', previous: { score: 0.5 }, settings: { ...DEFAULT_SETTINGS, llmEnabled: true }, search: { results: [{ title: 'Ep 42: the Linux kernel scheduler', snippet: 'operating systems podcast' }] } });
  assert.equal(r.classification, 'relevant');
  assert.equal(r.source, 'llm+search');
});
