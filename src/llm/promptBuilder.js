/**
 * Builds the structured input for the local LLM judge. Kept separate from the runtime so it can
 * be unit-tested and reused by any adapter.
 *
 * The model receives ONLY: goal, page title, domain, the three similarity numbers and the
 * ranked web-context snippets. No URL, no history, no other tabs.
 */
export const MAX_CONTEXT_RESULTS = 5;

export const SYSTEM_PROMPT = [
  'You are a browsing-goal relevance classifier.',
  "Determine whether the page is relevant to the user's stated weekly goal.",
  'Do not judge whether the page is useful in general. Judge relevance only relative to the goal.',
  'Use the supplied page title, domain, semantic similarity information, and web-search context.',
  'Return ONLY valid JSON with this exact shape:',
  '{"classification":"relevant|questionable|irrelevant","confidence":0.0,"reason":"one sentence","evidence":["short phrase copied from the supplied context"]}',
  'Classifications:',
  'relevant: the page is reasonably related to the goal.',
  'questionable: there is insufficient evidence or the relationship is indirect or ambiguous.',
  'irrelevant: the page is clearly unrelated to the goal.',
  'Do not infer facts that are not present in the supplied information.',
  'If the supplied context does not establish what the page is about, answer questionable.',
].join('\n');

/**
 * @typedef {Object} LlmPayload
 * @property {string} goal
 * @property {{ title: string, domain?: string }} page
 * @property {{ goalSimilarity?: number|null, positiveSimilarity?: number|null, negativeSimilarity?: number|null }} [semantic]
 * @property {Array<{ title: string, domain?: string, snippet?: string }>} [webContext]
 */

/** Assemble the payload from pipeline state; strips everything the model must not see. */
export function buildLlmPayload({ goal, title, domain, semantic, webContext }) {
  const payload = { goal: String(goal ?? '').slice(0, 500), page: { title: String(title ?? '').slice(0, 300) } };
  if (domain) payload.page.domain = String(domain).slice(0, 100);
  if (semantic && (semantic.goalSimilarity != null || semantic.positiveSimilarity != null)) {
    payload.semantic = {
      goalSimilarity: num(semantic.goalSimilarity),
      positiveSimilarity: num(semantic.positiveSimilarity),
      negativeSimilarity: num(semantic.negativeSimilarity),
    };
  }
  const ctx = (webContext ?? []).slice(0, MAX_CONTEXT_RESULTS).map((r) => {
    const item = { title: String(r.title ?? '').slice(0, 160) };
    if (r.domain) item.domain = String(r.domain).slice(0, 100);
    if (r.snippet) item.snippet = String(r.snippet).slice(0, 240);
    return item;
  });
  if (ctx.length) payload.webContext = ctx;
  return payload;
}

/** @returns {Array<{role: string, content: string}>} chat messages */
export function buildMessages(payload) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: JSON.stringify(payload, null, 1) },
  ];
}

/** All text the model was shown, lower-cased, for the evidence-grounding check. */
export function payloadText(payload) {
  const parts = [payload.goal, payload.page?.title, payload.page?.domain];
  for (const r of payload.webContext ?? []) parts.push(r.title, r.domain, r.snippet);
  return parts.filter(Boolean).join(' \n ').toLowerCase();
}

function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
}
