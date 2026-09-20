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

  cont = await h.sendMessage('continueFromFriction', { domain: 'pcmag.com', url, tabId: id, generation: view.generation });
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

  // Revoking the grant re-triggers friction on the open tab.
  await h.sendMessage('revokeGrant', { domain: 'pcmag.com' });
  await settle();
  assert.equal(h.navigations.length, 3);
  assert.match(h.navigations.at(-1).url, /blocked\.html/);
  await h.browser.tabs.remove(id);
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
