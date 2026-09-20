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

function renderCurrent(state) {
  const { current, tab, settings } = state;
  $('pageTitle').textContent = tab?.title || '—';
  $('pageTitle').title = tab?.title || '';
  const badge = $('badge');
  badge.className = 'badge';
  if (!settings.weeklyGoal?.trim()) {
    badge.textContent = '·';
    $('verdictText').textContent = 'Set a goal to start';
    $('meta').textContent = '';
    return;
  }
  if (!current) {
    badge.textContent = '·';
    $('verdictText').textContent = 'Not tracked';
    $('meta').textContent = tab?.domain ? '' : 'Internal or unsupported page';
    return;
  }
  const [label, glyph] = LABELS[current.classification] ?? LABELS.unknown;
  badge.classList.add(current.classification);
  badge.textContent = `${glyph} ${label}`;
  $('verdictText').textContent = current.grant ? 'temporary access' : current.decision === 'allow' ? '' : current.decision;
  const bits = [];
  if (typeof current.score === 'number') bits.push(`Score ${current.score.toFixed(2)}`);
  if (typeof current.positiveSimilarity === 'number') bits.push(`+${current.positiveSimilarity.toFixed(2)} / −${current.negativeSimilarity.toFixed(2)}`);
  if (current.reason) bits.push(current.reason);
  $('meta').textContent = bits.join(' · ');
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

function renderModel(model) {
  const map = { idle: 'idle', loading: 'Loading…', ready: 'Ready', unavailable: 'unavailable' };
  let text = `AI classifier: ${map[model.status] ?? model.status}`;
  if (model.status === 'ready' && model.averageInferenceMs != null) text += ` (${model.averageInferenceMs} ms/title)`;
  $('modelStatus').textContent = text;
  $('modelStatus').title = model.error ?? '';
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
  renderModel(state.model);
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
$('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  api.runtime.openOptionsPage();
});

refresh();
const timer = setInterval(refresh, 3000);
window.addEventListener('unload', () => clearInterval(timer));
