/**
 * DuckDuckGo retrieval provider (HTML endpoint, no API key). Fetches the top results for a
 * short query and returns compact { title, domain, snippet } objects.
 *
 * Privacy: this is the ONLY component that talks to the network. It is opt-in, only runs for
 * pages the embedding layer could not decide, and sends nothing but the page title (never the
 * URL). Results are cached in the `retrieval` namespace (see cacheStore.js).
 */
import { retrievalKey } from '../storage/cacheKeys.js';
import { extractDomain, normalizeTitle } from '../utils/text.js';

export const DDG_PROVIDER = 'ddg';
export const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
export const DDG_ORIGIN_PATTERN = 'https://html.duckduckgo.com/*';
const DEFAULT_TIMEOUT_MS = 6000;
const MAX_RESULTS = 5;
const MAX_QUERY_LENGTH = 120;

/** Trim a page title into a search query. */
export function buildQuery(title) {
  return normalizeTitle(title)
    .replace(/\s[-–—|·•]\s.*$/, '') // drop " - YouTube", " | Site name" suffixes
    .slice(0, MAX_QUERY_LENGTH)
    .trim();
}

/**
 * Parse DuckDuckGo's HTML results page without a DOM (works in the event page and in Node).
 * Tolerant of markup drift: it only relies on the `result__a` / `result__snippet` classes.
 */
export function parseResultsHtml(html) {
  const results = [];
  if (typeof html !== 'string') return results;
  const blocks = html.split(/class="result\b/).slice(1);
  for (const block of blocks) {
    const link = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!link) continue;
    const href = decodeDdgRedirect(decodeEntities(link[1]));
    const title = cleanText(link[2]);
    const snippetMatch = /class="result__snippet"[^>]*>([\s\S]*?)<\/(a|div|span)>/i.exec(block);
    const snippet = snippetMatch ? cleanText(snippetMatch[1]) : '';
    if (!title) continue;
    results.push({ title: title.slice(0, 160), domain: extractDomain(href) || hostFromDdg(block), snippet: snippet.slice(0, 240) });
    if (results.length >= MAX_RESULTS) break;
  }
  return results;
}

function decodeDdgRedirect(href) {
  // DDG wraps links as //duckduckgo.com/l/?uddg=<encoded url>&rut=...
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

function hostFromDdg(block) {
  const m = /class="result__url"[^>]*>([\s\S]*?)</i.exec(block);
  return m ? cleanText(m[1]).replace(/^https?:\/\//, '').split('/')[0] : '';
}

function cleanText(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export class DuckDuckGoRetriever {
  /**
   * @param {Object} options
   * @param {import('../storage/cacheStore.js').PersistentCache} options.cache
   * @param {typeof fetch} [options.fetchImpl]
   * @param {() => Promise<boolean>} [options.hasPermission]  host-permission check
   * @param {number} [options.timeoutMs]
   */
  constructor({ cache, fetchImpl = globalThis.fetch?.bind(globalThis), hasPermission = async () => true, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.cache = cache;
    this.fetchImpl = fetchImpl;
    this.hasPermission = hasPermission;
    this.timeoutMs = timeoutMs;
    this.stats = { requests: 0, failures: 0, cacheHits: 0 };
    this.lastError = null;
  }

  get name() {
    return DDG_PROVIDER;
  }

  /**
   * @returns {Promise<{ query: string, results: Array, cached: boolean }|null>} null when unavailable
   */
  async search(title) {
    const query = buildQuery(title);
    if (!query) return null;
    if (!(await this.hasPermission())) {
      this.lastError = 'Host permission for html.duckduckgo.com not granted';
      return null;
    }
    const key = retrievalKey({ provider: DDG_PROVIDER, query });
    try {
      const { value, cached } = await this.cache.getOrCompute(key, () => this.fetchResults(query));
      if (cached) this.stats.cacheHits++;
      return value ? { query, results: value, cached } : null;
    } catch (e) {
      this.stats.failures++;
      this.lastError = String(e?.message ?? e);
      return null;
    }
  }

  async fetchResults(query) {
    if (!this.fetchImpl) throw new Error('fetch unavailable');
    this.stats.requests++;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const response = await this.fetchImpl(`${DDG_ENDPOINT}?q=${encodeURIComponent(query)}`, {
        method: 'GET',
        headers: { Accept: 'text/html' },
        credentials: 'omit',
        cache: 'no-store',
        signal: controller?.signal,
      });
      if (!response.ok) throw new Error(`DuckDuckGo responded ${response.status}`);
      const results = parseResultsHtml(await response.text());
      this.lastError = null;
      return results;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  getStatus() {
    return { provider: DDG_PROVIDER, ...this.stats, lastError: this.lastError };
  }
}
