/**
 * Boots the real background script against a fake `browser` API and walks through the core
 * loop: set goal → visit relevant page → visit distracting page → friction → continue → grant.
 * The real bundled model is used (loaded via file:// URLs through Transformers.js).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakeBrowser, sleep } from '../helpers/fakeBrowser.mjs';
import { loadNodeModel } from '../helpers/nodeModel.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let h;

async function settle(ms = 400) {
  await sleep(ms); // tab monitor debounce (250 ms) + async work
}

before(async () => {
  h = createFakeBrowser({ root });
  globalThis.browser = h.browser;
  globalThis.GOALGUARD_MODEL_LOADER = loadNodeModel;
  globalThis.llmChats = 0;
  globalThis.ddgCalls = [];
  globalThis.GOALGUARD_LLM_LOADER = async () => ({
    complete: async (msgs) => {
      globalThis.llmChats++;
      const payload = JSON.parse(msgs[1].content);
      return payload.webContext
        ? JSON.stringify({ classification: 'relevant', confidence: 0.9, reason: 'The interview is about Linux kernel development.', evidence: ['Linux kernel'] })
        : JSON.stringify({ classification: 'irrelevant', confidence: 0.8, reason: 'Looks like celebrity content.', evidence: [] });
    },
  });
  globalThis.GOALGUARD_FETCH = async (url) => { globalThis.ddgCalls.push(url); return { ok: true, status: 200, text: async () => (await import('node:fs')).readFileSync(new URL('../data/ddg-sample.html', import.meta.url), 'utf8') }; };
  await import('../../src/background/background.js');
  await sleep(100);
});

test('boot initialises storage with defaults', async () => {
  const s = await h.sendMessage('getSettings');
  assert.equal(s.settings.frictionSeconds, 10);
  assert.equal(s.settings.overrideMinutes, 5);
  assert.deepEqual(s.rules, { allow: [], block: [] });
});

test('setting the goal generates anchors', async () => {
  await h.sendMessage('saveSettings', { weeklyGoal: 'Study operating systems and C++' });
  await sleep(50);
  const state = await h.sendMessage('getPopupState');
  assert.equal(state.settings.weeklyGoal, 'Study operating systems and C++');
  const { anchors } = await h.sendMessage('getSettings');
  assert.ok(anchors.positive.includes('virtual memory'));
});

test('relevant page is allowed without navigation', async () => {
  const id = await h.openTab({ url: 'https://pages.cs.wisc.edu/~remzi/OSTEP/', title: 'OSTEP - Processes' });
  await settle();
  assert.equal(h.navigations.length, 0);
  const state = await h.sendMessage('getPopupState');
  assert.equal(state.current.classification, 'relevant');
  assert.equal(state.current.decision, 'allow');
  await h.browser.tabs.remove(id);
});

test('semantic classification runs the local model for uncertain titles', async () => {
  const r = await h.sendMessage('classifyText', { title: 'Linux Virtual Memory Explained', url: 'https://youtube.com/watch?v=1' });
  assert.equal(r.source, 'embedding', JSON.stringify(r));
  assert.equal(r.classification, 'relevant');
  assert.equal(typeof r.positiveSimilarity, 'number');
  const model = await h.sendMessage('getModelStatus');
  assert.equal(model.status, 'ready');
});

test('irrelevant page → friction page → countdown → continue → temporary access → expiry', async () => {
  await h.sendMessage('saveSettings', { frictionSeconds: 1, overrideMinutes: 0.5 });
  await sleep(50);
  const url = 'https://www.pcmag.com/picks/the-best-gaming-pcs';
  const id = await h.openTab({ url, title: 'Best Gaming PCs of 2026' });
  await settle(800);
  assert.equal(h.navigations.length, 1, 'redirected to friction page');
  assert.match(h.navigations[0].url, /blocking\/blocked\.html\?/);
  const params = Object.fromEntries(new URL(h.navigations[0].url).searchParams);
  assert.equal(params.domain, 'pcmag.com');
  assert.equal(params.classification, 'irrelevant');

  let view = await h.sendMessage('getFrictionState', { ...params, tabId: Number(params.tabId), score: Number(params.score) });
  assert.equal(view.state, 'COUNTING_DOWN');
  assert.ok(view.remainingMs > 0 && view.remainingMs <= 1000);

  // Pressing Continue early is rejected by the background.
  let cont = await h.sendMessage('continueFromFriction', { domain: 'pcmag.com', url, tabId: id, generation: view.generation });
  assert.equal(cont.ok, false);

  // A "reload" of the friction page keeps the same countdown.
  await sleep(400);
  const view2 = await h.sendMessage('getFrictionState', { ...params, tabId: Number(params.tabId) });
  assert.ok(view2.remainingMs < view.remainingMs);

  await sleep(700);
  view = await h.sendMessage('getFrictionState', { ...params, tabId: Number(params.tabId) });
  assert.equal(view.state, 'UNLOCKED');

  // The friction page's sender tab is authoritative for tab/window identity.
  cont = await h.sendMessage('continueFromFriction', { domain: 'pcmag.com', url, tabId: id, generation: view.generation }, { tab: { id, windowId: 1 } });
  assert.equal(cont.ok, true);
  assert.equal(cont.state, 'TEMPORARILY_ALLOWED');
  assert.equal(h.navigations.at(-1).url, url, 'background navigated back to the site');

  await h.navigateTab(id, { url, title: 'Best Gaming PCs of 2026' });
  await settle();
  assert.equal(h.navigations.length, 2, 'no second redirect while grant is active');
  const popup = await h.sendMessage('getPopupState');
  assert.equal(popup.current.frictionState, 'TEMPORARILY_ALLOWED');
  assert.equal(popup.current.classification, 'irrelevant');

  const stats = await h.sendMessage('getStatistics');
  assert.equal(stats.today.frictionTriggered, 1);
  assert.equal(stats.today.overrides, 1);
  assert.equal(stats.grants.length, 1);
  const grant = stats.grants[0];
  assert.equal(grant.tabId, id, 'default scope is per-tab');
  assert.equal(grant.windowId, 1);
  assert.ok(h.scheduledAlarms().has(`goalguard-expire:${grant.key}`), 'an alarm is armed for exactly expiresAt');
  assert.equal(h.scheduledAlarms().get(`goalguard-expire:${grant.key}`).when, grant.expiresAt);

  // Expiry: the alarm fires while the user does nothing at all — no click, switch or reload.
  // The tab is replaced immediately with the "access expired" friction page.
  await h.fireAlarm(`goalguard-expire:${grant.key}`);
  await settle();
  assert.equal(h.navigations.length, 3, 'tab was replaced without user interaction');
  assert.equal(h.navigations.at(-1).tabId, id);
  assert.match(h.navigations.at(-1).url, /blocked\.html.*expired=1/);
  assert.ok(h.mediaPauses.includes(id), 'media pause attempted before redirect');
  assert.equal((await h.sendMessage('getStatistics')).grants.length, 0);
  assert.equal((await h.sendMessage('getStatistics')).today.overrideExpired, 1);

  // "Wait again": the expired page requests a fresh authoritative countdown.
  const again = await h.sendMessage('getFrictionState', { ...params, tabId: id });
  assert.equal(again.state, 'COUNTING_DOWN');
  await h.browser.tabs.remove(id);
});

test('expiry never blocks a tab that has moved to another site', async () => {
  await h.sendMessage('saveSettings', { frictionSeconds: 1, overrideMinutes: 0.5 });
  const url = 'https://www.pcmag.com/picks/the-best-gaming-pcs';
  const id = await h.openTab({ url, title: 'Best Gaming PCs of 2026' });
  await settle(800);
  const params = Object.fromEntries(new URL(h.navigations.at(-1).url).searchParams);
  await sleep(1100);
  const view = await h.sendMessage('getFrictionState', { ...params, tabId: id });
  const cont = await h.sendMessage('continueFromFriction', { domain: 'pcmag.com', url, tabId: id, generation: view.generation });
  assert.equal(cont.ok, true);
  const before = h.navigations.length;
  // User leaves for a relevant site before the timer runs out.
  await h.navigateTab(id, { url: 'https://github.com/torvalds/linux', title: 'torvalds/linux: Linux kernel source tree' });
  await settle();
  const key = `pcmag.com|${id}`;
  await h.fireAlarm(`goalguard-expire:${key}`);
  await settle();
  assert.equal(h.navigations.length, before, 'GitHub tab was left alone');
  assert.equal(h.tab(id).url, 'https://github.com/torvalds/linux');
  await h.browser.tabs.remove(id);
});

test('expiryAction "close" closes the tab; "domain" scope covers every tab on the site', async () => {
  await h.sendMessage('saveSettings', { frictionSeconds: 1, overrideMinutes: 0.5, expiryAction: 'close', overrideScope: 'domain' });
  await sleep(50);
  const url = 'https://www.pcmag.com/picks/the-best-gaming-pcs';
  const id = await h.openTab({ url, title: 'Best Gaming PCs of 2026' });
  await settle(800);
  const params = Object.fromEntries(new URL(h.navigations.at(-1).url).searchParams);
  await sleep(1100);
  const view = await h.sendMessage('getFrictionState', { ...params, tabId: id });
  await h.sendMessage('continueFromFriction', { domain: 'pcmag.com', url, tabId: id, generation: view.generation });
  const grants = (await h.sendMessage('getStatistics')).grants;
  assert.equal(grants[0].key, 'pcmag.com');
  assert.equal(grants[0].tabId, null);
  // A second pcmag tab is allowed straight through under the shared allowance.
  const before = h.navigations.length;
  const id2 = await h.openTab({ url: 'https://www.pcmag.com/reviews/some-laptop', title: 'Laptop review' });
  await settle(800);
  assert.equal(h.navigations.length, before, 'no friction on second tab of the granted domain');
  await h.fireAlarm('goalguard-expire:pcmag.com');
  await settle();
  assert.equal(h.tab(id2), undefined, 'active pcmag tab was closed');
  await h.sendMessage('saveSettings', { expiryAction: 'friction', overrideScope: 'tab' });
  if (h.tab(id)) await h.browser.tabs.remove(id);
});

test('go back abandons the countdown and records the statistic', async () => {
  const url = 'https://www.netflix.com/browse';
  const before = h.navigations.length;
  const id = await h.openTab({ url, title: 'Netflix' });
  await settle();
  assert.equal(h.navigations.length, before + 1);
  await h.sendMessage('leaveFriction', { tabId: id });
  const stats = await h.sendMessage('getStatistics');
  assert.ok(stats.today.frictionAbandoned >= 1);
  await h.browser.tabs.remove(id);
});

test('switching tabs during the countdown resets it; returning restarts a full timer', async () => {
  await h.sendMessage('saveSettings', { frictionSeconds: 2 });
  await sleep(50);
  const url = 'https://www.twitch.tv/somechannel';
  const id = await h.openTab({ url, title: 'Some Channel - Twitch' });
  await settle(600);
  const params = Object.fromEntries(new URL(h.navigations.at(-1).url).searchParams);
  params.tabId = Number(params.tabId);
  let view = await h.sendMessage('getFrictionState', params);
  assert.equal(view.state, 'COUNTING_DOWN');
  const firstGeneration = view.generation;
  await sleep(700);
  view = await h.sendMessage('getFrictionState', params);
  assert.ok(view.remainingMs < 1400);

  const other = await h.openTab({ url: 'https://pages.cs.wisc.edu/~remzi/OSTEP/', title: 'OSTEP' });
  await settle();
  const hidden = await h.sendMessage('getFrictionState', params);
  assert.equal(hidden.state, 'BLOCKED');
  assert.equal(hidden.inactive, true, 'background tab cannot run its timer');

  await sleep(1500); // would have completed the original timer by now
  await h.activateTab(id);
  await settle();
  view = await h.sendMessage('getFrictionState', params);
  assert.equal(view.state, 'COUNTING_DOWN');
  assert.ok(view.remainingMs > 1800, `full timer again, got ${view.remainingMs}`);
  assert.notEqual(view.generation, firstGeneration);

  // A stale Continue with the old generation is refused even once time has passed.
  await sleep(2100);
  const stale = await h.sendMessage('continueFromFriction', { domain: 'twitch.tv', url, tabId: id, generation: firstGeneration });
  assert.equal(stale.ok, false);
  const fresh = await h.sendMessage('continueFromFriction', { domain: 'twitch.tv', url, tabId: id, generation: view.generation });
  assert.equal(fresh.ok, true);
  const stats = await h.sendMessage('getStatistics');
  assert.ok(stats.today.frictionReset >= 1);
  await h.sendMessage('revokeGrant', { domain: 'twitch.tv' });
  await h.browser.tabs.remove(id);
  await h.browser.tabs.remove(other);
});

test('classification and embedding caches persist across a background restart', async () => {
  const title = 'Understanding the Linux Kernel Scheduler in depth';
  const first = await h.sendMessage('classifyText', { title, url: 'https://blog.example/x' });
  assert.equal(first.source, 'embedding');
  const second = await h.sendMessage('classifyText', { title: `  ${title} `, url: 'https://blog.example/y?utm_source=z' });
  assert.equal(second.cached, true);
  const stats = await h.sendMessage('getCacheStats');
  assert.ok(stats.classification.hits >= 1);
  assert.ok(stats.embedding.size >= 1);

  // Flush (the minute alarm does this in production) and inspect what is on disk.
  await h.tick();
  const stored = h.store.get('cache:classification');
  assert.ok(stored && stored.entries.length >= 1);
  const json = JSON.stringify(stored);
  assert.ok(!json.includes('blog.example/x'), 'cache must not contain URLs');

  // Simulate an event-page restart: fresh PersistentCache over the same storage.
  const { PersistentCache } = await import('../../src/storage/cacheStore.js');
  const reborn = new PersistentCache('classification');
  await reborn.ensureLoaded();
  assert.ok(reborn.size >= 1, 'entries reload from storage');
});

test('layer 3 is off by default: questionable stays with the embedding layer', async () => {
  const r = await h.sendMessage('classifyText', { title: 'Linus Torvalds Interview', url: 'https://youtube.com/watch?v=q' });
  assert.equal(r.classification, 'questionable');
  assert.equal(r.source, 'embedding');
  assert.equal(globalThis.llmChats, 0);
});

test('LLM enabled: questionable pages get a final LLM verdict; relevant pages never touch it', async () => {
  await h.sendMessage('saveSettings', { llmEnabled: true });
  await sleep(50);
  const r = await h.sendMessage('classifyText', { title: 'Linus Torvalds Interview', url: 'https://youtube.com/watch?v=q' });
  assert.equal(r.source, 'llm', JSON.stringify(r));
  assert.equal(r.sourceKind, 'local_llm');
  assert.equal(r.classification, 'irrelevant');
  assert.equal(r.confidence, 0.8);
  assert.equal(r.evidenceQuality, 'low');
  assert.equal(globalThis.llmChats, 1);
  const cached = await h.sendMessage('classifyText', { title: 'Linus Torvalds Interview', url: 'https://youtube.com/watch?v=other' });
  assert.equal(cached.cached, true);
  assert.equal(globalThis.llmChats, 1, 'final decision cached: no second LLM call');
  await h.sendMessage('classifyText', { title: 'Linux Virtual Memory Explained', url: 'https://youtube.com/watch?v=vm' });
  assert.equal(globalThis.llmChats, 1, 'confident embedding result skips the LLM');
  const st = await h.sendMessage('getLayer3Status');
  assert.equal(st.llm.status, 'ready');
});

test('search enabled without host permission → LLM runs without context; with permission → llm+search and cached', async () => {
  await h.sendMessage('saveSettings', { searchEnabled: true, searchMode: 'uncertain' });
  await sleep(50);
  let r = await h.sendMessage('classifyText', { title: 'Linus Torvalds Interview', url: 'https://youtube.com/watch?v=q' });
  assert.equal(r.source, 'llm');
  assert.equal(globalThis.ddgCalls.length, 0, 'no network call without permission');
  h.grantOrigin('https://html.duckduckgo.com/*');
  await h.sendMessage('clearCaches');
  r = await h.sendMessage('classifyText', { title: 'Linus Torvalds Interview', url: 'https://youtube.com/watch?v=q' });
  assert.equal(r.source, 'llm+search', JSON.stringify(r));
  assert.equal(r.classification, 'relevant');
  assert.equal(r.searchUsed, true);
  assert.ok(r.webContext.length >= 1);
  assert.ok(['medium', 'high'].includes(r.evidenceQuality), r.evidenceQuality);
  assert.equal(globalThis.ddgCalls.length, 1);
  assert.ok(globalThis.ddgCalls[0].includes(encodeURIComponent('Linus Torvalds Interview')));
  assert.ok(!globalThis.ddgCalls[0].includes('youtube'), 'URL never sent');
  const probe = await h.sendMessage('testLayer3', { title: 'Linus Torvalds Interview' });
  assert.equal(probe.retrieval.cached, true, 'retrieval cache hit: no second DuckDuckGo request');
  assert.equal(globalThis.ddgCalls.length, 1);
  const stats = await h.sendMessage('getCacheStats');
  assert.ok(stats.retrieval.size >= 1);
  assert.ok(stats.llm.size >= 1);
  const tel = await h.sendMessage('getTelemetry');
  assert.ok(tel.pipeline.counters.llmCalls >= 1);
  assert.equal(tel.search.requests, 1);
  await h.sendMessage('saveSettings', { llmEnabled: false, searchEnabled: false });
  await sleep(50);
});

test('feedback is stored locally and debug mode exposes the trace', async () => {
  await h.sendMessage('saveSettings', { debugMode: true });
  await sleep(50);
  const r = await h.sendMessage('classifyText', { title: 'Best Gaming PCs of 2026', url: 'https://pcmag.com/x' });
  assert.ok(Array.isArray(r.trace) && r.trace.length >= 1);
  assert.ok(typeof r.timings.totalMs === 'number');
  const fb = await h.sendMessage('submitFeedback', { domain: 'pcmag.com', title: 'Best Gaming PCs of 2026', prediction: r.classification, userLabel: 'relevant', source: r.source });
  assert.equal(fb.userLabel, 'relevant');
  const list = await h.sendMessage('getFeedback');
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes('pcmag.com/x'), 'URL is not stored');
  assert.deepEqual(await h.sendMessage('submitFeedback', { userLabel: 'nope' }), { error: 'Invalid label' });
  await h.sendMessage('clearFeedback');
  assert.equal((await h.sendMessage('getFeedback')).length, 0);
  await h.sendMessage('saveSettings', { debugMode: false });
  const plain = await h.sendMessage('classifyText', { title: 'Best Gaming PCs of 2026', url: 'https://pcmag.com/x' });
  assert.equal(plain.trace, undefined);
});

test('rapid tab switching: a slow page superseded by navigation never redirects', async () => {
  const id = await h.openTab({ url: 'https://example.org/a', title: 'Random unclear thing number one' });
  await h.navigateTab(id, { url: 'https://pages.cs.wisc.edu/~remzi/OSTEP/', title: 'OSTEP - Processes' });
  await settle(600);
  const state = await h.sendMessage('getPopupState');
  assert.equal(state.current.classification, 'relevant');
  assert.equal(state.current.title, 'OSTEP - Processes');
  await h.browser.tabs.remove(id);
});

test('user allow rule overrides the semantic verdict', async () => {
  const saved = await h.sendMessage('saveRules', { allow: ['\\bgaming pcs\\b'], block: [] });
  assert.ok(!saved.error);
  await sleep(50);
  const r = await h.sendMessage('classifyText', { title: 'Best Gaming PCs of 2026', url: 'https://pcmag.com/x' });
  assert.equal(r.source, 'rule:allow');
  const bad = await h.sendMessage('saveRules', { allow: ['[oops'], block: [] });
  assert.equal(bad.error, 'Invalid regex');
  await h.sendMessage('saveRules', { allow: [], block: [] });
});

test('unsupported pages are ignored', async () => {
  const before = h.navigations.length;
  const id = await h.openTab({ url: 'about:preferences', title: 'Settings' });
  await settle();
  assert.equal(h.navigations.length, before);
  const state = await h.sendMessage('getPopupState');
  assert.equal(state.current, null);
  await h.browser.tabs.remove(id);
});

test('unknown message types return an error object instead of throwing', async () => {
  const r = await h.sendMessage('nope');
  assert.match(r.error, /Unknown message/);
});
