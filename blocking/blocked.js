/**
 * Friction page. Purely a view over background state: it asks the background for the
 * authoritative countdown/grant state and only ever *requests* to continue. Refreshing this
 * page, editing the DOM or changing CSS does not change when access becomes available.
 */
import { parseBlockedPageParams } from '../src/blocking/blocker.js';

const api = globalThis.browser ?? globalThis.chrome;
const params = parseBlockedPageParams(location.search);

const el = Object.fromEntries(
  ['card', 'eyebrow', 'headline', 'goal', 'pageTitle', 'domain', 'scoreRow', 'score', 'aiRow', 'aiVerdict', 'evidenceRow', 'evidence', 'whyBtn', 'details', 'count', 'unit', 'hint', 'back', 'continue', 'error', 'recovery', 'recoveryLink', 'fine', 'feedback', 'feedbackFix', 'feedbackDone', 'usedRow', 'used', 'closeTab']
    .map((id) => [id, document.getElementById(id)])
);

let explanation = null;
const SOURCE_LABELS = { explicit_rule: 'your rule', regex: 'a built-in rule', embedding: 'semantic similarity to your goal', local_llm: 'the local AI model', fallback: 'no signal' };

let unlockAt = null;
let generation = null;
let ticking = null;
let syncTimer = null;
let continuing = false;

function send(type, payload) {
  return api.runtime.sendMessage({ type, payload });
}

function renderStatic() {
  el.pageTitle.textContent = params.title || '(no title)';
  el.domain.textContent = params.domain || '—';
  const kind = params.decision === 'warn' ? 'warn' : 'block';
  el.card.dataset.kind = kind;
  if (kind === 'warn') {
    el.eyebrow.textContent = 'Quick check';
    el.headline.textContent = 'This page may not be related to your weekly goal.';
  } else {
    el.eyebrow.textContent = 'Take a pause';
    el.headline.textContent = "This page doesn't appear related to your weekly goal.";
  }
  if (params.expired) {
    // Background replaced the tab because temporary access ran out (no click was needed).
    el.eyebrow.textContent = 'Time is up';
    el.headline.textContent = 'Temporary access expired. Wait again to continue.';
    el.continue.textContent = 'Wait again';
    el.closeTab.hidden = false;
    el.feedback.hidden = true;
    if (Number.isFinite(params.usedMinutes)) {
      el.usedRow.hidden = false;
      el.used.textContent = `${formatMinutes(params.usedMinutes)} used`;
    }
  }
  if (typeof params.score === 'number' && Number.isFinite(params.score)) {
    el.scoreRow.hidden = false;
    el.score.textContent = `${Math.round(params.score * 100)}%`;
  }
  if (params.url) el.recoveryLink.href = params.url;
}

/**
 * Explanation is a read-only view of the cached classification; asking for it never changes
 * the decision or the timer. Details are hidden behind "Why?" to keep the page calm.
 */
async function loadExplanation() {
  try {
    explanation = await send('classifyText', { title: params.title, url: params.url });
  } catch {
    explanation = null;
  }
  if (!explanation || explanation.error) return;
  if (explanation.sourceKind === 'local_llm') {
    el.aiRow.hidden = false;
    el.aiVerdict.textContent = `${explanation.classification} (${Math.round((explanation.confidence ?? 0) * 100)}% confidence)`;
  }
  const evidence = explanation.llm?.evidence?.length ? explanation.llm.evidence.join(', ') : explanation.llm?.reason || null;
  if (evidence) {
    el.evidenceRow.hidden = false;
    el.evidence.textContent = evidence;
  }
}

function renderDetails() {
  const box = el.details;
  box.innerHTML = '';
  const add = (text) => { const p = document.createElement('p'); p.textContent = text; box.append(p); };
  if (!explanation) { add('No details available.'); return; }
  add(`Decided by ${SOURCE_LABELS[explanation.sourceKind] ?? explanation.source}.`);
  if (explanation.reason) add(`Reason: ${explanation.reason}`);
  if (typeof explanation.semanticScore === 'number') add(`Semantic relevance: ${Math.round(explanation.semanticScore * 100)}%${explanation.nearestPositive ? ` (closest goal topic: ${explanation.nearestPositive}; closest distraction: ${explanation.nearestNegative ?? '-'})` : ''}`);
  if (explanation.evidenceQuality) add(`Evidence quality: ${explanation.evidenceQuality}`);
  if (explanation.searchUsed && explanation.webContext?.length) {
    add('Web context used:');
    const ul = document.createElement('ul');
    for (const r of explanation.webContext) { const li = document.createElement('li'); li.textContent = `${r.title}${r.domain ? ` (${r.domain})` : ''}`; ul.append(li); }
    box.append(ul);
  }
}

async function sendFeedback(userLabel) {
  await send('submitFeedback', { domain: params.domain, title: params.title, prediction: params.classification, userLabel, source: explanation?.source }).catch(() => {});
  el.feedback.hidden = true;
  el.feedbackFix.hidden = true;
  el.feedbackDone.hidden = false;
}

async function sync() {
  let state;
  try {
    state = await send('getFrictionState', params);
  } catch (e) {
    return showRecovery(e);
  }
  if (!state || state.error) return showRecovery(new Error(state?.error ?? 'empty response'));

  el.goal.textContent = state.goal || '(no goal set)';
  el.error.hidden = true;

  if (state.releaseImmediately) return proceed();

  switch (state.state) {
    case 'TEMPORARILY_ALLOWED':
      return proceed();
    case 'COUNTING_DOWN':
      if (generation !== null && state.generation !== generation) {
        el.error.textContent = 'Timer restarted because you switched away.';
        el.error.hidden = false;
      }
      unlockAt = state.unlockAt;
      generation = state.generation;
      startTicking();
      break;
    case 'UNLOCKED':
      unlockAt = state.unlockAt ?? Date.now();
      generation = state.generation;
      startTicking();
      break;
    default:
      // BLOCKED while inactive: the timer only runs while this tab is in front.
      if (ticking) clearInterval(ticking);
      ticking = null;
      unlockAt = null;
      el.continue.disabled = true;
      el.count.textContent = '--';
      el.count.classList.remove('done');
      el.hint.textContent = state.inactive ? 'Timer reset — it restarts when you come back to this tab.' : 'Waiting for the extension…';
  }
  const minutes = state.settings?.overrideMinutes;
  if (minutes) el.fine.textContent = `Continuing grants ${formatMinutes(minutes)} of access to ${params.domain}. Time spent still counts as distraction time.`;
}

function startTicking() {
  if (ticking) clearInterval(ticking);
  tick();
  ticking = setInterval(tick, 200);
}

function tick() {
  const remainingMs = Math.max(0, (unlockAt ?? 0) - Date.now());
  const seconds = Math.ceil(remainingMs / 1000);
  if (remainingMs > 0) {
    el.count.textContent = String(seconds).padStart(2, '0');
    el.count.classList.remove('done');
    el.unit.textContent = seconds === 1 ? 'second' : 'seconds';
    el.hint.textContent = `Continue in ${seconds} second${seconds === 1 ? '' : 's'}`;
    el.continue.disabled = true;
  } else {
    el.count.textContent = '✓';
    el.count.classList.add('done');
    el.unit.textContent = '';
    el.hint.textContent = 'You can continue now — or go back to your goal.';
    el.continue.disabled = false;
    clearInterval(ticking);
    ticking = null;
  }
}

async function onContinue() {
  if (continuing) return;
  continuing = true;
  el.continue.disabled = true;
  el.hint.textContent = 'Checking…';
  el.error.hidden = true;
  try {
    const result = await send('continueFromFriction', { domain: params.domain, url: params.url, tabId: params.tabId, generation });
    if (result?.ok) {
      el.hint.textContent = 'Access granted. Opening…';
      // Background navigates the tab; fall back to a direct navigation if it did not.
      setTimeout(() => {
        if (params.url) location.replace(params.url);
      }, 800);
      return;
    }
    // The authoritative timer says no: re-sync and show why.
    el.error.textContent = result?.reason || result?.error || 'Not yet.';
    el.error.hidden = false;
    continuing = false;
    generation = null;
    await sync();
  } catch (e) {
    continuing = false;
    showRecovery(e);
  }
}

function proceed() {
  el.hint.textContent = 'Access is currently allowed. Opening…';
  el.continue.disabled = true;
  if (params.url) location.replace(params.url);
}

async function onBack() {
  try {
    await send('leaveFriction', { tabId: params.tabId, closeTab: history.length <= 1 });
  } catch {
    /* fall through to navigation */
  }
  if (history.length > 1) history.back();
  else location.replace('about:newtab');
}

function showRecovery(error) {
  console.warn('[GoalGuard] friction page error', error);
  el.hint.textContent = 'Extension unavailable';
  el.recovery.hidden = false;
}

function formatMinutes(m) {
  const n = Math.round(m * 10) / 10;
  return n === 1 ? '1 minute' : `${n} minutes`;
}

async function onCloseTab() {
  try {
    await send('leaveFriction', { tabId: params.tabId, closeTab: true });
  } catch {
    window.close();
  }
}

el.continue.addEventListener('click', onContinue);
el.back.addEventListener('click', onBack);
el.closeTab.addEventListener('click', onCloseTab);
el.whyBtn.addEventListener('click', () => {
  el.details.hidden = !el.details.hidden;
  if (!el.details.hidden) renderDetails();
});
el.feedback.addEventListener('click', (e) => {
  const fb = e.target.dataset?.fb;
  if (fb === 'yes') sendFeedback(params.classification);
  else if (fb === 'no') { el.feedback.hidden = true; el.feedbackFix.hidden = false; }
});
el.feedbackFix.addEventListener('click', (e) => {
  const label = e.target.dataset?.label;
  if (label) sendFeedback(label);
});
loadExplanation();
// Switching away resets the timer in the background; re-sync on return so the UI shows the
// fresh full countdown (and stops ticking while hidden).
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (ticking) clearInterval(ticking);
    ticking = null;
  } else {
    setTimeout(sync, 50);
  }
});

renderStatic();
sync();
// Periodic re-sync guards against clock drift and background restarts.
syncTimer = setInterval(sync, 5000);
window.addEventListener('pagehide', () => {
  clearInterval(syncTimer);
  if (ticking) clearInterval(ticking);
});
