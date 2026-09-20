import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, requiresFriction } from '../../src/classifier/policyEngine.js';
import { DEFAULT_SETTINGS } from '../../src/storage/schema.js';

test('default policy maps classifications to decisions', () => {
  assert.equal(decide('relevant', DEFAULT_SETTINGS).decision, 'allow');
  assert.equal(decide('questionable', DEFAULT_SETTINGS).decision, 'warn');
  assert.equal(decide('irrelevant', DEFAULT_SETTINGS).decision, 'block');
  assert.equal(decide('unknown', DEFAULT_SETTINGS).decision, 'allow');
});

test('friction seconds follow policy and settings', () => {
  const s = { ...DEFAULT_SETTINGS, frictionSeconds: 30, questionableFrictionMode: 'short', questionableFrictionSeconds: 7 };
  assert.equal(decide('irrelevant', s).frictionSeconds, 30);
  assert.equal(decide('questionable', s).frictionSeconds, 7);
  assert.equal(decide('questionable', { ...s, questionableFrictionMode: 'none' }).frictionSeconds, 0);
  assert.equal(decide('questionable', { ...s, questionableFrictionMode: 'normal' }).frictionSeconds, 30);
  assert.equal(decide('relevant', s).frictionSeconds, 0);
});

test('disabled extension allows everything', () => {
  assert.equal(decide('irrelevant', { ...DEFAULT_SETTINGS, enabled: false }).decision, 'allow');
});

test('user can remap policy', () => {
  const s = { ...DEFAULT_SETTINGS, policy: { ...DEFAULT_SETTINGS.policy, irrelevant: 'warn', questionable: 'allow' } };
  assert.equal(decide('irrelevant', s).decision, 'warn');
  assert.equal(decide('questionable', s).decision, 'allow');
});

test('requiresFriction only for non-allow with positive delay', () => {
  assert.ok(requiresFriction({ decision: 'block', frictionSeconds: 10 }));
  assert.ok(!requiresFriction({ decision: 'warn', frictionSeconds: 0 }));
  assert.ok(!requiresFriction({ decision: 'allow', frictionSeconds: 10 }));
});
