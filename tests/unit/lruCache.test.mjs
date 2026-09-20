import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../../src/utils/lruCache.js';

test('evicts least recently used entries', () => {
  const c = new LruCache(2);
  c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3);
  assert.equal(c.has('b'), false);
  assert.equal(c.has('a'), true);
  assert.equal(c.size, 2);
});
