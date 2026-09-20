/**
 * DuckDuckGo SearchProvider (HTML endpoint, no API key). Fetches the results page for a short
 * query and parses it into { title, url, domain, snippet } objects.
 *
 * Privacy: this is the ONLY component that talks to a search engine. It is opt-in, is only
 * reached through SearchManager (cache + rate limiter) for pages the embedding layer could not
 * decide, and receives nothing but the query built by queryBuilder.js (title, optionally the
 * domain — never the URL or the goal). Cookies are never sent (`credentials: 'omit'`).
 */
import { SearchProvider } from './searchProvider.js';
import { extractDomain } from '../utils/text.js';

export const DDG_PROVIDER = 'ddg';
export const DDG_ENDPOINT = 'https://html.duckduckgo.com/html/';
export const DDG_ORIGIN_PATTERN = 'https://html.duckduckgo.com/*';
const MAX_RESULTS = 10;

/**
 * Parse DuckDuckGo's HTML results page without a DOM (works in the event page and in Node).
 * Tolerant of markup drift: it only relies on the `result__a` / `result__snippet` classes.
 */
export function parseResultsHtml(html, maxResults = MAX_RESULTS) {
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
    results.push({ title: title.slice(0, 160), url: href.startsWith('http') ? href : '', domain: extractDomain(href) || hostFromDdg(block), snippet: snippet.slice(0, 240) });
    if (results.length >= maxResults) break;
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

export class DuckDuckGoSearchProvider extends SearchProvider {
  /**
   * @param {Object} [options]
   * @param {typeof fetch} [options.fetchImpl]
   * @param {() => Promise<boolean>} [options.hasPermission]  optional host-permission check
   */
  constructor({ fetchImpl = globalThis.fetch?.bind(globalThis), hasPermission = async () => true } = {}) {
    super();
    this.fetchImpl = fetchImpl;
    this.hasPermission = hasPermission;
  }

  get name() {
    return DDG_PROVIDER;
  }

  async isAvailable() {
    if (!this.fetchImpl) return false;
    return this.hasPermission();
  }

  async search(query, { maxResults = MAX_RESULTS, signal } = {}) {
    const response = await this.fetchImpl(`${DDG_ENDPOINT}?q=${encodeURIComponent(query)}`, {
      method: 'GET',
      headers: { Accept: 'text/html' },
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'follow',
      signal,
    });
    if (!response.ok) throw new Error(`DuckDuckGo responded ${response.status}`);
    return parseResultsHtml(await response.text(), maxResults);
  }
}
