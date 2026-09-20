import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAnchors } from '../../src/classifier/anchors.js';

test('generates positive anchors from goal phrases and expansions', () => {
  const a = generateAnchors('Study operating systems and C++');
  assert.ok(a.positive.includes('operating systems'));
  assert.ok(a.positive.includes('virtual memory'));
  assert.ok(a.positive.includes('c++ programming'));
  assert.ok(a.negative.length > 0);
});

test('empty goal yields no positive anchors', () => {
  assert.deepEqual(generateAnchors('').positive, []);
});

test('keeps user negative anchors when provided', () => {
  const a = generateAnchors('Fitness', { existingNegative: ['fast food'] });
  assert.deepEqual(a.negative, ['fast food']);
});
