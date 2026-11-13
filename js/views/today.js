// Today: how the day is going. Hero (daily target, eaten, left, macros with what is still to go; tap for how the targets are set), quick-log tiles,
// coach, energy card (eaten, burned so far and why, balance, day score), training verdict, check-in, day ledger, week glance.
// Swipe right/left to change day. Water shows only when Settings turns it on.
import { state, day, dayIfAny, dayTotals, habitCount, habitEntries, waterMl, chaiCount, isChai, logHabit, removeHabit, logFood, removeFood, findFood, setWeight, latestWeight, weights, workoutsOn, shiftDate, lastNDays, lastHabitTs, commit, dateKey, trackWater, setSteps, stepsOn } from '../state.js';
import { scaleFood } from '../calc.js';
import { tidyName, coachCard, targetsSheet, gradientRing } from './food-extras.js';
import { todayPlan } from '../train-plan.js';
import { dayVerdict, weekVerdict, stepsKcal } from '../verdict.js';
import { h, icon, sheet, toast, stepper, counterTile, ring, fmt, fmtTime, fmtDateLabel, fmtShortDate, fmtDur, fmtDow, sinceText, ago, clear, haptic } from '../ui.js';
import { barChart, legend } from '../charts.js';
import { countUp, odometer, fill, pulse, pop, ripple, celebrate, quiet, seen, remember, recall, swipeNav, swipeReveal, prefersReducedMotion, EASE_OUT } from '../motion.js';

const openScan = (ctx) => import('./food-scan.js').then((m) => m.openScanner(ctx, { date: ctx.date })).catch((e) => toast('Could not open the scanner: ' + e.message));

const shortcutSeen = new WeakSet(); // one apply per "#today?steps=" hand-off, however often the screen redraws or the day is swiped
export function render(container, ctx) {
  const root = h('div', { class: 'td' });
  container.append(root);
  const hand = takeShortcutSteps(ctx);
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
  if (hand) afterShortcutSteps(hand);
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
  const tot = dayTotals(key), left = t.kcal - tot.kcal, over = tot.kcal > t.kcal;
  let dv = null; try { dv = dayVerdict(key); } catch (e) { console.error(e); } // the recap and the training verdict are extras: a throw here must never blank the screen
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

  // ---- hero: daily target, eaten, left. The ring is the picture, the macros say what is still to go. Tap anywhere: how the targets are set ----
  const R = 132, STROKE = 12;
  const pctRaw = t.kcal ? (tot.kcal / t.kcal) * 100 : 0, pctMain = Math.min(100, pctRaw), pctLap = over && t.kcal ? Math.min(100, ((tot.kcal - t.kcal) / t.kcal) * 100) : 0;
  const pctEl = h('span', { class: 'td-kcal' }), eatEl = h('span', { class: 'td-kcal' }), leftEl = h('span', { class: 'td-kcal' });
  const rg = ring({ size: R, stroke: STROKE, pct: pctMain, color: over ? 'var(--bad)' : 'var(--accent)', cls: 'td-ring' + (over ? ' over' : ''),
    children: [h('div', { class: 'num-lg td-num' + (over ? ' bad' : '') }, pctEl, h('span', { class: 'td-pc' }, '%')), h('small', null, 'of target')] });
  rg.setAttribute('role', 'img'); rg.setAttribute('aria-label', `${Math.round(pctRaw)}% of your daily target eaten`);
  if (!over) gradientRing(rg, 'td-grad');
  const dl = dial(R, STROKE, pctMain, over); rg.insertBefore(dl, rg.querySelector('.ring-in'));
  const ringSvg = rg.querySelector('svg:not(.td-dial)');
  let lap = null;
  if (over) { lap = rg.fillEl.cloneNode(false); lap.setAttribute('class', 'fill lap2'); lap.style.stroke = 'var(--bad)'; rg.fillEl.after(lap); }
  // the glowing end-cap: a soft halo, a solid disc and a pin, riding the end of the arc as it grows
  const cap = svgEl('g', { class: 'td-cap' }), cx = R - STROKE / 2, cy = R / 2;
  { const defs = ringSvg.querySelector('defs') || ringSvg.insertBefore(svgEl('defs'), ringSvg.firstChild), rgd = svgEl('radialGradient', { id: 'td-halo' }); rgd.style.color = over ? 'var(--bad)' : 'var(--accent-2)';
    rgd.append(svgEl('stop', { offset: '0', 'stop-color': 'currentColor', 'stop-opacity': '.75' }), svgEl('stop', { offset: '1', 'stop-color': 'currentColor', 'stop-opacity': '0' })); defs.append(rgd);
    cap.append(svgEl('circle', { cx, cy, r: STROKE * 1.7, fill: 'url(#td-halo)' }), svgEl('circle', { cx, cy, r: STROKE / 2 + 0.6, class: 'core' }), svgEl('circle', { cx, cy, r: 2.3, class: 'pin' }));
    ringSvg.append(cap); }
  const angle = (pc) => (pc / 100) * 360;
  // a number that counts up on the first open and rolls like an odometer after that
  const numAnim = (el, val, k, from = 0) => {
    const prev = recall(k);
    if (first) { countUp(el, val, { from, key: k, ms: 1000, fmt }); remember('odo:' + k, fmt(val)); }
    else { odometer(el, val, { key: k, fmt }); remember(k, val); if (prev != null && prev !== val) pulse(el.parentNode, { scale: 1.06, ms: 360 }); }
  };
  jobs.push(() => {
    const prevMain = recall(`rg:${key}`, 0), prevLap = recall(`rl:${key}`, 0), ms = first ? 1100 : 520;
    fill(rg.fillEl, pctMain, { axis: 'ring', key: `rg:${key}`, ms, delay: first ? 140 : 0 });
    if (lap) fill(lap, pctLap, { axis: 'ring', key: `rl:${key}`, ms, delay: first ? 640 : 0 }); else remember(`rl:${key}`, 0);
    const toA = angle(over ? pctLap : pctMain), fromA = angle(over ? prevLap : prevMain), dly = over ? (first ? 640 : 0) : first ? 140 : 0;
    cap.style.transformOrigin = `${R / 2}px ${R / 2}px`; cap.style.transform = `rotate(${toA}deg)`;
    cap.style.opacity = (over ? pctLap : pctMain) > 0.5 ? '1' : '0';
    if (canAnim() && Math.abs(toA - fromA) > 1) cap.animate([{ transform: `rotate(${fromA}deg)` }, { transform: `rotate(${toA}deg)` }], { duration: ms, delay: dly, easing: EASE_OUT, fill: 'backwards' });
    if (first && canAnim()) { cap.animate([{ opacity: 0 }, { opacity: 0, offset: 0.2 }, { opacity: 1 }], { duration: ms + dly, easing: 'ease-out' }); dl.litTicks.forEach((ln, i) => ln.animate([{ opacity: 0.1 }, { opacity: 1 }], { duration: 200, delay: 140 + (i / Math.max(1, dl.litTicks.length)) * 860, fill: 'backwards', easing: 'ease-out' })); }
    countUp(pctEl, Math.round(pctRaw), { key: `kp:${key}`, ms: first ? 1000 : 520, fmt: (v) => String(Math.round(v)) });
    numAnim(eatEl, tot.kcal, `ke:${key}`, 0);
    numAnim(leftEl, Math.abs(left), `kl:${key}`, over ? 0 : t.kcal);
  });

  const protHit = t.p > 0 && tot.p >= t.p;
  const macro = (k, label, eaten, target, cls) => {
    const val = h('span'), bar = h('i'), to = target > 0 ? Math.round(target - eaten) : null, done = to != null && to <= 0, good = k === 'p' || k === 'fiber';
    const goTxt = to == null ? '' : !done ? `${fmt(to)} g to go` : good ? 'Done' : `${fmt(-to)} g over`;
    const row = h('div', { class: 'td-macro ' + cls },
      h('div', { class: 'td-macro-top' }, h('span', { class: 'td-macro-name' }, h('i', { class: 'dot ' + cls }), label),
        h('span', { class: 'td-togo' + (done ? (good ? ' hit' : ' over') : '') }, done && good ? h('span', { class: 'td-hit', 'aria-label': 'Target reached' }, icon('check', 11)) : null, goTxt)),
      h('div', { class: 'td-macro-val' }, val, h('small', null, target ? `/ ${fmt(target)} g` : 'g')),
      h('div', { class: 'td-track' }, bar));
    jobs.push(() => {
      const prev = recall(`mv:${k}:${key}`);
      countUp(val, Math.round(eaten), { key: `mv:${k}:${key}`, ms: 750 });
      fill(bar, target ? Math.min(100, (eaten / target) * 100) : 0, { key: `mb:${k}:${key}`, delay: first ? 220 : 0, ms: 750 });
      if (prev != null && prev !== Math.round(eaten)) pulse(val, { scale: 1.14, ms: 380 });
    });
    return row;
  };
  // the first time protein crosses its target this session: a small burst
  const goalKey = 'pgoal:' + key;
  const macrosEl = h('div', { class: 'td-macros' }, macro('p', 'Protein', tot.p, t.p, 'p'), macro('c', 'Carbs', tot.c, t.c, 'c'), macro('f', 'Fat', tot.f, t.f, 'f'), macro('fiber', 'Fibre', tot.fiber, t.fiber, 'fiber'));
  if (isToday && recall(goalKey) === false && protHit) jobs.push(() => { celebrate(macrosEl.querySelector('.td-hit') || macrosEl, { kind: 'goal' }); haptic('success'); });
  if (isToday) remember(goalKey, protHit);
  const hero = h('div', { class: 'card hero fuel td-fuel pressable' + (over ? ' over' : ''), role: 'button', tabindex: '0',
    'aria-label': `Daily target ${fmt(t.kcal)} kcal. Eaten ${fmt(tot.kcal)}. ${fmt(Math.abs(left))} ${over ? 'over' : 'left'}. Tap to see how your targets are set.`,
    onClick: () => targetsSheet(ctx), onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); targetsSheet(ctx); } } },
    h('div', { class: 'td-t-row' }, h('span', { class: 'td-t-l' }, 'Daily target'), h('b', { class: 'num td-t-n' }, fmt(t.kcal)), h('small', { class: 'td-t-u' }, 'kcal')),
    h('div', { class: 'td-fuel-main' }, rg,
      h('div', { class: 'td-eq' },
        h('div', { class: 'td-eq-eaten' }, h('span', { class: 'td-eq-l' }, isToday ? 'Eaten so far' : 'Eaten that day'), h('div', { class: 'num-lg td-eq-n' }, eatEl, h('small', null, 'kcal'))),
        h('div', { class: 'td-eq-left' + (over ? ' over' : '') }, h('span', { class: 'td-eq-l' }, over ? 'Over by' : 'Left to eat'), h('div', { class: 'num-md td-eq-n' }, leftEl, h('small', null, 'kcal'))))),
    macrosEl,
    h('div', { class: 'td-hero-foot' }, h('span', null, 'Sugar ', h('b', { class: 'num' }, Math.round(tot.sugar)), ' g'), h('span', { class: 'td-hero-how' }, 'How your targets are set', icon('right', 14))));
  page.append(hero); rise.push(hero);

  // ---- coach + energy: both sit below the quick-log tiles, because they grow the moment something is logged and anything above the
  // tiles would push the tile that was just tapped (and its Undo minus) off the screen. ----
  const coach = isToday ? coachCard(ctx, key, { fresh: first }) : null;
  if (coach) rise.push(coach);
  const recap = dv ? energyCard(ctx, key, isToday, dv, jobs, first) : null;
  if (recap) rise.push(recap);

  // ---- quick-log tiles: tap = +1, minus removes the last, hold opens the list ----
  const waterOn = trackWater(); // water is an opt-in setting: off means no tile, no line, no mention
  const glassMl = state.settings.glassMl || 250, water = waterOn ? waterMl(key) : 0, glasses = Math.round((water / glassMl) * 10) / 10, goalGlasses = t.water || 8;
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
  if (waterOn) {
    const under = h('div', { class: 'under' });
    jobs.push(() => fill(under, Math.min(100, goalGlasses ? (water / (goalGlasses * glassMl)) * 100 : 0), { axis: 'y', key: `wf:${key}`, ms: 700 }));
    quick.append(tile('water', { cls: 'water', ico: 'drop', label: 'Water', count: glasses, sub: `of ${goalGlasses}`, under, extra: 'td-water-tile',
      onAdd: () => tapWater(key, water, glasses, goalGlasses, glassMl, under), onRemove: () => undoLast(KINDS.water(key)), onOpen: () => countSheet('water', key) }));
  } else {
    // steps take water's place: the tile fills from the bottom as the day's steps approach the goal
    const steps = stepsOn(key), stepGoal = state.settings.stepTarget || 8000, under = h('div', { class: 'under' });
    jobs.push(() => fill(under, Math.min(100, stepGoal ? (steps / stepGoal) * 100 : 0), { axis: 'y', key: `sf:${key}`, ms: 700 }));
    const st = tile('steps', { cls: 'stp', ico: 'steps', label: 'Steps', count: 0, sub: steps ? fmt(steps) : 'Add steps', under, extra: 'td-steps-tile',
      onAdd: () => stepsSheet(ctx, key), onOpen: () => stepsSheet(ctx, key) });
    quick.append(st);
    st.setAttribute('aria-label', steps ? `Steps today: ${fmt(steps)} of ${fmt(stepGoal)}. Tap to edit.` : 'Steps today: none yet. Tap to add.');
    jobs.push(() => { const prev = recall(`sv:${key}`); remember(`sv:${key}`, steps); if (prev != null && prev !== steps) pop(st.querySelector('.sub')); });
  }
  quick.append(tile('weight', { cls: 'weight', ico: 'scale', label: 'Weight', count: 0, sub: wt ? `${n1(wt)} kg` : 'Weigh in', onAdd: () => weightSheet(key, wt || lw?.kg || 70), onOpen: () => weightSheet(key, wt || lw?.kg || 70) }));
  page.append(quick);
  if (p.smoker && cigs && isToday) page.append(h('p', { class: 'td-note' }, `Last cigarette ${Date.now() - (lastHabitTs('cig') || 0) < 60000 ? 'just now' : sinceText(lastHabitTs('cig')) + ' ago'}${lim ? ` · limit ${lim}` : ''}${lim && cigs > lim ? ' · over limit' : ''}`));
  else if ((chai || cigs || water) && !state.settings.todayTileHint) page.append(h('p', { class: 'td-note' }, 'Tap to add one. Tap − to remove the last. Hold a tile to edit.'));
  if (coach) page.append(coach);
  if (recap) page.append(recap);
  if (first && canAnim()) jobs.push(() => tiles.forEach((el, i) => enter(el, 190 + i * 45, 12, 300)));

  // ---- training: the verdict on what was done, or the plan for today ----
  const ws = workoutsOn(key);
  const trainEl = trainingCard(ctx, key, isToday, ws, dv, jobs);
  page.append(trainEl);

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
  if (waterOn && water) {
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
    h('button', { class: 'btn primary', onClick: () => ctx.go('food') }, icon('plus'), 'Add food'),
    h('button', { class: 'btn', onClick: () => openScan(ctx) }, icon('camera'), 'Scan plate')));

  if (first && canAnim()) jobs.push(() => [trainEl, checkin, led].forEach((el, i) => enter(el, 360 + i * 50, 12, 320)));
  if (first && canAnim()) jobs.push(() => rise.forEach((el, i) => enter(el, i * 45, 8, 300)));
  return page;
}

// ---------------------------------------------------------------- shared bits for the verdict pieces
const TONE = { good: 'var(--good)', accent: 'var(--accent)', warn: 'var(--f)', bad: 'var(--bad)' }; // caution tone is the rose token: nothing on Today is yellow
const GRADE = { strong: { word: 'Strong', ico: 'zap', tone: 'good' }, solid: { word: 'Solid', ico: 'check', tone: 'accent' }, light: { word: 'Light', ico: 'leaf', tone: 'warn' } };
const gradePill = (g) => { const m = GRADE[g] || GRADE.solid; return h('span', { class: 'td-grade ' + g }, icon(m.ico, 15), m.word); };
const signed = (n, unit = '') => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt(Math.abs(n))}${unit}`;
// a leading icon in a coloured disc, then one short sentence
const noteRow = (ico, tone, text) => h('li', null, h('span', { class: 'ic ' + tone }, icon(ico, 13)), h('span', { class: 'tx' }, text));

// ---------------------------------------------------------------- training card
function trainingCard(ctx, key, isToday, ws, dv, jobs) {
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
    const verdicts = new Map((dv?.sessions || []).map((s) => [s.id, s.verdict]));
    ws.forEach((w, i) => {
      const v = verdicts.get(w.id) || null;
      const stat = (val, l) => h('div', { class: 'td-stat' }, h('div', { class: 'num-sm' }, val), h('div', { class: 'micro muted' }, l));
      const pill = v ? gradePill(v.grade) : null;
      const top = h('div', { class: 'td-train-top' }, h('span', { class: 'well good lg' }, icon('check')),
        h('div', { class: 'grow' }, h('h3', { class: 'ellipsis' }, w.name || 'Workout'), h('div', { class: 'td-done-sub small muted' }, h('span', { class: 'nowrap' }, `Done ${fmtTime(w.end || w.start)}`), w.prs?.length ? h('span', { class: 'pr-tag nowrap' }, icon('trophy', 12), `${w.prs.length} PR${w.prs.length > 1 ? 's' : ''}`) : null)),
        pill);
      const notes = v ? [v.wins[0] ? noteRow('check', 'good', v.wins[0]) : null, v.improve[0] ? noteRow('arrowUp', 'warn', v.improve[0]) : null].filter(Boolean) : [];
      card.append(h('div', { class: 'td-done' + (i ? ' next' : '') }, top,
        h('div', { class: 'td-stats' }, stat(fmtDur((w.end - w.start) / 1000), 'time'), stat(fmt(w.volume), 'kg lifted'), stat(fmt(w.kcal), 'kcal burned')),
        notes.length ? h('ul', { class: 'td-rl' }, notes) : null,
        h('div', { class: 'td-train-act' }, h('button', { class: 'btn sm', onClick: () => (v ? verdictSheet(ctx, w, v) : ctx.go('train')) }, v ? 'See details' : 'View in Train', icon('right', 16)))));
      // the pill pops once, when the workout has just been finished
      if (pill) { const gk = 'gp:' + w.id; if (!seen(gk)) { remember(gk, true); if (Date.now() - (w.end || w.start) < 10 * 60e3) jobs.push(() => pop(pill)); } }
    });
    return card;
  }
  let plan = null;
  if (isToday) { try { plan = todayPlan(); } catch (e) { plan = null; } }
  if (!isToday) {
    card.append(h('div', { class: 'td-train-top' }, h('span', { class: 'well sleep lg' }, icon('moon')), h('div', { class: 'grow' }, h('h3', null, 'Rest day'), h('div', { class: 'small muted' }, 'Nothing was trained this day.'))));
    return card;
  }
  // the text takes the full width beside the icon and the action sits on its own row, so "Last trained: Pull · yesterday" never wraps beside a button
  const act = (btn) => h('div', { class: 'td-train-act' }, btn);
  if (plan && plan.kind === 'train') {
    card.append(h('div', { class: 'td-train-top' }, h('span', { class: 'well train lg' }, icon('dumbbell')),
      h('div', { class: 'grow' }, h('h3', null, `${plan.dayName}: you usually train`), h('div', { class: 'small muted' }, `${plan.hits} of the last ${plan.weeksObserved} ${plan.dayName}s`))),
      h('div', { class: 'td-groups' }, plan.groups.map(groupChip)),
      act(h('button', { class: 'btn primary', onClick: () => ctx.go('train') }, icon('play', 18), 'Start workout')));
    return card;
  }
  if (plan && plan.kind === 'rest') {
    card.classList.add('td-rest');
    card.append(h('div', { class: 'td-train-top' }, h('span', { class: 'well sleep lg' }, icon('moon')),
      h('div', { class: 'grow' }, h('h3', null, 'Rest day'), h('div', { class: 'small muted' }, 'Your usual rest day. Recovery builds muscle.'))),
      act(h('button', { class: 'btn sm', onClick: () => ctx.go('train') }, 'Train anyway')));
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
    h('div', { class: 'grow' }, h('h3', null, 'No workout yet'), bits.length ? bits.map((b) => h('div', { class: 'small muted' }, b)) : h('div', { class: 'small muted' }, 'Log sets, reps and weight. The app remembers last time.'))),
    act(h('button', { class: 'btn primary', onClick: () => ctx.go('train') }, icon('play', 18), dayPlan ? `Start ${dayPlan.name}` : 'Start workout')));
  return card;
}

// Everything about one finished session: score, wins, what to improve, the comparison and sets per muscle group.
function verdictSheet(ctx, w, v) {
  const m = GRADE[v.grade] || GRADE.solid, s = v.stats, cmp = v.compare;
  const rg = ring({ size: 84, stroke: 9, pct: v.score, color: TONE[m.tone], cls: 'td-score', children: [h('span', { class: 'td-vs-n' }, String(v.score))] });
  const when = `${fmtDateLabel(dateKey(new Date(w.start)), ctx.today)}, ${fmtTime(w.start)}`;
  const stat = (val, l) => h('div', { class: 'td-vs-stat' }, h('b', null, val), h('span', null, l));
  const section = (title, body) => h('section', { class: 'td-vs-sec' }, h('h3', null, title), body);
  const body = h('div', { class: 'td-vs' },
    h('div', { class: 'td-vs-hero' }, rg, h('div', { class: 'grow' }, gradePill(v.grade), h('div', { class: 'td-vs-head' }, v.headline), h('div', { class: 'small muted' }, `${when}${s.mins != null ? ` · ${s.mins} min` : ''}`))),
    h('div', { class: 'td-vs-stats' }, stat(`${s.sets}${s.planned && s.planned !== s.sets ? `/${s.planned}` : ''}`, 'sets'), stat(fmt(s.volume), 'kg lifted'), stat(s.mins != null ? String(s.mins) : '–', 'minutes'), stat(String(s.prs), s.prs === 1 ? 'PR' : 'PRs')),
    v.wins.length ? section('What went well', h('ul', { class: 'td-rl' }, v.wins.map((t) => noteRow('check', 'good', t)))) : null,
    section('To improve', v.improve.length ? h('ul', { class: 'td-rl' }, v.improve.map((t) => noteRow('arrowUp', 'warn', t))) : h('p', { class: 'small muted' }, 'Nothing to fix. Repeat this next time.')));
  if (cmp) {
    const mx = Math.max(s.volume, cmp.volume, 1), up = cmp.volumeDelta >= 3, down = cmp.volumeDelta <= -10;
    const tracks = [[w.name || 'This session', s.volume, 'now'], [`${cmp.name}, ${fmtShortDate(cmp.date)}`, cmp.volume, 'then']];
    const rows = tracks.map(([l, val, cls]) => { const i = h('i', { class: cls }); setTimeout(() => fill(i, (val / mx) * 100, { key: `vc:${w.id}:${cls}`, ms: 700 }), 200); return h('div', { class: 'td-cmp-row' }, h('span', { class: 'td-cmp-l ellipsis' }, l), h('div', { class: 'td-cmp-t' }, i), h('b', null, fmt(val))); });
    body.append(section(`vs ${cmp.name}, ${fmtShortDate(cmp.date)}`, h('div', { class: 'stack td-cmp' },
      h('div', { class: 'td-cmp-chips' }, h('span', { class: 'pill ' + (up ? 'good' : down ? 'bad' : '') }, icon(up ? 'trendUp' : down ? 'trendDown' : 'arrowRight', 14), `volume ${signed(cmp.volumeDelta)} %`), h('span', { class: 'pill' }, cmp.setsDelta ? `${signed(cmp.setsDelta)} set${Math.abs(cmp.setsDelta) === 1 ? '' : 's'}` : 'same sets')),
      h('div', { class: 'td-cmp-rows' }, rows), h('div', { class: 'micro muted' }, 'Volume in kg, sets times reps times weight.'))));
  }
  const groups = Object.entries(s.groups || {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (groups.length) {
    const top = groups[0][1];
    body.append(section('Sets per muscle group', h('div', { class: 'stack' }, h('div', { class: 'td-gb' }, groups.map(([g, n], i) => { const bar = h('i'); setTimeout(() => fill(bar, (n / top) * 100, { key: `vg:${w.id}:${g}`, delay: i * 40, ms: 600 }), 200); return setVar(h('div', { class: 'td-gb-row' }, h('span', { class: 'td-gb-n' }, h('i', { class: 'dot' }), g), h('div', { class: 'td-cmp-t' }, bar), h('b', null, String(n))), '--g', `var(${GROUP_VAR[g] || '--muted'})`); })), h('div', { class: 'micro muted' }, 'Helper muscles count half, so a group can add up to more than your sets.'))));
  }
  const api = sheet({ title: w.name || 'Workout', content: body, actions: (a) => [h('button', { class: 'btn', onClick: a.close }, 'Done'), h('button', { class: 'btn primary', onClick: () => { a.close(); ctx.go('train'); } }, 'Open in Train')] });
  setTimeout(() => fill(rg.fillEl, v.score, { axis: 'ring', key: `vs:${w.id}`, ms: 850 }), 160);
  return api;
}

// ---------------------------------------------------------------- energy: eaten, burned (and why), balance, then the day score
const scoreWord = (s, done) => (s >= 80 ? 'Strong' : s >= 60 ? 'Solid' : s >= 40 ? (done ? 'Fair' : 'Building') : done ? 'Light' : 'Early');
const scoreTone = (s) => (s >= 75 ? 'good' : s >= 45 ? 'accent' : 'warn');
const WORD_ICO = { good: 'zap', accent: 'check', warn: 'leaf' };
// Is this balance what the user is after? Cutting wants a deficit, bulking a surplus, maintaining stays close to even.
function netTone(net, goal) {
  const g = String(goal || 'cut');
  if (g.startsWith('cut')) return net <= 0 ? 'good' : net < 300 ? 'warn' : 'bad';
  if (g === 'bulk') return net >= 0 ? 'good' : net > -300 ? 'warn' : 'bad';
  return Math.abs(net) < 250 ? 'good' : 'warn';
}
// the verdict's sentences, each with the icon that says what it is about
function lineKind(s) {
  if (/^(Strong|Solid|Light) session/.test(s)) return ['dumbbell', 'train'];
  if (/^No training/.test(s)) return ['moon', 'rest'];
  if (/^Protein/.test(s)) return /hit/.test(s) ? ['check', 'good'] : ['target', 'warn'];
  return ['info', 'info'];
}

function energyCard(ctx, key, isToday, dv, jobs, first) {
  const hour = new Date().getHours(), eve = !isToday || hour >= 20; // after 8 pm, or looking back at a finished day
  const bare = !dv.items && !dv.steps && !dv.sessions.length;
  if (bare && !isToday) return null;
  const b = dv.burn, tone = scoreTone(dv.score), word = bare ? (eve ? 'Nothing logged' : 'Not started') : scoreWord(dv.score, eve);
  const k = (n) => `rc:${n}:${key}`, d0 = first ? 160 : 0, so = isToday ? ' so far' : '';
  const card = h('div', { class: 'card td-recap td-energy' + (eve ? ' eve' : '') + (bare ? ' bare' : '') });
  const hrs = Math.max(1, Math.floor(b.dayFrac * 24 + 0.01));

  card.append(h('div', { class: 'td-rc-head' },
    h('div', { class: 'grow' }, h('h3', null, isToday ? 'Energy today' : 'Energy that day'), h('div', { class: 'td-en-sub' }, 'Calories you ate against calories you burned')),
    dv.partial ? h('span', { class: 'pill accent nowrap' }, 'Partly logged') : null));

  // eaten − burned = balance: three numbers, each with what it is
  if (!bare) {
    const noFood = !dv.items, net = dv.net, nt = noFood ? '' : netTone(net, state.profile?.goal);
    const sgn = (v) => { const r = Math.round(v); return (r < 0 ? '−' : r > 0 ? '+' : '') + fmt(Math.abs(r)); };
    const inEl = h('b', { class: 'td-fl-n' }, fmt(dv.intake)), outEl = h('b', { class: 'td-fl-n' }, fmt(b.total)), netEl = h('b', { class: 'td-fl-n' }, noFood ? '–' : sgn(net));
    const col = (cls, label, valEl, sub) => h('div', { class: 'td-fl ' + cls }, h('span', { class: 'td-fl-l' }, label), valEl, sub);
    const op = (g) => h('span', { class: 'td-fa', 'aria-hidden': 'true' }, g);
    const netSub = h('span', { class: 'td-fl-s' }, noFood ? 'log food' : Math.abs(net) < 25 ? 'about even' : [icon(net < 0 ? 'arrowDown' : 'arrowUp', 12), net < 0 ? 'deficit' : 'surplus']);
    card.append(h('div', { class: 'td-flow', role: 'group', 'aria-label': noFood ? `Burned about ${fmt(b.total)} kcal${so}` : `Eaten ${fmt(dv.intake)} kcal, burned ${fmt(b.total)}${so}, balance ${sgn(net)}` },
      col('in', 'Eaten', inEl, h('span', { class: 'td-fl-s' }, 'kcal in')), op(icon('minus', 14)), col('out', 'Burned' + so, outEl, h('span', { class: 'td-fl-s' }, 'kcal out')), op('='), col('net ' + nt, 'Balance' + so, netEl, netSub)));
    jobs.push(() => {
      countUp(inEl, dv.intake, { key: k('in'), ms: 750, fmt }); countUp(outEl, b.total, { key: k('out'), ms: 750, fmt });
      if (!noFood) countUp(netEl, net, { key: k('net'), ms: 750, fmt: sgn }); else remember(k('net'), 0);
    });
  } else {
    card.append(h('p', { class: 'td-en-bare' }, isToday ? `Nothing eaten yet. Your body has burned about ${fmt(b.total)} kcal at rest so far today.` : 'Nothing was logged this day.'));
  }

  // where the burned number comes from: resting + walking + training, as one bar and three plain rows
  if (!bare || b.steps || b.workouts) {
    const mx = Math.max(b.total, 1), seg = (cls) => h('i', { class: cls }), bR = seg('r'), bW = seg('w'), bT = seg('t');
    const sp = dv.stepGoal ? Math.min(100, (dv.steps / dv.stepGoal) * 100) : 0, sBar = h('i');
    const trained = dv.sessions.map((x) => x.name).filter(Boolean).join(', ');
    const dot = (cls) => h('i', { class: 'td-bk-dot ' + cls });
    const row = (cls, label, val, sub, extra) => [dot(cls), h('div', { class: 'td-bk-t' }, h('span', { class: 'td-bk-l' }, label), h('span', { class: 'td-bk-s' }, sub), extra || null), h('b', { class: 'td-bk-n' }, fmt(val))];
    card.append(h('div', { class: 'td-bk' },
      h('div', { class: 'td-bk-bar', 'aria-hidden': 'true' }, h('div', { class: 'td-bar-t' }, bR, bW, bT)),
      h('div', { class: 'td-bk-row' }, row('r', 'Resting', b.resting, isToday ? `your body at rest, ${hrs} of 24 h` : 'your body at rest, all 24 h')),
      h('button', { class: 'td-bk-row td-bk-tap td-r-steps', 'aria-label': dv.steps ? `Walking ${fmt(b.steps)} kcal from ${fmt(dv.steps)} of ${fmt(dv.stepGoal)} steps. Tap to edit.` : 'Walking 0 kcal. Add your steps for the day.', onClick: () => stepsSheet(ctx, key) },
        row('w', 'Walking', b.steps, dv.steps ? `${fmt(dv.steps)} steps, ${Math.round(sp)}% of ${fmt(dv.stepGoal)}` : 'add steps', dv.steps ? h('div', { class: 'td-track stp' }, sBar) : null), h('span', { class: 'td-r-go', 'aria-hidden': 'true' }, icon('right', 16))),
      h('div', { class: 'td-bk-row' }, row('t', 'Training', b.workouts, dv.sessions.length ? trained : isToday ? 'no workout yet' : 'no workout')),
      b.everyday > 0 ? h('div', { class: 'td-bk-row' }, row('e', 'Everyday movement', b.everyday, 'estimate from your activity level, until you add steps')) : null));
    jobs.push(() => { const pc = (v) => (v / mx) * 100, o = { ms: 650, delay: d0 }; fill(bR, pc(b.resting), { ...o, key: k('br') }); fill(bW, pc(b.steps), { ...o, key: k('bw'), delay: d0 + 90 }); fill(bT, pc(b.workouts), { ...o, key: k('bt'), delay: d0 + 180 }); fill(sBar, sp, { key: k('st'), ms: 650, delay: d0 }); });
    card.append(h('p', { class: 'td-rc-note' }, isToday
      ? `Burned so far = resting burn for the hours passed today + walking${b.everyday > 0 ? ' (estimated until you add steps)' : ''} + training. By midnight resting reaches ${fmt(b.restingFull)}.`
      : `Burned = resting burn for the full day + walking${b.everyday > 0 ? ' (estimated)' : ''} + training.`));
  }

  // the day score, then the sentences
  if (!bare) {
    const scoreEl = h('span', { class: 'td-score-n' }, String(dv.score));
    const rg = ring({ size: eve ? 70 : 62, stroke: 7, pct: dv.score, color: TONE[tone], cls: 'td-score', children: [scoreEl] });
    rg.setAttribute('role', 'img'); rg.setAttribute('aria-label', `Day score ${dv.score} out of 100, ${word}`);
    card.append(h('div', { class: 'td-sc' }, rg, h('div', { class: 'grow' }, h('div', { class: 'td-rc-sub' }, h('span', { class: 'td-word ' + tone }, icon(WORD_ICO[tone], 14), word), h('span', { class: 'small muted' }, 'day score')),
      h('div', { class: 'micro muted td-sc-how' }, dv.scoreParts ? `Out of 100: protein ${dv.scoreParts.protein}/${dv.scoreMax.protein}, calories ${dv.scoreParts.calories}/${dv.scoreMax.calories}, training ${dv.scoreParts.training}/${dv.scoreMax.training}, steps ${dv.scoreParts.steps}/${dv.scoreMax.steps}.` : 'Out of 100: protein, calories near target, training and steps.'))));
    jobs.push(() => { const prev = recall(`dsn:${key}`); fill(rg.fillEl, dv.score, { axis: 'ring', key: `ds:${key}`, ms: 900, delay: d0 }); countUp(scoreEl, dv.score, { key: `dsn:${key}`, ms: 900 }); if (prev != null && prev !== dv.score) pulse(rg, { scale: 1.08, ms: 360 }); });
    // the energy sentence repeats the three numbers above; the session sentence repeats the training card below; the protein shortfall is in the hero and the coach
    const lines = (dv.lines || []).filter((l) => !/kcal in, about/.test(l) && !(dv.sessions.length && /^(Strong|Solid|Light) session/.test(l)) && !(isToday && /^Protein \d+ g short/.test(l)));
    if (lines.length) card.append(h('ul', { class: 'td-rl' }, lines.map((l) => { const [ico, cls] = lineKind(l); return noteRow(ico, cls, l); })));
  }

  if (eve) { const wk = weekStrip(key, jobs); if (wk) card.append(wk); }
  return card;
}

// Last 7 days of day scores as small bars ending on the day being viewed.
function weekStrip(key, jobs) {
  let wk; try { wk = weekVerdict(key); } catch (e) { console.error(e); return null; }
  const has = (d) => !!(d.items || d.sessions.length || d.steps), have = wk.days.filter(has);
  if (!have.length) return null;
  const avg = Math.round(have.reduce((a, d) => a + d.score, 0) / have.length);
  const cols = wk.days.map((d, i) => {
    const on = has(d), bar = h('i', { class: on ? scoreTone(d.score) : '' });
    jobs.push(() => fill(bar, on ? Math.max(8, d.score) : 0, { axis: 'y', key: `wk:${i}:${key}`, ms: 620, delay: i * 40 }));
    return h('div', { class: 'td-wk-col' + (d.key === key ? ' on' : '') + (on ? '' : ' none'), 'aria-label': `${fmtDateLabel(d.key, dateKey())}: ${on ? 'score ' + d.score : 'nothing logged'}` },
      h('span', { class: 'td-wk-n' }, on ? String(d.score) : '–'), h('div', { class: 'td-wk-t' }, bar), h('span', { class: 'td-wk-d' }, fmtDow(d.key)[0]));
  });
  return h('div', { class: 'td-wk' },
    h('div', { class: 'td-wk-h' }, h('h3', null, 'Last 7 days'), h('span', { class: 'small muted nowrap' }, `average ${avg}`)),
    h('div', { class: 'td-wk-bars' }, cols),
    h('div', { class: 'td-pills' }, h('span', { class: 'pill' }, `${wk.sessions} session${wk.sessions === 1 ? '' : 's'}`), h('span', { class: 'pill p' }, `Protein hit on ${wk.proteinDays} of ${wk.loggedDays} logged days`)));
}

// ---------------------------------------------------------------- steps
// First number in a piece of text: "6,500", "6 500", "6532.0" or "Steps: 6532 today". Null when there is none, or it cannot be a step count.
function parseSteps(text) {
  const m = String(text ?? '').match(/\d{1,3}(?:[ ,  ]\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Math.round(parseFloat(m[0].replace(/[ ,  ]/g, '')));
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? n : null;
}
const SHORTCUT_URL = 'https://shivamsahugzp.github.io/shredlog/#today?steps=';

// "#today?steps=6500" from an iPhone Shortcut: save it for today, once per hand-off.
function takeShortcutSteps(ctx) {
  const p = ctx.params;
  if (!p || p.steps == null || shortcutSeen.has(p)) return null;
  shortcutSeen.add(p);
  const n = parseSteps(p.steps);
  if (n == null) { toast('Steps from Shortcut were not a number.', { ms: 3600 }); return null; }
  const key = ctx.today, prev = stepsOn(key), goal = state.settings.stepTarget || 8000;
  setSteps(key, n);
  return { n, prev, key, goal };
}
function afterShortcutSteps({ n, prev, key, goal }) {
  haptic('success');
  toast(`Steps from Shortcut: ${fmt(n)}`, { undo: () => setSteps(key, prev || 0), kind: 'success' });
  if (n >= goal && prev < goal) setTimeout(() => { celebrate(document.querySelector('.td-steps-tile, .td-r-steps'), { kind: 'goal' }); haptic('success'); }, 450);
}

function stepsSheet(ctx, key) {
  const isToday = key === ctx.today, goal = state.settings.stepTarget || 8000, prev = stepsOn(key);
  const kg = dayIfAny(key)?.weight || state.profile?.weightKg || 70;
  const everLogged = lastNDays(30, ctx.today).some((d) => stepsOn(d) > 0);
  const input = h('input', { class: 'td-steps-in', type: 'number', inputmode: 'numeric', enterkeyhint: 'done', min: '0', max: '100000', step: '1', placeholder: '0', 'aria-label': 'Steps', value: prev ? String(prev) : '' });
  const read = () => { const n = parseInt(input.value, 10); return Number.isFinite(n) && n > 0 ? Math.min(n, 100000) : 0; };
  const kcalEl = h('b', null), pctEl = h('span', { class: 'small muted' }), bar = h('i'), prevBox = h('div', { class: 'td-ss-prev' }, h('div', { class: 'td-ss-prev-top' }, kcalEl, pctEl), h('div', { class: 'td-track stp' }, bar));
  const paint = () => {
    const n = read(), pc = Math.min(100, (n / goal) * 100);
    kcalEl.textContent = n ? `about ${fmt(stepsKcal(n, kg))} kcal walked` : 'Enter your steps for the day';
    pctEl.textContent = n ? `${Math.round((n / goal) * 100)}% of ${fmt(goal)}` : `Goal ${fmt(goal)}`;
    fill(bar, pc, { key: `ss:${key}`, ms: 380 });
  };
  input.addEventListener('input', paint); input.addEventListener('focus', () => input.select());
  const setTo = (n) => { input.value = n ? String(Math.min(100000, n)) : ''; paint(); pulse(input, { scale: 1.04, ms: 260 }); };
  // the clipboard is read inside the tap itself, which is the only place iOS allows it
  const paste = () => {
    haptic();
    let p;
    try { p = navigator.clipboard && navigator.clipboard.readText ? navigator.clipboard.readText() : Promise.reject(new Error('no clipboard')); } catch (e) { p = Promise.reject(e); }
    p.then((t) => {
      const n = parseSteps(t);
      if (n == null || !n) { toast('No step count on the clipboard.', { ms: 3200 }); input.focus(); return; }
      setTo(n); haptic('success'); toast(`Pasted ${fmt(n)} steps. Tap Save steps.`);
    }).catch(() => { toast('Clipboard blocked. Hold the field to paste.', { ms: 3600 }); input.focus(); });
  };
  const chip = (label, aria, fn) => h('button', { type: 'button', class: 'chip', 'aria-label': aria, onClick: () => { haptic(); fn(); } }, label);
  const quick = h('div', { class: 'td-sq' }, chip('+1k', 'Add 1,000 steps', () => setTo(read() + 1000)), chip('+2k', 'Add 2,000 steps', () => setTo(read() + 2000)),
    chip('5k', 'Set 5,000 steps', () => setTo(5000)), chip('8k', 'Set 8,000 steps', () => setTo(8000)), chip('10k', 'Set 10,000 steps', () => setTo(10000)));

  // the automatic route: an iPhone Shortcut reads Health once a day and hands the number over
  const node = (ico, label) => h('div', { class: 'td-fn' }, h('span', { class: 'well' }, icon(ico, 20)), h('span', { class: 'td-fn-l' }, label));
  const fa = () => h('span', { class: 'td-fa', 'aria-hidden': 'true' }, icon('arrowRight', 14));
  const copyLink = () => { try { navigator.clipboard.writeText(SHORTCUT_URL).then(() => toast('Link copied. Paste it into Open URL.'), () => toast('Could not copy. Select it by hand.')); } catch (e) { toast('Could not copy. Select it by hand.'); } };
  const setup = h('div', { class: 'td-setup' + (everLogged ? '' : ' open') });
  const head = h('button', { type: 'button', class: 'td-setup-h', 'aria-expanded': everLogged ? 'false' : 'true', onClick: () => { const o = setup.classList.toggle('open'); head.setAttribute('aria-expanded', o ? 'true' : 'false'); } },
    h('span', { class: 'well good' }, icon('footprints')), h('div', { class: 'grow' }, h('b', null, 'Set up automatic steps'), h('div', { class: 'micro muted' }, 'Once, about two minutes')), h('span', { class: 'chev', 'aria-hidden': 'true' }, icon('down', 18)));
  setup.append(head, h('div', { class: 'td-setup-b' },
    h('div', { class: 'td-fg', 'aria-hidden': 'true' }, node('clock', '9:30 pm'), fa(), node('heartbeat', 'Steps sum'), fa(), node('copy', 'Clipboard'), fa(), node('steps', 'ShredLog')),
    h('ol', { class: 'td-su' },
      h('li', null, 'Open the Shortcuts app, tap Automation, then the plus button.'),
      h('li', null, 'Choose Time of Day, for example 9:30 pm, repeat Daily, and Run Immediately.'),
      h('li', null, 'Add Find Health Samples: Type Steps, Start Date is Today. Then total them with Sum.'),
      h('li', null, 'Add Copy to Clipboard with that total.'),
      h('li', { class: 'opt' }, h('span', null, h('b', null, 'Optional: '), 'add Open URL with the link below and put the total right after the equals sign. ShredLog then opens with your steps already saved.')),
      h('li', null, 'No link? Open ShredLog, tap Steps, then Paste. One tap fills it in.')),
    h('div', { class: 'td-url' }, h('code', null, 'https://shivamsahugzp.github.io/', h('wbr'), 'shredlog/', h('wbr'), '#today?steps='), h('button', { type: 'button', class: 'icon-btn plain', 'aria-label': 'Copy the link', onClick: copyLink }, icon('copy'))),
    h('div', { class: 'callout info small' }, icon('info'), h('div', null, 'A web app cannot read Apple Health by itself. A Shortcut can, so this is the closest to automatic: it hands the number over, ShredLog never sees the rest of Health.'))));

  const body = h('div', { class: 'td-ss' },
    h('div', { class: 'td-ss-field' }, input, h('button', { type: 'button', class: 'btn td-ss-paste', onClick: paste }, icon('clipboard', 20), 'Paste')),
    prevBox, quick, setup);
  paint();
  const api = sheet({ title: isToday ? 'Steps today' : `Steps, ${fmtDateLabel(key, ctx.today)}`, content: body,
    actions: (a) => [prev ? h('button', { class: 'btn', onClick: () => { a.close(); haptic('warn'); setSteps(key, 0); toast('Steps cleared', { undo: () => setSteps(key, prev) }); } }, 'Clear') : h('button', { class: 'btn', onClick: a.close }, 'Cancel'),
      h('button', { class: 'btn primary', onClick: () => {
        const n = read(); a.close(); haptic('success'); setSteps(key, n);
        toast(n ? `Steps saved: ${fmt(n)}` : 'Steps cleared', { undo: () => setSteps(key, prev) });
        if (n >= goal && prev < goal) setTimeout(() => { celebrate(document.querySelector('.td-steps-tile, .td-r-steps'), { kind: 'goal' }); haptic('success'); }, 420);
      } }, 'Save steps')] });
  return api;
}

// ---------------------------------------------------------------- ledger
function ledgerRow(it, key, ctx, gap) {
  const { type, e } = it;
  let name, meta, kcal, sub, tl, onDelete = null;
  if (type === 'food' || type === 'chai') {
    name = tidyName(e.name); meta = `${servingText(e)}${e.oilTsp ? ` · +${e.oilTsp} tsp oil` : ''} · P ${Math.round(e.p)} g`; kcal = fmt(e.kcal); sub = 'kcal'; tl = cap(e.meal);
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
  if (type !== 'cig') s.el.querySelector('.sheet-body').append(h('p', { class: 'small muted', style: { marginTop: '10px' } }, `${servingText(e)}${e.g > 0 ? ` (${Math.round(e.g)} g)` : ''} · ${e.meal} · ${fmtTime(e.ts)}${e.fiber || e.sugar ? ` · fibre ${Math.round(e.fiber || 0)} g · sugar ${Math.round(e.sugar || 0)} g` : ''}`));
}

// ---------------------------------------------------------------- quick logging
// A tap on a past day belongs to that day: stamp it at noon, never with the moment of the tap (which would also reset "since last cigarette").
const past = (key) => (key === dateKey() ? {} : { ts: new Date(key + 'T12:00:00').getTime() });
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
    label: (e) => e.name, sub: (e) => `${Math.round(e.kcal)} kcal`, del: (e) => removeFood(key, e.id), put: (c) => logFood(key, c), add: () => { const f = chaiFields(); return f ? logFood(key, { ...f, ...past(key) }) : null; }, count: () => chaiEntries(key).length }),
  cig: (key) => ({ key, noun: 'cigarette', title: 'Cigarettes', ico: 'cig', cls: 'cig', unit: 1, val: () => 1, list: () => habitEntries(key, 'cig').sort((a, b) => a.ts - b.ts),
    label: () => 'Cigarette', sub: (e) => e.note || '', del: (e) => removeHabit(key, e.id), put: (c) => logHabit(key, 'cig', c), add: () => logHabit(key, 'cig', past(key)), count: () => habitCount(key, 'cig') }),
  water: (key) => { const g = state.settings.glassMl || 250; return { key, noun: 'water', title: 'Water', ico: 'drop', cls: 'water', unit: g, val: (e) => e.ml || g, list: () => habitEntries(key, 'water').sort((a, b) => a.ts - b.ts),
    label: (e) => `${e.ml || g} ml`, sub: () => '', del: (e) => removeHabit(key, e.id), put: (c) => logHabit(key, 'water', c), add: (need) => logHabit(key, 'water', { ml: Math.round(need || g), ...past(key) }), count: () => Math.round(waterMl(key) / g) }; },
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
  const e = logFood(key, { ...f, ...past(key) }); haptic();
  toast(`Chai ${chaiCount(key)} today · ${Math.round(e.kcal)} kcal`, { undo: () => removeFood(key, e.id) });
}
function tapCig(key) {
  const e = logHabit(key, 'cig', past(key)); haptic();
  const n = habitCount(key, 'cig'), lim = state.targets?.cigLimit;
  toast(`Cigarette ${n} today${lim ? ` · limit ${lim}` : ''}`, { undo: () => removeHabit(key, e.id) });
}
function tapWater(key, water, glasses, goalGlasses, glassMl, under) {
  const e = logHabit(key, 'water', { ml: glassMl, ...past(key) }); haptic();
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
