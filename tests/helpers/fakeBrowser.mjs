/**
 * Minimal in-memory stand-in for the WebExtension `browser` API, enough to boot the real
 * background script in Node and drive tab events. Not a full emulator.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function makeEvent() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    hasListener: (fn) => listeners.has(fn),
    emit: (...args) => Promise.all([...listeners].map((fn) => fn(...args))),
  };
}

export function createFakeBrowser({ root, now = () => Date.now() } = {}) {
  const store = new Map();
  const tabs = new Map();
  let nextTabId = 1;
  const navigations = [];

  const storage = {
    local: {
      get: async (keys) => {
        const list = keys == null ? [...store.keys()] : Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of list) if (store.has(k)) out[k] = structuredClone(store.get(k));
        return out;
      },
      set: async (obj) => {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: store.get(k), newValue: structuredClone(v) };
          store.set(k, structuredClone(v));
        }
        setTimeout(() => storage.onChanged.emit(changes, 'local'), 0);
      },
      clear: async () => store.clear(),
    },
    onChanged: makeEvent(),
  };

  const runtime = {
    id: 'fake-extension',
    getURL: (p) => (root ? pathToFileURL(path.join(root, p)).href : `moz-extension://fake/${p}`),
    onMessage: makeEvent(),
    onInstalled: makeEvent(),
    onStartup: makeEvent(),
    openOptionsPage: async () => {},
    sendMessage: async (message) => {
      const [first] = [...runtime.onMessage.listeners ?? []];
      throw new Error('use harness.sendMessage');
    },
  };

  const tabsApi = {
    onActivated: makeEvent(),
    onUpdated: makeEvent(),
    onRemoved: makeEvent(),
    get: async (id) => {
      if (!tabs.has(id)) throw new Error(`No tab ${id}`);
      return structuredClone(tabs.get(id));
    },
    query: async ({ active, lastFocusedWindow } = {}) => [...tabs.values()].filter((t) => (active === undefined || t.active === active)).map((t) => structuredClone(t)),
    update: async (id, props) => {
      const tab = tabs.get(id);
      if (!tab) throw new Error(`No tab ${id}`);
      if (props.url) {
        navigations.push({ tabId: id, url: props.url });
        tab.url = props.url;
        tab.title = props.url.includes('blocked.html') ? 'Take a pause' : tab.title;
      }
      return structuredClone(tab);
    },
    remove: async (id) => { tabs.delete(id); await tabsApi.onRemoved.emit(id, {}); },
  };

  const windows = { WINDOW_ID_NONE: -1, onFocusChanged: makeEvent(), get: async (id) => ({ id, focused: true }) };
  const alarms = { create: () => {}, onAlarm: makeEvent() };
  const idle = { onStateChanged: makeEvent(), setDetectionInterval: () => {} };

  const browser = { storage, runtime, tabs: tabsApi, windows, alarms, idle };

  const harness = {
    browser,
    store,
    navigations,
    async openTab({ url, title }) {
      const id = nextTabId++;
      for (const t of tabs.values()) t.active = false;
      tabs.set(id, { id, url, title, active: true, windowId: 1 });
      await tabsApi.onActivated.emit({ tabId: id, windowId: 1 });
      await tabsApi.onUpdated.emit(id, { status: 'complete', title }, structuredClone(tabs.get(id)));
      return id;
    },
    async navigateTab(id, { url, title }) {
      const tab = tabs.get(id);
      Object.assign(tab, { url, title });
      await tabsApi.onUpdated.emit(id, { url, title, status: 'complete' }, structuredClone(tab));
    },
    async sendMessage(type, payload, sender = {}) {
      const listeners = [];
      runtime.onMessage.addListener; // no-op for lint
      // Only one listener is registered by the background.
      const results = await runtime.onMessage.emit({ type, payload }, sender);
      return results.find((r) => r !== undefined);
    },
    tab: (id) => tabs.get(id),
    tick: async () => alarms.onAlarm.emit({ name: 'goalguard-tick' }),
  };
  return harness;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
