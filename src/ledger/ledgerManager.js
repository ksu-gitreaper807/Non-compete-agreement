/**
 * Intent Ledger — user-declared reasons for opening a site, collected at friction time and
 * executed later in a deliberate session.
 *
 * Deliberately separate from classification caches, friction state and session tracking:
 * an entry exists only because the user typed one. Nothing here is inferred from browsing,
 * nothing leaves the device, and the ledger never grants access (opening a task goes through
 * the normal classifier/friction path like any other navigation).
 *
 * Storage is a single `ledger` key in storage.local: { entries: Entry[], session }.
 */

export const LEDGER_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  DISMISSED: 'dismissed',
});

/** Statuses that count as "still to do". */
export const OPEN_STATUSES = Object.freeze([LEDGER_STATUS.PENDING, LEDGER_STATUS.IN_PROGRESS]);

export const LEDGER_LIMITS = Object.freeze({
  maxEntries: 1000,
  maxIntentChars: 200,
  maxTitleChars: 200,
  duplicateWindowMs: 7 * 24 * 60 * 60 * 1000,
  completedRetentionDays: 30, // 0 = keep forever
});

/**
 * Normalisation used ONLY for duplicate detection and search — the stored `intent` is always
 * the user's exact wording. Lower-case, strip punctuation, drop a few filler words.
 */
const FILLERS = new Set(['the', 'a', 'an', 'to', 'my', 'on', 'of', 'for', 'in', 'about', 'and', 'that', 'this']);
export function normalizeIntent(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s#]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w && !FILLERS.has(w))
    .join(' ');
}

export function generateId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * @typedef {Object} LedgerEntry
 * @property {string} id
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {string} domain
 * @property {string|null} url           supporting context only; may go stale
 * @property {string} titleAtCreation
 * @property {string} intent             the user's exact words (primary data)
 * @property {string} normalizedIntent   derived, for matching only
 * @property {'pending'|'in_progress'|'completed'|'dismissed'} status
 * @property {number|null} completedAt
 * @property {'friction'|'ledger'|'popup'} source
 */

export class LedgerManager {
  /**
   * @param {Object} deps
   * @param {() => Promise<Object|null>} deps.load
   * @param {(state: Object) => Promise<void>} deps.save
   * @param {() => number} [deps.now]
   * @param {Object} [deps.limits]
   */
  constructor({ load, save, now = () => Date.now(), limits = {} }) {
    this.load = load;
    this.save = save;
    this.now = now;
    this.limits = { ...LEDGER_LIMITS, ...limits };
    this.state = null;
  }

  async ensureLoaded() {
    if (!this.state) {
      const loaded = (await this.load()) ?? {};
      this.state = {
        entries: Array.isArray(loaded.entries) ? loaded.entries.filter((e) => e && e.id && e.intent) : [],
        session: loaded.session ?? null,
      };
      this.applyRetention();
    }
    return this.state;
  }

  async persist() {
    await this.save(this.state);
  }

  /** Drops old completed/dismissed entries; pending ones are kept indefinitely. */
  applyRetention() {
    const days = this.limits.completedRetentionDays;
    if (!days) return;
    const cutoff = this.now() - days * 86400000;
    this.state.entries = this.state.entries.filter((e) => OPEN_STATUSES.includes(e.status) || (e.completedAt ?? e.updatedAt) >= cutoff);
  }

  // ---- CRUD -----------------------------------------------------------------------------------

  /**
   * @param {{domain:string, url?:string, title?:string, intent:string, source?:string}} input
   * @returns {Promise<LedgerEntry>}
   */
  async createEntry({ domain, url = null, title = '', intent, source = 'friction' }) {
    await this.ensureLoaded();
    const text = String(intent ?? '').trim().slice(0, this.limits.maxIntentChars);
    if (!text) throw new Error('Intent is required');
    if (!domain) throw new Error('Domain is required');
    const now = this.now();
    const entry = {
      id: generateId(),
      createdAt: now,
      updatedAt: now,
      domain: String(domain),
      url: url ? String(url) : null,
      titleAtCreation: String(title ?? '').slice(0, this.limits.maxTitleChars),
      intent: text,
      normalizedIntent: normalizeIntent(text),
      status: LEDGER_STATUS.PENDING,
      completedAt: null,
      source,
    };
    this.state.entries.push(entry);
    if (this.state.entries.length > this.limits.maxEntries) {
      // Evict the oldest closed entries first; never silently drop pending work.
      const closed = this.state.entries.filter((e) => !OPEN_STATUSES.includes(e.status));
      const drop = new Set(closed.slice(0, this.state.entries.length - this.limits.maxEntries).map((e) => e.id));
      this.state.entries = this.state.entries.filter((e) => !drop.has(e.id));
    }
    await this.persist();
    return { ...entry };
  }

  async getEntry(id) {
    await this.ensureLoaded();
    const e = this.state.entries.find((x) => x.id === id);
    return e ? { ...e } : null;
  }

  /**
   * @param {{status?:string|string[], domain?:string, query?:string}} [filter]
   * @returns {Promise<LedgerEntry[]>} newest first
   */
  async listEntries(filter = {}) {
    await this.ensureLoaded();
    let list = this.state.entries;
    if (filter.status) {
      const set = new Set([].concat(filter.status));
      list = list.filter((e) => set.has(e.status));
    }
    if (filter.domain) list = list.filter((e) => e.domain === filter.domain);
    if (filter.query) list = searchList(list, filter.query);
    return list.map((e) => ({ ...e })).sort((a, b) => b.createdAt - a.createdAt);
  }

  getPendingEntries() {
    return this.listEntries({ status: OPEN_STATUSES });
  }

  /** Substring match over intent, domain and title (normalised). Deterministic, no model. */
  searchEntries(query) {
    return this.listEntries({ query });
  }

  /** Editable fields only; `updatedAt` always bumps. */
  async updateEntry(id, changes = {}) {
    await this.ensureLoaded();
    const e = this.state.entries.find((x) => x.id === id);
    if (!e) return null;
    if ('intent' in changes) {
      const text = String(changes.intent ?? '').trim().slice(0, this.limits.maxIntentChars);
      if (!text) throw new Error('Intent is required');
      e.intent = text;
      e.normalizedIntent = normalizeIntent(text);
    }
    if ('url' in changes) e.url = changes.url ? String(changes.url) : null;
    if ('status' in changes) this.setStatus(e, changes.status);
    e.updatedAt = this.now();
    await this.persist();
    return { ...e };
  }

  setStatus(entry, status) {
    if (!Object.values(LEDGER_STATUS).includes(status)) throw new Error(`Unknown status: ${status}`);
    entry.status = status;
    entry.completedAt = status === LEDGER_STATUS.COMPLETED ? this.now() : null;
  }

  /** Explicit user action — the only way an entry becomes completed. */
  completeEntry(id) {
    return this.updateEntry(id, { status: LEDGER_STATUS.COMPLETED });
  }

  reopenEntry(id) {
    return this.updateEntry(id, { status: LEDGER_STATUS.PENDING });
  }

  /** The user pressed Open: mark it in progress (not complete). */
  startEntry(id) {
    return this.updateEntry(id, { status: LEDGER_STATUS.IN_PROGRESS });
  }

  async deleteEntry(id) {
    await this.ensureLoaded();
    const before = this.state.entries.length;
    this.state.entries = this.state.entries.filter((e) => e.id !== id);
    if (this.state.session) this.state.session.remainingTaskIds = this.state.session.remainingTaskIds.filter((x) => x !== id);
    const removed = this.state.entries.length !== before;
    if (removed) await this.persist();
    return removed;
  }

  async clearCompleted() {
    await this.ensureLoaded();
    const before = this.state.entries.length;
    this.state.entries = this.state.entries.filter((e) => OPEN_STATUSES.includes(e.status));
    await this.persist();
    return before - this.state.entries.length;
  }

  // ---- Duplicates -----------------------------------------------------------------------------

  /**
   * Conservative: same domain + identical normalised intent, still open, created within the
   * duplicate window. No semantic matching.
   */
  async findDuplicate({ domain, intent }) {
    await this.ensureLoaded();
    const norm = normalizeIntent(intent);
    if (!norm) return null;
    const cutoff = this.now() - this.limits.duplicateWindowMs;
    const match = this.state.entries.find(
      (e) => e.domain === domain && e.normalizedIntent === norm && OPEN_STATUSES.includes(e.status) && e.createdAt >= cutoff
    );
    return match ? { ...match } : null;
  }

  /** Open entries for a domain, used by the friction page to show "your stated reason". */
  async pendingForDomain(domain) {
    return this.listEntries({ status: OPEN_STATUSES, domain });
  }

  // ---- Execution session ----------------------------------------------------------------------

  /** Snapshot of open tasks (oldest first) to work through deliberately. */
  async startSession() {
    await this.ensureLoaded();
    const ids = this.state.entries.filter((e) => OPEN_STATUSES.includes(e.status)).sort((a, b) => a.createdAt - b.createdAt).map((e) => e.id);
    if (!ids.length) return null;
    this.state.session = { sessionStartedAt: this.now(), totalTasks: ids.length, remainingTaskIds: ids, currentTaskId: ids[0], skippedTaskIds: [] };
    await this.persist();
    return this.getSession();
  }

  async getSession() {
    await this.ensureLoaded();
    const s = this.state.session;
    if (!s) return null;
    // Entries may have been completed/deleted from elsewhere since the snapshot.
    s.remainingTaskIds = s.remainingTaskIds.filter((id) => {
      const e = this.state.entries.find((x) => x.id === id);
      return e && OPEN_STATUSES.includes(e.status);
    });
    if (!s.remainingTaskIds.includes(s.currentTaskId)) s.currentTaskId = s.remainingTaskIds[0] ?? null;
    const current = s.currentTaskId ? { ...this.state.entries.find((x) => x.id === s.currentTaskId) } : null;
    const done = s.totalTasks - s.remainingTaskIds.length;
    return { ...s, current, position: Math.min(done + 1, s.totalTasks), finished: s.remainingTaskIds.length === 0 };
  }

  /** Move past the current task without completing it. */
  async skipCurrent() {
    const s = await this.getSession();
    if (!s || !s.currentTaskId) return s;
    const st = this.state.session;
    st.remainingTaskIds = st.remainingTaskIds.filter((id) => id !== st.currentTaskId).concat(st.currentTaskId);
    st.skippedTaskIds.push(st.currentTaskId);
    // If everything left has been skipped once, stop cycling.
    const unskipped = st.remainingTaskIds.filter((id) => !st.skippedTaskIds.includes(id));
    st.currentTaskId = unskipped[0] ?? null;
    if (!st.currentTaskId) st.remainingTaskIds = [];
    await this.persist();
    return this.getSession();
  }

  async endSession() {
    await this.ensureLoaded();
    this.state.session = null;
    await this.persist();
  }

  async counts() {
    await this.ensureLoaded();
    const c = { pending: 0, in_progress: 0, completed: 0, dismissed: 0 };
    for (const e of this.state.entries) c[e.status] = (c[e.status] ?? 0) + 1;
    return { ...c, open: c.pending + c.in_progress, total: this.state.entries.length };
  }
}

function searchList(list, query) {
  const q = normalizeIntent(query);
  if (!q) return list;
  const raw = String(query).toLowerCase().trim();
  return list.filter(
    (e) => e.normalizedIntent.includes(q) || e.intent.toLowerCase().includes(raw) || e.domain.includes(raw) || e.titleAtCreation.toLowerCase().includes(raw)
  );
}
