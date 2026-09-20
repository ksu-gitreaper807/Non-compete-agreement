/**
 * Deterministic search-query construction and URL sanitisation.
 *
 * Privacy rules enforced here (see docs/CLASSIFICATION.md):
 *  - the primary query is the page title only; the user's goal is never part of a query;
 *  - the domain is appended only when the title is too generic to search on its own;
 *  - if a URL-derived query is ever needed it goes through `sanitizeUrl`, which keeps only
 *    origin + pathname (no query string, no fragment, no credentials).
 */
import { normalizeTitle, parseUrl } from '../utils/text.js';

export const MAX_QUERY_LENGTH = 120;
const MIN_INFORMATIVE_WORDS = 3;

const STOPWORDS = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'and', 'or', 'for', 'with', 'my', 'your', 'is', 'it', 'this', 'that', 'how', 'what', 'why', 'i', 'we', 'you']);
const GENERIC_WORDS = new Set(['episode', 'ep', 'part', 'chapter', 'update', 'latest', 'new', 'guide', 'complete', 'everything', 'need', 'know', 'interview', 'systems', 'system', 'home', 'page', 'untitled', 'video', 'watch', 'article', 'post', 'blog']);

/** Strip " - Site", " | Site", " · Site" suffixes; most titles carry the site name there. */
export function stripSiteSuffix(title) {
  return normalizeTitle(title).replace(/\s[-–—|·•]\s[^-–—|·•]{1,40}$/, '').trim();
}

/** Words that carry information (letters/digits, not stopwords). */
export function informativeWords(title) {
  return stripSiteSuffix(title)
    .toLowerCase()
    .split(/[^a-z0-9+#.]+/i)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * A title is "generic" when it has too few informative words or is made mostly of
 * boilerplate words ("Episode 42", "Complete Guide", "Latest Update").
 */
export function isGenericTitle(title) {
  const words = informativeWords(title);
  if (words.length < MIN_INFORMATIVE_WORDS) return true;
  const generic = words.filter((w) => GENERIC_WORDS.has(w) || /^\d+$/.test(w)).length;
  return generic / words.length >= 0.5;
}

/**
 * Build the search query for a page.
 * @param {{ title: string, domain?: string }} page
 * @returns {{ query: string, usedDomain: boolean }|null} null when nothing searchable remains
 */
export function buildSearchQuery({ title, domain }) {
  const base = stripSiteSuffix(title).slice(0, MAX_QUERY_LENGTH).trim();
  if (!base) return null;
  const usedDomain = Boolean(domain) && isGenericTitle(base);
  const query = usedDomain ? `${base} ${domain}`.slice(0, MAX_QUERY_LENGTH).trim() : base;
  return { query, usedDomain };
}

/** origin + pathname only; drops query, fragment, credentials, and returns '' for non-http(s). */
export function sanitizeUrl(url) {
  const parsed = parseUrl(url);
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return '';
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return `${parsed.origin}${parsed.pathname}`;
}
