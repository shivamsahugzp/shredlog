// Settings: profile, targets, habits, appearance, backup, install guide.
import { state, setProfile, setTargets, recomputeTargets, setSetting, exportJSON, importJSON, resetAll, allFoods, todayKey, commit, storage } from '../state.js';
import { ACTIVITY, GOALS, tdee, defaultTargets } from '../calc.js';
import { h, icon, sheet, toast, confirmSheet, stepper, segmented, chips, field, toggle, downloadText, pickFile, clear, fmt, relTime } from '../ui.js';
import { hashPin, renderLock } from '../lock.js';

export function render(container, ctx) {
  const root = h('div'); container.append(root);
  const draw = () => { clear(root); root.append(build(ctx)); };
  draw(); return draw;
}

const row = (label, value, onClick) => h('button', { class: 'list-item', onClick }, h('div', { class: 'grow' }, h('div', { class: 'title' }, label)), h('div', { class: 'trail' }, value), onClick ? icon('right', 18) : null);

function build(ctx) {
  const p = state.profile || {}, t = state.targets || {}, s = state.settings;
  const goal = GOALS.find((g) => g.id === p.goal), act = ACTIVITY.find((a) => a.id === p.activity);
  const entries = Object.values(state.log).reduce((a, d) => a + (d.food?.length || 0) + (d.habits?.length || 0), 0) + state.workouts.length;
  return h('div', null,
    h('div', { class: 'screen-head' }, h('div', null, h('h1', null, 'Settings'), h('div', { class: 'sub' }, 'Everything lives on this phone. Back it up now and then.')), h('button', { class: 'icon-btn plain', 'aria-label': 'Back', onClick: () => ctx.go('today') }, icon('x'))),

    h('div', { class: 'section-head' }, h('h2', null, 'You')),
    h('div', { class: 'list' },
      row('Profile', `${p.name || '—'} · ${p.age} y · ${p.heightCm} cm · ${p.weightKg} kg`, () => profileSheet(ctx)),
      row('Activity & goal', `${act?.label.split(':')[0] || '—'} · ${goal?.label || '—'}`, () => profileSheet(ctx, 1)),
      row('Diet & budget', `${cap(p.diet)} · ${cap(p.region)} · ${cap(p.budget)} budget`, () => profileSheet(ctx, 2))),

    h('div', { class: 'section-head', style: { marginTop: '18px' } }, h('h2', null, 'Daily targets'), h('span', { class: 'pill ' + (t.auto === false ? 'warn' : 'good') }, t.auto === false ? 'Manual' : 'Auto from profile')),
    h('div', { class: 'list' },
      row('Calories', `${fmt(t.kcal)} kcal`, () => targetsSheet()),
      row('Protein / Carbs / Fat', `${t.p} / ${t.c} / ${t.f} g`, () => targetsSheet()),
      row('Fibre · Water · Cigarette limit', `${t.fiber} g · ${t.water} glasses${p.smoker ? ` · ${t.cigLimit ?? '—'}` : ''}`, () => targetsSheet())),
    h('div', { class: 'small muted', style: { marginTop: '6px' } }, `Maintenance by formula: ${fmt(p.age ? tdee(p) : 0)} kcal. Progress shows your measured burn once you have ~2 weeks of data.`),

    h('div', { class: 'section-head', style: { marginTop: '18px' } }, h('h2', null, 'Habits & logging')),
    h('div', { class: 'card stack' },
      field('One-tap chai', h('select', { onChange: (e) => setProfile({ chaiFoodId: e.target.value }) }, allFoods().filter((f) => /^(chai|black_tea|green_tea|masala_chai|kadak|cutting|tea|coffee|filter_coffee|black_coffee)/.test(f.id)).map((f) => h('option', { value: f.id, selected: f.id === p.chaiFoodId }, f.name)))),
      toggle('I smoke', !!p.smoker, (v) => { setProfile({ smoker: v }); ctx.refresh(); }),
      p.smoker ? h('div', { class: 'grid-2' }, field('Baseline per day', stepper({ value: p.cigBaseline || 5, min: 1, max: 60, onChange: (v) => setProfile({ cigBaseline: v }) })), field('Cost per cigarette (₹)', stepper({ value: p.cigCost || 18, min: 1, max: 100, onChange: (v) => setProfile({ cigCost: v }) }))) : null,
      field('Rest timer default', segmented([60, 90, 120, 150, 180].map((v) => ({ id: v, label: v + 's' })), s.restSec || 90, (v) => setSetting('restSec', v))),
      field('Water glass', segmented([200, 250, 300].map((v) => ({ id: v, label: v + ' ml' })), s.glassMl || 250, (v) => setSetting('glassMl', v))),
      field('Sleep target', h('div', { class: 'row' }, stepper({ value: p.sleepTarget || 7.5, min: 4, max: 12, step: 0.5, onChange: (v) => setProfile({ sleepTarget: v }) }), h('span', { class: 'muted small' }, 'hours')))),

    h('div', { class: 'section-head', style: { marginTop: '18px' } }, h('h2', null, 'Appearance')),
    h('div', { class: 'card' }, segmented([{ id: 'auto', label: 'Auto' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }], s.theme || 'auto', (v) => setSetting('theme', v))),

    h('div', { class: 'section-head', style: { marginTop: '18px' } }, h('h2', null, 'App lock')),
    h('div', { class: 'card' },
      toggle('Ask for a 4-digit PIN', !!s.pinHash, (v) => pinToggle(v, ctx), 'On open, and after a minute in the background'),
      h('div', { class: 'small muted' }, 'The PIN never leaves this phone. If you forget it, the only way in is to reset all data, so keep a backup.')),

    h('div', { class: 'section-head', style: { marginTop: '18px' } }, h('h2', null, 'Your data')),
    h('div', { class: 'card stack' },
      h('div', { class: 'row between small' }, h('span', { class: 'muted' }, 'Entries stored'), h('b', null, fmt(entries))),
      h('div', { class: 'row between small' }, h('span', { class: 'muted' }, 'Saved on this phone'), h('b', { class: storage.blocked ? 'text-danger' : '' }, storageLabel())),
      storage.blocked ? h('div', { class: 'callout small danger' }, icon('warn'), h('div', null, 'Safari is refusing to store data (', storage.lastError || 'unknown error', '). Turn off Settings → Safari → Block All Cookies and open the app from the Home Screen icon, not a Private tab.')) : null,
      h('div', { class: 'row between small' }, h('span', { class: 'muted' }, 'Last backup'), h('b', null, state.meta.lastBackup ? new Date(state.meta.lastBackup).toLocaleDateString('en-IN') : 'never')),
      h('div', { class: 'row' },
        h('button', { class: 'btn grow', onClick: () => { downloadText(`shredlog-backup-${todayKey()}.json`, exportJSON()); state.meta.lastBackup = Date.now(); commit(); toast('Backup file ready. Save it to Files or iCloud.'); } }, icon('download'), 'Export backup'),
        h('button', { class: 'btn grow', onClick: async () => { const txt = await pickFile(); if (!txt) return; if (!(await confirmSheet('This replaces everything on this phone with the backup file.', { ok: 'Import', title: 'Import backup?' }))) return; try { await importJSON(txt); toast('Backup restored'); ctx.go('today'); } catch (e) { toast(e.message); } } }, icon('upload'), 'Import')),
      h('div', { class: 'callout small' }, icon('warn'), h('div', null, 'iPhone deletes this app’s data if you remove the icon. Export a backup every few weeks and keep it in iCloud Drive.')),
      h('button', { class: 'btn danger block', onClick: async () => { if (await confirmSheet('Deletes every log, workout and setting on this phone. Export a backup first.', { ok: 'Delete everything', danger: true })) { await resetAll(); ctx.go('onboarding'); } } }, icon('trash'), 'Reset all data')),

    h('div', { class: 'section-head', style: { marginTop: '18px' } }, h('h2', null, 'Install on iPhone')),
    h('div', { class: 'card stack small' },
      step(1, 'Open this page in Safari (not Chrome).'),
      step(2, 'Tap the Share button (square with an arrow).'),
      step(3, 'Scroll and tap “Add to Home Screen”, then Add.'),
      step(4, 'Open ShredLog from the icon from now on. The Safari tab and the icon do not share data.'),
      h('button', { class: 'btn sm', onClick: () => { state.settings.hideInstallHint = false; commit(); toast('Install hint will show on Today'); } }, 'Show the hint again')),

    h('div', { class: 'section-head', style: { marginTop: '18px' } }, h('h2', null, 'About')),
    h('div', { class: 'card small muted stack' },
      h('p', null, 'ShredLog is a free personal tracker. No account, no ads, no server: your data never leaves this phone unless you export it.'),
      h('p', null, 'Food values come from the Indian Food Composition Tables (NIN 2017) and typical home recipes, so treat them as good estimates, not lab numbers. Oil and portion size are the biggest sources of error.'),
      h('p', null, 'Nothing here is medical advice. If you have symptoms that worry you, see a doctor.')),
  );
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '—');
const step = (n, text) => h('div', { class: 'row' }, h('span', { class: 'num', style: { width: '24px', height: '24px', borderRadius: '50%', background: 'var(--accent)', color: 'var(--accent-ink)', display: 'grid', placeItems: 'center', fontSize: '13px', flex: 'none' } }, n), h('span', null, text));

function storageLabel() {
  if (storage.blocked) return 'Not saving';
  const stores = (storage.ls === 'ok' ? 1 : 0) + (storage.idb === 'ok' ? 1 : 0);
  const when = storage.lastSaved ? relTime(storage.lastSaved) : 'nothing yet';
  return `${when} · ${stores} of 2 stores`;
}
function profileSheet(ctx, section = 0) {
  const p = { ...state.profile };
  const num = (k, unit, st = 1) => h('div', { class: 'row' }, h('input', { type: 'number', inputmode: 'decimal', value: p[k] ?? '', step: st, onInput: (e) => { p[k] = e.target.value === '' ? null : +e.target.value; } }), unit ? h('span', { class: 'muted small', style: { width: '30px', flex: 'none' } }, unit) : null);
  const body = h('div', { class: 'stack' });
  if (section === 0) body.append(field('Name', h('input', { type: 'text', value: p.name || '', onInput: (e) => { p.name = e.target.value; } })), field('Sex', segmented([{ id: 'male', label: 'Male' }, { id: 'female', label: 'Female' }], p.sex, (v) => { p.sex = v; })), h('div', { class: 'grid-3' }, field('Age', num('age')), field('Height', num('heightCm', 'cm')), field('Weight', num('weightKg', 'kg', 0.1))));
  if (section === 1) body.append(field('Activity', h('select', { onChange: (e) => { p.activity = e.target.value; } }, ACTIVITY.map((a) => h('option', { value: a.id, selected: a.id === p.activity }, a.label)))), field('Goal', h('select', { onChange: (e) => { p.goal = e.target.value; } }, GOALS.map((g) => h('option', { value: g.id, selected: g.id === p.goal }, `${g.label} — ${g.sub}`)))), field('Target weight', num('targetWeightKg', 'kg', 0.5)));
  if (section === 2) body.append(field('Diet', chips([{ id: 'veg', label: 'Vegetarian' }, { id: 'egg', label: 'Eggetarian' }, { id: 'nonveg', label: 'Non-veg' }, { id: 'vegan', label: 'Vegan' }, { id: 'jain', label: 'Jain' }], p.diet, (v) => { p.diet = v; })), field('Home cuisine', chips([{ id: 'north', label: 'North' }, { id: 'south', label: 'South' }, { id: 'east', label: 'East' }, { id: 'west', label: 'West' }, { id: 'mixed', label: 'Mixed' }], p.region, (v) => { p.region = v; })), field('Food budget', chips([{ id: 'tight', label: 'Tight' }, { id: 'moderate', label: 'Moderate' }, { id: 'flexible', label: 'Flexible' }], p.budget, (v) => { p.budget = v; })));
  sheet({ title: ['Profile', 'Activity & goal', 'Diet & budget'][section], content: body, actions: (api) => [h('button', { class: 'btn primary', onClick: () => { setProfile(p); api.close(); toast('Saved'); } }, 'Save')] });
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

async function pinToggle(on, ctx) {
  if (!on) {
    const box = h('div'); const sh = sheet({ title: 'Enter current PIN', content: box, closeLabel: true, onClose: () => ctx.refresh() });
    renderLock(box, { allowForgot: false }).then(() => { sh.onClose = null; sh.close(); setSetting('pinHash', null); toast('PIN removed'); ctx.refresh(); });
    return;
  }
  const box = h('div'); const sh = sheet({ title: 'Choose a 4-digit PIN', content: box, onClose: () => ctx.refresh() });
  const first = await renderLock(box, { title: 'Choose a 4-digit PIN', verifyHash: null, allowForgot: false });
  const firstHash = await hashPin(first);
  const again = await renderLock(box, { title: 'Enter it again', verifyHash: firstHash, allowForgot: false }).catch(() => null);
  if (again) { setSetting('pinHash', firstHash); sh.onClose = null; sh.close(); toast('PIN set'); ctx.refresh(); }
}
