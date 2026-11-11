// Train tab: home (today's plan, week, body builder, routines, history, exercise browser), muscle picker,
// live workout logger, finish + share card, exercise guide. Screen-specific CSS lives in css/train.css (tr-, bm-).
// The live logger never rebuilds inputs while the user types: update() only refreshes the clock, rest bar and header stats.
import { state, commit, startWorkout, finishWorkout, discardWorkout, deleteWorkout, findExercise, allExercises, searchExercises, addCustomExercise, allRoutines, saveRoutine, exerciseHistory, lastSetsFor, bestFor, latestWeight, workoutsOn, todayKey, dateKey, parseKey, lastNDays, uid } from '../state.js';
import { h, icon, sheet, actionSheet, toast, confirmSheet, promptSheet, chips, segmented, stepper, field, ring, append, clear, emptyState, fmt, fmtClock, fmtDateLabel, fmtShortDate, fmtTime, haptic } from '../ui.js';
import { countUp, fill, pop, pulse, odometer, swipeReveal, celebrate, prefersReducedMotion, quiet, EASE_OUT, EASE_SPRING } from '../motion.js';
import { metBurn, workoutVolume } from '../calc.js';
import { lineChart } from '../charts.js';
import { repRange, nextSuggestion, weeklyVolume, volumeByGroup, volumeStatus, MUSCLE_GROUPS } from '../insights.js';
import { bodyMap, bodyShapes, MUSCLE_LABELS, groupColor, muscleColor, catGroup, musclesForCats, viewFor } from './body-map.js';
import { weekPlans, weekThisWeek, weekStreak } from '../train-plan.js';

// ---------- constants ----------
const REST_CHOICES = [45, 60, 90, 120, 150, 180, 240];
const PLATES = [25, 20, 15, 10, 5, 2.5, 1.25];
const TYPES = [{ id: 'strength', label: 'Weights' }, { id: 'bodyweight', label: 'Bodyweight' }, { id: 'timed', label: 'Timed' }, { id: 'cardio', label: 'Cardio' }];
const FEEL = [{ id: 'easy', label: 'Easy' }, { id: 'good', label: 'Good' }, { id: 'hard', label: 'Hard' }, { id: 'exhausted', label: 'Exhausted' }];
// per exercise type: [field key, column label, keyboard]
const FIELDS = {
  strength: [['w', 'kg', 'decimal'], ['r', 'Reps', 'numeric']],
  bodyweight: [['w', '+kg', 'decimal'], ['r', 'Reps', 'numeric']],
  timed: [['w', 'kg', 'decimal'], ['sec', 'Sec', 'numeric']],
  cardio: [['min', 'Min', 'decimal'], ['km', 'Km', 'decimal']],
};
const NEED = { strength: ['r', 'reps'], bodyweight: ['r', 'reps'], timed: ['sec', 'seconds'], cardio: ['min', 'minutes or km'] };
const SET_TYPES = ['N', 'W', 'D', 'F'];
const SET_NAMES = { N: 'normal', W: 'warm-up', D: 'drop set', F: 'to failure' };
const EQUIP = [{ id: 'all', label: 'All' }, { id: 'barbell', label: 'Barbell' }, { id: 'dumbbell', label: 'Dumbbell' }, { id: 'machine', label: 'Machine' }, { id: 'cable', label: 'Cable' }, { id: 'bodyweight', label: 'Bodyweight' }, { id: 'kettlebell', label: 'Kettlebell' }, { id: 'smith', label: 'Smith' }, { id: 'band', label: 'Band' }];
const MY_ROUTINE_ID = 'routine_my_sessions';
const MOBILITY_PICKS = ['cat_cow', 'worlds_greatest_stretch', 'hip_flexor_stretch', 'thoracic_rotation', 'hamstring_stretch', 'childs_pose'];
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GROUP_ORDER = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Core'];
const PAGE = 30;

const ui = { hist: 8, ex: { q: '', cat: '', equip: 'all', n: PAGE } }; // browser memory that survives re-renders
let view = { draw() {} };   // set by render(): redraws the whole screen
let live = null;            // refs the 1-second tick refreshes (active workout only)
let timer = 0;
let lastW = 0;              // last weight typed, default for the plate calculator
let jobs = [];              // motion work queued while building, run once the new DOM is attached
let wake = null;            // screen wake lock while a workout is open

// ---------- small helpers ----------
const isNum = (v) => typeof v === 'number' && isFinite(v);
const numStr = (v) => (isNum(v) ? String(+v.toFixed(2)) : '');
const parseNum = (s) => { const v = parseFloat(String(s).replace(',', '.')); return isFinite(v) && v >= 0 ? v : null; };
const round25 = (v) => Math.round(v / 2.5) * 2.5;
const est = (w, r) => (w && r ? Math.round(w * (1 + r / 30) * 10) / 10 : 0); // same Epley maths as state.bestFor
const isWork = (s) => s.t !== 'W';
const fieldsOf = (type) => FIELDS[type] || FIELDS.strength;
const need = (type) => NEED[type] || NEED.strength;
const hasNeed = (type, s) => (type === 'cardio' ? s.min > 0 || s.km > 0 : s[need(type)[0]] > 0);
const isBlank = (type, s) => !fieldsOf(type).some(([k]) => s[k] != null);
const newSet = (type) => ({ k: uid(), t: 'N', done: false, ...Object.fromEntries(fieldsOf(type).map(([k]) => [k, null])) });
const entryFor = (ex, n = 3, extra = {}) => ({ exId: ex.id, name: ex.name, type: ex.type || 'strength', met: ex.met || 5, sets: Array.from({ length: n }, () => newSet(ex.type)), notes: '', ...extra });
const countSets = (w) => (w.exercises || []).reduce((n, e) => n + e.sets.filter((s) => s.done && isWork(s)).length, 0);
const volumeOf = (w) => workoutVolume({ exercises: (w.exercises || []).map((e) => ({ ...e, sets: e.sets.filter(isWork) })) });
const durOf = (w) => w.durationSec ?? Math.round(((w.end || w.start) - w.start) / 1000);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const exGroup = (ex) => catGroup(ex.cat) || MUSCLE_GROUPS[ex.muscles?.[0]] || null;
const exColor = (ex) => groupColor(exGroup(ex));
const hms = (sec) => { sec = Math.max(0, Math.round(sec)); const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60; return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`; };
const canAnim = () => !prefersReducedMotion() && typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';
const CAT_ORDER = ['Chest', 'Back', 'Shoulders', 'Biceps', 'Triceps', 'Forearms', 'Quads', 'Hamstrings', 'Glutes', 'Calves', 'Core', 'Full Body', 'Cardio', 'Mobility'];
const categories = () => [...new Set(allExercises().map((e) => e.cat))].filter(Boolean).sort((a, b) => (CAT_ORDER.indexOf(a) + 1 || 99) - (CAT_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
// "52 min", "1h 05m": durations in lists read better without seconds
const durShort = (sec) => { sec = Math.max(0, Math.round(sec)); const hh = Math.floor(sec / 3600), mm = Math.round((sec % 3600) / 60); return hh ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${Math.max(1, mm)} min`; };
const sectionOf = (title, body, link, cls = '') => h('section', { class: 'section ' + cls }, h('div', { class: 'section-head' }, h('h2', null, title), link), body);
const statCell = (label, value, unit) => h('div', { class: 'tr-stat' }, h('div', { class: 'tr-stat-v' }, h('span', null, value), unit ? h('small', null, unit) : null), h('div', { class: 'tr-stat-l' }, label));
const dayText = (key) => fmtDateLabel(key, todayKey());
const uniq = (a) => [...new Set(a)];

// fade + rise for a first-open moment; no-op under reduced motion
function rise(el, { delay = 0, y = 14, ms = 420, scale = 0.985 } = {}) {
  if (!el || !canAnim()) return;
  el.animate([{ opacity: 0, transform: `translateY(${y}px) scale(${scale})` }, { opacity: 1, transform: 'none' }], { duration: ms, delay, easing: EASE_OUT, fill: 'backwards' });
}
function popIn(el, delay = 0) {
  if (!el || !canAnim()) return;
  el.animate([{ transform: 'scale(0)', opacity: 0 }, { transform: 'scale(1.25)', opacity: 1, offset: 0.6 }, { transform: 'scale(1)', opacity: 1 }], { duration: 420, delay, easing: EASE_SPRING, fill: 'backwards' });
}
// run fn once `el` is on screen (below-the-fold sections play their moment when the user gets there)
function whenVisible(el, fn) {
  if (typeof IntersectionObserver === 'undefined') return fn();
  const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) { io.disconnect(); fn(); } }, { threshold: 0.25 });
  io.observe(el);
  setTimeout(() => { try { io.disconnect(); } catch (e) { /* ignore */ } }, 600000);
}
let introNow = false;     // true while the screen is being drawn for the first time (the first-open moment)
const intro = () => introNow;

function setLabel(ex, i) {
  const t = ex.sets[i].t || 'N';
  return t !== 'N' ? t : String(ex.sets.slice(0, i + 1).filter((s) => (s.t || 'N') === 'N').length);
}
// "60 × 10" (short, for the Previous column) or "60 kg × 10" (long)
function setText(type, s, long) {
  if (!s) return '';
  const n = numStr;
  if (type === 'cardio') return `${n(s.min) || '–'} ${long ? 'min' : 'm'} · ${n(s.km) || '–'} km`;
  if (type === 'timed') return `${s.w ? n(s.w) + (long ? ' kg × ' : ' × ') : ''}${n(s.sec) || '–'} ${long ? 'sec' : 's'}`;
  return s.w ? `${n(s.w)}${long ? ' kg' : ''} × ${n(s.r) || '–'}` : `${n(s.r) || '–'} reps`;
}
// Previous session split into warm-up and working sets, so row N compares with the same kind of set.
function prevSets(exId) { const all = lastSetsFor(exId); return { w: all.filter((s) => s.t === 'W'), n: all.filter(isWork) }; }
function prevFor(ex, i, prev) {
  const warm = ex.sets[i].t === 'W';
  const ord = ex.sets.slice(0, i).filter((s) => (s.t === 'W') === warm).length;
  return (warm ? prev.w : prev.n)[ord] || null;
}
// Coarse muscle groups a finished workout trained, most sets first.
function workoutGroups(w) {
  const n = new Map();
  for (const e of w.exercises || []) {
    const sets = (e.sets || []).filter((s) => s.done && isWork(s)).length; if (!sets) continue;
    const def = findExercise(e.exId); if (!def || def.cat === 'Mobility') continue;
    const g = exGroup(def); if (g) n.set(g, (n.get(g) || 0) + sets);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
}
// Muscle heat for a workout: primary muscle counts each set, helpers count half; 8 sets = full colour.
function workoutHeat(w) {
  const v = {};
  for (const e of w.exercises || []) {
    const def = findExercise(e.exId), n = (e.sets || []).filter((s) => s.done && isWork(s)).length; if (!def || !n) continue;
    (def.muscles || []).forEach((m, i) => { v[m] = (v[m] || 0) + n * (i === 0 ? 1 : 0.5); });
  }
  return Object.fromEntries(Object.entries(v).map(([m, x]) => [m, Math.min(1, x / 8)]));
}
const heatOf = (muscles) => Object.fromEntries(muscles.map((m) => [m, 1]));
const exerciseHeat = (ex) => Object.fromEntries((ex.muscles || []).map((m, i) => [m, i === 0 ? 1 : 0.45])); // primary strong, helpers softer
function miniMap(opts, cls = '') { const m = bodyMap(opts); m.classList.add('bm-compact'); if (cls) m.classList.add(cls); return m; }
const dotsFor = (groups, max = 3) => uniq(groups.map((g) => catGroup(g) || g)).slice(0, max).map((g) => h('i', { class: 'tr-gdot', style: `--gc:${groupColor(g)}`, title: g }));

// Most recent finished sets per exercise, built once per paint instead of once per row.
function lastIndex() {
  const m = new Map();
  for (const w of [...state.workouts].sort((a, b) => b.start - a.start)) for (const e of w.exercises || []) {
    if (m.has(e.exId)) continue;
    const sets = (e.sets || []).filter((s) => s.done && isWork(s));
    if (sets.length) m.set(e.exId, { date: dateKey(new Date(w.start)), sets });
  }
  return m;
}
function agoText(key) {
  const d = Math.round((parseKey(todayKey()) - parseKey(key)) / 864e5);
  if (d <= 0) return 'today'; if (d === 1) return 'yesterday'; if (d < 14) return `${d}d ago`;
  return d < 60 ? `${Math.round(d / 7)}w ago` : `${Math.round(d / 30)}mo ago`;
}
function bestSet(sets) {
  return sets.filter(isWork).reduce((b, s) => (!b || (s.w || 0) > (b.w || 0) || ((s.w || 0) === (b.w || 0) && (s.r || 0) > (b.r || 0)) ? s : b), null);
}
function lastGhost(ex, idx) {
  const l = idx.get(ex.id); if (!l) return null;
  return `${setText(ex.type, bestSet(l.sets) || l.sets[0], true)} · ${agoText(l.date)}`;
}

// ---------- progression hint ----------
function topReps(plan) {
  const range = /(\d+)\s*[-–]\s*(\d+)/.exec(plan?.reps || '');
  if (range) return +range[2];
  const one = /(\d+)/.exec(plan?.reps || '');
  return one ? +one[1] : 12;
}
function hintFor(ex) {
  if (ex.type !== 'strength' && ex.type !== 'bodyweight') return null;
  const hist = exerciseHistory(ex.exId, 3);
  if (!hist.length) return null;
  const work = hist[0].sets.filter(isWork), top = topReps(ex.plan);
  const loaded = ex.type === 'bodyweight' || work.every((s) => s.w > 0);
  if (loaded && work.length >= Math.min(ex.plan?.sets || 2, 3) && work.every((s) => (s.r || 0) >= top)) {
    return { cls: 'good', ico: 'arrowUp', text: `All sets hit ${top} last time. ${ex.type === 'bodyweight' ? 'Add a rep or weight' : 'Try +2.5 kg'}` };
  }
  if (hist.length === 3) {
    const b = hist.map((x) => bestSet(x.sets));
    if (b.every(Boolean) && b.every((s) => (s.w || 0) === (b[0].w || 0) && (s.r || 0) === (b[0].r || 0))) return { cls: 'warn', ico: 'swap', text: 'Stuck 3 sessions. Change the rep range or swap the exercise' };
  }
  return null;
}

// ---------- personal records ----------
// Compares a set with the best from before this workout (state.active.prBase) plus the earlier sets of this workout.
function checkPR(ex, s) {
  const base = ((state.active.prBase ||= {})[ex.exId] ||= bestFor(ex.exId));
  if (!(base.w || base.reps || base.sec || base.e1rm)) return null; // first time on this lift: nothing to beat yet
  const best = { w: base.w, e1rm: base.e1rm, reps: base.reps, sec: base.sec };
  for (const o of ex.sets) {
    if (o === s || !o.done || !isWork(o)) continue;
    best.w = Math.max(best.w, o.w || 0); best.e1rm = Math.max(best.e1rm, est(o.w, o.r)); best.reps = Math.max(best.reps, o.r || 0); best.sec = Math.max(best.sec, o.sec || 0);
  }
  const w = s.w || 0, r = s.r || 0;
  if (ex.type === 'timed') return s.sec > best.sec ? { kind: 'time', value: s.sec, text: `${s.sec} s` } : null;
  if (ex.type === 'cardio' || !r) return null;
  if (w > best.w) return { kind: 'weight', value: w, text: `${numStr(w)} kg` };
  const e = est(w, r);
  if (r <= 10 && e > best.e1rm) return { kind: 'e1rm', value: e, text: `e1RM ${numStr(e)} kg` };
  if (w >= best.w && r > best.reps) return { kind: 'reps', value: r, text: `${r} reps${w ? ' at ' + numStr(w) + ' kg' : ''}` };
  return null;
}
function applyPR(ex, s, silent) {
  const a = state.active;
  a.prs = (a.prs || []).filter((p) => p.k !== s.k); delete s.pr;
  const pr = s.done && isWork(s) ? checkPR(ex, s) : null;
  if (!pr) return null;
  s.pr = pr.kind; a.prs.push({ exId: ex.exId, name: ex.name, kind: pr.kind, value: pr.value, text: pr.text, k: s.k });
  if (!silent) toast(`New PR: ${ex.name} ${pr.text}`, { ms: 3200 });
  return pr;
}

// ---------- thumbnails + form guide ----------
// First demo photo when there is one (lazy, fades in), otherwise a muscle-group tinted tile. Offline the photo fails and the tile stays.
function thumb(ex, cls = '') {
  const box = h('span', { class: 'tr-thumb ' + cls, style: `--tc:${exColor(ex)}`, 'aria-hidden': 'true' }, icon(ex.type === 'cardio' ? 'zap' : 'dumbbell', 20));
  const url = Array.isArray(ex.img) ? ex.img[0] : null;
  if (url) { const img = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', onLoad: () => box.classList.add('ld'), onError: () => img.remove() }); box.append(img); }
  return box;
}

// What to chart for an exercise: estimated 1RM, else best reps, else longest hold.
function trendMode(ex, hist) {
  if (ex.type === 'timed') return 'sec';
  return hist.some((x) => x.sets.some((s) => est(s.w, s.r) > 0)) ? 'e1rm' : 'reps';
}
const TREND = { e1rm: ['Estimated 1RM', 'kg', (s) => est(s.w, s.r)], reps: ['Best reps in a set', 'reps', (s) => s.r || 0], sec: ['Longest hold', 'sec', (s) => s.sec || 0] };
function trendChart(ex, hist) {
  if (ex.type === 'cardio') return null;
  const [title, unit, val] = TREND[trendMode(ex, hist)];
  const points = hist.slice().reverse().map((x) => ({ x: fmtShortDate(x.date), y: Math.max(0, ...x.sets.filter(isWork).map(val)) })).filter((p) => p.y > 0);
  if (points.length < 2) return h('div', { class: 'small muted' }, 'Log this exercise in two workouts to see your trend.');
  const first = points[0].y, lastY = points[points.length - 1].y, d = lastY - first;
  return h('div', { class: 'card flat pad-s tr-trend' },
    h('div', { class: 'row between' }, h('div', { class: 'small strong' }, title), h('span', { class: 'pill ' + (d > 0 ? 'good' : d < 0 ? 'warn' : '') }, icon(d >= 0 ? 'arrowUp' : 'arrowDown', 12), `${d > 0 ? '+' : ''}${+d.toFixed(1)} ${unit}`)),
    lineChart({ series: [{ name: '', color: 'var(--accent-text)', dots: true, end: true, points }], fmtY: (v) => String(+v.toFixed(1)), unit: ' ' + unit, height: 140, area: true, label: `${title} over time` }));
}

// 16:10 panel. The two demo photos (start, end) alternate like a short clip with a story-style progress bar; tap pauses, then flips by hand.
// Reduced motion shows both side by side. Without photos it shows the body map with the primary muscle lit. Returns { el, stop }.
function formMedia(ex) {
  const urls = (Array.isArray(ex.img) ? ex.img : []).filter((u) => typeof u === 'string' && u).slice(0, 2);
  const tc = exColor(ex), primary = ex.muscles?.[0];
  let tm = 0;
  const stop = () => { clearTimeout(tm); tm = 0; };
  const placeholder = () => {
    const map = bodyMap({ heat: exerciseHeat(ex), view: primary ? viewFor(primary) : 'front' });
    map.classList.add('bm-compact');
    return h('div', { class: 'tr-media tr-ph', style: `--tc:${tc}` }, map,
      h('div', { class: 'tr-ph-txt' }, h('b', null, primary ? MUSCLE_LABELS[primary] || cap(primary) : ex.cat || 'Exercise'),
        h('span', null, 'No demo photos for this one. Follow the steps below or watch a form video.')));
  };
  if (!urls.length) return { el: placeholder(), stop };

  const reduced = prefersReducedMotion(), names = ['Start', 'End'];
  const wrap = h('div', { class: 'tr-media' + (reduced ? ' sbs' : ''), style: `--tc:${tc}` });
  let frames = [], cur = 0, paused = false;
  const bars = h('div', { class: 'tr-media-bars', 'aria-hidden': 'true' });
  const tag = h('span', { class: 'tr-media-tag', 'aria-hidden': 'true' });
  const ppIcon = h('span', { class: 'tr-media-pp-ic' });
  const MS = 1300;
  const paintBars = () => {
    clear(bars);
    frames.forEach((f, k) => bars.append(h('i', { class: k < cur ? 'full' : k === cur ? (paused ? 'cur hold' : 'cur') : '', style: `--ms:${MS}ms` }, h('b'))));
    tag.textContent = names[frames[cur] ? urls.indexOf(frames[cur].dataset.src) : 0] || '';
    clear(ppIcon); ppIcon.append(icon(paused ? 'play' : 'pause', 14));
  };
  const holdBar = () => { const b = bars.children[cur]; if (b) b.classList.add('hold'); clear(ppIcon); ppIcon.append(icon('play', 14)); };
  const schedule = () => { stop(); if (!paused && frames.length > 1 && !reduced) tm = setTimeout(() => { if (!wrap.isConnected) return stop(); show(cur + 1); }, MS); };
  const show = (i) => { cur = (i + frames.length) % frames.length; frames.forEach((f, k) => f.classList.toggle('on', reduced || k === cur)); paintBars(); schedule(); };
  const drop = (frame) => {
    frames = frames.filter((f) => f !== frame); frame.remove();
    if (!frames.length) { stop(); wrap.replaceWith(placeholder()); return; }
    if (frames.length < 2) { stop(); wrap.classList.add('single'); }
    show(Math.min(cur, frames.length - 1));
  };
  frames = urls.map((u, i) => {
    const frame = h('div', { class: 'tr-frame', dataset: { src: u } }, h('img', { src: u, alt: `${ex.name}, ${names[i].toLowerCase()} position`, decoding: 'async', referrerpolicy: 'no-referrer', onError: () => drop(frame) }), reduced ? h('span', { class: 'tr-frame-tag' }, names[i]) : null);
    wrap.append(frame); return frame;
  });
  if (urls.length < 2) wrap.classList.add('single');
  if (!reduced && frames.length > 1) {
    const hit = h('button', { class: 'tr-media-hit', 'aria-label': 'Exercise demo. Tap to pause, tap again to flip between start and end position.', onClick: () => { if (!paused) { paused = true; stop(); holdBar(); } else show(cur + 1); } });
    const pp = h('button', { class: 'tr-media-pp', 'aria-label': 'Play or pause the demo', onClick: (e) => { e.stopPropagation(); paused = !paused; if (paused) { stop(); holdBar(); } else show(cur + 1); } }, ppIcon);
    wrap.append(bars, tag, hit, pp);
  }
  show(0);
  return { el: wrap, stop };
}

function detailSheet(exId, { inWorkout = false } = {}) {
  const ex = findExercise(exId);
  if (!ex) return toast('Exercise not found');
  const hist = exerciseHistory(exId, 20), best = bestFor(exId), last = hist[0];
  const media = formMedia(ex);
  const meta = [ex.equipment, ex.level, ex.mechanic, ex.force].filter(Boolean).map(cap);
  const steps = Array.isArray(ex.steps) ? ex.steps.filter(Boolean) : [];
  const list = (title, items, cls, ico) => (items?.length ? h('div', { class: 'tr-block' }, h('h3', { class: 'tr-sub' }, title), h('ul', { class: 'tr-cues ' + cls }, items.map((t) => h('li', null, icon(ico, 16), h('span', null, t))))) : null);
  const stats = [];
  if (best.e1rm) stats.push(statCell('Best e1RM', numStr(best.e1rm), 'kg'));
  if (best.w) stats.push(statCell('Heaviest', numStr(best.w), 'kg'));
  if (ex.type === 'bodyweight' && best.reps) stats.push(statCell('Best reps', best.reps));
  if (best.sec) stats.push(statCell('Best hold', best.sec, 's'));
  if (hist.length) stats.push(statCell('Sessions', hist.length));
  const muscles = ex.muscles || [];
  const map = muscles.length ? miniMap({ heat: exerciseHeat(ex), view: 'both' }, 'tr-detail-map') : null;
  sheet({
    title: ex.name, full: true,
    onClose: media.stop,
    content: h('div', { class: 'stack tr-detail' },
      media.el,
      meta.length ? h('div', { class: 'tr-metaline' }, meta.map((m) => h('span', { class: 'pill' }, m))) : null,
      stats.length ? h('div', { class: 'tr-stats' }, stats.slice(0, 4)) : h('div', { class: 'callout info small' }, icon('info'), h('div', null, 'Not logged yet. Your best lifts and a trend line will show here.')),
      last ? h('div', { class: 'card flat pad-s' }, h('div', { class: 'small muted' }, `Last session · ${dayText(last.date)}`), h('div', { class: 'strong tr-lastsets' }, last.sets.map((s) => h('span', null, setText(ex.type, s, true))))) : null,
      last ? trendChart(ex, hist) : null,
      muscles.length ? h('div', { class: 'tr-musrow' }, map, h('div', { class: 'tr-mus' }, h('h3', { class: 'tr-sub' }, 'Muscles worked'), muscles.map((m, i) => h('span', { class: 'tr-mus-chip' + (i === 0 ? ' pri' : ''), style: `--mc:${muscleColor(m)}` }, MUSCLE_LABELS[m] || cap(m), h('em', null, i === 0 ? 'main' : 'helper'))))) : null,
      steps.length ? h('div', { class: 'tr-block' }, h('h3', { class: 'tr-sub' }, 'How to'), h('ol', { class: 'tr-steps' }, steps.map((t) => h('li', null, h('span', null, t))))) : null,
      list('Coach cues', ex.cues, 'good', 'check'), list('Avoid', ex.mistakes, 'avoid', 'x'),
      h('a', { class: 'btn block tr-yt', href: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(ex.name + ' proper form'), target: '_blank', rel: 'noopener' }, icon('play', 18), 'Watch form videos on YouTube')),
    actions: state.active && !inWorkout ? (api) => h('button', { class: 'btn primary', onClick: () => { api.close(); addToWorkout(ex); } }, icon('plus'), 'Add to current workout') : undefined,
  });
}

// ---------- exercise rows, browser and add/replace picker ----------
const equipMatch = (ex, f) => f === 'all' || (f === 'bodyweight' ? ex.equipment === 'bodyweight' || ex.equipment === 'none' : ex.equipment === f);
// Name matches first (starts with, then contains), then keyword and muscle matches; stable otherwise.
function rankSearch(list, q) {
  const t = q.toLowerCase().trim().split(/\s+/).filter(Boolean); if (!t.length) return list;
  const score = (e) => { const n = e.name.toLowerCase(); return t.every((x) => n.startsWith(x) || n.includes(' ' + x)) ? 0 : t.every((x) => n.includes(x)) ? 1 : 2; };
  return list.map((e, i) => [score(e), i, e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
}
// One row: thumbnail, name, equipment + last best set. cfg: { select, isOn, order, onMain, info, chev }
function pickRow(ex, idx, cfg = {}) {
  const sub = [h('span', { class: 'pill' }, cap(ex.equipment || 'other'))];
  const primary = ex.muscles?.[0]; if (primary && !cfg.select) sub.push(h('span', { class: 'tr-ghost' }, MUSCLE_LABELS[primary] || cap(primary)));
  const g = lastGhost(ex, idx); if (g) sub.push(h('span', { class: 'tr-ghost tr-last' }, icon('clock', 11), g));
  const check = cfg.select ? h('span', { class: 'tr-check' }, icon('check', 16)) : null;
  const main = h('button', { class: 'tr-prow-main', 'aria-pressed': cfg.select ? (cfg.isOn() ? 'true' : 'false') : null },
    thumb(ex), h('div', { class: 'grow' }, h('div', { class: 'title' }, ex.name), h('div', { class: 'tr-prow-sub' }, sub)), check, cfg.chev ? icon('right', 18) : null);
  const el = h('div', { class: 'tr-prow' + (cfg.select && cfg.isOn() ? ' on' : '') }, main,
    cfg.info ? h('button', { class: 'icon-btn plain tr-info', 'aria-label': `Form guide for ${ex.name}`, onClick: () => detailSheet(ex.id) }, icon('info', 20)) : null);
  const sync = () => {
    const on = cfg.select && cfg.isOn();
    el.classList.toggle('on', !!on);
    main.setAttribute('aria-label', `${ex.name}${cfg.select ? (on ? '. Selected' : '. Not selected') : ''}`);
    if (check) { check.dataset.n = on && cfg.order ? String(cfg.order()) : ''; main.setAttribute('aria-pressed', on ? 'true' : 'false'); }
  };
  main.addEventListener('click', () => { cfg.onMain && cfg.onMain(ex, el); sync(); if (cfg.select && cfg.isOn() && check) pop(check, { ms: 380 }); });
  sync();
  return { el, sync };
}

// Search + category + equipment chips + list. mode 'browse' opens the guide; 'add' (single) and 'multi' pick for the workout.
function exercisePanel(f, { mode = 'browse', onPick, picked, onTogglePick } = {}) {
  const idx = lastIndex(), rows = new Map();
  const box = h('div', { class: 'tr-elist' }), count = h('div', { class: 'tr-count' });
  const paint = () => {
    const res = rankSearch(searchExercises(f.q, f.cat, 600).filter((e) => equipMatch(e, f.equip)), f.q);
    clear(box); rows.clear();
    count.textContent = res.length ? `${fmt(res.length)} exercise${res.length === 1 ? '' : 's'}` : '';
    if (!res.length) {
      return append(box, emptyState('No exercises found', f.q ? `Nothing matches "${f.q}".` : 'Try another filter.', h('button', { class: 'btn sm', onClick: () => customSheet(f.q, (ex) => { paint(); onPick && onPick(ex); }) }, icon('plus', 16), 'Create your own'), { ico: 'search' }));
    }
    const shown = res.slice(0, f.n);
    const list = h('div', { class: 'tr-plist-rows' }, shown.map((ex) => {
      const cfg = mode === 'browse' ? { onMain: () => detailSheet(ex.id), chev: true }
        : mode === 'multi' ? { select: true, isOn: () => picked.includes(ex.id), order: () => picked.indexOf(ex.id) + 1, onMain: () => { onTogglePick(ex); rows.forEach((r) => r.sync()); }, info: true }
          : { onMain: () => onPick(ex), info: true, chev: false };
      const r = pickRow(ex, idx, cfg); rows.set(ex.id, r); return r.el;
    }));
    append(box, list, res.length > f.n ? h('button', { class: 'btn sm block ghost', style: { marginTop: '8px' }, onClick: () => { f.n += PAGE; paint(); } }, `Show ${Math.min(PAGE, res.length - f.n)} more`) : null);
  };
  const input = h('input', { type: 'search', placeholder: 'Search 600 exercises', value: f.q, enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'none', 'aria-label': 'Search exercises', onInput: (e) => { f.q = e.target.value; f.n = PAGE; paint(); } });
  const cats = chips([{ id: '', label: 'All' }, ...categories().map((c) => ({ id: c, label: c }))], f.cat, (v) => { f.cat = v; f.n = PAGE; paint(); });
  const eq = chips(EQUIP, f.equip, (v) => { f.equip = v; f.n = PAGE; paint(); });
  paint();
  return h('div', { class: 'stack tr-panel' }, h('div', { class: 'search' }, icon('search'), input), cats, eq, count, box);
}
// Add (one or several) or replace an exercise in the live workout.
function pickExercise(title, cb, { multi = false, cat = '' } = {}) {
  const f = { q: '', cat, equip: 'all', n: PAGE }, picked = [];
  let btn;
  const sync = () => { if (!btn) return; btn.textContent = picked.length ? `Add ${picked.length} exercise${picked.length === 1 ? '' : 's'}` : 'Add exercises'; btn.disabled = !picked.length; };
  sheet({
    title, full: true,
    content: (api) => {
      if (multi) { btn = h('button', { class: 'btn primary lg block', disabled: true, onClick: () => { api.close(); picked.map(findExercise).filter(Boolean).forEach(cb); } }, 'Add exercises'); api.footer = btn; sync(); }
      return exercisePanel(f, multi ? { mode: 'multi', picked, onTogglePick: (ex) => { const i = picked.indexOf(ex.id); if (i >= 0) picked.splice(i, 1); else picked.push(ex.id); haptic(); sync(); } } : { mode: 'add', onPick: (ex) => { api.close(); cb(ex); } });
    },
    actions: multi ? (api) => api.footer : undefined,
  });
}
function customSheet(name, done) {
  const f = { name: name || '', cat: 'Full Body', type: 'strength' };
  sheet({
    title: 'New exercise',
    content: () => h('div', { class: 'stack' },
      field('Name', h('input', { type: 'text', value: f.name, placeholder: 'e.g. Landmine press', onInput: (e) => { f.name = e.target.value; } })),
      field('Muscle group', h('select', { onChange: (e) => { f.cat = e.target.value; } }, categories().map((c) => h('option', { value: c, selected: c === f.cat }, c)))),
      field('How do you log it?', segmented(TYPES, f.type, (v) => { f.type = v; }))),
    actions: (api) => h('button', { class: 'btn primary', onClick: () => {
      const nm = f.name.trim(); if (!nm) return toast('Give it a name first');
      const ex = addCustomExercise({ name: nm, cat: f.cat, type: f.type, muscles: [f.cat.toLowerCase()], met: f.type === 'cardio' ? 7 : 4, equipment: f.type === 'bodyweight' ? 'bodyweight' : 'other' });
      api.close(); done(ex);
    } }, 'Save exercise'),
  });
}

// ---------- routines ----------
function dayGroups(day) {
  const n = new Map();
  for (const d of day.exercises || []) { const ex = findExercise(d.ex); const g = ex && ex.cat !== 'Mobility' ? exGroup(ex) : null; if (g) n.set(g, (n.get(g) || 0) + (d.sets || 1)); }
  return [...n.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
}
function dayLines(day, max = 6) {
  const rows = day.exercises.map((d) => [findExercise(d.ex), `${d.sets} × ${d.reps}`]).filter((r) => r[0]);
  return h('div', { class: 'tr-lines' }, rows.slice(0, max).map(([ex, t]) => h('button', { class: 'tr-line', 'aria-label': `Form guide for ${ex.name}`, onClick: () => detailSheet(ex.id) },
    thumb(ex, 'sm'), h('span', { class: 'tr-line-name ellipsis' }, ex.name), h('span', { class: 'tr-line-t' }, t))),
  rows.length > max ? h('div', { class: 'small muted tr-more-l' }, `+ ${rows.length - max} more`) : null);
}
function startDay(r, idx) {
  if (state.active) return toast('Finish or discard your current workout first');
  const day = r.days[idx];
  const exercises = day.exercises.map((d) => { const ex = findExercise(d.ex); return ex && plannedEntry(ex, { n: d.sets || 3, plan: { reps: d.reps, restSec: d.restSec, sets: d.sets }, restSec: d.restSec }); }).filter(Boolean);
  if (!exercises.length) return toast('Could not find the exercises for that day');
  begin({ name: day.name, routineId: r.id, dayIndex: idx, exercises });
}
function advanceRoutine(w) {
  if (!w.routineId || w.routineId !== state.settings.currentRoutineId) return;
  const r = allRoutines().find((x) => x.id === w.routineId);
  if (!r?.days?.length) return;
  state.settings.routineDayIndex = ((w.dayIndex || 0) + 1) % r.days.length; commit('settings');
}
function routineSheet(r) {
  const cur = state.settings.currentRoutineId === r.id, mine = r.id === MY_ROUTINE_ID || r.custom;
  const removeDay = async (api, i) => {
    if (!(await confirmSheet(`Remove "${r.days[i].name}" from ${r.name}?`, { ok: 'Remove', danger: true, title: 'Remove day?' }))) return;
    const prev = r, days = r.days.filter((_, k) => k !== i); api.close();
    saveRoutine({ ...r, days, daysPerWeek: Math.max(1, Math.min(7, days.length)) });
    toast('Day removed', { undo: () => saveRoutine(prev), ms: 5000 });
  };
  sheet({
    title: r.name, full: true,
    content: (api) => h('div', { class: 'stack' },
      h('div', { class: 'row wrap' }, h('span', { class: 'pill' }, cap(r.level)), h('span', { class: 'pill' }, `${r.daysPerWeek} day${r.daysPerWeek === 1 ? '' : 's'} a week`), r.goal ? h('span', { class: 'pill accent' }, r.goal) : null),
      r.desc ? h('p', { class: 'small muted' }, r.desc) : null,
      r.days.map((d, i) => h('div', { class: 'tr-day', style: `--dc:${groupColor(dayGroups(d)[0])}` },
        h('div', { class: 'row between' }, h('div', { class: 'grow' }, h('h3', null, d.name), h('div', { class: 'micro muted' }, `${d.exercises.length} exercises · ${dayGroups(d).slice(0, 3).join(', ') || 'Mixed'}`)),
          mine ? h('button', { class: 'icon-btn plain', 'aria-label': `Remove ${d.name}`, onClick: () => removeDay(api, i) }, icon('trash', 18)) : null,
          h('button', { class: 'btn sm primary', onClick: () => { api.close(); startDay(r, i); } }, icon('play', 14), `Start`)),
        dayLines(d, 99)))),
    actions: (api) => h('button', { class: 'btn primary', disabled: cur, onClick: () => { state.settings.currentRoutineId = r.id; state.settings.routineDayIndex = 0; commit('settings'); api.close(); toast(`${r.name} is now your routine`); } }, cur ? 'Current routine' : 'Use this routine'),
  });
}

// ---------- starting a workout ----------
// Workout entry with planned reps from repRange and, when there is history, the weight nextSuggestion recommends.
function plannedEntry(ex, { n, plan, restSec } = {}) {
  const range = repRange(ex), hist = lastSetsFor(ex.id);
  const count = Math.max(1, Math.min(8, n || hist.filter(isWork).length || 3));
  const reps = plan?.reps || (range ? `${range[0]}-${range[1]}` : '');
  const entry = entryFor(ex, count, { plan: { sets: count, ...(reps ? { reps } : {}), ...(plan?.restSec ? { restSec: plan.restSec } : {}) }, ...(restSec ? { restSec } : {}) });
  if (ex.type === 'strength' || ex.type === 'bodyweight') {
    const sug = hist.length ? nextSuggestion(ex.id, reps) : null;
    if (sug && sug.weight > 0) entry.sets.forEach((s) => { s.w = sug.weight; });
  } else if (ex.type === 'timed' && hist.length) {
    entry.sets.forEach((s, i) => { const p = hist[i] || hist[hist.length - 1]; if (p?.sec) s.sec = p.sec; });
  }
  return entry;
}
const sessionName = (exs) => [...new Set(exs.map((e) => e.cat).filter((c) => c && c !== 'Mobility'))].slice(0, 3).join(' · ') || 'Workout';
function begin(w) {
  const exercises = w.exercises || [];
  startWorkout({ prs: [], rest: null, ...w, prBase: Object.fromEntries(exercises.map((e) => [e.exId, bestFor(e.exId)])) });
  window.scrollTo(0, 0); view.draw();
}
function startFromPicks(ids) {
  if (state.active) return toast('Finish or discard your current workout first');
  const exs = ids.map(findExercise).filter(Boolean);
  if (!exs.length) return toast('Pick at least one exercise');
  begin({ name: sessionName(exs), exercises: exs.map((ex) => plannedEntry(ex)) });
}
// "Repeat last Monday": same exercises, fresh sets, weights from nextSuggestion.
function startFromTemplate(w, name) {
  if (state.active) return toast('Finish or discard your current workout first');
  const exercises = (w.exercises || []).map((e) => {
    const def = findExercise(e.exId) || { id: e.exId, name: e.name, type: e.type, met: e.met };
    return plannedEntry(def, { n: (e.sets || []).filter(isWork).length, plan: e.plan, restSec: e.restSec });
  });
  if (!exercises.length) return toast('That workout has no exercises to repeat');
  begin({ name: name || w.name || 'Workout', exercises });
}
function startMobility() {
  if (state.active) return toast('Finish or discard your current workout first');
  const lib = allExercises().filter((e) => e.cat === 'Mobility' && e.type === 'timed');
  const picks = MOBILITY_PICKS.map((id) => lib.find((e) => e.id === id)).filter(Boolean);
  const pool = (picks.length >= 4 ? picks : lib).slice(0, 5);
  if (!pool.length) return toast('No mobility exercises found');
  begin({ name: 'Light mobility', exercises: pool.map((ex) => { const e = entryFor(ex, 2, { restSec: 15, plan: { sets: 2, reps: '45 s' } }); e.sets.forEach((s) => { s.sec = 45; }); return e; }) });
}
async function saveAsDay(ids, fallbackName) {
  const name = await promptSheet('Name this routine day', fallbackName, { placeholder: 'e.g. Push day' });
  if (!name) return;
  const cur = state.customRoutines.find((r) => r.id === MY_ROUTINE_ID);
  const base = cur || { id: MY_ROUTINE_ID, name: 'My sessions', level: 'custom', daysPerWeek: 1, goal: 'Built from the body map', desc: 'Days you saved from the muscle picker.', days: [] };
  const exercises = ids.map(findExercise).filter(Boolean).map((ex) => {
    const range = repRange(ex), n = Math.max(2, Math.min(5, lastSetsFor(ex.id).filter(isWork).length || 3));
    return { ex: ex.id, sets: n, reps: range ? `${range[0]}-${range[1]}` : ex.type === 'cardio' ? '20 min' : '45 s', restSec: ex.type === 'strength' ? 90 : 60 };
  });
  const days = [...(base.days || []), { name, exercises }];
  saveRoutine({ ...base, days, daysPerWeek: Math.min(7, days.length) });
  toast(`Saved "${name}" to My sessions`);
}

// ---------- muscle picker ----------
function musclePicker({ muscles = [], title = 'Build your session' } = {}) {
  const sel = new Set(muscles), picked = [], f = { equip: 'all', q: '', show: {} };
  const idx = lastIndex(), rows = new Map();
  let map, selBox, bar, list, startBtn, saveBtn, seeBtn, count = 0;
  const syncMap = () => map.setSelected([...sel]);
  const syncRows = () => rows.forEach((r) => r.sync());

  function syncFooter() {
    const n = picked.length;
    startBtn.textContent = n ? `Start workout (${n})` : 'Start workout';
    startBtn.disabled = !n; saveBtn.disabled = !n;
    if (n) pulse(startBtn, { scale: 1.02, ms: 240 });
  }
  function paintSel() {
    clear(selBox);
    bar.classList.toggle('has', sel.size > 0);
    if (!sel.size) return append(selBox, h('div', { class: 'tr-sel-hint' }, icon('target', 16), 'Tap a muscle on the body, or search below.'));
    append(selBox, [...sel].map((m) => h('button', { class: 'tr-mchip', style: `--mc:${muscleColor(m)}`, 'aria-label': `Remove ${MUSCLE_LABELS[m] || m}`, onClick: () => { sel.delete(m); syncMap(); paintSel(); paintList(); } }, h('i'), MUSCLE_LABELS[m] || m, icon('x', 14))),
      h('button', { class: 'tr-clear', onClick: () => { sel.clear(); syncMap(); paintSel(); paintList(); } }, 'Clear'));
  }
  const toggle = (ex) => { const i = picked.indexOf(ex.id); if (i >= 0) picked.splice(i, 1); else picked.push(ex.id); haptic(); syncFooter(); syncRows(); };
  const row = (ex) => { const r = pickRow(ex, idx, { select: true, isOn: () => picked.includes(ex.id), order: () => picked.indexOf(ex.id) + 1, onMain: toggle, info: true }); rows.set(ex.id + ':' + rows.size, r); return r.el; };
  // Cardio and mobility last; exercises you have done before first (most recent first), then the rest in library order.
  const rank = (e) => (e.cat === 'Cardio' || e.cat === 'Mobility' || e.type === 'cardio' ? 2 : idx.has(e.id) ? 0 : 1);
  const byRank = (a, b) => rank(a) - rank(b) || (rank(a) === 0 ? (idx.get(b.id).date < idx.get(a.id).date ? -1 : idx.get(b.id).date > idx.get(a.id).date ? 1 : 0) : 0);
  const SEC_PAGE = 8;
  const more = (key, base, n) => h('button', { class: 'btn sm block ghost', onClick: () => { f.show[key] = (f.show[key] || base) + PAGE; paintList(); } }, `Show ${Math.min(n, PAGE)} more`);
  function paintList() {
    clear(list); rows.clear();
    const pool = rankSearch(searchExercises(f.q, '', 600).filter((e) => equipMatch(e, f.equip)), f.q);
    const body = [];
    if (!sel.size) {
      count = f.q ? pool.length : 0;
      if (!f.q) body.push(emptyState('Pick a muscle above', 'Tap the body, or search by name. Every exercise that trains it shows up here.', null, { ico: 'target' }));
      else if (!pool.length) body.push(emptyState('No exercises found', `Nothing matches "${f.q}".`, null, { ico: 'search' }));
      else body.push(h('h3', { class: 'tr-mhead' }, 'Search results'), pool.slice(0, 60).map(row));
    } else {
      const groups = new Map([...sel].map((m) => [m, { primary: [], secondary: [] }]));
      for (const ex of pool) {
        const ms = ex.muscles || [], p = [...sel].find((m) => ms[0] === m), s = p || [...sel].find((m) => ms.includes(m));
        if (s) groups.get(s)[p ? 'primary' : 'secondary'].push(ex);
      }
      count = 0;
      for (const [m, g] of groups) {
        const pri = g.primary.sort(byRank), sec = g.secondary.sort(byRank);
        if (!pri.length && !sec.length) continue;
        count += pri.length + sec.length;
        const kp = m + ':p', ks = m + ':s', nPri = f.show[kp] || PAGE, nSec = f.show[ks] || SEC_PAGE;
        body.push(h('h3', { class: 'tr-mhead', style: `--mc:${muscleColor(m)}` }, h('i'), MUSCLE_LABELS[m] || m, h('span', { class: 'muted' }, String(pri.length + sec.length))),
          pri.slice(0, nPri).map(row), pri.length > nPri ? more(kp, PAGE, pri.length - nPri) : null,
          sec.length ? [h('div', { class: 'tr-subhead' }, `Also works ${(MUSCLE_LABELS[m] || m).toLowerCase()}`), sec.slice(0, nSec).map(row), sec.length > nSec ? more(ks, SEC_PAGE, sec.length - nSec) : null] : null);
      }
      if (!count) body.push(emptyState('No exercises match', 'Try another equipment filter or clear the search.', null, { ico: 'search' }));
    }
    append(list, body);
    seeBtn.classList.toggle('hide', !count || !sel.size);
    seeBtn.textContent = `${count} exercise${count === 1 ? '' : 's'}`;
    seeBtn.prepend(icon('down', 14));
  }

  sheet({
    title, full: true,
    content: (api) => {
      map = bodyMap({ selected: [...sel], onToggle: (m, now) => { if (now) sel.add(m); else sel.delete(m); haptic(); paintSel(); paintList(); } });
      selBox = h('div', { class: 'tr-sel' });
      list = h('div', { class: 'tr-plist' });
      seeBtn = h('button', { class: 'tr-see hide', onClick: () => list.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }) });
      bar = h('div', { class: 'tr-pbar glass' }, selBox, seeBtn);
      const input = h('input', { type: 'search', placeholder: 'Search exercises', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'none', 'aria-label': 'Search exercises', onInput: (e) => { f.q = e.target.value; f.show = {}; paintList(); } });
      startBtn = h('button', { class: 'btn primary lg block', disabled: true, onClick: () => { api.close(); startFromPicks(picked.slice()); } }, 'Start workout');
      saveBtn = h('button', { class: 'btn ghost sm block', disabled: true, onClick: () => saveAsDay(picked.slice(), sessionName(picked.map(findExercise).filter(Boolean))) }, icon('plus', 16), 'Save as routine day');
      api.footer = h('div', { class: 'tr-foot' }, startBtn, saveBtn);
      paintSel(); paintList(); syncFooter();
      return h('div', { class: 'tr-picker stack' }, h('div', { class: 'tr-pmap' }, map), bar, chips(EQUIP, f.equip, (v) => { f.equip = v; f.show = {}; paintList(); }), h('div', { class: 'search' }, icon('search'), input), list);
    },
    actions: (api) => api.footer,
  });
}

// ---------- home: day sheet, week strip, plan hero ----------
function daySheet(plan, trained) {
  const t = plan.template, muscles = musclesForCats(plan.groups);
  const kids = [];
  if (plan.kind === 'train') {
    kids.push(
      h('div', { class: 'tr-gchips' }, plan.groups.map((g) => h('span', { class: 'tr-gchip', style: `--mc:${groupColor(catGroup(g))}` }, h('i'), g))),
      muscles.length ? miniMap({ heat: heatOf(muscles), view: 'both' }, 'tr-day-map') : null,
      h('div', { class: 'small muted' }, `${plan.hits} of the last ${plan.weeksObserved} ${plan.dayName}s`),
      plan.lastDate ? h('div', { class: 'card flat pad-s' }, h('div', { class: 'small muted' }, 'Last session'), h('div', { class: 'strong' }, `${dayText(plan.lastDate)}${t ? ` · ${t.name || 'Workout'} · ${(t.exercises || []).length} exercises` : ''}`)) : null);
  } else if (plan.kind === 'rest') {
    kids.push(h('div', { class: 'tr-rest-note' }, icon('moon', 28), h('div', null, h('b', null, 'Usually a rest day'), h('div', { class: 'small muted' }, 'Recovery is where muscle grows.'))));
  } else {
    kids.push(h('div', { class: 'empty' }, h('b', null, `No pattern on ${plan.dayName}s yet`), plan.dataWeeks < 2 ? 'ShredLog learns your weekly pattern after about two weeks of logging.' : 'Train on this day a few times and it will remember.'));
  }
  if (trained && trained.length) kids.push(h('div', { class: 'list' }, trained.map((w) => h('button', { class: 'list-item', onClick: () => summarySheet(w) }, h('div', { class: 'grow' }, h('div', { class: 'title' }, w.name || 'Workout'), h('div', { class: 'sub' }, `${durShort(durOf(w))} · ${countSets(w)} sets`)), icon('right', 18)))));
  sheet({
    title: `${plan.dayName}s`,
    content: h('div', { class: 'stack' }, kids),
    actions: (api) => h('div', { class: 'tr-foot' },
      plan.kind === 'train' && t ? h('button', { class: 'btn primary lg block', onClick: () => { api.close(); startFromTemplate(t); } }, icon('play', 16), 'Start this') : null,
      plan.kind === 'rest' ? h('button', { class: 'btn primary lg block', onClick: () => { api.close(); startMobility(); } }, 'Light mobility (10 min)') : null,
      h('button', { class: plan.kind === 'unknown' ? 'btn primary lg block' : 'btn block', onClick: () => { api.close(); musclePicker({ muscles }); } }, 'Pick muscles')),
  });
}

// Monday to Sunday of this week: solid dots = trained that day, hollow dots = what you usually do, dash = usual rest day.
function weekStrip(plans, week) {
  return h('div', { class: 'tr-week-strip', role: 'group', 'aria-label': 'This week' }, week.map((d) => {
    const p = plans[d.weekday], did = d.trained.length > 0;
    const what = did ? `trained ${d.trained.join(', ')}` : p.kind === 'train' ? `usually ${p.label}` : p.kind === 'rest' ? 'usually rest' : 'no pattern yet';
    let mark;
    if (did) mark = h('span', { class: 'tr-wk-dots solid' }, dotsFor(d.trained));
    else if (p.kind === 'train') mark = h('span', { class: 'tr-wk-dots ghost' }, dotsFor(p.groups));
    else if (p.kind === 'rest') mark = h('span', { class: 'tr-wk-rest' }, icon('moon', 11));
    else mark = h('span', { class: 'tr-wk-dots' }, h('i', { class: 'tr-gdot nil' }));
    const missed = !did && !d.isFuture && !d.isToday && p.kind === 'train';
    return h('button', { class: `tr-wk ${did ? 'did' : p.kind}${d.isToday ? ' today' : ''}${missed ? ' missed' : ''}${d.isFuture ? ' future' : ''}`, 'aria-label': `${p.dayName}: ${what}`, 'aria-current': d.isToday ? 'date' : null,
      onClick: () => daySheet(p, d.workouts.map((id) => state.workouts.find((w) => w.id === id)).filter(Boolean)) },
    h('span', { class: 'tr-wk-d' }, SHORT_DAY[d.weekday]), mark, did ? h('span', { class: 'tr-wk-tick', 'aria-hidden': 'true' }, icon('check', 9)) : null);
  }));
}

function confidenceBar(p) {
  const n = Math.max(1, Math.min(8, p.weeksObserved || 1)), on = Math.min(n, p.hits || 0);
  return h('div', { class: 'tr-conf', title: `${Math.round((p.confidence || 0) * 100)}% match` },
    h('div', { class: 'tr-conf-bars', 'aria-hidden': 'true' }, Array.from({ length: n }, (_, i) => h('i', { class: i < on ? 'on' : '' }))),
    h('span', null, `${p.hits} of the last ${p.weeksObserved} ${p.dayName}s`));
}

// Today's plan: what you usually do on this weekday, one big Start that repeats last time, the week strip underneath.
function heroCard(plans, week) {
  const now = new Date(), p = plans[now.getDay()], t = p.template, muscles = musclesForCats(p.groups);
  const done = workoutsOn(todayKey());
  const tone = p.kind === 'train' ? groupColor(catGroup(p.groups[0])) : p.kind === 'rest' ? 'var(--sleep)' : 'var(--accent)';
  const head = h('div', { class: 'tr-hero-day' }, h('b', null, p.dayName), done.length ? h('span', { class: 'pill good' }, icon('check', 12), 'Done today') : h('span', { class: 'pill accent' }, 'Today'));
  const copy = [head];
  const btns = [];
  let art = null;
  const goLabel = (title, sub) => h('span', { class: 'tr-go-t' }, h('b', null, title), sub ? h('small', null, sub) : null);
  if (p.kind === 'train') {
    copy.push(h('div', { class: 'tr-hero-lead' }, 'You usually train'), h('div', { class: 'tr-gchips big' }, p.groups.map((g) => h('span', { class: 'tr-gchip', style: `--mc:${groupColor(catGroup(g))}` }, h('i'), g))), confidenceBar(p));
    const nEx = t ? (t.exercises || []).length : 0;
    const lastLine = t ? `${done.length ? 'Same as' : 'Repeats'} last ${p.dayName} · ${nEx} exercise${nEx === 1 ? '' : 's'}` : 'Pick the exercises yourself';
    btns.push(h('button', { class: 'btn primary lg block tr-go', onClick: () => (t ? startFromTemplate(t) : musclePicker({ muscles })) }, icon('play', 22), goLabel(done.length ? 'Train again' : 'Start', lastLine)));
    art = miniMap({ heat: { }, view: 'both' }, 'tr-hero-art'); art.dataset.heat = JSON.stringify(heatOf(muscles));
  } else if (p.kind === 'rest') {
    copy.push(h('div', { class: 'tr-rest-h' }, 'Rest day'), h('div', { class: 'tr-hero-lead' }, 'Usually your rest day. Recovery is where muscle grows.'));
    btns.push(h('button', { class: 'btn soft lg block tr-go', onClick: startMobility }, icon('moon', 20), goLabel('Light mobility', '10 minutes, no weights')));
    art = h('div', { class: 'tr-moon', 'aria-hidden': 'true' }, icon('moon', 44));
  } else {
    copy.push(h('div', { class: 'tr-rest-h' }, `No pattern on ${p.dayName}s yet`), h('div', { class: 'tr-hero-lead' }, p.dataWeeks < 2 ? 'ShredLog learns your week after about two weeks of logging.' : 'Train on this day a few times and it will remember.'));
    btns.push(h('button', { class: 'btn primary lg block tr-go', onClick: () => musclePicker() }, icon('target', 20), goLabel('Build a session', 'Pick the muscles you want')));
    art = h('div', { class: 'tr-moon accent', 'aria-hidden': 'true' }, icon('dumbbell', 40));
  }
  const second = [];
  if (p.kind === 'train' && t) second.push(h('button', { class: 'btn sm', onClick: () => musclePicker({ muscles }) }, icon('target', 16), 'Pick muscles'));
  if (p.kind === 'rest') second.push(h('button', { class: 'btn sm', onClick: () => musclePicker() }, icon('dumbbell', 16), 'Train anyway'));
  second.push(h('button', { class: 'btn sm', onClick: () => begin({ name: 'Workout' }) }, icon('plus', 16), 'Empty workout'));
  const card = h('div', { class: 'card tr-plan-card tr-plan-' + p.kind, style: `--hc:${tone}` },
    h('div', { class: 'tr-hero-top' }, h('div', { class: 'tr-hero-copy' }, copy), art),
    h('div', { class: 'tr-hero-btns' }, btns, h('div', { class: 'tr-hero-second' }, second)),
    weekStrip(plans, week));
  if (art && art.dataset && art.dataset.heat) {
    const full = JSON.parse(art.dataset.heat);
    if (intro()) { art.classList.add('bm-intro'); jobs.push(() => setTimeout(() => { art.setHeat(full); setTimeout(() => art.classList.remove('bm-intro'), 1200); }, 260)); }
    else art.setHeat(full);
  }
  if (intro()) jobs.push(() => {
    rise(card, { y: 18, ms: 480 });
    card.querySelectorAll('.tr-gchip').forEach((c, i) => rise(c, { delay: 220 + i * 70, y: 8, ms: 320, scale: 0.9 }));
    card.querySelectorAll('.tr-conf-bars i').forEach((c, i) => popIn(c, 360 + i * 40));
    const go = card.querySelector('.tr-go'); if (go) rise(go, { delay: 300, y: 10, ms: 380 });
    card.querySelectorAll('.tr-wk').forEach((c, i) => rise(c, { delay: 380 + i * 45, y: 8, ms: 300 }));
    card.querySelectorAll('.tr-wk .tr-gdot').forEach((c, i) => popIn(c, 520 + i * 30));
    card.querySelectorAll('.tr-wk-tick').forEach((c, i) => popIn(c, 700 + i * 60));
    const m = card.querySelector('.tr-moon'); if (m) popIn(m, 200);
  });
  return card;
}

// "Build from the body": the figure lights up group by group, tap it (or the button) to pick muscles.
const CYCLE = [['chest', 'front delts', 'triceps'], ['lats', 'upper back', 'traps', 'biceps'], ['quads', 'glutes', 'hamstrings', 'calves'], ['abs', 'obliques', 'side delts', 'forearms']];
function bodyCard() {
  const art = bodyMap({ heat: {}, view: 'both' }); art.classList.add('bm-compact', 'tr-build-art');
  let k = 0, tm = 0;
  const light = () => {
    if (!art.isConnected) { clearInterval(tm); return; }
    art.setHeat(heatOf(CYCLE[k % CYCLE.length])); k++;
  };
  jobs.push(() => { light(); if (canAnim()) tm = setInterval(light, 2200); });
  return h('div', { class: 'card tr-build-card' },
    h('div', { class: 'tr-build-copy' }, h('h3', null, 'Build from the body'), h('p', { class: 'small' }, 'Tap the muscles you want to train. Pick from every exercise that works them.'),
      h('button', { class: 'btn primary', onClick: () => musclePicker() }, icon('target', 18), 'Pick muscles')),
    h('button', { class: 'tr-build-fig', 'aria-label': 'Pick muscles from the body', onClick: () => musclePicker() }, art));
}

// "Trained this week": last 7 days of hard sets as a heat map (10+ sets = full colour), totals and a status for each group.
function weekMapCard() {
  const keys = lastNDays(7), vol = weeklyVolume(keys), groups = volumeByGroup(keys), beginner = state.workouts.length < 12;
  const heat = Object.fromEntries(Object.entries(vol).map(([m, v]) => [m, Math.min(1, v / 10)]));
  const map = miniMap({ heat: intro() ? {} : heat, view: 'both', formatHeat: (m) => (vol[m] ? `${fmt(vol[m], 1)} sets` : 'not yet') }, 'tr-weekmap-fig');
  const week = state.workouts.filter((w) => w.start > Date.now() - 7 * 864e5);
  const totalSets = Math.round(GROUP_ORDER.reduce((a, g) => a + (groups[g] || 0), 0)), totalVol = week.reduce((a, w) => a + (w.volume ?? volumeOf(w)), 0);
  const any = Object.keys(vol).length > 0;
  const nums = [h('span', { class: 'num-lg' }), h('span', { class: 'num-lg' }), h('span', { class: 'num-lg' })];
  const tracks = [];
  const tiles = GROUP_ORDER.map((g) => {
    const n = groups[g] || 0, st = volumeStatus(n, beginner);
    const word = !n ? 'Not yet' : st.label.startsWith('high') ? 'High' : st.label === 'very high' ? 'Very high' : st.label === 'on target' ? 'On target' : st.label === 'light' ? 'Light' : 'Low';
    const cls = !n ? '' : st.status === 'green' ? 'good' : st.status === 'amber' ? 'warn' : 'bad';
    const pct = Math.min(100, (n / 16) * 100), track = h('i', { style: `background:${groupColor(g)};width:${pct}%` });
    tracks.push([track, pct]);
    return h('div', { class: 'tr-gtile', style: `--gc:${groupColor(g)}` },
      h('div', { class: 'tr-gtile-top' }, h('i'), h('span', null, g)), h('div', { class: 'tr-gtile-n' }, h('b', null, fmt(n, 0)), h('small', null, 'sets')),
      h('span', { class: 'tr-gtile-t' }, track), h('span', { class: 'pill ' + cls }, !n ? null : cls === 'good' ? icon('check', 11) : cls === 'warn' ? icon('warn', 11) : icon('arrowDown', 11), word));
  });
  const card = h('div', { class: 'card tr-weekmap' },
    h('div', { class: 'tr-weekmap-body' }, map,
      h('div', { class: 'tr-wm-stats' }, [[nums[0], 'sets'], [nums[1], week.length === 1 ? 'workout' : 'workouts'], [nums[2], 'kg lifted']].map(([n, l]) => h('div', null, n, h('small', null, l))))),
    h('div', { class: 'tr-gtiles' }, tiles),
    h('div', { class: 'micro muted tr-weekmap-note' }, any ? 'Hard sets in the last 7 days; helper muscles count half. Tap a muscle for its number.' : 'Nothing logged in the last 7 days. The muscles you train will light up here.'));
  const volText = (v) => (totalVol >= 1000 ? fmt(v, 1) + 'k' : fmt(v));
  const run = () => {
    map.classList.add('bm-intro'); map.setHeat(heat); setTimeout(() => map.classList.remove('bm-intro'), 1400);
    countUp(nums[0], totalSets, { from: 0, ms: 700, fmt: (v) => fmt(v) }); countUp(nums[1], week.length, { from: 0, ms: 700 });
    countUp(nums[2], totalVol >= 1000 ? totalVol / 1000 : totalVol, { from: 0, ms: 800, fmt: volText });
    tracks.forEach(([el, pct], i) => fill(el, pct, { ms: 600, delay: 80 + i * 60 }));
  };
  nums[0].textContent = fmt(totalSets); nums[1].textContent = String(week.length); nums[2].textContent = volText(totalVol >= 1000 ? totalVol / 1000 : totalVol);
  if (intro()) { jobs.push(() => { nums.forEach((n) => { n.textContent = '0'; }); whenVisible(card, run); }); }
  return card;
}

// ---------- home: routines rail, history, browser ----------
function routineCard(r) {
  const cur = state.settings.currentRoutineId === r.id;
  const idx = cur && r.days.length ? (state.settings.routineDayIndex || 0) % r.days.length : 0, next = r.days[idx];
  const colors = r.days.map((d) => groupColor(dayGroups(d)[0]));
  const el = h('div', { class: 'tr-rcard' + (cur ? ' cur' : ''), role: 'button', tabindex: '0', style: `--rc:${colors[0] || 'var(--accent)'}`, 'aria-label': `${r.name}. ${r.daysPerWeek} day${r.daysPerWeek === 1 ? '' : 's'} a week. Open details.`, onClick: () => routineSheet(r), onKeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); routineSheet(r); } } },
    h('div', { class: 'row between' }, h('span', { class: 'pill' }, cap(r.level)), cur ? h('span', { class: 'pill good' }, icon('check', 12), 'Current') : null),
    h('h3', { class: 'tr-rname' }, r.name),
    h('div', { class: 'tr-rgoal' }, r.goal || r.desc || ''),
    h('div', { class: 'tr-rdays', 'aria-hidden': 'true' }, r.days.map((d, i) => h('i', { class: cur && i === idx ? 'on' : cur && i < idx ? 'past' : '', style: `--dc:${colors[i]}`, title: d.name }))),
    h('div', { class: 'tr-rfoot' }, cur && next
      ? h('button', { class: 'btn primary sm', onClick: (e) => { e.stopPropagation(); startDay(r, idx); } }, icon('play', 14), `Start ${next.name}`)
      : h('span', { class: 'small muted' }, `${r.daysPerWeek} day${r.daysPerWeek === 1 ? '' : 's'} a week`), cur && next ? h('span', { class: 'micro muted' }, `Day ${idx + 1} of ${r.days.length}`) : null));
  return el;
}
function routinesRail() {
  const all = allRoutines();
  if (!all.length) return emptyState('No routines yet', 'Routines will appear here once they load.');
  const cur = all.filter((r) => r.id === state.settings.currentRoutineId), rest = all.filter((r) => r.id !== state.settings.currentRoutineId);
  const build = h('button', { class: 'tr-rcard tr-rnew', onClick: () => musclePicker() }, h('span', { class: 'tr-rnew-ic' }, icon('plus', 22)), h('b', null, 'Build your own'), h('span', { class: 'small muted' }, 'Pick muscles, then save the session as a routine day.'));
  return h('div', { class: 'tr-rail', role: 'list' }, [...cur, ...rest].map(routineCard), build);
}
function historyList() {
  const all = [...state.workouts].sort((a, b) => b.start - a.start);
  if (!all.length) return emptyState('No workouts yet', 'Start one above and it will show up here.', null, { ico: 'dumbbell' });
  const shown = all.slice(0, ui.hist);
  return h('div', null,
    h('div', { class: 'list tr-hist' }, shown.map((w) => {
      const gs = workoutGroups(w), vol = w.volume ?? volumeOf(w);
      return h('button', { class: 'tr-hrow', onClick: () => summarySheet(w) },
        h('span', { class: 'tr-hdots', 'aria-hidden': 'true' }, (gs.length ? gs : ['']).slice(0, 3).map((g) => h('i', { style: `background:${g ? groupColor(g) : 'var(--muted)'}` }))),
        h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, w.name || 'Workout'),
          h('div', { class: 'sub ellipsis' }, [dayText(dateKey(new Date(w.start))), durShort(durOf(w)), `${countSets(w)} sets`].join(' · '))),
        h('div', { class: 'trail' }, h('b', null, fmt(vol), h('small', null, ' kg')), w.prs?.length ? h('span', { class: 'pr-tag' }, icon('trophy', 11), `${w.prs.length} PR`) : null));
    })),
    all.length > ui.hist ? h('button', { class: 'btn sm block ghost', style: { marginTop: '8px' }, onClick: () => { ui.hist += 10; view.draw(); } }, `Show more (${all.length - ui.hist} older)`) : null);
}

// ---------- home ----------
function homeHead(plans, week, streak) {
  const nWeek = week.filter((d) => d.workouts.length).length, last7 = state.workouts.filter((w) => w.start > Date.now() - 7 * 864e5).length;
  const r = allRoutines().find((x) => x.id === state.settings.currentRoutineId);
  const goal = Math.max(2, r ? r.daysPerWeek : plans.filter((p) => p.kind === 'train').length || 3);
  const pct = Math.min(100, (nWeek / goal) * 100);
  const lbl = h('b', { class: 'num-sm' }, `${nWeek}/${goal}`);
  const rg = ring({ size: 56, stroke: 6, pct, color: nWeek >= goal ? 'var(--good)' : 'var(--accent)', children: lbl });
  rg.classList.add('tr-wring'); rg.setAttribute('title', 'Days trained this week'); rg.setAttribute('role', 'img'); rg.setAttribute('aria-label', `${nWeek} of ${goal} days trained this week`);
  if (intro()) { rg.fillEl.setAttribute('stroke-dashoffset', rg.fillEl.getAttribute('stroke-dasharray')); jobs.push(() => fill(rg.fillEl, pct, { ms: 800, delay: 250, axis: 'ring' })); }
  return h('div', { class: 'screen-head tr-home-head' },
    h('div', { class: 'grow' }, h('h1', null, 'Train'), h('div', { class: 'sub' }, last7 ? `${last7} workout${last7 === 1 ? '' : 's'} in the last 7 days` : 'Nothing logged in the last 7 days'),
      streak.weeks >= 2 ? h('span', { class: 'pill accent tr-streak' }, icon('flame', 12), `${streak.weeks}-week streak`) : null),
    rg);
}
function drawHome(root) {
  const plans = weekPlans(), week = weekThisWeek(), streak = weekStreak();
  const exSection = sectionOf('Exercises', exercisePanel(ui.ex, { mode: 'browse' }), h('button', { class: 'link', onClick: () => customSheet('', (ex) => detailSheet(ex.id)) }, '+ New'));
  const parts = [
    homeHead(plans, week, streak),
    heroCard(plans, week),
    bodyCard(),
    sectionOf('Trained this week', weekMapCard()),
    sectionOf('Routines', routinesRail()),
    sectionOf('History', historyList()),
    exSection,
  ];
  append(root, parts);
  if (intro()) jobs.push(() => parts.slice(2).forEach((p, i) => { if (i < 2) rise(p, { delay: 520 + i * 90, y: 14, ms: 380 }); }));
}

// ---------- workout summary (history) + share card ----------
function exerciseSummary(e) {
  const def = findExercise(e.exId);
  return h('div', { class: 'card flat pad-s tr-sum-ex' },
    h('div', { class: 'tr-sum-exh' }, def ? thumb(def, 'sm') : null, h('div', { class: 'strong grow' }, e.name)),
    e.sets.map((s, i) => h('div', { class: 'tr-sumset' }, h('span', { class: 'tr-tag mini t-' + (s.t || 'N').toLowerCase() }, setLabel(e, i)), h('span', null, setText(e.type, s, true)), s.pr ? h('span', { class: 'pr-tag' }, icon('trophy', 11), 'PR') : null)),
    e.notes ? h('div', { class: 'small muted', style: { marginTop: '4px' } }, e.notes) : null);
}
function summarySheet(w) {
  const sec = durOf(w), vol = w.volume ?? volumeOf(w), gs = workoutGroups(w), heat = workoutHeat(w);
  const remove = async (api) => {
    if (!(await confirmSheet(`Delete "${w.name || 'Workout'}" from your history?`, { ok: 'Delete', danger: true, title: 'Delete workout?' }))) return;
    api.close(); deleteWorkout(w.id);
    toast('Workout deleted', { action: 'Undo', ms: 5000, onAction: () => { state.workouts.push(w); state.workouts.sort((a, b) => a.start - b.start); commit('workout'); } });
  };
  const repeat = (api) => { api.close(); startFromTemplate(w, w.name); };
  sheet({
    title: w.name || 'Workout', full: true,
    content: h('div', { class: 'stack tr-summary' },
      h('div', { class: 'small muted' }, `${dayText(dateKey(new Date(w.start)))} · ${fmtTime(w.start)}${w.feel ? ' · felt ' + w.feel : ''}`),
      h('div', { class: 'tr-sum-top' }, Object.keys(heat).length ? miniMap({ heat, view: 'both' }, 'tr-sum-map') : null,
        h('div', { class: 'tr-stats2' }, statCell('Duration', durShort(sec)), statCell('Volume', fmt(vol), 'kg'), statCell('Sets', countSets(w)), statCell('Calories', w.kcal ? fmt(w.kcal) : '–', w.kcal ? 'kcal' : ''))),
      gs.length ? h('div', { class: 'tr-gchips' }, gs.map((g) => h('span', { class: 'tr-gchip', style: `--mc:${groupColor(g)}` }, h('i'), g))) : null,
      w.prs?.length ? h('div', { class: 'tr-prcard' }, h('div', { class: 'row' }, icon('trophy', 18), h('b', null, `${w.prs.length} personal record${w.prs.length === 1 ? '' : 's'}`)), w.prs.map((p) => h('div', { class: 'small' }, `${p.name} · ${p.text || ''}`))) : null,
      (w.exercises || []).length ? w.exercises.map(exerciseSummary) : emptyState('No sets saved', 'This workout has no exercises.')),
    actions: (api) => h('div', { class: 'tr-foot' },
      state.active ? null : h('button', { class: 'btn primary lg block', onClick: () => repeat(api) }, icon('reset', 18), 'Repeat workout'),
      h('div', { class: 'tr-foot-row' }, h('button', { class: 'btn', onClick: () => shareSheet(w) }, icon('share', 18), 'Share card'), h('button', { class: 'btn danger', onClick: () => remove(api) }, icon('trash', 18), 'Delete'))),
  });
}

function roundRect(g, x, y, w, hgt, r) {
  g.beginPath();
  if (g.roundRect) g.roundRect(x, y, w, hgt, r);
  else { g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + hgt, r); g.arcTo(x + w, y + hgt, x, y + hgt, r); g.arcTo(x, y + hgt, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
}
// 1080 x 1350 in the app palette (tokens read from the live theme): name, date, muscles, volume, PRs, body heat.
async function drawShareCard(w) {
  const W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  try { await Promise.all([document.fonts.load('800 100px "Bricolage Grotesque"'), document.fonts.load('600 40px "Bricolage Grotesque"')]); } catch (e) { /* system font is fine */ }
  const cs = getComputedStyle(document.documentElement), tok = (n, fb) => cs.getPropertyValue(n).trim() || fb;
  const C = { bg: tok('--bg', 'black'), card: tok('--card', 'black'), card2: tok('--card-2', 'gray'), ink: tok('--ink', 'white'), ink2: tok('--ink-2', 'white'), muted: tok('--muted', 'gray'), accent: tok('--accent', 'gold'), accentInk: tok('--accent-ink', 'black'), line: tok('--line-2', 'gray'), good: tok('--good', 'green') };
  const FONT = '"Bricolage Grotesque", -apple-system, system-ui, sans-serif';
  const text = (s, x, y, { size = 40, weight = 600, color = C.ink, align = 'left', max = 0, stretch = 'normal' } = {}) => {
    g.font = `${weight} ${size}px ${FONT}`; try { g.fontStretch = stretch; } catch (e) { /* unsupported */ }
    g.fillStyle = color; g.textAlign = align; g.textBaseline = 'alphabetic';
    let t = String(s);
    if (max) { while (g.measureText(t).width > max && t.length > 1) t = t.slice(0, -1); if (t !== String(s)) t = t.trimEnd() + '…'; }
    g.fillText(t, x, y); return g.measureText(t).width;
  };
  // background: palette + two faint glows like the app
  g.fillStyle = C.bg; g.fillRect(0, 0, W, H);
  let gr = g.createRadialGradient(120, 40, 0, 120, 40, 760); gr.addColorStop(0, C.accent); gr.addColorStop(1, 'transparent');
  g.globalAlpha = 0.16; g.fillStyle = gr; g.fillRect(0, 0, W, H);
  gr = g.createRadialGradient(W, 200, 0, W, 200, 640); gr.addColorStop(0, tok('--p', C.accent)); gr.addColorStop(1, 'transparent');
  g.globalAlpha = 0.12; g.fillStyle = gr; g.fillRect(0, 0, W, H); g.globalAlpha = 1;
  const M = 80;
  // brand row
  roundRect(g, M, M, 92, 92, 26); g.fillStyle = C.accent; g.fill();
  text('S', M + 46, M + 70, { size: 66, weight: 800, color: C.accentInk, align: 'center', stretch: 'semi-condensed' });
  text('ShredLog', M + 116, M + 66, { size: 46, weight: 800, stretch: 'semi-condensed' });
  text(`${fmtDateLabel(dateKey(new Date(w.start)), '0000-00-00')}`, W - M, M + 62, { size: 38, weight: 600, color: C.muted, align: 'right' });
  // name
  const name = (w.name || 'Workout').trim();
  let size = 150; g.font = `800 ${size}px ${FONT}`;
  while (g.measureText(name).width > W - 2 * M && size > 84) { size -= 6; g.font = `800 ${size}px ${FONT}`; }
  text(name, M, 330, { size, weight: 800, max: W - 2 * M, stretch: 'semi-condensed' });
  // muscle chips
  const gs = workoutGroups(w).slice(0, 4); let cx = M;
  const groupTok = { Chest: '--g1', Back: '--g2', Shoulders: '--g3', Arms: '--g4', Legs: '--g5', Core: '--g6' };
  for (const gname of gs) {
    g.font = `700 36px ${FONT}`; const tw = g.measureText(gname).width, cw = tw + 84, col = tok(groupTok[gname] || '--muted', C.muted);
    roundRect(g, cx, 372, cw, 68, 34); g.fillStyle = C.card2; g.fill(); g.lineWidth = 3; g.strokeStyle = col; g.stroke();
    g.beginPath(); g.arc(cx + 34, 406, 10, 0, Math.PI * 2); g.fillStyle = col; g.fill();
    text(gname, cx + 56, 418, { size: 36, weight: 700 }); cx += cw + 14;
  }
  // volume (the big number)
  const vol = w.volume ?? volumeOf(w), sets = countSets(w), dur = durOf(w);
  text('Total volume', M, 560, { size: 38, weight: 600, color: C.muted });
  const vw = text(fmt(vol), M, 720, { size: 190, weight: 800, stretch: 'semi-condensed' });
  text('kg', M + vw + 18, 720, { size: 64, weight: 600, color: C.muted });
  // small stats
  const small = [['Time', durShort(dur)], ['Sets', String(sets)], ['Burned', w.kcal ? `${fmt(w.kcal)} kcal` : '–']];
  small.forEach(([l, v], i) => { const y = 800 + i * 112; text(l, M, y, { size: 32, weight: 600, color: C.muted }); text(v, M + 190, y + 2, { size: 60, weight: 800, stretch: 'semi-condensed' }); });
  // body heat map (both figures), same geometry as the app
  try {
    const shp = bodyShapes(), heat = workoutHeat(w), sc = 1.45, fw = shp.W * sc, fh = shp.H * sc, ox = W - M - fw * 2 - 22, oy = 520;
    const skin = C.card2;
    for (const [k, side] of [[0, 'front'], [1, 'back']]) {
      g.save(); g.translate(ox + k * (fw + 22), oy); g.scale(sc, sc);
      g.lineJoin = 'round';
      const body = new Path2D(shp.body), head = new Path2D(shp.head);
      g.fillStyle = skin; g.fill(body); g.fill(head); g.lineWidth = 1.6; g.strokeStyle = C.line; g.stroke(body); g.stroke(head);
      g.save(); g.clip(body);
      for (const [m, d] of shp[side]) {
        const hv = heat[m] || 0, col = tok(groupTok[MUSCLE_GROUPS[m]] || '--muted', C.muted), p = new Path2D(d);
        g.globalAlpha = 1; g.fillStyle = C.ink2; g.globalAlpha = 0.1; g.fill(p);
        if (hv > 0) { g.globalAlpha = 0.3 + 0.7 * hv; g.fillStyle = col; g.fill(p); }
        g.globalAlpha = 1; g.lineWidth = 0.6; g.strokeStyle = C.line; g.stroke(p);
      }
      g.restore(); g.restore();
    }
    void fh;
  } catch (e) { /* the card still reads without the figure */ }
  // PR strip or exercise count
  const prs = w.prs || [], py = 1120;
  roundRect(g, M, py, W - 2 * M, 150, 40); g.fillStyle = prs.length ? C.accent : C.card; g.fill();
  if (!prs.length) { g.lineWidth = 2; g.strokeStyle = C.line; g.stroke(); }
  const fg = prs.length ? C.accentInk : C.ink;
  if (prs.length) {
    text(`${prs.length} new personal record${prs.length === 1 ? '' : 's'}`, M + 44, py + 66, { size: 46, weight: 800, color: fg, stretch: 'semi-condensed', max: W - 2 * M - 88 });
    text(prs.slice(0, 2).map((p) => `${p.name} ${p.text || ''}`).join('   '), M + 44, py + 116, { size: 34, weight: 600, color: fg, max: W - 2 * M - 88 });
  } else {
    const n = (w.exercises || []).length;
    text(`${n} exercise${n === 1 ? '' : 's'}, ${sets} working set${sets === 1 ? '' : 's'}`, M + 44, py + 66, { size: 46, weight: 800, color: fg, stretch: 'semi-condensed' });
    text((w.exercises || []).slice(0, 3).map((e) => e.name).join(', '), M + 44, py + 116, { size: 34, weight: 600, color: C.muted, max: W - 2 * M - 88 });
  }
  text('Logged with ShredLog', W / 2, H - 38, { size: 30, weight: 600, color: C.muted, align: 'center' });
  return c;
}
function shareSheet(w) {
  let file = null, url = '';
  const img = h('img', { class: 'tr-share-img', alt: 'Your workout card', draggable: 'false' });
  const stage = h('div', { class: 'tr-share-stage' }, h('div', { class: 'tr-share-load skeleton' }), img);
  const canShare = () => { try { return !!(file && navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { return false; } };
  const save = () => {
    if (!url) return;
    const a = h('a', { href: url, download: `shredlog-${dateKey(new Date(w.start))}.png` }); document.body.append(a); a.click(); a.remove();
    toast('Image saved');
  };
  const send = async () => {
    if (!file) return toast('Still drawing the card');
    if (!canShare()) return save();
    try { await navigator.share({ files: [file], title: w.name || 'Workout', text: `${w.name || 'Workout'} on ShredLog` }); }
    catch (e) { if (e && e.name !== 'AbortError') save(); }
  };
  let shareBtn, saveBtn;
  sheet({
    title: 'Share your workout', full: true, onClose: () => { if (url) URL.revokeObjectURL(url); },
    content: h('div', { class: 'stack' }, stage, h('div', { class: 'small muted' }, 'A 1080 × 1350 card in your colours. Share it or save the image.')),
    actions: () => [saveBtn = h('button', { class: 'btn', disabled: true, onClick: save }, icon('download', 18), 'Save image'), shareBtn = h('button', { class: 'btn primary', disabled: true, onClick: send }, icon('share', 18), 'Share')],
  });
  drawShareCard(w).then((cv) => cv.toBlob((b) => {
    if (!b) return toast('Could not draw the card');
    url = URL.createObjectURL(b); file = new File([b], `shredlog-${dateKey(new Date(w.start))}.png`, { type: 'image/png' });
    img.src = url; img.onload = () => { stage.classList.add('ready'); rise(img, { y: 10, ms: 360 }); };
    shareBtn.disabled = false; saveBtn.disabled = false; if (!canShare()) shareBtn.classList.add('hide');
  }, 'image/png')).catch((e) => { console.error(e); toast('Could not draw the card'); });
}

// ---------- rest timer, clock, screen wake lock ----------
const restFor = (ex) => ex.restSec || ex.plan?.restSec || state.settings.restSec || 90;
function startTimer() { clearInterval(timer); timer = setInterval(tick, 1000); tick(); holdScreen(); }
function stopTimer() { clearInterval(timer); timer = 0; live = null; freeScreen(); }
async function holdScreen() {
  try {
    if (state.settings.trainWake === false || !navigator.wakeLock || wake) return;
    wake = await navigator.wakeLock.request('screen');
    wake.addEventListener('release', () => { wake = null; });
  } catch (e) { wake = null; }
}
function freeScreen() { try { if (wake) wake.release(); } catch (e) { /* ignore */ } wake = null; }
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && live && live.root.isConnected) holdScreen(); });

function progress(a) {
  let done = 0, total = 0;
  for (const e of a.exercises) for (const s of e.sets) if (isWork(s)) { total++; if (s.done) done++; }
  return { done, total };
}
function tick() {
  const a = state.active;
  if (!live || !live.root.isConnected) return stopTimer(); // the tab was left: unmount
  if (!a || a.id !== live.id) return;
  live.elapsed.textContent = hms((Date.now() - a.start) / 1000);
  paintStats(a);
  paintRest(a);
}
function paintStats(a) {
  const L = live, p = progress(a), v = volumeOf(a);
  if (p.done !== L.lastDone || p.total !== L.lastTotal) {
    L.count.textContent = `${p.done}/${p.total}`;
    fill(L.ringEl.fillEl, p.total ? (p.done / p.total) * 100 : 0, { axis: 'ring', key: 'tr:ring:' + a.id, ms: 560 });
    L.ringEl.classList.toggle('full', p.total > 0 && p.done === p.total);
    if (L.lastDone >= 0 && p.done > L.lastDone) pulse(L.ringEl, { scale: 1.14, ms: 380 });
    L.lastDone = p.done; L.lastTotal = p.total;
  }
  if (v !== L.lastVol) { odometer(L.vol, v, { fmt: (x) => fmt(x), key: 'tr:vol:' + a.id }); L.lastVol = v; }
}
const RING_R = 21.5, RING_C = 2 * Math.PI * RING_R;
function showBar() {
  const b = live.bar; b.classList.remove('hide');
  if (live.quietShow) { live.quietShow = false; return; } // a redraw while resting must not replay the entrance
  if (canAnim()) b.animate([{ opacity: 0, transform: 'translateY(16px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: EASE_SPRING });
}
function hideBar() {
  const b = live.bar;
  if (!canAnim()) return b.classList.add('hide');
  const an = b.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(10px)' }], { duration: 170, easing: 'ease-in', fill: 'forwards' });
  an.onfinish = () => { an.cancel(); if (!(state.active && state.active.rest)) b.classList.add('hide'); }; // a new rest may have started meanwhile
}
function paintRest(a) {
  const L = live, r = a.rest, bar = L.bar;
  L.root.classList.toggle('tr-has-rest', !!r);
  if (!r) { if (!bar.classList.contains('hide') && !L.hiding) { L.hiding = true; hideBar(); setTimeout(() => { L.hiding = false; }, 200); } return; }
  const left = (r.endAt - Date.now()) / 1000;
  if (left < -4) return endRest(a);
  const ex = a.exercises.find((e) => e.exId === r.exId);
  const total = Math.max(1, r.total || (ex ? restFor(ex) : state.settings.restSec || 90));
  const fresh = bar.classList.contains('hide');
  if (fresh) { bar.classList.add('snap'); showBar(); }
  const pct = left <= 0 ? 0 : Math.min(1, left / total);
  L.rring.style.strokeDashoffset = (RING_C * (1 - pct)).toFixed(2);
  if (fresh) { void bar.offsetWidth; bar.classList.remove('snap'); }
  if (left <= 0) {
    bar.classList.add('done'); bar.classList.remove('soon');
    L.rtime.textContent = 'Go'; L.rlabel.textContent = 'Rest over. Next set';
    if (L.notified !== r.endAt) { L.notified = r.endAt; haptic('success'); try { navigator.vibrate?.([200, 100, 200]); } catch (e) { /* not supported on iOS */ } }
  } else {
    bar.classList.remove('done'); bar.classList.toggle('soon', left <= 10);
    L.rtime.textContent = fmtClock(Math.ceil(left)); L.rlabel.textContent = ex ? ex.name : 'Rest';
  }
}
function endRest(a) { a.rest = null; commit(); if (live) paintRest(a); }
function startRest(ex) {
  if (ex.type === 'cardio') return;
  const sec = restFor(ex);
  state.active.rest = { endAt: Date.now() + sec * 1000, exId: ex.exId, total: sec };
}
function changeRest(fn) { const a = state.active; if (!a?.rest) return; fn(a.rest); commit(); tick(); }
// A rest that ended while the screen was away must not greet the user with a stale countdown.
function clearStaleRest(a) { if (a && a.rest && a.rest.endAt < Date.now() - 4000) { a.rest = null; commit(); } }
function restBar() {
  const rg = ring({ size: 48, stroke: 5, pct: 100, color: 'var(--accent)', children: h('span', { class: 'tr-rest-ic' }, icon('timer', 18)) });
  const time = h('div', { class: 'time' }, '0:00'), label = h('div', { class: 'micro ellipsis' });
  const bar = h('div', { class: 'rest-banner tr-rest hide', role: 'timer', 'aria-live': 'off', dataset: { moFixed: '1' } }, rg,
    h('button', { class: 'tr-rest-col', 'aria-label': 'Change rest time', onClick: () => restSheet(null) }, time, label),
    h('button', { class: 'btn tr-rbtn', 'aria-label': 'Subtract 15 seconds', onClick: () => changeRest((r) => { r.endAt -= 15000; r.total = Math.max(15, (r.total || 90) - 15); }) }, '−15'),
    h('button', { class: 'btn tr-rbtn', 'aria-label': 'Add 15 seconds', onClick: () => changeRest((r) => { r.endAt += 15000; r.total = (r.total || 90) + 15; }) }, '+15'),
    h('button', { class: 'btn tr-rbtn skip', onClick: () => { haptic(); const a = state.active; if (a) { a.rest = null; commit(); tick(); } } }, 'Skip'));
  return { bar, time, label, rring: rg.fillEl };
}
function restSheet(ex) {
  const cur = ex ? String(ex.restSec || 0) : String(state.settings.restSec || 90);
  const opts = ex ? [{ id: '0', label: 'Default' }, ...REST_CHOICES.map((s) => ({ id: String(s), label: `${s} s` }))] : REST_CHOICES.map((s) => ({ id: String(s), label: `${s} s` }));
  sheet({ title: ex ? `Rest after ${ex.name}` : 'Rest timer', content: (api) => h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, ex ? 'Used after every set of this exercise. Default follows your workout setting.' : 'Default rest after each set. Each exercise can override it.'),
    h('div', { class: 'chips wrap' }, opts.map((o) => h('button', { class: 'chip' + (o.id === cur ? ' on' : ''), onClick: () => {
      if (ex) { if (+o.id) ex.restSec = +o.id; else delete ex.restSec; } else state.settings.restSec = +o.id;
      commit(ex ? undefined : 'settings'); api.close(); toast(ex ? `Rest set to ${o.label}` : `Default rest ${o.label}`);
    } }, o.label)))) });
}

// ---------- live workout: edit actions ----------
let justAdded = '';          // key of a set that was just added, so its row can animate in
const syncSig = () => view.sync && view.sync();
function refreshCard(ex) {
  const a = state.active, ei = a.exercises.indexOf(ex);
  if (ei < 0 || !live) return view.draw();
  const old = live.cardsEl.children[ei]; if (!old) return view.draw();
  jobs2 = []; old.replaceWith(buildCard(ex, ei)); syncSig(); tick();
  for (const j of jobs2) { try { j(); } catch (e) { console.error(e); } } jobs2 = [];
}
function addToWorkout(ex) {
  const a = state.active;
  if (!a) return toast('Start a workout first');
  a.exercises.push(plannedEntry(ex, { n: 3 })); (a.prBase ||= {})[ex.id] ||= bestFor(ex.id);
  commit(); view.draw();
  const cards = document.querySelectorAll('.tr-ex');
  cards[cards.length - 1]?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
}
function replaceExercise(ei, ex) {
  const a = state.active, old = a.exercises[ei];
  a.prs = (a.prs || []).filter((p) => !old.sets.some((s) => s.k === p.k));
  a.exercises[ei] = plannedEntry(ex, { n: old.sets.length || 3, plan: old.plan, restSec: old.restSec });
  a.exercises[ei].notes = old.notes || '';
  (a.prBase ||= {})[ex.id] ||= bestFor(ex.id);
  commit(); view.draw();
}
async function removeExercise(ei) {
  const a = state.active, ex = a.exercises[ei];
  if (ex.sets.some((s) => s.done || !isBlank(ex.type, s)) && !(await confirmSheet(`Remove ${ex.name} and its sets from this workout?`, { ok: 'Remove', danger: true, title: 'Remove exercise?' }))) return;
  const gone = a.prs ? a.prs.filter((p) => ex.sets.some((s) => s.k === p.k)) : [];
  a.prs = (a.prs || []).filter((p) => !ex.sets.some((s) => s.k === p.k));
  a.exercises.splice(ei, 1); commit(); view.draw();
  toast(`${ex.name} removed`, { undo: () => { if (!state.active || state.active.id !== a.id) return; a.exercises.splice(Math.min(ei, a.exercises.length), 0, ex); a.prs = [...(a.prs || []), ...gone]; commit(); view.draw(); }, ms: 5000 });
}
function moveExercise(ei, dir) {
  const a = state.active, to = ei + dir; if (to < 0 || to >= a.exercises.length) return;
  a.exercises.splice(to, 0, a.exercises.splice(ei, 1)[0]); commit(); view.draw();
}
function addSet(ex) {
  const src = [...ex.sets].reverse().find(isWork) || ex.sets[ex.sets.length - 1], s = newSet(ex.type);
  if (src) for (const [k] of fieldsOf(ex.type)) s[k] = src[k];
  ex.sets.push(s); justAdded = s.k; commit(); refreshCard(ex);
}
function addDrop(ex) {
  const src = [...ex.sets].reverse().find((s) => isWork(s) && s.w), s = newSet(ex.type); s.t = 'D';
  if (src) { s.w = Math.max(0, round25(src.w * 0.8)); }
  ex.sets.push(s); justAdded = s.k; commit(); refreshCard(ex);
}
function deleteSet(ex, i) {
  const a = state.active, [s] = ex.sets.splice(i, 1), gone = (a.prs || []).filter((p) => p.k === s.k);
  a.prs = (a.prs || []).filter((p) => p.k !== s.k);
  commit(); refreshCard(ex);
  toast('Set deleted', { undo: () => { if (!state.active || state.active.id !== a.id) return; ex.sets.splice(Math.min(i, ex.sets.length), 0, s); a.prs = [...(a.prs || []), ...gone]; commit(); refreshCard(ex); }, ms: 4500 });
}
function addWarmups(ex) {
  if (ex.type !== 'strength') return toast('Warm-up sets are for weighted exercises');
  if (ex.sets[0]?.t === 'W') return toast('Warm-up sets are already there');
  const W = ex.sets.find((s) => isWork(s) && s.w)?.w || prevSets(ex.exId).n.find((s) => s.w)?.w;
  if (!W) return toast('Enter your first working weight so I can work out the warm-ups');
  const plan = [[0.4, 8], [0.6, 5], [0.8, 3]].map(([f, r]) => [round25(W * f), r]).filter(([w], i, arr) => w > 0 && w < W && (i === 0 || w !== arr[i - 1][0]));
  const added = plan.map(([w, r]) => ({ ...newSet(ex.type), t: 'W', w, r }));
  ex.sets.unshift(...added); justAdded = added[0]?.k || '';
  commit(); refreshCard(ex);
}
// Replace the sets you have not ticked with last session's numbers (warm-ups included).
function copyLast(ex) {
  const l = exerciseHistory(ex.exId, 1)[0]; if (!l) return toast('No earlier session to copy');
  const before = ex.sets, kept = ex.sets.filter((s) => s.done);
  const fresh = lastSetsFor(ex.exId).length ? sessionSets(ex.exId).map((s) => ({ ...newSet(ex.type), t: s.t || 'N', ...Object.fromEntries(fieldsOf(ex.type).map(([k]) => [k, s[k] ?? null])) })) : [];
  if (!fresh.length) return toast('No earlier session to copy');
  ex.sets = [...kept, ...fresh]; justAdded = fresh[0].k; commit(); refreshCard(ex);
  toast(`Copied ${fresh.length} set${fresh.length === 1 ? '' : 's'} from ${dayText(l.date)}`, { undo: () => { ex.sets = before; commit(); refreshCard(ex); }, ms: 5000 });
}
// All finished sets (warm-ups too) of the most recent session of an exercise.
function sessionSets(exId) {
  for (const w of [...state.workouts].sort((a, b) => b.start - a.start)) for (const e of w.exercises || []) if (e.exId === exId) { const s = (e.sets || []).filter((x) => x.done); if (s.some(isWork)) return s; }
  return [];
}
function toggleDone(ex, s) {
  if (s.done) { s.done = false; delete s.at; applyPR(ex, s, true); commit(); return true; }
  if (!hasNeed(ex.type, s)) { toast(`Add ${need(ex.type)[1]} first`); return false; }
  s.done = true; s.at = Date.now();
  if (s.w) lastW = s.w;
  applyPR(ex, s);
  startRest(ex);
  commit(); tick();
  return true;
}
function setType(ex, s, t) {
  s.t = t; if (s.done) applyPR(ex, s, true);
  commit(); refreshCard(ex);
}
function setMenu(ex, i) {
  const s = ex.sets[i], cur = s.t || 'N';
  const T = [['N', 'dumbbell', 'Normal set', 'Counts toward volume and PRs'], ['W', 'flame', 'Warm-up set', 'Left out of volume and PRs'], ['D', 'arrowDown', 'Drop set', 'Lighter weight straight after a hard set'], ['F', 'zap', 'To failure', 'Pushed until no more reps']];
  actionSheet(`Set ${setLabel(ex, i)} · ${ex.name}`, [
    ...T.map(([t, ic, label, sub]) => ({ icon: ic, label, sub, trail: cur === t ? 'Now' : '', onClick: () => setType(ex, s, t) })),
    { icon: 'trash', label: 'Delete set', danger: true, onClick: () => deleteSet(ex, i) },
  ]);
}

// ---------- live workout: rows and cards ----------
function paintRow(ref) {
  const { ex, i, prev } = ref, s = ex.sets[i], p = prevFor(ex, i, prev), fs = fieldsOf(ex.type);
  ref.nBtn.textContent = setLabel(ex, i);
  ref.nBtn.className = 'n tr-tag t-' + (s.t || 'N').toLowerCase();
  ref.nBtn.setAttribute('aria-label', `Set ${setLabel(ex, i)}, ${SET_NAMES[s.t || 'N']}. Tap for options`);
  clear(ref.prevEl);
  if (s.pr) { append(ref.prevEl, h('span', { class: 'pr-tag' }, icon('trophy', 11), 'PR')); ref.prevEl.disabled = true; }
  else { ref.prevEl.textContent = p ? setText(ex.type, p) : '–'; ref.prevEl.disabled = !p || !!s.done; ref.prevEl.setAttribute('aria-label', p ? `Previous ${setText(ex.type, p, true)}. Tap to use` : 'No previous set'); }
  fs.forEach(([k], fi) => { ref.inputs[fi].placeholder = p && p[k] != null ? numStr(p[k]) : (k === 'r' && ex.plan?.reps) || ''; });
  ref.el.classList.toggle('is-done', !!s.done);
  ref.el.classList.toggle('is-pr', !!s.pr);
  ref.doneBtn.classList.toggle('on', !!s.done);
  ref.doneBtn.setAttribute('aria-pressed', s.done ? 'true' : 'false');
  ref.doneBtn.setAttribute('aria-label', s.done ? `Set ${i + 1} done. Tap to undo` : `Complete set ${i + 1}`);
}
function buildRow(ex, i, prev, repaint) {
  const s = ex.sets[i], fs = fieldsOf(ex.type), ref = { ex, i, prev };
  ref.nBtn = h('button', { class: 'n tr-tag', onClick: () => setMenu(ex, i) });
  ref.prevEl = h('button', { class: 'prev', type: 'button', onClick: () => {
    const p = prevFor(ex, i, prev); if (!p || s.done) return;
    fs.forEach(([k], fi) => { if (p[k] != null) { s[k] = p[k]; ref.inputs[fi].value = numStr(p[k]); } });
    if (s.w) lastW = s.w; haptic(); commit(); repaint(); pulse(ref.inputs[0], { scale: 1.06, ms: 260 });
  } });
  ref.inputs = fs.map(([key, label, mode], fi) => h('input', {
    type: 'text', inputmode: mode, enterkeyhint: fi < fs.length - 1 ? 'next' : 'done', autocomplete: 'off', 'aria-label': `${label} for set ${i + 1}`, value: numStr(s[key]),
    onFocus: (e) => e.target.select(),
    onKeydown: (e) => { if (e.key !== 'Enter') return; e.preventDefault(); (ref.inputs[fi + 1] || e.target).focus(); if (!ref.inputs[fi + 1]) e.target.blur(); },
    onInput: (e) => { s[key] = parseNum(e.target.value); if (key === 'w' && s.w) lastW = s.w; if (s.done) applyPR(ex, s, true); commit(); paintRow(ref); },
  }));
  ref.doneBtn = h('button', { class: 'done', onClick: () => {
    if (!s.done) { // empty row: copy the previous session's numbers, then tick
      const p = prevFor(ex, i, prev);
      if (p) fs.forEach(([k], fi) => { if (s[k] == null && p[k] != null) { s[k] = p[k]; ref.inputs[fi].value = numStr(p[k]); } });
    }
    const had = !!s.pr;
    if (toggleDone(ex, s)) {
      repaint();
      if (s.done) { haptic(s.pr && !had ? 'success' : 'tap'); pop(ref.doneBtn, { ms: 460 }); if (s.pr && !had) celebrate(ref.doneBtn, { kind: 'pr', count: 10 }); }
      else haptic();
    } else ref.inputs[Math.max(0, fs.findIndex(([k]) => k === need(ex.type)[0]))].focus();
  } }, icon('check', 22));
  ref.fillEl = h('span', { class: 'tr-rowfill', 'aria-hidden': 'true' });
  ref.el = h('div', { class: 'set-row tr-set', onContextmenu: (e) => e.preventDefault() }, ref.fillEl, ref.nBtn, ref.prevEl, ref.inputs, ref.doneBtn);
  return ref;
}
function buildCard(ex, ei) {
  const prev = prevSets(ex.exId), rows = [];
  const def = findExercise(ex.exId) || { id: ex.exId, name: ex.name, type: ex.type, muscles: [], cat: '' };
  const repaint = () => rows.forEach(paintRow);
  const body = h('div', { class: 'tr-sets' }, ex.sets.map((s, i) => { const r = buildRow(ex, i, prev, repaint); rows.push(r); return r.el; }));
  repaint();
  const hint = hintFor(ex), muscles = (def.muscles || []).slice(0, 2).map((m) => MUSCLE_LABELS[m] || m).join(', ');
  const plan = ex.plan ? `${ex.plan.sets || ex.sets.length} × ${ex.plan.reps}` : '';
  const open = () => detailSheet(ex.exId, { inWorkout: true });
  const hist = exerciseHistory(ex.exId, 1)[0], fresh = !ex.sets.some((s) => s.done || !isBlank(ex.type, s));
  const note = h('input', { class: 'tr-note' + (ex.notes ? '' : ' hide'), type: 'text', value: ex.notes || '', placeholder: 'Note for this exercise', enterkeyhint: 'done', 'aria-label': `Note for ${ex.name}`,
    onInput: (e) => { ex.notes = e.target.value; commit(); }, onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } });
  const tools = h('div', { class: 'tr-tools' },
    hist && fresh ? h('button', { class: 'tr-tool hot', 'aria-label': 'Copy last session', onClick: () => copyLast(ex) }, icon('copy', 14), 'Copy last') : null,
    h('button', { class: 'tr-tool', onClick: () => { note.classList.remove('hide'); note.focus(); } }, icon('note', 14), 'Note'),
    h('button', { class: 'tr-tool', onClick: () => restSheet(ex) }, icon('timer', 14), `Rest ${restFor(ex)} s`));
  const weighted = ex.type === 'strength';
  const card = h('section', { class: 'card tr-ex' },
    h('div', { class: 'tr-ex-head' },
      h('button', { class: 'tr-ex-thumb', 'aria-label': `Form guide for ${ex.name}`, onClick: open }, thumb(def)),
      h('div', { class: 'tr-ex-title' }, h('button', { class: 'tr-ex-name', onClick: open }, ex.name), h('div', { class: 'tr-ex-meta ellipsis' }, [muscles, plan].filter(Boolean).join(' · '))),
      h('button', { class: 'icon-btn plain tr-info', 'aria-label': `Form guide for ${ex.name}`, onClick: open }, icon('info', 20)),
      h('button', { class: 'icon-btn plain tr-more', 'aria-label': `Options for ${ex.name}`, onClick: () => exerciseMenu(ex) }, icon('more'))),
    hint ? h('div', { class: 'tr-hint' }, h('span', { class: 'pill ' + hint.cls }, icon(hint.ico, 13), hint.text)) : null,
    tools, note,
    h('div', { class: 'set-row head' }, h('div', null, 'Set'), h('div', null, 'Previous'), fieldsOf(ex.type).map(([, l]) => h('div', null, l)), h('div', null, icon('check', 13))),
    body,
    h('div', { class: 'tr-card-foot' },
      h('button', { class: 'btn sm tr-addset', onClick: () => addSet(ex) }, icon('plus', 16), 'Add set'),
      weighted ? h('button', { class: 'btn sm', onClick: () => addWarmups(ex) }, 'Warm-up') : null,
      weighted ? h('button', { class: 'btn sm', onClick: () => addDrop(ex) }, 'Drop') : null));
  // swipe a row left to delete it (undo in the toast); built after the rows are in the card so the wrapper has a parent
  rows.forEach((r) => { swipeReveal(r.el, { label: 'Delete', onAction: () => deleteSet(ex, r.i) }); });
  if (justAdded) { const r = rows.find((x) => ex.sets[x.i] && ex.sets[x.i].k === justAdded); justAdded = ''; if (r) jobs2.push(() => rise(r.el.closest('.mo-swipe') || r.el, { y: 8, ms: 280, scale: 0.98 })); }
  return card;
}
let jobs2 = [];
function exerciseMenu(ex) {
  const a = state.active, ei = a.exercises.indexOf(ex), weighted = ex.type === 'strength', hist = exerciseHistory(ex.exId, 1)[0];
  actionSheet(ex.name, [
    { icon: 'swap', label: 'Replace exercise', sub: 'Swap in a different one, sets stay', onClick: () => pickExercise('Replace with…', (n) => replaceExercise(ei, n), { cat: ex.cat || findExercise(ex.exId)?.cat || '' }) },
    ei > 0 ? { icon: 'arrowUp', label: 'Move up', onClick: () => moveExercise(ei, -1) } : null,
    ei < a.exercises.length - 1 ? { icon: 'arrowDown', label: 'Move down', onClick: () => moveExercise(ei, 1) } : null,
    hist ? { icon: 'copy', label: 'Copy last session', sub: `${dayText(hist.date)} · ${hist.sets.length} sets`, onClick: () => copyLast(ex) } : null,
    weighted ? { icon: 'flame', label: 'Add warm-up sets', onClick: () => addWarmups(ex) } : null,
    weighted ? { icon: 'scale', label: 'Plate calculator', onClick: () => plateSheet(ex.sets.find(isWork)?.w || lastW) } : null,
    { icon: 'timer', label: 'Rest timer', trail: `${restFor(ex)} s`, onClick: () => restSheet(ex) },
    { icon: 'trash', label: 'Remove exercise', danger: true, onClick: () => removeExercise(ei) },
  ]);
}
function reorderSheet() {
  const a = state.active;
  sheet({ title: 'Reorder exercises', onClose: () => view.draw(), content: () => {
    const box = h('div', { class: 'list' });
    const paint = () => {
      clear(box);
      a.exercises.forEach((e, i) => append(box, h('div', { class: 'tr-ro' }, h('span', { class: 'tr-tag mini' }, String(i + 1)), h('div', { class: 'grow title ellipsis' }, e.name),
        h('button', { class: 'icon-btn plain', 'aria-label': `Move ${e.name} up`, disabled: i === 0, onClick: () => { a.exercises.splice(i - 1, 0, a.exercises.splice(i, 1)[0]); commit(); paint(); } }, icon('arrowUp', 18)),
        h('button', { class: 'icon-btn plain', 'aria-label': `Move ${e.name} down`, disabled: i === a.exercises.length - 1, onClick: () => { a.exercises.splice(i + 1, 0, a.exercises.splice(i, 1)[0]); commit(); paint(); } }, icon('arrowDown', 18)))));
    };
    paint(); return box;
  } });
}
function workoutMenu() {
  const a = state.active, wakeOn = state.settings.trainWake !== false;
  const discard = async () => {
    if (!(await confirmSheet('This throws away everything you logged in this workout. Nothing is saved.', { ok: 'Discard', danger: true, title: 'Discard workout?' }))) return;
    discardWorkout(); toast('Workout discarded'); view.draw();
  };
  const weighted = a.exercises.filter((e) => e.type === 'strength');
  const warm = () => {
    if (!weighted.length) return toast('Add a weighted exercise first');
    if (weighted.length === 1) return addWarmups(weighted[0]);
    sheet({ title: 'Warm up which exercise?', content: (s2) => h('div', { class: 'list' }, weighted.map((e) => h('button', { class: 'list-item', onClick: () => { s2.close(); addWarmups(e); } }, icon('flame', 20), h('div', { class: 'grow title' }, e.name)))) });
  };
  actionSheet('Workout options', [
    a.exercises.length > 1 ? { icon: 'list', label: 'Reorder exercises', onClick: reorderSheet } : null,
    { icon: 'scale', label: 'Plate calculator', sub: 'What goes on each side of the bar', onClick: () => plateSheet(lastW) },
    { icon: 'flame', label: 'Add warm-up sets', onClick: warm },
    { icon: 'timer', label: 'Default rest timer', trail: `${state.settings.restSec || 90} s`, onClick: () => restSheet(null) },
    { icon: 'sun', label: 'Keep screen on', trail: wakeOn ? 'On' : 'Off', onClick: () => { state.settings.trainWake = !wakeOn; commit('settings'); if (!wakeOn) holdScreen(); else freeScreen(); toast(`Screen stays on: ${!wakeOn ? 'on' : 'off'}`); } },
    { icon: 'trash', label: 'Discard workout', danger: true, onClick: discard },
  ]);
}
function drawActive(stage, root) {
  const a = state.active;
  clearStaleRest(a);
  const elapsed = h('span', { class: 'tr-elapsed' }, hms((Date.now() - a.start) / 1000)), vol = h('span', { class: 'tr-vol' });
  const count = h('b', { class: 'num-sm' }, '0/0');
  const rg = ring({ size: 46, stroke: 5, pct: 0, color: 'var(--accent)', children: count });
  rg.classList.add('tr-pring'); rg.setAttribute('role', 'img'); rg.setAttribute('aria-label', 'Sets done');
  const rb = restBar();
  const cardsEl = h('div', { class: 'tr-cards' });
  live = { id: a.id, root, elapsed, vol, count, ringEl: rg, bar: rb.bar, rtime: rb.time, rlabel: rb.label, rring: rb.rring, cardsEl, lastDone: -1, lastTotal: -1, lastVol: -1, notified: 0, hiding: false, quietShow: !intro() };
  rb.rring.setAttribute('stroke-dasharray', RING_C.toFixed(2));
  const head = h('div', { class: 'tr-head glass' },
    h('div', { class: 'tr-head-top' },
      h('input', { class: 'tr-name', type: 'text', value: a.name || '', placeholder: 'Workout name', enterkeyhint: 'done', 'aria-label': 'Workout name', onInput: (e) => { a.name = e.target.value; commit(); }, onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } }),
      h('button', { class: 'icon-btn plain tr-wmenu', 'aria-label': 'Workout options', onClick: workoutMenu }, icon('more'))),
    h('div', { class: 'tr-head-bar' },
      h('div', { class: 'tr-clock' }, icon('clock', 16), elapsed, h('span', { class: 'tr-sep' }, '·'), h('span', { class: 'tr-volw' }, vol, h('small', null, ' kg'))),
      rg,
      h('button', { class: 'btn primary sm tr-finish', onClick: finishSheet }, 'Finish')));
  jobs2 = [];
  a.exercises.forEach((e, i) => cardsEl.append(buildCard(e, i)));
  append(stage, [head,
    a.exercises.length ? cardsEl : emptyState('No exercises yet', 'Add your first exercise to start logging sets.', null, { ico: 'dumbbell' }),
    h('button', { class: 'btn block tr-add', onClick: () => pickExercise('Add exercises', addToWorkout, { multi: true }) }, icon('plus'), 'Add exercise'),
    rb.bar]);
  jobs.push(() => {
    live.lastVol = -1; paintStats(a);
    for (const j of jobs2) { try { j(); } catch (e) { console.error(e); } }
    if (intro()) { rise(head, { y: -10, ms: 320, scale: 1 }); [...cardsEl.children].forEach((c, i) => rise(c, { delay: 80 + Math.min(i, 5) * 70, y: 16, ms: 380 })); }
  });
}

// ---------- finish ----------
function durationOf(a, exercises) {
  let sec = (Date.now() - a.start) / 1000, capped = false;
  const lastAt = Math.max(0, ...exercises.flatMap((e) => e.sets.map((s) => s.at || 0)));
  if (sec > 4 * 3600 && lastAt > a.start) { sec = (lastAt - a.start) / 1000 + 120; capped = true; } // forgot to finish: stop the clock at the last set
  return { sec: Math.round(sec), capped };
}
function finishSheet() {
  const a = state.active;
  const pending = a.exercises.flatMap((e) => e.sets.filter((s) => !s.done && hasNeed(e.type, s)).map((s) => [e, s]));
  const exercises = a.exercises.map((e) => ({ ...e, sets: e.sets.filter((s) => s.done) })).filter((e) => e.sets.length);
  const nSets = exercises.reduce((n, e) => n + e.sets.filter(isWork).length, 0);
  const { sec, capped } = durationOf(a, exercises);
  const volume = volumeOf({ exercises }), kg = latestWeight()?.kg || 70, prs = a.prs || [];
  const kcal = exercises.length ? Math.round(exercises.reduce((t, e) => t + metBurn(e.met || 5, kg, sec / 60 / exercises.length), 0)) : 0;
  const name = (a.name || '').trim() || 'Workout';
  const preview = { name, start: a.start, exercises, volume, kcal, prs, durationSec: sec, feel: a.feel };
  const heat = workoutHeat(preview), gs = workoutGroups(preview);
  const save = (api) => {
    const w = finishWorkout({ name, exercises, kcal, volume, prs, durationSec: sec, feel: a.feel, rest: undefined, prBase: undefined });
    advanceRoutine(w); api.close();
    toast(prs.length ? `Workout saved · ${prs.length} new PR${prs.length > 1 ? 's' : ''}` : 'Workout saved');
    view.draw();
  };
  const countThem = (api) => { for (const [e, s] of pending) { s.done = true; s.at = Date.now(); applyPR(e, s, true); } commit(); api.close(); view.draw(); finishSheet(); };
  const vals = [[sec, durShort], [nSets, (v) => String(Math.round(v))], [volume, (v) => fmt(v)], [kcal, (v) => fmt(v)]];
  const cells = [statCell('Duration', durShort(sec)), statCell('Sets done', String(nSets)), statCell('Volume', fmt(volume), 'kg'), statCell('Calories', `~${fmt(kcal)}`, 'kcal')];
  const s = sheet({
    title: 'Finish workout',
    content: (api) => h('div', { class: 'stack tr-fin' },
      h('div', { class: 'tr-fin-hero' }, h('span', { class: 'tr-fin-badge' + (prs.length ? ' pr' : '') }, icon(prs.length ? 'trophy' : 'check', 26)),
        h('div', null, h('h3', null, nSets ? (prs.length ? `${prs.length} new PR${prs.length > 1 ? 's' : ''}. Strong session` : 'Strong session') : 'Nothing ticked yet'), h('div', { class: 'small muted' }, `${name} · ${exercises.length} exercise${exercises.length === 1 ? '' : 's'}`))),
      h('div', { class: 'tr-fin-top' }, Object.keys(heat).length ? miniMap({ heat, view: 'both' }, 'tr-fin-map') : null, h('div', { class: 'tr-stats2' }, cells)),
      gs.length ? h('div', { class: 'tr-gchips' }, gs.map((g) => h('span', { class: 'tr-gchip', style: `--mc:${groupColor(g)}` }, h('i'), g))) : null,
      capped ? h('div', { class: 'small muted' }, 'This ran for a long time, so the clock stops at your last set.') : null,
      nSets ? null : h('div', { class: 'callout' }, icon('info'), h('div', null, 'No sets are ticked yet. Tick a set to save this workout, or discard it from the ⋯ menu.')),
      pending.length ? h('div', { class: 'callout' }, icon('warn'), h('div', { class: 'grow' }, `${pending.length} set${pending.length > 1 ? 's have' : ' has'} numbers but ${pending.length > 1 ? "aren't" : "isn't"} ticked, so ${pending.length > 1 ? "they won't" : "it won't"} be saved.`,
        h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn sm', onClick: () => countThem(api) }, 'Count them')))) : null,
      prs.length ? h('div', { class: 'tr-prcard' }, h('div', { class: 'row' }, icon('trophy', 18), h('b', null, 'Personal records')), prs.map((p) => h('div', { class: 'small' }, `${p.name} · ${p.text}`))) : null,
      h('div', { class: 'tr-feel' }, h('h3', { style: { marginBottom: '8px' } }, 'How did it feel?'), segmented(FEEL, a.feel, (v) => { a.feel = v; commit(); }))),
    actions: (api) => h('div', { class: 'tr-foot' },
      h('button', { class: 'btn primary lg block', disabled: !nSets, onClick: () => save(api) }, icon('check', 20), 'Save workout'),
      h('div', { class: 'tr-foot-row' }, h('button', { class: 'btn tr-share-btn', disabled: !nSets, onClick: () => shareSheet(preview) }, icon('share', 18), 'Share card'), h('button', { class: 'btn', onClick: () => api.close() }, 'Keep going'))),
  });
  // numbers climb to their values when the sheet opens
  s.el.querySelectorAll('.tr-stat-v span').forEach((el, i) => { const [v, f] = vals[i]; countUp(el, v, { from: 0, ms: 700, fmt: i === 3 ? (x) => '~' + fmt(x) : f }); });
  const badge = s.el.querySelector('.tr-fin-badge'); if (badge) { pop(badge, { ms: 560 }); if (prs.length) setTimeout(() => celebrate(badge, { kind: 'pr', count: 12 }), 260); }
}

// ---------- plate calculator ----------
function platesFor(target, bar) {
  let rem = (target - bar) / 2; const out = [];
  if (rem < 0) return { out, rem: 0, under: true };
  for (const p of PLATES) { const n = Math.floor(rem / p + 1e-9); if (n) { out.push([n, p]); rem = +(rem - n * p).toFixed(3); } }
  return { out, rem };
}
function plateSheet(defaultW) {
  let target = defaultW || 60, bar = state.settings.plateBar || 20;
  const result = h('div', { class: 'stack' });
  const paint = () => {
    const { out, rem, under } = platesFor(target, bar);
    clear(result);
    if (under || !target) return append(result, h('div', { class: 'callout info small' }, icon('info'), h('div', null, target ? 'That is lighter than the bar.' : 'Set the weight you want on the bar.')));
    const stack = out.flatMap(([n, p]) => Array(n).fill(p));
    append(result, [
      h('div', { class: 'tr-bar', 'aria-hidden': 'true' }, h('div', { class: 'tr-rod' }), stack.map((p) => h('div', { class: 'tr-plate tp' + String(p).replace('.', '_'), style: { height: 30 + p * 2.6 + 'px' } }, p)), h('div', { class: 'tr-collar' })),
      out.length ? h('div', { class: 'tr-plate-list' }, out.map(([n, p]) => h('span', { class: 'tr-pchip' }, h('i', { class: 'tr-pdot tp' + String(p).replace('.', '_') }), h('b', null, `${n} × ${p}`), ' kg')), h('span', { class: 'small muted' }, 'on each side')) : h('div', { class: 'strong' }, 'Just the bar'),
      rem > 0.001 ? h('div', { class: 'small muted' }, `Closest you can load is ${numStr(target - rem * 2)} kg (${numStr(rem * 2)} kg short).`) : null,
    ]);
  };
  sheet({
    title: 'Plate calculator',
    content: h('div', { class: 'stack' },
      field('Target weight (kg)', h('div', { class: 'tr-stepw' }, stepper({ value: target, min: 0, max: 600, step: 2.5, onChange: (v) => { target = v; paint(); } }))),
      field('Bar', segmented([20, 15, 10].map((n) => ({ id: String(n), label: `${n} kg` })), String(bar), (v) => { bar = +v; state.settings.plateBar = bar; commit('settings'); paint(); })),
      result),
  });
  paint();
}

// ---------- entry ----------
let sig = '';
const sigNow = () => {
  const a = state.active, s = state.settings;
  if (a) return `a:${a.id}:${a.exercises.map((e) => e.exId + ':' + e.sets.length).join(',')}`;
  const last = state.workouts[state.workouts.length - 1];
  return `h:${state.workouts.length}:${last ? last.id : ''}:${s.currentRoutineId}:${s.routineDayIndex}:${state.customRoutines.map((r) => r.id + r.days.length).join('.')}`;
};
export function render(container, ctx) {
  const root = h('div', { class: 'tr' });
  container.append(root);
  let drawn = false, mode = '';
  const draw = () => {
    const y = window.scrollY, next = state.active ? 'active' : 'home', first = !drawn || next !== mode;
    introNow = first; jobs = []; jobs2 = [];
    const stage = h('div', { class: 'tr-stage' });
    const build = () => { if (next === 'active') drawActive(stage, root); else drawHome(stage); };
    if (first) build(); else quiet(build);
    clear(root); root.classList.remove('tr-has-rest'); root.append(stage);
    sig = sigNow();
    if (next === 'active') startTimer(); else stopTimer();
    for (const j of jobs) { try { j(); } catch (e) { console.error(e); } }
    jobs = []; introNow = false;
    if (!first) window.scrollTo(0, y); else if (drawn) window.scrollTo(0, 0);
    drawn = true; mode = next;
  };
  view = { draw, sync: () => { sig = sigNow(); }, ctx };
  draw();
  if (ctx?.params?.exId) detailSheet(ctx.params.exId, { inWorkout: !!state.active });
  return () => { if (sigNow() !== sig) draw(); else if (state.active) tick(); };
}
