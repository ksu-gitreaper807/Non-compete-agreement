/**
 * Authoritative friction state. Lives in the background and is persisted to storage so
 * reloads, tab re-opens and event-page restarts cannot reset a countdown or forge a grant.
 *
 * Two independent kinds of state:
 *
 *   countdowns[tabId] = { tabId, domain, url, title, classification, decision, score,
 *                         generation, startedAt, unlockAt }
 *       Per-tab timer. Invalidated (not paused) when the tab stops being the active tab of
 *       the focused window while still counting down, and when the tab navigates to a
 *       different page. Every (re)start bumps `generation`; a Continue request must present
 *       the current generation, so stale callbacks can never grant access.
 *
 *   grants[domain]    = { domain, grantedAt, expiresAt, classification, decision }
 *       Temporary access after the user explicitly pressed Continue. Domain-scoped and
 *       independent of tab lifetime.
 *
 * Derived state per tab (see `getState`):
 *   TEMPORARILY_ALLOWED  a grant for the domain exists and has not expired
 *   COUNTING_DOWN        countdown exists and now < unlockAt
 *   UNLOCKED             countdown exists, now >= unlockAt, and the grace window is open
 *   BLOCKED              nothing active; a fresh full countdown must be started
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
    this.generationCounter = 0;
  }

  async ensureLoaded() {
    if (!this.state) {
      const loaded = (await this.load()) ?? {};
      const countdowns = {};
      for (const [key, cd] of Object.entries(loaded.countdowns ?? {})) {
        // Ignore legacy domain-keyed entries (pre per-tab schema).
        if (cd && typeof cd.tabId === 'number' && String(cd.tabId) === key) countdowns[key] = cd;
      }
      this.state = { countdowns, grants: loaded.grants ?? {}, generationCounter: loaded.generationCounter ?? 0 };
      this.generationCounter = this.state.generationCounter;
      this.pruneExpired();
    }
    return this.state;
  }

  async persist() {
    this.state.generationCounter = this.generationCounter;
    await this.save(this.state);
  }

  nextGeneration() {
    this.generationCounter += 1;
    return this.generationCounter;
  }

  pruneExpired() {
    const now = this.now();
    for (const [domain, grant] of Object.entries(this.state.grants)) {
      if (grant.expiresAt <= now) delete this.state.grants[domain];
    }
    for (const [tabId, cd] of Object.entries(this.state.countdowns)) {
      if (cd.unlockAt + UNLOCK_GRACE_MS <= now) delete this.state.countdowns[tabId];
    }
  }

  /**
   * @param {{tabId:number, domain:string}} ref
   * @returns {Promise<{state: string, unlockAt?: number, expiresAt?: number, remainingMs: number, generation?: number, countdown?: Object, grant?: Object}>}
   */
  async getState({ tabId, domain }) {
    await this.ensureLoaded();
    this.pruneExpired();
    const now = this.now();
    const grant = domain ? this.state.grants[domain] : null;
    if (grant && grant.expiresAt > now) {
      return { state: FRICTION_STATE.TEMPORARILY_ALLOWED, expiresAt: grant.expiresAt, remainingMs: grant.expiresAt - now, grant };
    }
    const cd = this.state.countdowns[tabId];
    if (cd && (!domain || cd.domain === domain)) {
      if (cd.unlockAt > now) {
        return { state: FRICTION_STATE.COUNTING_DOWN, unlockAt: cd.unlockAt, remainingMs: cd.unlockAt - now, generation: cd.generation, countdown: cd };
      }
      return { state: FRICTION_STATE.UNLOCKED, unlockAt: cd.unlockAt, remainingMs: 0, generation: cd.generation, countdown: cd };
    }
    return { state: FRICTION_STATE.BLOCKED, remainingMs: 0 };
  }

  async hasActiveGrant(domain) {
    const s = await this.getState({ tabId: -1, domain });
    return s.state === FRICTION_STATE.TEMPORARILY_ALLOWED ? s.grant : null;
  }

  /**
   * Starts a countdown for a tab if none is running for the same page. Idempotent for the
   * same tab+url (a reload keeps the timer); a different url in the same tab restarts it.
   */
  async startCountdown({ tabId, domain, url, title, classification, decision, score, frictionSeconds }) {
    await this.ensureLoaded();
    const current = await this.getState({ tabId, domain });
    if (current.state === FRICTION_STATE.TEMPORARILY_ALLOWED) return current;
    if ((current.state === FRICTION_STATE.COUNTING_DOWN || current.state === FRICTION_STATE.UNLOCKED) && samePage(current.countdown.url, url)) {
      Object.assign(current.countdown, { title, classification, decision, score });
      await this.persist();
      return current;
    }
    if (current.countdown) {
      // Same tab, materially different page: the old timer does not transfer.
      this.onEvent('frictionReset', { domain: current.countdown.domain, classification: current.countdown.classification, reason: 'navigation' });
    }
    const now = this.now();
    const seconds = Math.max(0, Number(frictionSeconds) || 0);
    this.state.countdowns[tabId] = {
      tabId,
      domain,
      url: url ?? null,
      title: String(title ?? '').slice(0, 200),
      classification,
      decision,
      score: score ?? null,
      generation: this.nextGeneration(),
      startedAt: now,
      unlockAt: now + seconds * 1000,
    };
    this.onEvent('frictionTriggered', { domain, classification });
    await this.persist();
    return this.getState({ tabId, domain });
  }

  /**
   * Called when the user presses Continue. Succeeds only if the countdown for this tab has
   * genuinely elapsed and the caller presents the current generation.
   */
  async grantAccess({ tabId, domain, generation, overrideMinutes }) {
    await this.ensureLoaded();
    const current = await this.getState({ tabId, domain });
    if (current.state === FRICTION_STATE.TEMPORARILY_ALLOWED) return { ok: true, ...current };
    if (current.state !== FRICTION_STATE.UNLOCKED) {
      return { ok: false, reason: current.state === FRICTION_STATE.COUNTING_DOWN ? 'Countdown has not finished' : 'Countdown was reset', ...current };
    }
    if (generation !== undefined && generation !== current.generation) {
      return { ok: false, reason: 'Countdown was reset', ...current };
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
    delete this.state.countdowns[tabId];
    this.onEvent('frictionCompleted', { domain, classification: cd.classification });
    this.onEvent('overrideGranted', { domain, classification: cd.classification, minutes });
    await this.persist();
    return { ok: true, ...(await this.getState({ tabId, domain })) };
  }

  /**
   * Tab lost focus (another tab activated, window blurred). A *running* countdown is
   * invalidated so the user must wait the full duration again; a completed (UNLOCKED)
   * countdown is preserved.
   * @returns {Promise<boolean>} true if a running countdown was reset
   */
  async onTabDeactivated(tabId) {
    await this.ensureLoaded();
    const cd = this.state.countdowns[tabId];
    if (!cd) return false;
    if (cd.unlockAt <= this.now()) return false; // completed first: completion wins
    delete this.state.countdowns[tabId];
    this.onEvent('frictionReset', { domain: cd.domain, classification: cd.classification, reason: 'tab-switch' });
    await this.persist();
    return true;
  }

  /** User left during the countdown (Go Back). */
  async abandonCountdown(tabId, { reason = 'left' } = {}) {
    await this.ensureLoaded();
    const cd = this.state.countdowns[tabId];
    if (!cd) return false;
    delete this.state.countdowns[tabId];
    this.onEvent('frictionAbandoned', { domain: cd.domain, classification: cd.classification, reason });
    await this.persist();
    return true;
  }

  /** Tab closed or navigated to an unrelated page: drop its countdown. */
  async abandonForTab(tabId, { exceptUrl = null } = {}) {
    await this.ensureLoaded();
    const cd = this.state.countdowns[tabId];
    if (!cd) return false;
    if (exceptUrl && samePage(cd.url, exceptUrl)) return false;
    delete this.state.countdowns[tabId];
    this.onEvent('frictionAbandoned', { domain: cd.domain, classification: cd.classification, reason: 'tab' });
    await this.persist();
    return true;
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

  async listCountdowns() {
    await this.ensureLoaded();
    this.pruneExpired();
    return Object.values(this.state.countdowns);
  }
}

function samePage(a, b) {
  if (!a || !b) return a === b;
  return stripHash(a) === stripHash(b);
}

function stripHash(u) {
  const i = u.indexOf('#');
  return i === -1 ? u : u.slice(0, i);
}
