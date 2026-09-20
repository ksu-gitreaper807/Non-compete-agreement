/**
 * Builds and recognises friction-page URLs. Only the minimum needed to render the page is
 * passed in the query string; the authoritative state lives in the background.
 */
export const BLOCKED_PAGE_PATH = 'blocking/blocked.html';

export function buildBlockedPageUrl(baseUrl, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  return `${baseUrl}?${search.toString()}`;
}

export function isBlockedPageUrl(url, baseUrl) {
  return typeof url === 'string' && url.startsWith(baseUrl);
}

export function parseBlockedPageParams(search) {
  const p = new URLSearchParams(search);
  const tabId = Number(p.get('tabId'));
  return {
    url: p.get('url') ?? '',
    domain: p.get('domain') ?? '',
    title: p.get('title') ?? '',
    classification: p.get('classification') ?? 'irrelevant',
    decision: p.get('decision') ?? 'block',
    score: p.has('score') && p.get('score') !== 'null' ? Number(p.get('score')) : null,
    tabId: Number.isFinite(tabId) ? tabId : null,
    expired: p.get('expired') === '1',
    usedMinutes: p.has('usedMinutes') ? Number(p.get('usedMinutes')) : null,
  };
}
