// Body: how you feel (symptoms, evening check-in), habits (steps, cigarettes, chai & coffee, sleep, and water only when it is switched on in Settings),
// measurements, and food-to-symptom patterns. Screen CSS: css/body.css (prefix bd-).
//
// Rules this file follows (docs/design.md):
//  - The whole screen is rebuilt on every state change, but only inside quiet(): the element that changed pops, nothing else replays.
//  - First open plays one orchestrated moment: app.js rises the sections in turn (.mo-in), the glance rings fill ~60 ms apart (gradient arc, glowing head),
//    numbers count up, bars grow. Nothing here staggers the sections a second time.
//  - Every counter has a visible minus (removes the latest entry, Undo toast) and a list of today's entries (long-press or the list button).
//  - Past-day logs carry a noon timestamp (metaFor) so they never reset "since last" or land at the wrong hour; times are never shown for those.
import { state, day, dayIfAny, dateKey, setCheckin, logSymptom, removeSymptom, setRedFlags, logHabit, removeHabit, habitEntries, habitCount, habitByDate, lastHabitTs, waterMl, chaiCount, coffeeCount, setMeasurements, measurementSeries, setWeight, latestWeight, weights, lastNDays, shiftDate, commit, isChai, isCoffee, trackWater, setSteps, stepsOn } from '../state.js';
import { stepsKcal } from '../verdict.js';
import { cigStats } from '../calc.js';
import { SYMPTOMS, TAG_LABELS, RED_FLAGS, symptomPatterns } from '../insights.js';
import { h, icon, sheet, toast, stepper, longPress, append, clear, fmt, fmtTime, fmtDateLabel, fmtShortDate, fmtDow, haptic } from '../ui.js';
import { quiet, countUp, fill, pop, pulse, seen, remember, recall, canIntro, EASE_OUT, prefersReducedMotion } from '../motion.js';
import { gradRing, animateRing } from '../charts.js';

let seenParams = null; // one-shot ctx.params handling (params keep the same identity until go() is called again)

// ---------- small helpers ----------
const dt = (k) => new Date(k + 'T12:00:00').getTime();
const signed = (n, d = 1) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(+(+n).toFixed(d));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const n1 = (v) => String(+(+v).toFixed(1));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const mk = (cls, ...kids) => h('div', { class: cls }, ...kids);
const tagCard = (el, id) => { el.dataset.card = id; return el; }; // scroll anchor for the glance rings
// Timestamps: older / seeded records may lack ts (or hold junk). Never feed those to fmtTime ("12:NaN am").
const okTs = (ts) => typeof ts === 'number' && Number.isFinite(ts) && ts > 0;
const isNoon = (ts) => { const d = new Date(ts); return d.getHours() === 12 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0; };
// Clock text for an entry, or '' when it has none worth showing (missing ts, or the synthetic noon stamp of a past-day log).
const clock = (ts, key, today) => (okTs(ts) && !(key !== today && isNoon(ts)) ? fmtTime(ts) : '');
// Logs for a past day get a noon timestamp so they never reset "since last" or land at the wrong hour.
const metaFor = (key, today, extra = {}) => (key === today ? extra : { ...extra, ts: dt(key) });
const firstLogKey = () => Object.keys(state.log).sort()[0] || null;
const sec = (id, title, ...kids) => h('div', { class: 'section', dataset: { card: id } }, title ? h('div', { class: 'section-head' }, h('h2', null, title)) : null, kids);
const head = (ico, cls, title, right) => mk('bd-head', h('span', { class: 'well ' + cls }, icon(ico)), h('h3', { class: 'grow ellipsis' }, title), right || null);
const numField = (label, input, hint) => h('div', { class: 'field' }, h('label', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
// True when a value on screen changed since the last paint in this session: that element pops, nothing else does.
function changed(id, v) { const had = seen(id), prev = recall(id); remember(id, v); return had && prev !== v; }
const rise = (el, dy = 8) => { if (el && el.animate && !prefersReducedMotion()) el.animate([{ opacity: 0, transform: `translateY(${dy}px)` }, { opacity: 1, transform: 'none' }], { duration: 220, easing: EASE_OUT }); };
const sevDots = (n) => h('span', { class: 'bd-sevdots', 'aria-hidden': 'true' }, [1, 2, 3].map((i) => h('i', { class: i <= n ? 'on' : '' })));
const pips = (n, max) => h('span', { class: 'bd-pips', 'aria-hidden': 'true' }, Array.from({ length: max }, (_, i) => h('i', { class: i < n ? 'on' : '' })));

// Spot illustrations: inline SVG, two palette tones (.a = accent, .b = the --tone of the host), no hex.
const SPOTS = {
  moon: '<svg viewBox="0 0 96 96"><circle class="b w" cx="48" cy="48" r="42"/><path class="a" d="M72.9 34.7A30 30 0 1 0 44 77.9A26 26 0 1 1 72.9 34.7z"/><circle class="b" cx="74" cy="26" r="3.5"/><circle class="b" cx="82" cy="46" r="2.5"/><path class="b" d="M26 20l2.2 5.2 5.2 2.2-5.2 2.2L26 35l-2.2-5.2-5.2-2.2 5.2-2.2z"/></svg>',
  bowl: '<svg viewBox="0 0 96 96"><ellipse class="b w" cx="48" cy="82" rx="30" ry="5"/><path class="a" d="M14 48h68a34 34 0 0 1-68 0z"/><path class="b s" d="M34 36c0-7 7-7 7-14M48 38c0-7 7-7 7-14M62 36c0-7 7-7 7-14"/></svg>',
  tape: '<svg viewBox="0 0 96 96"><circle class="a" cx="42" cy="46" r="28"/><circle class="hole" cx="42" cy="46" r="12"/><rect class="b" x="38" y="62" width="48" height="14" rx="3"/><path class="hole s" d="M48 62v6M56 62v9M64 62v6M72 62v9M80 62v6"/></svg>',
  lens: '<svg viewBox="0 0 96 96"><circle class="b w" cx="42" cy="42" r="32"/><circle class="a ring" cx="42" cy="42" r="22"/><path class="a s" d="M58 58l22 22"/><circle class="b" cx="34" cy="40" r="3.5"/><circle class="b" cx="46" cy="34" r="3.5"/><circle class="b" cx="48" cy="48" r="3.5"/></svg>',
};
const spot = (name, tone = 'var(--sleep)') => h('span', { class: 'bd-spot', style: { '--tone': tone }, 'aria-hidden': 'true', html: SPOTS[name] });
const emptyBlock = (name, tone, text, action) => mk('bd-empty', spot(name, tone), h('p', null, text), action || null);

// Tiny monotone-cubic sparkline (Fritsch-Butland tangents: no false dips). Soft area gradient, a blurred glow twin of the line and a haloed end dot.
let sparkSeq = 0;
function spark(vals, { w = 84, hgt = 26, color = 'var(--accent)', cls = '' } = {}) {
  const NS = 'http://www.w3.org/2000/svg', n = vals.length;
  const el = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const svg = el('svg', { viewBox: `0 0 ${w} ${hgt}`, class: 'bd-spark ' + cls, 'aria-hidden': 'true' });
  if (n < 2) return svg;
  const lo = Math.min(...vals), hi = Math.max(...vals), span = hi - lo || 1, pad = 3;
  const pts = vals.map((v, i) => [pad + (i / (n - 1)) * (w - 2 * pad), hgt - pad - ((v - lo) / span) * (hgt - 2 * pad)]);
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1][0] - pts[i][0]); m.push((pts[i + 1][1] - pts[i][1]) / dx[i]); }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1] * m[i] <= 0 ? 0 : (3 * (dx[i - 1] + dx[i])) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]));
  t.push(m[n - 2]);
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) { const s = dx[i] / 3; d += `C${(pts[i][0] + s).toFixed(1)} ${(pts[i][1] + t[i] * s).toFixed(1)} ${(pts[i + 1][0] - s).toFixed(1)} ${(pts[i + 1][1] - t[i + 1] * s).toFixed(1)} ${pts[i + 1][0].toFixed(1)} ${pts[i + 1][1].toFixed(1)}`; }
  const id = 'bdsp' + (++sparkSeq);
  const grad = el('linearGradient', { id: 'g' + id, x1: 0, y1: 0, x2: 0, y2: 1 }), s0 = el('stop', { offset: '0%', 'stop-opacity': 0.32 }), s1 = el('stop', { offset: '100%', 'stop-opacity': 0 });
  s0.style.stopColor = color; s1.style.stopColor = color; grad.append(s0, s1);
  const blur = el('filter', { id: 'f' + id, filterUnits: 'userSpaceOnUse', x: -6, y: -6, width: w + 12, height: hgt + 12 }); blur.append(el('feGaussianBlur', { stdDeviation: 2 }));
  svg.append(el('defs'), el('defs'));
  svg.firstChild.append(grad, blur);
  const area = el('path', { d: `${d}L${pts[n - 1][0].toFixed(1)} ${hgt}L${pts[0][0].toFixed(1)} ${hgt}Z`, fill: `url(#g${id})`, stroke: 'none' });
  const glow = el('path', { d, fill: 'none', 'stroke-width': 5, 'stroke-linecap': 'round', opacity: 0.25, filter: `url(#f${id})` }); glow.style.stroke = color;
  const path = el('path', { d, fill: 'none', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }); path.style.stroke = color;
  const halo = el('circle', { cx: pts[n - 1][0], cy: pts[n - 1][1], r: 5.6, opacity: 0.25 }); halo.style.fill = color;
  const dot = el('circle', { cx: pts[n - 1][0], cy: pts[n - 1][1], r: 2.8 }); dot.style.fill = color;
  svg.append(area, glow, path, halo, dot);
  if (canIntro()) {
    for (const p of [glow, path]) { p.setAttribute('pathLength', '1'); p.animate([{ strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDasharray: '1 1', strokeDashoffset: 0 }], { duration: 600, easing: EASE_OUT, fill: 'backwards' }); }
    area.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: 300, fill: 'backwards' });
    for (const p of [halo, dot]) p.animate([{ opacity: 0 }, { opacity: p === halo ? 0.25 : 1 }], { duration: 240, delay: 520, fill: 'backwards' });
  }
  return svg;
}

// Progress ring (charts.js gradRing): gradient arc, blurred glow and a glowing head that rides the arc; a lighter second lap above 100 %.
// The fill animates from the last painted value (0 on first open), the head follows it frame by frame.
function pRing(c, { id, size, stroke, raw, color, color2, children, delay = 0, ms = 900 }) {
  const pct = clamp(raw, 0, 200);
  const r = gradRing({ size, stroke, pct, color, color2, children });
  c.jobs.push(() => animateRing(r, pct, { key: `bd:ring:${id}:${c.key}`, ms, delay }));
  return r;
}

// Habit strength: a score that survives a few misses (idea from Loop Habit Tracker, GPL: idea only, no code taken).
// A streak snaps to 0 on one bad day. Strength is an exponential moving average of each day's result (0 = missed, 1 = nailed it):
//     s[today] = s[yesterday] * K + result[today] * (1 - K),   K = 0.5 ^ (1/13)  (about 0.948)
// so the score has a 13-day half-life: it climbs slowly while you do well, and one slip only shaves ~5 % of what you built.
// It starts at 0 on your first logged day, which is why seven perfect days read about 30 % ("Building"), not 100 %.
const K = Math.pow(0.5, 1 / 13);
function strength(endKey, result, days = 120) {
  const first = firstLogKey();
  if (!first || first > endKey) return null;
  let start = shiftDate(endKey, -(days - 1)); if (start < first) start = first;
  let s = 0; const series = [];
  for (let k = start; k <= endKey; k = shiftDate(k, 1)) { s = s * K + clamp(result(k), 0, 1) * (1 - K); series.push(s); }
  return { pct: Math.round(s * 100), series, slip: Math.max(1, Math.round(s * 100 * (1 - K))) };
}
const strengthWord = (p) => (p < 20 ? 'Just starting' : p < 45 ? 'Building' : p < 70 ? 'Solid' : 'Strong');

// ---------- entry ----------
export function render(container, ctx) {
  const root = h('div', { class: 'bd' });
  container.append(root);
  const ui = { pending: null, since: null, sleepDraft: null };
  let drawn = false;
  // Build first, swap second (a throwing build cannot blank the screen). Ring/number intros replay on the first draw only (redraws are quiet).
  const draw = () => {
    const jobs = [];
    const run = () => { ui.since = null; const next = build(ctx, ui, draw, jobs); clear(root); root.append(next); };
    if (drawn) quiet(run); else run();
    for (const j of jobs) { try { j(); } catch (e) { console.error(e); } }
    drawn = true;
  };
  draw();
  const timer = setInterval(() => { if (!root.isConnected) clearInterval(timer); else paintSince(ui); }, 30000);
  if (ctx.params && ctx.params.open === 'checkin' && ctx.params !== seenParams) { seenParams = ctx.params; checkinSheet(ctx.params.date || ctx.date, ctx.today); }
  return draw;
}

function build(ctx, ui, redraw, jobs) {
  const c = { ctx, ui, redraw, jobs, key: ctx.date, today: ctx.today, p: state.profile || {}, t: state.targets || {} };
  const f = h('div');
  append(f, [header(), redFlagBanner(c), dateNav(c), glanceCard(c), stomachSection(c), checkinSection(c), habitsSection(c), measuresSection(c), patternsSection(c), ironNudge(c)]);
  return f;
}

const header = () => h('div', { class: 'screen-head' }, h('div', null, h('h1', null, 'Body'), h('div', { class: 'sub' }, 'How you feel, what you do, what it adds up to.')));

function dateNav({ key, today, ctx }) {
  const isToday = key === today;
  return h('div', { class: 'date-nav bd-nav' },
    h('button', { class: 'icon-btn', 'aria-label': 'Previous day', onClick: () => ctx.setDate(shiftDate(key, -1)) }, icon('left')),
    h('div', { class: 'label' }, fmtDateLabel(key, today), h('small', null, isToday ? 'Log as you go' : 'Viewing a past day'),
      !isToday ? h('button', { class: 'btn sm soft pill bd-back', onClick: () => ctx.setDate(today) }, 'Back to today') : null),
    h('button', { class: 'icon-btn', 'aria-label': 'Next day', disabled: isToday, onClick: () => ctx.setDate(shiftDate(key, 1)) }, icon('right')));
}

function redFlagBanner({ today }) {
  const seenF = new Map();
  for (const k of lastNDays(7, today)) for (const f of dayIfAny(k)?.redFlags || []) if (!seenF.has(f)) seenF.set(f, k);
  if (!seenF.size) return null;
  return h('div', { class: 'callout danger bd-red', role: 'alert' }, icon('warn'), h('div', { class: 'grow' },
    h('b', null, 'Some of these need a doctor, not an app. Please get checked.'),
    h('ul', { class: 'bd-red-list' }, [...seenF].map(([f, k]) => h('li', null, f, h('span', { class: 'muted' }, ` · ${fmtDateLabel(k, today)}`))))));
}

const stepGoal = () => state.settings.stepTarget || 8000;
const scrollTo = (id) => { const el = document.querySelector(`.bd [data-card="${id}"]`); if (el) el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }); };

// ---------- 1. Today at a glance: three or four rings, the first-open moment ----------
// Water is opt-in (Settings): off by default, so the row is Steps, Sleep and Cigarettes (or Check-in).
function glanceCard(c) {
  const { key, p, t } = c, d = dayIfAny(key) || {};
  const sGoal = stepGoal(), steps = d.steps || 0;
  const sTarget = p.sleepTarget || 7.5, hrs = d.sleep > 0 ? d.sleep : 0;
  const n = habitCount(key, 'cig'), lim = t.cigLimit || 0;
  const kfmt = (v) => (v >= 1000 ? n1(v / 1000) + 'k' : String(Math.round(v)));
  const items = [];
  if (trackWater()) { const glass = state.settings.glassMl || 250, wGoal = (t.water || 8) * glass, ml = waterMl(key); items.push({ id: 'water', card: 'water', label: 'Water', raw: (ml / wGoal) * 100, color: 'var(--water)', color2: 'var(--accent)', to: ml / 1000, f: (v) => n1(v), unit: 'L' }); }
  items.push(
    { id: 'steps', card: 'steps', label: 'Steps', raw: (steps / sGoal) * 100, color: 'var(--p)', color2: 'var(--accent-2)', to: steps, f: kfmt, unit: '' },
    { id: 'sleep', card: 'sleep', label: 'Sleep', raw: (hrs / sTarget) * 100, color: 'var(--sleep)', color2: 'var(--accent)', to: hrs, f: n1, unit: 'h' },
    p.smoker
      ? { id: 'cig', card: 'cig', label: 'Cigarettes', raw: lim ? (n / lim) * 100 : n ? 100 : 0, color: lim && n > lim ? 'var(--bad)' : lim && n >= lim * 0.8 ? 'var(--warn)' : 'var(--cig)', to: n, f: (v) => String(Math.round(v)), unit: lim ? `/${lim}` : '' }
      : { id: 'ck', card: 'checkin', label: 'Check-in', raw: d.checkin ? 100 : 0, color: 'var(--accent)', color2: 'var(--accent-2)', icon: d.checkin ? 'check' : 'edit' });
  const card = h('div', { class: 'card hero bd-glance', style: { '--n': items.length } });
  items.forEach((it, i) => {
    let center;
    if (it.icon) center = h('span', { class: 'bd-gl-n ico' }, icon(it.icon, 22));
    else { const numEl = h('span', null); center = h('span', { class: 'bd-gl-n' }, numEl, it.unit ? h('small', null, it.unit) : null); c.jobs.push(() => countUp(numEl, it.to, { key: `bd:gl:${it.id}:${key}`, ms: 500, fmt: it.f })); if (changed(`bd:glv:${it.id}:${key}`, it.to)) c.jobs.push(() => pop(center)); }
    // the sequence: rings start 60 ms apart after the card begins to rise (80 ms), each 360 ms long, so the last one lands inside ~600 ms
    const r = pRing(c, { id: 'gl-' + it.id, size: items.length > 3 ? 68 : 76, stroke: 7, raw: it.raw, color: it.color, color2: it.color2, children: center, delay: 80 + i * 60, ms: 360 });
    card.append(h('button', { class: 'bd-gl pressable', 'aria-label': `${it.label}. Jump to it.`, onClick: () => { haptic(); scrollTo(it.card); } }, r, h('span', { class: 'bd-gl-l' }, it.label)));
  });
  return card;
}

// ---------- 2. Right now: how do you feel after eating? ----------
const STOMACH = [{ id: 'all_good', label: 'All good' }, { id: 'bloating', label: 'Bloating' }, { id: 'gas', label: 'Gas' }, { id: 'acidity', label: 'Acidity' }, { id: 'cramps', label: 'Cramps' }, { id: 'headache', label: 'Headache' }, { id: 'sleepy', label: 'Sleepy / heavy', noun: 'sleepiness or heaviness' }, { id: 'heat', label: 'Garmi', noun: 'body heat' }];
const SEV = [{ v: 1, label: 'Mild' }, { v: 2, label: 'Moderate' }, { v: 3, label: 'Strong' }];
const SYM_LABEL = Object.fromEntries(STOMACH.map((s) => [s.id, s.label]));
const SEV_LABEL = Object.fromEntries(SEV.map((s) => [s.v, s.label]));
// Short chip label first, then the insights SYMPTOMS label, so any logged type displays properly.
const symLabel = (type) => SYM_LABEL[type] || SYMPTOMS.find((x) => x.id === type)?.label || type;
const symNoun = (type) => (STOMACH.find((x) => x.id === type)?.noun || symLabel(type)).toLowerCase();

const restoreSymptom = (key, e) => { const d = day(key); if (!(d.symptoms ||= []).some((x) => x.id === e.id)) d.symptoms.push(e); commit('checkin'); };
const restoreHabit = (key, e) => { const d = day(key); if (!d.habits.some((x) => x.id === e.id)) d.habits.push(e); commit('habit'); };
// The most recent tap is the last one pushed (insertion order), not the highest ts: seeded / past-day entries carry arbitrary stamps.
const latestOf = (arr) => (arr.length ? arr[arr.length - 1] : null);

function addSymptom({ key, today }, type, sev) {
  const e = logSymptom(key, type, sev, metaFor(key, today));
  haptic();
  toast(type === 'all_good' ? 'Logged: all good' : `Logged: ${symNoun(type)}, ${SEV_LABEL[sev].toLowerCase()}`, { undo: () => removeSymptom(key, e.id) });
}
function dropSymptom({ key }, e) {
  removeSymptom(key, e.id); haptic('warn');
  toast(`Removed ${e.type === 'all_good' ? 'all good' : symNoun(e.type)}`, { undo: () => restoreSymptom(key, e) });
}

function symptomPill(e, c) {
  const lvl = e.type === 'all_good' ? 'good' : e.sev >= 3 ? 'bad' : e.sev === 2 ? 'warn' : 'mild', t = clock(e.ts, c.key, c.today);
  const label = e.type === 'all_good' ? 'All good' : symLabel(e.type);
  return h('span', { class: 'bd-pill ' + lvl },
    t ? h('i', { class: 't' }, t) : null, h('b', null, label), e.type === 'all_good' ? null : sevDots(e.sev),
    h('button', { class: 'bd-x', 'aria-label': `Remove ${label}${e.sev ? ', ' + (SEV_LABEL[e.sev] || '').toLowerCase() : ''}`, onClick: () => dropSymptom(c, e) }, icon('x', 14)));
}

// What was eaten in the last 3 h (today only): the food names plus the trigger tags the pattern finder links to symptoms.
function recentMeals(key, today) {
  if (key !== today) return null;
  const now = Date.now(), since = now - 3 * 3600000;
  return (dayIfAny(key)?.food || []).filter((e) => okTs(e.ts) && e.ts >= since && e.ts <= now + 60000);
}
function ateRow(meals, c) {
  if (!meals.length) return mk('bd-ate none', icon('clock', 14), h('span', null, 'Nothing logged in the last 3 h.'), h('button', { class: 'bd-linkbtn', onClick: () => c.ctx.go('food') }, 'Add a meal'));
  const names = [...new Set(meals.map((e) => e.name).filter(Boolean))];
  const tags = [...new Set(meals.flatMap((e) => e.triggers || []))].filter((tg) => TAG_LABELS[tg]);
  return mk('bd-ate', mk('bd-ate-l', icon('clock', 14), 'On your plate in the last 3 h'),
    mk('bd-tags', names.slice(0, 3).map((nm) => h('span', { class: 'bd-tag food' }, nm)), names.length > 3 ? h('span', { class: 'bd-tag' }, `+${names.length - 3} more`) : null, tags.slice(0, 4).map((tg) => h('span', { class: 'bd-tag trig' }, TAG_LABELS[tg]))));
}

function stomachSection(c) {
  const { key, today } = c;
  const slot = sec('stomach', key === today ? 'Right now' : 'Symptoms that day');
  const paint = (animate) => {
    const body = stomachCard(c, () => paint(true));
    slot.querySelector('.bd-stomach')?.remove(); slot.append(body);
    const sevEl = body.querySelector('.bd-sev');
    if (animate && sevEl) { rise(sevEl, 6); sevEl.scrollIntoView({ block: 'nearest', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }); } // scroll-margin keeps it clear of the tab bar
  };
  paint(false);
  return slot;
}

function stomachCard(c, repaint) {
  const { key, today, ui } = c;
  const list = (dayIfAny(key)?.symptoms || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const meals = recentMeals(key, today);
  const card = h('div', { class: 'card bd-stomach' });
  card.append(mk('bd-qrow', h('h3', null, 'How do you feel after eating?'), list.length ? h('span', { class: 'pill accent' }, `${list.length} logged`) : null));
  if (meals) card.append(ateRow(meals, c));
  const pick = (id) => { if (id === 'all_good') { ui.pending = null; addSymptom(c, 'all_good', 0); } else { ui.pending = ui.pending === id ? null : id; haptic(); repaint(); } };
  card.append(mk('bd-chips', STOMACH.map((s) => h('button', { class: 'bd-chip' + (s.id === 'all_good' ? ' good' : '') + (ui.pending === s.id ? ' on' : ''), 'aria-pressed': ui.pending === s.id ? 'true' : 'false', onClick: () => pick(s.id) }, s.label))));
  if (ui.pending) {
    card.append(mk('bd-sev', h('div', { class: 'strong' }, `How strong is the ${symNoun(ui.pending)}?`),
      mk('bd-sevs', SEV.map((s) => h('button', { class: 'bd-sevb sev' + s.v + ' pressable', onClick: () => { const tp = ui.pending; ui.pending = null; addSymptom(c, tp, s.v); } }, sevDots(s.v), h('span', null, s.label)))),
      h('button', { class: 'btn sm ghost bd-cancel', onClick: () => { ui.pending = null; repaint(); } }, 'Cancel')));
  }
  card.append(list.length
    ? mk('bd-pills', list.map((e) => symptomPill(e, c)))
    : mk('bd-quiet', spot('bowl', 'var(--c)'), h('p', null, 'Nothing logged yet. Tap how you feel 2 to 3 hours after a meal. Good days count too.')));
  return card;
}

// ---------- 3. Evening check-in ----------
const CK_FIELDS = ['energy', 'mood', 'hunger', 'cravings', 'stool', 'skin', 'headache', 'sleepQ'];
const SCALES = [
  { k: 'energy', label: 'Energy', q: 'Energy today', words: ['Drained', 'Low', 'Okay', 'Good', 'Buzzing'] },
  { k: 'mood', label: 'Mood', q: 'Mood', words: ['Low', 'Meh', 'Okay', 'Good', 'Great'] },
  { k: 'hunger', label: 'Hunger', q: 'Hunger between meals', words: ['Starving', 'Hungry', 'Just right', 'Full', 'Stuffed'], hint: '3 means comfortably satisfied.' },
  { k: 'sleepQ', label: 'Sleep', q: 'Last night’s sleep quality', words: ['Poor', 'Restless', 'Okay', 'Good', 'Great'] },
];
const CRAVE = [{ v: 'none', label: 'None' }, { v: 'sweet', label: 'Sweet' }, { v: 'salty', label: 'Salty' }, { v: 'fried', label: 'Fried' }];
const BRISTOL = ['', 'Hard, separate lumps', 'Lumpy, sausage-shaped', 'Sausage with cracks', 'Smooth, soft sausage', 'Soft blobs, easy to pass', 'Mushy, fluffy pieces', 'Watery, no solid pieces'];
const stoolBand = (v) => (v <= 2 ? 'Hard' : v >= 6 ? 'Loose' : 'Ideal');
const SKIN = [{ v: 0, label: 'Clear' }, { v: 1, label: 'A few spots' }, { v: 2, label: 'Breakout' }];
const HEAD = [{ v: 0, label: 'None' }, { v: 1, label: 'Mild' }, { v: 2, label: 'Moderate' }, { v: 3, label: 'Strong' }];

// "Saved at 9:42 pm", or just "Saved" when the check-in has no usable timestamp (older / seeded ones) or was filed for another day.
function savedText(ck, key, today) {
  if (okTs(ck.ts) && dateKey(new Date(ck.ts)) === key && !(key !== today && isNoon(ck.ts))) return `Saved at ${fmtTime(ck.ts)}`;
  return 'Saved';
}

function meter(label, v, max = 5) {
  return mk('bd-m', h('b', { class: 'bd-m-n' }, v != null ? String(v) : '–'), pips(v != null ? v : 0, max), h('span', { class: 'bd-m-l' }, label));
}

function checkinSection(c) {
  const { key, today } = c;
  const ck = dayIfAny(key)?.checkin;
  const card = h('div', { class: 'card bd-ck' + (ck ? '' : ' accent') });
  if (!ck) {
    card.append(mk('bd-ck-empty', spot('moon', 'var(--sleep)'), mk('grow', h('h3', null, 'How was today?'), h('p', { class: 'small ink2' }, 'Five quick taps. The app links your answers to what you ate.')),
    ), h('button', { class: 'btn primary block bd-cta', onClick: () => checkinSheet(key, today) }, icon('check', 18), 'Check in'));
    return sec('checkin', 'Evening check-in', card);
  }
  const chipsRow = [];
  if (ck.cravings && ck.cravings !== 'none') chipsRow.push(h('span', { class: 'pill' }, `Craving: ${ck.cravings}`));
  if (ck.skin != null) chipsRow.push(h('span', { class: 'pill ' + (ck.skin ? 'warn' : '') }, SKIN.find((s) => s.v === ck.skin)?.label ? `Skin: ${SKIN.find((s) => s.v === ck.skin).label.toLowerCase()}` : 'Skin'));
  if (ck.headache) chipsRow.push(h('span', { class: 'pill warn' }, `Headache: ${(HEAD.find((s) => s.v === ck.headache)?.label || '').toLowerCase()}`));
  card.append(mk('bd-qrow', h('div', { class: 'grow' }, h('h3', null, savedText(ck, key, today)), h('div', { class: 'small muted' }, 'Your answers feed the food patterns below.')),
    h('button', { class: 'btn sm', onClick: () => checkinSheet(key, today) }, icon('edit', 16), 'Edit')));
  card.append(mk('bd-meters', SCALES.map((s) => meter(s.label, ck[s.k])), ck.stool != null ? mk('bd-m', h('b', { class: 'bd-m-n' }, String(ck.stool)), h('span', { class: 'bd-m-band ' + stoolBand(ck.stool).toLowerCase() }, stoolBand(ck.stool)), h('span', { class: 'bd-m-l' }, 'Stool')) : meter('Stool', null)));
  if (chipsRow.length) card.append(mk('bd-chips tight', chipsRow));
  if (ck.notes) card.append(h('p', { class: 'bd-quote' }, ck.notes));
  return sec('checkin', 'Evening check-in', card);
}

// Single-choice row. Tapping the selected option again clears it, so skipped questions stay unanswered (undefined).
function pickRow(options, draft, k, cls = '', onChange) {
  const row = h('div', { class: 'bd-pick ' + cls, role: 'group' });
  const paint = () => [...row.children].forEach((b, i) => { const on = draft[k] === options[i].v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  options.forEach((o) => row.append(h('button', { type: 'button', class: 'bd-opt', onClick: (e) => { if (draft[k] === o.v) delete draft[k]; else draft[k] = o.v; paint(); haptic(); if (draft[k] === o.v) pulse(e.currentTarget, { scale: 1.06, ms: 240 }); onChange && onChange(); } }, o.label)));
  paint();
  return row;
}
const question = (label, ctl, extra, right) => mk('bd-q', mk('bd-qh', h('div', { class: 'bd-ql' }, label), right || null), ctl, extra || null);

// A 1 to 5 scale as five big tappable cells; the chosen word shows beside the question.
function scaleRow(def, draft) {
  const word = h('span', { class: 'bd-word' }), row = h('div', { class: 'bd-scale', role: 'group', 'aria-label': def.q });
  const paint = () => {
    [...row.children].forEach((b, i) => { const on = draft[def.k] === i + 1; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    word.textContent = draft[def.k] ? def.words[draft[def.k] - 1] : '';
  };
  def.words.forEach((w, i) => row.append(h('button', { type: 'button', class: 'bd-sc', 'aria-label': `${i + 1}, ${w}`, onClick: (e) => { if (draft[def.k] === i + 1) delete draft[def.k]; else { draft[def.k] = i + 1; pulse(e.currentTarget, { scale: 1.1, ms: 260 }); } paint(); haptic(); } }, h('b', null, String(i + 1)))));
  paint();
  return question(def.q, row, mk('bd-ends', h('span', null, def.words[0]), def.hint ? h('span', { class: 'bd-hint' }, def.hint) : null, h('span', null, def.words[4])), word);
}

// Digestion: the Bristol scale (1 to 7) is what the pattern finder reads (hard 1-2, loose 6-7), so it keeps its 1-7 values.
function stoolRow(draft) {
  const note = h('div', { class: 'bd-hint' }), word = h('span', { class: 'bd-word' });
  const row = h('div', { class: 'bd-scale seven', role: 'group', 'aria-label': 'Digestion, Bristol stool type' });
  const none = h('button', { type: 'button', class: 'bd-opt', onClick: () => { if (draft.stool === null) delete draft.stool; else draft.stool = null; paint(); haptic(); } }, 'No stool today');
  const paint = () => {
    [...row.children].forEach((b, i) => { const on = draft.stool === i + 1; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    none.classList.toggle('on', draft.stool === null); none.setAttribute('aria-pressed', draft.stool === null ? 'true' : 'false');
    note.textContent = draft.stool ? BRISTOL[draft.stool] : ''; word.textContent = draft.stool ? stoolBand(draft.stool) : '';
  };
  for (let v = 1; v <= 7; v++) row.append(h('button', { type: 'button', class: 'bd-sc ' + (v <= 2 ? 'warn' : v >= 6 ? 'warn' : 'ok'), 'aria-label': `Type ${v}, ${BRISTOL[v]}`, onClick: (e) => { if (draft.stool === v) delete draft.stool; else { draft.stool = v; pulse(e.currentTarget, { scale: 1.1, ms: 260 }); } paint(); haptic(); } }, h('b', null, String(v))));
  paint();
  return question('Digestion', row, mk('bd-stoolfoot', mk('bd-ends', h('span', null, 'Hard'), h('span', null, 'Ideal 3 to 5'), h('span', null, 'Loose')), note, none), word);
}

function sleepHoursControl(extra, start) {
  const box = h('div');
  const show = () => { clear(box); box.append(h('div', { class: 'row' }, stepper({ value: extra.sleep, min: 0, max: 14, step: 0.5, onChange: (v) => { extra.sleep = v; } }), h('span', { class: 'muted' }, 'hours'))); };
  if (extra.sleep != null) show();
  else box.append(h('button', { type: 'button', class: 'btn sm', onClick: () => { extra.sleep = start; show(); } }, icon('plus', 16), 'Add hours slept'));
  return box;
}

function redFlagsBlock(flags) {
  return h('details', { class: 'bd-flags', open: flags.size > 0 }, h('summary', null, 'Anything worrying?'),
    h('p', { class: 'small muted' }, 'If any of these are true, please see a doctor. An app cannot judge them.'),
    RED_FLAGS.map((f) => h('label', { class: 'bd-flag' }, h('input', { type: 'checkbox', checked: flags.has(f), onChange: (e) => { if (e.target.checked) flags.add(f); else flags.delete(f); } }), f)));
}

function checkinSheet(key, today) {
  const d = dayIfAny(key) || {}, ck = d.checkin || {};
  const draft = { ...ck };
  const extra = { sleep: d.sleep > 0 ? d.sleep : null, steps: d.steps ?? null, notes: ck.notes || '', flags: new Set(d.redFlags || []) };
  const form = h('div', { class: 'bd-form' });
  for (const s of SCALES.slice(0, 3)) form.append(scaleRow(s, draft));
  form.append(scaleRow(SCALES[3], draft));
  form.append(stoolRow(draft));
  form.append(question('Cravings today', pickRow(CRAVE, draft, 'cravings')));
  form.append(question('Skin', pickRow(SKIN, draft, 'skin')));
  form.append(question('Headache', pickRow(HEAD, draft, 'headache')));
  form.append(question('Hours slept', sleepHoursControl(extra, state.profile?.sleepTarget || 7.5)));
  form.append(question('Steps today', h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 100000, placeholder: 'For example 6500', value: extra.steps ?? '', onInput: (e) => { const v = parseInt(e.target.value, 10); extra.steps = Number.isFinite(v) && v >= 0 ? v : null; } })));
  form.append(question('Notes', h('textarea', { rows: 3, maxlength: 500, placeholder: 'Poor night, stressful day, travel, new food…', value: extra.notes, onInput: (e) => { extra.notes = e.target.value; } })));
  form.append(redFlagsBlock(extra.flags));
  sheet({ title: `Check-in · ${fmtDateLabel(key, today)}`, content: form,
    actions: (api) => [h('button', { class: 'btn', onClick: api.close }, 'Cancel'), h('button', { class: 'btn primary', onClick: () => { saveCheckin(key, today, d, ck, draft, extra); api.close(); } }, 'Save')] });
}

function saveCheckin(key, today, d, ck, draft, extra) {
  const patch = {};
  for (const k of CK_FIELDS) if (k in draft || k in ck) patch[k] = draft[k]; // undefined clears an old answer
  const notes = extra.notes.trim();
  if (notes) patch.notes = notes; else if (ck.notes) patch.notes = undefined;
  const answered = Object.values(patch).some((v) => v !== undefined);
  let wrote = false;
  if (extra.sleep != null && extra.sleep !== d.sleep) day(key).sleep = extra.sleep;
  if (extra.steps !== (d.steps ?? null)) day(key).steps = extra.steps;
  const flags = RED_FLAGS.filter((f) => extra.flags.has(f)), before = d.redFlags || [];
  if (flags.length !== before.length || flags.some((f) => !before.includes(f))) { setRedFlags(key, flags); wrote = true; }
  // A past day's new check-in gets the noon stamp (metaFor); an existing one keeps the real time it was saved at.
  const keepTs = okTs(ck.ts) && dateKey(new Date(ck.ts)) === key;
  if (answered || d.checkin) { setCheckin(key, keepTs ? patch : metaFor(key, today, patch)); wrote = true; }
  if (!wrote) commit();
  haptic('success');
  toast(answered ? 'Check-in saved' : 'Saved', { kind: 'success' });
}

// ---------- 4. Habits ----------
function habitsSection(c) {
  const stack = mk('bd-stack');
  append(stack, [stepsCard(c), ...(c.p.smoker ? cigCards(c) : []), chaiCard(c), trackWater() ? waterCard(c) : null, sleepCard(c)]);
  return sec('habits', 'Habits', stack);
}

// ---- shared counter pieces ----
function bigCounter({ cls = '', minusLabel, mainLabel, count, has, onMinus, onAdd, onList, icoName, extra = '' }) {
  const minus = h('button', { class: 'bd-minus pressable', 'aria-label': minusLabel, disabled: !(has ?? count), onClick: () => { haptic('warn'); onMinus(); } }, icon('minus', 20));
  const main = h('button', { class: 'bd-add pressable ' + cls, onClick: (e) => { haptic(); onAdd(e); } }, icoName ? icon(icoName, 18) : null, h('span', { class: 'bd-add-l' }, mainLabel), count != null ? h('b', { class: 'bd-add-n' }, String(count)) : null);
  if (onList) longPress(main, onList);
  return mk('bd-ctr ' + extra, minus, main);
}

function entriesSheet(c, { title, rows }) {
  sheet({ title, content: () => {
    const box = h('div', { class: 'bd-ent' });
    const paint = () => {
      clear(box);
      const list = rows(paint);
      if (!list.length) { box.append(mk('bd-ent-empty', 'Nothing logged for this day yet.')); return; }
      for (const r of list) box.append(mk('bd-ent-row', h('span', { class: 'well ' + (r.cls || '') }, icon(r.ico || 'check')),
        mk('grow', h('div', { class: 'strong ellipsis' }, r.label), r.sub ? h('div', { class: 'small muted' }, r.sub) : null),
        r.remove ? h('button', { class: 'icon-btn plain', 'aria-label': `Remove ${r.label}`, onClick: r.remove }, icon('trash')) : h('span', { class: 'pill' }, 'Logged in Food')));
    };
    paint();
    return box;
  }, actions: (api) => [h('button', { class: 'btn primary', onClick: api.close }, 'Done')] });
}

// Habit entry helpers shared by every counter.
function addHabit(c, type, meta, msg) {
  const e = logHabit(c.key, type, metaFor(c.key, c.today, meta));
  toast(msg, { undo: () => removeHabit(c.key, e.id) });
  return e;
}
function dropLatest(c, type, label) {
  const e = latestOf(habitEntries(c.key, type));
  if (!e) return;
  removeHabit(c.key, e.id);
  toast(`Removed the last ${label}`, { undo: () => restoreHabit(c.key, e) });
}
function habitRows(c, types, labelOf, subOf, ico, cls) {
  return (paint) => types.flatMap((type) => habitEntries(c.key, type)).sort((a, b) => (b.ts || 0) - (a.ts || 0)).map((e) => ({
    ico: ico(e), cls: cls(e), label: labelOf(e), sub: subOf(e),
    remove: () => { removeHabit(c.key, e.id); haptic('warn'); toast(`Removed ${labelOf(e).toLowerCase()}`, { undo: () => { restoreHabit(c.key, e); paint(); } }); paint(); },
  }));
}

// ---- cigarettes: counter + ring, 30-day heat grid + habit strength, recovery timeline ----
const MILESTONES = [
  { min: 20, label: '20 min', text: 'Pulse normalises' }, { min: 480, label: '8 h', text: 'Carbon monoxide halves' },
  { min: 1440, label: '24 h', text: 'Heart-attack risk starts falling' }, { min: 2880, label: '48 h', text: 'Taste and smell improve' },
  { min: 4320, label: '72 h', text: 'Breathing gets easier' }, { min: 20160, label: '2 weeks', text: 'Circulation improves' },
  { min: 43200, label: '1 month', text: 'Lung function goes up' },
];
const leftText = (mins) => (mins >= 2880 ? `${Math.ceil(mins / 1440)} days` : mins >= 120 ? `${Math.ceil(mins / 60)} h` : `${Math.max(1, Math.ceil(mins))} min`);

// "2d 5h", "5h 12m", "42m" as number + small unit pairs.
function sinceParts(ts) {
  if (!okTs(ts)) return [['–', '']];
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000)), d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
  return d ? [[d, 'd'], [hh, 'h']] : hh ? [[hh, 'h'], [mm, 'm']] : [[mm, 'm']];
}
function sinceHero(box, ts, animate) {
  clear(box);
  box.classList.toggle('lit', okTs(ts) && Date.now() - ts > 3600000); // past the first hour the number wears the drifting gradient
  sinceParts(ts).forEach(([v, u], i) => {
    const el = h('span', null, String(v)); box.append(el, u ? h('small', null, u) : null);
    if (animate && typeof v === 'number') countUp(el, v, { key: `bd:since:${u}`, ms: 700 });
  });
}

function milestoneList(last, animate) {
  const mins = okTs(last) ? (Date.now() - last) / 60000 : 0, n = MILESTONES.length;
  const done = okTs(last) ? MILESTONES.filter((m) => mins >= m.min).length : 0, nextM = done < n ? MILESTONES[done] : null;
  const prevMin = done ? MILESTONES[done - 1].min : 0, frac = nextM && okTs(last) ? clamp((mins - prevMin) / (nextM.min - prevMin), 0, 1) : 0;
  const lit = !okTs(last) ? 0 : done >= n ? 1 : done === 0 ? 0 : (done - 1 + frac) / (n - 1);
  const rail = h('i', { style: { height: (lit * 100) + '%' } });
  if (animate && !seen('bd:rail') && canIntro()) { rail.style.transformOrigin = '50% 0'; rail.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 900, easing: EASE_OUT, fill: 'backwards' }); }
  remember('bd:rail');
  const sub = okTs(last) ? (nextM ? `Next: ${nextM.label}, ${nextM.text.toLowerCase()}, in ${leftText(nextM.min - mins)}` : 'Every milestone reached. Keep going.') : 'Counting starts from your next logged cigarette.';
  return mk('bd-tlw', mk('bd-tl-sub', icon('trophy', 15), h('span', null, okTs(last) ? `${done} of ${n} reached` : 'Recovery timeline'), h('small', null, sub)),
    mk('bd-tl', mk('bd-tl-rail', rail), h('ul', null, MILESTONES.map((m, i) => {
      const ok = i < done, isNext = i === done && okTs(last);
      const node = isNext ? gradRing({ size: 24, stroke: 3.5, pct: frac * 100, color: 'var(--accent)', color2: 'var(--accent-2)' }) : h('i', null, ok ? icon('check', 13) : null);
      return h('li', { class: (ok ? 'done' : isNext ? 'next' : '') }, h('span', { class: 'bd-tl-node' }, node), h('b', null, m.label), h('span', { class: 'grow' }, m.text));
    }))));
}

function paintSince(ui) {
  if (!ui.since) return;
  const last = lastHabitTs('cig');
  sinceHero(ui.since.big, last, false);
  clear(ui.since.list); ui.since.list.append(milestoneList(last, false));
}

// Days in a row (ending at key) with fewer cigarettes than the usual baseline. Stops at the first day the app has any record of.
function lowerStreak(key, baseline) {
  const first = firstLogKey();
  if (!baseline || !first) return 0;
  let n = 0, k = key;
  while (k >= first && n < 365 && habitCount(k, 'cig') < baseline) { n++; k = shiftDate(k, -1); }
  return n;
}
// Days in a row (ending at key) with zero cigarettes, counted only from the first log record onward.
function smokeFree(key) {
  const first = firstLogKey();
  if (!first) return 0;
  let n = 0, k = key;
  while (k >= first && n < 365 && habitCount(k, 'cig') === 0) { n++; k = shiftDate(k, -1); }
  return n;
}

function cigCards(c) {
  const { key, today, p, t, ui } = c;
  const n = habitCount(key, 'cig'), beaten = habitCount(key, 'craving'), lim = t.cigLimit || 0, base = p.cigBaseline || 0, last = lastHabitTs('cig');
  const first = firstLogKey();
  const used = Object.fromEntries(Object.entries(habitByDate('cig', 30, key)).filter(([k]) => first && k >= first));
  // a day that is still running has not "saved" anything yet: it counts toward what was spent, not toward what was avoided
  const dayOpen = key === today && new Date().getHours() < 20;
  const cs = dayOpen ? cigStats(Object.fromEntries(Object.entries(used).filter(([k]) => k !== key)), base, p.cigCost) : cigStats(used, base, p.cigCost);
  const spentAll = dayOpen ? cigStats(used, base, p.cigCost).moneySpent : cs.moneySpent;
  const wk = Object.entries(habitByDate('cig', 7, key)).filter(([k]) => first && k >= first).map(([, v]) => v), wkAvg = avg(wk), streak = lowerStreak(key, base);
  const free = smokeFree(key), sameRun = free >= 1 && free === streak; // same run: show smoke-free as the headline instead of "under usual"
  const label = key === today ? 'Today' : fmtDateLabel(key, today);

  // hero: since last
  const big = h('div', { class: 'bd-since-num num-lg' });
  const list = h('div', { class: 'bd-tl-host' });
  ui.since = { big, list };
  sinceHero(big, last, true);
  const lastTxt = okTs(last) ? `Last: ${dateKey(new Date(last)) === today ? 'today' : new Date(last).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}, ${fmtTime(last)}` : 'No cigarette logged yet';

  // ring: today's count against the limit
  const numEl = h('span', { class: 'num-md' });
  const center = h('span', { class: 'bd-ring-c' }, numEl, h('small', null, lim ? `of ${lim}` : 'no limit'));
  c.jobs.push(() => countUp(numEl, n, { key: `bd:cig:${key}`, ms: 700 }));
  if (changed(`bd:cigv:${key}`, n)) c.jobs.push(() => pop(center));
  const over = lim && n > lim, near = lim && n >= lim * 0.8 && n <= lim;
  const r = pRing(c, { id: 'cig', size: 112, stroke: 10, raw: lim ? (n / lim) * 100 : n ? 100 : 0, color: over ? 'var(--bad)' : near ? 'var(--warn)' : 'var(--cig)', children: center, delay: 120 });
  const ringBtn = h('button', { class: 'bd-ringbtn pressable', 'aria-label': `${label}: ${n} cigarettes${lim ? ` of ${lim}` : ''}. Show entries.`, onClick: () => cigEntries(c) }, r);

  const pills = [];
  if (over) pills.push(h('span', { class: 'pill bad' }, `${n - lim} over your limit`));
  else if (base) pills.push(n < base ? h('span', { class: 'pill good' }, dayOpen ? `${base - n} under usual so far` : `${base - n} fewer than usual`) : n === base ? h('span', { class: 'pill' }, 'Same as usual') : h('span', { class: 'pill bad' }, `${n - base} more than usual`));
  if (sameRun) pills.push(h('span', { class: 'pill good' }, `Smoke-free ${free} day${free > 1 ? 's' : ''}`));
  else { if (streak) pills.push(h('span', { class: 'pill good' }, `Under usual ${streak} day${streak > 1 ? 's' : ''} running`)); if (free >= 1) pills.push(h('span', { class: 'pill good' }, `Smoke-free ${free} day${free > 1 ? 's' : ''}`)); }

  const tiles = [mk('bd-stat', h('div', { class: 'num-sm' }, wkAvg != null ? n1(wkAvg) : '–', h('small', null, ' a day')), h('div', { class: 'micro muted' }, base ? `7-day avg, usual ${base}` : '7-day average'),
    wkAvg != null && base ? h('span', { class: 'bd-delta ' + (wkAvg <= base ? 'good' : 'bad') }, icon(wkAvg <= base ? 'arrowDown' : 'arrowUp', 12), `${Math.abs(Math.round((1 - wkAvg / base) * 100))}%`) : null)];
  if (p.cigCost) tiles.push(mk('bd-stat', h('div', { class: 'num-sm good' }, '₹ ', fmt(cs.moneySaved)), h('div', { class: 'micro muted' }, 'saved, 30 days')), mk('bd-stat', h('div', { class: 'num-sm' }, '₹ ', fmt(spentAll)), h('div', { class: 'micro muted' }, 'spent, 30 days')));

  const counter = h('div', { class: 'card hero bd-cig' }, head('cig', 'cig', 'Cigarettes', h('button', { class: 'icon-btn plain', 'aria-label': 'Show today’s entries', onClick: () => cigEntries(c) }, icon('list'))),
      mk('bd-hero', mk('bd-hero-l', h('div', { class: 'bd-cap' }, 'Since last'), big, h('div', { class: 'small muted' }, lastTxt)), mk('bd-hero-r', ringBtn, h('div', { class: 'bd-cap center' }, label))),
      pills.length ? mk('bd-chips tight', pills) : null,
      bigCounter({ minusLabel: 'Remove the last cigarette', mainLabel: '+1 cigarette', count: n, onMinus: () => dropLatest(c, 'cig', 'cigarette'), onList: () => cigEntries(c), icoName: null,
        onAdd: () => { addHabit(c, 'cig', {}, `Cigarette ${n + 1} ${key === today ? 'today' : 'that day'}${lim ? ` · limit ${lim}` : ''}`); } }),
      bigCounter({ cls: 'win', minusLabel: 'Remove the last beaten craving', mainLabel: 'Craving beaten', count: beaten, onMinus: () => dropLatest(c, 'craving', 'beaten craving'), onList: () => cigEntries(c), icoName: 'check',
        onAdd: () => { addHabit(c, 'craving', {}, 'Craving beaten. Nice one.'); haptic('success'); } }),
      mk('bd-stats n' + tiles.length, tiles));

  const hist = h('div', { class: 'card bd-cig-hist' }, head('flame', 'good', 'Last 30 days'), heatGrid(c, base, lim, first), strengthBlock(c, base, lim));
  const rec = h('div', { class: 'card bd-cig-rec' }, head('trophy', 'good', 'Recovery'), list);
  list.append(milestoneList(last, true));
  return [tagCard(counter, 'cig'), hist, rec];
}

function cigEntries(c) {
  entriesSheet(c, { title: `Cigarettes · ${fmtDateLabel(c.key, c.today)}`, rows: habitRows(c, ['cig', 'craving'],
    (e) => (e.type === 'cig' ? 'Cigarette' : 'Craving beaten'), (e) => clock(e.ts, c.key, c.today) || (c.key === c.today ? '' : 'Logged for this day'), (e) => (e.type === 'cig' ? 'cig' : 'check'), (e) => (e.type === 'cig' ? 'cig' : 'good')) });
}

// 30-day heat grid, Loop style: columns are weekdays (Mon first), rows are weeks, colour strength = cigarettes that day.
function heatGrid(c, base, lim, first) {
  const { key, today } = c, days = lastNDays(30, key);
  const lead = (new Date(days[0] + 'T12:00:00').getDay() + 6) % 7;
  const cap = h('div', { class: 'bd-cap' }, 'Tap a day to see it');
  const cells = [];
  const grid = h('div', { class: 'bd-heat', role: 'img', 'aria-label': 'Cigarettes per day for the last 30 days' });
  ['M', 'T', 'W', 'T', 'F', 'S', 'S'].forEach((l) => grid.append(h('span', { class: 'bd-hd' }, l)));
  for (let i = 0; i < lead; i++) grid.append(h('i', { class: 'bd-hc gap' }));
  let run = 0, best = 0;
  for (const k of days) {
    const known = !!first && k >= first, n = habitCount(k, 'cig');
    if (known && n === 0) { run++; best = Math.max(best, run); } else run = 0;
    const ratio = n / (base || lim || 4), lvl = ratio <= 0.34 ? 1 : ratio <= 0.67 ? 2 : ratio <= 1 ? 3 : 4;
    const cls = !known ? 'na' : n === 0 ? 'free' : 'l' + lvl + (lim && n > lim ? ' over' : '');
    const text = !known ? `${fmtDateLabel(k, today)}: no record yet` : `${fmtDateLabel(k, today)}: ${n === 0 ? 'smoke-free' : n + (n === 1 ? ' cigarette' : ' cigarettes')}`;
    const cell = h('div', { class: 'bd-hc ' + cls + (k === today ? ' today' : ''), 'aria-label': text, onPointerdown: () => { cap.textContent = text; cells.forEach((x) => x.classList.toggle('sel', x === cell)); haptic(); } }, !known ? null : n === 0 ? icon('check', 12) : String(n));
    cells.push(cell); grid.append(cell);
  }
  if (!seen('bd:heat') && canIntro()) c.jobs.push(() => cells.forEach((el, i) => el.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: Math.min(520, 240 + i * 9), easing: EASE_OUT, fill: 'backwards' })));
  remember('bd:heat');
  const legend = mk('bd-heat-key', h('span', null, h('i', { class: 'bd-hc free mini' }), 'Smoke-free'), h('span', null, 'Fewer', h('i', { class: 'bd-hc l1 mini' }), h('i', { class: 'bd-hc l2 mini' }), h('i', { class: 'bd-hc l3 mini' }), h('i', { class: 'bd-hc l4 mini' }), 'More'), lim ? h('span', null, h('i', { class: 'bd-hc l3 over mini' }), 'Over limit') : null);
  return mk('bd-heatw', cap, grid, legend, best ? h('div', { class: 'micro muted' }, `Best smoke-free run in this window: ${best} day${best > 1 ? 's' : ''}`) : null);
}

// Habit strength block (see strength() for the maths).
function strengthBlock(c, base, lim) {
  const goal = lim > 0 ? lim : base > 0 ? base - 1 : 0;
  const res = strength(c.key, (k) => { const n = habitCount(k, 'cig'); return n <= goal ? 1 : base && n <= base ? 0.5 : 0; });
  if (!res) return mk('bd-str', h('div', { class: 'small muted' }, 'Habit strength appears after your first logged day.'));
  const numEl = h('span', null);
  c.jobs.push(() => countUp(numEl, res.pct, { key: `bd:str:cig:${c.key}`, ms: 800 }));
  const bar = h('i', { style: { width: res.pct + '%' } });
  c.jobs.push(() => fill(bar, res.pct, { key: `bd:strbar:cig:${c.key}`, ms: 800 }));
  return mk('bd-str', mk('bd-str-top', mk('grow', h('div', { class: 'bd-cap' }, 'Habit strength'), h('div', { class: 'num-lg' }, numEl, h('small', null, '%'))), mk('bd-str-r', h('span', { class: 'pill accent' }, strengthWord(res.pct)), spark(res.series.slice(-30), { w: 96, hgt: 30, color: 'var(--accent)' }))),
    mk('bd-meter', bar),
    h('p', { class: 'small ink2 bd-str-note' }, goal ? `A day counts when you stay at ${goal} or fewer. ` : 'A day counts when you stay smoke-free. ', res.pct < 5 ? 'Each good day adds a little.' : `One slip costs about ${res.slip} point${res.slip > 1 ? 's' : ''}, not everything you built.`));
}

// ---- 7-day bars (tap a bar for its value). Heights animate from the last painted value. ----
function miniBars(c, { id, days, vals, target, tone, fmtV, note }) {
  const max = Math.max(target ? target * 1.18 : 0, ...vals, 1);
  const cap = h('div', { class: 'bd-bar-cap' }, note);
  const wrap = h('div', { class: 'bd-bars' });
  const cols = days.map((k, i) => {
    const v = vals[i], pct = v > 0 ? Math.max(5, (v / max) * 100) : 0;
    const bar = h('i', { class: (v <= 0 ? 'zero ' : '') + (target && v >= target ? 'hit' : ''), style: { height: pct + '%' } });
    c.jobs.push(() => fill(bar, pct, { axis: 'y', key: `bd:bar:${id}:${k}`, ms: 460, delay: i * 30 }));
    const col = h('button', { class: 'bd-col' + (k === c.today ? ' hl' : ''), 'aria-label': `${fmtDateLabel(k, c.today)}: ${fmtV(v)}`, onClick: () => { cap.textContent = `${fmtDateLabel(k, c.today)} · ${fmtV(v)}`; cols.forEach((x) => x.classList.toggle('sel', x === col)); haptic(); } },
      h('span', { class: 'bd-track', style: { '--tone': tone } }, bar), h('span', { class: 'bd-dow' }, fmtDow(k)[0]));
    return col;
  });
  append(wrap, cols);
  if (target) wrap.append(h('span', { class: 'bd-target', style: { top: (64 * (1 - target / max)) + 'px' }, 'aria-hidden': 'true' }));
  return mk('bd-barsw', wrap, cap);
}

// ---- chai & coffee ----
function sugarTsp(e) {
  const m = /(\d+(?:\.\d+)?)\s*tsp\s*sugar/i.exec(e.name || '');
  const per = m ? +m[1] : (e.triggers || []).includes('sugar') ? 1 : 0;
  const q = Number.isFinite(e.qty) && e.qty > 0 && e.qty <= 6 ? e.qty : 1; // qty above 6 is a gram amount, not cups
  return per * q;
}
const coffeeTotal = (key) => coffeeCount(key) + habitCount(key, 'coffee'); // coffee logged in Food + quick taps here

function chaiCard(c) {
  const { key, today, ctx } = c;
  const food = dayIfAny(key)?.food || [];
  const chai = chaiCount(key), coffeeQuick = habitCount(key, 'coffee'), coffee = coffeeTotal(key), total = chai + coffee;
  const logged = lastNDays(14, key).filter((k) => dayIfAny(k)?.food?.length);
  const avg14 = avg(logged.map((k) => chaiCount(k) + coffeeTotal(k)));
  const tsp = Math.round(food.filter((e) => isChai(e) || isCoffee(e)).reduce((a, e) => a + sugarTsp(e), 0) * 2) / 2;
  const late = food.some((e) => isChai(e) && okTs(e.ts) && new Date(e.ts).getHours() >= 16);
  const days = lastNDays(7, key), vals = days.map((k) => chaiCount(k) + coffeeTotal(k));
  const chaiN = h('span', { class: 'num-md' }), coffeeN = h('span', { class: 'num-md' });
  c.jobs.push(() => { countUp(chaiN, chai, { key: `bd:chai:${key}`, ms: 600 }); countUp(coffeeN, coffee, { key: `bd:coffee:${key}`, ms: 600 }); });
  const coffeeTile = mk('bd-cup', mk('bd-cup-top', h('span', { class: 'bd-cup-n' }, coffeeN), mk('grow', h('b', null, 'Coffee'), h('div', { class: 'micro muted' }, coffee === 1 ? '1 cup today' : `${coffee} cups today`))),
    bigCounter({ cls: 'sm', minusLabel: 'Remove the last coffee', mainLabel: '+1 cup', count: null, has: coffee > 0, onMinus: () => (coffeeQuick ? dropLatest(c, 'coffee', 'coffee') : toast('That coffee was logged in Food. Remove it there.')), onList: () => coffeeEntries(c),
      onAdd: () => addHabit(c, 'coffee', {}, `Coffee ${coffee + 1} ${key === today ? 'today' : 'that day'}`), extra: 'compact' }));
  if (changed(`bd:coffeev:${key}`, coffee)) c.jobs.push(() => pop(coffeeN));
  if (changed(`bd:chaiv:${key}`, chai)) c.jobs.push(() => pop(chaiN));
  const chaiTile = mk('bd-cup', mk('bd-cup-top', h('span', { class: 'bd-cup-n' }, chaiN), mk('grow', h('b', null, 'Chai'), h('div', { class: 'micro muted' }, chai === 1 ? '1 cup today' : `${chai} cups today`))),
    h('button', { class: 'btn bd-gofood pressable', 'aria-label': 'Log chai in Food', onClick: () => ctx.go('food') }, icon('plus', 18), 'Log chai', icon('right', 16)));
  const card = h('div', { class: 'card bd-chai' }, head('cup', 'chai', 'Chai & coffee', h('button', { class: 'icon-btn plain', 'aria-label': 'Show today’s coffee entries', onClick: () => coffeeEntries(c) }, icon('list'))),
    mk('bd-duo', chaiTile, coffeeTile),
    vals.some((v) => v > 0) ? miniBars(c, { id: 'cups', days, vals, tone: 'var(--chai)', fmtV: (v) => `${v} cup${v === 1 ? '' : 's'}`, note: avg14 != null ? `Last 7 days · 14-day average ${n1(avg14)} cups a day` : 'Last 7 days · the average shows after a few logged days' })
      : mk('bd-quiet', spot('bowl', 'var(--chai)'), h('p', null, 'Log chai in Food or tap +1 cup for coffee, and your week shows up here.')));
  if (tsp) card.append(h('div', { class: 'small bd-line' }, icon('target', 14), `About ${n1(tsp)} tsp sugar ${key === today ? 'today' : 'that day'}, ${total} cup${total === 1 ? '' : 's'} in all.`));
  if (late) card.append(h('div', { class: 'small bd-tip' }, icon('moon', 14), 'A chai after 4 pm can cost you deep sleep. Try the last one before 4.'));
  return tagCard(card, 'chai');
}
function coffeeEntries(c) {
  const inFood = (dayIfAny(c.key)?.food || []).filter(isCoffee);
  entriesSheet(c, { title: `Coffee · ${fmtDateLabel(c.key, c.today)}`, rows: (paint) => [
    ...habitRows(c, ['coffee'], () => 'Coffee', (e) => clock(e.ts, c.key, c.today) || '', () => 'cup', () => 'chai')(paint),
    ...inFood.map((e) => ({ ico: 'cup', cls: 'chai', label: e.name || 'Coffee', sub: clock(e.ts, c.key, c.today) || '', remove: null })),
  ] });
}

// ---- water ----
function waterCard(c) {
  const { key, today, t } = c;
  const glass = state.settings.glassMl || 250, glasses = t.water || 8, goal = glasses * glass, ml = waterMl(key);
  const days = lastNDays(7, key), vals = days.map((k) => waterMl(k)), wkAvg = avg(vals.filter((v) => v > 0));
  const numEl = h('span', { class: 'num-md' }), lf = (v) => String(+(v / 1000).toFixed(2));
  const center = h('span', { class: 'bd-ring-c' }, numEl, h('small', null, `of ${lf(goal)} L`));
  c.jobs.push(() => countUp(numEl, ml, { key: `bd:water:${key}`, ms: 700, fmt: lf }));
  if (changed(`bd:waterv:${key}`, ml)) c.jobs.push(() => pop(center));
  const r = pRing(c, { id: 'water', size: 112, stroke: 10, raw: (ml / goal) * 100, color: ml >= goal ? 'var(--good)' : 'var(--water)', color2: ml >= goal ? undefined : 'var(--accent)', children: center, delay: 80 });
  const done = Math.floor(ml / glass), part = ml / glass - done, tally = Math.max(glasses, Math.ceil(ml / glass));
  const tallyEl = mk('bd-glasses' + (tally > 10 ? ' many' : ''), Array.from({ length: tally }, (_, i) => h('i', { class: i < done ? 'on' : i === done && part > 0.01 ? 'half' : '' })));
  const str = strength(key, (k) => clamp(waterMl(k) / goal, 0, 1));
  const strPill = str ? h('span', { class: 'pill accent', title: 'Average of daily results with a 13-day half-life' }, `Habit strength ${str.pct}%`) : null;
  const addL = (m) => addHabit(c, 'water', { ml: m }, `Water: ${lf(ml + m)} L`);
  const card = h('div', { class: 'card bd-water' }, head('drop', 'water', 'Water', h('button', { class: 'icon-btn plain', 'aria-label': 'Show today’s water entries', onClick: () => waterEntries(c) }, icon('list'))),
    mk('bd-hero compact', mk('bd-ringbtn', r), mk('bd-hero-l', h('div', { class: 'bd-cap' }, `${fmt(ml / glass, 1)} of ${glasses} glasses · 1 glass = ${glass} ml`), tallyEl, strPill ? mk('bd-pillrow', strPill) : null)),
    mk('bd-ctr3', h('button', { class: 'bd-minus pressable', 'aria-label': 'Remove the last water entry', disabled: !habitEntries(key, 'water').length, onClick: () => { haptic('warn'); dropLatest(c, 'water', 'water entry'); } }, icon('minus', 20)),
      (() => { const b = h('button', { class: 'bd-add pressable water', onClick: () => { haptic(); addL(glass); } }, icon('plus', 18), h('span', { class: 'bd-add-l' }, 'glass')); longPress(b, () => waterEntries(c)); return b; })(),
      h('button', { class: 'bd-add pressable water', onClick: () => { haptic(); addL(500); } }, icon('plus', 18), h('span', { class: 'bd-add-l' }, '500 ml'))),
    miniBars(c, { id: 'water', days, vals, target: goal, tone: 'var(--water)', fmtV: (v) => `${lf(v)} L`, note: wkAvg != null ? `Last 7 days · average ${lf(wkAvg)} L · dashed line is your goal` : 'Last 7 days · dashed line is your goal' }));
  return tagCard(card, 'water');
}
function waterEntries(c) {
  entriesSheet(c, { title: `Water · ${fmtDateLabel(c.key, c.today)}`, rows: habitRows(c, ['water'], (e) => `Water ${e.ml || state.settings.glassMl || 250} ml`, (e) => clock(e.ts, c.key, c.today) || '', () => 'drop', () => 'water') });
}

// ---- sleep: inline hours stepper with an explicit Save, so a hold-to-repeat tap never fights a redraw ----
function sleepCard(c) {
  const { key, p, ui } = c;
  const target = p.sleepTarget || 7.5, d = dayIfAny(key), saved = d?.sleep > 0 ? d.sleep : null;
  const days = lastNDays(7, key), vals = days.map((k) => dayIfAny(k)?.sleep || 0), logged = vals.filter((v) => v > 0), mean = avg(logged);
  let draft = ui.sleepDraft && ui.sleepDraft.key === key ? ui.sleepDraft.v : saved ?? target;
  const dirty = () => saved == null || draft !== saved;
  const saveBtn = h('button', { class: 'btn primary bd-save', disabled: !dirty(), onClick: () => {
    const prev = d?.sleep ?? null; day(key).sleep = draft; ui.sleepDraft = null; commit(); haptic('success');
    toast(`Sleep saved: ${n1(draft)} h`, { undo: () => { day(key).sleep = prev; commit(); } });
  } }, saved != null && !dirty() ? 'Saved' : 'Save');
  const stp = stepper({ value: draft, min: 0, max: 14, step: 0.5, onChange: (v) => { draft = v; ui.sleepDraft = { key, v }; saveBtn.disabled = !dirty(); saveBtn.textContent = dirty() ? 'Save' : 'Saved'; } });
  const status = saved == null ? null : saved >= target - 0.25 ? h('span', { class: 'pill good' }, icon('check', 12), 'On target') : h('span', { class: 'pill warn' }, `${n1(target - saved)} h short`);
  const numEl = h('span', null);
  c.jobs.push(() => countUp(numEl, saved || 0, { key: `bd:sleep:${key}`, ms: 700, fmt: (v) => (saved == null ? '–' : n1(v)) }));
  const q = d?.checkin?.sleepQ;
  const card = h('div', { class: 'card bd-sleep' }, head('moon', 'sleep', 'Sleep'),
    mk('bd-sl-top', mk('grow', saved == null ? mk('bd-sl-none', h('b', null, 'Not logged yet'), h('div', { class: 'small muted' }, `Aim for ${n1(target)} h. Set the hours below.`)) : h('div', { class: 'num-lg' }, numEl, h('small', null, ` h of ${n1(target)} h`)), q != null ? mk('bd-sl-q', h('span', { class: 'micro muted' }, 'Quality'), pips(q, 5), h('span', { class: 'micro muted' }, `${q}/5`)) : null), status),
    mk('bd-sl-in', stp, saveBtn),
    logged.length >= 2 ? miniBars(c, { id: 'sleep', days, vals, target, tone: 'var(--sleep)', fmtV: (v) => (v ? `${n1(v)} h` : 'not logged'), note: `Last 7 days · average ${n1(mean)} h · dashed line is your target` })
      : saved == null ? null : mk('bd-quiet', spot('moon', 'var(--sleep)'), h('p', null, 'Log your hours for a few nights and the week shows up here.')));
  return tagCard(card, 'sleep');
}

// ---- steps: the day's movement. Paste from the clipboard (an iPhone Shortcut puts the number there), tap a rough count, or type it. ----
// A web app cannot read Apple Health; stepsGuideSheet() explains the Shortcut that does the reading.
const SHORTCUT_URL = 'https://shivamsahugzp.github.io/shredlog/#today?steps=';
const quickSteps = (goal) => [...new Set([0.5, 0.75, 1, 1.25].map((m) => Math.round((goal * m) / 500) * 500))].filter((v) => v > 0);

// The first number in a piece of text ("6,543", "6543.0", "Steps: 6543"), or null when there is none or it is not a believable step count.
export function parseSteps(text) {
  const m = /\d[\d,]*(?:\.\d+)?/.exec(String(text == null ? '' : text));
  if (!m) return null;
  const n = Math.round(parseFloat(m[0].replace(/,/g, '')));
  return Number.isFinite(n) && n >= 0 && n <= 100000 ? n : null;
}

function setStepsUndoable(key, n, msg) {
  const prev = dayIfAny(key)?.steps ?? null;
  setSteps(key, n); haptic('success');
  toast(msg, { undo: () => { day(key).steps = prev; commit('habit'); } });
}

// Call this straight from a tap handler: clipboard.readText() needs the user gesture, and iOS shows its own "Paste" callout.
export async function pasteSteps(key) {
  if (!navigator.clipboard || !navigator.clipboard.readText) { toast('This browser cannot read the clipboard. Type the number instead.'); return false; }
  let text;
  try { text = await navigator.clipboard.readText(); }
  catch (e) { toast('Could not read the clipboard. Allow paste when asked, or type the number.'); return false; }
  const n = parseSteps(text);
  if (n == null) { toast('No step count on the clipboard. Run your Shortcut first, then tap Paste steps.'); return false; }
  setStepsUndoable(key, n, `Steps set to ${fmt(n)}`);
  return true;
}

function stepsCard(c) {
  const { key, p } = c;
  const goal = stepGoal(), d = dayIfAny(key) || {}, steps = d.steps || 0, kg = d.weight || p.weightKg || 70;
  const days = lastNDays(7, key), vals = days.map((k) => stepsOn(k)), wk = vals.filter((v) => v > 0), wkAvg = avg(wk);
  const pct = goal ? (steps / goal) * 100 : 0, reached = steps >= goal && steps > 0;
  const numEl = h('span', null), pctEl = h('span', null);
  c.jobs.push(() => { countUp(numEl, steps, { key: `bd:steps:${key}`, ms: 700, fmt: (v) => fmt(Math.round(v)) }); countUp(pctEl, Math.min(999, Math.round(pct)), { key: `bd:stepspct:${key}`, ms: 700 }); });
  if (changed(`bd:stepsv:${key}`, steps)) c.jobs.push(() => pop(numEl));
  const center = h('span', { class: 'bd-ring-c' }, h('span', { class: 'num-md' }, pctEl, h('small', null, '%')), h('small', null, 'of goal'));
  const r = pRing(c, { id: 'steps', size: 100, stroke: 10, raw: pct, color: reached ? 'var(--good)' : 'var(--p)', color2: reached ? undefined : 'var(--accent-2)', children: center, delay: 100 });
  const ringBtn = h('button', { class: 'bd-ringbtn pressable', 'aria-label': `${fmt(steps)} of ${fmt(goal)} steps. Edit steps and goal.`, onClick: () => stepsSheet(key) }, r);
  const str = strength(key, (k) => clamp(stepsOn(k) / goal, 0, 1));
  const pills = [];
  if (!steps) pills.push(h('span', { class: 'pill' }, 'Not logged yet'));
  else {
    pills.push(reached ? h('span', { class: 'pill good' }, icon('check', 12), 'Goal reached') : h('span', { class: 'pill accent' }, `${fmt(goal - steps)} to go`));
    pills.push(h('span', { class: 'pill', title: 'Estimate from your weight and a 0.75 m stride' }, icon('flame', 12), `About ${fmt(stepsKcal(steps, kg))} kcal walking`));
  }
  if (str) pills.push(h('span', { class: 'pill accent', title: 'Average of daily results with a 13-day half-life' }, `Habit strength ${str.pct}%`));
  const goalBtn = h('button', { class: 'pill bd-goalpill pressable', 'aria-label': `Daily goal ${fmt(goal)} steps. Change it.`, onClick: () => stepsSheet(key) }, icon('target', 12), `Goal ${fmt(goal)}`);
  const rough = h('div', { class: 'chips bd-qs', role: 'group', 'aria-label': 'Set a rough step count' }, quickSteps(goal).map((v) => h('button', { class: 'chip' + (steps === v ? ' on' : ''), 'aria-pressed': steps === v ? 'true' : 'false', 'aria-label': `Set steps to ${fmt(v)}`, onClick: () => { haptic(); setStepsUndoable(key, v, `Steps set to ${fmt(v)}`); } }, fmt(v))));
  const card = h('div', { class: 'card hero bd-steps' }, head('steps', 'train', 'Steps', goalBtn),
    mk('bd-steps-hero', mk('bd-steps-l', h('div', { class: 'bd-cap' }, key === c.today ? 'Today' : fmtDateLabel(key, c.today)), h('div', { class: 'num-xl bd-steps-big' }, numEl), h('div', { class: 'bd-steps-unit' }, 'steps')), ringBtn),
    mk('bd-steps-pills', pills),
    mk('bd-steps-act',
      h('button', { class: 'btn primary bd-paste pressable', onClick: () => pasteSteps(key) }, icon('clipboard', 18), 'Paste steps'),
      h('button', { class: 'btn bd-type pressable', onClick: () => stepsSheet(key) }, icon('edit', 18), 'Type it')),
    h('div', { class: 'bd-cap bd-qs-cap' }, 'Or set a rough count'), rough,
    wk.length ? miniBars(c, { id: 'steps', days, vals, target: goal, tone: 'var(--p)', fmtV: (v) => (v ? `${fmt(v)} steps, about ${fmt(stepsKcal(v, kg))} kcal` : 'not logged'), note: `Last 7 days · average ${fmt(wkAvg)} · dashed line is your goal` })
      : mk('bd-quiet', spot('lens', 'var(--p)'), h('p', null, 'Paste or type today’s steps and your week shows up here.')),
    h('button', { class: 'bd-auto pressable', onClick: () => stepsGuideSheet(key) }, h('span', { class: 'well food' }, icon('zap')),
      mk('grow', h('b', null, 'Set up automatic steps'), h('div', { class: 'micro muted' }, 'An iPhone Shortcut copies the number for you')), icon('right', 18)));
  return tagCard(card, 'steps');
}

function stepsSheet(key) {
  const d = dayIfAny(key) || {}; let goal = stepGoal();
  const input = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 100000, placeholder: 'For example 6500', value: d.steps ?? '' });
  const fromClip = h('button', { type: 'button', class: 'btn sm bd-clipfill', onClick: async () => {
    if (!navigator.clipboard || !navigator.clipboard.readText) { toast('This browser cannot read the clipboard.'); return; }
    let text; try { text = await navigator.clipboard.readText(); } catch (e) { toast('Could not read the clipboard. Allow paste when asked.'); return; }
    const n = parseSteps(text); if (n == null) { toast('No step count on the clipboard.'); return; }
    input.value = String(n); haptic();
  } }, icon('clipboard', 16), 'Fill from clipboard');
  sheet({ title: 'Steps', content: h('div', { class: 'stack' },
    numField('Steps', input, 'Read it from the Health app, or let a Shortcut copy it for you.'), fromClip,
    numField('Daily goal', h('div', { class: 'row' }, stepper({ value: goal, min: 1000, max: 30000, step: 500, onChange: (v) => { goal = v; } }), h('span', { class: 'muted' }, 'steps')))),
  actions: (api) => [h('button', { class: 'btn', onClick: api.close }, 'Cancel'), h('button', { class: 'btn primary', onClick: () => {
    const v = parseInt(input.value, 10), prev = d.steps ?? null;
    if (Number.isFinite(v) && v >= 0) day(key).steps = v; else if (input.value === '' && d.steps != null) day(key).steps = null;
    state.settings.stepTarget = goal; commit('settings'); api.close(); haptic('success');
    toast('Steps saved', { undo: () => { day(key).steps = prev; commit(); } });
  } }, 'Save')] });
  setTimeout(() => { try { input.focus(); } catch (e) { /* ignore */ } }, 380);
}

// "Set up automatic steps": what the Shortcut does and how to build it. Also opened from Settings.
export function stepsGuideSheet(key = dateKey()) {
  const node = (ico, title, sub) => mk('bd-gnode', h('span', { class: 'well lg food' }, icon(ico, 22)), h('b', null, title), h('span', { class: 'micro muted' }, sub));
  const flow = mk('bd-gflow', node('heart', 'Health', 'Your phone counts the steps'), icon('right', 16), node('zap', 'Shortcut', 'Reads and copies the total'), icon('right', 16), node('steps', 'ShredLog', 'Paste it in one tap'));
  const copyUrl = () => { try { navigator.clipboard.writeText(SHORTCUT_URL).then(() => toast('Link copied'), () => toast('Could not copy. Press and hold the link to copy it.')); } catch (e) { toast('Could not copy. Press and hold the link to copy it.'); } };
  const step = (title, body, extra, opt) => h('li', null, h('span', { class: 'bd-gn' }, ''), mk('bd-gt', h('b', null, title, opt ? h('em', { class: 'pill' }, 'Optional') : null), h('p', null, body), extra || null));
  const list = h('ol', { class: 'bd-gsteps' },
    step('Make an automation', 'Open Shortcuts, then Automation, New Automation, Time of Day. Pick a time like 9 pm and choose Run Immediately.'),
    step('Read your steps', 'Add Find Health Samples: Type is Steps, Start Date is Today. Then add Calculate Statistics and choose Sum.'),
    step('Copy the total', 'Add Copy to Clipboard. Now the number is waiting for you.'),
    step('Open the app', 'Add Open URL with the link below and put the Sum right after “steps=”. It opens Safari, which keeps its data apart from the Home Screen icon, so skip this if you use the icon.',
      mk('bd-gurl', h('code', null, SHORTCUT_URL), h('button', { class: 'btn sm', 'aria-label': 'Copy the link', onClick: copyUrl }, icon('copy', 16), 'Copy')), true),
    step('Fill it in', 'Open ShredLog from its icon and tap Paste steps, here or on Today. Safari may ask you to allow paste.'));
  [...list.children].forEach((li, i) => { li.querySelector('.bd-gn').textContent = String(i + 1); });
  sheet({ title: 'Automatic steps', content: mk('bd-g', flow, h('div', { class: 'callout info small' }, icon('info'), h('div', null, 'A web app cannot read Apple Health. A Shortcut can, and it hands the number over.')), list),
    actions: (api) => [h('button', { class: 'btn', onClick: api.close }, 'Close'), h('button', { class: 'btn primary', onClick: () => { pasteSteps(key).then((ok) => { if (ok) api.close(); }); } }, icon('clipboard', 18), 'Paste steps now')] });
}

// ---------- 5. Measurements ----------
const TAPE = [['waist', 'Waist'], ['chest', 'Chest'], ['arms', 'Arms'], ['thighs', 'Thighs'], ['hips', 'Hips'], ['neck', 'Neck']];
const DOWN_IS_GOOD = new Set(['waist', 'hips']);
const removeLabel = (key, today) => (key === today ? 'Remove today’s entry' : 'Remove this day’s entry');

function weightSheet(key, today) {
  const prev = dayIfAny(key)?.weight || null, ws = weights().filter((w) => w.date !== key);
  const ref = [...ws].reverse().find((w) => w.date < key) || ws[ws.length - 1] || null;
  let v = prev || latestWeight()?.kg || 70;
  const diff = h('div', { class: 'bd-wdiff' });
  const paint = () => { diff.textContent = ref ? `${signed(v - ref.kg)} kg vs ${n1(ref.kg)} kg on ${fmtShortDate(ref.date)}` : 'Your first weigh-in. Everything starts here.'; };
  paint();
  sheet({ title: 'Weigh in', content: (api) => h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Best first thing in the morning, after the loo, before chai. Same scale every time.'),
    h('div', { class: 'row', style: { justifyContent: 'center' } }, stepper({ value: v, min: 30, max: 250, step: 0.1, onChange: (x) => { v = x; paint(); } }), h('span', { class: 'muted' }, 'kg')), diff,
    prev ? h('button', { type: 'button', class: 'bd-rm', onClick: () => { api.close(); setWeight(key, null); toast('Weight entry removed', { undo: () => setWeight(key, prev) }); } }, removeLabel(key, today)) : null),
  actions: (api) => [h('button', { class: 'btn primary', onClick: () => { setWeight(key, v); api.close(); haptic('success'); toast(`Weight saved: ${n1(v)} kg`, { undo: () => setWeight(key, prev) }); } }, 'Save weight')] });
}

function measureSheet(key, today, focus) {
  const cur = { ...(dayIfAny(key)?.measurements || {}) };
  const hasAny = TAPE.some(([f]) => cur[f]);
  const inputs = TAPE.map(([f, label]) => {
    const latest = measurementSeries(f).slice(-1)[0];
    return [f, label, h('input', { type: 'number', inputmode: 'decimal', step: '0.1', min: 10, max: 300, placeholder: latest ? String(latest.v) : 'cm', value: cur[f] ?? '' }), latest];
  });
  const clearDay = (api) => { api.close(); setMeasurements(key, Object.fromEntries(TAPE.map(([f]) => [f, null]))); toast('Measurements removed', { undo: () => setMeasurements(key, cur) }); };
  sheet({ title: 'Measure', content: (api) => h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, 'Tape snug, not tight, on bare skin. Waist at the navel after breathing out. Same spots, same time of day.'),
    h('div', { class: 'grid-2' }, inputs.map(([, label, input, latest]) => numField(`${label} (cm)`, input, latest ? `Last ${n1(latest.v)} on ${fmtShortDate(latest.date)}` : null))),
    hasAny ? h('button', { type: 'button', class: 'bd-rm', onClick: () => clearDay(api) }, removeLabel(key, today)) : null),
  actions: (api) => [h('button', { class: 'btn', onClick: api.close }, 'Cancel'), h('button', { class: 'btn primary', onClick: () => {
    const m = {};
    for (const [f, , input] of inputs) { const v = parseFloat(input.value); if (Number.isFinite(v) && v >= 10 && v <= 300) m[f] = v; }
    api.close();
    if (Object.keys(m).length) { setMeasurements(key, m); haptic('success'); toast('Measurements saved', { undo: () => setMeasurements(key, Object.fromEntries(TAPE.map(([f]) => [f, cur[f] ?? null]))) }); }
  } }, 'Save measurements')] });
  if (focus) { const t = inputs.find(([f]) => f === focus); if (t) setTimeout(() => { try { t[2].focus(); } catch (e) { /* ignore */ } }, 380); }
}

// Waist change vs weight change between the first and last tape reading.
function waistNote(ws) {
  const a = ws[0], b = ws[ws.length - 1], all = weights();
  const near = (date) => all.reduce((best, w) => (!best || Math.abs(dt(w.date) - dt(date)) < Math.abs(dt(best.date) - dt(date)) ? w : best), null);
  const wa = near(a.date), wb = near(b.date), dW = wa && wb && wa.date !== wb.date ? wb.kg - wa.kg : null, dWaist = b.v - a.v;
  const text = `Since ${fmtShortDate(a.date)}: waist ${signed(dWaist)} cm${dW != null ? ` · weight ${signed(dW)} kg` : ''}`;
  return mk('bd-recomp', h('span', { class: 'small strong' }, text), dWaist <= -1 && dW != null && Math.abs(dW) <= 0.5 ? h('span', { class: 'pill good' }, icon('sparkle', 12), 'Recomping') : null);
}

function measuresSection(c) {
  const { key, today, p } = c;
  const lw = latestWeight(), ws = weights();
  const prevW = ws.length >= 2 ? ws[ws.length - 2] : null, delta = prevW ? ws[ws.length - 1].kg - prevW.kg : null;
  const dir = /^cut/.test(p.goal || '') ? -1 : p.goal === 'bulk' ? 1 : 0;
  const towards = delta != null && (dir === 0 ? Math.abs(delta) <= 0.3 : Math.sign(delta) === dir);
  const hasWeigh = !!(lw && lw.date);
  const numEl = h('span', null);
  c.jobs.push(() => countUp(numEl, lw ? lw.kg : 0, { key: `bd:wt:${key}`, ms: 800, fmt: (v) => (lw ? n1(v) : '–') }));
  const wBox = mk('bd-wt', mk('bd-wt-l', h('div', { class: 'bd-cap' }, hasWeigh ? 'Latest weight' : 'Starting weight'), h('div', { class: 'num-lg' }, numEl, h('small', null, ' kg')),
    delta != null ? h('div', { class: 'bd-delta big ' + (towards ? 'good' : 'flat') }, icon(delta > 0 ? 'arrowUp' : 'arrowDown', 13), `${signed(delta, 1).replace(/^[+−]/, '')} kg vs ${fmtShortDate(prevW.date)}`)
      : h('div', { class: 'small muted' }, hasWeigh ? `Weighed ${fmtShortDate(lw.date)}` : 'From your profile. Weigh in to start tracking.')),
    ws.length >= 2 ? mk('bd-wt-r', spark(ws.slice(-14).map((w) => w.kg), { w: 110, hgt: 44, color: 'var(--sleep)' }), h('div', { class: 'micro muted' }, `${signed(ws[ws.length - 1].kg - ws[0].kg)} kg since ${fmtShortDate(ws[0].date)}`)) : null);
  if (lw && changed(`bd:wtv:${key}`, lw.kg)) c.jobs.push(() => pop(numEl));

  const anyTape = TAPE.some(([f]) => measurementSeries(f).length);
  const tiles = TAPE.map(([f, label]) => {
    const s = measurementSeries(f), now = s.length ? s[s.length - 1].v : null, dd = s.length >= 2 ? now - s[0].v : null;
    const good = dd != null && DOWN_IS_GOOD.has(f) && dd < 0;
    return h('button', { class: 'bd-tile pressable', 'aria-label': `${label}${now != null ? ' ' + n1(now) + ' centimetres' : ''}. Edit.`, onClick: () => measureSheet(key, today, f) },
      h('div', { class: 'bd-cap' }, label), mk('bd-tile-v', h('span', { class: 'num-sm' }, now != null ? n1(now) : '–', now != null ? h('small', null, ' cm') : null)),
      dd != null ? mk('bd-tile-d', h('span', { class: 'bd-delta ' + (good ? 'good' : 'flat') }, icon(dd > 0 ? 'arrowUp' : dd < 0 ? 'arrowDown' : 'minus', 11), `${Math.abs(+dd.toFixed(1))}`), s.length >= 2 ? spark(s.slice(-8).map((x) => x.v), { w: 52, hgt: 20, color: good ? 'var(--good)' : 'var(--ink-2)' }) : null) : h('div', { class: 'micro muted' }, now != null ? 'First reading' : 'Tap to add'));
  });
  const waist = measurementSeries('waist');
  const card = h('div', { class: 'card bd-measure' }, head('scale', 'weight', 'Weight', h('button', { class: 'btn sm primary', onClick: () => weightSheet(key, today) }, 'Weigh in')), wBox,
    mk('bd-tapehead', h('h3', null, 'Tape'), h('button', { class: 'btn sm', onClick: () => measureSheet(key, today) }, icon('edit', 16), 'Measure')));
  if (anyTape) {
    card.append(mk('bd-tapes', tiles));
    if (waist.length >= 2) card.append(waistNote(waist));
    card.append(h('p', { class: 'small muted bd-note' }, 'Waist down and weight flat means you are recomping. Trust the tape.'));
  } else card.append(emptyBlock('tape', 'var(--sleep)', 'Measure your waist every week or two. The tape often moves before the scale does.', h('button', { class: 'btn primary', onClick: () => measureSheet(key, today, 'waist') }, icon('edit', 16), 'Take measurements')));
  return sec('measure', 'Measurements', card);
}

// ---------- 6. Patterns ----------
let patCache = { sig: '', res: null };
// symptomPatterns() runs permutation tests (random), so cache it: same data gives the same answer between redraws.
function patterns() {
  const sig = lastNDays(60).map((k) => { const d = dayIfAny(k); return d ? `${(d.food || []).length}.${(d.symptoms || []).length}.${d.checkin?.ts || 0}.${d.checkin ? Object.keys(d.checkin).length : 0}` : '-'; }).join('|') + '|' + Math.floor(Date.now() / 3600000);
  if (patCache.sig !== sig) {
    try { patCache = { sig, res: symptomPatterns(60) }; } catch (e) { console.error(e); patCache = { sig, res: { ready: false, covered: 0, patterns: [], protective: [], tooCommon: [] } }; }
  }
  return patCache.res;
}

// Generic tips from knowledge.symptomHints matched to the day's food triggers (tags) or food ids. Up to 3.
function generalTips(key) {
  const sh = state.data.knowledge?.symptomHints;
  if (!sh) return [];
  const food = dayIfAny(key)?.food || [], tags = new Set(), ids = new Map();
  for (const e of food) { (e.triggers || []).forEach((t) => tags.add(t)); if (e.foodId) ids.set(e.foodId, e.name); }
  const out = [], seenH = new Set();
  for (const hint of Array.isArray(sh) ? sh : Object.values(sh)) {
    const tr = hint.trigger || {}, tag = [].concat(tr.tags || []).find((t) => tags.has(t)), fid = [].concat(tr.foodIds || []).find((i) => ids.has(i));
    if (!hint.hint || (!tag && !fid) || seenH.has(hint.hint)) continue;
    seenH.add(hint.hint);
    out.push({ label: tr.label || (tag ? TAG_LABELS[tag] || tag : ids.get(fid)), text: hint.hint });
    if (out.length === 3) break;
  }
  return out;
}

const CONF = { early: ['warn', 'Early pattern', 1], repeating: ['good', 'Repeating', 2], strong: ['good', 'Strong', 3] };
function cmpRow(c, id, label, v, tone) {
  const bar = h('i', { style: { width: Math.round(v * 100) + '%', background: tone } });
  c.jobs.push(() => fill(bar, v * 100, { key: `bd:cmp:${id}`, ms: 500 }));
  return mk('bd-cmp', h('span', { class: 'small ellipsis' }, label), mk('bd-cmp-bar', bar), h('b', { class: 'small' }, Math.round(v * 100) + '%'));
}

function patternCard(c, p, i) {
  const [cls, label, lvl] = CONF[p.confidence] || CONF.early;
  return mk('bd-pat', mk('bd-pat-top', mk('bd-flow', h('span', { class: 'bd-tag trig' }, p.tagLabel), icon('right', 16), h('span', { class: 'bd-tag sym' }, p.symptomLabel)), h('span', { class: 'pill ' + cls }, pips(lvl, 3), label)),
    mk('bd-cmps', cmpRow(c, `a${i}`, 'When eaten', p.pT, 'var(--warn)'), cmpRow(c, `b${i}`, 'Other meals', p.pN, 'var(--good)')),
    h('div', { class: 'small' }, p.text), h('div', { class: 'small muted' }, p.caveat), mk('bd-pat-tip', icon('sparkle', 15), h('span', null, p.tip)));
}

function patternsSection(c) {
  const { key } = c, res = patterns(), card = h('div', { class: 'card bd-pats-card' });
  card.append(head('heart', 'food', 'Food patterns', res.ready ? h('span', { class: 'small muted' }, `${res.covered} days of check-ins`) : null));
  if (!res.ready) {
    const numEl = h('span', null); c.jobs.push(() => countUp(numEl, res.covered, { key: 'bd:cov', ms: 600 }));
    const r = pRing(c, { id: 'cov', size: 84, stroke: 9, raw: (res.covered / 14) * 100, color: 'var(--accent)', color2: 'var(--accent-2)', children: h('span', { class: 'bd-ring-c' }, h('span', { class: 'num-md' }, numEl), h('small', null, 'of 14')) });
    card.append(mk('bd-hero compact', mk('bd-ringbtn', r), mk('bd-hero-l', h('b', null, `${res.covered} of 14 days with check-ins`), h('p', { class: 'small ink2' }, 'After two weeks of check-ins the app looks for foods that keep showing up before bloating, gas, acidity, low energy or poor sleep.'))));
    const tips = generalTips(key);
    if (tips.length) append(card, [h('div', { class: 'bd-sub' }, 'General tips'), tips.map((t) => mk('bd-gtip', h('b', { class: 'small' }, t.label), h('div', { class: 'small' }, t.text)))]);
  } else {
    if (!res.patterns.length) card.append(emptyBlock('lens', 'var(--c)', 'No clear food pattern yet. That is good news, or it means more check-ins are needed.'));
    else card.append(mk('bd-pats', res.patterns.map((p, i) => patternCard(c, p, i))));
    const prot = [...new Set((res.protective || []).map((r) => r.tagLabel))];
    if (prot.length) card.append(h('div', { class: 'small muted bd-line' }, icon('check', 14), `Fewer problems after: ${prot.join(' · ')}`));
    if ((res.tooCommon || []).length) card.append(h('div', { class: 'small muted bd-line' }, icon('info', 14), `Eaten too often to judge: ${res.tooCommon.join(' · ')}`));
  }
  card.append(h('p', { class: 'small muted bd-note' }, 'These are patterns, not diagnoses. Try a two-week swap, then re-check. Don’t cut a whole food group on one pattern.'));
  return sec('patterns', 'Patterns', card);
}

// ---------- 7. Iron nudge ----------
function ironNudge({ key }) {
  const food = dayIfAny(key)?.food || [];
  const caf = food.filter((e) => (e.triggers || []).includes('caffeine')), iron = food.filter((e) => (e.micro?.iron || 0) >= 3);
  if (!caf.some((cf) => iron.some((f) => f !== cf && okTs(cf.ts) && okTs(f.ts) && Math.abs(cf.ts - f.ts) <= 3600000))) return null;
  return sec('iron', null, h('div', { class: 'callout' }, icon('info'), h('div', null, 'Chai within an hour of an iron-rich meal blocks a lot of the iron. Try a 1-hour gap or add lemon.')));
}
