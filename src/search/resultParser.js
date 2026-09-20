/**
 * Normalises, de-duplicates and ranks search results before they reach the LLM.
 *
 * Ranking: optional embedding similarity between the page title and "result title: snippet"
 * (when an `embed` function is supplied), falling back to lexical word overlap. The first
 * engine result is *not* assumed authoritative.
 */
import { cosineSimilarity } from '../classifier/similarity.js';
import { extractDomain } from '../utils/text.js';
import { informativeWords } from './queryBuilder.js';

export const DEFAULT_MAX_RESULTS = 5;
export const HARD_MAX_RESULTS = 10;
const MAX_TITLE = 160;
const MAX_SNIPPET = 240;

/** Coerce a provider result into the canonical { title, url, domain, snippet } shape. */
export function normalizeResult(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = clean(raw.title).slice(0, MAX_TITLE);
  if (!title) return null;
  const url = typeof raw.url === 'string' ? raw.url.slice(0, 500) : '';
  const domain = clean(raw.domain) || extractDomain(url);
  const snippet = clean(raw.snippet).slice(0, MAX_SNIPPET);
  return { title, url, domain, snippet };
}

export function normalizeResults(list, maxResults = HARD_MAX_RESULTS) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const r = normalizeResult(raw);
    if (!r) continue;
    const key = `${r.domain}|${r.title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
    if (out.length >= Math.min(maxResults, HARD_MAX_RESULTS)) break;
  }
  return out;
}

/** Jaccard-style overlap of informative words in [0,1]. */
export function lexicalOverlap(a, b) {
  const wa = new Set(informativeWords(a));
  const wb = new Set(informativeWords(b));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.sqrt(wa.size * wb.size);
}

/**
 * Rank results by relevance to the page title.
 * @param {string} title  page title
 * @param {Array} results normalised results
 * @param {{ embed?: (text: string) => Promise<Float32Array>, maxResults?: number }} [options]
 * @returns {Promise<Array<{title,url,domain,snippet,relevance:number}>>}
 */
export async function rankResults(title, results, { embed = null, maxResults = DEFAULT_MAX_RESULTS } = {}) {
  const scored = [];
  let titleVec = null;
  if (embed) {
    try {
      titleVec = await embed(title);
    } catch {
      titleVec = null; // degrade to lexical ranking
    }
  }
  for (const r of results) {
    const text = r.snippet ? `${r.title}: ${r.snippet}` : r.title;
    let relevance = lexicalOverlap(title, text);
    if (titleVec) {
      try {
        relevance = Math.max(0, cosineSimilarity(titleVec, await embed(text)));
      } catch {
        /* keep lexical */
      }
    }
    scored.push({ ...r, relevance: round(relevance) });
  }
  scored.sort((a, b) => b.relevance - a.relevance);
  return scored.slice(0, Math.min(maxResults, HARD_MAX_RESULTS));
}

/**
 * How much the (ranked) results actually tell us about the page.
 * Thresholds are heuristics: embedding cosine ≥0.7 or lexical ≥0.5 means "clearly about it".
 */
export function assessEvidence(results, { usedEmbeddings = false } = {}) {
  if (!results?.length) return 'none';
  const strong = usedEmbeddings ? 0.7 : 0.5;
  const weak = usedEmbeddings ? 0.55 : 0.3;
  const withSnippet = results.filter((r) => r.snippet);
  const top = results[0].relevance ?? 0;
  const strongCount = results.filter((r) => (r.relevance ?? 0) >= strong).length;
  if (strongCount >= 2 && withSnippet.length >= 2) return 'high';
  if (top >= strong || (top >= weak && withSnippet.length >= 1)) return 'medium';
  if (top >= weak * 0.5) return 'low';
  return 'none';
}

function clean(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}

function round(x) {
  return Math.round(x * 1000) / 1000;
}
