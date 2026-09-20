/**
 * Text and URL normalisation helpers shared by the classifier layers.
 * All functions are pure and safe to call with malformed input.
 */

const SUPPORTED_SCHEMES = new Set(['http:', 'https:', 'file:']);

/** Common title suffixes such as " - YouTube" or " | Hacker News" are kept: they help the embedding. */
export function normalizeTitle(title) {
  if (typeof title !== 'string') return '';
  return title
    .replace(/\s+/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .trim()
    .slice(0, 300);
}

export function normalizeForMatching(text) {
  return normalizeTitle(text).toLowerCase();
}

/**
 * Parse a URL defensively. Returns null for malformed or unsupported URLs.
 */
export function parseUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!SUPPORTED_SCHEMES.has(parsed.protocol)) return null;
  return parsed;
}

export function isSupportedUrl(url) {
  return parseUrl(url) !== null;
}

/** Hostname without a leading "www." and lower-cased. */
export function extractDomain(url) {
  const parsed = parseUrl(url);
  if (!parsed) return '';
  return stripWww(parsed.hostname.toLowerCase());
}

export function stripWww(hostname) {
  return typeof hostname === 'string' ? hostname.replace(/^www\./, '') : '';
}

/** True if `domain` equals `candidate` or is a subdomain of it. */
export function domainMatches(domain, candidate) {
  if (!domain || !candidate) return false;
  const d = stripWww(domain.toLowerCase());
  const c = stripWww(candidate.toLowerCase().trim());
  return d === c || d.endsWith('.' + c);
}

/**
 * Turn a URL path into readable words. Used as a fallback when a page has no title.
 * "/watch/linux-virtual-memory_explained" -> "linux virtual memory explained"
 */
export function urlToWords(url) {
  const parsed = parseUrl(url);
  if (!parsed) return '';
  const raw = decodeURIComponentSafe(parsed.pathname + ' ' + parsed.search);
  return raw
    .replace(/[\/_\-+.?&=#%]+/g, ' ')
    .replace(/\b[a-f0-9]{8,}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Build the text that is embedded for a page. Title first; fall back to URL words.
 */
export function buildClassificationText({ title, url }) {
  const t = normalizeTitle(title);
  if (t) return t;
  return urlToWords(url);
}

/** Small, fast, non-cryptographic hash (FNV-1a 32-bit) used for cache keys. */
export function hashString(input) {
  let hash = 0x811c9dc5;
  const str = String(input);
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Split a natural-language goal into candidate topic phrases. */
export function splitGoalPhrases(goal) {
  const text = normalizeTitle(goal);
  if (!text) return [];
  return text
    .replace(/^(study|learn|learning|studying|practice|practicing|read|reading|work on|working on|finish|finishing|complete|completing|my|the)\s+/i, '')
    .split(/,|;|\band\b|\bplus\b|&|\//i)
    .map((p) => p.replace(/^(my|the|some|and)\s+/i, '').replace(/[.!]+$/, '').trim())
    .filter((p) => p.length >= 2);
}

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_\w+|igshid|ref|ref_src|ref_url|si|feature|_ga|yclid|vero_id|_hsenc|_hsmi|spm)$/i;

/** Remove common tracking parameters and fragments; keeps content-identifying params (e.g. ?v=). */
export function stripTrackingParams(url) {
  const parsed = parseUrl(url);
  if (!parsed) return '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.test(key)) parsed.searchParams.delete(key);
  }
  parsed.hash = '';
  return parsed.toString();
}

/**
 * Canonical title form for cache keys: Unicode NFKC, lower-case, typographic quotes/dashes
 * unified, whitespace collapsed, decorative edge punctuation trimmed. Internal punctuation is
 * kept so "C++" and "C" do not collide.
 */
export function normalizeTitleForKey(title) {
  return normalizeTitle(title)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-|•·:;,.!?]+|[\s\-|•·:;,.!?]+$/g, '')
    .trim();
}
