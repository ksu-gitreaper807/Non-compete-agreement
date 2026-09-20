import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../../src/background/controller.js';
import { FrictionManager } from '../../src/blocking/frictionManager.js';
import { RegexClassifier } from '../../src/classifier/regexClassifier.js';
import { Classifier, makeResult } from '../../src/classifier/classifier.js';
import { DEFAULT_SETTINGS, DEFAULT_ANCHORS } from '../../src/storage/schema.js';
import { DecisionPipeline } from '../../src/intelligence/decisionPipeline.js';

class StubSemantic extends Classifier {
  constructor(map) { super(); this.map = map; }
  get name() { return 'stub'; }
  async classify({ text }) {
    const c = this.map[text];
    return c ? makeResult(c, 'embedding', 'stub', { score: c === 'relevant' ? 0.8 : c === 'questionable' ? 0.5 : 0.2 }) : null;
  }
}
class FailingClassifier extends Classifier {
  get name() { return 'failing'; }
  async classify() { throw new Error('model exploded'); }
}
/** Embedding stage that first explodes (like an unloadable model) and then delegates. */
class FlakyThen extends Classifier {
  constructor(inner) { super(); this.inner = inner; this.failed = false; }
  get name() { return 'embedding'; }
  async classify(ctx) {
    if (!this.failed) { this.failed = true; throw new Error('model exploded'); }
    return this.inner.classify(ctx);
  }
}

function make({ semantic, settings = {}, pipelineDeps = {} } = {}) {
  let now = 1_000_000;
  const navigations = [];
  const sessionCalls = [];
  const friction = new FrictionManager({ load: async () => null, save: async () => {}, now: () => now });
  const sessions = { start: async (s) => sessionCalls.push(['start', s]), stop: async () => sessionCalls.push(['stop']) };
  const controller = new Controller({
    pipeline: new DecisionPipeline({ regex: new RegexClassifier(), embedding: semantic ?? new StubSemantic({}), ...pipelineDeps }),
    friction,
    sessions,
    loadConfig: async () => ({ settings: { ...DEFAULT_SETTINGS, weeklyGoal: 'Study operating systems and C++', ...settings }, rules: { allow: [], block: [] }, anchors: { ...DEFAULT_ANCHORS } }),
    navigate: async (tabId, url) => navigations.push([tabId, url]),
    blockedPageUrl: (p) => `moz-extension://x/blocking/blocked.html?domain=${p.domain}`,
    isBlockedPage: (url) => url.startsWith('moz-extension://x/blocking/'),
  });
  return { controller, navigations, sessionCalls, friction, advance: (ms) => { now += ms; } };
}

test('relevant page is allowed and tracked; classifier errors are skipped', async () => {
  const { controller, navigations, sessionCalls } = make();
  const out = await controller.handleActiveTab({ id: 1, url: 'https://pages.cs.wisc.edu/~remzi/OSTEP/', title: 'Operating Systems: Three Easy Pieces' });
  assert.equal(out.classification, 'relevant');
  assert.equal(out.decision, 'allow');
  assert.equal(navigations.length, 0);
  assert.equal(sessionCalls.at(-1)[0], 'start');
  assert.equal(out.source, 'auto:allow');
  // A title without goal terms reaches a failing embedding stage, which is skipped gracefully.
  const failing = make({ semantic: new FailingClassifier() });
  const out2 = await failing.controller.handleActiveTab({ id: 11, url: 'https://example.org/x', title: 'Something else entirely' });
  assert.ok(out2.trace.some((t) => t.stage === 'embedding' && t.error));
  assert.equal(out2.decision, 'allow');
  assert.equal(out2.sourceKind, 'fallback');
});

test('irrelevant page redirects to friction page and starts a countdown', async () => {
  const semantic = new StubSemantic({ 'Best Gaming PCs of 2026': 'irrelevant' });
  const { controller, navigations, friction } = make({ semantic });
  const out = await controller.handleActiveTab({ id: 2, url: 'https://pcmag.com/gaming', title: 'Best Gaming PCs of 2026' });
  assert.equal(out.decision, 'block');
  assert.equal(out.frictionState, 'COUNTING_DOWN');
  assert.equal(navigations.length, 1);
  assert.match(navigations[0][1], /blocked\.html/);
  assert.equal((await friction.getState({ tabId: 2, domain: 'pcmag.com' })).state, 'COUNTING_DOWN');
});

test('after Continue the page is allowed until the grant expires', async () => {
  const semantic = new StubSemantic({ 'Best Gaming PCs of 2026': 'irrelevant' });
  const { controller, navigations, advance, sessionCalls } = make({ semantic, settings: { frictionSeconds: 10, overrideMinutes: 5 } });
  const tab = { id: 3, url: 'https://pcmag.com/gaming', title: 'Best Gaming PCs of 2026' };
  await controller.handleActiveTab(tab);
  let r = await controller.continueFromFriction({ domain: 'pcmag.com', url: tab.url, tabId: 3 });
  assert.equal(r.ok, false);
  advance(10_000);
  r = await controller.continueFromFriction({ domain: 'pcmag.com', url: tab.url, tabId: 3 });
  assert.equal(r.ok, true);
  assert.equal(navigations.at(-1)[1], tab.url);
  const out = await controller.handleActiveTab(tab);
  assert.equal(out.frictionState, 'TEMPORARILY_ALLOWED');
  const lastStart = sessionCalls.filter((c) => c[0] === 'start').at(-1)[1];
  assert.equal(lastStart.classification, 'irrelevant');
  assert.equal(lastStart.overridden, true);
  advance(5 * 60_000);
  await controller.onGrantExpired('pcmag.com');
  const again = await controller.handleActiveTab(tab);
  assert.equal(again.frictionState, 'COUNTING_DOWN');
});

test('unknown classification (no signal) is allowed by default', async () => {
  const { controller, navigations } = make();
  const out = await controller.handleActiveTab({ id: 4, url: 'https://random.site/x', title: 'Zebra quantum pancake' });
  assert.equal(out.classification, 'unknown');
  assert.equal(out.decision, 'allow');
  assert.equal(navigations.length, 0);
});

test('questionable pages get short friction by default and none when configured', async () => {
  const semantic = new StubSemantic({ 'Linus Torvalds Interview': 'questionable' });
  let ctx = make({ semantic });
  let out = await ctx.controller.handleActiveTab({ id: 5, url: 'https://news.site/a', title: 'Linus Torvalds Interview' });
  assert.equal(out.decision, 'warn');
  assert.equal(out.frictionSeconds, DEFAULT_SETTINGS.questionableFrictionSeconds);
  assert.equal(ctx.navigations.length, 1);
  ctx = make({ semantic, settings: { questionableFrictionMode: 'none' } });
  out = await ctx.controller.handleActiveTab({ id: 6, url: 'https://news.site/a', title: 'Linus Torvalds Interview' });
  assert.equal(ctx.navigations.length, 0);
});

test('unsupported URLs and the friction page itself are ignored', async () => {
  const { controller, navigations } = make();
  assert.equal((await controller.handleActiveTab({ id: 7, url: 'about:blank', title: '' })).ignored, true);
  assert.equal((await controller.handleActiveTab({ id: 8, url: 'moz-extension://x/blocking/blocked.html?domain=a', title: 'Take a pause' })).ignored, true);
  assert.equal(navigations.length, 0);
});

test('missing goal yields unknown without touching the model', async () => {
  const { controller } = make({ settings: { weeklyGoal: '' } });
  const out = await controller.classifyPage({ url: 'https://a.com', title: 'anything' });
  assert.equal(out.source, 'no-goal');
});

test('classification results are cached per domain+text', async () => {
  let calls = 0;
  class Counting extends Classifier { get name() { return 'c'; } async classify() { calls++; return makeResult('irrelevant', 'embedding', 'x', { score: 0.1 }); } }
  const { controller } = make({ semantic: new Counting() });
  await controller.classifyPage({ url: 'https://a.com/1', title: 'Foo bar' });
  const second = await controller.classifyPage({ url: 'https://a.com/2', title: 'Foo bar' });
  assert.equal(calls, 1);
  assert.equal(second.cached, true);
});

test('unconfident embedding results are passed to the LLM stage as context.previous', async () => {
  class Tentative extends Classifier { get name() { return 'embedding'; } async classify() { return makeResult('questionable', 'embedding', 'meh', { score: 0.5, confident: false }); } }
  class Refiner extends Classifier { get name() { return 'llm'; } async classify(ctx) { return ctx.previous ? makeResult('relevant', 'llm', `refined ${ctx.previous.classification}`, { confidence: 0.9 }) : null; } }
  const withRefiner = new DecisionPipeline({ regex: new RegexClassifier(), embedding: new Tentative(), llm: new Refiner() });
  const ctx = { text: 'Linus Torvalds kernel interview', title: 'Linus Torvalds kernel interview', url: 'https://a.com/', goal: 'g', rules: {}, anchors: {} };
  const r1 = await withRefiner.classify({ ...ctx, settings: { ...DEFAULT_SETTINGS, llmEnabled: true } });
  assert.equal(r1.classification, 'relevant');
  assert.equal(r1.source, 'llm');
  assert.equal(r1.sourceKind, 'local_llm');
  // A generic title with no web evidence cannot be promoted to a definite verdict.
  const generic = await withRefiner.classify({ ...ctx, text: 'Episode 42', title: 'Episode 42', settings: { ...DEFAULT_SETTINGS, llmEnabled: true } });
  assert.equal(generic.classification, 'questionable');
  assert.equal(generic.downgraded, true);
  assert.equal(generic.evidenceQuality, 'none');
  const without = new DecisionPipeline({ regex: new RegexClassifier(), embedding: new Tentative() });
  const r2 = await without.classify({ ...ctx, settings: DEFAULT_SETTINGS });
  assert.equal(r2.classification, 'questionable');
  assert.equal(r2.sourceKind, 'embedding');
});

test('stale results are discarded when the tab navigates during classification', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  class Slow extends Classifier {
    get name() { return 'embedding'; }
    async classify({ text }) {
      if (text === 'Slow page') { await gate; return makeResult('irrelevant', 'embedding', 'slow', { score: 0.1 }); }
      return makeResult('relevant', 'embedding', 'fast', { score: 0.9 });
    }
  }
  const { controller, navigations } = make({ semantic: new Slow() });
  const first = controller.handleActiveTab({ id: 5, url: 'https://a.com/slow', title: 'Slow page' });
  await new Promise((r) => setTimeout(r, 5));
  const second = await controller.handleActiveTab({ id: 5, url: 'https://a.com/fast', title: 'Fast page' });
  assert.equal(second.classification, 'relevant');
  release();
  const stale = await first;
  assert.equal(stale.ignored, true);
  assert.equal(stale.reason, 'stale');
  assert.equal(navigations.length, 0, 'the stale irrelevant verdict must not redirect the tab');
  assert.equal(controller.getTabResult(5).classification, 'relevant');
});

test('feedback is stored locally without the URL and evicts the cached decision', async () => {
  const saved = [];
  const semantic = new StubSemantic({ 'Episode 42': 'irrelevant' });
  const { controller } = make({ semantic });
  controller.deps.saveFeedback = async (e) => saved.push(e);
  await controller.classifyPage({ url: 'https://pod.example/ep/42?utm_source=x', title: 'Episode 42' });
  const entry = await controller.recordFeedback({ domain: 'pod.example', title: 'Episode 42', prediction: 'irrelevant', userLabel: 'relevant', source: 'embedding' });
  assert.equal(saved.length, 1);
  assert.equal(entry.userLabel, 'relevant');
  assert.ok(!JSON.stringify(entry).includes('utm_source'));
  const again = await controller.classifyPage({ url: 'https://pod.example/ep/42', title: 'Episode 42' });
  assert.notEqual(again.cached, true);
});


test('switching tabs during a countdown resets it; return gives a full timer', async () => {
  const semantic = new StubSemantic({ 'Best Gaming PCs of 2026': 'irrelevant' });
  const { controller, friction, advance } = make({ semantic, settings: { frictionSeconds: 10 } });
  const tab = { id: 20, url: 'https://pcmag.com/gaming', title: 'Best Gaming PCs of 2026' };
  await controller.onActiveTabChanged(20);
  await controller.handleActiveTab(tab);
  advance(6_000);
  assert.equal((await friction.getState({ tabId: 20, domain: 'pcmag.com' })).remainingMs, 4_000);
  await controller.onActiveTabChanged(21); // user switches away
  assert.equal((await friction.getState({ tabId: 20, domain: 'pcmag.com' })).state, 'BLOCKED');
  // While tab 20 is not active, its friction page cannot restart the timer.
  const bg = await controller.getFrictionView({ domain: 'pcmag.com', url: tab.url, classification: 'irrelevant', decision: 'block', tabId: 20 });
  assert.equal(bg.state, 'BLOCKED');
  assert.equal(bg.inactive, true);
  await controller.onActiveTabChanged(20); // user returns
  const view = await controller.getFrictionView({ domain: 'pcmag.com', url: tab.url, classification: 'irrelevant', decision: 'block', tabId: 20 });
  assert.equal(view.state, 'COUNTING_DOWN');
  assert.equal(view.remainingMs, 10_000);
});

test('classification cache hit still triggers friction', async () => {
  const semantic = new StubSemantic({ 'Best Gaming PCs of 2026': 'irrelevant' });
  const { controller, navigations } = make({ semantic });
  await controller.handleActiveTab({ id: 30, url: 'https://pcmag.com/a', title: 'Best Gaming PCs of 2026' });
  const second = await controller.handleActiveTab({ id: 31, url: 'https://pcmag.com/b', title: 'Best Gaming PCs of 2026' });
  assert.equal(second.cached, true);
  assert.equal(second.frictionState, 'COUNTING_DOWN');
  assert.equal(navigations.length, 2);
});

test('classification cache hit on a relevant page causes no friction', async () => {
  const { controller, navigations } = make();
  await controller.handleActiveTab({ id: 40, url: 'https://a.com/1', title: 'Operating Systems lecture' });
  const second = await controller.handleActiveTab({ id: 41, url: 'https://b.com/2', title: 'Operating Systems lecture' });
  assert.equal(second.decision, 'allow');
  assert.equal(navigations.length, 0);
});

test('concurrent identical classifications run the pipeline once', async () => {
  let calls = 0;
  class Slow extends Classifier { get name() { return 's'; } async classify() { calls++; await new Promise((r) => setTimeout(r, 20)); return makeResult('irrelevant', 'embedding', 'x', { score: 0.1 }); } }
  const { controller } = make({ semantic: new Slow() });
  const [a, b] = await Promise.all([
    controller.classifyPage({ url: 'https://a.com/1', title: 'Foo bar' }),
    controller.classifyPage({ url: 'https://a.com/2', title: 'Foo  bar ' }),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.classification, b.classification);
  assert.equal(b.deduplicated, true);
});

test('changing settings invalidates cached decisions via the key fingerprint', async () => {
  let calls = 0;
  class Counting extends Classifier { get name() { return 'c'; } async classify() { calls++; return makeResult('irrelevant', 'embedding', 'x', { score: 0.1 }); } }
  const ctx = make({ semantic: new Counting() });
  await ctx.controller.classifyPage({ url: 'https://a.com/1', title: 'Foo bar' });
  ctx.controller.deps.loadConfig = async () => ({ settings: { ...DEFAULT_SETTINGS, weeklyGoal: 'Learn Rust' }, rules: { allow: [], block: [] }, anchors: { ...DEFAULT_ANCHORS } });
  ctx.controller.invalidateConfig();
  await ctx.controller.classifyPage({ url: 'https://a.com/1', title: 'Foo bar' });
  assert.equal(calls, 2);
});
