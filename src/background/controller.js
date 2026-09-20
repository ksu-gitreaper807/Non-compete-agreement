/**
 * Orchestrates the per-tab pipeline: normalise → cache → regex → embedding → policy → friction.
 * Pure of browser APIs (they are injected), so it can be exercised in tests.
 */
import { buildClassificationText, extractDomain, isSupportedUrl, normalizeTitle } from '../utils/text.js';
import { ClassifierPipeline, makeResult } from '../classifier/classifier.js';
import { decide, requiresFriction, DECISION } from '../classifier/policyEngine.js';
import { CLASSIFICATION, FRICTION_STATE } from '../storage/schema.js';
import { PersistentCache } from '../storage/cacheStore.js';
import { classificationKey, classificationConfigFingerprint } from '../storage/cacheKeys.js';

export class Controller {
  /**
   * @param {Object} deps
   * @param {import('../classifier/classifier.js').Classifier[]} deps.classifiers
   * @param {import('../blocking/frictionManager.js').FrictionManager} deps.friction
   * @param {import('../background/sessionTracker.js').SessionTracker} deps.sessions
   * @param {() => Promise<{settings, rules, anchors}>} deps.loadConfig
   * @param {(tabId: number, url: string) => Promise<void>} deps.navigate
   * @param {(params: Object) => string} deps.blockedPageUrl
   * @param {(tabId: number) => Promise<boolean>} [deps.isBlockedPage]
   * @param {PersistentCache} [deps.classificationCache]  final-decision cache (persistent)
   * @param {() => string} [deps.modelVersion]             part of the cache fingerprint
   */
  constructor(deps) {
    this.deps = deps;
    this.pipeline = new ClassifierPipeline(deps.classifiers, {
      fallback: () => makeResult(CLASSIFICATION.UNKNOWN, 'fallback', 'No signal available; allowed by default'),
    });
    this.classificationCache = deps.classificationCache ?? new PersistentCache('classification', { persist: false });
    this.modelVersion = deps.modelVersion ?? (() => 'none');
    this.config = null;
    this.configFingerprint = null;
    this.tabResults = new Map(); // tabId -> last outcome (tab-scoped, not a classification cache)
    this.inFlight = new Map(); // tabId -> promise
    this.activeTabId = null;
  }

  async getConfig() {
    if (!this.config) {
      this.config = await this.deps.loadConfig();
      this.configFingerprint = classificationConfigFingerprint({ ...this.config, modelVersion: this.modelVersion() });
    }
    return this.config;
  }

  /**
   * Called on storage changes so new settings/rules/anchors take effect immediately.
   * The persistent cache is not cleared: its keys embed a config fingerprint, so entries from
   * the old configuration simply stop matching and age out.
   */
  invalidateConfig() {
    this.config = null;
    this.configFingerprint = null;
    this.tabResults.clear();
  }

  /**
   * Classify a page without side effects (no friction, no session tracking).
   */
  async classifyPage({ url, title }) {
    const config = await this.getConfig();
    const { settings, rules, anchors } = config;
    const domain = extractDomain(url);
    const normalizedTitle = normalizeTitle(title);
    const text = buildClassificationText({ title: normalizedTitle, url });
    const goal = settings.weeklyGoal?.trim() ?? '';

    if (!goal) {
      return { ...makeResult(CLASSIFICATION.UNKNOWN, 'no-goal', 'Set a weekly goal to start classifying'), domain, title: normalizedTitle, text };
    }
    if (!text) {
      return { ...makeResult(CLASSIFICATION.UNKNOWN, 'no-title', 'Page has no title or readable URL'), domain, title: normalizedTitle, text };
    }

    const context = { url, domain, title: normalizedTitle, text, goal, settings, rules, anchors };
    const key = classificationKey({ domain, text, fingerprint: this.configFingerprint });
    const { value, cached, deduplicated } = await this.classificationCache.getOrCompute(key, async () => {
      const result = await this.pipeline.classify(context);
      const { trace, ...stored } = result; // trace is diagnostic; keep cached entries small
      return { ...stored, domain, title: normalizedTitle, text, cachedAt: Date.now(), trace };
    });
    return cached ? { ...value, cached: true } : deduplicated ? { ...value, deduplicated: true } : value;
  }

  /**
   * Main entry point when the active tab changes or its title/url updates.
   * Returns the outcome (classification + decision + friction state) or null if ignored.
   */
  async handleActiveTab(tab) {
    if (!tab || typeof tab.id !== 'number') return null;
    if (this.inFlight.has(tab.id)) return this.inFlight.get(tab.id);
    const promise = this.processTab(tab).finally(() => this.inFlight.delete(tab.id));
    this.inFlight.set(tab.id, promise);
    return promise;
  }

  async processTab(tab) {
    const { url, title, id: tabId } = tab;
    const config = await this.getConfig();

    if (this.deps.isBlockedPage?.(url)) {
      // Our own friction page: not screen time, nothing to classify.
      await this.deps.sessions.stop();
      return { ignored: true, reason: 'friction-page' };
    }

    if (!isSupportedUrl(url)) {
      await this.deps.sessions.stop();
      await this.deps.friction.abandonForTab(tabId);
      this.tabResults.delete(tabId);
      return { ignored: true, reason: 'unsupported-url' };
    }

    const domain = extractDomain(url);
    const previous = this.tabResults.get(tabId);
    if (previous && previous.url === url && previous.title === normalizeTitle(title) && previous.frictionState !== FRICTION_STATE.TEMPORARILY_ALLOWED) {
      // Same page already handled; only refresh session timing.
      await this.trackSession(previous);
      return previous;
    }

    // Navigating the tab to a different page abandons that tab's countdown (a completed
    // timer never transfers to a materially different page).
    await this.deps.friction.abandonForTab(tabId, { exceptUrl: url });

    const classification = await this.classifyPage({ url, title });
    const policy = decide(classification.classification, config.settings);
    const grant = await this.deps.friction.hasActiveGrant(domain);

    const outcome = {
      tabId,
      url,
      title: classification.title,
      domain,
      ...classification,
      decision: policy.decision,
      frictionSeconds: policy.frictionSeconds,
      overrideMinutes: policy.overrideMinutes,
      frictionState: grant ? FRICTION_STATE.TEMPORARILY_ALLOWED : null,
      grant: grant ?? null,
      handledAt: Date.now(),
    };

    if (requiresFriction(policy) && !grant) {
      const state = await this.deps.friction.startCountdown({
        tabId,
        domain,
        url,
        title: classification.title,
        classification: classification.classification,
        decision: policy.decision,
        score: classification.score,
        frictionSeconds: policy.frictionSeconds,
      });
      outcome.frictionState = state.state;
      outcome.generation = state.generation;
      this.tabResults.set(tabId, outcome);
      await this.deps.sessions.stop();
      await this.deps.navigate(
        tabId,
        this.deps.blockedPageUrl({
          url,
          domain,
          title: classification.title,
          classification: classification.classification,
          decision: policy.decision,
          score: classification.score,
          tabId,
        })
      );
      return outcome;
    }

    if (policy.decision !== DECISION.ALLOW && policy.frictionSeconds === 0 && !grant) {
      // WARN with "no friction" mode: allow but flag it.
      outcome.frictionState = FRICTION_STATE.UNLOCKED;
    }

    this.tabResults.set(tabId, outcome);
    await this.trackSession(outcome);
    return outcome;
  }

  async trackSession(outcome) {
    await this.deps.sessions.start({
      domain: outcome.domain,
      title: outcome.title,
      classification: outcome.classification,
      decision: outcome.decision,
      score: outcome.score,
      overridden: Boolean(outcome.grant),
    });
  }

  /**
   * Friction page asks for its state. Starts a fresh full countdown when none is running for
   * this tab (first visit, after a tab-switch reset, or after the grace window expired) —
   * but only while the tab is actually the active one, so a background tab cannot pre-run
   * its timer.
   */
  async getFrictionView({ domain, url, title, classification, decision, score, tabId }) {
    const config = await this.getConfig();
    let state = await this.deps.friction.getState({ tabId, domain });
    if (state.state === FRICTION_STATE.BLOCKED) {
      const policy = decide(classification, config.settings);
      if (!requiresFriction(policy)) {
        // Policy changed since the redirect: let the user through.
        return { state: FRICTION_STATE.UNLOCKED, remainingMs: 0, releaseImmediately: true, settings: publicSettings(config.settings) };
      }
      if (this.activeTabId !== null && this.activeTabId !== tabId) {
        return { state: FRICTION_STATE.BLOCKED, remainingMs: 0, inactive: true, goal: config.settings.weeklyGoal, settings: publicSettings(config.settings), url };
      }
      state = await this.deps.friction.startCountdown({
        tabId,
        domain,
        url,
        title,
        classification,
        decision,
        score,
        frictionSeconds: policy.frictionSeconds,
      });
    }
    return { ...state, goal: config.settings.weeklyGoal, settings: publicSettings(config.settings), url };
  }

  async continueFromFriction({ domain, url, tabId, generation }) {
    const config = await this.getConfig();
    const result = await this.deps.friction.grantAccess({ tabId, domain, generation, overrideMinutes: config.settings.overrideMinutes });
    if (result.ok && typeof tabId === 'number' && url) {
      this.tabResults.delete(tabId);
      await this.deps.navigate(tabId, url);
    }
    return result;
  }

  async leaveFriction({ tabId }) {
    await this.deps.friction.abandonCountdown(tabId, { reason: 'go-back' });
    if (typeof tabId === 'number') this.tabResults.delete(tabId);
  }

  /**
   * Tab lifecycle: the active tab changed. A running countdown on the previously active tab
   * is reset (full timer again on return); completed countdowns and grants are untouched.
   */
  async onActiveTabChanged(newTabId) {
    const previous = this.activeTabId;
    this.activeTabId = newTabId;
    if (previous === null || previous === newTabId) return false;
    const reset = await this.deps.friction.onTabDeactivated(previous);
    if (reset) this.tabResults.delete(previous);
    return reset;
  }

  /** Window lost focus entirely: treat as leaving the active tab. */
  async onFocusLost() {
    const previous = this.activeTabId;
    this.activeTabId = null;
    if (previous === null) return false;
    const reset = await this.deps.friction.onTabDeactivated(previous);
    if (reset) this.tabResults.delete(previous);
    return reset;
  }

  /** Called when a temporary grant expires; the caller re-evaluates matching tabs. */
  async onGrantExpired(domain) {
    for (const [tabId, outcome] of this.tabResults) {
      if (outcome.domain === domain) this.tabResults.delete(tabId);
    }
  }

  forgetTab(tabId) {
    this.tabResults.delete(tabId);
  }

  getTabResult(tabId) {
    return this.tabResults.get(tabId) ?? null;
  }
}

function publicSettings(settings) {
  return {
    frictionSeconds: settings.frictionSeconds,
    overrideMinutes: settings.overrideMinutes,
    weeklyGoal: settings.weeklyGoal,
  };
}
