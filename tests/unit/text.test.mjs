import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, extractDomain, parseUrl, urlToWords, buildClassificationText, domainMatches, hashString, splitGoalPhrases } from '../../src/utils/text.js';

test('normalizeTitle collapses whitespace and trims', () => {
  assert.equal(normalizeTitle('  Linux   Virtual\nMemory  '), 'Linux Virtual Memory');
  assert.equal(normalizeTitle(null), '');
  assert.equal(normalizeTitle(42), '');
});

test('extractDomain strips www and lowercases', () => {
  assert.equal(extractDomain('https://WWW.YouTube.com/watch?v=1'), 'youtube.com');
  assert.equal(extractDomain('not a url'), '');
  assert.equal(extractDomain('about:blank'), '');
});

test('parseUrl rejects unsupported schemes', () => {
  assert.equal(parseUrl('moz-extension://abc/x.html'), null);
  assert.equal(parseUrl('chrome://settings'), null);
  assert.ok(parseUrl('https://example.com'));
});

test('urlToWords produces readable words', () => {
  assert.equal(urlToWords('https://ex.com/watch/linux-virtual-memory_explained?x=1'), 'watch linux virtual memory explained x 1');
});

test('buildClassificationText falls back to URL words', () => {
  assert.equal(buildClassificationText({ title: '', url: 'https://ex.com/gaming-pcs' }), 'gaming pcs');
  assert.equal(buildClassificationText({ title: 'Hi', url: 'https://ex.com/gaming' }), 'Hi');
});

test('domainMatches handles subdomains', () => {
  assert.ok(domainMatches('m.youtube.com', 'youtube.com'));
  assert.ok(domainMatches('youtube.com', 'www.youtube.com'));
  assert.ok(!domainMatches('notyoutube.com', 'youtube.com'));
});

test('hashString is stable and hex', () => {
  assert.equal(hashString('abc'), hashString('abc'));
  assert.match(hashString('abc'), /^[0-9a-f]{8}$/);
  assert.notEqual(hashString('abc'), hashString('abd'));
});

test('splitGoalPhrases splits on conjunctions and strips verbs', () => {
  assert.deepEqual(splitGoalPhrases('Study operating systems and finish my C++ coursework.'), ['operating systems', 'finish my C++ coursework'].map((s) => s.replace(/^finish my /, 'finish my ')).map((s, i) => (i === 1 ? 'finish my C++ coursework' : s)));
  assert.deepEqual(splitGoalPhrases('Mathematics, machine learning & fitness'), ['Mathematics', 'machine learning', 'fitness']);
  assert.deepEqual(splitGoalPhrases(''), []);
});
