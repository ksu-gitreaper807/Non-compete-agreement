import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSearchQuery, sanitizeUrl, isGenericTitle, stripSiteSuffix } from '../../src/search/queryBuilder.js';
import { normalizeResults, rankResults, assessEvidence, lexicalOverlap } from '../../src/search/resultParser.js';
import { RateLimiter } from '../../src/search/rateLimiter.js';
import { SearchManager, SEARCH_STATUS } from '../../src/search/searchManager.js';
import { MockSearchProvider } from '../../src/search/searchProvider.js';
import { DuckDuckGoSearchProvider, parseResultsHtml } from '../../src/search/duckduckgoProvider.js';
import { PersistentCache } from '../../src/storage/cacheStore.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sampleHtml = fs.readFileSync(path.join(here, '..', 'data', 'ddg-sample.html'), 'utf8');

// ---- query generation --------------------------------------------------------------------------

test('buildSearchQuery uses the title only for informative titles and adds the domain for generic ones', () => {
  assert.deepEqual(buildSearchQuery({ title: 'Linux Virtual Memory Explained - YouTube', domain: 'youtube.com' }), { query: 'Linux Virtual Memory Explained', usedDomain: false });
  assert.deepEqual(buildSearchQuery({ title: 'Episode 42', domain: 'podcasts.example' }), { query: 'Episode 42 podcasts.example', usedDomain: true });
  assert.deepEqual(buildSearchQuery({ title: 'Processes', domain: 'pages.cs.wisc.edu' }), { query: 'Processes pages.cs.wisc.edu', usedDomain: true });
  assert.equal(buildSearchQuery({ title: '   ', domain: 'x.com' }), null);
  assert.ok(buildSearchQuery({ title: 'word '.repeat(100) }).query.length <= 120);
});

test('isGenericTitle flags low-information titles', () => {
  for (const t of ['Processes', 'Systems', 'Episode 42', 'Complete Guide', 'Latest Update', 'Everything You Need to Know', 'How It Works']) assert.equal(isGenericTitle(t), true, t);
  for (const t of ['Understanding Linux Page Tables', 'Best Gaming PCs of 2026', 'Deadlocks and mutexes in xv6']) assert.equal(isGenericTitle(t), false, t);
  assert.equal(stripSiteSuffix('OSTEP - Processes | Hacker News'), 'OSTEP - Processes');
});

test('sanitizeUrl keeps origin + path and drops query, fragment and credentials', () => {
  assert.equal(sanitizeUrl('https://user:pw@example.com/a/b?utm_source=x&session=abc#frag'), 'https://example.com/a/b');
  assert.equal(sanitizeUrl('file:///etc/passwd'), '');
  assert.equal(sanitizeUrl('not a url'), '');
});

// ---- result parsing / ranking -------------------------------------------------------------------

test('normalizeResults coerces shape, dedupes and caps at 10', () => {
  const raw = [
    { title: ' A ', url: 'https://x.com/1?q=1', snippet: 'one  two' },
    { title: 'A', url: 'https://x.com/2', snippet: 'dup' },
    { title: '', url: 'https://x.com/3' },
    null,
    ...Array.from({ length: 20 }, (_, i) => ({ title: `T${i}`, domain: `d${i}.com` })),
  ];
  const out = normalizeResults(raw);
  assert.equal(out.length, 10);
  assert.deepEqual(out[0], { title: 'A', url: 'https://x.com/1?q=1', domain: 'x.com', snippet: 'one two' });
});

test('rankResults prefers results semantically closer to the title (lexical fallback and embeddings)', async () => {
  const results = [
    { title: 'Unrelated business article', domain: 'biz.com', snippet: 'quarterly earnings' },
    { title: 'Building Better Systems - distributed systems talk', domain: 'infoq.com', snippet: 'distributed systems architecture' },
  ];
  const lexical = await rankResults('Building Better Systems', results);
  assert.equal(lexical[0].domain, 'infoq.com');
  assert.ok(lexical[0].relevance > lexical[1].relevance);

  const vec = (s) => Float32Array.from(s.includes('systems') ? [1, 0] : [0, 1]);
  const embedded = await rankResults('Building Better Systems', results, { embed: async (t) => vec(t.toLowerCase()) });
  assert.equal(embedded[0].domain, 'infoq.com');
  assert.equal(embedded[0].relevance, 1);
  assert.equal(lexicalOverlap('a b', ''), 0);
});

test('assessEvidence grades none/low/medium/high', () => {
  assert.equal(assessEvidence([]), 'none');
  assert.equal(assessEvidence([{ relevance: 0.05, snippet: '' }]), 'none');
  assert.equal(assessEvidence([{ relevance: 0.2, snippet: 'x' }]), 'low');
  assert.equal(assessEvidence([{ relevance: 0.6, snippet: 'x' }]), 'medium');
  assert.equal(assessEvidence([{ relevance: 0.8, snippet: 'x' }, { relevance: 0.7, snippet: 'y' }]), 'high');
});

test('DuckDuckGo provider parses the HTML endpoint into structured results with URLs', async () => {
  const results = parseResultsHtml(sampleHtml);
  assert.equal(results.length, 2);
  assert.equal(results[0].domain, 'en.wikipedia.org');
  assert.match(results[0].url, /^https:\/\/en\.wikipedia\.org/);
  const calls = [];
  const provider = new DuckDuckGoSearchProvider({ fetchImpl: async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, text: async () => sampleHtml }; } });
  const out = await provider.search('linus torvalds interview');
  assert.equal(out.length, 2);
  assert.ok(calls[0].url.startsWith('https://html.duckduckgo.com/html/?q=linus'));
  assert.equal(calls[0].init.credentials, 'omit');
  const failing = new DuckDuckGoSearchProvider({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(failing.search('x'), /503/);
  assert.equal(await new DuckDuckGoSearchProvider({ fetchImpl: null }).isAvailable(), false);
});

// ---- rate limiting ------------------------------------------------------------------------------

test('RateLimiter enforces min interval, per-minute and per-session limits', () => {
  let now = 0;
  const rl = new RateLimiter({ minIntervalMs: 1000, maxPerMinute: 3, maxPerSession: 4, now: () => now });
  assert.equal(rl.check().ok, true);
  rl.record();
  assert.match(rl.check().reason, /too soon/);
  now = 1000; rl.record();
  now = 2000; rl.record();
  now = 3000; assert.match(rl.check().reason, /per-minute/);
  now = 61_000; assert.equal(rl.check().ok, true);
  rl.record();
  now = 200_000; assert.match(rl.check().reason, /session/);
  assert.equal(rl.getStats().rejected, 3);
});

// ---- search manager -----------------------------------------------------------------------------

const fixtures = {
  'building better systems': [
    { title: 'Building Better Systems – a talk on distributed systems', url: 'https://infoq.com/x', snippet: 'distributed systems and architecture' },
    { title: 'Business coaching: building better systems for your team', url: 'https://biz.example/y', snippet: 'management' },
  ],
};

function makeManager({ provider = new MockSearchProvider({ fixtures }), rateLimiter, now, ttlMs, embed } = {}) {
  let clock = 1_000_000;
  const cache = new PersistentCache('retrieval', { persist: false, now: () => clock, ttlMs });
  const manager = new SearchManager({ provider, cache, rateLimiter: rateLimiter ?? new RateLimiter({ minIntervalMs: 0 }), now: now ?? (() => clock), embed });
  return { manager, provider, cache, advance: (ms) => { clock += ms; } };
}

test('SearchManager: miss → provider call; hit → cached; results ranked and structured', async () => {
  const { manager, provider } = makeManager();
  const a = await manager.search({ title: 'Building Better Systems - Blog', domain: 'medium.com' });
  assert.equal(a.status, SEARCH_STATUS.OK);
  assert.equal(a.query, 'Building Better Systems');
  assert.equal(a.results[0].domain, 'infoq.com');
  assert.ok(['medium', 'high'].includes(a.evidenceQuality));
  const b = await manager.search({ title: 'building better systems' });
  assert.equal(b.status, SEARCH_STATUS.CACHED);
  assert.equal(b.cached, true);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(Object.keys(b.results[0]).sort(), ['domain', 'relevance', 'snippet', 'title', 'url']);
});

test('SearchManager: cache entries expire after the TTL', async () => {
  const { manager, provider, advance } = makeManager({ ttlMs: 1000 });
  await manager.search({ title: 'Building Better Systems' });
  advance(500);
  assert.equal((await manager.search({ title: 'Building Better Systems' })).cached, true);
  advance(600);
  assert.equal((await manager.search({ title: 'Building Better Systems' })).cached, false);
  assert.equal(provider.calls.length, 2);
});

test('SearchManager: concurrent identical queries share one request', async () => {
  const { manager, provider } = makeManager({ provider: new MockSearchProvider({ fixtures, delayMs: 20 }) });
  const out = await Promise.all([1, 2, 3].map(() => manager.search({ title: 'Building Better Systems' })));
  assert.equal(provider.calls.length, 1);
  assert.ok(out.every((o) => o.results.length === 2));
  assert.equal(manager.getStatus().dedupeHits, 2);
});

test('SearchManager: rate limited, empty, provider failure, timeout and unavailable are all non-throwing', async () => {
  const limited = makeManager({ rateLimiter: new RateLimiter({ maxPerSession: 1, minIntervalMs: 0 }) });
  await limited.manager.search({ title: 'Building Better Systems' });
  const r = await limited.manager.search({ title: 'Something else entirely' });
  assert.equal(r.status, SEARCH_STATUS.RATE_LIMITED);
  assert.deepEqual(r.results, []);

  const empty = await makeManager().manager.search({ title: 'Nothing known about this' });
  assert.equal(empty.status, SEARCH_STATUS.EMPTY);
  assert.equal(empty.evidenceQuality, 'none');

  const failing = makeManager({ provider: new MockSearchProvider({ failUnknown: true }) });
  const f = await failing.manager.search({ title: 'Network down please' });
  assert.equal(f.status, SEARCH_STATUS.ERROR);
  assert.equal(failing.manager.getStatus().failures, 1);

  class Slow extends MockSearchProvider { async search() { await new Promise((r) => setTimeout(r, 50)); return []; } }
  const slow = new SearchManager({ provider: new Slow(), cache: new PersistentCache('retrieval', { persist: false }), rateLimiter: new RateLimiter({ minIntervalMs: 0 }), timeoutMs: 10 });
  assert.equal((await slow.search({ title: 'Takes too long today' })).status, SEARCH_STATUS.TIMEOUT);

  class Off extends MockSearchProvider { async isAvailable() { return false; } }
  const off = new SearchManager({ provider: new Off(), cache: new PersistentCache('retrieval', { persist: false }) });
  assert.equal((await off.search({ title: 'No permission granted here' })).status, SEARCH_STATUS.UNAVAILABLE);
  assert.equal((await off.search({ title: '' })).status, SEARCH_STATUS.SKIPPED);
});

test('SearchManager never sends the goal or URL to the provider', async () => {
  const { manager, provider } = makeManager();
  await manager.search({ title: 'Building Better Systems', domain: 'medium.com', url: 'https://medium.com/@me/secret?token=1', goal: 'Study OS' });
  assert.equal(provider.calls[0], 'Building Better Systems');
});
