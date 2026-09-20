const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);

function send(type, payload) {
  return api.runtime.sendMessage({ type, payload });
}

function formatDuration(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

const LABELS = {
  relevant: ['Relevant', '✓'],
  questionable: ['Questionable', '?'],
  irrelevant: ['Irrelevant', '✕'],
  unknown: ['Not classified', '·'],
};

function renderGoal(settings) {
  const goal = settings.weeklyGoal?.trim();
  if (goal) {
    $('goalText').hidden = false;
    $('goalForm').hidden = true;
    $('goalText').innerHTML = '';
    $('goalText').append(goal);
    const small = document.createElement('small');
    small.textContent = 'Click to change';
    $('goalText').append(small);
    $('goalInput').value = goal;
  } else {
    $('goalText').hidden = true;
    $('goalForm').hidden = false;
  }
}

let lastCurrent = null;
let explainOpen = false;

const SOURCE_LABELS = { explicit_rule: 'Your rule', regex: 'Built-in rule', embedding: 'Semantic similarity', local_llm: 'Local AI', fallback: 'No signal' };

function renderCurrent(state) {
  const { current, tab, settings, analyzing } = state;
  $('pageTitle').textContent = tab?.title || '—';
  $('pageTitle').title = tab?.title || '';
  const badge = $('badge');
  badge.className = 'badge';
  $('explainRow').hidden = true;
  $('explain').hidden = true;
  $('debug').hidden = true;
  $('meta').classList.remove('analyzing');
  if (!settings.weeklyGoal?.trim()) {
    badge.textContent = '·';
    $('verdictText').textContent = 'Set a goal to start';
    $('meta').textContent = '';
    return;
  }
  if (!current && analyzing) {
    badge.textContent = '…';
    $('verdictText').textContent = 'Analyzing page…';
    $('meta').textContent = analyzing.stage === 'searching' ? 'Looking up what this page is about' : 'Local AI is judging this page';
    $('meta').classList.add('analyzing');
    return;
  }
  if (!current) {
    badge.textContent = '·';
    $('verdictText').textContent = 'Not tracked';
    $('meta').textContent = tab?.domain ? '' : 'Internal or unsupported page';
    return;
  }
  const changedPage = !lastCurrent || lastCurrent.title !== current.title || lastCurrent.domain !== current.domain;
  lastCurrent = current;
  const [label, glyph] = LABELS[current.classification] ?? LABELS.unknown;
  badge.classList.add(current.classification);
  badge.textContent = `${glyph} ${label}`;
  $('verdictText').textContent = current.grant ? 'temporary access' : current.decision === 'allow' ? '' : current.decision;
  const bits = [];
  if (typeof current.score === 'number') bits.push(`Score ${current.score.toFixed(2)}`);
  if (current.sourceKind) bits.push(SOURCE_LABELS[current.sourceKind] ?? current.sourceKind);
  if (current.reason) bits.push(current.reason);
  $('meta').textContent = bits.join(' · ');
  $('explainRow').hidden = false;
  if (changedPage) resetFeedback();
  if (explainOpen) renderExplain(current, state);
  if (settings.debugMode) {
    $('debug').hidden = false;
    $('debug').textContent = debugText(current);
  }
}

function renderExplain(current, state) {
  const box = $('explain');
  box.innerHTML = '';
  const dl = document.createElement('dl');
  const add = (k, v) => {
    if (v === null || v === undefined || v === '') return;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    if (Array.isArray(v)) { const ul = document.createElement('ul'); for (const x of v) { const li = document.createElement('li'); li.textContent = x; ul.append(li); } dd.append(ul); }
    else dd.textContent = String(v);
    dl.append(dt, dd);
  };
  add('Goal', state.settings.weeklyGoal);
  add('Page', `${current.title || '(no title)'} — ${current.domain}`);
  if (typeof current.semanticScore === 'number') add('Semantic relevance', `${Math.round(current.semanticScore * 100)}%${current.nearestPositive ? ` (closest goal topic: ${current.nearestPositive})` : ''}`);
  add('Decided by', SOURCE_LABELS[current.sourceKind] ?? current.source);
  if (current.sourceKind === 'local_llm') {
    add('AI classification', `${current.classification} (confidence ${Math.round((current.confidence ?? 0) * 100)}%)`);
    add('AI reasoning', current.llm?.reason);
    if (current.llm?.evidence?.length) add('Evidence', current.llm.evidence);
  } else add('Reason', current.reason);
  add('Evidence quality', current.evidenceQuality);
  if (current.searchUsed) add('Web context', (current.webContext ?? []).map((r) => `${r.title}${r.domain ? ` (${r.domain})` : ''}`));
  box.append(dl);
  box.hidden = false;
}

function debugText(c) {
  const t = c.timings ?? {};
  const search = c.trace?.find((x) => x.stage === 'search');
  const lines = [
    `TITLE: ${c.title}`, `DOMAIN: ${c.domain}`,
    `REGEX: ${c.trace?.find((x) => x.stage === 'regex')?.decided ? c.source : 'uncertain'}`,
    `BGE: ${c.semanticScore ?? '-'}`,
    `SEARCH: ${c.searchUsed ? `yes (${search?.status}, ${search?.results ?? 0} results, "${c.searchQuery}")` : 'no'}`,
    `SEARCH LATENCY: ${t.searchMs ?? '-'} ms`,
    `LLM: ${c.sourceKind === 'local_llm' ? c.classification : '-'}`,
    `LLM CONFIDENCE: ${c.confidence ?? '-'}`,
    `EVIDENCE: ${c.evidenceQuality ?? '-'}`,
    `FINAL: ${c.decision?.toUpperCase()} (${c.source})${c.cached ? ' [cached]' : ''}`,
    `TOTAL: ${t.totalMs ?? '-'} ms (regex ${t.regexMs ?? '-'} / embedding ${t.embeddingMs ?? '-'} / llm ${t.llmMs ?? '-'})`,
  ];
  return lines.join('\n');
}

function resetFeedback() {
  $('feedback').hidden = false;
  $('feedbackFix').hidden = true;
  $('feedbackDone').hidden = true;
}

async function sendFeedback(userLabel) {
  if (!lastCurrent) return;
  await send('submitFeedback', { domain: lastCurrent.domain, title: lastCurrent.title, prediction: lastCurrent.classification, userLabel, source: lastCurrent.source });
  $('feedback').hidden = true;
  $('feedbackFix').hidden = true;
  $('feedbackDone').hidden = false;
}

function renderStats(state) {
  const { today, week } = state.summary;
  $('todayRelevant').textContent = formatDuration(today.relevantMs);
  $('todayQuestionable').textContent = formatDuration(today.questionableMs);
  $('todayIrrelevant').textContent = formatDuration(today.irrelevantMs);
  $('todayOverride').textContent = formatDuration(today.overrideMs);

  const target = state.settings.weeklyTargetMinutes * 60000;
  const pct = target > 0 ? Math.min(100, Math.round((week.relevantMs / target) * 100)) : 0;
  $('progressBar').style.width = `${pct}%`;
  $('progressText').textContent = target > 0
    ? `${formatDuration(week.relevantMs)} of ${formatDuration(target)} productive this week (${pct}%)`
    : `${formatDuration(week.relevantMs)} productive this week`;
  $('frictionText').textContent = `This week: ${week.frictionTriggered} pauses · ${week.overrides} overrides · ${week.frictionAbandoned} walked away · ${week.frictionReset ?? 0} resets · ${formatDuration(week.overrideMs)} after overrides`;
}

function renderModel(model, ai) {
  const map = { idle: 'idle', loading: 'Loading…', ready: 'Ready', unavailable: 'unavailable' };
  let text = `AI classifier: ${map[model.status] ?? model.status}`;
  if (model.status === 'ready' && model.averageInferenceMs != null) text += ` (${model.averageInferenceMs} ms/title)`;
  $('modelStatus').textContent = text;
  $('modelStatus').title = model.error ?? '';
  const dot = (el, cls, label, title = '') => { el.className = `model dot ${cls}`; el.textContent = label; el.title = title; };
  if (!ai) return;
  if (!ai.llm.enabled) dot($('llmStatus'), 'off', 'Local model: off');
  else if (ai.llm.status === 'ready') dot($('llmStatus'), 'ok', 'Local model ready');
  else if (ai.llm.status === 'loading') dot($('llmStatus'), 'busy', `Local model loading${ai.llm.progress != null ? ` ${ai.llm.progress}%` : '…'}`);
  else if (ai.llm.status === 'unavailable') dot($('llmStatus'), 'bad', 'Local model unavailable', ai.llm.error ?? '');
  else dot($('llmStatus'), 'off', 'Local model: idle (loads when needed)');
  if (!ai.search.enabled) dot($('searchStatus'), 'off', 'Semantic search: off');
  else if (!ai.search.permission) dot($('searchStatus'), 'bad', 'Semantic search: no permission');
  else if (!ai.search.online) dot($('searchStatus'), 'off', 'Semantic search: offline');
  else dot($('searchStatus'), ai.search.lastError ? 'bad' : 'ok', `Semantic search: ${ai.search.lastError ? 'error' : 'online'}`, ai.search.lastError ?? '');
}

async function refresh() {
  let state;
  try {
    state = await send('getPopupState');
  } catch (e) {
    $('verdictText').textContent = 'Extension not responding';
    return;
  }
  if (!state || state.error) {
    $('verdictText').textContent = state?.error ?? 'Error';
    return;
  }
  $('enabled').checked = state.settings.enabled !== false;
  renderGoal(state.settings);
  renderCurrent(state);
  renderStats(state);
  renderModel(state.model, state.ai);
}

$('goalForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const weeklyGoal = $('goalInput').value.trim();
  $('goalSave').disabled = true;
  await send('saveSettings', { weeklyGoal });
  $('goalSave').disabled = false;
  await refresh();
});
$('goalText').addEventListener('click', () => {
  $('goalText').hidden = true;
  $('goalForm').hidden = false;
  $('goalInput').focus();
});
$('enabled').addEventListener('change', async (e) => {
  await send('saveSettings', { enabled: e.target.checked });
  await refresh();
});
$('whyBtn').addEventListener('click', () => {
  explainOpen = !explainOpen;
  $('explain').hidden = !explainOpen;
  if (explainOpen) refresh();
});
$('feedback').addEventListener('click', (e) => {
  const fb = e.target.dataset?.fb;
  if (!fb) return;
  if (fb === 'yes') sendFeedback(lastCurrent?.classification);
  else { $('feedback').hidden = true; $('feedbackFix').hidden = false; }
});
$('feedbackFix').addEventListener('click', (e) => {
  const label = e.target.dataset?.label;
  if (label) sendFeedback(label);
});
$('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
});

refresh();
const timer = setInterval(refresh, 3000);
window.addEventListener('unload', () => clearInterval(timer));
