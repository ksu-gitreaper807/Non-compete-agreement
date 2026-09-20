/**
 * Prompt construction and response parsing for the local LLM judge. Kept separate from the
 * model runtime so it can be unit-tested and reused by a different backend.
 */
import { CLASSIFICATION } from '../storage/schema.js';

export const SYSTEM_PROMPT =
  'You judge whether a web page is relevant to a person\'s current study or work goal. ' +
  'Answer with exactly one word: RELEVANT, QUESTIONABLE or IRRELEVANT, then one short sentence of reason.';

/**
 * @param {{ goal: string, title: string, domain?: string, previous?: Object, retrieval?: {results: Array} }} input
 * @returns {Array<{role: string, content: string}>} chat messages
 */
export function buildMessages({ goal, title, domain, previous, retrieval }) {
  const lines = [`Goal: ${goal}`, `Page title: ${title}`];
  if (domain) lines.push(`Site: ${domain}`);
  if (previous?.nearestPositive || previous?.nearestNegative) {
    lines.push(`Embedding hint: closest goal topic "${previous.nearestPositive ?? '-'}", closest distraction "${previous.nearestNegative ?? '-'}".`);
  }
  const results = retrieval?.results?.slice(0, 3) ?? [];
  if (results.length) {
    lines.push('Web context about this page:');
    for (const r of results) lines.push(`- ${r.title}${r.snippet ? `: ${r.snippet}` : ''}`);
  }
  lines.push('Is this page relevant to the goal? Answer RELEVANT, QUESTIONABLE or IRRELEVANT and explain briefly.');
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ];
}

/**
 * Parse the model's free-form answer. Returns null when no verdict word is present.
 * @returns {{ classification: string, reason: string }|null}
 */
export function parseVerdict(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  const m = /\b(IRRELEVANT|NOT RELEVANT|UNRELATED|QUESTIONABLE|UNCERTAIN|MAYBE|RELEVANT)\b/i.exec(cleaned);
  if (!m) return null;
  const word = m[1].toUpperCase();
  const classification =
    word === 'RELEVANT' ? CLASSIFICATION.RELEVANT
    : word === 'QUESTIONABLE' || word === 'UNCERTAIN' || word === 'MAYBE' ? CLASSIFICATION.QUESTIONABLE
    : CLASSIFICATION.IRRELEVANT;
  const reason = cleaned
    .slice(m.index + m[0].length)
    .replace(/^[\s:.,\-–—]+/, '')
    .split(/\n/)[0]
    .trim()
    .slice(0, 200);
  return { classification, reason: reason || `Model answered ${word}` };
}
