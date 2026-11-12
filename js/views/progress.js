// Progress: four sub-views (Weight, Food, Training, Habits) behind a sticky segmented nav.
// Verdicts (js/verdict.js) surface here: an Energy card (in vs out) on Weight and Food, session grades and a week summary on Training, steps on Habits.
// All insight logic still comes from insights.js / calc.js; this file only lays it out.
import { state, dayIfAny, dayTotals, intakeByDate, weights, lastNDays, shiftDate, parseKey, dateKey, setTargets, exerciseHistory, bestFor, findExercise, habitByDate, habitCount, chaiCount, waterMl, trackWater, stepsOn } from '../state.js';
import { dayVerdict, sessionVerdict, weekVerdict, stepsKcal } from '../verdict.js';
import { adaptiveTdee, trendWeights, tdee, GOALS, bmi, e1rm, workoutVolume, cigStats } from '../calc.js';
import { weightInsight, nutritionGaps, budgetProtein, volumeByGroup, volumeStatus, recoveryByGroup, deloadAdvice, suggestDay, nextSuggestion } from '../insights.js';
import { lineChart, barChart, stackedBarChart, legend, sparkline } from '../charts.js';
import { h, icon, ring, toast, confirmSheet, segmented, chips, emptyState, fmt, fmtShortDate, fmtDow, fmtDateLabel, clear } from '../ui.js';
import { countUp, pop, quiet, stagger, fill, remember, canIntro, EASE_OUT } from '../motion.js';

const SUBS = [{ id: 'weight', label: 'Weight' }, { id: 'food', label: 'Food' }, { id: 'train', label: 'Training' }, { id: 'habits', label: 'Habits' }];
const RANGES = [{ id: '14', label: '2 w' }, { id: '28', label: '4 w' }, { id: '90', label: '3 m' }];
const RANGE_NAME = { 14: '2 weeks', 28: '4 weeks', 90: '3 months' };
let sub = 'weight';      // survive tab switches
let rangeDays = 28;
const openMicros = new Set(); // expanded <details> survive redraws
const openE1 = new Set();
let showAllProtein = false;
let jobs = [];          // motion work queued while building, run once the new DOM is attached
const MINUS = '−';

export function render(container, ctx) {
  const root = h('div', { class: 'pg' });
  const head = h('div', { class: 'screen-head' }, h('div', null, h('h1', null, 'Progress'), h('div', { class: 'sub' }, 'Trends, gaps and what to do next')));
  const body = h('div', { class: 'pg-body' });
  const seg = segmented(SUBS, sub, (id) => { sub = id; paint(true, true); }, 'accent');
  // segmented() leaves --n/--i at their CSS defaults on first paint (custom properties cannot go through el.style[...]); set them here
  seg.style.setProperty('--n', String(SUBS.length)); seg.style.setProperty('--i', String(SUBS.findIndex((o) => o.id === sub)));
  const nav = h('div', { class: 'pg-nav glass' }, seg);
  root.append(head, nav, body);
  container.append(root);
  let drawn = false;
  // intro: replay the chart draw-in (first open, range change, sub-view change). Data-change redraws are quiet.
  const paint = (intro, switched) => {
    const y = window.scrollY;
    jobs = [];
    const make = () => build(ctx, () => paint(true));
    const kids = intro ? make() : quiet(make);
    clear(body); body.append(...kids);
    if (switched) { const top = head.getBoundingClientRect().bottom + window.scrollY - 6; if (window.scrollY > top) window.scrollTo(0, top); }
    else if (y) window.scrollTo(0, y);
    grow(body, intro);
    for (const j of jobs) { try { j(); } catch (e) { console.error(e); } }
    if (intro) stagger(body, { key: 'pg-' + sub });
    drawn = true;
  };
  paintAgain = () => paint(false);
  paint(true);
  return () => paint(false);
}

// bars, rings and sweeps marked in the DOM: intro draws replay from zero, quiet redraws only move what changed
function grow(root, intro) {
  const on = canIntro();
  root.querySelectorAll('[data-grow]').forEach((el, i) => {
    const key = `pg:${sub}:g${i}`, pct = parseFloat(el.style.width);
    if (isNaN(pct)) return;
    if (intro) remember(key, 0);
    fill(el, pct, { key, delay: Math.min(i * 35, 280), ms: 520 });
  });
  root.querySelectorAll('[data-growy]').forEach((el, i) => {
    const key = `pg:${sub}:y${i}`, pct = parseFloat(el.style.height);
    if (isNaN(pct)) return;
    if (intro) remember(key, 0);
    fill(el, pct, { key, axis: 'y', delay: Math.min(i * 30, 240), ms: 480 });
  });
  if (!intro || !on) return;
  root.querySelectorAll('[data-sweep]').forEach((el, i) => {
    el.style.transformOrigin = '0 50%';
    el.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 560, delay: 80 + i * 60, easing: EASE_OUT, fill: 'backwards' });
  });
}

// ---------- small helpers ----------
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const num1 = (v) => String(+(+v).toFixed(1));
const signed = (v, d = 1) => { const r = +(+v).toFixed(d); return r === 0 ? '0' : (r > 0 ? '+' : MINUS) + Math.abs(r); };
const clampPct = (v) => Math.max(0, Math.min(100, v * 100));
const niceName = (n) => cap(String(n || '')).replace(/^Vitamin ([a-z]\d*)$/i, (_, x) => 'Vitamin ' + x.toUpperCase());
const pill = (cls, ...kids) => h('span', { class: 'pill ' + cls }, ...kids);
const note = (text) => h('p', { class: 'pg-note' }, text);
const cap2 = (left, right) => h('div', { class: 'pg-cap' }, h('span', null, left), right ? h('small', null, right) : null);
const sub3 = (text) => h('h3', { class: 'pg-sub' }, text);
const chartCard = (...kids) => h('div', { class: 'card pad-s pg-chart' }, kids);
const section = (title, ...kids) => h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, title)), kids);
const day = (key) => Math.round(parseKey(key).getTime() / 864e5);
const mondayOf = (key) => shiftDate(key, -((parseKey(key).getDay() + 6) % 7));
// a track (data-grow) is laid out at its final width and animated by grow()
const track = (pct, color, cls = 'mini-bar') => h('div', { class: cls }, h('i', { 'data-grow': '', style: { width: Math.max(0, Math.min(100, pct)) + '%', background: color } }));
const meterRow = (label, value, target, unit, color) => h('div', { class: 'pg-mrow' },
  h('div', { class: 'row between small' }, h('span', { class: 'strong' }, label), h('span', { class: 'muted' }, `${fmt(value)} / ${fmt(target)} ${unit}`)),
  track(clampPct(value / target), color));

function dataDays() {
  const s = new Set();
  for (const [k, d] of Object.entries(state.log)) if (d.food?.length || d.habits?.length || d.weight || d.sleep) s.add(k);
  for (const w of state.workouts) s.add(dateKey(new Date(w.start)));
  return s.size;
}
function rangeBar(redraw) {
  const el = chips(RANGES, String(rangeDays), (id) => { rangeDays = +id; redraw(); });
  el.classList.add('pg-range');
  el.setAttribute('aria-label', 'Chart range');
  el.querySelectorAll('.chip').forEach((b) => { b.classList.add('accent'); b.setAttribute('aria-label', RANGE_NAME[b.dataset.id]); });
  return el;
}
const safe = (fn, ...a) => { try { return fn(...a); } catch (e) { console.error('progress:', fn.name, e); return null; } };

function build(ctx, redraw) {
  const c = { ctx, today: ctx.today, keys: lastNDays(rangeDays, ctx.today), p: state.profile || {}, t: state.targets || {}, redraw };
  const out = [];
  const days = dataDays();
  if (days < 3) out.push(comeBackCard(days));
  const view = { weight: weightView, food: foodView, train: trainView, habits: habitsView }[sub] || weightView;
  out.push(...[].concat(safe(view, c) || []));
  return out.filter(Boolean);
}

function comeBackCard(days) {
  return h('div', { class: 'card pg-come' },
    h('div', { class: 'pg-dots', 'aria-hidden': 'true' }, [0, 1, 2].map((i) => h('i', { class: i < days ? 'on' : '' }))),
    emptyState('Come back after a few days of logging', 'Trends need a few data points. Log food, weight and workouts and this screen fills in.'));
}

// =====================================================================================================
// WEIGHT
// =====================================================================================================
function weightView(c) {
  const ws = weights();
  if (!ws.length) return h('div', { class: 'card' }, emptyState('No weigh-ins yet', 'Weigh in 3 times a week, same scale, same time. The trend line needs it.', h('button', { class: 'btn sm primary', onClick: () => c.ctx.go('today') }, 'Go to Today'), { ico: 'scale' }));
  return [safe(weightHero, c, ws), rangeBar(c.redraw), safe(trendCard, c, ws), safe(statTiles, c), safe(energyCard, c), safe(bmiCard, c, ws), safe(energySection, c)];
}

function nearestWeight(ws, key, tol, skip) {
  let best = null, bd = 1e9;
  for (const w of ws) { if (w === skip) continue; const d = Math.abs(day(w.date) - day(key)); if (d <= tol && d < bd) { bd = d; best = w; } }
  return best;
}
const goalDir = (p) => { const g = GOALS.find((x) => x.id === p.goal); return g ? Math.sign(g.kcal) : null; };

function weightHero(c, ws) {
  const lw = ws[ws.length - 1], target = c.p.targetWeightKg, first = ws[0].kg;
  const before = nearestWeight(ws, shiftDate(lw.date, -7), 3, lw);
  const delta = before ? +(lw.kg - before.kg).toFixed(1) : null, dir = goalDir(c.p);
  const val = h('span', null, lw.kg.toFixed(1));
  jobs.push(() => countUp(val, lw.kg, { key: 'pg:wt', fmt: (v) => v.toFixed(1), ms: 600 }));
  let chip;
  if (delta == null) chip = pill('', 'Weigh in again to see the weekly change');
  else if (Math.abs(delta) < 0.05) chip = pill('', 'No change vs 7 days ago');
  else {
    const good = dir === 0 ? Math.abs(delta) <= 0.5 : dir == null ? null : (dir < 0) === (delta < 0);
    chip = pill(good == null ? '' : good ? 'good' : 'warn', icon(delta < 0 ? 'arrowDown' : 'arrowUp', 12), `${num1(Math.abs(delta))} kg vs 7 days ago`);
  }
  let side;
  if (target && Math.abs(first - target) >= 0.5) {
    const pct = Math.max(0, Math.min(100, (first - lw.kg) / (first - target) * 100));
    const r = ring({ size: 98, stroke: 10, pct, color: 'var(--accent)', children: [h('div', { class: 'num-sm' }, Math.round(pct) + '%'), h('small', null, 'to goal')] });
    jobs.push(() => fill(r.fillEl, pct, { axis: 'ring', key: 'pg:wring', ms: 900 }));
    side = h('div', { class: 'pg-hero-side' }, r, h('div', { class: 'micro muted' }, `Goal ${num1(target)} kg`));
  } else {
    const byDate = new Map(ws.map((w) => [w.date, w.kg]));
    side = h('div', { class: 'pg-hero-side' }, sparkline({ points: lastNDays(21, c.ctx.today).map((k) => byDate.get(k) ?? null), color: 'var(--accent-text)', width: 104, height: 52 }), h('div', { class: 'micro muted' }, 'Last 3 weeks'));
  }
  return h('div', { class: 'card pg-hero' },
    h('div', { class: 'pg-hero-main' },
      h('div', { class: 'small muted ellipsis' }, `Latest weigh-in · ${fmtDateLabel(lw.date, c.today)}`),
      h('div', { class: 'num-xl pg-big' }, val, h('small', null, 'kg')),
      h('div', { class: 'pg-hero-chip' }, chip)),
    side);
}

function trendCard(c, ws) {
  const inRange = ws.filter((w) => w.date >= c.keys[0]).length;
  const card = chartCard();
  if (inRange >= 2) {
    const target = c.p.targetWeightKg;
    card.append(cap2('Weight and trend', `kg · last ${RANGE_NAME[rangeDays]}`), weightChart(c, ws, target),
      legend([{ label: 'Weigh-ins', color: 'var(--muted)', dot: true }, { label: 'Trend', color: 'var(--accent-text)', line: true }, target ? { label: `Goal ${num1(target)} kg`, color: 'var(--ink-2)', dash: true } : null].filter(Boolean)));
  } else card.append(h('div', { class: 'empty' }, h('b', null, 'Not enough weigh-ins in this range'), 'Log your weight at least twice to draw the line.'));
  return card;
}

function weightChart(c, ws, target) {
  const all = trendWeights(ws), byDate = new Map(all.map((w) => [w.date, w]));
  const trendAt = (k) => { // linear between weigh-ins; nothing before the first or after the last
    let a = null, b = null;
    for (const w of all) { if (w.date <= k) a = w; if (w.date >= k) { b = w; break; } }
    if (!a || !b) return null;
    if (a === b) return a.trend;
    return +(a.trend + (b.trend - a.trend) * (day(k) - day(a.date)) / (day(b.date) - day(a.date))).toFixed(2);
  };
  const labels = c.keys.map(fmtShortDate);
  const raw = { name: 'Weight', color: 'var(--muted)', dots: true, line: false, dotR: 3, opacity: 1, points: c.keys.map((k, i) => ({ x: labels[i], y: byDate.get(k)?.kg ?? null })) };
  const trend = { name: 'Trend', color: 'var(--accent-text)', areaColor: 'var(--accent)', width: 2.75, end: true, points: c.keys.map((k, i) => ({ x: labels[i], y: trendAt(k) })) };
  return lineChart({ series: [raw, trend], area: true, target: target || undefined, clampTarget: true, targetLabel: true, height: 200, fmtY: num1, unit: ' kg', xLabels: 5, label: 'Weight and trend' });
}

function paceOf(rate, goalRate) {
  if (goalRate == null) return null;
  if (goalRate === 0) return Math.abs(rate) <= 0.25 ? ['good', 'steady'] : ['warn', rate > 0 ? 'drifting up' : 'drifting down'];
  if (Math.sign(rate) !== Math.sign(goalRate) && Math.abs(rate) > 0.05) return ['bad', 'wrong direction'];
  const r = rate / goalRate;
  return r > 1.5 ? ['warn', 'faster than plan'] : r < 0.5 ? ['warn', 'slower than plan'] : ['good', 'on pace'];
}

const RATE_KEY = 'shredlog-mo-rate';
function lastRate() { try { const v = parseFloat(localStorage.getItem(RATE_KEY)); return isFinite(v) ? v : null; } catch (e) { return null; } }
function saveRate(v) { try { localStorage.setItem(RATE_KEY, String(v)); } catch (e) { /* private mode */ } }

// Rate (weightInsight: least-squares over the last 14 days) and the pace pill, plus distance to goal.
function statTiles(c) {
  const wi = weightInsight(), goal = GOALS.find((g) => g.id === c.p.goal);
  const goalRate = goal ? +(goal.kcal * 7 / 7700).toFixed(2) : null, lw = wi?.last;
  const tile = (lbl, v, unit, ...rest) => h('div', { class: 'tile pg-stat' }, h('div', { class: 'lbl' }, lbl), h('div', { class: 'val' }, v, unit ? h('small', null, ' ' + unit) : null), ...rest);
  let a, b;
  if (wi?.rate != null) {
    const rateEl = h('span', { class: 'pg-rate' }, signed(wi.rate, Math.abs(wi.rate) < 0.1 ? 2 : 1));
    const pc = paceOf(wi.rate, goalRate);
    a = tile('Weight trend', rateEl, 'kg/week', h('div', { class: 'micro muted' }, `last 14 days${goalRate != null ? ` · plan ${signed(goalRate)}` : ''}`),
      pc ? h('div', { class: 'pg-statpill' }, pill(pc[0], icon(pc[0] === 'good' ? 'check' : 'warn', 12), pc[1])) : null);
    // the number pops when the trend has moved towards the goal since the last time this screen was drawn
    const tg = goalRate != null ? goalRate : 0, prev = lastRate(), dist = (r) => Math.abs(r - tg);
    if (prev != null && dist(wi.rate) < dist(prev) - 0.04) jobs.push(() => pop(rateEl));
    saveRate(wi.rate);
  } else a = tile('Weight trend', '–', 'kg/week', h('div', { class: 'micro muted' }, 'Log weight 3+ times a week'));
  const target = c.p.targetWeightKg;
  if (lw && target) {
    const left = Math.abs(lw.kg - target), reached = (goalRate != null && goalRate < 0 && lw.kg <= target) || (goalRate != null && goalRate > 0 && lw.kg >= target);
    b = tile('To goal', reached ? 'Reached' : num1(left), reached ? '' : 'kg', h('div', { class: 'micro muted' }, wi?.eta ? `about ${fmtShortDate(dateKey(wi.eta))} at this rate` : reached ? `Goal ${num1(target)} kg` : 'No date yet at this rate'));
  } else b = tile('To goal', '–', '', h('div', { class: 'micro muted' }, 'Set a target weight in Settings'));
  return h('div', { class: 'tiles-2' }, a, b);
}

// BMI with Asian-Indian cut-offs: 18.5 / 23 / 25. The strip maps BMI 15..32 to 0..100 %.
function bmiCard(c, ws) {
  const lw = ws[ws.length - 1];
  if (!lw?.kg || !c.p.heightCm) return null;
  const b = bmi(lw.kg, c.p.heightCm), lo = 15, hi = 32, pos = (v) => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
  const word = b < 18.5 ? 'below range' : b < 23 ? 'healthy (Asian cut-offs)' : b < 25 ? 'above range (Asian cut-offs)' : 'well above range (Asian cut-offs)';
  const tone = b >= 18.5 && b < 23 ? 'good' : 'warn';
  const seg = (a, z, color) => h('i', { style: { flex: String(z - a), background: color } });
  const mark = h('b', { class: 'pg-mark', style: { left: pos(b) + '%' }, 'aria-hidden': 'true' });
  jobs.push(() => pop(mark));
  return h('div', { class: 'card pg-bmi' },
    h('div', { class: 'row between' }, h('div', null, h('div', { class: 'small muted' }, 'BMI'), h('div', { class: 'num-md' }, String(b))), pill(tone, icon(tone === 'good' ? 'check' : 'info', 12), word)),
    h('div', { class: 'pg-scale', role: 'img', 'aria-label': `BMI ${b}, ${word}` }, seg(lo, 18.5, 'var(--warn)'), seg(18.5, 23, 'var(--good)'), seg(23, 25, 'var(--warn)'), seg(25, hi, 'var(--bad)'), mark),
    h('div', { class: 'pg-ticks', 'aria-hidden': 'true' }, [18.5, 23, 25].map((v) => h('span', { style: { left: pos(v) + '%' } }, String(v)))),
    h('p', { class: 'pg-note' }, 'South Asian bodies carry more fat at the same BMI, so the healthy range ends at 23, not 25.'));
}

// ---------- energy in and out (verdict.js dayVerdict, averaged over the range) ----------
// "Out" is an estimate: resting burn from the profile formula, walking from steps, training from logged sessions.
// Today is left out (it is still being eaten), and so are partial days.
function energyCard(c) {
  const days = c.keys.map((k) => dayVerdict(k)).filter((d) => d.items && !d.partial && d.key !== c.today);
  if (!days.length) return null;
  const n = days.length, mean = (f) => Math.round(days.reduce((a, d) => a + f(d), 0) / n);
  const inn = mean((d) => d.intake), rest = mean((d) => d.burn.resting), walk = mean((d) => d.burn.steps), train = mean((d) => d.burn.workouts);
  const out = rest + walk + train, net = inn - out, max = Math.max(inn, out, 1), dir = goalDir(c.p);
  const good = dir === 0 ? Math.abs(net) <= 200 : dir == null ? null : dir < 0 ? net < 0 : net > 0;
  const sign = net < 0 ? MINUS : net > 0 ? '+' : '';
  const netEl = h('span', null, `${sign}${fmt(Math.abs(net))}`);
  const w = (v) => (v / max * 100) + '%';
  const seg = (v, color) => (v > 0 ? h('span', { style: { width: w(v), background: color } }) : null);
  const row = (label, value, ...segs) => h('div', { class: 'pg-en-row' }, h('span', { class: 'pg-en-l' }, label), h('div', { class: 'pg-en-track' }, h('div', { class: 'pg-en-bar', 'data-sweep': '' }, segs)), h('b', null, fmt(value)));
  jobs.push(() => countUp(netEl, Math.abs(net), { key: 'pg:en:net', fmt: (v) => `${sign}${fmt(Math.round(v))}` }));
  return h('div', { class: 'card pg-energy' },
    cap2('Energy', `daily average of ${n} logged day${n === 1 ? '' : 's'}`),
    h('div', { class: 'pg-en-top' },
      h('div', { class: 'num-lg' }, netEl, h('small', null, 'kcal net a day')),
      pill(good == null ? '' : good ? 'good' : 'warn', icon(net < 0 ? 'arrowDown' : 'arrowUp', 12), net === 0 ? 'Even' : net < 0 ? 'Deficit' : 'Surplus')),
    h('div', { class: 'pg-en-rows' }, row('In', inn, seg(inn, 'var(--c)')), row('Out', out, seg(rest, 'var(--muted)'), seg(walk, 'var(--p)'), seg(train, 'var(--accent)'))),
    legend([{ label: 'Resting', color: 'var(--muted)', value: fmt(rest) }, walk > 0 ? { label: 'Walking', color: 'var(--p)', value: fmt(walk) } : null, train > 0 ? { label: 'Training', color: 'var(--accent)', value: fmt(train) } : null].filter(Boolean)),
    note(`Out is an estimate: resting from your profile, walking from your steps${walk > 0 ? '' : ' (none logged, so it is left out)'}, training from your logged sessions. Today and partial days are left out.`));
}

// ---------- energy balance ----------
function energySection(c) {
  const ws = weights(), intake = intakeByDate(28, c.today);
  if (!ws.length && !Object.keys(intake).length) return null;
  const res = adaptiveTdee(ws, intake, 21);
  const ok = res && res.tdee >= 1000 && res.tdee <= 5500;
  return section('Energy balance', h('div', { class: 'card' }, ok ? measuredBlock(c, res) : energyNote(c, ws, intake, res)));
}

function measuredBlock(c, res) {
  const goal = GOALS.find((g) => g.id === c.p.goal) || GOALS[1];
  const formula = c.p.age && c.p.heightCm && c.p.weightKg ? tdee(c.p) : null;
  const suggested = Math.max(1200, Math.round((res.tdee + goal.kcal) / 10) * 10); // measured burn minus the goal's deficit (plus for a bulk)
  const top = Math.max(res.tdee, formula || 0);
  const heroNum = h('span', null, fmt(res.tdee));
  jobs.push(() => countUp(heroNum, res.tdee, { key: 'pg:tdee', fmt: (v) => fmt(v) }));
  const diff = formula ? res.tdee - formula : null;
  const bar = (label, v, color, strong) => h('div', { class: 'pg-cmp' + (strong ? ' on' : '') }, h('span', null, label), h('div', { class: 'pg-cmp-track' }, h('i', { 'data-grow': '', style: { width: (v / top * 100) + '%', background: color } })), h('b', null, fmt(v)));
  const gap = res.avgIntake - res.tdee;
  const out = [
    h('div', { class: 'row between wrap pg-etop' }, h('div', null, h('div', { class: 'small muted' }, 'Your measured burn'), h('div', { class: 'pg-hero2' }, '≈ ', heroNum, h('small', null, ' kcal/day'))),
      diff != null && Math.abs(diff) >= 25 ? pill('', icon(diff > 0 ? 'arrowUp' : 'arrowDown', 12), `${fmt(Math.abs(diff))} vs formula`) : null),
    h('div', { class: 'pg-cmps' }, formula ? bar('Formula', formula, 'var(--muted)') : null, bar('Measured', res.tdee, 'var(--accent)', true)),
    h('p', { class: 'pg-line' }, `You ate about ${fmt(res.avgIntake)} kcal a day, ${gap < 0 ? `${fmt(-gap)} under` : `${fmt(gap)} over`} what you burn.`),
    note(`Energy window: weigh-ins over the last ${res.span} days, food logged on ${res.days} of them (weight trend ${signed(res.slopePerWeek)} kg/week). The weight card above uses the last 14 days, so the two rates can differ.`)];
  if (c.t.kcal && Math.abs(suggested - c.t.kcal) >= 75) {
    out.push(h('div', { class: 'pg-suggest' }, h('p', { class: 'small' }, `For your ${goal.label.toLowerCase()} goal (${goal.sub}) eat about `, h('b', null, `${fmt(suggested)} kcal`), `. Target now ${fmt(c.t.kcal)}.`),
      h('button', { class: 'btn primary block', onClick: () => applyTarget(suggested) }, `Update target to ${fmt(suggested)}`)));
  } else if (c.t.kcal) out.push(h('div', { class: 'pg-suggest' }, pill('good', icon('check', 12), 'Your target matches your measured burn')));
  return out;
}

async function applyTarget(N) {
  const t = state.targets || {}, p = t.p || 0, f = Math.round(N * 0.25 / 9), cc = Math.max(50, Math.round((N - p * 4 - f * 9) / 4));
  const ok = await confirmSheet(`Daily calories ${fmt(t.kcal)} → ${fmt(N)}. Protein stays ${p} g, fat becomes ${f} g, carbs ${cc} g.`, { ok: 'Update target', title: 'Update calorie target?' });
  if (!ok) return;
  setTargets({ kcal: N, p, f, c: cc });
  toast(`Target is now ${fmt(N)} kcal`);
}

function energyNote(c, ws, intake, res) {
  const wd = new Set(ws.map((w) => w.date));
  const both = lastNDays(28, c.today).filter((k) => intake[k] > 0 && wd.has(k)).length, n = Math.min(both, 14);
  const r = ring({ size: 76, stroke: 8, pct: n / 14 * 100, color: 'var(--accent)', children: [h('div', { class: 'num-sm' }, String(n)), h('small', null, 'of 14')] });
  jobs.push(() => fill(r.fillEl, n / 14 * 100, { axis: 'ring', key: 'pg:ering', ms: 800 }));
  return h('div', { class: 'pg-wait' }, r, h('div', { class: 'grow' }, h('div', { class: 'strong' }, 'Measured burn is warming up'),
    h('p', { class: 'small muted' }, res ? `Your logs give an odd result (${fmt(res.tdee)} kcal). Log every meal and weigh in the same way each time.` : `Needs about 14 days with both food and weight logged (${both} so far).`)));
}

// =====================================================================================================
// FOOD
// =====================================================================================================
function foodView(c) {
  const tot = Object.fromEntries(c.keys.map((k) => [k, dayTotals(k)]));
  const all = c.keys.filter((k) => dayIfAny(k)?.food?.length);
  // Today is still being filled in: until the evening it stays out of the averages and protein-day counts (as the Energy card already does)
  const settled = all.filter((k) => !(k === c.today && new Date().getHours() < 20));
  const logged = settled.length ? settled : all;
  if (!all.length) return h('div', { class: 'card' }, emptyState('No meals logged in this range', 'Log food on Today and the calorie and protein charts fill in.', h('button', { class: 'btn sm primary', onClick: () => c.ctx.go('food') }, 'Open Food'), { ico: 'bowl' }));
  return [safe(foodHero, c, tot, logged), rangeBar(c.redraw), safe(energyCard, c), safe(intakeCards, c, tot, logged), safe(weekBudget, c), safe(splitCard, c, tot, logged), safe(nutrientSection, c)].flat().concat(safe(budgetSection) || []);
}

function ringStat(label, value, targetV, unit, color, key) {
  const pct = targetV ? Math.min(100, value / targetV * 100) : 0, num = h('span', null, fmt(value));
  const r = ring({ size: 100, stroke: 10, pct, color, children: [h('div', { class: 'num-sm' }, num), h('small', null, unit)] });
  jobs.push(() => { fill(r.fillEl, pct, { axis: 'ring', key: 'pg:' + key, ms: 900 }); countUp(num, value, { key: 'pg:n:' + key, fmt: (v) => fmt(v), ms: 700 }); });
  return h('div', { class: 'pg-ringstat' }, r, h('div', { class: 'strong' }, label), h('div', { class: 'micro muted' }, targetV ? `target ${fmt(targetV)} ${unit}` : 'no target set'));
}

function foodHero(c, tot, logged) {
  const t = c.t, aK = avg(logged.map((k) => tot[k].kcal)), aP = avg(logged.map((k) => tot[k].p));
  const hit = logged.filter((k) => t.p && tot[k].p >= t.p * 0.9).length;
  let kv = null;
  if (t.kcal) { const r = aK / t.kcal; kv = r > 1.1 ? ['warn', icon('arrowUp', 12), `${fmt(aK - t.kcal)} over`] : r >= 0.9 ? ['good', icon('check', 12), 'On target'] : ['accent', icon('arrowDown', 12), `${fmt(t.kcal - aK)} under`]; }
  let pv = null;
  if (t.p) pv = aP >= t.p * 0.9 ? ['good', icon('check', 12), 'On target'] : ['warn', icon('arrowDown', 12), `${fmt(t.p - aP)} g short`];
  return h('div', { class: 'card pg-hero pg-rings' },
    h('div', { class: 'pg-rings-head' }, h('div', { class: 'strong' }, 'Daily average'), h('div', { class: 'micro muted' }, `${logged.length} of ${c.keys.length} days logged`)),
    h('div', { class: 'pg-rings-row' },
      h('div', null, ringStat('Calories', aK, t.kcal, 'kcal', 'var(--c)', 'rk'), kv ? h('div', { class: 'pg-ringpill' }, pill(...kv)) : null),
      h('div', null, ringStat('Protein', aP, t.p, 'g', 'var(--p)', 'rp'), pv ? h('div', { class: 'pg-ringpill' }, pill(...pv)) : null)),
    t.p ? h('div', { class: 'pg-hitrow' }, pill(hit >= logged.length * 0.7 ? 'good' : 'warn', icon(hit >= logged.length * 0.7 ? 'check' : 'info', 12), `Protein hit on ${hit} of ${logged.length} logged days`)) : null);
}

function intakeCards(c, tot, logged) {
  const t = c.t;
  const mk = (field, unitTxt, over) => c.keys.map((k) => ({ label: fmtShortDate(k), value: tot[k][field], hl: k === c.today, color: over && over > 0 && tot[k][field] > over * 1.1 ? 'var(--bad)' : null, tip: `${fmtShortDate(k)}: ${fmt(tot[k][field])} ${unitTxt}` }));
  return [
    chartCard(cap2('Calories per day', `avg ${fmt(avg(logged.map((k) => tot[k].kcal)))} · target ${fmt(t.kcal)}`),
      barChart({ bars: mk('kcal', 'kcal', t.kcal), target: t.kcal, height: 160, color: 'var(--c)', targetLabel: true, fmtY: (v) => fmt(v), label: 'Calories per day' }),
      note('Dashed line is your target. Red bars went more than 10% over it.')),
    chartCard(cap2('Protein per day', `avg ${fmt(avg(logged.map((k) => tot[k].p)))} g · target ${fmt(t.p)} g`),
      barChart({ bars: mk('p', 'g protein'), target: t.p, height: 140, color: 'var(--p)', targetLabel: true, label: 'Protein per day' })),
  ];
}

function weekBudget(c) {
  const t = c.t; if (!t.kcal) return null;
  const dow = (parseKey(c.today).getDay() + 6) % 7, keys = lastNDays(7, shiftDate(c.today, 6 - dow)); // Mon..Sun
  const eaten = keys.filter((k) => k <= c.today).reduce((a, k) => a + dayTotals(k).kcal, 0);
  if (!eaten) return null;
  const budget = t.kcal * 7, left = budget - eaten, daysLeft = 7 - dow;
  const text = left >= 0 ? `${fmt(left)} kcal left this week, about ${fmt(left / daysLeft)} a day from today.` : `${fmt(-left)} kcal over the weekly budget.`;
  return h('div', { class: 'card pg-week' },
    cap2('Weekly budget', `${fmt(eaten)} of ${fmt(budget)} kcal`),
    h('div', { class: 'heat' }, keys.map((k) => weekCell(k, c))),
    h('div', { class: 'pg-days' }, keys.map((k) => h('span', null, fmtDow(k)[0]))),
    h('div', { class: 'pg-track', style: { marginTop: '12px' } }, h('i', { 'data-grow': '', style: { width: clampPct(eaten / budget) + '%', background: left < 0 ? 'var(--bad)' : 'var(--c)' } }), h('b', { class: 'pg-pace', style: { left: ((dow + 1) / 7 * 100) + '%' } })),
    note(text + ' Tick = within 10% of target; the marker is an even pace by tonight.'));
}

function weekCell(k, c) {
  const d = dayIfAny(k);
  if (k > c.today) return h('i', { class: 'future', title: fmtShortDate(k) });
  if (!d?.food?.length) return h('i', { class: 'none', title: `${fmtShortDate(k)}: nothing logged` }, '–');
  if (d.partial) return h('i', { class: 'none', title: `${fmtShortDate(k)}: partial day` }, '~');
  if (k === c.today) return h('i', { class: 'now', title: 'Today so far' }, '·');
  const r = dayTotals(k).kcal / c.t.kcal, off = Math.abs(r - 1);
  return h('i', { class: off <= 0.1 ? 'good' : off <= 0.25 ? 'warn' : 'bad', title: `${fmtShortDate(k)}: ${Math.round(r * 100)}% of target` }, off <= 0.1 ? '✓' : r > 1 ? '+' : MINUS);
}

function splitCard(c, tot, logged) {
  const sum = (f) => logged.reduce((a, k) => a + tot[k][f], 0), t = c.t;
  return chartCard(cap2('Where your calories come from', 'daily average'),
    splitRow('You', sum('p') * 4, sum('c') * 4, sum('f') * 9), t.p ? splitRow('Target', t.p * 4, (t.c || 0) * 4, (t.f || 0) * 9) : null,
    legend([{ label: 'Protein', color: 'var(--p)' }, { label: 'Carbs', color: 'var(--c)' }, { label: 'Fat', color: 'var(--f)' }]));
}
function splitRow(label, p, cc, f) {
  const tot = p + cc + f || 1, pc = (v) => Math.round(v / tot * 100), w = (v) => (v / tot * 100) + '%';
  return h('div', { class: 'pg-split' }, h('span', { class: 'strong' }, label),
    h('div', null, h('div', { class: 'bar', 'data-sweep': '' }, h('span', { class: 'seg-p', style: { width: w(p) } }), h('span', { class: 'seg-c', style: { width: w(cc) } }), h('span', { class: 'seg-f', style: { width: w(f) } })),
      h('div', { class: 'micro muted' }, `P ${pc(p)}% · C ${pc(cc)}% · F ${pc(f)}%`)));
}

// ---------- nutrients ----------
const STATUS = { red: ['bad', 'low'], amber: ['warn', 'a bit low'], green: ['good', 'fine'] };
const STATUS_NA = { red: ['bad', 'high'], amber: ['warn', 'a bit high'], green: ['good', 'fine'] };
const FIX_LABEL = { protein: 'Protein', fiber: 'Fibre', cheap: 'Budget', b12: 'B12', low_kcal: 'Low kcal', post_workout: 'Post-workout', pre_workout: 'Pre-workout', late_night_light: 'Late-night light' };

function nutrientSection(c) {
  const g = nutritionGaps(7);
  if (!g) return null;
  const hasMicro = g.micros.some((m) => m.avg > 0);
  const bad = (m) => (m.id === 'sodium' ? m.pct - 1 : 1 - m.pct);
  const micros = [...g.micros].sort((a, b) => bad(b) - bad(a));
  const n = (s) => micros.filter((m) => m.status === s).length;
  const card = h('div', { class: 'card' });
  if (hasMicro) card.append(h('div', { class: 'pg-strip', 'aria-hidden': 'true', 'data-sweep': '' }, [['red', 'bad'], ['amber', 'warn'], ['green', 'good']].map(([s, v]) => n(s) ? h('i', { style: { flex: n(s), background: `var(--${v})` } }) : null)),
    h('div', { class: 'pg-pills' }, n('red') ? pill('bad', icon('warn', 12), `${n('red')} low`) : null, n('amber') ? pill('warn', `${n('amber')} a bit low`) : null, n('green') ? pill('good', icon('check', 12), `${n('green')} fine`) : null));
  card.append(h('div', { class: 'small muted', style: { margin: '10px 0 4px' } }, `Average of the last ${g.days} logged day${g.days === 1 ? '' : 's'}`));
  const m = g.macros;
  if (m.p.target) card.append(meterRow('Protein', m.p.avg, m.p.target, 'g', 'var(--p)'));
  if (m.fiber.target) card.append(meterRow('Fibre', m.fiber.avg, m.fiber.target, 'g', 'var(--fiber)'));
  if (hasMicro) card.append(h('div', { class: 'pg-micros' }, micros.map((x) => microRow(x, c.p.diet))));
  else card.append(note('No vitamin or mineral data in these logs yet. Foods from the list carry it; quick-added items do not.'));
  const lowKey = micros.filter((x) => x.status === 'red' && ['iron', 'vitamin_b12', 'vitamin_d'].includes(x.id));
  if (lowKey.length) card.append(note('Low intake for weeks → ask a doctor for a blood test before supplementing.'));
  card.append(note('Micronutrient numbers come from food tables, not your blood.'));
  return [section('Nutrients', card), g.ideas.length ? ideasBlock(g, micros) : null];
}

function foodText(unit) {
  const amt = (v) => (typeof v === 'number' ? `${+v.toFixed(1)} ${unit}` : String(v));
  return (f) => (typeof f === 'string' ? f : `${f.name}${f.serving ? ` (${f.serving}${f.perServing != null ? ' → ' + amt(f.perServing) : ''})` : ''}`);
}

function microRow(m, diet) {
  const sodium = m.id === 'sodium', st = (sodium ? STATUS_NA : STATUS)[m.status];
  const foods = sodium ? [] : (m.foods || []).slice(0, 4).map(foodText(m.unit));
  const color = { red: 'var(--bad)', amber: 'var(--warn)', green: 'var(--good)' }[m.status];
  return h('details', { class: 'pg-micro', open: openMicros.has(m.id), onToggle: (e) => { if (e.target.open) openMicros.add(m.id); else openMicros.delete(m.id); } },
    h('summary', null,
      h('div', { class: 'pg-sum' }, h('div', { class: 'grow' }, h('div', { class: 'strong' }, niceName(m.name)), h('div', { class: 'small muted' }, `${fmt(m.avg, 1)} of ${fmt(m.rda)} ${m.unit}`)), pill(st[0], st[1]), h('span', { class: 'pg-chev' }, icon('down', 16))),
      track(clampPct(m.pct), color)),
    h('div', { class: 'pg-more' }, m.why ? h('p', null, m.why) : null,
      foods.length ? h('p', null, h('b', null, 'Add: '), foods.join(' · ')) : null,
      m.vegNote && ['veg', 'vegan', 'jain'].includes(diet) ? h('p', { class: 'muted' }, m.vegNote) : null));
}

// meal ideas for the gaps: a horizontal row of cards that bleeds to the screen edge
function ideasBlock(g, micros) {
  const fixLabel = (id) => FIX_LABEL[id] || niceName(micros.find((x) => x.id === id)?.name || id.replace(/_/g, ' '));
  return section('Meal ideas for your gaps', h('div', { class: 'pg-rail' }, g.ideas.slice(0, 6).map((i) => {
    const fixes = i.fixes.filter((f) => f !== 'b12' || !i.fixes.includes('vitamin_b12')).slice(0, 4);
    const items = Array.isArray(i.items) ? i.items.map((x) => (typeof x === 'string' ? x : x.name || '')).filter(Boolean).join(' · ') : i.items;
    return h('div', { class: 'card pad-s pg-idea' },
      h('div', { class: 'row between top' }, h('b', { class: 'pg-idea-name' }, i.name), i.costInr != null ? h('span', { class: 'pill accent' }, `₹${fmt(i.costInr)}`) : null),
      items ? h('div', { class: 'small muted pg-idea-items' }, items) : null,
      h('div', { class: 'small strong' }, [i.approx ? `${fmt(i.approx.kcal)} kcal · ${fmt(i.approx.p)} g protein` : null, i.prepMin ? `${i.prepMin} min` : null].filter(Boolean).join(' · ')),
      h('div', { class: 'pg-fixes' }, fixes.map((f) => h('span', { class: 'pg-fix' + (g.fixes.includes(f) ? ' on' : '') }, fixLabel(f)))));
  })));
}

// ---------- cheapest protein ----------
function budgetSection() {
  if (!state.data.knowledge) return null;
  const all = budgetProtein(10).slice(0, 10);
  if (!all.length) return null;
  const list = showAllProtein ? all : all.slice(0, 6);
  const top = Math.max(...all.map((s) => s.inrPer10gProtein), 1);
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } };
  const show = (s) => toast(`${s.name} · ${String(s.priceNote || s.notes || '').slice(0, 130)}${s.src ? ` (source: ${host(s.src)})` : ''}`.trim(), { ms: 7000 });
  const rows = list.map((s) => h('tr', { tabindex: 0, role: 'button', onClick: () => show(s), onKeydown: (e) => { if (e.key === 'Enter') show(s); } },
    h('td', null, h('div', { class: 'nm' }, s.name), s.notes ? h('div', { class: 'nt' }, s.notes) : null, h('div', { class: 'pg-bar', 'data-grow': '', style: { width: Math.max(6, s.inrPer10gProtein / top * 100) + '%' } })),
    h('td', { class: 'right strong' }, `₹${num1(s.inrPer10gProtein)}`), h('td', { class: 'right' }, `${num1(s.proteinPer100g)} g`)));
  return section('Cheapest protein for your diet and budget',
    h('div', { class: 'card pad-s' }, h('table', { class: 'table pg-bp' }, h('thead', null, h('tr', null, h('th', null, 'Food (bar = cost)'), h('th', { class: 'right' }, '₹ / 10 g P'), h('th', { class: 'right' }, 'P / 100 g'))), h('tbody', null, rows)),
      all.length > 6 ? h('button', { class: 'btn sm block pg-more-btn', onClick: () => { showAllProtein = !showAllProtein; paintAgain(); } }, showAllProtein ? 'Show fewer' : `Show all ${all.length}`) : null,
      note('Typical 2025–26 retail prices; yours will differ. Tap a row to see the source.')));
}
let paintAgain = () => {};

// =====================================================================================================
// TRAINING
// =====================================================================================================
const GROUPS = [['Chest', 1], ['Back', 2], ['Shoulders', 3], ['Arms', 4], ['Legs', 5], ['Core', 6]].map(([label, n]) => ({ key: label, label, color: `var(--g${n})` }));
const KIND = { increase: ['good', 'Add weight'], reps: ['good', 'Add reps'], hold: ['warn', 'Hold'], reduce: ['warn', 'Drop back'], stall: ['bad', 'Stuck'], layoff: ['warn', 'Ease back'] };
const PR_KIND = { weight: 'Heaviest', reps: 'Rep PR', time: 'Longest hold' };
const swatch = (color) => h('i', { class: 'pg-sw', style: { background: color } });

function currentRoutine() {
  const id = state.settings.currentRoutineId;
  return id ? (state.data.routines || []).concat(state.customRoutines || []).find((r) => r.id === id) : null;
}
const wVol = (w) => (w.exercises?.length ? workoutVolume(w) : w.volume || 0);
const kFmt = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(Math.round(v)));

function trainView(c) {
  if (!state.workouts.length) return h('div', { class: 'card' }, emptyState('No workouts yet', 'Finish one session on Train and your weekly volume, records and strength trend show up here.', h('button', { class: 'btn sm primary', onClick: () => c.ctx.go('train') }, 'Go to Train'), { ico: 'dumbbell' }));
  const vols = [5, 4, 3, 2, 1, 0].map((i) => ({ label: i ? `W-${i}` : 'This wk', vol: volumeByGroup(lastNDays(7, shiftDate(c.today, -7 * i))) }));
  return [safe(trainHero, c), safe(weekCard, c), safe(sessionsSection), safe(volumeCard, vols), safe(groupsCard, c, vols[5].vol), safe(loadCard, c), safe(nextCard, c), safe(prCard), safe(e1rmCards)];
}

// ---------- this week + recent sessions (verdict.js) ----------
const GRADE = { strong: ['good', 'check', 'Strong'], solid: ['accent', 'star', 'Solid'], light: ['warn', 'minus', 'Light'] };

// Day scores for the last 7 days (protein, calories, training, steps) plus the week's headline numbers.
function weekCard(c) {
  const wv = weekVerdict(c.today);
  const cols = wv.days.map((d, i) => {
    const has = d.items || d.sessions.length || d.steps, tone = d.score >= 70 ? 'hi' : d.score >= 45 ? 'mid' : 'lo';
    return h('div', { class: 'pg-wk-col' + (d.key === c.today ? ' now' : ''), role: 'img', 'aria-label': `${fmtDateLabel(d.key, c.today)}: ${has ? `day score ${d.score} of 100` : 'nothing logged'}` },
      h('span', { class: 'pg-wk-track' }, h('b', { style: { bottom: has ? `calc(${Math.max(4, d.score)}% + 4px)` : '0' } }, has ? String(d.score) : '–'), has ? h('i', { class: tone, 'data-growy': '', style: { height: Math.max(4, d.score) + '%' } }) : null), h('span', { class: 'pg-wk-d' }, fmtDow(d.key)[0]));
  });
  const stat = (key, to, unit, label, sub) => { const el = h('span', null, String(to)); jobs.push(() => countUp(el, to, { key: 'pg:wk:' + key, ms: 500 })); return h('div', { class: 'pg-wk-stat' }, h('div', { class: 'num-md' }, el, unit ? h('small', null, unit) : null), h('div', { class: 'strong small' }, label), h('div', { class: 'micro muted' }, sub)); };
  return h('div', { class: 'card pg-week7card' },
    cap2('This week', 'day score, last 7 days'),
    h('div', { class: 'pg-wk', 'data-wk': '' }, cols),
    h('div', { class: 'pg-wk-stats' },
      stat('s', wv.sessions, '', 'Sessions', 'in 7 days'),
      stat('a', wv.avgScore, '/100', 'Day score', 'average of 7 days'),
      stat('p', wv.proteinDays, wv.loggedDays ? `/${wv.loggedDays}` : '', 'Protein', 'days on target')),
    note('Day score: protein 35, calories near target 30, training 25, steps 10.'));
}

function sessionRow(w) {
  const v = safe(sessionVerdict, w);
  if (!v) return null;
  const [tone, ico, word] = GRADE[v.grade] || GRADE.solid, st = v.stats, k = dateKey(new Date(w.start));
  const r = ring({ size: 48, stroke: 5, pct: v.score, color: tone === 'accent' ? 'var(--accent)' : `var(--${tone})`, children: h('span', { class: 'pg-ses-n' }, String(v.score)) });
  jobs.push(() => fill(r.fillEl, v.score, { axis: 'ring', key: 'pg:ses:' + w.id, ms: 700 }));
  const improve = v.improve[0], win = v.wins[0], line = improve || win;
  return h('div', { class: 'pg-ses' },
    h('div', { class: 'pg-ses-top' }, r,
      h('div', { class: 'grow pg-ses-main' }, h('b', { class: 'ellipsis' }, w.name || 'Workout'), h('div', { class: 'micro muted ellipsis' }, `${fmtShortDate(k)} · ${st.sets} sets${st.volume ? ` · ${kFmt(st.volume)} kg` : ''}`)),
      pill(tone, icon(ico, 12), word)),
    line ? h('div', { class: 'pg-ses-line ' + (improve ? 'imp' : 'win') }, icon(improve ? 'target' : 'check', 14), h('span', null, line)) : null);
}

function sessionsSection() {
  const rows = [...state.workouts].sort((a, b) => b.start - a.start).slice(0, 6).map(sessionRow).filter(Boolean);
  if (!rows.length) return null;
  return section('Recent sessions', h('div', { class: 'card pad-s pg-ses-list' }, rows, note('Score out of 100 from completion, volume vs last time, records and rep ranges. Under each: the top thing to fix, or the best win.')));
}

function trainHero(c) {
  const routine = currentRoutine();
  const dow = (parseKey(c.today).getDay() + 6) % 7, keys = lastNDays(7, shiftDate(c.today, 6 - dow)); // Mon..Sun
  const cnt = (a, b) => state.workouts.filter((w) => { const k = dateKey(new Date(w.start)); return k >= a && k <= b; }).length;
  const mon = mondayOf(c.today), thisWk = cnt(mon, c.today), lastWk = cnt(shiftDate(mon, -7), shiftDate(mon, -1));
  const done = new Set(state.workouts.map((w) => dateKey(new Date(w.start))));
  const val = h('span', null, String(thisWk));
  jobs.push(() => countUp(val, thisWk, { key: 'pg:tw', ms: 500 }));
  const planned = routine?.daysPerWeek;
  return h('div', { class: 'card pg-hero pg-trainhero' },
    h('div', { class: 'row between top' },
      h('div', null, h('div', { class: 'small muted' }, 'Workouts this week'), h('div', { class: 'num-xl pg-big' }, val, h('small', null, planned ? `of ${planned}` : 'done'))),
      h('div', { class: 'pg-last' }, h('div', { class: 'num-md' }, String(lastWk)), h('div', { class: 'micro muted' }, 'last week'))),
    h('div', { class: 'pg-week7', role: 'img', 'aria-label': `${thisWk} workouts this week` }, keys.map((k) => h('div', { class: 'pg-day' + (done.has(k) ? ' done' : '') + (k === c.today ? ' now' : '') + (k > c.today ? ' future' : '') }, h('i', null, done.has(k) ? icon('check', 14) : null), h('span', null, fmtDow(k)[0])))));
}

function volumeCard(vols) {
  const any = vols.some((w) => GROUPS.some((g) => w.vol[g.key] > 0));
  return chartCard(cap2('Hard sets per week', 'by muscle group'),
    any ? [stackedBarChart({ groups: vols.map((w) => ({ label: w.label, parts: w.vol })), keys: GROUPS, height: 180, fmtY: num1, label: 'Hard sets per week by muscle group' }), legend(GROUPS.map((g) => ({ label: g.label, color: g.color })))]
      : h('div', { class: 'empty' }, h('b', null, 'No workouts in the last 6 weeks'), 'Log a session and the chart appears.'));
}

// one cell per muscle group: this week's sets + status pill, and how recovered it is
function groupCell(g, sets, r, beginner) {
  const st = volumeStatus(sets, beginner), tone = { red: 'bad', amber: 'warn', green: 'good' }[st.status];
  return h('div', { class: 'pg-gcell' },
    h('div', { class: 'row between' }, h('span', { class: 'small strong ellipsis' }, swatch(g.color), g.label), h('b', { class: 'num nowrap' }, `${num1(sets)} sets`)),
    h('span', { class: 'pill ' + tone }, h('span', null, st.label)),
    track(r == null ? 0 : clampPct(r), r >= 1 ? 'var(--good)' : 'var(--warn)', 'pg-track sm'),
    h('div', { class: 'micro muted' }, r == null ? 'not trained yet' : r >= 1 ? 'fresh' : `recovering ${Math.round(r * 100)}%`));
}

function groupsCard(c, vol) {
  const routine = currentRoutine(), rec = recoveryByGroup(), dl = deloadAdvice(), s = routine ? suggestDay(routine) : null, beginner = state.workouts.length < 12;
  return h('div', { class: 'card' },
    cap2('Last 7 days', 'sets and recovery'),
    h('div', { class: 'pg-grp' }, GROUPS.map((g) => groupCell(g, vol[g.key] || 0, rec[g.key], beginner))),
    dl ? h('div', { class: 'callout', style: { marginTop: '14px' } }, icon('info'), h('div', null, dl.text)) : null,
    s ? h('div', { class: 'pg-suggest' }, h('p', { class: 'small' }, 'Suggested next: ', h('b', null, s.name), ' — ', s.why.length ? s.why.join(', ') : 'fits your week and recovery'),
      h('button', { class: 'btn sm primary', onClick: () => c.ctx.go('train') }, 'Go to Train')) : null);
}

// total weight × reps per week: the "load trend"
function loadCard(c) {
  const mon = mondayOf(c.today), weeks = [];
  for (let i = 7; i >= 0; i--) {
    const a = shiftDate(mon, -7 * i), z = shiftDate(a, 6);
    const v = state.workouts.reduce((s, w) => { const k = dateKey(new Date(w.start)); return k >= a && k <= z ? s + wVol(w) : s; }, 0);
    weeks.push({ label: i ? fmtShortDate(a) : 'This wk', v });
  }
  const active = weeks.filter((w) => w.v > 0).length, cur = weeks[7].v, prev = weeks[6].v;
  const chg = prev > 0 ? Math.round((cur - prev) / prev * 100) : null;
  return chartCard(cap2('Training load', 'weight × reps, per week'),
    h('div', { class: 'row between pg-loadhead' }, h('div', { class: 'num-md' }, `${kFmt(cur)}`, h('small', null, 'kg so far this week')),
      chg != null ? pill(chg >= 0 ? 'good' : 'accent', icon(chg >= 0 ? 'arrowUp' : 'arrowDown', 12), `${Math.abs(chg)}% ${chg >= 0 ? 'above' : 'below'} last week`) : null),
    active >= 2 ? lineChart({ series: [{ name: 'Load', color: 'var(--p)', dots: true, dotR: 3, width: 2.5, end: true, points: weeks.map((w) => ({ x: w.label, y: w.v })) }], area: true, height: 150, fmtY: kFmt, unit: ' kg', xLabels: 4, yMin: 0, label: 'Weekly training load' })
      : h('div', { class: 'empty' }, h('b', null, 'Train a couple of weeks'), 'The load trend needs two weeks with workouts.'));
}

function nextCard(c) {
  const since = shiftDate(c.today, -29), counts = new Map();
  for (const w of state.workouts) {
    if (dateKey(new Date(w.start)) < since) continue;
    for (const ex of w.exercises || []) if ((ex.sets || []).some((x) => x.done)) counts.set(ex.exId, (counts.get(ex.exId) || 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => ({ id, ex: findExercise(id), s: nextSuggestion(id) })).filter((x) => x.ex && x.s).slice(0, 5);
  if (!top.length) return null;
  return section('Next session suggestions', h('div', { class: 'card pad-s' }, top.map((x) => { const k = KIND[x.s.kind] || ['', x.s.kind];
    return h('div', { class: 'pg-sug' }, h('div', { class: 'row between' }, h('b', { class: 'ellipsis' }, x.ex.name), pill(k[0], k[1])), h('div', { class: 'small muted' }, x.s.text)); })));
}

function prCard() {
  const out = [];
  for (const w of [...state.workouts].sort((a, b) => b.start - a.start)) for (const pr of w.prs || []) { if (out.length < 8) out.push({ date: dateKey(new Date(w.start)), pr }); }
  if (!out.length) return null;
  return section('Recent personal records', h('div', { class: 'card pad-s' }, out.map(({ date, pr }) => {
    const name = typeof pr === 'string' ? pr : pr.name || findExercise(pr.exId)?.name || 'Exercise', detail = typeof pr === 'string' ? '' : [PR_KIND[pr.kind], pr.text || (pr.value != null ? String(pr.value) : '')].filter(Boolean).join(' · ');
    return h('div', { class: 'pg-pr' }, h('span', { class: 'pr-tag' }, icon('trophy', 11), 'PR'), h('div', { class: 'grow' }, h('div', { class: 'strong ellipsis' }, name), detail ? h('div', { class: 'micro muted ellipsis' }, detail) : null), h('span', { class: 'small muted nowrap' }, fmtShortDate(date)));
  })));
}

// estimated 1RM per exercise: a card with a sparkline, tap to open the full chart
function e1rmCards() {
  const counts = new Map();
  for (const w of state.workouts) for (const ex of w.exercises || []) if (findExercise(ex.exId)?.type === 'strength' && (ex.sets || []).some((x) => x.done && x.w && x.r)) counts.set(ex.exId, (counts.get(ex.exId) || 0) + 1);
  const top = [...counts].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const cards = top.map(([id]) => {
    const pts = exerciseHistory(id, 12).reverse().map((s) => ({ x: fmtShortDate(s.date), y: Math.max(0, ...s.sets.filter((x) => x.t !== 'W' && x.w && x.r).map((x) => e1rm(x.w, x.r))) })).filter((p) => p.y > 0);
    if (pts.length < 3) return null;
    const best = bestFor(id).e1rm, change = +(pts[pts.length - 1].y - pts[0].y).toFixed(1);
    const bodyEl = h('div', { class: 'pg-e1-body' });
    const fillChart = () => { if (!bodyEl.firstChild) bodyEl.append(lineChart({ series: [{ name: 'Est. 1RM', color: 'var(--p)', dots: true, dotR: 3, width: 2.5, end: true, points: pts }], area: true, height: 150, fmtY: num1, unit: ' kg', xLabels: 5, label: 'Estimated one-rep max' }), note('Each dot is one session: the best set, converted to an estimated one-rep max.')); };
    if (openE1.has(id)) fillChart();
    return h('details', { class: 'card pad-s pg-e1', open: openE1.has(id), onToggle: (e) => { if (e.target.open) { openE1.add(id); fillChart(); } else openE1.delete(id); } },
      h('summary', null, h('div', { class: 'pg-e1-row' },
        h('div', { class: 'grow' }, h('div', { class: 'strong ellipsis' }, findExercise(id).name), h('div', { class: 'row pg-e1-num' }, h('span', { class: 'num-sm' }, num1(best), h('small', null, 'kg est. 1RM')), change ? pill(change > 0 ? 'good' : 'warn', icon(change > 0 ? 'arrowUp' : 'arrowDown', 12), `${num1(Math.abs(change))} kg`) : null)),
        sparkline({ points: pts.map((p) => p.y), color: 'var(--p)', width: 84, height: 36 }), h('span', { class: 'pg-chev' }, icon('down', 16)))),
      bodyEl);
  }).filter(Boolean);
  return cards.length ? section('Strength trend', h('div', { class: 'stack' }, cards)) : null;
}

// =====================================================================================================
// HABITS
// =====================================================================================================
// Steps: 7-day average, best day in the range, walking burn, and a bar per day against the goal. Logging lives on Body.
function stepsCard(c) {
  const goal = state.settings.stepTarget || 8000, win = lastNDays(7, c.today), before = lastNDays(7, shiftDate(c.today, -7));
  const got = (ks) => ks.filter((k) => stepsOn(k) > 0);
  const inRange = got(c.keys);
  if (!inRange.length && !got(win).length) return h('div', { class: 'card' }, emptyState('No steps yet', 'Paste or type them on Body. A Shortcut can copy them from the Health app for you.', h('button', { class: 'btn sm primary', onClick: () => c.ctx.go('body') }, 'Go to Body'), { ico: 'steps' }));
  const w7 = got(win), avg7 = avg(w7.map(stepsOn)), prev = avg(got(before).map(stepsOn)), arrow = arrowFor(avg7, prev, 'higher');
  const best = inRange.reduce((b, k) => (!b || stepsOn(k) > stepsOn(b) ? k : b), null);
  const kcal = w7.length ? Math.round(avg(w7.map((k) => stepsKcal(stepsOn(k), dayIfAny(k)?.weight || c.p.weightKg)))) : null;
  const k = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(Math.round(v)));
  const stat = (id, label, to, unit, sub, extra) => { const el = h('span', null, to == null ? '–' : fmt(to)); if (to != null) jobs.push(() => countUp(el, to, { key: 'pg:st:' + id, fmt: (v) => fmt(Math.round(v)), ms: 500 })); return h('div', { class: 'pg-sstat' }, h('div', { class: 'micro muted' }, label), h('div', { class: 'num-md' }, el, unit ? h('small', null, unit) : null), h('div', { class: 'micro muted ellipsis' }, sub), extra || null); };
  const span = Math.min(rangeDays, 30), keys = lastNDays(span, c.today);
  return h('div', { class: 'card pg-steps' },
    cap2('Steps', `last ${span} days`),
    h('div', { class: 'pg-sstats' },
      stat('avg', '7-day avg', avg7 == null ? null : Math.round(avg7), '', avg7 == null ? 'no steps this week' : `goal ${fmt(goal)}`),
      stat('best', 'Best day', best ? stepsOn(best) : null, '', best ? fmtShortDate(best) : 'none yet'),
      stat('kcal', 'Walking', kcal, 'kcal', 'a day')),
    arrow ? h('div', { class: 'pg-pills' }, h('span', { class: 'pg-arrow ' + arrow[1] }, arrow[0], arrow[3] ? h('small', null, arrow[3]) : null), h('span', { class: 'small muted' }, 'vs the 7 days before')) : null,
    barChart({ bars: keys.map((d) => ({ label: fmtShortDate(d), value: stepsOn(d), hl: d === c.today, color: stepsOn(d) >= goal ? 'var(--good)' : null, tip: `${fmtShortDate(d)}: ${stepsOn(d) ? fmt(stepsOn(d)) + ' steps' : 'not logged'}` })), target: goal, targetLabel: `Goal ${k(goal)}`, height: 140, color: 'var(--p)', fmtY: k, label: 'Steps per day' }),
    note('Green bars reached the goal. Walking burn uses your weight and a 0.75 m stride, so treat it as a guide.'));
}

function habitsView(c) {
  const active = (k) => { const d = dayIfAny(k); return !!d && !!(d.food.length || d.habits.length || d.weight || d.sleep); };
  const water = trackWater(), glass = state.settings.glassMl || 250;
  const win = (end) => lastNDays(7, end), prevEnd = shiftDate(c.today, -7);
  const mean = (end, fn, onlyActive = true) => avg(win(end).filter((k) => !onlyActive || active(k)).map(fn).filter((v) => v != null));
  const defs = [
    c.p.smoker ? { id: 'cig', ico: 'cig', cls: 'cig', color: 'var(--cig)', label: 'Cigarettes / day', fn: (k) => habitCount(k, 'cig'), better: 'lower', unit: '', target: c.t.cigLimit ? `limit ${c.t.cigLimit}` : '', dec: 1 } : null,
    { id: 'chai', ico: 'cup', cls: 'chai', color: 'var(--chai)', label: 'Chai / day', fn: chaiCount, better: null, unit: 'cups', target: c.p.chaiCups ? `usual ${c.p.chaiCups}` : '', dec: 1 },
    water ? { id: 'water', ico: 'drop', cls: 'water', color: 'var(--water)', label: 'Water / day', fn: (k) => waterMl(k) / glass, better: 'higher', unit: 'glasses', target: c.t.water ? `target ${c.t.water}` : '', dec: 1 } : null,
    { id: 'sleep', ico: 'moon', cls: 'sleep', color: 'var(--sleep)', label: 'Sleep / night', fn: (k) => dayIfAny(k)?.sleep ?? null, better: 'higher', unit: 'h', target: c.p.sleepTarget ? `target ${c.p.sleepTarget} h` : '', dec: 1, any: true },
  ].filter(Boolean);
  if (!lastNDays(14, c.today).some((k) => habitCount(k, 'cig') || (water && waterMl(k)) || chaiCount(k) || dayIfAny(k)?.sleep || stepsOn(k))) return h('div', { class: 'card' }, emptyState('No habits logged yet', 'Log steps, sleep or chai on Body and the trends show up here.', h('button', { class: 'btn sm primary', onClick: () => c.ctx.go('body') }, 'Go to Body'), { ico: 'cup' }));
  const sparkKeys = lastNDays(Math.min(rangeDays, 30), c.today);
  const tiles = defs.map((d) => {
    const cur = mean(c.today, d.fn, !d.any), prev = mean(prevEnd, d.fn, !d.any), arrow = arrowFor(cur, prev, d.better);
    const raw = sparkKeys.map((k) => (d.any ? (d.fn(k) ?? null) : active(k) ? d.fn(k) : null));
    // 3-day rolling mean so the line shows the trend, not the day-to-day noise
    const pts = raw.map((v, i) => { if (v == null) return null; const w = raw.slice(Math.max(0, i - 1), i + 2).filter((x) => x != null); return avg(w); });
    const val = h('span', null, cur == null ? '–' : fmt(cur, d.dec));
    if (cur != null) jobs.push(() => countUp(val, cur, { key: 'pg:h:' + d.id, fmt: (v) => fmt(v, d.dec), ms: 500 }));
    return h('div', { class: 'tile pg-tile' },
      h('div', { class: 'row between' }, h('span', { class: 'well ' + d.cls }, icon(d.ico)),
        arrow ? h('span', { class: 'pg-arrow ' + arrow[1], title: arrow[2], 'aria-label': arrow[2] }, arrow[0], arrow[3] ? h('small', null, arrow[3]) : null) : null),
      h('div', { class: 'lbl pg-tl' }, d.label),
      h('div', { class: 'val' }, val, cur == null || !d.unit ? null : h('small', null, ' ' + (d.unit === 'cups' && +cur.toFixed(1) === 1 ? 'cup' : d.unit))),
      sparkline({ points: pts, color: d.color, width: 120, height: 32, strokeWidth: 1.75, fluid: true }),
      h('div', { class: 'micro muted ellipsis' }, d.target || ' '));
  });
  const els = [rangeBar(c.redraw), safe(stepsCard, c), h('div', { class: 'tiles-2 pg-habit-tiles' }, tiles), note('Averages are the last 7 logged days; arrows compare them with the 7 before. Sparklines show the last ' + sparkKeys.length + ' days.')];
  if (c.p.smoker) {
    const by = habitByDate('cig', Math.min(rangeDays, 30), c.today), lim = c.t.cigLimit || undefined;
    // "fewer than usual" only counts days the app has a record of, and not today until the evening: an empty day before the first
    // log, or a morning with one cigarette so far, is not a day of smoking 6 fewer
    const firstKey = Object.keys(state.log).sort()[0] || null, dayOpen = new Date().getHours() < 20;
    const st = cigStats(Object.fromEntries(Object.entries(by).filter(([k]) => firstKey && k >= firstKey && !(k === c.today && dayOpen))), c.p.cigBaseline, c.p.cigCost);
    els.push(chartCard(cap2('Cigarettes per day', `last ${Math.min(rangeDays, 30)} days`),
      barChart({ bars: Object.entries(by).map(([k, v]) => ({ label: fmtShortDate(k), value: v, hl: k === c.today, tip: `${fmtShortDate(k)}: ${v} cigarette${v === 1 ? '' : 's'}` })), target: lim, targetLabel: lim ? `Limit ${lim}` : false, height: 140, color: 'var(--cig)', label: 'Cigarettes per day' }),
      st.moneySaved > 0 ? h('div', { class: 'pg-pills' }, pill('good', icon('check', 12), `${fmt(st.avoided)} fewer than usual · ₹${fmt(st.moneySaved)} saved`)) : null));
  }
  return els;
}

function arrowFor(cur, prev, better) {
  if (cur == null || prev == null) return null;
  const diff = cur - prev;
  if (Math.abs(diff) < Math.max(0.1, prev * 0.05)) return ['→', 'flat', 'About the same as the previous 7 days'];
  const up = diff > 0, good = better ? (better === 'higher') === up : null, pct = prev > 0 ? Math.round(Math.abs(diff) / prev * 100) : 0;
  return [up ? '↑' : '↓', good == null ? 'flat' : good ? 'good' : 'bad', `${up ? 'Up' : 'Down'} from the previous 7 days`, pct ? ` ${pct}%` : ''];
}
