import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrictionManager, UNLOCK_GRACE_MS } from '../../src/blocking/frictionManager.js';

function make() {
  let store = null;
  let now = 1_000_000;
  const events = [];
  const deps = () => ({ load: async () => store, save: async (s) => { store = structuredClone(s); }, now: () => now, onEvent: (e, p) => events.push([e, p]) });
  const fm = new FrictionManager(deps());
  return { fm, events, advance: (ms) => { now += ms; }, getStore: () => store, reload: () => new FrictionManager(deps()) };
}
const page = (tabId, domain = 'example.com', url = `https://${domain}/a`) => ({ tabId, domain, url, title: 't', classification: 'irrelevant', decision: 'block' });

test('timer starts, counts down, completes', async () => {
  const { fm, advance, events } = make();
  let s = await fm.startCountdown({ ...page(1), frictionSeconds: 10 });
  assert.equal(s.state, 'COUNTING_DOWN');
  assert.equal(s.remainingMs, 10_000);
  assert.equal(typeof s.generation, 'number');
  advance(4_000);
  s = await fm.getState({ tabId: 1, domain: 'example.com' });
  assert.equal(s.remainingMs, 6_000);
  advance(6_000);
  s = await fm.getState({ tabId: 1, domain: 'example.com' });
  assert.equal(s.state, 'UNLOCKED');
  assert.equal(events[0][0], 'frictionTriggered');
});

test('Continue is rejected before unlockAt and accepted after', async () => {
  const { fm, advance } = make();
  await fm.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 10 });
  advance(9_999);
  let r = await fm.grantAccess({ tabId: 1, domain: 'a.com', overrideMinutes: 5 });
  assert.equal(r.ok, false);
  advance(1);
  r = await fm.grantAccess({ tabId: 1, domain: 'a.com', overrideMinutes: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'TEMPORARILY_ALLOWED');
  assert.equal(r.remainingMs, 5 * 60_000);
});

test('reloading the friction page (same tab, same url) keeps the countdown', async () => {
  const { fm, advance, reload } = make();
  await fm.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 10 });
  advance(3_000);
  const fm2 = reload(); // simulates an event-page restart too
  const s = await fm2.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 10 });
  assert.equal(s.state, 'COUNTING_DOWN');
  assert.equal(s.remainingMs, 7_000);
});

test('switching away during the timer resets it; returning starts a full timer', async () => {
  const { fm, advance, events } = make();
  const first = await fm.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 10 });
  advance(3_000);
  assert.equal(await fm.onTabDeactivated(1), true);
  assert.equal((await fm.getState({ tabId: 1, domain: 'a.com' })).state, 'BLOCKED');
  assert.ok(events.some(([e, p]) => e === 'frictionReset' && p.reason === 'tab-switch'));
  const again = await fm.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 10 });
  assert.equal(again.remainingMs, 10_000, 'full timer, not 7 s');
  assert.notEqual(again.generation, first.generation);
});

test('switching repeatedly never lets the timer complete', async () => {
  const { fm, advance } = make();
  for (let i = 0; i < 5; i++) {
    const s = await fm.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 10 });
    assert.equal(s.remainingMs, 10_000);
    advance(9_000);
    await fm.onTabDeactivated(1);
  }
  const r = await fm.grantAccess({ tabId: 1, domain: 'a.com', overrideMinutes: 5 });
  assert.equal(r.ok, false);
});

test('completed timer followed by a tab switch stays completed', async () => {
  const { fm, advance } = make();
  await fm.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 10 });
  advance(10_000);
  assert.equal(await fm.onTabDeactivated(1), false);
  assert.equal((await fm.getState({ tabId: 1, domain: 'a.com' })).state, 'UNLOCKED');
  assert.equal((await fm.grantAccess({ tabId: 1, domain: 'a.com', overrideMinutes: 5 })).ok, true);
});

test('stale generation cannot grant access after a reset', async () => {
  const { fm, advance } = make();
  const stale = await fm.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 10 });
  advance(5_000);
  await fm.onTabDeactivated(1);
  await fm.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 10 });
  advance(10_000);
  const r = await fm.grantAccess({ tabId: 1, domain: 'a.com', generation: stale.generation, overrideMinutes: 5 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /reset/);
  const fresh = await fm.getState({ tabId: 1, domain: 'a.com' });
  assert.equal((await fm.grantAccess({ tabId: 1, domain: 'a.com', generation: fresh.generation, overrideMinutes: 5 })).ok, true);
});

test('two tabs have independent timers', async () => {
  const { fm, advance } = make();
  await fm.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 10 });
  advance(2_000);
  await fm.startCountdown({ ...page(2, 'b.com'), frictionSeconds: 10 });
  await fm.onTabDeactivated(1);
  assert.equal((await fm.getState({ tabId: 1, domain: 'a.com' })).state, 'BLOCKED');
  assert.equal((await fm.getState({ tabId: 2, domain: 'b.com' })).remainingMs, 10_000);
});

test('navigating the tab to a different page restarts the timer', async () => {
  const { fm, advance, events } = make();
  await fm.startCountdown({ ...page(1, 'youtube.com', 'https://youtube.com/watch?v=A'), frictionSeconds: 10 });
  advance(9_000);
  const s = await fm.startCountdown({ ...page(1, 'youtube.com', 'https://youtube.com/watch?v=B'), frictionSeconds: 10 });
  assert.equal(s.remainingMs, 10_000);
  assert.ok(events.some(([e, p]) => e === 'frictionReset' && p.reason === 'navigation'));
  // Hash-only changes are the same page: the timer continues.
  advance(4_000);
  const same = await fm.startCountdown({ ...page(1, 'youtube.com', 'https://youtube.com/watch?v=B#t=5'), frictionSeconds: 10 });
  assert.equal(same.state, 'COUNTING_DOWN');
  assert.equal(same.remainingMs, 6_000);
});

test('grant expires and friction is required again', async () => {
  const { fm, advance } = make();
  await fm.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 1 });
  advance(1_000);
  await fm.grantAccess({ tabId: 1, domain: 'a.com', overrideMinutes: 1 });
  advance(59_999);
  assert.equal((await fm.getState({ tabId: 1, domain: 'a.com' })).state, 'TEMPORARILY_ALLOWED');
  advance(1);
  assert.equal((await fm.getState({ tabId: 1, domain: 'a.com' })).state, 'BLOCKED');
});

test('grants are domain scoped and survive tab switches', async () => {
  const { fm, advance } = make();
  await fm.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 1 });
  advance(1_000);
  await fm.grantAccess({ tabId: 1, domain: 'a.com', overrideMinutes: 5 });
  await fm.onTabDeactivated(1);
  assert.ok(await fm.hasActiveGrant('a.com'));
  assert.equal(await fm.hasActiveGrant('b.com'), null);
  assert.equal((await fm.getState({ tabId: 9, domain: 'a.com' })).state, 'TEMPORARILY_ALLOWED');
});

test('go back abandons and records an event', async () => {
  const { fm, events } = make();
  await fm.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 10 });
  assert.equal(await fm.abandonCountdown(1), true);
  assert.equal((await fm.getState({ tabId: 1, domain: 'a.com' })).state, 'BLOCKED');
  assert.ok(events.some(([e]) => e === 'frictionAbandoned'));
  assert.equal(await fm.abandonCountdown(1), false);
});

test('tab closure removes timer state', async () => {
  const { fm, getStore } = make();
  await fm.startCountdown({ ...page(7, 'a.com'), frictionSeconds: 10 });
  await fm.abandonForTab(7);
  assert.deepEqual(await fm.listCountdowns(), []);
  assert.deepEqual(getStore().countdowns, {});
});

test('unlocked countdown expires after the grace period', async () => {
  const { fm, advance } = make();
  await fm.startCountdown({ ...page(1, 'a.com'), frictionSeconds: 1 });
  advance(1_000 + UNLOCK_GRACE_MS);
  assert.equal((await fm.getState({ tabId: 1, domain: 'a.com' })).state, 'BLOCKED');
});

test('spec §9.5 timeline: access timer starts at Continue, not at friction-page open', async () => {
  const { fm, advance, events } = make();
  const t0 = 1_000_000;
  await fm.startCountdown({ tabId: 9, domain: 'youtube.com', url: 'https://youtube.com/w', frictionSeconds: 10 });
  advance(10_000);           // 13:20:10 countdown done
  advance(30_000);           // user hesitates 30 s before pressing Continue (within grace)
  const r = await fm.grantAccess({ tabId: 9, domain: 'youtube.com', overrideMinutes: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.grant.grantedAt, t0 + 40_000);
  assert.equal(r.grant.expiresAt, t0 + 40_000 + 5 * 60_000, 'expiry counts from the grant, not from page open');
  const granted = events.find((e) => e[0] === 'overrideGranted');
  assert.equal(granted[1].minutes, 5);
  // Grant is domain-scoped: another domain is still blocked.
  assert.equal((await fm.getState({ tabId: 9, domain: 'reddit.com' })).state, 'BLOCKED');
});
