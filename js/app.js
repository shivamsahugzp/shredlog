// App shell: boot, tab router, re-render on state change, service worker updates.
import { state, load, on, todayKey, flush, storage } from './state.js';
import { h, icon, toast, clear, fmtClock, haptic } from './ui.js';
import { renderLock } from './lock.js';
import { prefersReducedMotion, celebrate, EASE_OUT } from './motion.js';

const VIEWS = {
  today: () => import('./views/today.js'),
  food: () => import('./views/food.js'),
  train: () => import('./views/train.js'),
  body: () => import('./views/body.js'),
  progress: () => import('./views/progress.js'),
  settings: () => import('./views/settings.js'),
  onboarding: () => import('./views/onboarding.js'),
};
const TABS = [
  { id: 'today', label: 'Today', icon: 'home' },
  { id: 'food', label: 'Food', icon: 'bowl' },
  { id: 'train', label: 'Train', icon: 'dumbbell' },
  { id: 'body', label: 'Body', icon: 'heart' },
  { id: 'progress', label: 'Progress', icon: 'chart' },
];

let current = { tab: 'today', params: {} };
let date = todayKey();
let updater = null;
let raf = 0;
let renderToken = 0;
// Position in the left-to-right slide order. Settings is "one past" Progress so it pushes in from the right and Back slides out to the left.
const ORDER = ['today', 'food', 'train', 'body', 'progress', 'settings'];
const $ = (id) => document.getElementById(id);
// "#today?steps=6500" → { tab: 'today', params: { steps: '6500' } } (an iPhone Shortcut can hand the app a number this way)
function parseHash() {
  const raw = location.hash.replace(/^#/, ''), q = raw.indexOf('?');
  const tab = q >= 0 ? raw.slice(0, q) : raw, params = {};
  if (q >= 0) for (const [k, v] of new URLSearchParams(raw.slice(q + 1))) params[k] = v;
  return { tab, params };
}

export function ctx() {
  return {
    date, today: todayKey(),
    // opts.skipOut: the caller already animated the old view away (Today's swipe)
    setDate(k, opts = {}) { const dir = k < date ? -1 : k > date ? 1 : 0; date = k; return rerender(true, { dir, skipOut: !!opts.skipOut }); },
    go, params: current.params,
    refresh: () => rerender(true),
  };
}

const LAST_TAB = 'shredlog-last-tab';
export async function go(tab, params = {}) {
  if (!VIEWS[tab]) tab = 'today';
  if (tab !== 'onboarding') { try { localStorage.setItem(LAST_TAB, JSON.stringify({ tab, at: Date.now() })); } catch (e) { /* ignore */ } }
  const prev = current.tab;
  current = { tab, params };
  if (tab !== 'onboarding') { try { history.replaceState(null, '', '#' + tab); } catch (e) { /* ignore */ } }
  renderTabbar();
  const dir = tab !== prev && ORDER.includes(tab) && ORDER.includes(prev) ? Math.sign(ORDER.indexOf(tab) - ORDER.indexOf(prev)) : 0;
  await rerender(true, { dir, top: true });
  window.scrollTo({ top: 0 });
}

const hasFixed = (el) => !!(el && el.querySelector('.rest-banner:not(.hide), [data-mo-fixed]')); // a transformed ancestor would re-anchor position:fixed children
function errorCard(e) {
  return h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', null, 'This screen hit a problem'), 'Your data is safe. ', h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } },
    h('button', { class: 'btn primary', onClick: () => location.reload() }, 'Reload'), current.tab !== 'today' ? h('button', { class: 'btn', onClick: () => go('today') }, 'Go to Today') : null)));
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function rerender(full, opts = {}) {
  const app = $('app');
  if (!full && typeof updater === 'function') {
    try { updater(); } catch (e) { console.error(e); const st = app.querySelector('.mo-view'); if (st && !st.firstElementChild?.childElementCount) { clear(st); st.append(errorCard(e)); } }
    return;
  }
  const token = ++renderToken;
  const old = app.querySelector(':scope > .mo-view');
  const dir = opts.dir || 0;
  const slide = dir !== 0 && !prefersReducedMotion() && !!old && !!old.animate;
  const modP = VIEWS[current.tab]();
  let outAnim = null;
  if (slide && !opts.skipOut) {
    outAnim = old.animate(hasFixed(old) ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 1, transform: 'translateX(0)' }, { opacity: 0, transform: `translateX(${-dir * 12}px)` }], { duration: 90, easing: 'ease-in', fill: 'forwards' });
  }
  let mod;
  try { mod = await modP; } catch (e) { console.error(e); if (outAnim) outAnim.cancel(); toast('Could not open that screen. Check your connection.'); return; }
  if (outAnim) { try { await outAnim.finished; } catch (e) { /* cancelled */ } }
  if (token !== renderToken) return; // a newer navigation took over
  // Swap. The stage wrapper is what animates, so views keep appending into the container they are handed.
  const stage = h('div', { class: 'mo-view' });
  clear(app); app.append(stage);
  if (opts.top) window.scrollTo(0, 0);
  try { updater = mod.render(stage, ctx()) || null; }
  catch (e) { console.error(e); updater = null; clear(stage); stage.append(errorCard(e)); }
  if (!stage.firstElementChild) stage.append(errorCard(new Error('empty view')));
  if (slide && stage.animate) {
    stage.animate(hasFixed(stage) ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 0, transform: `translateX(${dir * 12}px)` }, { opacity: 1, transform: 'translateX(0)' }], { duration: 190, easing: EASE_OUT });
  }
}

function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { rerender(false); updateRestPill(); }); }

// ---- tab bar: built once; the active indicator slides, the rest pill floats above it ----
function tabPress(id) {
  if (id === current.tab && window.scrollY > 40) { window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' }); return; } // iOS habit: tap the active tab to scroll to top
  go(id);
}
function renderTabbar() {
  const bar = $('tabbar');
  if (current.tab === 'onboarding') { bar.classList.add('hide'); return; }
  bar.classList.remove('hide');
  if (!bar.querySelector('.mo-ind')) {
    clear(bar);
    bar.append(h('span', { class: 'mo-ind', 'aria-hidden': 'true' }, h('i')));
    for (const t of TABS) bar.append(h('button', { dataset: { id: t.id }, onClick: () => tabPress(t.id) }, h('span', { class: 'tb-ico' }, icon(t.icon, 24, 'ph-off'), icon.fill(t.icon, 24, 'ph-on')), t.label)); // duotone when idle, Phosphor fill on the active pill
    bar.append(h('button', { class: 'mo-rest', hidden: true, 'aria-label': 'Rest timer running. Open Train', onClick: () => go('train') }, icon('timer', 18), h('span', { class: 't' }), h('span', { class: 'n' })));
  }
  const ind = bar.querySelector('.mo-ind'), idx = TABS.findIndex((t) => t.id === current.tab);
  for (const b of bar.querySelectorAll('button[data-id]')) {
    const on = b.dataset.id === current.tab;
    if (on && !b.classList.contains('on') && ind.classList.contains('ready') && !prefersReducedMotion()) { b.classList.remove('mo-popin'); void b.offsetWidth; b.classList.add('mo-popin'); }
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  ind.style.transform = `translateX(${Math.max(0, idx) * 100}%)`;
  ind.classList.toggle('show', idx >= 0);
  if (!ind.classList.contains('ready')) requestAnimationFrame(() => requestAnimationFrame(() => ind.classList.add('ready'))); // first placement must not slide in from tab 0
  updateRestPill();
}

// Rest timer pill: visible on every tab except Train (which has its own banner) while a rest countdown is running.
let restTick = 0, restNotified = 0;
function updateRestPill() {
  const bar = $('tabbar'), pill = bar && bar.querySelector('.mo-rest');
  if (!pill) return;
  const r = state.active && state.active.rest, show = !!r && current.tab !== 'train' && current.tab !== 'onboarding' && !bar.classList.contains('hide');
  if (!r) { restNotified = 0; }
  if (!show) { if (!pill.hidden) pill.hidden = true; clearInterval(restTick); restTick = 0; return; }
  const left = Math.ceil((r.endAt - Date.now()) / 1000);
  if (left < -180) { pill.hidden = true; clearInterval(restTick); restTick = 0; return; } // stale: the timer ended long ago and Train was never opened
  const t = pill.querySelector('.t'), n = pill.querySelector('.n');
  const txt = left > 0 ? fmtClock(left) : 'Go';
  if (t.textContent !== txt) t.textContent = txt;
  const ex = state.active.exercises && state.active.exercises.find((e) => e.exId === r.exId);
  const name = left > 0 ? (ex ? ex.name : 'Rest') : 'Rest over';
  if (n.textContent !== name) n.textContent = name;
  pill.classList.toggle('soon', left > 0 && left <= 10); pill.classList.toggle('done', left <= 0);
  if (pill.hidden) pill.hidden = false;
  if (left <= 0 && restNotified !== r.endAt) { restNotified = r.endAt; haptic('success'); }
  if (!restTick) restTick = setInterval(updateRestPill, 1000);
}

// New personal record: a light confetti burst from the top of the screen, from whichever tab the workout ends on.
let workoutCount = 0;
function watchPRs() {
  workoutCount = state.workouts.length;
  on('workout', () => {
    const n = state.workouts.length, last = state.workouts[n - 1];
    if (n > workoutCount && last && last.prs && last.prs.length) { celebrate(null, { kind: 'pr' }); haptic('success'); }
    workoutCount = n;
  });
}

export function applyTheme() {
  const t = state.settings.theme || 'auto', a = state.settings.accent || 'haldi';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
  if (a === 'haldi') document.documentElement.removeAttribute('data-accent'); else document.documentElement.setAttribute('data-accent', a);
}

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing; if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Update ready', { action: 'Reload', ms: 30000, onAction: () => nw.postMessage('SKIP_WAITING') });
        }
      });
    });
    // A build downloaded on an earlier visit but never applied: offer it straight away.
    if (reg.waiting && navigator.serviceWorker.controller) toast('Update ready', { action: 'Reload', ms: 30000, onAction: () => reg.waiting && reg.waiting.postMessage('SKIP_WAITING') });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    // Home-screen apps resume from the background without reloading, so check on every return to the foreground (at most once a minute).
    let lastCheck = Date.now();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastCheck > 60 * 1000) { lastCheck = Date.now(); reg.update().catch(() => {}); } });
  }).catch((e) => console.warn('SW registration failed', e));
  // Reload only when a *new* worker replaces an old one. The very first claim must not reload: it would throw away onboarding mid-way.
  let controlled = !!navigator.serviceWorker.controller, reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (!controlled) { controlled = true; return; } if (reloading) return; reloading = true; location.reload(); });
}

let hiddenAt = 0;
async function lockIfNeeded() {
  if (!state.settings.pinHash) return;
  const bar = document.getElementById('tabbar'); bar.classList.add('hide');
  await renderLock(document.getElementById('app'));
  renderTabbar();
}
async function boot() {
  await load();
  applyTheme();
  await lockIfNeeded();
  on('change', schedule);
  on('settings', applyTheme);
  watchPRs();
  document.addEventListener('touchstart', () => {}, { passive: true }); // iOS only applies :active press feedback when a touch listener exists
  window.addEventListener('pagehide', () => { flush(); });
  // Coming back from the lock screen or another app must not throw the user to the top of the page: the view is
  // refreshed in place and the scroll position restored. Only a date change (past midnight) rebuilds the screen.
  let scrollAtHide = 0;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); scrollAtHide = window.scrollY; flush(); return; }
    const t = todayKey(), dayChanged = date < t; if (dayChanged) date = t;
    const locked = state.settings.pinHash && hiddenAt && Date.now() - hiddenAt > 60 * 1000;
    if (locked) { await lockIfNeeded(); }
    if (dayChanged) { await rerender(true); return; }
    if (locked || typeof updater !== 'function') await rerender(true); else rerender(false);
    const y = scrollAtHide; requestAnimationFrame(() => { window.scrollTo(0, y); requestAnimationFrame(() => window.scrollTo(0, y)); });
  });
  window.addEventListener('hashchange', () => { const { tab, params } = parseHash(); if (tab && (tab !== current.tab || Object.keys(params).length) && VIEWS[tab] && tab !== 'onboarding') go(tab, params); });
  if (storage.blocked) {
    document.body.insertBefore(h('div', { class: 'storage-warn', role: 'alert' }, icon('warn', 18), h('div', null, h('b', null, 'This phone is not saving your data. '), 'Everything you log will vanish when the app closes. In iPhone Settings → Safari turn off “Block All Cookies”, and open the app from the Home Screen icon, not a Private tab.')), document.getElementById('app'));
  }
  if (!state.settings.onboarded || !state.profile) { await go('onboarding'); }
  else {
    // A killed home-screen app relaunches without a hash: go back to where the user was (within 3 hours), and always to Train
    // while a workout is in progress.
    let { tab, params } = parseHash();
    if (!tab) { try { const last = JSON.parse(localStorage.getItem(LAST_TAB) || 'null'); if (last && Date.now() - last.at < 3 * 3600e3 && VIEWS[last.tab]) tab = last.tab; } catch (e) { /* ignore */ } }
    if (state.active && !tab) tab = 'train';
    await go(VIEWS[tab] && tab !== 'onboarding' ? tab : 'today', params);
  }
  registerSW();
}
boot().catch((e) => { console.error(e); document.getElementById('app').innerHTML = `<div class="empty"><b>Could not start</b>${e.message}</div>`; });
