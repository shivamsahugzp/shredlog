// Today: hero, fuel card, quick logs, check-in, training, day ledger, week glance. Swipe right/left to change day.
import { state, day, dayIfAny, dayTotals, dayBurn, habitCount, waterMl, chaiCount, logHabit, removeHabit, logFood, removeFood, findFood, setWeight, latestWeight, weights, workoutsOn, shiftDate, lastNDays, lastHabitTs, commit, dateKey } from '../state.js';
import { scaleFood } from '../calc.js';
import { h, icon, sheet, toast, stepper, fmt, fmtTime, fmtDateLabel, fmtDur, fmtDow, sinceText, ago, clear, haptic } from '../ui.js';
import { barChart, legend } from '../charts.js';
const openScan = (ctx) => import('./food-scan.js').then((m) => m.openScanner(ctx, { date: ctx.date })).catch((e) => toast('Could not open the scanner: ' + e.message));
import { countUp, fill, pulse, pop, ripple, celebrate, quiet, seen, remember, recall, swipeNav } from '../motion.js';

export function render(container, ctx) {
  const root = h('div', { class: 'mo-today' });
  container.append(root);
  let drawn = false;
  // Build first, swap second: a throwing build can never leave the screen empty. Charts only play their intro on the first draw.
  const draw = () => {
    const jobs = [];
    const run = () => { const next = build(ctx, jobs); clear(root); root.append(next); for (const j of jobs) { try { j(); } catch (e) { console.error(e); } } };
    if (drawn) quiet(run); else run();
    drawn = true;
  };
  draw();
  swipeNav(root, { canGo: (dir) => dir < 0 || ctx.date < ctx.today, onSwipe: (dir) => ctx.setDate(shiftDate(ctx.date, dir), { skipOut: true }) });
  return draw;
}

const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const n1 = (v) => String(+(+v).toFixed(1));
const MILESTONES = [7, 14, 21, 30, 50, 75, 100, 150, 200, 365];

function greeting() { const hh = new Date().getHours(); return hh < 5 ? 'Up late' : hh < 12 ? 'Good morning' : hh < 17 ? 'Good afternoon' : hh < 22 ? 'Good evening' : 'Good night'; }

// Days in a row with food logged, counted back from today (or from yesterday while today is still empty).
function streakInfo(today) {
  const has = (k) => !!dayIfAny(k)?.food?.length;
  const loggedToday = has(today);
  let cur = loggedToday ? today : shiftDate(today, -1), n = 0;
  while (has(cur) && n < 999) { n++; cur = shiftDate(cur, -1); }
  return { n, loggedToday };
}

// One sentence that reflects the state of the day.
function heroLine(t, tot, left) {
  const hh = new Date().getHours(), pLeft = Math.round(t.p - tot.p), over = Math.round(tot.kcal - t.kcal);
  if (!tot.n) return hh < 11 ? `Fuel up. Today’s protein target is ${t.p} g.` : hh < 21 ? 'Nothing logged yet. Add what you have eaten so far.' : 'Nothing logged today. Add your meals while you remember them.';
  if (over > t.kcal * 0.05) return `${fmt(over)} kcal over. One day will not undo your week.`;
  const pHit = tot.p >= t.p * 0.95, kOk = tot.kcal >= t.kcal * 0.9;
  if (pHit && kOk) return 'Target hit — nice.';
  if (pHit) return `Protein done. ${fmt(Math.max(0, left))} kcal left to spend.`;
  return hh >= 20 && pLeft > 30 ? `Protein ${pLeft} g to go. Eggs or a shake closes it.` : `Protein ${pLeft} g to go.`;
}

// "1 omelette (125 g)" already carries its own count; "g" and "ml" units need one.
function servingText(e) {
  const label = e.unit?.label || 'g', q = +(+e.qty).toFixed(2);
  if (label === 'Quick add') return 'Quick add';
  if (/^\d/.test(label)) return q === 1 ? label : `${q} × ${label}`;
  return `${q} ${label}`;
}

function build(ctx, jobs) {
  const key = ctx.date, isToday = key === ctx.today, p = state.profile || {}, t = state.targets || { kcal: 2000, p: 120, c: 200, f: 60, fiber: 28, water: 8 };
  const tot = dayTotals(key), burn = dayBurn(key), left = t.kcal - tot.kcal, over = tot.kcal > t.kcal;
  const { n: streak, loggedToday } = streakInfo(ctx.today);
  const first = !seen('fuel:' + key); remember('fuel:' + key);
  const frag = h('div');

  // ---- hero: greeting that follows the time of day, one line that follows the state of the day ----
  const longDate = new Date(key + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  const line = isToday ? heroLine(t, tot, left) : `Anything you log here is saved to ${longDate}.`;
  const lineEl = h('div', { class: 'mo-hint' }, line);
  if (isToday) { const prev = recall('hero:' + key); if (prev && prev !== line) jobs.push(() => pop(lineEl)); remember('hero:' + key, line); }
  frag.append(h('div', { class: 'screen-head mo-hero' },
    h('div', { class: 'grow' }, h('h1', null, isToday ? `${greeting()}${p.name ? ', ' + p.name : ''}` : 'Looking back'), lineEl),
    h('button', { class: 'icon-btn plain', 'aria-label': 'Settings', onClick: () => ctx.go('settings') }, icon('gear'))));

  // ---- date nav: Today / Yesterday / Mon 3 Nov, plus the streak ----
  const flame = streak > 1 ? h('span', { class: 'mo-flame' }, icon('flame', 14)) : null;
  const streakBtn = streak > 1 && isToday ? h('button', { class: 'mo-streak' + (loggedToday ? '' : ' wait'), 'aria-label': `${streak} day streak`, onClick: () => toast(loggedToday ? `${streak} days in a row with food logged. Keep going.` : `${streak}-day streak. Log something today to keep it alive.`) }, flame, `${streak}-day streak${loggedToday ? '' : ' · log today'}`) : null;
  frag.append(h('div', { class: 'date-nav mo-nav' },
    h('button', { class: 'icon-btn', 'aria-label': 'Previous day', onClick: () => ctx.setDate(shiftDate(key, -1)) }, icon('left')),
    h('div', { class: 'label' }, fmtDateLabel(key, ctx.today), h('small', null, isToday ? [longDate, streakBtn ? ' · ' : null, streakBtn] : longDate), !isToday ? h('button', { class: 'btn sm ghost', onClick: () => ctx.setDate(ctx.today) }, 'Back to today') : null),
    h('button', { class: 'icon-btn', 'aria-label': 'Next day', disabled: isToday, onClick: () => ctx.setDate(shiftDate(key, 1)) }, icon('right'))));
  if (flame && isToday && loggedToday && state.settings.streakPulsed !== key) {
    state.settings.streakPulsed = key; // saved with the next write; the flame plays once per day, the first time the streak includes today
    jobs.push(() => { pulse(flame, { scale: 1.7, ms: 600 }); if (MILESTONES.includes(streak)) celebrate(flame, { kind: 'streak' }); });
  }

  // install hint
  if (isIOS() && !isStandalone() && !state.settings.hideInstallHint) {
    frag.append(h('div', { class: 'callout', style: { marginBottom: '12px' } }, icon('share'), h('div', { class: 'grow' }, h('b', null, 'Install this on your phone. '), 'In Safari tap Share, then “Add to Home Screen”. Then use only the home-screen icon: Safari and the icon keep separate data.'), h('button', { class: 'icon-btn plain', 'aria-label': 'Dismiss', onClick: () => { state.settings.hideInstallHint = true; commit(); } }, icon('x'))));
  }

  // ---- fuel card ----
  const pct = (v) => Math.max(0, Math.min(100, (v / t.kcal) * 100));
  const wp = pct(tot.p * 4), wc = pct(tot.c * 4), wf = pct(tot.f * 9);
  const macro = (k, label, eaten, target, cls) => {
    const num = h('span', null, Math.round(eaten)), mini = h('i', { style: { background: `var(--${cls})` } });
    jobs.push(() => { countUp(num, Math.round(eaten), { key: `mv:${k}:${key}` }); fill(mini, Math.min(100, (eaten / target) * 100), { key: `mb:${k}:${key}`, delay: 80 }); });
    return h('div', null, h('div', { class: 'lbl' }, h('i', { class: 'dot ' + cls }), label), h('div', { class: 'val' }, num, h('small', null, ` / ${target} g`)), h('div', { class: 'mini-bar' }, mini));
  };
  const bigNum = h('span', null, fmt(Math.abs(left))), eatenNum = h('span', null, fmt(tot.kcal)), pLeftNum = h('span', null, Math.max(0, Math.round(t.p - tot.p)));
  const pLeft = Math.max(0, Math.round(t.p - tot.p));
  jobs.push(() => {
    countUp(bigNum, Math.abs(left), { from: first ? (over ? 0 : t.kcal) : undefined, key: `kl:${key}`, fmt: (v) => fmt(v) });
    countUp(eatenNum, tot.kcal, { key: `ke:${key}`, fmt: (v) => fmt(v) });
    countUp(pLeftNum, pLeft, { from: first ? t.p : undefined, key: `pl:${key}` });
  });
  const segP = h('span', { class: 'seg-p' }), segC = h('span', { class: 'seg-c' }), segF = h('span', { class: 'seg-f' });
  jobs.push(() => { fill(segP, wp, { key: `sp:${key}` }); fill(segC, wc, { key: `sc:${key}`, delay: 60 }); fill(segF, Math.min(wf, 100 - wp - wc), { key: `sf:${key}`, delay: 120 }); });
  const protLeftB = h('b', { style: { color: t.p - tot.p > 0 ? 'var(--p)' : 'var(--good)' } }, pLeftNum, ' g');
  // the first time protein crosses its target this session: a small burst
  const goalKey = 'pgoal:' + key, hit = t.p > 0 && tot.p >= t.p;
  if (isToday && recall(goalKey) === false && hit) jobs.push(() => { celebrate(protLeftB, { kind: 'goal' }); haptic('success'); });
  if (isToday) remember(goalKey, hit);
  frag.append(h('div', { class: 'fuel' },
    h('div', { class: 'top' },
      h('div', null, h('div', { class: 'big', style: over ? { color: 'var(--bad)' } : null }, bigNum, h('small', null, over ? 'kcal over' : 'kcal left')), h('div', { class: 'small muted', style: { marginTop: '4px' } }, eatenNum, ` eaten of ${fmt(t.kcal)}${burn ? ` · ${fmt(burn)} burned training` : ''}`)),
      h('div', { class: 'status' }, 'Protein left', protLeftB)),
    h('div', { class: 'bar' + (over ? ' over' : '') }, segP, segC, segF),
    h('div', { class: 'macro-legend' }, macro('p', 'Protein', tot.p, t.p, 'p'), macro('c', 'Carbs', tot.c, t.c, 'c'), macro('f', 'Fat', tot.f, t.f, 'f')),
    h('div', { class: 'row between small muted', style: { marginTop: '10px' } }, h('span', null, `Fibre ${Math.round(tot.fiber)} / ${t.fiber} g`), h('span', null, `Sugar ${Math.round(tot.sugar)} g`), h('span', null, `${tot.n} item${tot.n === 1 ? '' : 's'}`)),
  ));

  // ---- quick log tiles ----
  const glassMl = state.settings.glassMl || 250, water = waterMl(key), glasses = Math.round(water / glassMl * 10) / 10, goalGlasses = t.water || 8;
  const chai = chaiCount(key), cigs = habitCount(key, 'cig'), wt = dayIfAny(key)?.weight, lw = latestWeight(), sleepH = dayIfAny(key)?.sleep;
  const tile = ({ cls, ico, label, count, sub, bad, onClick, extra, under }) => {
    const b = h('button', { class: extra || '', onClick: (e) => { ripple(b, e); onClick(e); } }, under || null, count != null ? h('span', { class: 'count' + (bad ? ' bad' : '') }, count) : null, h('span', { class: 'ico ' + cls }, icon(ico)), h('span', { class: 'mo-lbl' }, label), sub ? h('span', { class: 'mo-sub' }, sub) : null);
    return b;
  };
  const quick = h('div', { class: 'quick section', style: { marginTop: '12px' } });
  quick.append(tile({ cls: 'chai', ico: 'cup', label: 'Chai', count: chai || null, onClick: () => quickChai(key) }));
  if (p.smoker) quick.append(tile({ cls: 'cig', ico: 'cig', label: 'Cigarette', count: cigs || null, bad: t.cigLimit && cigs > t.cigLimit, sub: t.cigLimit ? `limit ${t.cigLimit}` : null, onClick: () => quickCig(key) }));
  else quick.append(tile({ cls: 'weight', ico: 'moon', label: 'Sleep', sub: sleepH ? `${n1(sleepH)} h` : 'Log', onClick: () => sleepSheet(key) }));
  const waterFill = h('div', { class: 'mo-water-fill' });
  jobs.push(() => fill(waterFill, Math.min(100, (water / (goalGlasses * glassMl)) * 100), { axis: 'y', key: `wf:${key}` }));
  quick.append(tile({ cls: 'water', ico: 'drop', label: 'Water', count: glasses || null, sub: `of ${goalGlasses}`, extra: 'mo-water', under: waterFill, onClick: () => {
    const e = logHabit(key, 'water', { ml: glassMl }); haptic();
    const g = Math.round((water + glassMl) / glassMl * 10) / 10;
    if (g >= goalGlasses && glasses < goalGlasses) { celebrate(waterFill.parentNode, { kind: 'goal' }); haptic('success'); }
    toast(`Water: ${n1(g)} of ${goalGlasses} glasses · ${fmt((water + glassMl) / 1000, 2)} L`, { action: 'Undo', onAction: () => removeHabit(key, e.id) });
  } }));
  quick.append(tile({ cls: 'weight', ico: 'scale', label: 'Weight', sub: wt ? `${n1(wt)} kg` : 'Weigh in', onClick: () => weightSheet(key, wt || lw?.kg || 70) }));
  frag.append(quick);
  if (p.smoker && cigs) frag.append(h('div', { class: 'small muted', style: { marginTop: '6px', textAlign: 'center' } }, `Last cigarette ${sinceText(lastHabitTs('cig'))} ago${t.cigLimit ? ` · limit ${t.cigLimit}` : ''}${cigs > (t.cigLimit || Infinity) ? ' · over limit' : ''}`));

  // ---- check-in ----
  const ck = dayIfAny(key)?.checkin;
  const CK = [['energy', 'Energy'], ['mood', 'Mood'], ['hunger', 'Hunger'], ['sleepQ', 'Sleep']];
  const ckBits = ck ? CK.filter(([k]) => typeof ck[k] === 'number').map(([k, l]) => `${l} ${ck[k]}/5`) : [];
  frag.append(h('div', { class: 'card section', style: { marginTop: '14px' } },
    h('div', { class: 'row between' },
      h('div', { class: 'grow' }, h('h3', null, ck ? 'Check-in saved' : 'How are you feeling?'), h('div', { class: 'small muted' }, ck ? (ckBits.join(' · ') || 'Notes saved.') : 'Energy, bloating, digestion, sleep. 20 seconds.')),
      h('button', { class: 'btn sm mo-nowrap ' + (ck ? '' : 'primary'), onClick: () => ctx.go('body', { open: 'checkin', date: key }) }, ck ? 'Edit' : 'Check in'))));

  // ---- training ----
  const ws = workoutsOn(key);
  const trainCard = h('div', { class: 'card section', style: { marginTop: '10px' } });
  if (state.active && isToday) {
    const r = state.active.rest, mins = Math.max(0, Math.round((Date.now() - state.active.start) / 60000));
    trainCard.append(h('div', { class: 'row between' }, h('div', { class: 'grow' }, h('h3', null, 'Workout in progress'), h('div', { class: 'small muted' }, `${state.active.name} · started ${fmtTime(state.active.start)} · ${mins} min${r && r.endAt > Date.now() ? ' · resting' : ''}`)), h('button', { class: 'btn sm primary', onClick: () => ctx.go('train') }, 'Resume')));
  } else if (ws.length) {
    for (const w of ws) trainCard.append(h('div', { class: 'row between' }, h('div', { class: 'grow' }, h('h3', null, w.name || 'Workout'), h('div', { class: 'small muted' }, `${fmtDur((w.end - w.start) / 1000)} · ${fmt(w.volume)} kg lifted · ${fmt(w.kcal)} kcal${w.prs?.length ? ` · ${w.prs.length} PR${w.prs.length > 1 ? 's' : ''}` : ''}`)), h('button', { class: 'btn sm', onClick: () => ctx.go('train') }, 'View')));
  } else {
    const prior = state.workouts.filter((w) => dateKey(new Date(w.start)) < key).reduce((a, w) => (!a || w.start > a.start ? w : a), null);
    const week = new Set(lastNDays(7, key)), inWeek = state.workouts.filter((w) => week.has(dateKey(new Date(w.start)))).length;
    const r = state.settings.currentRoutineId && state.data.routines.concat(state.customRoutines).find((x) => x.id === state.settings.currentRoutineId);
    const dayPlan = r?.days?.[(state.settings.routineDayIndex || 0) % r.days.length];
    const bits = [];
    if (dayPlan) bits.push(`Next up: ${dayPlan.name} (${r.name})`);
    if (prior) bits.push(`Last trained: ${prior.name || 'Workout'} · ${ago(prior.start)}`);
    if (prior && inWeek) bits.push(`${inWeek} workout${inWeek > 1 ? 's' : ''} in the last 7 days`);
    trainCard.append(h('div', { class: 'row between' }, h('div', { class: 'grow' }, h('h3', null, isToday ? 'No workout yet' : 'Rest day'),
      bits.length ? bits.map((b) => h('div', { class: 'small muted' }, b)) : h('div', { class: 'small muted' }, isToday ? 'Log sets, reps and weight. The app remembers last time.' : 'Nothing was trained this day.')),
      isToday ? h('button', { class: 'btn sm primary', onClick: () => ctx.go('train') }, dayPlan ? 'Start' : 'Train') : null));
  }
  frag.append(trainCard);

  // ---- ledger ----
  const items = [];
  for (const e of (dayIfAny(key)?.food || [])) items.push({ ts: e.ts, type: /chai|tea/i.test(e.name) ? 'chai' : 'food', e });
  for (const hb of (dayIfAny(key)?.habits || [])) if (hb.type === 'cig') items.push({ ts: hb.ts, type: 'cig', e: hb });
  for (const w of ws) items.push({ ts: w.start, type: 'train', e: w });
  items.sort((a, b) => a.ts - b.ts);
  const led = h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, 'Day ledger'), h('div', { class: 'row', style: { gap: '4px' } }, h('button', { class: 'icon-btn plain', 'aria-label': 'Scan a plate with the camera', onClick: () => openScan(ctx) }, icon('camera', 22)), h('button', { class: 'link', style: { background: 'none' }, onClick: () => ctx.go('food') }, 'Add food'))));
  if (!items.length) led.append(h('div', { class: 'card' }, h('div', { class: 'empty' }, h('span', { class: 'mo-empty-ico' }, icon('bowl', 22)), h('b', null, isToday ? 'Nothing logged yet' : 'Nothing logged this day'), isToday ? 'Chai counts too. Tap a tile above, or add your first meal.' : 'Add what you ate so this day counts in your trends.',
    isToday ? h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } }, h('button', { class: 'btn', onClick: () => quickChai(key) }, icon('cup', 18), 'Log chai')) : null)));
  else led.append(h('div', { class: 'card pad-s' }, h('div', { class: 'ledger' }, items.map((it) => ledgerItem(it, key, ctx)))));
  if (water) led.append(h('div', { class: 'small muted', style: { marginTop: '8px' } }, `Water ${fmt(water / 1000, 2)} L (${n1(glasses)} of ${goalGlasses} glasses)`));
  frag.append(led);

  // ---- week glance: weekday initials, today highlighted, over means more than 5% above target ----
  const keys = lastNDays(7, ctx.today);
  const bars = keys.map((k) => { const v = dayTotals(k).kcal; return { label: fmtDow(k)[0], value: v, hl: k === ctx.today, color: v > t.kcal * 1.05 ? 'var(--bad)' : 'var(--c)', tip: `${fmtDateLabel(k, ctx.today)}: ${fmt(v)} kcal` }; });
  if (bars.some((b) => b.value)) {
    const done = keys.slice(0, -1).filter((k) => dayIfAny(k)?.food?.length && !dayIfAny(k)?.partial), good = done.filter((k) => Math.abs(dayTotals(k).kcal / t.kcal - 1) <= 0.1).length;
    frag.append(h('div', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, 'This week'), h('span', { class: 'small muted' }, `avg ${fmt(bars.reduce((a, b) => a + b.value, 0) / Math.max(1, bars.filter((b) => b.value).length))} kcal`)),
      h('div', { class: 'card pad-s' }, barChart({ bars, target: t.kcal, height: 120, color: 'var(--c)' }),
        legend([{ color: 'var(--c)', label: 'Within target' }, { color: 'var(--bad)', label: 'Over by 5%+' }]),
        done.length ? h('div', { class: 'small muted', style: { marginTop: '8px' } }, `Within 10% of target on ${good} of ${done.length} full day${done.length === 1 ? '' : 's'}.`) : null)));
  }

  // ---- add food: pinned above the tab bar while the day is empty ----
  frag.append(h('div', { class: 'mo-cta' + (!tot.n && !items.length ? ' mo-sticky' : '') }, h('div', { class: 'row', style: { gap: '8px' } }, h('button', { class: 'btn primary grow', onClick: () => ctx.go('food') }, icon('plus'), 'Add food'), h('button', { class: 'btn grow', onClick: () => openScan(ctx) }, icon('camera'), 'Scan plate'))));
  return frag;
}

function ledgerItem(it, key, ctx) {
  const { type, e } = it;
  let name, meta, kcal, sub;
  if (type === 'food' || type === 'chai') { name = e.name; meta = `${servingText(e)}${e.oilTsp ? ` · +${e.oilTsp} tsp oil` : ''} · P ${Math.round(e.p)} g`; kcal = fmt(e.kcal); sub = e.meal; }
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
    actions: (api) => [h('button', { class: 'btn danger', onClick: () => {
      haptic('warn'); api.close(); const copy = { ...e };
      if (type === 'cig') { removeHabit(key, e.id); toast('Removed', { action: 'Undo', onAction: () => logHabit(key, 'cig', copy) }); }
      else { removeFood(key, e.id); toast('Removed', { action: 'Undo', onAction: () => logFood(key, copy) }); }
    } }, icon('trash'), 'Delete'), type !== 'cig' ? h('button', { class: 'btn', onClick: () => { api.close(); ctx.go('food', { edit: e.id, date: key }); } }, 'Edit in Food') : null] });
  if (type !== 'cig') s.el.querySelector('.sheet-body').append(h('p', { class: 'small muted', style: { marginTop: '10px' } }, `${servingText(e)} (${Math.round(e.g)} g) · ${e.meal} · ${fmtTime(e.ts)}`));
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
    actions: (api) => [h('button', { class: 'btn primary', onClick: () => {
      const before = weights().filter((w) => w.date < key).pop();
      setWeight(key, v); api.close();
      const d = before ? +(v - before.kg).toFixed(1) : null;
      toast(`Weight saved: ${n1(v)} kg${d != null && d !== 0 ? ` · ${d > 0 ? '+' : '−'}${Math.abs(d)} vs last weigh-in` : ''}`);
    } }, 'Save')] });
}
function sleepSheet(key) {
  let v = dayIfAny(key)?.sleep || state.profile?.sleepTarget || 7.5;
  sheet({ title: 'Sleep last night', content: h('div', { class: 'row', style: { justifyContent: 'center' } }, stepper({ value: v, min: 0, max: 14, step: 0.5, onChange: (x) => { v = x; } }), h('span', { class: 'muted' }, 'hours')),
    actions: (api) => [h('button', { class: 'btn primary', onClick: () => { day(key).sleep = v; commit(); api.close(); toast(`Sleep saved: ${n1(v)} h`); } }, 'Save')] });
}
