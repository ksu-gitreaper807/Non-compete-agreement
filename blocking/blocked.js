/**
 * Friction page. Purely a view over background state: it asks the background for the
 * authoritative countdown/grant state and only ever *requests* to continue. Refreshing this
 * page, editing the DOM or changing CSS does not change when access becomes available.
 */
import { parseBlockedPageParams } from '../src/blocking/blocker.js';

const api = globalThis.browser ?? globalThis.chrome;
const params = parseBlockedPageParams(location.search);

const el = Object.fromEntries(
  ['card', 'eyebrow', 'headline', 'goal', 'pageTitle', 'domain', 'scoreRow', 'score', 'count', 'unit', 'hint', 'back', 'continue', 'error', 'recovery', 'recoveryLink', 'fine']
    .map((id) => [id, document.getElementById(id)])
);

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
  if (typeof params.score === 'number' && Number.isFinite(params.score)) {
    el.scoreRow.hidden = false;
    el.score.textContent = `${Math.round(params.score * 100)}%`;
  }
  if (params.url) el.recoveryLink.href = params.url;
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
  return m === 1 ? '1 minute' : `${m} minutes`;
}

el.continue.addEventListener('click', onContinue);
el.back.addEventListener('click', onBack);
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
