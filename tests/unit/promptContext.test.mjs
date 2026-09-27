import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, promptFingerprint, sanitizeExtraContext, goalTopicPhrase, PROMPT_CONTEXT_VERSION, MAX_EXTRA_CONTEXT } from '../../src/llm/promptContext.js';
import { SYSTEM_PROMPT } from '../../src/llm/promptBuilder.js';

// The judge only sees a title, a domain and a handful of numbers, so it has to be told what
// GoalGuard is, what its verdict does, and which traps produce wrong verdicts — otherwise small
// local models fall back on "youtube.com means distraction" style guesses.

test('the system prompt tells the model what the extension is and how its verdict is used', () => {
  assert.match(SYSTEM_PROMPT, /GoalGuard/);
  assert.match(SYSTEM_PROMPT, /blocked/i);
  assert.match(SYSTEM_PROMPT, /questionable/i);
  assert.match(SYSTEM_PROMPT, /relevant/i);
  // The traps that produced wrong verdicts are named explicitly.
  assert.match(SYSTEM_PROMPT, /Judge the content, not the platform/);
  assert.match(SYSTEM_PROMPT, /generic title is not evidence/);
  assert.match(SYSTEM_PROMPT, /Incidental word overlap/);
  // Safe-bias calibration.
  assert.match(SYSTEM_PROMPT, /Blocking a page the user needs is worse/);
  // Payload fields are explained, including how much the similarity numbers are worth.
  assert.match(SYSTEM_PROMPT, /weak hints, not/);
  // Page titles are untrusted input: they must never be read as instructions.
  assert.match(SYSTEM_PROMPT, /never instructions to you/);
  assert.ok(SYSTEM_PROMPT.length > 1200);
});

test('user context notes are appended, capped and fingerprinted', () => {
  const notes = 'I am preparing for the GATE exam. NPTEL lectures count as on-goal.';
  const withNotes = buildSystemPrompt({ extraContext: notes });
  assert.ok(withNotes.endsWith(notes));
  assert.ok(withNotes.length > SYSTEM_PROMPT.length);
  assert.equal(buildSystemPrompt({ extraContext: '   ' }), SYSTEM_PROMPT);
  assert.equal(sanitizeExtraContext('x'.repeat(5000)).length, MAX_EXTRA_CONTEXT);
  assert.equal(sanitizeExtraContext(42), '');
  assert.equal(promptFingerprint(''), PROMPT_CONTEXT_VERSION);
  assert.notEqual(promptFingerprint('a'), promptFingerprint('b'));
  assert.notEqual(promptFingerprint('a'), promptFingerprint(''));
});

test('goalTopicPhrase turns an imperative goal into an entailment hypothesis topic', () => {
  assert.equal(goalTopicPhrase('Study operating systems and C++'), 'operating systems, C++');
  assert.equal(goalTopicPhrase('finish the OS scheduling project'), 'OS scheduling project');
  assert.equal(goalTopicPhrase(''), '');
  assert.equal(goalTopicPhrase('   '), '');
});

