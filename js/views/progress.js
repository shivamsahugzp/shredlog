// Progress: weight trend, energy balance, intake, nutrients, budget protein, training, habits.
import { state, dayIfAny, dayTotals, intakeByDate, weights, latestWeight, lastNDays, shiftDate, parseKey, dateKey, setTargets, exerciseHistory, bestFor, findExercise, habitByDate, habitCount, chaiCount, waterMl } from '../state.js';
import { adaptiveTdee, trendWeights, tdee, GOALS, bmi, e1rm } from '../calc.js';
import { weightInsight, nutritionGaps, budgetProtein, volumeByGroup, volumeStatus, recoveryByGroup, deloadAdvice, suggestDay, nextSuggestion } from '../insights.js';
import { lineChart, barChart, stackedBarChart, legend } from '../charts.js';
import { h, icon, toast, confirmSheet, segmented, emptyState, fmt, fmtShortDate, fmtDow, clear } from '../ui.js';
import { countUp, pop, quiet, stagger, growBars } from '../motion.js';

const RANGES = [{ id: 14, label: '2 weeks' }, { id: 28, label: '4 weeks' }, { id: 90, label: '3 months' }];
let rangeDays = 28; // survives tab switches
const openMicros = new Set(); // expanded <details> survive redraws
let jobs = []; // motion work queued while building, run once the new DOM is attached
const MINUS = '−';

export function render(container, ctx) {
  const root = h('div', { class: 'pg' });
  container.append(root);
  let drawn = false;
  // Build first, swap second. Only the first draw (or a range change) replays the chart intros; data-change redraws stay quiet.
  const draw = (intro) => {
    const y = window.scrollY;
    jobs = [];
    const run = () => { const next = build(ctx, () => draw(true)); clear(root); root.append(next); };
    if (drawn && intro !== true) quiet(run); else run();
    if (y) window.scrollTo(0, y);
    growBars(root, '.mini-bar > i, .pg-cmp-track > i, .pg-track > i, .pg-bar, .pg-split .bar > span', { key: 'pg' });
    for (const j of jobs) { try { j(); } catch (e) { console.error(e); } }
    if (!drawn) stagger(root.firstElementChild, { key: 'progress' });
    drawn = true;
  };
  draw();
  return () => draw();
}

// ---------- small helpers ----------
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const num1 = (v) => String(+(+v).toFixed(1));
const signed = (v, d = 1) => { const r = +(+v).toFixed(d); return r === 0 ? '0' : (r > 0 ? '+' : MINUS) + Math.abs(r); };
const clampPct = (v) => Math.max(0, Math.min(100, v * 100));
const niceName = (n) => cap(String(n || '')).replace(/^Vitamin ([a-z]\d*)$/i, (_, x) => 'Vitamin ' + x.toUpperCase());
const pill = (cls, text) => h('span', { class: 'pill ' + cls }, text);
const note = (text) => h('p', { class: 'pg-note' }, text);
const cap2 = (left, right) => h('div', { class: 'pg-cap' }, h('span', null, left), right ? h('small', null, right) : null);
const sub = (text) => h('h3', { class: 'pg-sub' }, text);
const chartCard = (...kids) => h('div', { class: 'card pad-s' }, kids);
// charts.js always prints the last x label; drop earlier labels that would overlap it
function tidy(svg) {
  const H = +svg.getAttribute('viewBox').split(' ')[3];
  const t = [...svg.querySelectorAll('text')].filter((e) => +e.getAttribute('y') === H - 6);
  const ext = (e) => { const x = +e.getAttribute('x'), w = e.textContent.length * 6, a = e.getAttribute('text-anchor'); return a === 'start' ? [x, x + w] : a === 'end' ? [x - w, x] : [x - w / 2, x + w / 2]; };
  if (t.length < 2) return svg;
  const last = ext(t[t.length - 1]);
  for (let i = t.length - 2; i >= 0 && ext(t[i])[1] + 6 > last[0]; i--) t[i].remove();
  return svg;
}
const section = (title, ...kids) => h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, title)), kids);
const meterRow = (label, value, target, unit, color) => h('div', { class: 'pg-mrow' },
  h('div', { class: 'row between small' }, h('span', { class: 'strong' }, label), h('span', { class: 'muted' }, `${fmt(value)} / ${fmt(target)} ${unit}`)),
  h('div', { class: 'mini-bar' }, h('i', { style: { width: clampPct(value / target) + '%', background: color } })));

function dataDays() {
  const s = new Set();
  for (const [k, d] of Object.entries(state.log)) if (d.food?.length || d.habits?.length || d.weight || d.sleep) s.add(k);
  for (const w of state.workouts) s.add(dateKey(new Date(w.start)));
  return s.size;
}
const mondayOf = (key) => shiftDate(key, -((parseKey(key).getDay() + 6) % 7));

function build(ctx, redraw) {
  const c = { ctx, today: ctx.today, keys: lastNDays(rangeDays, ctx.today), p: state.profile || {}, t: state.targets || {} };
  const frag = h('div');
  frag.append(h('div', { class: 'screen-head' }, h('div', null, h('h1', null, 'Progress'), h('div', { class: 'sub' }, 'Trends, gaps and what to do next'))),
    h('div', { class: 'pg-range' }, segmented(RANGES, rangeDays, (v) => { rangeDays = v; redraw(); })));
  const days = dataDays();
  if (days < 3) frag.append(comeBackCard(days));
  for (const fn of [weightSection, energySection, intakeSection, nutrientSection, budgetSection, trainingSection, habitsSection]) {
    try { const el = fn(c); if (el) frag.append(el); } catch (e) { console.error('progress:', fn.name, e); }
  }
  return frag;
}

function comeBackCard(days) {
  return h('div', { class: 'card pg-come' },
    h('div', { class: 'pg-dots', 'aria-hidden': 'true' }, [0, 1, 2].map((i) => h('i', { class: i < days ? 'on' : '' }))),
    emptyState('Come back after a few days of logging', 'Trends need a few data points. Log food, weight and workouts and this screen fills in.'));
}

// ---------- 1. weight ----------
function weightSection(c) {
  const ws = weights();
  if (!ws.length) return dataDays() >= 3 ? section('Weight', h('div', { class: 'card' }, emptyState('No weigh-ins yet', 'Weigh in 3 times a week, same scale, same time. The trend line needs it.', h('button', { class: 'btn sm primary', onClick: () => c.ctx.go('today') }, 'Go to Today')))) : null;
  const card = chartCard();
  if (ws.filter((w) => w.date >= c.keys[0]).length >= 2) {
    const target = c.p.targetWeightKg;
    card.append(cap2('Weight and trend', 'kg'), weightChart(c, ws, target),
      legend([{ label: 'Weigh-ins', color: 'var(--muted)' }, { label: 'Trend', color: 'var(--p)' }, target ? { label: `Goal ${target} kg`, color: 'var(--ink-2)' } : null].filter(Boolean)));
  } else card.append(h('div', { class: 'empty' }, h('b', null, 'Not enough weigh-ins in this range'), 'Log your weight at least twice to draw the line.'));
  card.append(...weightNotes(c));
  return section('Weight', card);
}

function weightChart(c, ws, target) {
  const all = trendWeights(ws), byDate = new Map(all.map((w) => [w.date, w]));
  const dn = (k) => Math.round(parseKey(k).getTime() / 864e5);
  const trendAt = (k) => { // linear between weigh-ins; nothing before the first or after the last
    let a = null, b = null;
    for (const w of all) { if (w.date <= k) a = w; if (w.date >= k) { b = w; break; } }
    if (!a || !b) return null;
    if (a === b) return a.trend;
    return +(a.trend + (b.trend - a.trend) * (dn(k) - dn(a.date)) / (dn(b.date) - dn(a.date))).toFixed(2);
  };
  const labels = c.keys.map(fmtShortDate);
  const raw = { name: 'Weight', color: 'var(--muted)', dots: true, width: 1, opacity: 0.7, points: c.keys.map((k, i) => ({ x: labels[i], y: byDate.get(k)?.kg ?? null })) };
  const trend = { name: 'Trend', color: 'var(--p)', width: 2.5, points: c.keys.map((k, i) => ({ x: labels[i], y: trendAt(k) })) };
  const svg = tidy(lineChart({ series: [raw, trend], target: target || undefined, clampTarget: true, height: 190, fmtY: num1, unit: ' kg', xLabels: 5 }));
  // charts.css pins .series-line to 2 px; inline style wins, so raw stays hairline and trend gets 2.5 px
  const lines = svg.querySelectorAll('path.series-line');
  if (lines[0]) lines[0].style.strokeWidth = '1';
  if (lines[1]) lines[1].style.strokeWidth = '2.5';
  return svg;
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

function weightNotes(c) {
  const wi = weightInsight(), goal = GOALS.find((g) => g.id === c.p.goal);
  const goalRate = goal ? +(goal.kcal * 7 / 7700).toFixed(2) : null;
  let line = 'Log weight 3+ times a week to see a trend';
  const pills = [];
  if (wi?.rate != null) {
    const rateEl = h('b', { class: 'pg-rate' }, signed(wi.rate, Math.abs(wi.rate) < 0.1 ? 2 : 1));
    line = ['Trend: ', rateEl, ' kg/week' + (goalRate != null ? ` · goal ${signed(goalRate)}` : '')
      + (wi.eta && wi.target ? ` · at this rate you reach ${num1(wi.target)} kg around ${fmtShortDate(dateKey(wi.eta))}` : '')];
    const pc = paceOf(wi.rate, goalRate); if (pc) pills.push(pill(pc[0], pc[1]));
    // the number pops when the trend has moved towards the goal since the last time this screen was drawn
    const target = goalRate != null ? goalRate : 0, prev = lastRate(), dist = (r) => Math.abs(r - target);
    if (prev != null && dist(wi.rate) < dist(prev) - 0.04) jobs.push(() => pop(rateEl));
    saveRate(wi.rate);
  }
  const lw = latestWeight();
  if (lw?.kg && c.p.heightCm) {
    const b = bmi(lw.kg, c.p.heightCm); // Asian-Indian cut-offs: 23 overweight, 25 obese
    pills.push(pill(b >= 18.5 && b < 23 ? 'good' : 'warn', `BMI ${b} · ${b < 18.5 ? 'below range' : b < 23 ? 'healthy (Asian cut-offs)' : b < 25 ? 'above range (Asian cut-offs)' : 'well above range (Asian cut-offs)'}`));
  }
  return [h('p', { class: 'pg-line' }, line), pills.length ? h('div', { class: 'pg-pills' }, pills) : null];
}

// ---------- 2. energy balance ----------
function energySection(c) {
  const ws = weights(), intake = intakeByDate(28, c.today);
  if (!ws.length && !Object.keys(intake).length) return null;
  const res = adaptiveTdee(ws, intake, 21);
  const ok = res && res.tdee >= 1000 && res.tdee <= 5500;
  const card = h('div', { class: 'card' }, ok ? measuredBlock(c, res) : energyNote(c, ws, intake, res));
  return section('Energy balance', card, weekBudget(c));
}

function measuredBlock(c, res) {
  const goal = GOALS.find((g) => g.id === c.p.goal) || GOALS[1];
  const formula = c.p.age && c.p.heightCm && c.p.weightKg ? tdee(c.p) : null;
  const suggested = Math.max(1200, Math.round((res.tdee + goal.kcal) / 10) * 10); // measured burn minus the goal's deficit (plus for a bulk)
  const rows = [['Formula says', formula, 'var(--muted)'], ['Measured burn', res.tdee, 'var(--p)'], ['You ate (avg)', res.avgIntake, 'var(--c)']].filter((r) => r[1]);
  const top = Math.max(...rows.map((r) => r[1]));
  const heroNum = h('span', null, fmt(res.tdee));
  jobs.push(() => countUp(heroNum, res.tdee, { key: 'pg:tdee', fmt: (v) => fmt(v) }));
  const out = [h('div', { class: 'small muted' }, 'Your measured burn'), h('div', { class: 'pg-hero' }, '≈ ', heroNum, h('small', null, ' kcal/day')),
    rows.map(([l, v, col]) => h('div', { class: 'pg-cmp' }, h('span', null, l), h('div', { class: 'pg-cmp-track' }, h('i', { style: { width: (v / top * 100) + '%', background: col } })), h('b', null, fmt(v)))),
    note(`Based on ${res.days} logged days over ${res.span} days. Weight trend ${signed(res.slopePerWeek)} kg/week.`)];
  if (c.t.kcal && Math.abs(suggested - c.t.kcal) >= 75) {
    out.push(h('div', { class: 'pg-suggest' }, h('p', { class: 'small' }, `For your ${goal.label.toLowerCase()} goal (${goal.sub}) eat about `, h('b', null, `${fmt(suggested)} kcal`), `. Target now ${fmt(c.t.kcal)}.`),
      h('button', { class: 'btn primary block', onClick: () => applyTarget(suggested) }, `Update target to ${fmt(suggested)}`)));
  } else if (c.t.kcal) out.push(h('div', { class: 'pg-suggest' }, pill('good', 'Your target matches your measured burn')));
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
  const both = lastNDays(28, c.today).filter((k) => intake[k] > 0 && wd.has(k)).length;
  return [h('div', { class: 'row between small' }, h('span', { class: 'strong' }, 'Measured burn'), h('span', { class: 'muted' }, `${Math.min(both, 14)} / 14 days`)),
    h('div', { class: 'pg-track', style: { marginTop: '8px' } }, h('i', { style: { width: Math.min(100, both / 14 * 100) + '%' } })),
    note(res ? `Your logs give an odd result (${fmt(res.tdee)} kcal). Log every meal and weigh in the same way each time.`
      : `Needs about 14 days with both food and weight logged (${both} so far).`)];
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
    h('div', { class: 'pg-track', style: { marginTop: '12px' } }, h('i', { style: { width: clampPct(eaten / budget) + '%', background: left < 0 ? 'var(--bad)' : 'var(--c)' } }), h('b', { class: 'pg-pace', style: { left: ((dow + 1) / 7 * 100) + '%' } })),
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

// ---------- 3. intake ----------
function intakeSection(c) {
  const tot = Object.fromEntries(c.keys.map((k) => [k, dayTotals(k)]));
  const logged = c.keys.filter((k) => dayIfAny(k)?.food?.length);
  if (!logged.length) return null;
  const mk = (field, unitTxt) => c.keys.map((k) => ({ label: fmtShortDate(k), value: tot[k][field], tip: `${fmtShortDate(k)}: ${fmt(tot[k][field])} ${unitTxt}` }));
  const t = c.t, hit = logged.filter((k) => t.p && tot[k].p >= t.p * 0.9).length;
  const sum = (f) => logged.reduce((a, k) => a + tot[k][f], 0);
  return section('Intake',
    chartCard(cap2('Calories per day', `avg ${fmt(avg(logged.map((k) => tot[k].kcal)))} · target ${fmt(t.kcal)}`),
      tidy(barChart({ bars: mk('kcal', 'kcal'), target: t.kcal, height: 150, color: 'var(--c)', colorOver: 'var(--bad)' })),
      note('Dashed line is your target. Red bars went over it.')),
    chartCard(cap2('Protein per day', `avg ${fmt(avg(logged.map((k) => tot[k].p)))} g · target ${fmt(t.p)} g`),
      tidy(barChart({ bars: mk('p', 'g protein'), target: t.p, height: 130, color: 'var(--p)' })),
      t.p ? note(`Protein hit on ${hit} of ${logged.length} logged days (90%+ of target).`) : null),
    chartCard(cap2('Where your calories come from', 'avg of logged days'),
      splitRow('You', sum('p') * 4, sum('c') * 4, sum('f') * 9), t.p ? splitRow('Target', t.p * 4, (t.c || 0) * 4, (t.f || 0) * 9) : null,
      legend([{ label: 'Protein', color: 'var(--p)' }, { label: 'Carbs', color: 'var(--c)' }, { label: 'Fat', color: 'var(--f)' }])));
}

function splitRow(label, p, cc, f) {
  const tot = p + cc + f || 1, pc = (v) => Math.round(v / tot * 100), w = (v) => (v / tot * 100) + '%';
  return h('div', { class: 'pg-split' }, h('span', { class: 'strong' }, label),
    h('div', null, h('div', { class: 'bar' }, h('span', { class: 'seg-p', style: { width: w(p) } }), h('span', { class: 'seg-c', style: { width: w(cc) } }), h('span', { class: 'seg-f', style: { width: w(f) } })),
      h('div', { class: 'micro muted' }, `P ${pc(p)}% · C ${pc(cc)}% · F ${pc(f)}%`)));
}

// ---------- 4. nutrients ----------
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
  if (hasMicro) card.append(h('div', { class: 'pg-strip', 'aria-hidden': 'true' }, [['red', 'bad'], ['amber', 'warn'], ['green', 'good']].map(([s, v]) => n(s) ? h('i', { style: { flex: n(s), background: `var(--${v})` } }) : null)),
    h('div', { class: 'pg-pills' }, n('red') ? pill('bad', `${n('red')} low`) : null, n('amber') ? pill('warn', `${n('amber')} a bit low`) : null, n('green') ? pill('good', `${n('green')} fine`) : null));
  card.append(h('div', { class: 'small muted', style: { margin: '10px 0 4px' } }, `Average of the last ${g.days} logged day${g.days === 1 ? '' : 's'}`));
  const m = g.macros;
  if (m.p.target) card.append(meterRow('Protein', m.p.avg, m.p.target, 'g', 'var(--p)'));
  if (m.fiber.target) card.append(meterRow('Fibre', m.fiber.avg, m.fiber.target, 'g', 'var(--fiber)'));
  if (hasMicro) card.append(h('div', { class: 'pg-micros' }, micros.map((x) => microRow(x, c.p.diet))));
  else card.append(note('No vitamin or mineral data in these logs yet. Foods from the list carry it; quick-added items do not.'));
  const lowKey = micros.filter((x) => x.status === 'red' && ['iron', 'vitamin_b12', 'vitamin_d'].includes(x.id));
  if (lowKey.length) card.append(note('Low intake for weeks → ask a doctor for a blood test before supplementing.'));
  card.append(note('Micronutrient numbers come from food tables, not your blood.'));
  return section('Nutrients', card, g.ideas.length ? ideasBlock(g, micros) : null);
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
      h('div', { class: 'mini-bar' }, h('i', { style: { width: clampPct(m.pct) + '%', background: color } }))),
    h('div', { class: 'pg-more' }, m.why ? h('p', null, m.why) : null,
      foods.length ? h('p', null, h('b', null, 'Add: '), foods.join(' · ')) : null,
      m.vegNote && ['veg', 'vegan', 'jain'].includes(diet) ? h('p', { class: 'muted' }, m.vegNote) : null));
}

function ideasBlock(g, micros) {
  const fixLabel = (id) => FIX_LABEL[id] || niceName(micros.find((x) => x.id === id)?.name || id.replace(/_/g, ' '));
  return [sub('Meal ideas for your gaps'), h('div', { class: 'stack' }, g.ideas.slice(0, 4).map((i) => {
    const fixes = i.fixes.filter((f) => f !== 'b12' || !i.fixes.includes('vitamin_b12')).slice(0, 5);
    const items = Array.isArray(i.items) ? i.items.map((x) => (typeof x === 'string' ? x : x.name || '')).filter(Boolean).join(' · ') : i.items;
    return h('div', { class: 'card flat pad-s pg-idea' },
      h('div', { class: 'row between' }, h('b', null, i.name), i.costInr != null ? h('span', { class: 'strong' }, `₹${fmt(i.costInr)}`) : null),
      items ? h('div', { class: 'small muted' }, items) : null,
      h('div', { class: 'small' }, [i.approx ? `${fmt(i.approx.kcal)} kcal · ${fmt(i.approx.p)} g protein` : null, i.prepMin ? `${i.prepMin} min` : null].filter(Boolean).join(' · ')),
      h('div', { class: 'pg-fixes' }, fixes.map((f) => h('span', { class: 'pg-fix' + (g.fixes.includes(f) ? ' on' : '') }, fixLabel(f)))));
  }))];
}

// ---------- 5. budget protein ----------
function budgetSection() {
  if (!state.data.knowledge) return null;
  const list = budgetProtein(10).slice(0, 10);
  if (!list.length) return null;
  const top = Math.max(...list.map((s) => s.inrPer10gProtein), 1);
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return u; } };
  const show = (s) => toast(`${s.name} · ${String(s.priceNote || s.notes || '').slice(0, 130)}${s.src ? ` (source: ${host(s.src)})` : ''}`.trim(), { ms: 7000 });
  const rows = list.map((s) => h('tr', { tabindex: 0, role: 'button', onClick: () => show(s), onKeydown: (e) => { if (e.key === 'Enter') show(s); } },
    h('td', null, h('div', { class: 'nm' }, s.name), s.notes ? h('div', { class: 'nt' }, s.notes) : null, h('div', { class: 'pg-bar', style: { width: Math.max(6, s.inrPer10gProtein / top * 100) + '%' } })),
    h('td', { class: 'right strong' }, `₹${num1(s.inrPer10gProtein)}`), h('td', { class: 'right' }, `${num1(s.proteinPer100g)} g`)));
  return section('Cheapest protein for your diet and budget',
    h('div', { class: 'card pad-s' }, h('table', { class: 'table pg-bp' }, h('thead', null, h('tr', null, h('th', null, 'Food (bar = cost)'), h('th', { class: 'right' }, '₹/10 g P'), h('th', { class: 'right' }, 'P/100 g'))), h('tbody', null, rows)),
      note('Typical 2025–26 retail prices; yours will differ. Tap a row to see the source.')));
}

// ---------- 6. training ----------
const GROUPS = [['Chest', 1], ['Back', 2], ['Shoulders', 3], ['Arms', 4], ['Legs', 5], ['Core', 6]].map(([label, n]) => ({ key: label, label, color: `var(--g${n})` }));
const KIND = { increase: ['good', 'Add weight'], reps: ['good', 'Add reps'], hold: ['warn', 'Hold'], reduce: ['warn', 'Drop back'], stall: ['bad', 'Stuck'], layoff: ['warn', 'Ease back'] };
const PR_KIND = { weight: 'Heaviest', reps: 'Rep PR', time: 'Longest hold' };
const swatch = (color) => h('i', { class: 'pg-sw', style: { background: color } });

function currentRoutine() {
  const id = state.settings.currentRoutineId;
  return id ? (state.data.routines || []).concat(state.customRoutines || []).find((r) => r.id === id) : null;
}

function trainingSection(c) {
  if (!state.workouts.length) return null;
  const weeks = [5, 4, 3, 2, 1, 0].map((i) => ({ label: i ? `W-${i}` : 'This wk', vol: volumeByGroup(lastNDays(7, shiftDate(c.today, -7 * i))) }));
  const any = weeks.some((w) => GROUPS.some((g) => w.vol[g.key] > 0));
  const els = [chartCard(cap2('Hard sets per week', 'by muscle group'),
    any ? [tidy(stackedBarChart({ groups: weeks.map((w) => ({ label: w.label, parts: w.vol })), keys: GROUPS, height: 170, fmtY: num1 })), legend(GROUPS.map((g) => ({ label: g.label, color: g.color })))]
      : h('div', { class: 'empty' }, h('b', null, 'No workouts in the last 6 weeks'), 'Log a session and the chart appears.'))];
  els.push(loadCard(c, weeks[5].vol), nextCard(c), prCard(), e1rmCard());
  return section('Training', els);
}

// one cell per muscle group: this week's sets + status pill, and how recovered it is
function groupCell(g, sets, r, beginner) {
  const st = volumeStatus(sets, beginner);
  return h('div', null,
    h('div', { class: 'row between' }, h('span', { class: 'small strong' }, swatch(g.color), g.label), h('b', { class: 'num' }, `${num1(sets)} sets`)),
    h('span', { class: 'pill ' + { red: 'bad', amber: 'warn', green: 'good' }[st.status] }, st.label),
    h('div', { class: 'pg-track sm' }, h('i', { style: { width: (r == null ? 0 : clampPct(r)) + '%', background: r >= 1 ? 'var(--good)' : 'var(--warn)' } })),
    h('div', { class: 'micro muted' }, r == null ? 'not trained yet' : r >= 1 ? 'fresh' : `recovering ${Math.round(r * 100)}%`));
}

function loadCard(c, vol) {
  const routine = currentRoutine(), rec = recoveryByGroup(), dl = deloadAdvice(), s = routine ? suggestDay(routine) : null;
  const cnt = (a, b) => state.workouts.filter((w) => { const k = dateKey(new Date(w.start)); return k >= a && k <= b; }).length;
  const mon = mondayOf(c.today), thisWk = cnt(mon, c.today), lastWk = cnt(shiftDate(mon, -7), shiftDate(mon, -1));
  const tile = (lbl, v, extra) => h('div', { class: 'tile' }, h('div', { class: 'lbl' }, lbl), h('div', { class: 'val' }, v, h('small', null, ' ' + extra)));
  const beginner = state.workouts.length < 12;
  return h('div', { class: 'card' },
    h('div', { class: 'tiles' }, tile('Workouts this week', thisWk, routine?.daysPerWeek ? `of ${routine.daysPerWeek} planned` : 'done'), tile('Last week', lastWk, 'done')),
    sub('Last 7 days: sets and recovery'),
    h('div', { class: 'pg-grp' }, GROUPS.map((g) => groupCell(g, vol[g.key] || 0, rec[g.key], beginner))),
    dl ? h('div', { class: 'callout', style: { marginTop: '14px' } }, icon('info'), h('div', null, dl.text)) : null,
    s ? h('div', { class: 'pg-suggest' }, h('p', { class: 'small' }, 'Suggested next: ', h('b', null, s.name), ' — ', s.why.length ? s.why.join(', ') : 'fits your week and recovery'),
      h('button', { class: 'btn sm primary', onClick: () => c.ctx.go('train') }, 'Go to Train')) : null);
}

function nextCard(c) {
  const since = shiftDate(c.today, -29), counts = new Map();
  for (const w of state.workouts) {
    if (dateKey(new Date(w.start)) < since) continue;
    for (const ex of w.exercises || []) if ((ex.sets || []).some((x) => x.done)) counts.set(ex.exId, (counts.get(ex.exId) || 0) + 1);
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).map(([id]) => ({ id, ex: findExercise(id), s: nextSuggestion(id) })).filter((x) => x.ex && x.s).slice(0, 5);
  if (!top.length) return null;
  return [sub('Next session suggestions'), h('div', { class: 'card pad-s' }, top.map((x) => { const k = KIND[x.s.kind] || ['', x.s.kind];
    return h('div', { class: 'pg-sug' }, h('div', { class: 'row between' }, h('b', null, x.ex.name), pill(k[0], k[1])), h('div', { class: 'small muted' }, x.s.text)); }))];
}

function prCard() {
  const out = [];
  for (const w of [...state.workouts].sort((a, b) => b.start - a.start)) for (const pr of w.prs || []) { if (out.length < 8) out.push({ date: dateKey(new Date(w.start)), pr }); }
  if (!out.length) return null;
  return [sub('Recent personal records'), h('div', { class: 'card pad-s' }, out.map(({ date, pr }) => {
    const name = typeof pr === 'string' ? pr : pr.name || findExercise(pr.exId)?.name || 'Exercise', detail = typeof pr === 'string' ? '' : [PR_KIND[pr.kind], pr.text || (pr.value != null ? String(pr.value) : '')].filter(Boolean).join(' · ');
    return h('div', { class: 'pg-pr' }, h('span', { class: 'pr-tag' }, icon('trophy', 11), 'PR'), h('div', { class: 'grow' }, h('div', { class: 'strong ellipsis' }, name), detail ? h('div', { class: 'micro muted ellipsis' }, detail) : null), h('span', { class: 'small muted' }, fmtShortDate(date)));
  }))];
}

function e1rmCard() {
  const counts = new Map();
  for (const w of state.workouts) for (const ex of w.exercises || []) if (findExercise(ex.exId)?.type === 'strength' && (ex.sets || []).some((x) => x.done && x.w && x.r)) counts.set(ex.exId, (counts.get(ex.exId) || 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1])[0];
  if (!top || top[1] < 3) return null;
  const pts = exerciseHistory(top[0], 12).reverse().map((s) => ({ x: fmtShortDate(s.date), y: Math.max(0, ...s.sets.filter((x) => x.t !== 'W' && x.w && x.r).map((x) => e1rm(x.w, x.r))) })).filter((p) => p.y > 0);
  if (pts.length < 3) return null;
  return [sub('Strength trend'), chartCard(cap2(findExercise(top[0]).name, `best est. 1RM ${num1(bestFor(top[0]).e1rm)} kg`),
    tidy(lineChart({ series: [{ name: 'Est. 1RM', color: 'var(--p)', dots: true, width: 2, points: pts }], height: 150, fmtY: num1, unit: ' kg', xLabels: 5 })),
    note('Each dot is one session: the best set, converted to an estimated one-rep max.'))];
}

// ---------- 7. habits ----------
function habitsSection(c) {
  const active = (k) => { const d = dayIfAny(k); return !!d && !!(d.food.length || d.habits.length || d.weight || d.sleep); };
  const glass = state.settings.glassMl || 250;
  const win = (end) => lastNDays(7, end), prevEnd = shiftDate(c.today, -7);
  const mean = (end, fn, onlyActive = true) => avg(win(end).filter((k) => !onlyActive || active(k)).map(fn).filter((v) => v != null));
  const defs = [
    c.p.smoker ? { label: 'Cigarettes / day', fn: (k) => habitCount(k, 'cig'), better: 'lower', unit: '', target: c.t.cigLimit ? `limit ${c.t.cigLimit}` : '', dec: 1 } : null,
    { label: 'Chai / day', fn: chaiCount, better: null, unit: 'cups', target: c.p.chaiCups ? `usual ${c.p.chaiCups}` : '', dec: 1 },
    { label: 'Water / day', fn: (k) => waterMl(k) / glass, better: 'higher', unit: 'glasses', target: c.t.water ? `target ${c.t.water}` : '', dec: 1 },
    { label: 'Sleep / night', fn: (k) => dayIfAny(k)?.sleep ?? null, better: 'higher', unit: 'h', target: c.p.sleepTarget ? `target ${c.p.sleepTarget} h` : '', dec: 1, any: true },
  ].filter(Boolean);
  const tiles = defs.map((d) => { const cur = mean(c.today, d.fn, !d.any), prev = mean(prevEnd, d.fn, !d.any); return { d, cur, arrow: arrowFor(cur, prev, d.better) }; });
  if (!lastNDays(14, c.today).some((k) => habitCount(k, 'cig') || waterMl(k) || chaiCount(k) || dayIfAny(k)?.sleep)) return null;
  const els = [];
  if (c.p.smoker) {
    const by = habitByDate('cig', 30, c.today), lim = c.t.cigLimit || undefined;
    els.push(chartCard(cap2('Cigarettes per day', 'last 30 days'), tidy(barChart({ bars: Object.entries(by).map(([k, v]) => ({ label: fmtShortDate(k), value: v, tip: `${fmtShortDate(k)}: ${v} cigarette${v === 1 ? '' : 's'}` })), target: lim, height: 130, color: 'var(--cig)' }))));
  }
  els.push(h('div', { class: 'tiles', style: { marginTop: els.length ? '10px' : '0' } }, tiles.map(({ d, cur, arrow }) => h('div', { class: 'tile pg-tile' },
    arrow ? h('span', { class: 'pg-arrow ' + arrow[1], title: arrow[2], 'aria-label': arrow[2] }, arrow[0]) : null,
    h('div', { class: 'lbl' }, d.label), h('div', { class: 'val' }, cur == null ? '–' : fmt(cur, d.dec), cur == null || !d.unit ? null : h('small', null, ' ' + (d.unit === 'cups' && +cur.toFixed(1) === 1 ? 'cup' : d.unit))),
    h('div', { class: 'micro muted' }, d.target || ' ')))));
  els.push(note('Arrows compare the last 7 days with the 7 before.'));
  return section('Habits', els);
}

function arrowFor(cur, prev, better) {
  if (cur == null || prev == null) return null;
  const diff = cur - prev;
  if (Math.abs(diff) < Math.max(0.1, prev * 0.05)) return ['→', 'flat', 'About the same as the previous 7 days'];
  const up = diff > 0, good = better ? (better === 'higher') === up : null;
  return [up ? '↑' : '↓', good == null ? 'flat' : good ? 'good' : 'bad', `${up ? 'Up' : 'Down'} from the previous 7 days`];
}
