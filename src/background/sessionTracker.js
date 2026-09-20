/**
 * Screen-time accounting. Tracks exactly one "current" session (the active tab of the focused
 * window) and rolls elapsed time into per-day statistics. Only domain + truncated title are
 * kept; URLs are never stored.
 */
import { createDayStats, dayKey, weekDayKeys, CLASSIFICATION } from '../storage/schema.js';

const MAX_SESSION_TITLE = 120;

export class SessionTracker {
  /**
   * @param {Object} deps
   * @param {() => Promise<Object>} deps.loadStats
   * @param {(stats: Object) => Promise<void>} deps.saveStats
   * @param {() => Promise<Array>} deps.loadSessions
   * @param {(sessions: Array) => Promise<void>} deps.saveSessions
   * @param {() => Promise<Object|null>} deps.loadCurrent
   * @param {(current: Object|null) => Promise<void>} deps.saveCurrent
   * @param {{ maxSessions: number, sessionRetentionDays: number }} deps.limits
   * @param {() => number} [deps.now]
   */
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
    this.current = undefined; // undefined = not loaded yet
    this.stats = null;
    this.sessions = null;
    this.queue = Promise.resolve();
  }

  /** Serialises mutations to avoid lost updates from concurrent tab events. */
  enqueue(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async ensureLoaded() {
    if (this.current === undefined) {
      this.current = (await this.deps.loadCurrent()) ?? null;
      this.stats = (await this.deps.loadStats()) ?? { days: {} };
      if (!this.stats.days) this.stats.days = {};
      this.sessions = (await this.deps.loadSessions()) ?? [];
    }
  }

  /**
   * Start tracking a new page. If the same domain/title/classification is already current,
   * nothing changes (avoids resetting on duplicate events).
   */
  async start({ domain, title, classification, decision, score, overridden = false }) {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const cur = this.current;
      if (cur && cur.domain === domain && cur.title === (title ?? '').slice(0, MAX_SESSION_TITLE) && cur.classification === classification && cur.overridden === overridden) {
        return cur;
      }
      await this.closeCurrent();
      this.current = {
        id: `${this.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        domain,
        title: String(title ?? '').slice(0, MAX_SESSION_TITLE),
        classification: classification ?? CLASSIFICATION.UNKNOWN,
        decision,
        score: score ?? null,
        startedAt: this.now(),
        lastFlushAt: this.now(),
        overridden: Boolean(overridden),
      };
      await this.deps.saveCurrent(this.current);
      return this.current;
    });
  }

  /** Stop tracking (window lost focus, user idle, no supported tab active). */
  async stop() {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      await this.closeCurrent();
    });
  }

  /** Periodically move elapsed time into stats without ending the session. */
  async flush() {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      if (!this.current) return;
      await this.accumulate(this.current, this.now());
      this.current.lastFlushAt = this.now();
      await this.deps.saveCurrent(this.current);
      await this.deps.saveStats(this.stats);
    });
  }

  async closeCurrent() {
    const cur = this.current;
    if (!cur) return;
    const end = this.now();
    await this.accumulate(cur, end);
    const durationMs = end - cur.startedAt;
    if (durationMs >= 1000) {
      this.sessions.push({
        id: cur.id,
        domain: cur.domain,
        title: cur.title,
        classification: cur.classification,
        decision: cur.decision,
        score: cur.score,
        startedAt: cur.startedAt,
        endedAt: end,
        overridden: cur.overridden,
      });
      this.trimSessions();
      await this.deps.saveSessions(this.sessions);
    }
    this.current = null;
    await this.deps.saveCurrent(null);
    await this.deps.saveStats(this.stats);
  }

  /** Adds time since lastFlushAt to the day bucket(s). Splits across midnight if needed. */
  async accumulate(session, until) {
    let from = session.lastFlushAt ?? session.startedAt;
    if (until <= from) return;
    while (from < until) {
      const key = dayKey(from);
      const nextMidnight = new Date(from);
      nextMidnight.setHours(24, 0, 0, 0);
      const segmentEnd = Math.min(until, nextMidnight.getTime());
      const ms = segmentEnd - from;
      const day = this.dayBucket(key);
      day[`${session.classification}Ms`] = (day[`${session.classification}Ms`] ?? 0) + ms;
      if (session.overridden) day.overrideMs += ms;
      from = segmentEnd;
    }
  }

  dayBucket(key) {
    if (!this.stats.days[key]) this.stats.days[key] = createDayStats();
    const bucket = this.stats.days[key];
    for (const [k, v] of Object.entries(createDayStats())) if (bucket[k] === undefined) bucket[k] = v;
    return bucket;
  }

  /** Counter events from the friction manager. */
  async recordEvent(event, payload = {}) {
    return this.enqueue(async () => {
      await this.ensureLoaded();
      const day = this.dayBucket(dayKey(this.now()));
      if (event === 'frictionTriggered') day.frictionTriggered++;
      else if (event === 'frictionCompleted') day.frictionCompleted++;
      else if (event === 'frictionAbandoned') day.frictionAbandoned++;
      else if (event === 'frictionReset') day.frictionReset++;
      else if (event === 'overrideExpired') day.overrideExpired++;
      else if (event === 'overrideGranted') {
        day.overrides++;
        day.overrideGrantedMs += Math.round((Number(payload.minutes) || 0) * 60000);
      }
      await this.deps.saveStats(this.stats);
    });
  }

  trimSessions() {
    const { maxSessions = 2000, sessionRetentionDays = 14 } = this.deps.limits ?? {};
    const cutoff = this.now() - sessionRetentionDays * 86400000;
    this.sessions = this.sessions.filter((s) => s.endedAt >= cutoff);
    if (this.sessions.length > maxSessions) this.sessions = this.sessions.slice(-maxSessions);
    // Trim stat days older than retention as well.
    for (const key of Object.keys(this.stats.days)) {
      if (new Date(key).getTime() < cutoff - 86400000) delete this.stats.days[key];
    }
  }

  /** Summary including the un-flushed part of the current session. */
  async getSummary() {
    await this.ensureLoaded();
    const now = this.now();
    const days = structuredClone(this.stats.days);
    if (this.current) {
      const tmpStats = this.stats;
      this.stats = { days };
      await this.accumulate(this.current, now);
      this.stats = tmpStats;
    }
    const today = sumDays(days, [dayKey(now)]);
    const week = sumDays(days, weekDayKeys(now));
    return { today, week, current: this.current ? { ...this.current } : null };
  }
}

export function sumDays(days, keys) {
  const total = createDayStats();
  for (const key of keys) {
    const d = days[key];
    if (!d) continue;
    for (const k of Object.keys(total)) total[k] += d[k] ?? 0;
  }
  return total;
}
