/**
 * Builds the structured input for the local LLM judge. Kept separate from the runtime so it can
 * be unit-tested and reused by any adapter.
 *
 * The model receives ONLY: goal, page title/domain/kind, the three similarity numbers, derived
 * hints about how much those signals are worth, and the ranked web-context snippets.
 * No URL, no history, no other tabs.
 *
 * Two things happen before the model sees anything:
 *  1. `buildSystemPrompt()` (promptContext.js) primes the model with what GoalGuard is, what the
 *     verdict does, how to read each field and which traps cause wrong verdicts;
 *  2. `buildHints()` turns signals the model cannot compute for itself (is the title generic?
 *     which way did the embedding layer lean? is there any context at all?) into explicit facts,
 *     so the model does not have to infer them from a bare string.
 */
import { buildSystemPrompt, buildFewShotMessages, PROMPT_CONTEXT_VERSION } from './promptContext.js';
import { isGenericTitle } from '../search/queryBuilder.js';

export { PROMPT_CONTEXT_VERSION };
export const MAX_CONTEXT_RESULTS = 5;

/** The default (no user notes) system prompt. Exported for tests and debugging. */
export const SYSTEM_PROMPT = buildSystemPrompt();

/**
 * @typedef {Object} LlmPayload
 * @property {string} goal
 * @property {{ title: string, domain?: string }} page
 * @property {{ goalSimilarity?: number|null, positiveSimilarity?: number|null, negativeSimilarity?: number|null }} [semantic]
 * @property {{ titleIsGeneric?: boolean, hasWebContext?: boolean, pageKind?: string, semanticVerdict?: string }} [hints]
 * @property {Array<{ title: string, domain?: string, snippet?: string }>} [webContext]
 */

/** Coarse page-kind hints. `null` when nothing matches — the model then relies on the text. */
const DOMAIN_KINDS = [
  [/^(?:www\.)?(?:m\.)?youtube\.com$|^(?:www\.)?youtu\.be$|vimeo\.com$|twitch\.tv$|netflix\.com$|dailymotion\.com$|^podcasts\.apple\.com$/, 'video'],
  [/^(?:www\.|old\.|np\.)?reddit\.com$|news\.ycombinator\.com$|stackoverflow\.com$|\.stackexchange\.com$|quora\.com$|discourse\.|^forum\.|community\./, 'forum'],
  [/^arxiv\.org$|^dl\.acm\.org$|ieeexplore\.ieee\.org$|^www\.ncbi\.nlm\.nih\.gov$|pubmed\.|link\.springer\.com$|sciencedirect\.com$|^www\.jstor\.org$|^academic\.oup\.com$|biorxiv\.org$|papers\.withcode\.com$/, 'paper'],
  [/^github\.com$|^gist\.github\.com$|^gitlab\.com$|^bitbucket\.org$|^codeberg\.org$|sourcegraph\.com$|^www\.npmjs\.com$|^pypi\.org$|^crates\.io$/, 'code'],
  [/^(?:www\.)?wikipedia\.org$|^en\.wikipedia\.org$|wiktionary\.org$|wikibooks\.org$|^www\.britannica\.com$/, 'reference'],
  [/\.readthedocs\.io$|readthedocs\.org$|devdocs\.io$|developer\.mozilla\.org$|learn\.microsoft\.com$|developer\.android\.com$|developer\.apple\.com$|^docs\.python\.org$|^cppreference\.com$|^man7\.org$|developer\.nvidia\.com$|^kubernetes\.io$/, 'docs'],
  [/^medium\.com$|\.substack\.com$|^dev\.to$|blogspot\.|^www\.blog\.|^hackernoon\.com$|^www\.freecodecamp\.org$/, 'blog'],
  [/^(?:www\.)?(?:x|twitter)\.com$|^www\.instagram\.com$|^www\.facebook\.com$|^www\.linkedin\.com$|^www\.tiktok\.com$|^www\.threads\.net$|mastodon\.|^bsky\.app$/, 'social'],
  [/^(?:www\.)?(?:amazon|ebay|flipkart|aliexpress|etsy|walmart|bestbuy)\./, 'shopping'],
  [/^(?:www\.)?(?:cnn|bbc|nytimes|theguardian|reuters|bloomberg|forbes|buzzfeed|dailymail|washingtonpost)\./, 'news'],
  [/^(?:www\.)?coursera\.org$|^www\.udemy\.com$|^www\.edx\.org$|^ocw\.mit\.edu$|^www\.khanacademy\.org$|nptel\.ac\.in$|^www\.udacity\.com$/, 'course'],
];

const TITLE_KINDS = [
  [/\b(?:lecture|lesson|course|class|tutorial|workshop|seminar)\b/i, 'course'],
  [/\b(?:documentation|docs?|api reference|manual|handbook|specification|changelog)\b/i, 'docs'],
  [/\b(?:watch|episode|stream|trailer|clip)\b/i, 'video'],
  [/\b(?:paper|preprint|arxiv|journal|thesis|dissertation)\b/i, 'paper'],
  [/\b(?:news|headlines|daily|breaking)\b/i, 'news'],
  [/\b(?:deals?|sale|shop|buy|price|discount|coupon)\b/i, 'shopping'],
  [/\b(?:reddit|thread|discussion|forum|question|answer)\b/i, 'forum'],
];

const HOMEPAGE_TITLES = /^(?:home|home ?page|welcome|start(?:page)?|dashboard|feed|my feed|news feed|inbox|new tab|untitled|sign in|log in|login|search results?|explore|discover|latest|news)$/i;

/**
 * Best-effort page kind from the domain and title only. Never looks at the URL, so nothing the
 * user might consider private enters the prompt — only a coarse, generic label.
 *
 * @param {{ title?: string, domain?: string }} page
 * @returns {string} one of video|forum|paper|code|reference|docs|blog|social|shopping|news|
 *   course|home|unknown
 */
export function guessPageKind({ title = '', domain = '' } = {}) {
  const d = String(domain ?? '').toLowerCase().trim();
  const t = String(title ?? '').trim();
  if (t && HOMEPAGE_TITLES.test(t.replace(/\s*[-–—|·•]\s*[^-–—|·•]{1,40}$/, '').trim())) return 'home';
  for (const [re, kind] of DOMAIN_KINDS) if (d && re.test(d)) return kind;
  for (const [re, kind] of TITLE_KINDS) if (t && re.test(t)) return kind;
  return 'unknown';
}

/**
 * Which way the embedding layer leaned, in words the model can use. `undecided` covers the
 * middle band *and* the case where the numbers are missing, so the prompt never implies a
 * signal that does not exist.
 */
export function semanticVerdict(semantic) {
  const goal = finiteOrNull(semantic?.goalSimilarity);
  const positive = finiteOrNull(semantic?.positiveSimilarity);
  const negative = finiteOrNull(semantic?.negativeSimilarity);
  const best = goal ?? positive;
  if (best == null) return 'unavailable';
  if (negative != null && best + 0.05 < negative) return 'leans-distraction';
  if (best > 0.5 && (negative == null || best > negative)) return 'leans-relevant';
  return 'undecided';
}

/** Derived facts the model cannot compute from the raw strings alone. */
export function buildHints({ title = '', domain = '', semantic = null, webContext = [] } = {}) {
  return {
    titleIsGeneric: isGenericTitle(String(title ?? '')),
    hasWebContext: (webContext ?? []).length > 0,
    pageKind: guessPageKind({ title, domain }),
    semanticVerdict: semanticVerdict(semantic),
  };
}

/**
 * Assemble the payload from pipeline state; strips everything the model must not see.
 * `hints` is computed here when the caller does not pass it, so every payload carries it.
 */
export function buildLlmPayload({ goal, title, domain, semantic, webContext, hints }) {
  const ctx = (webContext ?? []).slice(0, MAX_CONTEXT_RESULTS).map((r) => {
    const item = { title: String(r.title ?? '').slice(0, 160) };
    if (r.domain) item.domain = String(r.domain).slice(0, 100);
    if (r.snippet) item.snippet = String(r.snippet).slice(0, 240);
    return item;
  });
  const payload = {
    goal: String(goal ?? '').slice(0, 500),
    page: { title: String(title ?? '').slice(0, 300) },
  };
  if (domain) payload.page.domain = String(domain).slice(0, 100);
  if (semantic && (semantic.goalSimilarity != null || semantic.positiveSimilarity != null)) {
    payload.semantic = {
      goalSimilarity: num(semantic.goalSimilarity),
      positiveSimilarity: num(semantic.positiveSimilarity),
      negativeSimilarity: num(semantic.negativeSimilarity),
    };
  }
  payload.hints = { ...(hints ?? buildHints({ title, domain, semantic, webContext: ctx })), hasWebContext: ctx.length > 0 };
  if (ctx.length) payload.webContext = ctx;
  return payload;
}

/**
 * @param {LlmPayload} payload
 * @param {{ extraContext?: string, fewShot?: boolean }} [options]  `extraContext` = user notes
 *   from Options (appended to the system prompt); `fewShot` adds the worked examples, which the
 *   NLI judge ignores and small chat models benefit from.
 * @returns {Array<{role: string, content: string}>} chat messages
 */
export function buildMessages(payload, { extraContext = '', fewShot = true } = {}) {
  return [
    { role: 'system', content: buildSystemPrompt({ extraContext }) },
    ...(fewShot ? buildFewShotMessages() : []),
    { role: 'user', content: JSON.stringify(payload, null, 1) },
  ];
}

/**
 * Recover the payload from a message list (adapters and tools only get messages).
 * Scans backwards so few-shot example turns cannot shadow the real payload.
 *
 * @param {Array<{role?: string, content?: string}>} messages
 * @returns {LlmPayload|null}
 */
export function parsePayload(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i]?.role !== 'user') continue;
    try {
      const obj = JSON.parse(String(list[i].content ?? ''));
      if (obj && typeof obj === 'object' && !Array.isArray(obj) && ('goal' in obj || 'page' in obj)) return obj;
    } catch {
      /* keep scanning */
    }
  }
  return null;
}

/** All text the model was shown, lower-cased, for the evidence-grounding check. */
export function payloadText(payload) {
  const parts = [payload.goal, payload.page?.title, payload.page?.domain];
  for (const r of payload.webContext ?? []) parts.push(r.title, r.domain, r.snippet);
  return parts.filter(Boolean).join(' \n ').toLowerCase();
}

function finiteOrNull(x) {
  const n = typeof x === 'number' ? x : Number(x);
  return Number.isFinite(n) && x !== null && x !== '' ? n : null;
}

function num(x) {
  return typeof x === 'number' && Number.isFinite(x) ? Math.round(x * 100) / 100 : null;
}
