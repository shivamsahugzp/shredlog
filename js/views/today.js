// Today: hero ring, quick-log tiles, check-in, training, day ledger, week glance. Swipe right/left to change day.
import { state, day, dayIfAny, dayTotals, dayBurn, habitCount, habitEntries, waterMl, chaiCount, isChai, logHabit, removeHabit, logFood, removeFood, findFood, setWeight, latestWeight, weights, workoutsOn, shiftDate, lastNDays, lastHabitTs, commit, dateKey } from '../state.js';
import { scaleFood } from '../calc.js';
import { todayPlan } from '../train-plan.js';
import { h, icon, sheet, toast, stepper, counterTile, ring, fmt, fmtTime, fmtDateLabel, fmtDur, fmtDow, sinceText, ago, clear, haptic } from '../ui.js';
import { barChart, legend } from '../charts.js';
import { countUp, odometer, fill, pulse, pop, ripple, celebrate, quiet, seen, remember, recall, swipeNav, swipeReveal, prefersReducedMotion, EASE_OUT } from '../motion.js';

const openScan = (ctx) => import('./food-scan.js').then((m) => m.openScanner(ctx, { date: ctx.date })).catch((e) => toast('Could not open the scanner: ' + e.message));

export function render(container, ctx) {
  const root = h('div', { class: 'td' });
  container.append(root);
  const cache = { led: null }; // the ledger DOM is reused while its rows are unchanged, so swipe-to-reveal state (and its listeners) are not rebuilt on every redraw
  let drawn = false;
  // Build first, swap second: a throwing build can never leave the screen empty. Charts only play their intro on the first draw.
  const draw = () => {
    const jobs = [];
    const run = () => { const next = build(ctx, jobs, cache); clear(root); root.append(next); for (const j of jobs) { try { j(); } catch (e) { console.error(e); } } };
    if (drawn) quiet(run); else run();
    drawn = true;
  };
  draw();
  swipeNav(root, { canGo: (dir) => dir < 0 || ctx.date < ctx.today, onSwipe: (dir) => ctx.setDate(shiftDate(ctx.date, dir), { skipOut: true }) });
  return draw;
}

// ---------------------------------------------------------------- helpers
const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const n1 = (v) => String(+(+v).toFixed(1));
const MILESTONES = [7, 14, 21, 30, 50, 75, 100, 150, 200, 365];
const canAnim = () => !prefersReducedMotion() && typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
const setVar = (el, k, v) => { el.style.setProperty(k, v); return el; };
// Entrance used once per screen open: fade and rise, staggered by the caller.
const enter = (el, delay = 0, rise = 10, ms = 320) => { if (el && canAnim()) el.animate([{ opacity: 0, transform: `translateY(${rise}px)` }, { opacity: 1, transform: 'none' }], { duration: ms, delay, easing: EASE_OUT, fill: 'backwards' }); };
const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

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
function shortAgo(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const hh = Math.floor(m / 60);
  return hh < 24 ? `${hh}h ago` : `${Math.floor(hh / 24)}d ago`;
}
const gapText = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Spot illustration for empty states: a katori of dal with steam, two tones from the palette.
const katori = () => h('span', { class: 'td-spot', 'aria-hidden': 'true', html: '<svg viewBox="0 0 96 96"><ellipse class="b" cx="48" cy="82" rx="30" ry="5"/><path class="s" d="M36 24c-4 5 4 8 0 14M48 19c-4 5 4 8 0 14M60 24c-4 5 4 8 0 14"/><path class="a" d="M14 46h68a34 34 0 0 1-68 0z"/><rect class="a2" x="11" y="41" width="74" height="9" rx="4.5"/><path class="hl" d="M25 58a24 24 0 0 0 12 14"/></svg>' });

// Muscle groups from the weekday plan, tinted with the fixed group palette.
const GROUP_VAR = { Chest: '--g1', Back: '--g2', Shoulders: '--g3', Biceps: '--g4', Triceps: '--g4', Forearms: '--g4', Arms: '--g4', Quads: '--g5', Glutes: '--g5', Hamstrings: '--g5', Calves: '--g5', Legs: '--g5', Core: '--g6' };
const groupChip = (g) => setVar(h('span', { class: 'td-grp' }, h('i'), g), '--g', `var(${GROUP_VAR[g] || '--muted'})`);

// ---------------------------------------------------------------- the dial: 60 ticks inside the ring, lit up to the current percentage
function dial(size, stroke, pct, over) {
  const c = size / 2, rOut = size / 2 - stroke - 6, svg = svgEl('svg', { viewBox: `0 0 ${size} ${size}`, class: 'td-dial' });
  const N = 60, lit = over ? N : Math.round((Math.min(100, pct) / 100) * N), ticks = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2, major = i % 5 === 0, r1 = rOut, r2 = rOut - (major ? 7 : 4);
    const ln = svgEl('line', { x1: (c + Math.cos(a) * r1).toFixed(2), y1: (c + Math.sin(a) * r1).toFixed(2), x2: (c + Math.cos(a) * r2).toFixed(2), y2: (c + Math.sin(a) * r2).toFixed(2), 'stroke-width': major ? 2 : 1.4 });
    if (i < lit) ln.setAttribute('class', 'on');
    svg.append(ln); ticks.push(ln);
  }
  svg.litTicks = ticks.filter((l) => l.getAttribute('class') === 'on');
  return svg;
}

// ---------------------------------------------------------------- build
function build(ctx, jobs, cache) {
  const key = ctx.date, isToday = key === ctx.today, p = state.profile || {}, t = state.targets || { kcal: 2000, p: 120, c: 200, f: 60, fiber: 28, water: 8 };
  const tot = dayTotals(key), burn = dayBurn(key), left = t.kcal - tot.kcal, over = tot.kcal > t.kcal;
  const { n: streak, loggedToday } = streakInfo(ctx.today);
  const first = !seen('td:' + key); remember('td:' + key);
  const page = h('div', { class: 'td-page' });
  const rise = []; // elements that play the one orchestrated entrance, in order

  // ---- greeting: follows the time of day; one honest line follows the state of the day ----
  const longDate = new Date(key + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  const line = isToday ? heroLine(t, tot, left) : `Anything you log here is saved to ${longDate}.`;
  const lineEl = h('p', { class: 'td-line' }, line);
  if (isToday) { const prev = recall('hero:' + key); if (prev && prev !== line) jobs.push(() => pop(lineEl)); remember('hero:' + key, line); }
  const head = h('header', { class: 'td-head' },
    h('div', { class: 'grow' }, h('h1', null, isToday ? `${greeting()}${p.name ? ', ' + p.name : ''}` : 'Looking back'), lineEl),
    h('button', { class: 'icon-btn plain', 'aria-label': 'Settings', onClick: () => ctx.go('settings') }, icon('gear')));
  page.append(head); rise.push(head);

  // ---- date nav: Today / Yesterday / Mon 3 Nov, plus the streak pill ----
  const flame = streak > 1 ? h('span', { class: 'td-flame' }, icon('flame', 14)) : null;
  const streakBtn = streak > 1 && isToday ? h('button', { class: 'td-pill' + (loggedToday ? '' : ' wait'), 'aria-label': `${streak} day streak`, onClick: () => toast(loggedToday ? `${streak} days in a row with food logged. Keep going.` : `${streak}-day streak. Log something today to keep it alive.`) }, flame, loggedToday ? `${streak}-day streak` : `${streak} days · log today`) : null;
  const nav = h('div', { class: 'td-nav' },
    h('button', { class: 'icon-btn', 'aria-label': 'Previous day', onClick: () => ctx.setDate(shiftDate(key, -1)) }, icon('left')),
    h('div', { class: 'td-nav-mid' }, h('div', { class: 'td-nav-day' }, fmtDateLabel(key, ctx.today)),
      h('div', { class: 'td-nav-sub' }, h('span', null, longDate), streakBtn, !isToday ? h('button', { class: 'td-pill', onClick: () => ctx.setDate(ctx.today) }, 'Back to today') : null)),
    h('button', { class: 'icon-btn', 'aria-label': 'Next day', disabled: isToday, onClick: () => ctx.setDate(shiftDate(key, 1)) }, icon('right')));
  page.append(nav); rise.push(nav);
  if (flame && isToday && loggedToday && state.settings.streakPulsed !== key) {
    state.settings.streakPulsed = key; // saved with the next write; the flame plays once per day, the first time the streak includes today
    jobs.push(() => { pulse(flame, { scale: 1.7, ms: 600 }); if (MILESTONES.includes(streak)) celebrate(flame, { kind: 'streak' }); });
  }

  // ---- install hint (iOS Safari only) ----
  if (isIOS() && !isStandalone() && !state.settings.hideInstallHint) {
    page.append(h('div', { class: 'callout' }, icon('share'), h('div', { class: 'grow' }, h('b', null, 'Install this on your phone. '), 'In Safari tap Share, then “Add to Home Screen”. Then use only the home-screen icon: Safari and the icon keep separate data.'), h('button', { class: 'icon-btn plain', 'aria-label': 'Dismiss', onClick: () => { state.settings.hideInstallHint = true; commit(); } }, icon('x'))));
  }

  // ---- hero: the calorie dial ----
  const R = 160, STROKE = 12;
  const pctMain = t.kcal ? Math.min(100, (tot.kcal / t.kcal) * 100) : 0, pctLap = over && t.kcal ? Math.min(100, ((tot.kcal - t.kcal) / t.kcal) * 100) : 0;
  const numEl = h('span', { class: 'td-kcal' });
  const rg = ring({ size: R, stroke: STROKE, pct: pctMain, color: over ? 'var(--bad)' : 'var(--accent)', cls: 'td-ring' + (over ? ' over' : ''),
    children: [h('div', { class: 'num-xl td-num' + (over ? ' bad' : '') }, numEl), h('small', null, over ? 'kcal over' : 'kcal left')] });
  rg.setAttribute('role', 'img'); rg.setAttribute('aria-label', `${fmt(Math.abs(left))} kcal ${over ? 'over' : 'left'} of ${fmt(t.kcal)}`);
  const dl = dial(R, STROKE, pctMain, over); rg.insertBefore(dl, rg.querySelector('.ring-in'));
  let lap = null, knob = null;
  if (over) { lap = rg.fillEl.cloneNode(false); lap.setAttribute('class', 'fill lap2'); rg.fillEl.after(lap); }
  { // a small handle at the end of the arc; it rides the stroke as it grows
    knob = svgEl('g', { class: 'td-knob' }); knob.append(svgEl('circle', { cx: R - STROKE / 2, cy: R / 2, r: 2.6 }));
    rg.querySelector('svg:not(.td-dial)').append(knob);
  }
  const angle = (pct) => (pct / 100) * 360;
  jobs.push(() => {
    const prevMain = recall(`rg:${key}`, 0), prevLap = recall(`rl:${key}`, 0), ms = first ? 950 : 520;
    fill(rg.fillEl, pctMain, { axis: 'ring', key: `rg:${key}`, ms, delay: first ? 120 : 0 });
    if (lap) fill(lap, pctLap, { axis: 'ring', key: `rl:${key}`, ms, delay: first ? 600 : 0 });
    else remember(`rl:${key}`, 0);
    // knob: rotate from the old end to the new one with the same easing as the stroke
    const toA = angle(over ? pctLap : pctMain), fromA = angle(over ? prevLap : prevMain);
    knob.style.transformOrigin = `${R / 2}px ${R / 2}px`; knob.style.transform = `rotate(${toA}deg)`;
    knob.style.opacity = (over ? pctLap : pctMain) > 0.5 ? '1' : '0';
    if (canAnim() && Math.abs(toA - fromA) > 1) knob.animate([{ transform: `rotate(${fromA}deg)` }, { transform: `rotate(${toA}deg)` }], { duration: ms, delay: over ? (first ? 600 : 0) : first ? 120 : 0, easing: EASE_OUT, fill: 'backwards' });
    // dial ticks light up in sequence on the first open
    if (first && canAnim()) dl.litTicks.forEach((ln, i) => ln.animate([{ opacity: 0.1 }, { opacity: 1 }], { duration: 200, delay: 140 + (i / Math.max(1, dl.litTicks.length)) * 760, fill: 'backwards', easing: 'ease-out' }));
    // the number
    const shown = Math.abs(left), txt = (v) => fmt(v);
    const prevShown = recall(`kl:${key}`);
    if (first) { countUp(numEl, shown, { from: over ? 0 : t.kcal, key: `kl:${key}`, ms: 900, fmt: txt }); remember(`odo:kl:${key}`, txt(shown)); }
    else { odometer(numEl, shown, { key: `kl:${key}`, fmt: txt }); remember(`kl:${key}`, shown); if (prevShown != null && prevShown !== shown) pulse(numEl.parentNode, { scale: 1.07, ms: 360 }); }
  });

  const protHit = t.p > 0 && tot.p >= t.p;
  const fact = (label, val, unit) => h('div', { class: 'td-fact' }, h('span', { class: 'td-fact-l' }, label), h('b', null, val, unit ? h('small', null, unit) : null));
  const macro = (k, label, eaten, target, cls) => {
    const val = h('span'), bar = h('i'), hit = k === 'p' && protHit;
    const row = h('div', { class: 'td-macro ' + cls },
      h('div', { class: 'td-macro-top' }, h('span', { class: 'td-macro-name' }, h('i', { class: 'dot ' + cls }), label), hit ? h('span', { class: 'td-hit', 'aria-label': 'Target reached' }, icon('check', 13)) : null),
      h('div', { class: 'td-macro-val' }, val, h('small', null, `/ ${target} g`)),
      h('div', { class: 'td-track' }, bar));
    jobs.push(() => {
      const prev = recall(`mv:${k}:${key}`);
      countUp(val, Math.round(eaten), { key: `mv:${k}:${key}`, ms: 650 });
      fill(bar, target ? Math.min(100, (eaten / target) * 100) : 0, { key: `mb:${k}:${key}`, delay: first ? 160 : 0, ms: 650 });
      if (prev != null && prev !== Math.round(eaten)) pulse(val, { scale: 1.14, ms: 380 });
    });
    return row;
  };
  // the first time protein crosses its target this session: a small burst
  const goalKey = 'pgoal:' + key;
  const macrosEl = h('div', { class: 'td-macros' }, macro('p', 'Protein', tot.p, t.p, 'p'), macro('c', 'Carbs', tot.c, t.c, 'c'), macro('f', 'Fat', tot.f, t.f, 'f'));
  if (isToday && recall(goalKey) === false && protHit) jobs.push(() => { celebrate(macrosEl.querySelector('.td-hit') || macrosEl, { kind: 'goal' }); haptic('success'); });
  if (isToday) remember(goalKey, protHit);
  const hero = h('div', { class: 'card fuel td-fuel' + (over ? ' over' : '') },
    h('div', { class: 'td-fuel-main' }, rg, macrosEl),
    h('div', { class: 'td-facts' }, fact('Eaten', fmt(tot.kcal), burn ? '' : ' kcal'), burn ? fact('Burned', fmt(burn)) : null, fact('Fibre', Math.round(tot.fiber), ` / ${t.fiber} g`), fact('Sugar', Math.round(tot.sugar), ' g')));
  page.append(hero); rise.push(hero);

  // ---- quick-log tiles: tap = +1, minus removes the last, hold opens the list ----
  const glassMl = state.settings.glassMl || 250, water = waterMl(key), glasses = Math.round((water / glassMl) * 10) / 10, goalGlasses = t.water || 8;
  const chaiList = chaiEntries(key), cigList = habitEntries(key, 'cig'), chai = chaiList.length, cigs = cigList.length;
  const wt = dayIfAny(key)?.weight, lw = latestWeight(), sleepH = dayIfAny(key)?.sleep, lim = t.cigLimit;
  const lastOf = (a) => a.reduce((m, e) => (!m || e.ts > m.ts ? e : m), null);
  const tiles = [];
  const tile = (id, cfg) => {
    const el = counterTile({ ...cfg, extra: 'mo-ripple-host ' + (cfg.extra || ''), onAdd: (e) => { ripple(el, e); cfg.onAdd(e); } });
    jobs.push(() => {
      const prev = recall(`tc:${id}:${key}`), now = cfg.count || 0; remember(`tc:${id}:${key}`, now);
      if (prev != null && prev !== now) { const c = el.querySelector('.count'); if (c) (now > prev ? pop : pulse)(c); else pulse(el.querySelector('.well'), { scale: 0.82, ms: 300 }); }
    });
    tiles.push(el); return el;
  };
  const quick = h('div', { class: 'quick td-quick' });
  const lastChai = lastOf(chaiList);
  quick.append(tile('chai', { cls: 'chai', ico: 'cup', label: 'Chai', count: chai, sub: isToday && lastChai ? shortAgo(lastChai.ts) : 'Tap to log',
    onAdd: () => tapChai(key), onRemove: () => undoLast(KINDS.chai(key)), onOpen: () => countSheet('chai', key) }));
  if (p.smoker) {
    const lastC = lastOf(cigList), over5 = !!lim && cigs > lim;
    quick.append(tile('cig', { cls: 'cig', ico: 'cig', label: 'Cigarette', count: cigs, bad: over5, sub: lim ? `limit ${lim}` : isToday && lastC ? shortAgo(lastC.ts) : 'Tap to log',
      onAdd: () => tapCig(key), onRemove: () => undoLast(KINDS.cig(key)), onOpen: () => countSheet('cig', key) }));
  } else quick.append(tile('sleep', { cls: 'sleep', ico: 'moon', label: 'Sleep', count: 0, sub: sleepH ? `${n1(sleepH)} h` : 'Log', onAdd: () => sleepSheet(key), onOpen: () => sleepSheet(key) }));
  const under = h('div', { class: 'under' });
  jobs.push(() => fill(under, Math.min(100, goalGlasses ? (water / (goalGlasses * glassMl)) * 100 : 0), { axis: 'y', key: `wf:${key}`, ms: 700 }));
  quick.append(tile('water', { cls: 'water', ico: 'drop', label: 'Water', count: glasses, sub: `of ${goalGlasses}`, under, extra: 'td-water-tile',
    onAdd: () => tapWater(key, water, glasses, goalGlasses, glassMl, under), onRemove: () => undoLast(KINDS.water(key)), onOpen: () => countSheet('water', key) }));
  quick.append(tile('weight', { cls: 'weight', ico: 'scale', label: 'Weight', count: 0, sub: wt ? `${n1(wt)} kg` : 'Weigh in', onAdd: () => weightSheet(key, wt || lw?.kg || 70), onOpen: () => weightSheet(key, wt || lw?.kg || 70) }));
  page.append(quick);
  if (p.smoker && cigs && isToday) page.append(h('p', { class: 'td-note' }, `Last cigarette ${Date.now() - (lastHabitTs('cig') || 0) < 60000 ? 'just now' : sinceText(lastHabitTs('cig')) + ' ago'}${lim ? ` · limit ${lim}` : ''}${lim && cigs > lim ? ' · over limit' : ''}`));
  else if ((chai || cigs || water) && !state.settings.todayTileHint) page.append(h('p', { class: 'td-note' }, 'Tap to add one. Tap − to remove the last. Hold a tile to edit.'));
  if (first && canAnim()) jobs.push(() => tiles.forEach((el, i) => enter(el, 190 + i * 45, 12, 300)));

  // ---- check-in ----
  const ck = dayIfAny(key)?.checkin;
  const CK = [['energy', 'Energy'], ['mood', 'Mood'], ['hunger', 'Hunger'], ['sleepQ', 'Sleep']];
  const ckCells = ck ? CK.filter(([k]) => typeof ck[k] === 'number') : [];
  const checkin = h('div', { class: 'card td-ck-card' },
    h('div', { class: 'row' },
      h('span', { class: 'well lg' + (ck ? ' good' : ' food') }, icon(ck ? 'check' : 'heart')),
      h('div', { class: 'grow' }, h('h3', null, ck ? 'Check-in saved' : 'How are you feeling?'), h('div', { class: 'small muted' }, ck ? (ckCells.length ? 'Your numbers for the day' : 'Notes saved.') : 'Energy, bloating, digestion, sleep. 20 seconds.')),
      h('button', { class: 'btn sm nowrap ' + (ck ? '' : 'primary'), onClick: () => ctx.go('body', { open: 'checkin', date: key }) }, ck ? 'Edit' : 'Check in')),
    ckCells.length ? h('div', { class: 'td-ck' }, ckCells.map(([k, l]) => h('div', { class: 'td-ck-cell' }, h('div', { class: 'td-ck-top' }, h('span', null, l), h('b', null, `${ck[k]}/5`)), h('div', { class: 'td-pips' }, [1, 2, 3, 4, 5].map((n) => h('i', { class: n <= ck[k] ? 'on' : '' }))))))
      : null);
  page.append(checkin);

  // ---- training ----
  const ws = workoutsOn(key);
  page.append(trainingCard(ctx, key, isToday, ws));

  // ---- day ledger ----
  const items = [];
  for (const e of (dayIfAny(key)?.food || [])) items.push({ ts: e.ts, type: isChai(e) ? 'chai' : 'food', e });
  for (const hb of cigList) items.push({ ts: hb.ts, type: 'cig', e: hb });
  for (const w of ws) items.push({ ts: w.start, type: 'train', e: w });
  items.sort((a, b) => a.ts - b.ts);
  const led = h('section', { class: 'td-sec' },
    h('div', { class: 'section-head' }, h('h2', null, 'Day ledger'),
      h('div', { class: 'row', style: { gap: '4px' } },
        h('button', { class: 'icon-btn plain', 'aria-label': 'Scan a plate with the camera', onClick: () => openScan(ctx) }, icon('camera', 22)),
        h('button', { class: 'link', onClick: () => ctx.go('food') }, 'Add food'))));
  if (!items.length) {
    cache.led = null;
    led.append(h('div', { class: 'card' }, h('div', { class: 'empty td-empty' }, katori(), h('b', null, isToday ? 'Nothing logged yet' : 'Nothing logged this day'),
      isToday ? 'Log your first meal or a chai and the day starts counting.' : 'Add what you ate so this day counts in your trends.',
      h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '14px' } }, isToday ? h('button', { class: 'btn soft', onClick: () => tapChai(key) }, icon('cup', 18), 'Log chai') : h('button', { class: 'btn soft', onClick: () => ctx.go('food') }, icon('plus', 18), 'Add food')))));
  } else {
    const sig = key + '|' + items.map((it) => [it.type, it.e.id, it.ts, it.e.name, it.e.kcal, it.e.qty, it.e.meal, it.e.oilTsp, it.e.p, it.e.unit?.label, it.e.volume, it.e.end].join('~')).join('|');
    if (cache.led && cache.led.sig === sig) led.append(cache.led.el);
    else {
      const el = h('div', { class: 'card td-led', 'data-no-swipe': '' });
      let prevCig = 0;
      const rows = items.map((it) => { const gap = it.type === 'cig' ? (prevCig ? it.ts - prevCig : 0) : 0; if (it.type === 'cig') prevCig = it.ts; return ledgerRow(it, key, ctx, gap); });
      rows.forEach((r) => el.append(r.row));
      cache.led = { sig, el };
      jobs.push(() => rows.forEach((r) => { if (r.onDelete) swipeReveal(r.item, { label: 'Delete', onAction: r.onDelete }); }));
      if (first && canAnim()) jobs.push(() => rows.slice(0, 6).forEach((r, i) => enter(r.row, 420 + i * 30, 8, 260)));
    }
    led.append(cache.led.el);
  }
  if (water) {
    const wb = h('i');
    jobs.push(() => fill(wb, Math.min(100, goalGlasses ? (water / (goalGlasses * glassMl)) * 100 : 0), { key: `ww:${key}`, ms: 600 }));
    led.append(h('div', { class: 'td-water' }, h('span', { class: 'well water' }, icon('drop', 18)), h('div', { class: 'grow' }, h('div', { class: 'td-water-line' }, h('b', null, `${fmt(water / 1000, 2)} L`), h('span', { class: 'muted' }, `${n1(glasses)} of ${goalGlasses} glasses`)), h('div', { class: 'td-track water' }, wb))));
  }
  page.append(led);

  // ---- this week: weekday initials, today highlighted, over means more than 5% above target ----
  const keys = lastNDays(7, ctx.today);
  const bars = keys.map((k) => { const v = dayTotals(k).kcal; return { label: fmtDow(k)[0], value: v, hl: k === ctx.today, color: v > t.kcal * 1.05 ? 'var(--bad)' : 'var(--c)', tip: `${fmtDateLabel(k, ctx.today)}: ${fmt(v)} kcal` }; });
  if (bars.some((b) => b.value)) {
    const logged = bars.filter((b) => b.value), avg = logged.reduce((a, b) => a + b.value, 0) / Math.max(1, logged.length);
    const done = keys.slice(0, -1).filter((k) => dayIfAny(k)?.food?.length && !dayIfAny(k)?.partial), good = done.filter((k) => Math.abs(dayTotals(k).kcal / t.kcal - 1) <= 0.1).length;
    const pDays = keys.filter((k) => t.p > 0 && dayTotals(k).p >= t.p * 0.95).length;
    page.append(h('section', { class: 'td-sec' },
      h('div', { class: 'section-head' }, h('h2', null, 'This week'), h('span', { class: 'small muted nowrap' }, `avg ${fmt(avg)} kcal`)),
      h('div', { class: 'card pad-s td-week' }, barChart({ bars, target: t.kcal, height: 120, color: 'var(--c)' }),
        legend([{ color: 'var(--c)', label: 'Within target' }, { color: 'var(--bad)', label: 'Over by 5%+' }]),
        h('div', { class: 'td-pills' },
          done.length ? h('span', { class: 'pill ' + (good >= done.length / 2 ? 'good' : '') }, `Within 10% on ${good} of ${done.length} full day${done.length === 1 ? '' : 's'}`) : null,
          h('span', { class: 'pill p' }, `Protein hit on ${pDays} of 7 days`)))));
  }

  // ---- add food: pinned above the tab bar while the day is empty ----
  if (!tot.n && !items.length) page.append(h('div', { class: 'td-cta glass mo-sticky' },
    h('button', { class: 'btn primary lg', onClick: () => ctx.go('food') }, icon('plus'), 'Add food'),
    h('button', { class: 'btn lg', onClick: () => openScan(ctx) }, icon('camera'), 'Scan plate')));

  if (first && canAnim()) jobs.push(() => [checkin, page.querySelector('.td-train'), led].forEach((el, i) => enter(el, 360 + i * 50, 12, 320)));
  if (first && canAnim()) jobs.push(() => rise.forEach((el, i) => enter(el, i * 45, 8, 300)));
  return page;
}

// ---------------------------------------------------------------- training card
function trainingCard(ctx, key, isToday, ws) {
  const card = h('div', { class: 'card td-train' });
  if (state.active && isToday) {
    const a = state.active, r = a.rest, mins = Math.max(0, Math.round((Date.now() - a.start) / 60000));
    card.classList.add('accent');
    card.append(h('div', { class: 'td-train-top' }, h('span', { class: 'well train lg' }, icon('dumbbell')),
      h('div', { class: 'grow' }, h('h3', { class: 'td-live-h' }, h('span', { class: 'td-live', 'aria-hidden': 'true' }), 'Workout in progress'), h('div', { class: 'small muted ellipsis' }, `${a.name} · ${mins} min${r && r.endAt > Date.now() ? ' · resting' : ''}`)),
      h('button', { class: 'btn sm primary nowrap', onClick: () => ctx.go('train') }, icon('play', 16), 'Resume')));
    return card;
  }
  if (ws.length) {
    ws.forEach((w, i) => {
      const stat = (v, l) => h('div', { class: 'td-stat' }, h('div', { class: 'num-sm' }, v), h('div', { class: 'micro muted' }, l));
      card.append(h('div', { class: 'td-done' + (i ? ' next' : '') },
        h('div', { class: 'td-train-top' }, h('span', { class: 'well good lg' }, icon('check')),
          h('div', { class: 'grow' }, h('h3', { class: 'ellipsis' }, w.name || 'Workout'), h('div', { class: 'td-done-sub small muted' }, h('span', { class: 'nowrap' }, `Done ${fmtTime(w.end || w.start)}`), w.prs?.length ? h('span', { class: 'pr-tag nowrap' }, icon('trophy', 12), `${w.prs.length} PR${w.prs.length > 1 ? 's' : ''}`) : null)),
          h('button', { class: 'btn sm nowrap', onClick: () => ctx.go('train') }, 'View')),
        h('div', { class: 'td-stats' }, stat(fmtDur((w.end - w.start) / 1000), 'time'), stat(fmt(w.volume), 'kg lifted'), stat(fmt(w.kcal), 'kcal burned'))));
    });
    return card;
  }
  let plan = null;
  if (isToday) { try { plan = todayPlan(); } catch (e) { plan = null; } }
  if (!isToday) {
    card.append(h('div', { class: 'td-train-top' }, h('span', { class: 'well sleep lg' }, icon('moon')), h('div', { class: 'grow' }, h('h3', null, 'Rest day'), h('div', { class: 'small muted' }, 'Nothing was trained this day.'))));
    return card;
  }
  if (plan && plan.kind === 'train') {
    card.append(h('div', { class: 'td-train-top' }, h('span', { class: 'well train lg' }, icon('dumbbell')),
      h('div', { class: 'grow' }, h('h3', null, `${plan.dayName}: you usually train`), h('div', { class: 'small muted' }, `${plan.hits} of the last ${plan.weeksObserved} ${plan.dayName}s`)),
      h('button', { class: 'btn sm primary nowrap', onClick: () => ctx.go('train') }, icon('play', 16), 'Start')),
      h('div', { class: 'td-groups' }, plan.groups.map(groupChip)));
    return card;
  }
  if (plan && plan.kind === 'rest') {
    card.classList.add('td-rest');
    card.append(h('div', { class: 'td-train-top' }, h('span', { class: 'well sleep lg' }, icon('moon')),
      h('div', { class: 'grow' }, h('h3', null, 'Rest day'), h('div', { class: 'small muted' }, 'Your usual rest day. Recovery builds muscle.')),
      h('button', { class: 'btn sm ghost nowrap', onClick: () => ctx.go('train') }, 'Train anyway')));
    return card;
  }
  // no weekday pattern yet: fall back to the routine and the last session
  const prior = state.workouts.filter((w) => dateKey(new Date(w.start)) < key).reduce((a, w) => (!a || w.start > a.start ? w : a), null);
  const week = new Set(lastNDays(7, key)), inWeek = state.workouts.filter((w) => week.has(dateKey(new Date(w.start)))).length;
  const r = state.settings.currentRoutineId && state.data.routines.concat(state.customRoutines).find((x) => x.id === state.settings.currentRoutineId);
  const dayPlan = r?.days?.[(state.settings.routineDayIndex || 0) % r.days.length];
  const bits = [];
  if (dayPlan) bits.push(`Next up: ${dayPlan.name} (${r.name})`);
  if (prior) bits.push(`Last trained: ${prior.name || 'Workout'} · ${ago(prior.start)}`);
  if (prior && inWeek) bits.push(`${inWeek} workout${inWeek > 1 ? 's' : ''} in the last 7 days`);
  card.append(h('div', { class: 'td-train-top' }, h('span', { class: 'well train lg' }, icon('dumbbell')),
    h('div', { class: 'grow' }, h('h3', null, 'No workout yet'), bits.length ? bits.map((b) => h('div', { class: 'small muted' }, b)) : h('div', { class: 'small muted' }, 'Log sets, reps and weight. The app remembers last time.')),
    h('button', { class: 'btn sm primary nowrap', onClick: () => ctx.go('train') }, icon('play', 16), dayPlan ? 'Start' : 'Train')));
  return card;
}

// ---------------------------------------------------------------- ledger
function ledgerRow(it, key, ctx, gap) {
  const { type, e } = it;
  let name, meta, kcal, sub, tl, onDelete = null;
  if (type === 'food' || type === 'chai') {
    name = e.name; meta = `${servingText(e)}${e.oilTsp ? ` · +${e.oilTsp} tsp oil` : ''} · P ${Math.round(e.p)} g`; kcal = fmt(e.kcal); sub = 'kcal'; tl = cap(e.meal);
    onDelete = () => { const copy = { ...e }; haptic('warn'); removeFood(key, e.id); toast(`Removed ${name.length > 26 ? name.slice(0, 25) + '…' : name}`, { undo: () => logFood(key, copy) }); };
  } else if (type === 'cig') {
    name = 'Cigarette'; meta = e.note || (gap ? `${gapText(gap)} after the last` : 'First of the day'); kcal = ''; sub = '';
    onDelete = () => { const copy = { ...e }; haptic('warn'); removeHabit(key, e.id); toast('Removed cigarette', { undo: () => logHabit(key, 'cig', copy) }); };
  } else { name = e.name || 'Workout'; meta = `${fmtDur((e.end - e.start) / 1000)} · ${fmt(e.volume)} kg`; kcal = '−' + fmt(e.kcal); sub = 'burned'; }
  const item = h('button', { class: 'td-item', onClick: () => itemSheet(it, key, ctx) },
    h('div', { class: 'td-time' }, h('div', null, fmtTime(it.ts)), tl ? h('div', { class: 'td-meal' }, tl) : null),
    h('div', { class: 'grow' }, h('div', { class: 'td-name ellipsis' }, name), h('div', { class: 'td-meta ellipsis' }, meta)),
    kcal ? h('div', { class: 'td-kc' }, kcal, h('small', null, sub)) : null);
  const row = h('div', { class: 'td-row' }, h('i', { class: 'td-pin ' + type }), h('div', { class: 'td-main' }, item));
  return { row, item, onDelete };
}

function itemSheet(it, key, ctx) {
  const { type, e } = it;
  if (type === 'train') {
    return sheet({ title: e.name || 'Workout',
      content: h('div', { class: 'stack' }, h('div', { class: 'tiles-4' }, [[fmtDur((e.end - e.start) / 1000), 'time'], [fmt(e.volume), 'kg lifted'], [fmt(e.kcal), 'kcal burned'], [e.prs?.length || 0, 'PRs']].map(([v, l]) => h('div', { class: 'tile' }, h('div', { class: 'lbl' }, l), h('div', { class: 'val' }, v)))),
        h('p', { class: 'small muted' }, `Started ${fmtTime(e.start)}. Sets and exercises are in Train.`)),
      actions: (api) => [h('button', { class: 'btn primary', onClick: () => { api.close(); ctx.go('train'); } }, 'Open in Train')] });
  }
  const dots = { kcal: 'accent', p: 'p', c: 'c', f: 'f' };
  const s = sheet({ title: type === 'cig' ? 'Cigarette' : e.name,
    content: type === 'cig' ? h('p', { class: 'muted' }, `Logged at ${fmtTime(e.ts)}.`) : h('div', { class: 'tiles-4' },
      ['kcal', 'p', 'c', 'f'].map((k) => h('div', { class: 'tile' }, h('div', { class: 'lbl' }, h('i', { class: 'dot ' + (dots[k] === 'accent' ? '' : dots[k]), style: dots[k] === 'accent' ? { background: 'var(--accent)' } : null }), { kcal: 'kcal', p: 'Protein', c: 'Carbs', f: 'Fat' }[k]), h('div', { class: 'val' }, Math.round(e[k] || 0), k !== 'kcal' ? h('small', null, 'g') : null)))),
    actions: (api) => [h('button', { class: 'btn danger', onClick: () => {
      haptic('warn'); api.close(); const copy = { ...e };
      if (type === 'cig') { removeHabit(key, e.id); toast('Removed', { undo: () => logHabit(key, 'cig', copy) }); }
      else { removeFood(key, e.id); toast('Removed', { undo: () => logFood(key, copy) }); }
    } }, icon('trash'), 'Delete'), type !== 'cig' ? h('button', { class: 'btn', onClick: () => { api.close(); ctx.go('food', { edit: e.id, date: key }); } }, icon('edit'), 'Edit in Food') : null] });
  if (type !== 'cig') s.el.querySelector('.sheet-body').append(h('p', { class: 'small muted', style: { marginTop: '10px' } }, `${servingText(e)} (${Math.round(e.g)} g) · ${e.meal} · ${fmtTime(e.ts)}${e.fiber || e.sugar ? ` · fibre ${Math.round(e.fiber || 0)} g · sugar ${Math.round(e.sugar || 0)} g` : ''}`));
}

// ---------------------------------------------------------------- quick logging
const chaiEntries = (key) => (dayIfAny(key)?.food || []).filter(isChai).sort((a, b) => a.ts - b.ts);

function chaiFields() {
  const id = state.profile?.chaiFoodId || 'chai_milk_1tsp';
  const food = findFood(id) || findFood('chai_milk_1tsp') || state.data.foods.find((f) => /chai/.test(f.id));
  if (!food) return null;
  const sv = food.servings[0], m = scaleFood(food, sv.g);
  const micro = food.micro ? Object.fromEntries(Object.entries(food.micro).map(([k, v]) => [k, +(v * sv.g / 100).toFixed(2)])) : null;
  return { foodId: food.id, name: food.name, cat: food.cat, qty: 1, unit: sv, g: sv.g, ...m, micro, triggers: food.triggers || [], meal: 'drinks', oilTsp: 0 };
}

// What each counter tile edits: its entries, how one is added, removed and put back. `val` is what one entry counts for; `unit` is one tap.
const KINDS = {
  chai: (key) => ({ key, noun: 'chai', title: 'Chai', ico: 'cup', cls: 'chai', unit: 1, val: () => 1, list: () => chaiEntries(key),
    label: (e) => e.name, sub: (e) => `${Math.round(e.kcal)} kcal`, del: (e) => removeFood(key, e.id), put: (c) => logFood(key, c), add: () => { const f = chaiFields(); return f ? logFood(key, f) : null; }, count: () => chaiEntries(key).length }),
  cig: (key) => ({ key, noun: 'cigarette', title: 'Cigarettes', ico: 'cig', cls: 'cig', unit: 1, val: () => 1, list: () => habitEntries(key, 'cig').sort((a, b) => a.ts - b.ts),
    label: () => 'Cigarette', sub: (e) => e.note || '', del: (e) => removeHabit(key, e.id), put: (c) => logHabit(key, 'cig', c), add: () => logHabit(key, 'cig'), count: () => habitCount(key, 'cig') }),
  water: (key) => { const g = state.settings.glassMl || 250; return { key, noun: 'water', title: 'Water', ico: 'drop', cls: 'water', unit: g, val: (e) => e.ml || g, list: () => habitEntries(key, 'water').sort((a, b) => a.ts - b.ts),
    label: (e) => `${e.ml || g} ml`, sub: () => '', del: (e) => removeHabit(key, e.id), put: (c) => logHabit(key, 'water', c), add: (need) => logHabit(key, 'water', { ml: Math.round(need || g) }), count: () => Math.round(waterMl(key) / g) }; },
};

// The "−" on a tile: remove the most recent entry of that kind, with Undo.
function undoLast(cfg) {
  const e = cfg.list().slice(-1)[0]; if (!e) return;
  const copy = { ...e };
  cfg.del(e);
  if (!state.settings.todayTileHint) { state.settings.todayTileHint = true; }
  toast(`Removed ${cfg.noun === 'water' ? `${e.ml || cfg.unit} ml of water` : `${cfg.noun} from ${fmtTime(e.ts)}`}`, { undo: () => cfg.put(copy) });
}

function tapChai(key) {
  const f = chaiFields(); if (!f) return toast('No chai in the food list yet');
  const e = logFood(key, f); haptic();
  toast(`Chai ${chaiCount(key)} today · ${Math.round(e.kcal)} kcal`, { undo: () => removeFood(key, e.id) });
}
function tapCig(key) {
  const e = logHabit(key, 'cig'); haptic();
  const n = habitCount(key, 'cig'), lim = state.targets?.cigLimit;
  toast(`Cigarette ${n} today${lim ? ` · limit ${lim}` : ''}`, { undo: () => removeHabit(key, e.id) });
}
function tapWater(key, water, glasses, goalGlasses, glassMl, under) {
  const e = logHabit(key, 'water', { ml: glassMl }); haptic();
  const g = Math.round(((water + glassMl) / glassMl) * 10) / 10;
  if (g >= goalGlasses && glasses < goalGlasses) { celebrate(under.parentNode, { kind: 'goal' }); haptic('success'); }
  toast(`Water: ${n1(g)} of ${goalGlasses} glasses · ${fmt((water + glassMl) / 1000, 2)} L`, { undo: () => removeHabit(key, e.id) });
}

// Long-press on a tile: today's entries of that kind, a delete on each, and a way to set the count outright.
function countSheet(kind, key) {
  const cfg = KINDS[kind](key);
  if (!state.settings.todayTileHint) { state.settings.todayTileHint = true; commit(); }
  const list = h('div', { class: 'td-cs-list' });
  let target = cfg.count(), stepEl = null, apply = null;
  const sync = () => { const c = cfg.count(); target = c; const inp = stepEl && stepEl.querySelector('input'); if (inp) inp.value = String(c); if (apply) apply.disabled = true; };
  const paint = (api) => {
    clear(list);
    const es = cfg.list();
    const hd = api && api.el.querySelector('.sheet-head h2'); if (hd) hd.textContent = `${cfg.title} today${es.length ? ` · ${kind === 'water' ? n1(waterMl(key) / cfg.unit) : es.length}` : ''}`;
    if (!es.length) list.append(h('p', { class: 'small muted td-cs-empty' }, 'Nothing logged on this day.'));
    es.slice().reverse().forEach((e) => list.append(h('div', { class: 'td-cs-row' },
      h('span', { class: 'td-cs-time' }, fmtTime(e.ts)),
      h('div', { class: 'grow' }, h('div', { class: 'strong ellipsis' }, cfg.label(e)), cfg.sub(e) ? h('div', { class: 'micro muted' }, cfg.sub(e)) : null),
      h('button', { class: 'icon-btn plain', 'aria-label': `Delete the entry from ${fmtTime(e.ts)}`, onClick: () => { const copy = { ...e }; haptic('warn'); cfg.del(e); toast(`Removed ${cfg.noun === 'water' ? cfg.label(e) + ' of water' : cfg.noun} from ${fmtTime(e.ts)}`, { undo: () => { cfg.put(copy); paint(api); sync(); } }); paint(api); sync(); } }, icon('trash')))));
  };
  const api = sheet({ title: `${cfg.title} today`,
    content: (a) => {
      stepEl = stepper({ value: target, min: 0, max: 40, step: 1, onChange: (v) => { target = v; if (apply) apply.disabled = v === cfg.count(); } });
      const body = h('div', { class: 'stack' }, list,
        h('div', { class: 'td-cs-set' }, h('div', { class: 'grow' }, h('div', { class: 'strong' }, 'Set count'), h('div', { class: 'micro muted' }, kind === 'water' ? `Glasses of ${cfg.unit} ml` : 'Adds or removes the most recent')), stepEl));
      return body;
    },
    actions: (a) => { apply = h('button', { class: 'btn primary', disabled: true, onClick: () => { const undo = setCount(cfg, target); a.close(); haptic('success'); toast(`${cfg.title} set to ${target}`, { undo }); } }, 'Apply count'); return [h('button', { class: 'btn', onClick: a.close }, 'Done'), apply]; } });
  paint(api);
}
// Move the total for the day to exactly N units: drop the most recent entries first, then add what is missing. Returns an undo.
function setCount(cfg, n) {
  const goal = n * cfg.unit, removed = [], added = [];
  let es = cfg.list(), total = es.reduce((a, e) => a + cfg.val(e), 0);
  while (total > goal + 1e-9 && es.length) { const e = es.pop(); removed.push({ ...e }); cfg.del(e); total -= cfg.val(e); }
  let guard = 0;
  while (total < goal - 1e-9 && guard++ < 60) { const e = cfg.add(Math.min(cfg.unit, goal - total)); if (!e) break; added.push(e); total += cfg.val(e); }
  return () => { added.forEach((e) => cfg.del(e)); removed.forEach((c) => cfg.put(c)); };
}

function weightSheet(key, start) {
  let v = start;
  const before = weights().filter((w) => w.date < key).pop(), prevToday = dayIfAny(key)?.weight ?? null;
  const delta = h('div', { class: 'td-wdelta small muted' });
  const paint = () => { const d = before ? +(v - before.kg).toFixed(1) : null; delta.textContent = before ? `${d === 0 ? 'Same as' : `${d > 0 ? '+' : '−'}${Math.abs(d)} kg vs`} your last weigh-in (${n1(before.kg)} kg)` : 'Your first weigh-in. It sets the starting point.'; };
  paint();
  sheet({ title: 'Weigh in', content: h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Best first thing in the morning, after the loo, before chai. Same scale every time.'), h('div', { class: 'row', style: { justifyContent: 'center' } }, stepper({ value: v, min: 30, max: 250, step: 0.1, onChange: (x) => { v = x; paint(); } }), h('span', { class: 'muted' }, 'kg')), delta),
    actions: (api) => [h('button', { class: 'btn primary', onClick: () => {
      setWeight(key, v); api.close(); haptic('success');
      const d = before ? +(v - before.kg).toFixed(1) : null;
      toast(`Weight saved: ${n1(v)} kg${d != null && d !== 0 ? ` · ${d > 0 ? '+' : '−'}${Math.abs(d)} vs last` : ''}`, { undo: () => setWeight(key, prevToday) });
    } }, 'Save weight')] });
}
function sleepSheet(key) {
  const prev = dayIfAny(key)?.sleep ?? null;
  let v = prev || state.profile?.sleepTarget || 7.5;
  sheet({ title: 'Sleep last night', content: h('div', { class: 'row', style: { justifyContent: 'center' } }, stepper({ value: v, min: 0, max: 14, step: 0.5, onChange: (x) => { v = x; } }), h('span', { class: 'muted' }, 'hours')),
    actions: (api) => [h('button', { class: 'btn primary', onClick: () => { day(key).sleep = v; commit(); api.close(); haptic('success'); toast(`Sleep saved: ${n1(v)} h`, { undo: () => { day(key).sleep = prev; commit(); } }); } }, 'Save sleep')] });
}
