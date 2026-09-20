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
  let cont = await h.sendMessage('continueFromFriction', { domain: 'pcmag.com', url, tabId: id });
  assert.equal(cont.ok, false);

  // A "reload" of the friction page keeps the same countdown.
  await sleep(400);
  const view2 = await h.sendMessage('getFrictionState', { ...params, tabId: Number(params.tabId) });
  assert.ok(view2.remainingMs < view.remainingMs);

  await sleep(700);
  view = await h.sendMessage('getFrictionState', { ...params, tabId: Number(params.tabId) });
  assert.equal(view.state, 'UNLOCKED');

  cont = await h.sendMessage('continueFromFriction', { domain: 'pcmag.com', url, tabId: id });
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
  await h.sendMessage('leaveFriction', { domain: 'netflix.com', tabId: id });
  const stats = await h.sendMessage('getStatistics');
  assert.ok(stats.today.frictionAbandoned >= 1);
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
