// Today: fuel bar, quick logs, check-in, training, day ledger, week glance.
import { state, day, dayIfAny, dayTotals, dayBurn, habitCount, waterMl, chaiCount, logHabit, removeHabit, logFood, removeFood, findFood, setWeight, latestWeight, workoutsOn, shiftDate, lastNDays, lastHabitTs, commit } from '../state.js';
import { scaleFood } from '../calc.js';
import { h, icon, sheet, toast, stepper, fmt, fmtTime, fmtDateLabel, fmtDur, fmtDow, sinceText, clear, haptic } from '../ui.js';
import { barChart } from '../charts.js';

export function render(container, ctx) {
  const root = h('div');
  container.append(root);
  const draw = () => { clear(root); root.append(build(ctx)); };
  draw();
  return draw;
}

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function greeting() { const hh = new Date().getHours(); return hh < 5 ? 'Late night' : hh < 12 ? 'Good morning' : hh < 17 ? 'Good afternoon' : 'Good evening'; }

function streakDays() {
  let n = 0; let k = state.settings.__today || null; k = null;
  const today = new Date(); const key0 = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  let cur = key0; if (!(dayIfAny(cur)?.food?.length)) cur = shiftDate(cur, -1);
  while (dayIfAny(cur)?.food?.length) { n++; cur = shiftDate(cur, -1); if (n > 999) break; }
  return n;
}

function build(ctx) {
  const key = ctx.date, isToday = key === ctx.today, p = state.profile || {}, t = state.targets || { kcal: 2000, p: 120, c: 200, f: 60, fiber: 28, water: 8 };
  const tot = dayTotals(key), burn = dayBurn(key), left = t.kcal - tot.kcal;
  const streak = streakDays();
  const frag = h('div');

  // header
  frag.append(h('div', { class: 'screen-head' },
    h('div', null, h('h1', null, isToday ? `${greeting()}${p.name ? ', ' + p.name : ''}` : fmtDateLabel(key, ctx.today)), h('div', { class: 'sub' }, isToday ? fmtDateLabel(key, ctx.today) + ' · ' + new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : 'Viewing a past day')),
    h('div', { class: 'row' }, streak > 1 ? h('span', { class: 'pill good', title: 'Days in a row with food logged' }, icon('flame', 14), streak) : null, h('button', { class: 'icon-btn plain', 'aria-label': 'Settings', onClick: () => ctx.go('settings') }, icon('gear')))));
  frag.append(h('div', { class: 'date-nav', style: { marginBottom: '14px' } },
    h('button', { class: 'icon-btn', 'aria-label': 'Previous day', onClick: () => ctx.setDate(shiftDate(key, -1)) }, icon('left')),
    h('div', { class: 'label' }, fmtDateLabel(key, ctx.today), h('small', null, isToday ? 'Tap a tile to log in one tap' : 'Tap Today to jump back'), !isToday ? h('button', { class: 'btn sm ghost', onClick: () => ctx.setDate(ctx.today) }, 'Today') : null),
    h('button', { class: 'icon-btn', 'aria-label': 'Next day', disabled: isToday, onClick: () => ctx.setDate(shiftDate(key, 1)) }, icon('right'))));

  // install hint
  if (isIOS() && !isStandalone() && !state.settings.hideInstallHint) {
    frag.append(h('div', { class: 'callout', style: { marginBottom: '12px' } }, icon('share'), h('div', { class: 'grow' }, h('b', null, 'Install this on your phone. '), 'In Safari tap Share, then “Add to Home Screen”. Then use only the home-screen icon: Safari and the icon keep separate data.'), h('button', { class: 'icon-btn plain', 'aria-label': 'Dismiss', onClick: () => { state.settings.hideInstallHint = true; commit(); } }, icon('x'))));
  }

  // fuel
  const pct = (v) => Math.max(0, Math.min(100, (v / t.kcal) * 100));
  const wp = pct(tot.p * 4), wc = pct(tot.c * 4), wf = pct(tot.f * 9), over = tot.kcal > t.kcal;
  const macro = (k, label, eaten, target, cls) => h('div', null, h('div', { class: 'lbl' }, h('i', { class: 'dot ' + cls }), label), h('div', { class: 'val' }, Math.round(eaten), h('small', null, ` / ${target} g`)), h('div', { class: 'mini-bar' }, h('i', { style: { width: Math.min(100, (eaten / target) * 100) + '%', background: `var(--${cls})` } })));
  frag.append(h('div', { class: 'fuel' },
    h('div', { class: 'top' },
      h('div', null, h('div', { class: 'big', style: over ? { color: 'var(--bad)' } : null }, fmt(Math.abs(left)), h('small', null, over ? 'kcal over' : 'kcal left')), h('div', { class: 'small muted', style: { marginTop: '4px' } }, `${fmt(tot.kcal)} eaten of ${fmt(t.kcal)}${burn ? ` · ${fmt(burn)} burned training` : ''}`)),
      h('div', { class: 'status' }, 'Protein left', h('b', { style: { color: t.p - tot.p > 0 ? 'var(--p)' : 'var(--good)' } }, Math.max(0, Math.round(t.p - tot.p)), ' g'))),
    h('div', { class: 'bar' + (over ? ' over' : '') }, h('span', { class: 'seg-p', style: { width: wp + '%' } }), h('span', { class: 'seg-c', style: { width: wc + '%' } }), h('span', { class: 'seg-f', style: { width: Math.min(wf, 100 - wp - wc) + '%' } })),
    h('div', { class: 'macro-legend' }, macro('p', 'Protein', tot.p, t.p, 'p'), macro('c', 'Carbs', tot.c, t.c, 'c'), macro('f', 'Fat', tot.f, t.f, 'f')),
    h('div', { class: 'row between small muted', style: { marginTop: '10px' } }, h('span', null, `Fibre ${Math.round(tot.fiber)} / ${t.fiber} g`), h('span', null, `Sugar ${Math.round(tot.sugar)} g`), h('span', null, `${tot.n} item${tot.n === 1 ? '' : 's'}`)),
  ));

  // quick log tiles
  const glassMl = state.settings.glassMl || 250, water = waterMl(key), glasses = Math.round(water / glassMl * 10) / 10;
  const chai = chaiCount(key), cigs = habitCount(key, 'cig'), wt = dayIfAny(key)?.weight, lw = latestWeight();
  const tile = (cls, ico, label, count, onClick) => h('button', { onClick }, count != null ? h('span', { class: 'count' }, count) : null, h('span', { class: 'ico ' + cls }, icon(ico)), label);
  const quick = h('div', { class: 'quick section', style: { marginTop: '12px' } });
  quick.append(tile('chai', 'cup', 'Chai', chai || null, () => quickChai(key)));
  if (p.smoker) quick.append(tile('cig', 'cig', 'Cigarette', cigs || null, () => quickCig(key)));
  else quick.append(tile('weight', 'moon', 'Sleep', dayIfAny(key)?.sleep ? dayIfAny(key).sleep + 'h' : null, () => sleepSheet(key)));
  quick.append(tile('water', 'drop', 'Water', glasses || null, () => { logHabit(key, 'water', { ml: glassMl }); haptic(); toast(`Water: ${Math.round((water + glassMl) / 1000 * 100) / 100} L today`); }));
  quick.append(tile('weight', 'scale', wt ? `${wt} kg` : 'Weigh in', null, () => weightSheet(key, wt || lw?.kg || 70)));
  frag.append(quick);
  if (p.smoker && cigs) frag.append(h('div', { class: 'small muted', style: { marginTop: '6px', textAlign: 'center' } }, `Last cigarette ${sinceText(lastHabitTs('cig'))} ago${t.cigLimit ? ` · limit ${t.cigLimit}` : ''}${cigs > (t.cigLimit || Infinity) ? ' · over limit' : ''}`));

  // check-in
  const ck = dayIfAny(key)?.checkin;
  frag.append(h('div', { class: 'card section', style: { marginTop: '14px' } },
    h('div', { class: 'row between' },
      h('div', null, h('h3', null, ck ? 'Today’s check-in' : 'How are you feeling?'), h('div', { class: 'small muted' }, ck ? Object.entries(ck).filter(([k, v]) => v != null && typeof v === 'number').slice(0, 4).map(([k, v]) => `${k} ${v}`).join(' · ') : 'Energy, bloating, digestion, sleep. 20 seconds, and the app links it to what you ate.')),
      h('button', { class: 'btn sm ' + (ck ? '' : 'primary'), onClick: () => ctx.go('body', { open: 'checkin', date: key }) }, ck ? 'Edit' : 'Check in'))));

  // training
  const ws = workoutsOn(key);
  const trainCard = h('div', { class: 'card section', style: { marginTop: '10px' } });
  if (state.active && isToday) trainCard.append(h('div', { class: 'row between' }, h('div', null, h('h3', null, 'Workout in progress'), h('div', { class: 'small muted' }, `${state.active.name} · started ${fmtTime(state.active.start)}`)), h('button', { class: 'btn sm primary', onClick: () => ctx.go('train') }, 'Resume')));
  else if (ws.length) { for (const w of ws) trainCard.append(h('div', { class: 'row between' }, h('div', null, h('h3', null, w.name || 'Workout'), h('div', { class: 'small muted' }, `${fmtDur((w.end - w.start) / 1000)} · ${fmt(w.volume)} kg lifted · ${fmt(w.kcal)} kcal${w.prs?.length ? ` · ${w.prs.length} PR${w.prs.length > 1 ? 's' : ''}` : ''}`)), h('button', { class: 'btn sm', onClick: () => ctx.go('train') }, 'View'))); }
  else { const r = state.settings.currentRoutineId && state.data.routines.concat(state.customRoutines).find((x) => x.id === state.settings.currentRoutineId); const dayPlan = r?.days?.[(state.settings.routineDayIndex || 0) % r.days.length]; trainCard.append(h('div', { class: 'row between' }, h('div', null, h('h3', null, isToday ? 'No workout yet' : 'Rest day'), h('div', { class: 'small muted' }, dayPlan ? `Next up: ${dayPlan.name} (${r.name})` : 'Log sets, reps and weight. The app remembers last time.')), isToday ? h('button', { class: 'btn sm primary', onClick: () => ctx.go('train') }, dayPlan ? 'Start' : 'Train') : null)); }
  frag.append(trainCard);

  // ledger
  const items = [];
  for (const e of (dayIfAny(key)?.food || [])) items.push({ ts: e.ts, type: /chai|tea/i.test(e.name) ? 'chai' : 'food', e });
  for (const hb of (dayIfAny(key)?.habits || [])) if (hb.type === 'cig') items.push({ ts: hb.ts, type: 'cig', e: hb });
  for (const w of ws) items.push({ ts: w.start, type: 'train', e: w });
  items.sort((a, b) => a.ts - b.ts);
  const led = h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, 'Day ledger'), h('button', { class: 'link', style: { background: 'none' }, onClick: () => ctx.go('food') }, 'Add food')));
  if (!items.length) led.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, h('b', null, 'Nothing logged yet'), 'Chai counts too. Tap a tile above or add food.')));
  else {
    const list = h('div', { class: 'card pad-s' }, h('div', { class: 'ledger' }, items.map((it) => ledgerItem(it, key, ctx))));
    led.append(list);
  }
  if (water) led.append(h('div', { class: 'small muted', style: { marginTop: '8px' } }, `Water ${(water / 1000).toFixed(2)} L (${glasses} glasses of ${glassMl} ml)`));
  frag.append(led);

  // week glance
  const keys = lastNDays(7, ctx.today);
  const bars = keys.map((k) => ({ label: fmtDow(k).slice(0, 2), value: dayTotals(k).kcal, tip: `${fmtDateLabel(k, ctx.today)}: ${fmt(dayTotals(k).kcal)} kcal` }));
  if (bars.some((b) => b.value)) frag.append(h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, 'This week'), h('span', { class: 'small muted' }, `avg ${fmt(bars.reduce((a, b) => a + b.value, 0) / Math.max(1, bars.filter((b) => b.value).length))} kcal`)), h('div', { class: 'card pad-s' }, barChart({ bars, target: t.kcal, height: 120, color: 'var(--c)', colorOver: 'var(--bad)' }))));

  frag.append(h('div', { style: { marginTop: '18px' } }, h('button', { class: 'btn primary block', onClick: () => ctx.go('food') }, icon('plus'), 'Add food')));
  return frag;
}

function ledgerItem(it, key, ctx) {
  const { type, e } = it;
  let name, meta, kcal, sub;
  if (type === 'food' || type === 'chai') { name = e.name; meta = `${e.qty} ${e.unit?.label || 'g'}${e.oilTsp ? ` · +${e.oilTsp} tsp oil` : ''} · P ${Math.round(e.p)} g`; kcal = fmt(e.kcal); sub = e.meal; }
  else if (type === 'cig') { name = 'Cigarette'; meta = e.note || 'Logged'; kcal = ''; sub = ''; }
  else { name = e.name || 'Workout'; meta = `${fmtDur((e.end - e.start) / 1000)} · ${fmt(e.volume)} kg`; kcal = '−' + fmt(e.kcal); sub = 'burned'; }
  return h('button', { class: 'ledger-item', style: { width: '100%', textAlign: 'left' }, onClick: () => itemSheet(it, key, ctx) },
    h('i', { class: 'pin ' + type }), h('div', { class: 't' }, fmtTime(it.ts)),
    h('div', { class: 'what' }, h('div', { class: 'name ellipsis' }, name), h('div', { class: 'meta' }, meta)),
    h('div', { class: 'kcal' }, kcal, sub ? h('small', null, sub) : null));
}

function itemSheet(it, key, ctx) {
  const { type, e } = it;
  if (type === 'train') return ctx.go('train');
  const s = sheet({ title: type === 'cig' ? 'Cigarette' : e.name,
    content: type === 'cig' ? h('p', { class: 'muted' }, `Logged at ${fmtTime(e.ts)}.`) : h('div', { class: 'tiles-4' },
      ['kcal', 'p', 'c', 'f'].map((k) => h('div', { class: 'tile' }, h('div', { class: 'lbl' }, { kcal: 'kcal', p: 'Protein', c: 'Carbs', f: 'Fat' }[k]), h('div', { class: 'val' }, Math.round(e[k] || 0), k !== 'kcal' ? h('small', null, 'g') : null)))),
    actions: (api) => [h('button', { class: 'btn danger', onClick: () => { api.close(); if (type === 'cig') removeHabit(key, e.id); else removeFood(key, e.id); toast('Removed'); } }, icon('trash'), 'Delete'), type !== 'cig' ? h('button', { class: 'btn', onClick: () => { api.close(); ctx.go('food', { edit: e.id, date: key }); } }, 'Edit in Food') : null] });
  if (type !== 'cig') s.el.querySelector('.sheet-body').append(h('p', { class: 'small muted', style: { marginTop: '10px' } }, `${e.qty} ${e.unit?.label || 'g'} (${Math.round(e.g)} g) · ${e.meal} · ${fmtTime(e.ts)}`));
}

function quickChai(key) {
  const id = state.profile?.chaiFoodId || 'chai_milk_1tsp';
  const food = findFood(id) || findFood('chai_milk_1tsp') || state.data.foods.find((f) => /chai/.test(f.id));
  if (!food) return toast('No chai in the food list yet');
  const sv = food.servings[0]; const m = scaleFood(food, sv.g);
  const micro = food.micro ? Object.fromEntries(Object.entries(food.micro).map(([k, v]) => [k, +(v * sv.g / 100).toFixed(2)])) : null;
  const e = logFood(key, { foodId: food.id, name: food.name, cat: food.cat, qty: 1, unit: sv, g: sv.g, ...m, micro, triggers: food.triggers || [], meal: 'drinks', oilTsp: 0 });
  haptic(); toast(`Chai logged · ${m.kcal} kcal`, { action: 'Undo', onAction: () => removeFood(key, e.id) });
}
function quickCig(key) {
  const e = logHabit(key, 'cig'); haptic();
  const n = habitCount(key, 'cig'), lim = state.targets?.cigLimit;
  toast(`Cigarette ${n} today${lim ? ` · limit ${lim}` : ''}`, { action: 'Undo', onAction: () => removeHabit(key, e.id) });
}
function weightSheet(key, start) {
  let v = start;
  sheet({ title: 'Weigh in', content: h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Best first thing in the morning, after the loo, before chai. Same scale every time.'), h('div', { class: 'row', style: { justifyContent: 'center' } }, stepper({ value: v, min: 30, max: 250, step: 0.1, onChange: (x) => { v = x; } }), h('span', { class: 'muted' }, 'kg'))),
    actions: (api) => [h('button', { class: 'btn primary', onClick: () => { setWeight(key, v); api.close(); toast(`Weight saved: ${v} kg`); } }, 'Save')] });
}
function sleepSheet(key) {
  let v = dayIfAny(key)?.sleep || state.profile?.sleepTarget || 7.5;
  sheet({ title: 'Sleep last night', content: h('div', { class: 'row', style: { justifyContent: 'center' } }, stepper({ value: v, min: 0, max: 14, step: 0.5, onChange: (x) => { v = x; } }), h('span', { class: 'muted' }, 'hours')),
    actions: (api) => [h('button', { class: 'btn primary', onClick: () => { day(key).sleep = v; commit(); api.close(); toast(`Sleep saved: ${v} h`); } }, 'Save')] });
}
