import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePattern, compilePatterns, firstMatch } from '../../src/utils/regex.js';
import { RegexClassifier, goalTermPatterns } from '../../src/classifier/regexClassifier.js';
import { DEFAULT_SETTINGS } from '../../src/storage/schema.js';

const classifier = new RegexClassifier();
const base = { url: 'https://example.com/page', domain: 'example.com', goal: 'Study operating systems and C++', settings: { ...DEFAULT_SETTINGS }, rules: { allow: [], block: [] }, anchors: {} };

test('validatePattern accepts valid and rejects invalid regexes', () => {
  assert.equal(validatePattern('\\bOSTEP\\b').valid, true);
  assert.equal(validatePattern('(unclosed').valid, false);
  assert.equal(validatePattern('').valid, false);
  assert.equal(validatePattern('\\-dash').valid, true);
});

test('compilePatterns never throws and reports invalid ones', () => {
  const { compiled, invalid } = compilePatterns(['ok', '[bad', 'C\\+\\+']);
  assert.equal(compiled.length, 2);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].pattern, '[bad');
});

test('matching is case-insensitive', () => {
  const { compiled } = compilePatterns(['\\bostep\\b']);
  assert.equal(firstMatch(compiled, 'OSTEP - Processes'.toLowerCase()), '\\bostep\\b');
  assert.equal(firstMatch(compiled, 'nothing here'), null);
});

test('user block beats user allow', async () => {
  const ctx = { ...base, title: 'OSTEP on Netflix', rules: { allow: ['ostep'], block: ['netflix'] } };
  const r = await classifier.classify(ctx);
  assert.equal(r.classification, 'irrelevant');
  assert.equal(r.source, 'rule:block');
});

test('user allow beats automatic block', async () => {
  const ctx = { ...base, url: 'https://www.twitch.tv/lectures', domain: 'twitch.tv', title: 'OS lecture stream', rules: { allow: ['lecture'], block: [] } };
  const r = await classifier.classify(ctx);
  assert.equal(r.classification, 'relevant');
  assert.equal(r.source, 'rule:allow');
});

test('automatic block applies to built-in hosts', async () => {
  const ctx = { ...base, url: 'https://www.netflix.com/browse', domain: 'netflix.com', title: 'Home' };
  const r = await classifier.classify(ctx);
  assert.equal(r.classification, 'irrelevant');
  assert.equal(r.source, 'auto:block');
});

test('blocked domain list matches subdomains and precedes everything', async () => {
  const ctx = { ...base, url: 'https://old.reddit.com/r/cpp', domain: 'old.reddit.com', title: 'C++ tips', settings: { ...DEFAULT_SETTINGS, blockedDomains: ['reddit.com'] }, rules: { allow: ['c\\+\\+'], block: [] } };
  const r = await classifier.classify(ctx);
  assert.equal(r.source, 'rule:block-domain');
});

test('goal terms in the title auto-allow', async () => {
  const ctx = { ...base, title: 'Intro to Operating Systems – Lecture 3' };
  const r = await classifier.classify(ctx);
  assert.equal(r.classification, 'relevant');
  assert.equal(r.source, 'auto:allow');
});

test('goal term patterns require whole words', () => {
  const { compiled } = compilePatterns(goalTermPatterns('Learn Rust'));
  assert.equal(firstMatch(compiled, 'rust programming'), compiled[0].pattern);
  assert.equal(firstMatch(compiled, 'trustworthy news'), null);
});

test('returns null when no rule applies (defers to semantic layer)', async () => {
  const r = await classifier.classify({ ...base, title: 'Linus Torvalds Interview' });
  assert.equal(r, null);
});

test('invalid user regexes are ignored, not fatal', async () => {
  const ctx = { ...base, title: 'Anything', rules: { allow: ['[oops'], block: ['(also'] } };
  const r = await classifier.classify(ctx);
  assert.equal(r, null);
});
