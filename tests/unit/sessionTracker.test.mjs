import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker } from '../../src/background/sessionTracker.js';

function make(start = new Date('2026-09-14T10:00:00').getTime()) {
  let now = start;
  const mem = { stats: null, sessions: [], current: null };
  const tracker = new SessionTracker({
    loadStats: async () => mem.stats,
    saveStats: async (s) => { mem.stats = structuredClone(s); },
    loadSessions: async () => mem.sessions,
    saveSessions: async (s) => { mem.sessions = structuredClone(s); },
    loadCurrent: async () => mem.current,
    saveCurrent: async (c) => { mem.current = structuredClone(c); },
    limits: { maxSessions: 10, sessionRetentionDays: 14 },
    now: () => now,
  });
  return { tracker, mem, advance: (ms) => { now += ms; } };
}

test('accumulates time per classification and stores minimal session records', async () => {
  const { tracker, mem, advance } = make();
  await tracker.start({ domain: 'a.com', title: 'OS lecture', classification: 'relevant', decision: 'allow', score: 0.8 });
  advance(120_000);
  await tracker.start({ domain: 'b.com', title: 'Gaming', classification: 'irrelevant', decision: 'block', overridden: true });
  advance(60_000);
  await tracker.stop();
  const s = await tracker.getSummary();
  assert.equal(s.today.relevantMs, 120_000);
  assert.equal(s.today.irrelevantMs, 60_000);
  assert.equal(s.today.overrideMs, 60_000);
  assert.equal(mem.sessions.length, 2);
  assert.ok(!('url' in mem.sessions[0]));
});

test('duplicate start for the same page does not reset the session', async () => {
  const { tracker, advance } = make();
  const a = await tracker.start({ domain: 'a.com', title: 'x', classification: 'relevant' });
  advance(5_000);
  const b = await tracker.start({ domain: 'a.com', title: 'x', classification: 'relevant' });
  assert.equal(a.id, b.id);
});

test('summary includes the running session and week totals', async () => {
  const { tracker, advance } = make();
  await tracker.start({ domain: 'a.com', title: 'x', classification: 'relevant' });
  advance(30_000);
  const s = await tracker.getSummary();
  assert.equal(s.today.relevantMs, 30_000);
  assert.equal(s.week.relevantMs, 30_000);
  assert.ok(s.current);
});

test('splits sessions across midnight', async () => {
  const { tracker, advance } = make(new Date('2026-09-14T23:59:00').getTime());
  await tracker.start({ domain: 'a.com', title: 'x', classification: 'relevant' });
  advance(120_000);
  await tracker.stop();
  const summary = await tracker.getSummary();
  assert.equal(summary.today.relevantMs, 60_000); // "today" is now the 15th
  assert.equal(tracker.stats.days['2026-09-14'].relevantMs, 60_000);
});

test('friction events increment counters', async () => {
  const { tracker } = make();
  await tracker.recordEvent('frictionTriggered');
  await tracker.recordEvent('frictionAbandoned');
  await tracker.recordEvent('overrideGranted');
  const s = await tracker.getSummary();
  assert.equal(s.today.frictionTriggered, 1);
  assert.equal(s.today.frictionAbandoned, 1);
  assert.equal(s.today.overrides, 1);
});

test('session list is bounded', async () => {
  const { tracker, advance } = make();
  for (let i = 0; i < 15; i++) {
    await tracker.start({ domain: `d${i}.com`, title: 't', classification: 'relevant' });
    advance(2_000);
  }
  await tracker.stop();
  assert.ok(tracker.sessions.length <= 10);
});
