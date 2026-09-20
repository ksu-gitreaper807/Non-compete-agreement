/**
 * Small sliding-window rate limiter for outbound searches. All three limits are enforced:
 * minimum gap between requests, requests per minute, requests per session (background lifetime).
 */
export const RATE_LIMIT_DEFAULTS = Object.freeze({
  minIntervalMs: 2000,
  maxPerMinute: 10,
  maxPerSession: 300,
});

export class RateLimiter {
  constructor({ minIntervalMs, maxPerMinute, maxPerSession, now = () => Date.now() } = {}) {
    this.minIntervalMs = minIntervalMs ?? RATE_LIMIT_DEFAULTS.minIntervalMs;
    this.maxPerMinute = maxPerMinute ?? RATE_LIMIT_DEFAULTS.maxPerMinute;
    this.maxPerSession = maxPerSession ?? RATE_LIMIT_DEFAULTS.maxPerSession;
    this.now = now;
    this.recent = [];
    this.total = 0;
    this.rejected = 0;
  }

  /** @returns {{ ok: boolean, reason?: string }} */
  check() {
    const now = this.now();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.total >= this.maxPerSession) return reject(this, 'session limit reached');
    if (this.recent.length >= this.maxPerMinute) return reject(this, 'per-minute limit reached');
    const last = this.recent[this.recent.length - 1];
    if (last !== undefined && now - last < this.minIntervalMs) return reject(this, 'too soon after previous search');
    return { ok: true };
  }

  /** Call once the request is actually issued. */
  record() {
    this.recent.push(this.now());
    this.total++;
  }

  getStats() {
    return { total: this.total, lastMinute: this.recent.length, rejected: this.rejected, limits: { minIntervalMs: this.minIntervalMs, maxPerMinute: this.maxPerMinute, maxPerSession: this.maxPerSession } };
  }
}

function reject(limiter, reason) {
  limiter.rejected++;
  return { ok: false, reason };
}
