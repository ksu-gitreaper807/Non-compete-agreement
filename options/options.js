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
  $('embeddingsEnabled').checked = s.embeddingsEnabled !== false;
  $('llmEnabled').checked = Boolean(s.llmEnabled);
  $('searchEnabled').checked = Boolean(s.searchEnabled);
  $('searchMode').value = s.searchMode;
  $('searchMaxResults').value = s.searchMaxResults;
  $('searchCacheHours').value = s.searchCacheHours;
  $('llmRuntime').value = s.llmRuntime;
  $('llmEndpoint').value = s.llmEndpoint ?? '';
  $('llmModelName').value = s.llmModelName ?? '';
  $('llmMinConfidence').value = s.llmMinConfidence;
  $('debugMode').checked = Boolean(s.debugMode);
  $('anchorsPositive').value = state.anchors.positive.join('\n');
  $('anchorsNegative').value = state.anchors.negative.join('\n');
  for (const key of Object.keys(LIST_CONFIG)) renderList(key);
  await Promise.all([refreshModel(), refreshGrants(), refreshCaches(), refreshLayer3(), refreshTelemetry(), refreshFeedback()]);
}

const DDG_ORIGIN = 'https://html.duckduckgo.com/*';
const IN_BROWSER = new Set(['nli', 'transformers']);
const LOCAL_ORIGINS = ['http://localhost/*', 'http://127.0.0.1/*'];
const HF_ORIGINS = ['https://huggingface.co/*', 'https://cdn-lfs.huggingface.co/*', 'https://cdn-lfs-us-1.huggingface.co/*', 'https://cas-bridge.xethub.hf.co/*'];

async function requestOrigins(origins) {
  try {
    return await api.permissions.request({ origins });
  } catch (e) {
    $('status').textContent = `Permission request failed: ${e.message}`;
    return false;
  }
}

async function refreshLayer3() {
  const st = await send('getLayer3Status');
  if (!st || st.error) return;
  const llm = st.llm;
  const parts = [`LLM (${llm.modelVersion}): ${llm.status}${llm.status === 'loading' && llm.progress != null ? ` ${llm.progress}%` : ''}`];
  if (llm.loadTimeMs != null) parts.push(`loaded in ${Math.round(llm.loadTimeMs / 1000)} s`);
  if (llm.averageMs != null) parts.push(`${llm.averageMs} ms per judgment`);
  if (llm.error) parts.push(`error: ${llm.error}`);
  parts.push(`Search: ${st.search.permission ? 'permitted' : 'no permission'}, ${st.search.requests} requests, ${st.search.cacheHits} cache hits, ${st.search.rateLimiter?.rejected ?? 0} rate-limited${st.search.lastError ? `, last error: ${st.search.lastError}` : ''}`);
  $('layer3Info').textContent = parts.join(' · ');
}

async function refreshTelemetry() {
  const t = await send('getTelemetry');
  if (!t || t.error) return;
  const st = (s) => `n=${s.count} mean=${s.meanMs ?? '-'}ms p50=${s.p50Ms ?? '-'}ms p95=${s.p95Ms ?? '-'}ms max=${s.maxMs ?? '-'}ms`;
  const lines = [
    `classifications ${t.pipeline.counters.classifications} · cache hits ${t.pipeline.counters.cacheHits} (rate ${t.pipeline.counters.cacheHitRate ?? '-'})`,
    `searches ${t.pipeline.counters.searches} (cached ${t.pipeline.counters.searchCacheHits}) · LLM calls ${t.pipeline.counters.llmCalls} (cached ${t.pipeline.counters.llmCacheHits}) · downgraded ${t.pipeline.counters.downgraded} · stale ${t.pipeline.counters.stale}`,
    `by source: ${Object.entries(t.pipeline.bySource).map(([k, v]) => `${k}=${v}`).join(', ') || '—'}`,
    '',
    ...Object.entries(t.pipeline.stages).map(([k, v]) => `${k.padEnd(10)} ${st(v)}`),
  ];
  $('telemetry').textContent = lines.join('\n');
}

async function refreshFeedback() {
  const list = await send('getFeedback');
  if (!Array.isArray(list)) return;
  const wrong = list.filter((f) => f.prediction !== f.userLabel).length;
  $('feedbackInfo').textContent = list.length ? `${list.length} feedback entries stored locally (${wrong} corrections).` : 'No feedback stored yet.';
}

async function refreshCaches() {
  const stats = await send('getCacheStats');
  if (!stats || stats.error) return;
  const fmtTtl = (ms) => (ms >= 86400000 ? `${Math.round(ms / 86400000)} d` : `${Math.round(ms / 3600000)} h`);
  $('cacheStats').textContent = Object.values(stats)
    .map((c) => `${c.namespace.padEnd(15)} ${String(c.size).padStart(5)} / ${c.maxEntries} entries · TTL ${fmtTtl(c.ttlMs)} · hits ${c.hits} · misses ${c.misses} · expired ${c.expired} · evicted ${c.evicted} · deduped ${c.dedupeHits}`)
    .join('\n');
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
    embeddingsEnabled: $('embeddingsEnabled').checked,
    llmEnabled: $('llmEnabled').checked,
    searchEnabled: $('searchEnabled').checked,
    searchMode: $('searchMode').value,
    searchMaxResults: Number($('searchMaxResults').value),
    searchCacheHours: Number($('searchCacheHours').value),
    llmRuntime: $('llmRuntime').value,
    llmEndpoint: $('llmEndpoint').value.trim(),
    llmModelName: $('llmModelName').value.trim(),
    llmMinConfidence: Number($('llmMinConfidence').value),
    debugMode: $('debugMode').checked,
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
$('llmEnabled').addEventListener('change', async (e) => {
  if (!e.target.checked) return;
  const origins = IN_BROWSER.has($('llmRuntime').value) ? HF_ORIGINS : LOCAL_ORIGINS;
  if (!(await requestOrigins(origins))) e.target.checked = false;
});
$('llmRuntime').addEventListener('change', () => {
  const local = !IN_BROWSER.has($('llmRuntime').value);
  $('llmEndpoint').disabled = !local;
  $('llmModelName').disabled = !local;
});
$('searchEnabled').addEventListener('change', async (e) => {
  if (e.target.checked && !(await requestOrigins([DDG_ORIGIN]))) e.target.checked = false;
});
$('warmUpLlm').addEventListener('click', async () => {
  if (!(await requestOrigins(IN_BROWSER.has($('llmRuntime').value) ? HF_ORIGINS : LOCAL_ORIGINS))) return;
  await send('saveSettings', { llmEnabled: true });
  $('llmEnabled').checked = true;
  $('layer3Info').textContent = 'LLM: downloading… (this can take a few minutes the first time)';
  const poll = setInterval(refreshLayer3, 1500);
  await send('warmUpLlm');
  clearInterval(poll);
  await refreshLayer3();
});
$('testLayer3').addEventListener('click', async () => {
  const title = $('tryTitle').value.trim() || 'Linus Torvalds Interview';
  $('layer3Result').textContent = 'Running… (loads the LLM on first use)';
  const r = await send('testLayer3', { title, domain: 'example.com' });
  $('layer3Result').textContent = JSON.stringify(r, null, 2);
  refreshLayer3();
});
$('tryButton').addEventListener('click', async () => {
  $('tryResult').textContent = 'Classifying… (loads models on first use)';
  const r = await send('debugClassify', { title: $('tryTitle').value });
  $('tryResult').textContent = JSON.stringify(r, null, 2);
  refreshModel();
  refreshTelemetry();
});
$('clearCaches').addEventListener('click', async () => {
  await send('clearCaches');
  await refreshCaches();
});
$('clearSearchCache').addEventListener('click', async () => {
  await send('clearCaches', { namespaces: ['retrieval'] });
  await refreshCaches();
});
$('clearAiCache').addEventListener('click', async () => {
  await send('clearCaches', { namespaces: ['classification', 'llm'] });
  await refreshCaches();
});
$('exportFeedback').addEventListener('click', async () => {
  const list = await send('getFeedback');
  const blob = new Blob([JSON.stringify(list ?? [], null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'goalguard-feedback.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$('clearFeedback').addEventListener('click', async () => {
  if (!confirm('Delete all stored feedback?')) return;
  await send('clearFeedback');
  await refreshFeedback();
});
$('refreshTelemetry').addEventListener('click', refreshTelemetry);
$('resetAll').addEventListener('click', async () => {
  if (!confirm('Delete all GoalGuard settings, rules and statistics?')) return;
  await send('resetAll');
  await load();
});

load();
