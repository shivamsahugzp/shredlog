// App shell: boot, tab router, re-render on state change, service worker updates.
import { state, load, on, todayKey } from './state.js';
import { h, icon, toast, clear } from './ui.js';
import { renderLock } from './lock.js';

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

export function ctx() {
  return {
    date, today: todayKey(),
    setDate(k) { date = k; rerender(true); },
    go, params: current.params,
    refresh: () => rerender(true),
  };
}

export async function go(tab, params = {}) {
  if (!VIEWS[tab]) tab = 'today';
  current = { tab, params };
  if (tab !== 'onboarding') { try { history.replaceState(null, '', '#' + tab); } catch (e) { /* ignore */ } }
  renderTabbar();
  await rerender(true);
  window.scrollTo({ top: 0 });
}

async function rerender(full) {
  const app = document.getElementById('app');
  if (!full && typeof updater === 'function') { updater(); return; }
  const mod = await VIEWS[current.tab]();
  clear(app);
  updater = mod.render(app, ctx()) || null;
}

function schedule() { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => rerender(false)); }

function renderTabbar() {
  const bar = document.getElementById('tabbar');
  clear(bar);
  if (current.tab === 'onboarding') { bar.classList.add('hide'); return; }
  bar.classList.remove('hide');
  for (const t of TABS) {
    bar.append(h('button', { class: current.tab === t.id ? 'on' : '', 'aria-current': current.tab === t.id ? 'page' : null, onClick: () => go(t.id) }, icon(t.icon, 24), t.label));
  }
}

export function applyTheme() {
  const t = state.settings.theme || 'auto';
  if (t === 'auto') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', t);
}

function registerSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing; if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Update ready', { action: 'Reload', ms: 15000, onAction: () => nw.postMessage('SKIP_WAITING') });
        }
      });
    });
    setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
  }).catch((e) => console.warn('SW registration failed', e));
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (reloading) return; reloading = true; location.reload(); });
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
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    const t = todayKey(); if (date < t) date = t;
    if (state.settings.pinHash && hiddenAt && Date.now() - hiddenAt > 60 * 1000) { await lockIfNeeded(); }
    rerender(true);
  });
  window.addEventListener('hashchange', () => { const tab = location.hash.replace('#', ''); if (tab && tab !== current.tab && VIEWS[tab] && tab !== 'onboarding') go(tab); });
  if (!state.settings.onboarded || !state.profile) { await go('onboarding'); }
  else { const tab = location.hash.replace('#', ''); await go(VIEWS[tab] && tab !== 'onboarding' ? tab : 'today'); }
  registerSW();
}
boot().catch((e) => { console.error(e); document.getElementById('app').innerHTML = `<div class="empty"><b>Could not start</b>${e.message}</div>`; });
