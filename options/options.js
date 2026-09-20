const api = globalThis.browser ?? globalThis.chrome;
const $ = (id) => document.getElementById(id);
const send = (type, payload) => api.runtime.sendMessage({ type, payload });

const state = { settings: null, rules: { allow: [], block: [] }, anchors: { positive: [], negative: [] } };

const LIST_CONFIG = {
  allow: { el: 'allowList', source: () => state.rules.allow, regex: true },
  block: { el: 'blockList', source: () => state.rules.block, regex: true },
  allowedDomains: { el: 'allowedDomainsList', source: () => state.settings.allowedDomains, regex: false },
  blockedDomains: { el: 'blockedDomainsList', source: () => state.settings.blockedDomains, regex: false },
};

async function load() {
  const data = await send('getSettings');
  if (!data || data.error) {
    $('status').textContent = data?.error ?? 'Could not load settings';
    return;
  }
  Object.assign(state, data);
  const s = state.settings;
  $('weeklyGoal').value = s.weeklyGoal ?? '';
  $('weeklyTargetMinutes').value = s.weeklyTargetMinutes;
  $('relevantThreshold').value = s.relevantThreshold;
  $('questionableThreshold').value = s.questionableThreshold;
  $('policyRelevant').value = s.policy.relevant;
  $('policyQuestionable').value = s.policy.questionable;
  $('policyIrrelevant').value = s.policy.irrelevant;
  $('policyUnknown').value = s.policy.unknown;
  setRadio('friction', s.frictionSeconds, 'frictionCustom');
  setRadio('override', s.overrideMinutes, 'overrideCustom');
  $('questionableFrictionMode').value = s.questionableFrictionMode;
  $('questionableFrictionSeconds').value = s.questionableFrictionSeconds;
  $('anchorsPositive').value = state.anchors.positive.join('\n');
  $('anchorsNegative').value = state.anchors.negative.join('\n');
  for (const key of Object.keys(LIST_CONFIG)) renderList(key);
  await Promise.all([refreshModel(), refreshGrants()]);
}

function setRadio(name, value, customId) {
  const radios = [...document.querySelectorAll(`input[name="${name}"]`)];
  const match = radios.find((r) => r.value === String(value));
  if (match) match.checked = true;
  else {
    radios.find((r) => r.value === 'custom').checked = true;
    $(customId).value = value;
  }
}

function readRadio(name, customId, fallback) {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  if (!checked) return fallback;
  if (checked.value === 'custom') return Number($(customId).value) || fallback;
  return Number(checked.value);
}

function renderList(key) {
  const cfg = LIST_CONFIG[key];
  const ul = $(cfg.el);
  ul.innerHTML = '';
  cfg.source().forEach((item, index) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = item;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => {
      cfg.source().splice(index, 1);
      renderList(key);
    });
    li.append(span, remove);
    if (cfg.regex) {
      send('validateRegex', { pattern: item }).then((r) => {
        if (r && !r.valid) {
          li.classList.add('invalid');
          li.title = r.error;
        }
      });
    }
    ul.append(li);
  });
}

document.querySelectorAll('form.add').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const key = form.dataset.list;
    const input = form.querySelector('input');
    const value = input.value.trim();
    if (!value) return;
    const cfg = LIST_CONFIG[key];
    if (cfg.regex) {
      const check = await send('validateRegex', { pattern: value });
      if (!check.valid) {
        $('status').textContent = `Invalid regex: ${check.error}`;
        return;
      }
    }
    $('status').textContent = '';
    cfg.source().push(cfg.regex ? value : value.toLowerCase());
    input.value = '';
    renderList(key);
  });
});

async function save() {
  $('saveStatus').textContent = 'Saving…';
  const patch = {
    weeklyGoal: $('weeklyGoal').value.trim(),
    weeklyTargetMinutes: Number($('weeklyTargetMinutes').value),
    relevantThreshold: Number($('relevantThreshold').value),
    questionableThreshold: Number($('questionableThreshold').value),
    policy: {
      relevant: $('policyRelevant').value,
      questionable: $('policyQuestionable').value,
      irrelevant: $('policyIrrelevant').value,
      unknown: $('policyUnknown').value,
    },
    frictionSeconds: readRadio('friction', 'frictionCustom', 10),
    overrideMinutes: readRadio('override', 'overrideCustom', 5),
    questionableFrictionMode: $('questionableFrictionMode').value,
    questionableFrictionSeconds: Number($('questionableFrictionSeconds').value),
    allowedDomains: state.settings.allowedDomains,
    blockedDomains: state.settings.blockedDomains,
  };
  if (patch.questionableThreshold > patch.relevantThreshold) {
    $('saveStatus').textContent = 'Questionable threshold must be ≤ relevant threshold.';
    return;
  }
  const goalChanged = patch.weeklyGoal !== state.settings.weeklyGoal;
  const rulesResult = await send('saveRules', state.rules);
  if (rulesResult?.error) {
    $('saveStatus').textContent = `${rulesResult.error}: ${rulesResult.invalid.map((i) => i.pattern).join(', ')}`;
    return;
  }
  await send('saveSettings', patch);
  const anchors = {
    positive: lines($('anchorsPositive').value),
    negative: lines($('anchorsNegative').value),
  };
  const anchorsEdited = anchors.positive.join('\n') !== state.anchors.positive.join('\n') || anchors.negative.join('\n') !== state.anchors.negative.join('\n');
  if (goalChanged && !anchorsEdited) await send('regenerateAnchors');
  else await send('saveAnchors', anchors);
  $('saveStatus').textContent = 'Saved.';
  await load();
  setTimeout(() => ($('saveStatus').textContent = ''), 2000);
}

function lines(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

async function refreshModel() {
  const m = await send('getModelStatus');
  if (!m || m.error) return;
  const parts = [`Status: ${m.status}`];
  if (m.loadTimeMs != null) parts.push(`loaded in ${m.loadTimeMs} ms`);
  if (m.averageInferenceMs != null) parts.push(`${m.averageInferenceMs} ms per title`);
  if (m.cacheSize) parts.push(`${m.cacheSize} cached embeddings`);
  if (m.error) parts.push(`error: ${m.error}`);
  $('modelInfo').textContent = parts.join(' · ');
}

async function refreshGrants() {
  const stats = await send('getStatistics');
  const grants = stats?.grants ?? [];
  const box = $('grants');
  box.innerHTML = '';
  if (!grants.length) return;
  const title = document.createElement('p');
  title.textContent = 'Active temporary access:';
  box.append(title);
  for (const g of grants) {
    const p = document.createElement('p');
    p.textContent = `${g.domain} — expires ${new Date(g.expiresAt).toLocaleTimeString()}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = 'Revoke';
    btn.addEventListener('click', async () => {
      await send('revokeGrant', { domain: g.domain });
      refreshGrants();
    });
    p.append(btn);
    box.append(p);
  }
}

$('save').addEventListener('click', save);
$('regenerateAnchors').addEventListener('click', async () => {
  await send('saveSettings', { weeklyGoal: $('weeklyGoal').value.trim() });
  const anchors = await send('regenerateAnchors');
  if (anchors && !anchors.error) {
    state.anchors = anchors;
    $('anchorsPositive').value = anchors.positive.join('\n');
    $('anchorsNegative').value = anchors.negative.join('\n');
  }
});
$('warmUp').addEventListener('click', async () => {
  $('modelInfo').textContent = 'Status: loading…';
  await send('warmUpModel');
  await refreshModel();
});
$('tryButton').addEventListener('click', async () => {
  $('tryResult').textContent = 'Classifying… (loads the model on first use)';
  const r = await send('classifyText', { title: $('tryTitle').value });
  $('tryResult').textContent = JSON.stringify(r, null, 2);
  refreshModel();
});
$('resetAll').addEventListener('click', async () => {
  if (!confirm('Delete all GoalGuard settings, rules and statistics?')) return;
  await send('resetAll');
  await load();
});

load();
