/**
 * Strict parsing/validation of the LLM's answer. Anything that is not a well-formed verdict is
 * rejected (`null`) — the caller then falls back to the embedding verdict. Never trusts prose.
 */
import { CLASSIFICATION } from '../storage/schema.js';

const ALLOWED = new Set([CLASSIFICATION.RELEVANT, CLASSIFICATION.QUESTIONABLE, CLASSIFICATION.IRRELEVANT]);
const MAX_REASON = 240;
const MAX_EVIDENCE_ITEMS = 5;
const MAX_EVIDENCE_LEN = 80;

/**
 * @param {string} text  raw model output
 * @param {{ contextText?: string }} [options]  lower-cased text the model was shown; evidence
 *   items not found in it are dropped (anti-hallucination) and flagged in `unsupportedEvidence`.
 * @returns {{ classification: string, confidence: number, reason: string, evidence: string[], unsupportedEvidence: string[] }|null}
 */
export function parseLlmResponse(text, { contextText = '' } = {}) {
  const obj = extractJson(text);
  if (!obj) return null;

  const classification = typeof obj.classification === 'string' ? obj.classification.trim().toLowerCase() : null;
  if (!ALLOWED.has(classification)) return null;

  const confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;

  const reason = typeof obj.reason === 'string' ? obj.reason.replace(/\s+/g, ' ').trim().slice(0, MAX_REASON) : '';
  const rawEvidence = Array.isArray(obj.evidence) ? obj.evidence : [];
  const evidence = [];
  const unsupportedEvidence = [];
  for (const item of rawEvidence.slice(0, MAX_EVIDENCE_ITEMS)) {
    if (typeof item !== 'string') continue;
    const phrase = item.replace(/\s+/g, ' ').trim().slice(0, MAX_EVIDENCE_LEN);
    if (!phrase) continue;
    if (!contextText || contextText.includes(phrase.toLowerCase())) evidence.push(phrase);
    else unsupportedEvidence.push(phrase);
  }
  return { classification, confidence: Math.round(confidence * 100) / 100, reason, evidence, unsupportedEvidence };
}

/** Find the first JSON object in the output (models sometimes wrap it in prose or ``` fences). */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  // Walk to the matching brace so trailing prose does not break JSON.parse.
  let depth = 0;
  let inString = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return safeParse(cleaned.slice(start, i + 1));
    }
  }
  return null;
}

function safeParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
