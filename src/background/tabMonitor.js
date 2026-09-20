/**
 * Listens to Firefox tab/window events and forwards the active tab to the controller.
 * Debounces bursts of onUpdated events (title/url/status arrive separately).
 */
const DEBOUNCE_MS = 250;

export class TabMonitor {
  constructor({ browser, controller, onActiveTabChanged }) {
    this.browser = browser;
    this.controller = controller;
    this.onActiveTabChanged = onActiveTabChanged ?? (() => {});
    this.timers = new Map();
    this.lastFocusedWindowId = null;
  }

  start() {
    const { tabs, windows, idle } = this.browser;
    tabs.onActivated.addListener(({ tabId }) => this.schedule(tabId));
    tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (!tab.active) return;
      if ('url' in changeInfo || 'title' in changeInfo || changeInfo.status === 'complete') this.schedule(tabId);
    });
    tabs.onRemoved.addListener((tabId) => {
      this.cancel(tabId);
      this.controller.forgetTab(tabId);
      this.controller.deps.friction.abandonForTab(tabId).catch(() => {});
    });
    windows.onFocusChanged.addListener((windowId) => {
      if (windowId === windows.WINDOW_ID_NONE) {
        this.controller.deps.sessions.stop().catch(() => {});
        return;
      }
      this.lastFocusedWindowId = windowId;
      this.refreshActive().catch(() => {});
    });
    if (idle?.onStateChanged) {
      idle.setDetectionInterval?.(120);
      idle.onStateChanged.addListener((state) => {
        if (state === 'active') this.refreshActive().catch(() => {});
        else this.controller.deps.sessions.stop().catch(() => {});
      });
    }
    this.refreshActive().catch(() => {});
  }

  schedule(tabId) {
    this.cancel(tabId);
    this.timers.set(
      tabId,
      setTimeout(() => {
        this.timers.delete(tabId);
        this.evaluate(tabId).catch((e) => console.warn('[GoalGuard] tab evaluation failed', e));
      }, DEBOUNCE_MS)
    );
  }

  cancel(tabId) {
    const t = this.timers.get(tabId);
    if (t) clearTimeout(t);
    this.timers.delete(tabId);
  }

  async evaluate(tabId) {
    let tab;
    try {
      tab = await this.browser.tabs.get(tabId);
    } catch {
      return; // tab closed
    }
    if (!tab.active) return;
    const win = await this.browser.windows.get(tab.windowId).catch(() => null);
    if (win && !win.focused) return;
    const outcome = await this.controller.handleActiveTab(tab);
    this.onActiveTabChanged(tab, outcome);
  }

  async refreshActive() {
    const [tab] = await this.browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab) await this.evaluate(tab.id);
  }

  /** Re-run the pipeline for every tab currently on `domain` (used when grants expire). */
  async reevaluateDomain(domain) {
    const tabs = await this.browser.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url) continue;
      try {
        if (new URL(tab.url).hostname.replace(/^www\./, '') === domain && tab.active) {
          this.controller.forgetTab(tab.id);
          await this.evaluate(tab.id);
        }
      } catch {
        /* ignore malformed */
      }
    }
  }
}
