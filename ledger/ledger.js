/**
 * Intent Ledger page. A thin view over the background LedgerManager: every mutation is a
 * message; nothing is stored here. Opening a task creates a normal tab that goes through the
 * usual classification/friction path — the ledger never bypasses it.
 */
const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const send = (type, payload) => api.runtime.sendMessage({ type, payload });

const FILTERS = { open: ['pending', 'in_progress'], completed: ['completed'], all: undefined };
let filter = 'open';
let query = '';
let sessionState = null;

async function refresh() {
  const data = await send('ledgerList', { status: FILTERS[filter], query: query || undefined });
  if (!data || data.error) {
    $('summary').textContent = 'Could not reach the extension.';
    return;
  }
  const { entries, counts, session } = data;
  sessionState = session;
  $('summary').textContent = `${counts.open} pending task${counts.open === 1 ? '' : 's'}${counts.completed ? ` · ${counts.completed} completed` : ''}`;
  $('startSession').disabled = counts.open === 0 || Boolean(session);
  $('clearCompleted').hidden = counts.completed === 0;
  renderList(entries);
  renderSession(session);
}

function renderList(entries) {
  const list = $('list');
  list.innerHTML = '';
  $('empty').hidden = entries.length > 0;
  const tpl = $('rowTpl');
  for (const e of entries) {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.classList.add(e.status);
    li.dataset.id = e.id;
    li.querySelector('.intent').textContent = e.intent;
    li.querySelector('.domain').textContent = e.domain;
    li.querySelector('.when').textContent = e.status === 'completed' ? `Completed ${ago(e.completedAt)}` : `Added ${ago(e.createdAt)}`;
    if (e.titleAtCreation) li.querySelector('.title').textContent = e.titleAtCreation;
    const done = li.querySelector('.done');
    done.checked = e.status === 'completed';
    done.addEventListener('change', () => (done.checked ? send('ledgerComplete', { id: e.id }) : send('ledgerReopen', { id: e.id })).then(refresh));
    li.querySelector('.open').addEventListener('click', () => send('ledgerOpen', { id: e.id }).then(refresh));
    li.querySelector('.openDomain').addEventListener('click', () => send('ledgerOpen', { id: e.id, useDomain: true }).then(refresh));
    li.querySelector('.openDomain').hidden = !e.url;
    li.querySelector('.del').addEventListener('click', () => {
      if (confirm(`Delete "${e.intent}"?`)) send('ledgerDelete', { id: e.id }).then(refresh);
    });
    const form = li.querySelector('.edit');
    const input = form.querySelector('input');
    li.querySelector('.editBtn').addEventListener('click', () => { input.value = e.intent; form.hidden = false; input.focus(); });
    form.querySelector('.cancel').addEventListener('click', () => { form.hidden = true; });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const intent = input.value.trim();
      if (intent && intent !== e.intent) send('ledgerUpdate', { id: e.id, changes: { intent } }).then(refresh);
      else form.hidden = true;
    });
    list.append(li);
  }
}

function renderSession(s) {
  const box = $('session');
  box.hidden = !s;
  if (!s) return;
  $('sessionDone').hidden = !s.finished;
  const has = Boolean(s.current);
  for (const id of ['sessionOpen', 'sessionComplete', 'sessionSkip']) $(id).disabled = !has;
  $('sessionPos').textContent = s.finished ? `${s.totalTasks} / ${s.totalTasks}` : `Task ${s.position} / ${s.totalTasks}`;
  $('sessionIntent').textContent = has ? s.current.intent : 'No tasks left';
  $('sessionMeta').textContent = has ? `${s.current.domain}${s.current.titleAtCreation ? ' · ' + s.current.titleAtCreation : ''}` : '';
}

function ago(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

$('filters').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-filter]');
  if (!b) return;
  filter = b.dataset.filter;
  for (const x of $('filters').children) x.classList.toggle('on', x === b);
  refresh();
});
$('search').addEventListener('input', (e) => { query = e.target.value; refresh(); });
$('clearCompleted').addEventListener('click', () => send('ledgerClearCompleted').then(refresh));
$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const intent = $('addIntent').value.trim();
  const domain = $('addDomain').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  if (!intent || !domain) return;
  const { duplicate } = (await send('ledgerFindDuplicate', { domain, intent })) ?? {};
  if (duplicate && !confirm(`You already have "${duplicate.intent}" for ${domain}. Create another?`)) return;
  await send('ledgerCreate', { domain, intent, source: 'ledger' });
  $('addIntent').value = '';
  refresh();
});
$('startSession').addEventListener('click', () => send('ledgerSession', { action: 'start' }).then(refresh));
$('sessionSkip').addEventListener('click', () => send('ledgerSession', { action: 'skip' }).then(refresh));
$('sessionEnd').addEventListener('click', () => send('ledgerSession', { action: 'end' }).then(refresh));
$('sessionOpen').addEventListener('click', () => sessionState?.current && send('ledgerOpen', { id: sessionState.current.id }).then(refresh));
$('sessionComplete').addEventListener('click', () => sessionState?.current && send('ledgerComplete', { id: sessionState.current.id }).then(refresh));

api.storage?.onChanged?.addListener((changes) => { if (changes.ledger) refresh(); });
refresh();
