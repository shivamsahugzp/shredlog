// Settings: profile, plan, targets, habits, appearance, lock, data, install guide, about.
import { state, setProfile, setTargets, recomputeTargets, setSetting, exportJSON, importJSON, resetAll, allFoods, todayKey, commit, storage } from '../state.js';
import { ACTIVITY, GOALS, tdee, defaultTargets } from '../calc.js';
import { h, icon, sheet, toast, confirmSheet, stepper, segmented, chips, field, toggle, downloadText, pickFile, clear, fmt, relTime, haptic } from '../ui.js';
import { hashPin, renderLock } from '../lock.js';
import { aiSettingsSection } from './food-scan.js';
import { countUp, growBars, stagger, quiet, pop, pulse } from '../motion.js';

import { VERSION as BUILD, BUILT } from '../version.js';
const APP_VERSION = '2.0';
const ACCENTS = [{ id: 'haldi', label: 'Haldi' }, { id: 'neel', label: 'Neel' }, { id: 'pudina', label: 'Pudina' }, { id: 'sindoor', label: 'Sindoor' }];
const THEMES = [{ id: 'auto', label: 'Auto' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }];

// Inline controls (steppers, segmented, selects) write state on every tick. The screen must not rebuild under a finger that is still
// holding a stepper, so a rebuild right after an inline edit is held back until the edits stop.
let redraw = () => {}, lastEdit = 0;
const edit = (fn) => (...a) => { lastEdit = performance.now(); return fn(...a); };

export function render(container, ctx) {
  const root = h('div', { class: 'st' }); container.append(root);
  let drawn = false, timer = 0;
  const draw = () => {
    const y = window.scrollY;
    let content;
    const run = () => { content = build(ctx); clear(root); root.append(content); };
    if (drawn) quiet(run); else run();
    if (y) window.scrollTo(0, y);
    growBars(root, '.st-macro > span', { key: 'st' });
    const kc = root.querySelector('.st-kcal-num'); if (kc) countUp(kc, +kc.dataset.v, { key: 'st:kcal', ms: 600, fmt: (v) => fmt(Math.round(v)) });
    if (!drawn) { const av = root.querySelector('.st-avatar'); if (av) pop(av); stagger(content, { key: 'settings' }); }
    drawn = true;
  };
  redraw = draw;
  draw();
  return () => {
    if (performance.now() - lastEdit < 700) { clearTimeout(timer); timer = setTimeout(() => { if (root.isConnected) draw(); }, 650); return; }
    draw();
  };
}

// ---------- helpers ----------
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '—');
const DIET = { veg: 'Vegetarian', egg: 'Eggetarian', nonveg: 'Non-veg', vegan: 'Vegan', jain: 'Jain' };
// ui.js segmented() sets --n/--i with Object.assign(el.style, ...), which ignores custom properties: set them properly here.
function seg(options, value, onChange, cls) {
  const el = segmented(options, value, onChange, cls);
  el.style.setProperty('--n', String(options.length)); el.style.setProperty('--i', String(Math.max(0, options.findIndex((o) => o.id === value))));
  return el;
}
const num1 = (v) => String(+(+v).toFixed(1));
const NS = 'http://www.w3.org/2000/svg';
// Local glyphs for things ui.js has no icon for (same 24-grid stroke style as icon()).
const GLYPH = {
  compass: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM16 8l-2.5 5.5L8 16l2.5-5.5z',
  phone: 'M8 2h8a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18.5h2',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
  addBox: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM12 8v8M8 12h8',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
};
function glyph(name, size = 20) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const p = document.createElementNS(NS, 'path'); p.setAttribute('d', GLYPH[name]); svg.append(p);
  return svg;
}
const wellOf = (ico, cls = '') => h('span', { class: 'well ' + cls }, typeof ico === 'string' ? (GLYPH[ico] ? glyph(ico) : icon(ico)) : ico);
const section = (title, right, ...kids) => h('section', { class: 'section st-sec' }, h('div', { class: 'section-head' }, h('h2', null, title), right || null), kids);
// A tappable settings row: icon well, a title that never wraps, a short trailing value (ellipsised, never the title), chevron.
const row = ({ ico, cls, title, sub, trail, onClick }) => h('button', { class: 'list-item st-row', onClick },
  wellOf(ico, cls), h('div', { class: 'grow' }, h('div', { class: 'title' }, title), sub ? h('div', { class: 'sub' }, sub) : null),
  trail != null ? h('div', { class: 'trail' }, trail) : null, onClick ? icon('right', 18) : null);
// A control row: well + title + short value, with the control underneath at full width.
const setRow = ({ ico, cls, title, value, control }) => h('div', { class: 'st-set' },
  h('div', { class: 'st-set-head' }, wellOf(ico, cls), h('div', { class: 'title' }, title), value != null ? h('div', { class: 'val' }, value) : null),
  control ? h('div', { class: 'st-set-ctl' }, control) : null);

// Read a token set for a given theme/accent without painting it: set the attributes, read computed style, put them back (all in one tick).
function probe(theme, accent) {
  const el = document.documentElement, ta = el.getAttribute('data-theme'), aa = el.getAttribute('data-accent');
  const set = (a, v) => (v == null ? el.removeAttribute(a) : el.setAttribute(a, v));
  try {
    set('data-theme', theme); set('data-accent', !accent || accent === 'haldi' ? null : accent);
    const cs = getComputedStyle(el), g = (k) => cs.getPropertyValue(k).trim();
    return { bg: g('--bg'), card: g('--card'), ink: g('--ink'), accent: g('--accent'), onAccent: g('--accent-ink') };
  } finally { set('data-theme', ta); set('data-accent', aa); }
}
const miniPrev = (tk) => h('span', { class: 'st-mini', style: { background: tk.bg } }, h('i', { style: { background: tk.card } }), h('b', { style: { background: tk.ink } }), h('s', { style: { background: tk.accent } }));

// ---------- build ----------
function build(ctx) {
  const p = state.profile || {}, t = state.targets || {}, s = state.settings;
  const goal = GOALS.find((g) => g.id === p.goal), act = ACTIVITY.find((a) => a.id === p.activity);
  const entries = Object.values(state.log).reduce((a, d) => a + (d.food?.length || 0) + (d.habits?.length || 0), 0) + state.workouts.length;
  const name = (p.name || '').trim();
  const daysLogged = Object.values(state.log).filter((d) => d.food?.length || d.habits?.length || d.weight || d.sleep).length;
  const theme = s.theme || 'auto', accent = s.accent || 'haldi';
  const light = probe('light', accent), dark = probe('dark', accent);

  // ---- hero: who you are ----
  const hero = h('button', { class: 'card st-hero pressable', onClick: () => profileSheet(ctx), 'aria-label': 'Edit profile' },
    h('span', { class: 'st-avatar', 'aria-hidden': 'true' }, (name[0] || 'S').toUpperCase()),
    h('span', { class: 'st-hero-main' },
      h('span', { class: 'st-hero-name' }, name || 'Your profile'),
      h('span', { class: 'st-hero-sub' }, p.age ? `${p.age} y · ${p.heightCm} cm · ${num1(p.weightKg)} kg` : 'Add your details'),
      h('span', { class: 'st-chips' }, goal ? h('span', { class: 'pill accent' }, goal.label) : null, p.diet ? h('span', { class: 'pill' }, DIET[p.diet] || cap(p.diet)) : null)),
    h('span', { class: 'st-edit' }, icon('edit', 18)));

  // ---- targets: one picture of the day ----
  const e = (p.age ? tdee(p) : 0);
  const kc = (t.p || 0) * 4 + (t.c || 0) * 4 + (t.f || 0) * 9 || 1;
  const w = (v) => (v / kc * 100) + '%';
  const targetsCard = h('button', { class: 'card st-targets pressable', onClick: () => targetsSheet(), 'aria-label': 'Edit daily targets' },
    h('span', { class: 'st-kcal' },
      h('span', { class: 'num-lg' }, h('span', { class: 'st-kcal-num', dataset: { v: String(t.kcal || 0) } }, fmt(t.kcal)), h('small', null, 'kcal / day')),
      h('span', { class: 'st-edit' }, icon('edit', 18))),
    h('span', { class: 'st-macro', 'aria-hidden': 'true' }, h('span', { class: 'p', style: { width: w((t.p || 0) * 4) } }), h('span', { class: 'c', style: { width: w((t.c || 0) * 4) } }), h('span', { class: 'f', style: { width: w((t.f || 0) * 9) } })),
    h('span', { class: 'macro-legend' },
      h('span', null, h('span', { class: 'lbl' }, h('i', { class: 'dot p' }), 'Protein'), h('span', { class: 'val' }, t.p ?? '–', h('small', null, ' g'))),
      h('span', null, h('span', { class: 'lbl' }, h('i', { class: 'dot c' }), 'Carbs'), h('span', { class: 'val' }, t.c ?? '–', h('small', null, ' g'))),
      h('span', null, h('span', { class: 'lbl' }, h('i', { class: 'dot f' }), 'Fat'), h('span', { class: 'val' }, t.f ?? '–', h('small', null, ' g')))),
    h('span', { class: 'st-chips st-extra' },
      h('span', { class: 'pill' }, `Fibre ${t.fiber ?? '–'} g`), h('span', { class: 'pill' }, `Water ${t.water ?? 8} glasses`), p.smoker ? h('span', { class: 'pill' }, `Cigarette limit ${t.cigLimit ?? '–'}`) : null));

  // ---- habits & logging ----
  const chaiOpts = allFoods().filter((f) => /^(chai|black_tea|green_tea|masala_chai|kadak|cutting|tea|coffee|filter_coffee|black_coffee)/.test(f.id));
  const smokerOpen = h('div', { class: 'st-subset' + (p.smoker ? '' : ' hide') },
    h('div', { class: 'grid-2' },
      field('Per day now', stepper({ value: p.cigBaseline || 5, min: 1, max: 60, onChange: edit((v) => setProfile({ cigBaseline: v })) })),
      field('Cost each (₹)', stepper({ value: p.cigCost || 18, min: 1, max: 100, onChange: edit((v) => setProfile({ cigCost: v })) }))));
  const smoker = h('div', { class: 'st-set st-tg' },
    h('div', { class: 'st-set-head' }, wellOf('cig', 'cig'), toggle('I smoke', !!p.smoker, (v) => { lastEdit = performance.now(); setProfile({ smoker: v }); smokerOpen.classList.toggle('hide', !v); }, 'Count, money and streaks')),
    smokerOpen);
  const habits = h('div', { class: 'list st-list' },
    setRow({ ico: 'cup', cls: 'chai', title: 'One-tap chai', control: h('select', { 'aria-label': 'One-tap chai', onChange: edit((ev) => setProfile({ chaiFoodId: ev.target.value })) }, chaiOpts.map((f) => h('option', { value: f.id, selected: f.id === p.chaiFoodId }, f.name))) }),
    smoker,
    setRow({ ico: 'timer', cls: 'train', title: 'Rest timer', value: `${s.restSec || 90} s`, control: seg([60, 90, 120, 150, 180].map((v) => ({ id: v, label: v + 's' })), s.restSec || 90, edit((v) => setSetting('restSec', v))) }),
    setRow({ ico: 'drop', cls: 'water', title: 'Water glass', value: `${s.glassMl || 250} ml`, control: seg([200, 250, 300].map((v) => ({ id: v, label: v + ' ml' })), s.glassMl || 250, edit((v) => setSetting('glassMl', v))) }),
    setRow({ ico: 'moon', cls: 'sleep', title: 'Sleep target', value: `${p.sleepTarget || 7.5} h a night`, control: stepper({ value: p.sleepTarget || 7.5, min: 4, max: 12, step: 0.5, onChange: edit((v) => setProfile({ sleepTarget: v })) }) }));

  // ---- appearance: previews drawn from the real tokens ----
  const themeBtns = THEMES.map((th) => {
    const prev = th.id === 'auto' ? h('span', { class: 'st-prev split' }, miniPrev(light), miniPrev(dark)) : h('span', { class: 'st-prev' }, miniPrev(th.id === 'light' ? light : dark));
    return h('button', { class: 'st-theme' + (theme === th.id ? ' on' : ''), role: 'radio', 'aria-checked': theme === th.id ? 'true' : 'false', dataset: { id: th.id }, onClick: (ev) => pick(themeRow, ev.currentTarget, th.id, 'theme') }, prev, h('span', { class: 'st-theme-name' }, th.label));
  });
  const themeRow = h('div', { class: 'st-themes', role: 'radiogroup', 'aria-label': 'Theme' }, themeBtns);
  const accBtns = ACCENTS.map((a) => {
    const tk = probe(theme === 'auto' ? null : theme, a.id);
    const b = h('button', { class: 'st-acc' + (accent === a.id ? ' on' : ''), role: 'radio', 'aria-checked': accent === a.id ? 'true' : 'false', 'aria-label': a.label, dataset: { id: a.id }, onClick: (ev) => pick(accRow, ev.currentTarget, a.id, 'accent') },
      h('span', { class: 'st-sw', style: { background: tk.accent, color: tk.onAccent } }, icon('check', 18)), h('span', { class: 'st-acc-name' }, a.label));
    b.style.setProperty('--sw', tk.accent);
    return b;
  });
  const accRow = h('div', { class: 'st-accents', role: 'radiogroup', 'aria-label': 'Accent colour' }, accBtns);
  function pick(group, btn, id, key) {
    lastEdit = performance.now();
    group.querySelectorAll('[role=radio]').forEach((b) => { const on = b === btn; b.classList.toggle('on', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); });
    pulse(btn, { scale: 1.06, ms: 300 }); haptic('tap');
    setSetting(key, id);
  }
  const appearance = h('div', { class: 'card st-appear' },
    h('div', { class: 'st-lbl' }, 'Theme'), themeRow,
    h('div', { class: 'st-lbl' }, 'Accent colour'), accRow);

  // ---- app lock ----
  const lockCard = h('div', { class: 'list st-list' },
    h('div', { class: 'st-set st-tg' }, h('div', { class: 'st-set-head' }, wellOf('shield', s.pinHash ? 'good' : ''), toggle('Ask for a 4-digit PIN', !!s.pinHash, (v) => pinToggle(v), 'On open, and after a minute away'))),
    s.pinHash ? row({ ico: 'lock', title: 'Change PIN', sub: 'Enter the current one first', onClick: () => pinChange() }) : null,
    h('div', { class: 'st-note' }, 'The PIN never leaves this phone. If you forget it, the only way in is to reset all data, so keep a backup.'));

  // ---- your data ----
  const blocked = storage.blocked;
  const storeChip = (label, st) => h('span', { class: 'st-store ' + (st === 'ok' ? 'ok' : st === 'failed' ? 'fail' : '') }, h('i'), label);
  const lastBackup = state.meta.lastBackup, backupAge = lastBackup ? Math.floor((Date.now() - lastBackup) / 864e5) : null;
  const backupPill = backupAge == null ? ['warn', 'Never backed up'] : backupAge > 14 ? ['warn', `Backed up ${backupAge} days ago`] : ['good', backupAge === 0 ? 'Backed up today' : `Backed up ${backupAge} day${backupAge === 1 ? '' : 's'} ago`];
  const dataBlock = h('div', { class: 'stack' },
    h('div', { class: 'card st-save' },
      h('div', { class: 'st-save-row' }, wellOf(blocked ? 'warn' : 'check', blocked ? 'bad' : 'good'),
        h('div', { class: 'grow' }, h('div', { class: 'strong st-save-t' }, 'Saved on this phone'), h('div', { class: 'small muted st-save-s' + (blocked ? ' text-danger' : '') }, storageLabel())),
        h('span', { class: 'pill ' + (blocked ? 'bad' : 'good') }, blocked ? 'Not saving' : 'Safe')),
      h('div', { class: 'st-stores' }, storeChip('Quick store', storage.ls), storeChip('Phone database', storage.idb)),
      blocked ? h('div', { class: 'callout small danger', style: { marginTop: '12px' } }, icon('warn'), h('div', null, 'Safari is refusing to store data (', storage.lastError || 'unknown error', '). Turn off Settings → Safari → Block All Cookies and open the app from the Home Screen icon, not a Private tab.')) : null),
    h('div', { class: 'st-stats' },
      h('div', { class: 'tile' }, h('div', { class: 'lbl' }, 'Entries'), h('div', { class: 'val' }, fmt(entries))),
      h('div', { class: 'tile' }, h('div', { class: 'lbl' }, 'Workouts'), h('div', { class: 'val' }, fmt(state.workouts.length))),
      h('div', { class: 'tile' }, h('div', { class: 'lbl' }, 'Days logged'), h('div', { class: 'val' }, fmt(daysLogged)))),
    h('span', { class: 'pill ' + backupPill[0], style: { alignSelf: 'flex-start' } }, backupPill[1]),
    h('div', { class: 'row' },
      h('button', { class: 'btn primary grow', onClick: () => { downloadText(`shredlog-backup-${todayKey()}.json`, exportJSON()); state.meta.lastBackup = Date.now(); commit(); toast('Backup file ready. Save it to Files or iCloud.'); } }, icon('download'), 'Export backup'),
      h('button', { class: 'btn grow', onClick: async () => { const txt = await pickFile(); if (!txt) return; if (!(await confirmSheet('This replaces everything on this phone with the backup file.', { ok: 'Import', title: 'Import backup?' }))) return; try { await importJSON(txt); toast('Backup restored'); ctx.go('today'); } catch (err) { toast(err.message); } } }, icon('upload'), 'Import')),
    h('div', { class: 'callout small' }, icon('warn'), h('div', null, 'iPhone deletes this app’s data if you remove the icon. Export a backup every few weeks and keep it in iCloud Drive.')),
    h('button', { class: 'btn danger block', onClick: async () => { if (await confirmSheet('Deletes every log, workout and setting on this phone. Export a backup first.', { ok: 'Delete everything', danger: true })) { await resetAll(); ctx.go('onboarding'); } } }, icon('trash'), 'Reset all data'));

  // ---- install guide ----
  const how = [['compass', 'Open this page in Safari, not Chrome.'], ['share', 'Tap the Share button, the square with an arrow.'], ['addBox', 'Scroll and tap “Add to Home Screen”, then Add.'], ['home', 'Open ShredLog from the icon from now on. The Safari tab and the icon do not share data.']];
  const install = h('div', { class: 'card' },
    h('ol', { class: 'st-how' }, how.map(([g, text], i) => h('li', null, h('span', { class: 'st-n' }, String(i + 1)), h('span', { class: 'st-how-t' }, text), h('span', { class: 'st-how-g' }, GLYPH[g] ? glyph(g, 18) : icon(g, 18))))),
    h('button', { class: 'btn sm block', style: { marginTop: '16px' }, onClick: () => { state.settings.hideInstallHint = false; commit(); toast('Install hint will show on Today'); } }, 'Show the hint again'));

  // ---- about ----
  const about = h('div', { class: 'card st-about' },
    h('div', { class: 'st-about-head' }, h('div', { class: 'mark' }, 'S'), h('div', { class: 'grow' }, h('div', { class: 'st-about-name' }, 'ShredLog'), h('div', { class: 'small muted' }, `Version ${APP_VERSION} · build ${BUILD} · ${BUILT}`))),
    h('button', { class: 'btn sm block st-update', style: { marginTop: '12px' }, onClick: checkForUpdate }, icon('reset', 18), 'Check for update'),
    h('p', { class: 'small ink2' }, 'Free and personal. No account, no ads, no server: your data never leaves this phone unless you export it.'),
    h('div', { class: 'st-credits' },
      h('div', { class: 'st-credit' }, h('span', { class: 'muted' }, 'Exercises'), h('span', null, 'free-exercise-db (Unlicense)')),
      h('div', { class: 'st-credit' }, h('span', { class: 'muted' }, 'Indian foods'), h('span', null, 'IFCT 2017 (NIN) and home recipes')),
      h('div', { class: 'st-credit' }, h('span', { class: 'muted' }, 'Typeface'), h('span', null, 'Bricolage Grotesque (OFL)'))),
    h('p', { class: 'micro muted' }, 'Food values are good estimates, not lab numbers; oil and portion size are the biggest errors. Nothing here is medical advice. If a symptom worries you, see a doctor.'));

  return h('div', { class: 'st-all' },
    h('div', { class: 'screen-head st-head' },
      h('button', { class: 'icon-btn', 'aria-label': 'Back to Today', onClick: () => ctx.go('today') }, icon('left')),
      h('div', null, h('h1', null, 'Settings'), h('div', { class: 'sub' }, 'Everything lives on this phone.'))),
    h('div', { class: 'st-first' }, hero),
    section('Your plan', null, h('div', { class: 'list st-list' },
      row({ ico: 'zap', cls: 'food', title: 'Activity & goal', sub: `${act ? act.label.split(/[:,]/)[0] : '—'} · ${goal?.label || '—'}`, onClick: () => profileSheet(ctx, 1) }),
      row({ ico: 'leaf', cls: 'good', title: 'Diet & budget', sub: `${DIET[p.diet] || cap(p.diet)} · ${cap(p.region)} · ${cap(p.budget)} budget`, onClick: () => profileSheet(ctx, 2) }))),
    section('Daily targets', h('span', { class: 'pill ' + (t.auto === false ? 'warn' : 'good') }, t.auto === false ? 'Manual' : 'Auto from profile'), targetsCard,
      h('div', { class: 'st-note' }, `Maintenance by formula: ${fmt(e)} kcal. Progress shows your measured burn once you have about 2 weeks of data.`)),
    section('Habits & logging', null, habits),
    h('div', { class: 'st-ai' }, aiSettingsSection(ctx)),
    section('Appearance', null, appearance),
    section('App lock', null, lockCard),
    section('Your data', null, dataBlock),
    section('Install on iPhone', null, install),
    section('About', null, about));
}

// Ask the service worker for a newer build right now; if one is already downloaded, switch to it (app.js reloads on controllerchange).
async function checkForUpdate() {
  if (!('serviceWorker' in navigator)) return toast('Updates need the installed app');
  toast('Checking for a newer build…');
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return toast('Open the app from the Home Screen icon to get updates');
    await reg.update();
    const apply = (w) => { toast('New build found. Reloading…', { ms: 4000 }); w.postMessage('SKIP_WAITING'); };
    if (reg.waiting) return apply(reg.waiting);
    if (reg.installing) { reg.installing.addEventListener('statechange', (e) => { if (e.target.state === 'installed' && reg.waiting) apply(reg.waiting); }); return; }
    toast(`You are on the latest build (${BUILD})`);
  } catch (e) { toast('Could not check: ' + (e.message || 'no connection')); }
}
function storageLabel() {
  if (storage.blocked) return 'Not saving';
  const stores = (storage.ls === 'ok' ? 1 : 0) + (storage.idb === 'ok' ? 1 : 0);
  const when = storage.lastSaved ? relTime(storage.lastSaved) : 'nothing yet';
  return `${when} · ${stores} of 2 stores`;
}

// ---------- sheets ----------
function profileSheet(ctx, section = 0) {
  const p = { ...state.profile };
  const num = (k, unit, st = 1) => h('div', { class: 'row' }, h('input', { type: 'number', inputmode: 'decimal', value: p[k] ?? '', step: st, onInput: (e) => { p[k] = e.target.value === '' ? null : +e.target.value; } }), unit ? h('span', { class: 'muted small', style: { width: '30px', flex: 'none' } }, unit) : null);
  const body = h('div', { class: 'stack' });
  if (section === 0) body.append(field('Name', h('input', { type: 'text', value: p.name || '', autocomplete: 'given-name', onInput: (e) => { p.name = e.target.value; } })), field('Sex', seg([{ id: 'male', label: 'Male' }, { id: 'female', label: 'Female' }], p.sex, (v) => { p.sex = v; })), h('div', { class: 'grid-3' }, field('Age', num('age')), field('Height', num('heightCm', 'cm')), field('Weight', num('weightKg', 'kg', 0.1))));
  if (section === 1) body.append(field('Activity', h('select', { onChange: (e) => { p.activity = e.target.value; } }, ACTIVITY.map((a) => h('option', { value: a.id, selected: a.id === p.activity }, a.label)))), field('Goal', h('select', { onChange: (e) => { p.goal = e.target.value; } }, GOALS.map((g) => h('option', { value: g.id, selected: g.id === p.goal }, `${g.label} — ${g.sub}`)))), field('Target weight', num('targetWeightKg', 'kg', 0.5)));
  if (section === 2) body.append(field('Diet', chips([{ id: 'veg', label: 'Vegetarian' }, { id: 'egg', label: 'Eggetarian' }, { id: 'nonveg', label: 'Non-veg' }, { id: 'vegan', label: 'Vegan' }, { id: 'jain', label: 'Jain' }], p.diet, (v) => { p.diet = v; })), field('Home cuisine', chips([{ id: 'north', label: 'North' }, { id: 'south', label: 'South' }, { id: 'east', label: 'East' }, { id: 'west', label: 'West' }, { id: 'mixed', label: 'Mixed' }], p.region, (v) => { p.region = v; })), field('Food budget', chips([{ id: 'tight', label: 'Tight' }, { id: 'moderate', label: 'Moderate' }, { id: 'flexible', label: 'Flexible' }], p.budget, (v) => { p.budget = v; })));
  sheet({ title: ['Profile', 'Activity & goal', 'Diet & budget'][section], content: body, actions: (api) => [h('button', { class: 'btn primary', onClick: () => {
    // age, height and weight feed every calorie formula: an empty one would turn the targets into NaN
    if (section === 0 && (!p.age || !p.heightCm || !p.weightKg)) { toast('Age, height and weight are needed'); return; }
    setProfile(p); api.close(); toast('Saved');
  } }, 'Save')] });
}

function targetsSheet() {
  const t = { ...state.targets };
  const presets = [{ id: 'hp', label: 'High-protein cut', p: 0.4, c: 0.3, f: 0.3 }, { id: 'bal', label: 'Balanced', p: 0.3, c: 0.4, f: 0.3 }, { id: 'lc', label: 'Lower carb', p: 0.35, c: 0.25, f: 0.4 }];
  const body = h('div', { class: 'stack' });
  const rows = h('div', { class: 'stack' });
  const drawRows = () => { clear(rows); rows.append(
    field('Calories per day', stepper({ value: t.kcal, min: 1000, max: 6000, step: 10, onChange: (v) => { t.kcal = v; } })),
    h('div', { class: 'grid-3' }, field('Protein g', stepper({ value: t.p, min: 40, max: 400, step: 5, onChange: (v) => { t.p = v; } })), field('Carbs g', stepper({ value: t.c, min: 30, max: 700, step: 5, onChange: (v) => { t.c = v; } })), field('Fat g', stepper({ value: t.f, min: 20, max: 250, step: 5, onChange: (v) => { t.f = v; } }))),
    h('div', { class: 'grid-3' }, field('Fibre g', stepper({ value: t.fiber, min: 10, max: 80, onChange: (v) => { t.fiber = v; } })), field('Water glasses', stepper({ value: t.water || 8, min: 2, max: 20, onChange: (v) => { t.water = v; } })), state.profile?.smoker ? field('Cigarette limit', stepper({ value: t.cigLimit ?? 0, min: 0, max: 60, onChange: (v) => { t.cigLimit = v; } })) : null)); };
  drawRows();
  body.append(field('Macro split presets (from calories)', chips(presets, null, (id) => { const pr = presets.find((x) => x.id === id); t.p = Math.round(t.kcal * pr.p / 4); t.c = Math.round(t.kcal * pr.c / 4); t.f = Math.round(t.kcal * pr.f / 9); drawRows(); })), rows,
    h('button', { class: 'btn sm', onClick: () => { Object.assign(t, defaultTargets(state.profile)); drawRows(); } }, icon('reset'), 'Recalculate from profile'));
  sheet({ title: 'Daily targets', content: body, actions: (api) => [h('button', { class: 'btn', onClick: () => { recomputeTargets(); api.close(); toast('Back to auto targets'); } }, 'Use auto'), h('button', { class: 'btn primary', onClick: () => { setTargets(t); api.close(); toast('Targets saved'); } }, 'Save manual')] });
}

// ---------- PIN ----------
async function pinToggle(on) {
  if (!on) {
    const box = h('div'); const sh = sheet({ title: 'Turn off PIN lock', content: box, closeLabel: true, onClose: () => redraw() });
    renderLock(box, { allowForgot: false, sub: 'Enter it to turn the lock off' }).then(() => { sh.onClose = null; sh.close(); setSetting('pinHash', null); toast('PIN removed'); redraw(); });
    return;
  }
  const box = h('div'); const sh = sheet({ title: 'Choose a 4-digit PIN', content: box, onClose: () => redraw() });
  const first = await renderLock(box, { title: 'Choose a 4-digit PIN', verifyHash: null, allowForgot: false, sub: 'You will use it every time you open the app' });
  const firstHash = await hashPin(first);
  const again = await renderLock(box, { title: 'Enter it again', verifyHash: firstHash, allowForgot: false, sub: 'Once more to confirm', wrongMsg: 'That is not the same PIN. Try again.' }).catch(() => null);
  if (again) { setSetting('pinHash', firstHash); sh.onClose = null; sh.close(); toast('PIN set'); redraw(); }
}
// Change = prove the old PIN, then the same two-step set flow. The stored hash only changes once both new entries match.
async function pinChange() {
  const box = h('div'); const sh = sheet({ title: 'Change PIN', content: box, onClose: () => redraw() });
  await renderLock(box, { title: 'Enter current PIN', allowForgot: false, sub: 'Then you will choose a new one' });
  const first = await renderLock(box, { title: 'Choose a new PIN', verifyHash: null, allowForgot: false, sub: '4 digits' });
  const firstHash = await hashPin(first);
  const again = await renderLock(box, { title: 'Enter it again', verifyHash: firstHash, allowForgot: false, sub: 'Once more to confirm', wrongMsg: 'That is not the same PIN. Try again.' }).catch(() => null);
  if (again) { setSetting('pinHash', firstHash); sh.onClose = null; sh.close(); toast('PIN changed'); redraw(); }
}
