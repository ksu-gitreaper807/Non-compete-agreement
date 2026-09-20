/**
 * Authoritative friction state. Lives in the background and is persisted to storage so
 * reloads, tab re-opens and event-page restarts cannot reset a countdown or forge a grant.
 *
 * State per domain:
 *   countdowns[domain] = { domain, title, classification, decision, score, startedAt, unlockAt, tabId }
 *   grants[domain]     = { domain, grantedAt, expiresAt, classification, decision }
 *
 * Derived state (see `getState`):
 *   TEMPORARILY_ALLOWED  a grant exists and has not expired
 *   COUNTING_DOWN        a countdown exists and now < unlockAt
 *   UNLOCKED             a countdown exists, now >= unlockAt, and the grace window is open
 *   BLOCKED              nothing active; a new countdown must be started
 */
import { FRICTION_STATE } from '../storage/schema.js';

/** After the countdown unlocks the user has this long to press Continue before it resets. */
export const UNLOCK_GRACE_MS = 2 * 60 * 1000;

export class FrictionManager {
  /**
   * @param {Object} deps
   * @param {() => Promise<Object>} deps.load       returns { countdowns, grants }
   * @param {(state: Object) => Promise<void>} deps.save
   * @param {() => number} [deps.now]
   * @param {(event: string, payload: Object) => void} [deps.onEvent]  statistics hook
   */
  constructor({ load, save, now = () => Date.now(), onEvent = () => {} }) {
    this.load = load;
    this.save = save;
    this.now = now;
    this.onEvent = onEvent;
    this.state = null;
  }

  async ensureLoaded() {
    if (!this.state) {
      const loaded = (await this.load()) ?? {};
      this.state = { countdowns: loaded.countdowns ?? {}, grants: loaded.grants ?? {} };
      this.pruneExpired();
    }
    return this.state;
  }

  async persist() {
    await this.save(this.state);
  }

  pruneExpired() {
    const now = this.now();
    for (const [domain, grant] of Object.entries(this.state.grants)) {
      if (grant.expiresAt <= now) delete this.state.grants[domain];
    }
    for (const [domain, cd] of Object.entries(this.state.countdowns)) {
      if (cd.unlockAt + UNLOCK_GRACE_MS <= now) delete this.state.countdowns[domain];
    }
  }

  /** @returns {Promise<{state: string, unlockAt?: number, expiresAt?: number, remainingMs: number, countdown?: Object, grant?: Object}>} */
  async getState(domain) {
    await this.ensureLoaded();
    this.pruneExpired();
    const now = this.now();
    const grant = this.state.grants[domain];
    if (grant && grant.expiresAt > now) {
      return { state: FRICTION_STATE.TEMPORARILY_ALLOWED, expiresAt: grant.expiresAt, remainingMs: grant.expiresAt - now, grant };
    }
    const cd = this.state.countdowns[domain];
    if (cd) {
      if (cd.unlockAt > now) {
        return { state: FRICTION_STATE.COUNTING_DOWN, unlockAt: cd.unlockAt, remainingMs: cd.unlockAt - now, countdown: cd };
      }
      return { state: FRICTION_STATE.UNLOCKED, unlockAt: cd.unlockAt, remainingMs: 0, countdown: cd };
    }
    return { state: FRICTION_STATE.BLOCKED, remainingMs: 0 };
  }

  async hasActiveGrant(domain) {
    const s = await this.getState(domain);
    return s.state === FRICTION_STATE.TEMPORARILY_ALLOWED ? s.grant : null;
  }

  /**
   * Starts a countdown if none is running for this domain. Idempotent: a reload during the
   * countdown returns the existing one rather than restarting.
   */
  async startCountdown({ domain, title, classification, decision, score, frictionSeconds, tabId }) {
    await this.ensureLoaded();
    const current = await this.getState(domain);
    if (current.state === FRICTION_STATE.COUNTING_DOWN || current.state === FRICTION_STATE.UNLOCKED) {
      // Keep the timer but refresh metadata so the UI shows the latest page.
      Object.assign(current.countdown, { title, tabId, classification, decision, score });
      await this.persist();
      return current;
    }
    if (current.state === FRICTION_STATE.TEMPORARILY_ALLOWED) return current;

    const now = this.now();
    const seconds = Math.max(0, Number(frictionSeconds) || 0);
    this.state.countdowns[domain] = {
      domain,
      title: String(title ?? '').slice(0, 200),
      classification,
      decision,
      score: score ?? null,
      startedAt: now,
      unlockAt: now + seconds * 1000,
      tabId: tabId ?? null,
    };
    this.onEvent('frictionTriggered', { domain, classification });
    await this.persist();
    return this.getState(domain);
  }

  /**
   * Called when the user presses Continue. Only succeeds if the countdown has genuinely elapsed.
   */
  async grantAccess({ domain, overrideMinutes }) {
    await this.ensureLoaded();
    const current = await this.getState(domain);
    if (current.state === FRICTION_STATE.TEMPORARILY_ALLOWED) return { ok: true, ...current };
    if (current.state !== FRICTION_STATE.UNLOCKED) {
      return { ok: false, reason: 'Countdown has not finished', ...current };
    }
    const now = this.now();
    const minutes = Math.max(0.1, Number(overrideMinutes) || 5);
    const cd = current.countdown;
    this.state.grants[domain] = {
      domain,
      grantedAt: now,
      expiresAt: now + Math.round(minutes * 60 * 1000),
      classification: cd.classification,
      decision: cd.decision,
    };
    delete this.state.countdowns[domain];
    this.onEvent('frictionCompleted', { domain, classification: cd.classification });
    this.onEvent('overrideGranted', { domain, classification: cd.classification, minutes });
    await this.persist();
    return { ok: true, ...(await this.getState(domain)) };
  }

  /** User left during the countdown (Go Back, closed tab, navigated elsewhere). */
  async abandonCountdown(domain, { reason = 'left' } = {}) {
    await this.ensureLoaded();
    const cd = this.state.countdowns[domain];
    if (!cd) return false;
    delete this.state.countdowns[domain];
    this.onEvent('frictionAbandoned', { domain, classification: cd.classification, reason });
    await this.persist();
    return true;
  }

  /** Abandon any countdown attached to a tab that closed or navigated away. */
  async abandonForTab(tabId, { exceptDomain = null } = {}) {
    await this.ensureLoaded();
    let changed = false;
    for (const [domain, cd] of Object.entries(this.state.countdowns)) {
      if (cd.tabId === tabId && domain !== exceptDomain) {
        delete this.state.countdowns[domain];
        this.onEvent('frictionAbandoned', { domain, classification: cd.classification, reason: 'tab' });
        changed = true;
      }
    }
    if (changed) await this.persist();
    return changed;
  }

  async revokeGrant(domain) {
    await this.ensureLoaded();
    const existed = Boolean(this.state.grants[domain]);
    delete this.state.grants[domain];
    if (existed) await this.persist();
    return existed;
  }

  async listGrants() {
    await this.ensureLoaded();
    this.pruneExpired();
    return Object.values(this.state.grants);
  }
}
