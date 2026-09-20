/**
 * Search provider abstraction. The classifier never talks to a concrete engine; it talks to a
 * SearchManager, which talks to *a* SearchProvider. Providers return already-structured
 * results and nothing else (no raw HTML leaves this layer).
 *
 * @typedef {Object} SearchResult
 * @property {string} title
 * @property {string} url
 * @property {string} domain
 * @property {string} snippet
 */

export class SearchProvider {
  /** Short stable id, part of cache keys. */
  get name() {
    return 'base';
  }

  /** Whether the provider can currently be used (permissions, config). */
  async isAvailable() {
    return true;
  }

  /**
   * @param {string} query
   * @param {{ signal?: AbortSignal, maxResults?: number }} [options]
   * @returns {Promise<SearchResult[]>}
   */
  // eslint-disable-next-line no-unused-vars
  async search(query, options = {}) {
    throw new Error('search() not implemented');
  }
}

/**
 * Deterministic provider for tests and benchmarks. `fixtures` maps a normalised query to a
 * result list; unknown queries resolve to [] (or throw when `failUnknown` is set).
 */
export class MockSearchProvider extends SearchProvider {
  constructor({ fixtures = {}, delayMs = 0, failUnknown = false, normalize = (q) => q.toLowerCase().trim() } = {}) {
    super();
    this.fixtures = fixtures;
    this.delayMs = delayMs;
    this.failUnknown = failUnknown;
    this.normalize = normalize;
    this.calls = [];
  }

  get name() {
    return 'mock';
  }

  async search(query, { maxResults = 5 } = {}) {
    this.calls.push(query);
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const hit = this.fixtures[this.normalize(query)];
    if (!hit) {
      if (this.failUnknown) throw new Error(`no fixture for "${query}"`);
      return [];
    }
    return hit.slice(0, maxResults).map((r) => ({ title: r.title ?? '', url: r.url ?? '', domain: r.domain ?? '', snippet: r.snippet ?? '' }));
  }
}
