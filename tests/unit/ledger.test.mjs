import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LedgerManager, LEDGER_STATUS, normalizeIntent } from '../../src/ledger/ledgerManager.js';

function make(opts = {}) {
  let store = null;
  let now = 1_700_000_000_000;
  const deps = () => ({ load: async () => store, save: async (s) => { store = structuredClone(s); }, now: () => now, ...opts });
  return { lm: new LedgerManager(deps()), advance: (ms) => { now += ms; }, reload: () => new LedgerManager(deps()), getStore: () => store };
}

test('create → list → edit → complete → delete lifecycle, persisted across restarts', async () => {
  const { lm, advance, reload } = make();
  const e = await lm.createEntry({ domain: 'youtube.com', url: 'https://youtube.com/watch?v=1', title: 'OS Lecture 4', intent: '  Watch lecture 4 on processes ' });
  assert.equal(e.intent, 'Watch lecture 4 on processes', 'stored trimmed, original wording');
  assert.equal(e.status, LEDGER_STATUS.PENDING);
  assert.equal(e.source, 'friction');
  assert.ok(e.id && e.createdAt);

  advance(60_000);
  const edited = await lm.updateEntry(e.id, { intent: 'Watch lecture 4 and take notes on fork/exec' });
  assert.equal(edited.intent, 'Watch lecture 4 and take notes on fork/exec');
  assert.ok(edited.updatedAt > e.updatedAt);
  assert.equal(edited.createdAt, e.createdAt);

  // Survives a "restart" (new manager over the same storage).
  const lm2 = reload();
  assert.equal((await lm2.getPendingEntries()).length, 1);
  assert.equal((await lm2.getEntry(e.id)).intent, edited.intent);

  advance(1000);
  const done = await lm2.completeEntry(e.id);
  assert.equal(done.status, LEDGER_STATUS.COMPLETED);
  assert.equal(done.completedAt, lm2.now());
  assert.equal((await lm2.getPendingEntries()).length, 0);
  assert.equal((await lm2.listEntries({ status: 'completed' })).length, 1);

  const reopened = await lm2.reopenEntry(e.id);
  assert.equal(reopened.status, 'pending');
  assert.equal(reopened.completedAt, null);

  assert.equal(await lm2.deleteEntry(e.id), true);
  assert.equal(await lm2.deleteEntry(e.id), false);
  assert.equal((await lm2.listEntries()).length, 0);
});

test('validation: empty intent / domain rejected, status must be known', async () => {
  const { lm } = make();
  await assert.rejects(() => lm.createEntry({ domain: 'a.com', intent: '   ' }), /Intent is required/);
  await assert.rejects(() => lm.createEntry({ domain: '', intent: 'x' }), /Domain/);
  const e = await lm.createEntry({ domain: 'a.com', intent: 'x' });
  await assert.rejects(() => lm.updateEntry(e.id, { status: 'bogus' }), /Unknown status/);
  assert.equal(await lm.updateEntry('nope', { intent: 'y' }), null);
});

test('task piling: many entries across domains, newest first, filter by domain', async () => {
  const { lm, advance } = make();
  for (const [d, i] of [['youtube.com', 'Watch OSTEP process lecture'], ['github.com', 'Check issue #142'], ['google.com', 'Find AVX2 docs'], ['reddit.com', 'Reply to discussion']]) {
    await lm.createEntry({ domain: d, intent: i });
    advance(1000);
  }
  const all = await lm.getPendingEntries();
  assert.equal(all.length, 4);
  assert.equal(all[0].domain, 'reddit.com');
  assert.deepEqual((await lm.pendingForDomain('github.com')).map((e) => e.intent), ['Check issue #142']);
  assert.deepEqual(await lm.counts(), { pending: 4, in_progress: 0, completed: 0, dismissed: 0, open: 4, total: 4 });
});

test('normalizeIntent only affects matching; search covers intent, domain and title', async () => {
  assert.equal(normalizeIntent('check the comments on my PR'), 'check comments pr');
  assert.equal(normalizeIntent('Check whether issue #42 is fixed!'), 'check whether issue #42 is fixed');
  const { lm } = make();
  await lm.createEntry({ domain: 'reddit.com', intent: 'Find discussion about the kernel bug' });
  await lm.createEntry({ domain: 'google.com', intent: 'Read the docs', title: 'Linux kernel documentation' });
  await lm.createEntry({ domain: 'youtube.com', intent: 'Watch lecture' });
  assert.deepEqual((await lm.searchEntries('kernel')).map((e) => e.domain).sort(), ['google.com', 'reddit.com']);
  assert.deepEqual((await lm.searchEntries('youtube')).map((e) => e.intent), ['Watch lecture']);
  assert.equal((await lm.searchEntries('')).length, 3);
});

test('duplicate detection is conservative: same domain + normalised intent, open, recent', async () => {
  const { lm, advance } = make();
  const e = await lm.createEntry({ domain: 'reddit.com', intent: 'Find the discussion about the kernel bug' });
  assert.equal((await lm.findDuplicate({ domain: 'reddit.com', intent: 'find discussion about kernel bug!' }))?.id, e.id);
  assert.equal(await lm.findDuplicate({ domain: 'github.com', intent: 'find discussion about kernel bug' }), null, 'different domain');
  assert.equal(await lm.findDuplicate({ domain: 'reddit.com', intent: 'find discussion about scheduler bug' }), null, 'different words');
  await lm.completeEntry(e.id);
  assert.equal(await lm.findDuplicate({ domain: 'reddit.com', intent: 'Find the discussion about the kernel bug' }), null, 'completed entries do not block');
  const f = await lm.createEntry({ domain: 'reddit.com', intent: 'Find the discussion about the kernel bug' });
  advance(8 * 86400000);
  assert.equal(await lm.findDuplicate({ domain: 'reddit.com', intent: 'Find the discussion about the kernel bug' }), null, 'outside window');
  assert.ok(await lm.getEntry(f.id), 'pending entries are retained indefinitely');
});

test('completion is never inferred: startEntry marks in_progress only', async () => {
  const { lm } = make();
  const e = await lm.createEntry({ domain: 'github.com', intent: 'Check issue #142' });
  const started = await lm.startEntry(e.id);
  assert.equal(started.status, 'in_progress');
  assert.equal(started.completedAt, null);
  assert.equal((await lm.getPendingEntries()).length, 1, 'still counts as open');
});

test('session: snapshot of open tasks, skip cycles, complete advances, ends when empty', async () => {
  const { lm } = make();
  const a = await lm.createEntry({ domain: 'a.com', intent: 'A' });
  const b = await lm.createEntry({ domain: 'b.com', intent: 'B' });
  const c = await lm.createEntry({ domain: 'c.com', intent: 'C' });
  let s = await lm.startSession();
  assert.equal(s.totalTasks, 3);
  assert.equal(s.current.id, a.id, 'oldest first');
  assert.equal(s.position, 1);
  s = await lm.skipCurrent();
  assert.equal(s.current.id, b.id);
  await lm.completeEntry(b.id);
  s = await lm.getSession();
  assert.equal(s.current.id, c.id);
  assert.equal(s.position, 2);
  await lm.deleteEntry(c.id);
  s = await lm.getSession();
  assert.equal(s.current.id, a.id, 'skipped task comes back at the end');
  await lm.completeEntry(a.id);
  s = await lm.getSession();
  assert.equal(s.finished, true);
  assert.equal(s.current, null);
  await lm.endSession();
  assert.equal(await lm.getSession(), null);
  assert.equal(await lm.startSession(), null, 'nothing open');
});

test('retention drops old completed entries but never pending ones', async () => {
  const { lm, advance, reload } = make();
  const old = await lm.createEntry({ domain: 'a.com', intent: 'old' });
  await lm.completeEntry(old.id);
  const keep = await lm.createEntry({ domain: 'a.com', intent: 'still pending' });
  advance(31 * 86400000);
  const lm2 = reload();
  const ids = (await lm2.listEntries()).map((e) => e.id);
  assert.deepEqual(ids, [keep.id]);
  assert.equal(await lm2.clearCompleted(), 0);
});
