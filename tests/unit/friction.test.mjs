import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrictionManager, UNLOCK_GRACE_MS } from '../../src/blocking/frictionManager.js';

function make() {
  let store = null;
  let now = 1_000_000;
  const events = [];
  const fm = new FrictionManager({
    load: async () => store,
    save: async (s) => { store = structuredClone(s); },
    now: () => now,
    onEvent: (e, p) => events.push([e, p]),
  });
  return { fm, events, advance: (ms) => { now += ms; }, getStore: () => store, reload: () => new FrictionManager({ load: async () => store, save: async (s) => { store = structuredClone(s); }, now: () => now, onEvent: (e, p) => events.push([e, p]) }) };
}

test('countdown starts, counts down, unlocks', async () => {
  const { fm, advance, events } = make();
  let s = await fm.startCountdown({ domain: 'example.com', title: 't', classification: 'irrelevant', decision: 'block', frictionSeconds: 10, tabId: 1 });
  assert.equal(s.state, 'COUNTING_DOWN');
  assert.equal(s.remainingMs, 10_000);
  advance(4_000);
  s = await fm.getState('example.com');
  assert.equal(s.state, 'COUNTING_DOWN');
  assert.equal(s.remainingMs, 6_000);
  advance(6_000);
  s = await fm.getState('example.com');
  assert.equal(s.state, 'UNLOCKED');
  assert.equal(events[0][0], 'frictionTriggered');
});

test('Continue is rejected before unlockAt and accepted after', async () => {
  const { fm, advance } = make();
  await fm.startCountdown({ domain: 'a.com', frictionSeconds: 10 });
  advance(9_999);
  let r = await fm.grantAccess({ domain: 'a.com', overrideMinutes: 5 });
  assert.equal(r.ok, false);
  advance(1);
  r = await fm.grantAccess({ domain: 'a.com', overrideMinutes: 5 });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'TEMPORARILY_ALLOWED');
  assert.equal(r.remainingMs, 5 * 60_000);
});

test('reloading the page (new manager, same storage) does not reset the countdown', async () => {
  const { fm, advance, reload } = make();
  await fm.startCountdown({ domain: 'a.com', frictionSeconds: 10 });
  advance(3_000);
  const fm2 = reload();
  const s = await fm2.startCountdown({ domain: 'a.com', frictionSeconds: 10 });
  assert.equal(s.state, 'COUNTING_DOWN');
  assert.equal(s.remainingMs, 7_000);
});

test('grant expires and friction is required again', async () => {
  const { fm, advance } = make();
  await fm.startCountdown({ domain: 'a.com', frictionSeconds: 1 });
  advance(1_000);
  await fm.grantAccess({ domain: 'a.com', overrideMinutes: 1 });
  advance(59_999);
  assert.equal((await fm.getState('a.com')).state, 'TEMPORARILY_ALLOWED');
  advance(1);
  assert.equal((await fm.getState('a.com')).state, 'BLOCKED');
});

test('grants are domain scoped', async () => {
  const { fm, advance } = make();
  await fm.startCountdown({ domain: 'a.com', frictionSeconds: 1 });
  advance(1_000);
  await fm.grantAccess({ domain: 'a.com', overrideMinutes: 5 });
  assert.equal((await fm.getState('b.com')).state, 'BLOCKED');
  assert.ok(await fm.hasActiveGrant('a.com'));
  assert.equal(await fm.hasActiveGrant('b.com'), null);
});

test('abandoning records an event and clears the countdown', async () => {
  const { fm, events } = make();
  await fm.startCountdown({ domain: 'a.com', frictionSeconds: 10, tabId: 7 });
  assert.equal(await fm.abandonCountdown('a.com'), true);
  assert.equal((await fm.getState('a.com')).state, 'BLOCKED');
  assert.ok(events.some(([e]) => e === 'frictionAbandoned'));
  assert.equal(await fm.abandonCountdown('a.com'), false);
});

test('abandonForTab clears countdowns of a closed tab except the current domain', async () => {
  const { fm } = make();
  await fm.startCountdown({ domain: 'a.com', frictionSeconds: 10, tabId: 7 });
  await fm.startCountdown({ domain: 'b.com', frictionSeconds: 10, tabId: 7 });
  await fm.abandonForTab(7, { exceptDomain: 'b.com' });
  assert.equal((await fm.getState('a.com')).state, 'BLOCKED');
  assert.equal((await fm.getState('b.com')).state, 'COUNTING_DOWN');
});

test('unlocked countdown expires after the grace period', async () => {
  const { fm, advance } = make();
  await fm.startCountdown({ domain: 'a.com', frictionSeconds: 1 });
  advance(1_000 + UNLOCK_GRACE_MS);
  assert.equal((await fm.getState('a.com')).state, 'BLOCKED');
});
