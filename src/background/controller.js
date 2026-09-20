/**
 * Orchestrates the per-tab pipeline: normalise → cache → regex → embedding → policy → friction.
 * Pure of browser APIs (they are injected), so it can be exercised in tests.
 */
import { buildClassificationText, extractDomain, isSupportedUrl, normalizeTitle } from '../utils/text.js';
import { ClassifierPipeline, makeResult } from '../classifier/classifier.js';
import { decide, requiresFriction, DECISION } from '../classifier/policyEngine.js';
import { CLASSIFICATION, FRICTION_STATE } from '../storage/schema.js';
import { LruCache } from '../utils/lruCache.js';

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
   * @param {number} [deps.classificationCacheSize]
   */
  constructor(deps) {
    this.deps = deps;
    this.pipeline = new ClassifierPipeline(deps.classifiers, {
      fallback: () => makeResult(CLASSIFICATION.UNKNOWN, 'fallback', 'No signal available; allowed by default'),
    });
    this.classificationCache = new LruCache(deps.classificationCacheSize ?? 1000);
    this.config = null;
    this.tabResults = new Map(); // tabId -> last outcome
    this.inFlight = new Map(); // tabId -> promise
  }

  async getConfig() {
    if (!this.config) this.config = await this.deps.loadConfig();
    return this.config;
  }

  /** Called on storage changes so new settings/rules/anchors take effect immediately. */
  invalidateConfig() {
    this.config = null;
    this.classificationCache.clear();
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

    const cacheKey = `${domain}|${text.toLowerCase()}`;
    const cached = this.classificationCache.get(cacheKey);
    if (cached) return { ...cached, cached: true };

    const context = { url, domain, title: normalizedTitle, text, goal, settings, rules, anchors };
    const result = await this.pipeline.classify(context);
    const outcome = { ...result, domain, title: normalizedTitle, text };
    this.classificationCache.set(cacheKey, outcome);
    return outcome;
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

    // Leaving a friction page for a different domain abandons that countdown.
    await this.deps.friction.abandonForTab(tabId, { exceptDomain: domain });

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
        domain,
        title: classification.title,
        classification: classification.classification,
        decision: policy.decision,
        score: classification.score,
        frictionSeconds: policy.frictionSeconds,
        tabId,
      });
      outcome.frictionState = state.state;
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

  /** Friction page asks for its state; restarts the countdown if it expired while away. */
  async getFrictionView({ domain, url, title, classification, decision, score, tabId }) {
    const config = await this.getConfig();
    let state = await this.deps.friction.getState(domain);
    if (state.state === FRICTION_STATE.BLOCKED) {
      const policy = decide(classification, config.settings);
      if (!requiresFriction(policy)) {
        // Policy changed since the redirect: let the user through.
        return { state: FRICTION_STATE.UNLOCKED, remainingMs: 0, releaseImmediately: true, settings: publicSettings(config.settings) };
      }
      state = await this.deps.friction.startCountdown({
        domain,
        title,
        classification,
        decision,
        score,
        frictionSeconds: policy.frictionSeconds,
        tabId,
      });
    }
    return { ...state, goal: config.settings.weeklyGoal, settings: publicSettings(config.settings), url };
  }

  async continueFromFriction({ domain, url, tabId }) {
    const config = await this.getConfig();
    const result = await this.deps.friction.grantAccess({ domain, overrideMinutes: config.settings.overrideMinutes });
    if (result.ok && typeof tabId === 'number' && url) {
      this.tabResults.delete(tabId);
      await this.deps.navigate(tabId, url);
    }
    return result;
  }

  async leaveFriction({ domain, tabId }) {
    await this.deps.friction.abandonCountdown(domain, { reason: 'go-back' });
    if (typeof tabId === 'number') this.tabResults.delete(tabId);
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
