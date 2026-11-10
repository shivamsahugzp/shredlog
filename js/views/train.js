// Train tab: workout home (next day, routines, history, exercise browser) and the live workout logger.
// The live logger never rebuilds inputs while the user types: update() only refreshes the clock, rest banner and header stats.
import { state, commit, startWorkout, finishWorkout, discardWorkout, deleteWorkout, findExercise, allExercises, searchExercises, addCustomExercise, allRoutines, saveRoutine, exerciseHistory, lastSetsFor, bestFor, latestWeight, workoutsOn, todayKey, dateKey, parseKey, lastNDays, uid } from '../state.js';
import { h, icon, sheet, toast, confirmSheet, promptSheet, chips, segmented, field, append, clear, emptyState, fmt, fmtDur, fmtClock, fmtDateLabel, fmtShortDate, fmtTime, haptic } from '../ui.js';
import { metBurn, workoutVolume } from '../calc.js';
import { lineChart } from '../charts.js';
import { repRange, nextSuggestion, weeklyVolume, volumeByGroup, MUSCLE_GROUPS } from '../insights.js';
import { bodyMap, MUSCLE_LABELS, groupColor, muscleColor, catGroup, musclesForCats, viewFor } from './body-map.js';
import { weekPlans } from '../train-plan.js';

// ---------- constants ----------
const REST_CHOICES = [60, 90, 120, 180];
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

const ui = { hist: 10, ex: { q: '', cat: '', n: 40 } }; // browser memory that survives re-renders
let view = { draw() {} };   // set by render(): redraws the whole screen
let live = null;            // refs the 1-second tick refreshes (active workout only)
let timer = 0;
let lastW = 0;              // last weight typed, default for the plate calculator

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
const tiles = (pairs) => h('div', { class: 'tiles' }, pairs.map(([l, v]) => h('div', { class: 'tile' }, h('div', { class: 'lbl' }, l), h('div', { class: 'val' }, v))));
const section = (title, body, link) => h('section', { class: 'section' }, h('div', { class: 'section-head' }, h('h2', null, title), link), body);
const menuItem = (ic, label, fn, danger) => h('button', { class: 'list-item' + (danger ? ' tr-danger' : ''), onClick: fn }, icon(ic, 20), h('div', { class: 'grow title' }, label));
const categories = () => [...new Set(allExercises().map((e) => e.cat))].sort();

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
function longPress(el, fn, ms = 600) {
  let t = 0, x = 0, y = 0;
  const stop = () => clearTimeout(t);
  el.addEventListener('pointerdown', (e) => { delete el.dataset.lp; if (e.target.closest('input')) return; x = e.clientX; y = e.clientY; stop(); t = setTimeout(() => { el.dataset.lp = '1'; haptic(); fn(); }, ms); });
  el.addEventListener('pointermove', (e) => { if (Math.hypot(e.clientX - x, e.clientY - y) > 10) stop(); });
  for (const n of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(n, stop);
  el.addEventListener('click', (e) => { if (el.dataset.lp) { delete el.dataset.lp; e.stopPropagation(); e.preventDefault(); } }, true);
}

// ---------- progression hint ----------
function topReps(plan) {
  const range = /(\d+)\s*[-–]\s*(\d+)/.exec(plan?.reps || '');
  if (range) return +range[2];
  const one = /(\d+)/.exec(plan?.reps || '');
  return one ? +one[1] : 12;
}
function bestSet(sets) {
  return sets.filter(isWork).reduce((b, s) => (!b || (s.w || 0) > (b.w || 0) || ((s.w || 0) === (b.w || 0) && (s.r || 0) > (b.r || 0)) ? s : b), null);
}
function hintFor(ex) {
  if (ex.type !== 'strength' && ex.type !== 'bodyweight') return null;
  const hist = exerciseHistory(ex.exId, 3);
  if (!hist.length) return null;
  const work = hist[0].sets.filter(isWork), top = topReps(ex.plan);
  const loaded = ex.type === 'bodyweight' || work.every((s) => s.w > 0);
  if (loaded && work.length >= Math.min(ex.plan?.sets || 2, 3) && work.every((s) => (s.r || 0) >= top)) {
    return { cls: 'good', text: `All sets hit ${top} last time → ${ex.type === 'bodyweight' ? 'add a rep or weight' : 'try +2.5 kg'}` };
  }
  if (hist.length === 3) {
    const b = hist.map((x) => bestSet(x.sets));
    if (b.every(Boolean) && b.every((s) => (s.w || 0) === (b[0].w || 0) && (s.r || 0) === (b[0].r || 0))) return { cls: 'warn', text: 'Stuck 3 sessions → change rep range or swap exercise' };
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
  if (!pr) return;
  s.pr = pr.kind; a.prs.push({ exId: ex.exId, name: ex.name, kind: pr.kind, value: pr.value, text: pr.text, k: s.k });
  if (!silent) toast(`New PR: ${ex.name} ${pr.text}`, { ms: 3200 });
}

// ---------- rest timer + clock ----------
const restFor = (ex) => ex.restSec || ex.plan?.restSec || state.settings.restSec || 90;
function startTimer() { clearInterval(timer); timer = setInterval(tick, 1000); tick(); }
function stopTimer() { clearInterval(timer); timer = 0; live = null; }
function progress(a) {
  let done = 0, total = 0;
  for (const e of a.exercises) for (const s of e.sets) if (isWork(s)) { total++; if (s.done) done++; }
  return { done, total };
}
function tick() {
  const a = state.active;
  if (!live || !live.root.isConnected) return stopTimer(); // the tab was left: unmount
  if (!a || a.id !== live.id) return;
  const p = progress(a);
  live.elapsed.textContent = fmtDur((Date.now() - a.start) / 1000);
  live.stats.textContent = `${p.done}/${p.total} sets · ${fmt(volumeOf(a))} kg`;
  paintRest(a);
}
function paintRest(a) {
  const b = live.banner, r = a.rest;
  live.root.classList.toggle('tr-has-rest', !!r);
  if (!r) return b.classList.add('hide');
  const left = (r.endAt - Date.now()) / 1000;
  if (left <= 0) return endRest(a);
  live.time.textContent = fmtClock(Math.ceil(left));
  live.label.textContent = a.exercises.find((e) => e.exId === r.exId)?.name || 'Rest';
  b.classList.toggle('soon', left <= 10);
  b.classList.remove('hide');
}
function endRest(a) {
  const late = Date.now() - a.rest.endAt;
  a.rest = null; commit();
  if (late < 15000) { try { navigator.vibrate?.([200, 100, 200]); } catch (e) { /* not supported on iOS */ } toast('Rest over'); }
  paintRest(a);
}
function startRest(ex) {
  if (ex.type === 'cardio') return;
  state.active.rest = { endAt: Date.now() + restFor(ex) * 1000, exId: ex.exId };
}
function changeRest(fn) { const a = state.active; if (!a?.rest) return; fn(a); commit(); tick(); }

// ---------- exercise picker (browser + add sheet), detail, custom ----------
function exercisePicker(f, { mode, onPick }) {
  const box = h('div');
  const paint = () => {
    const res = searchExercises(f.q, f.cat, f.n);
    clear(box);
    if (!res.length) {
      return append(box, emptyState('No exercises found', f.q ? `Nothing matches "${f.q}".` : 'Try another category.', h('button', { class: 'btn sm', onClick: () => customSheet(f.q, (ex) => { paint(); onPick(ex); }) }, icon('plus', 16), 'Create your own')));
    }
    append(box, [
      h('div', { class: 'list' }, res.map((ex) => h('div', { class: 'tr-pick' },
        h('button', { class: 'list-item', onClick: () => onPick(ex) }, h('div', { class: 'grow' }, h('div', { class: 'title' }, ex.name), h('div', { class: 'sub' }, `${ex.cat} · ${ex.equipment}`)), icon(mode === 'add' ? 'plus' : 'right', 18)),
        mode === 'add' ? h('button', { class: 'icon-btn plain', 'aria-label': `About ${ex.name}`, onClick: () => detailSheet(ex.id) }, icon('info', 18)) : null))),
      res.length >= f.n ? h('button', { class: 'btn sm block ghost', style: { marginTop: '8px' }, onClick: () => { f.n += 40; paint(); } }, 'Show more') : null,
    ]);
  };
  const input = h('input', { type: 'search', placeholder: 'Search exercises', value: f.q, enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'none', 'aria-label': 'Search exercises', onInput: (e) => { f.q = e.target.value; f.n = 40; paint(); } });
  const cats = chips([{ id: '', label: 'All' }, ...categories().map((c) => ({ id: c, label: c }))], f.cat, (v) => { f.cat = v; f.n = 40; paint(); });
  paint();
  return h('div', { class: 'stack' }, h('div', { class: 'search' }, icon('search'), input), cats, box);
}
function pickExercise(title, cb) {
  sheet({ title, full: true, content: (api) => exercisePicker({ q: '', cat: '', n: 40 }, { mode: 'add', onPick: (ex) => { api.close(); cb(ex); } }) });
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
  return h('div', { class: 'card flat pad-s' }, h('div', { class: 'small strong' }, title),
    lineChart({ series: [{ name: '', color: 'var(--p)', dots: true, points }], fmtY: (v) => String(+v.toFixed(1)), unit: ' ' + unit, height: 150 }));
}
// ---------- form guide: demo media, steps, cues, mistakes, video link ----------
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '');
const exGroup = (ex) => catGroup(ex.cat) || MUSCLE_GROUPS[ex.muscles?.[0]] || null;
const exColor = (ex) => groupColor(exGroup(ex));
const reducedMotion = () => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } };
const exerciseHeat = (ex) => Object.fromEntries((ex.muscles || []).map((m, i) => [m, i === 0 ? 1 : 0.45])); // primary strong, helpers softer

// 16:10 panel. Two images crossfade every 1.2 s (start ↔ end position); tap pauses, then flips the frame by hand.
// Without images it shows the body map with the primary muscle lit. Returns { el, stop }.
function formMedia(ex) {
  const urls = (Array.isArray(ex.img) ? ex.img : []).filter((u) => typeof u === 'string' && u).slice(0, 2);
  const tc = exColor(ex), primary = ex.muscles?.[0];
  let timer = 0;
  const stop = () => { clearInterval(timer); timer = 0; };
  const placeholder = () => {
    const map = bodyMap({ heat: exerciseHeat(ex), view: primary ? viewFor(primary) : 'front' });
    map.classList.add('bm-compact');
    return h('div', { class: 'tr-media tr-ph', style: `--tc:${tc}` }, map,
      h('div', { class: 'tr-ph-txt' }, h('b', null, primary ? MUSCLE_LABELS[primary] || cap(primary) : ex.cat || 'Exercise'),
        h('span', null, 'No demo images yet. Follow the steps below or watch a form video.')));
  };
  if (!urls.length) return { el: placeholder(), stop };

  const reduced = reducedMotion();
  const names = ['Start', 'End'];
  const wrap = h('div', { class: 'tr-media' + (reduced ? ' sbs' : ''), style: `--tc:${tc}` });
  let live = [], cur = 0, paused = false;
  const ind = h('span', { class: 'tr-media-ind', 'aria-hidden': 'true' });
  const ppIcon = h('span', { class: 'tr-media-pp-ic' });
  const sync = () => {
    live.forEach((f, k) => f.classList.toggle('on', reduced || k === cur));
    ind.textContent = `${cur + 1} / ${live.length}`;
    clear(ppIcon); ppIcon.append(icon(paused ? 'play' : 'pause', 16));
  };
  const show = (i) => { cur = (i + live.length) % live.length; sync(); };
  const drop = (frame) => {
    live = live.filter((f) => f !== frame); frame.remove();
    if (!live.length) { stop(); wrap.replaceWith(placeholder()); return; }
    if (live.length < 2) { stop(); wrap.classList.add('single'); }
    show(Math.min(cur, live.length - 1));
  };
  live = urls.map((u, i) => {
    const frame = h('div', { class: 'tr-frame' }, h('img', { src: u, alt: `${ex.name}, ${names[i].toLowerCase()} position`, decoding: 'async', onError: () => drop(frame) }), reduced ? h('span', { class: 'tr-frame-tag' }, names[i]) : null);
    wrap.append(frame); return frame;
  });
  if (urls.length < 2) wrap.classList.add('single');
  if (!reduced && live.length > 1) {
    const hit = h('button', { class: 'tr-media-hit', 'aria-label': 'Exercise demo. Tap to pause, tap again to flip between start and end position.', onClick: () => { if (!paused) { paused = true; sync(); } else show(cur + 1); } });
    const pp = h('button', { class: 'tr-media-pp', 'aria-label': 'Play or pause the demo', onClick: (e) => { e.stopPropagation(); paused = !paused; sync(); } }, ppIcon);
    wrap.append(hit, pp, ind);
    timer = setInterval(() => { if (!wrap.isConnected) return stop(); if (!paused && live.length > 1) show(cur + 1); }, 1200);
  }
  sync();
  return { el: wrap, stop };
}

function detailSheet(exId, { inWorkout = false } = {}) {
  const ex = findExercise(exId);
  if (!ex) return toast('Exercise not found');
  const hist = exerciseHistory(exId, 20), best = bestFor(exId), last = hist[0];
  const block = (title, items, cls = '') => (items?.length ? h('div', null, h('h3', { class: 'tr-sub' }, title), h('ul', { class: 'cue-list ' + cls }, items.map((t) => h('li', null, t)))) : null);
  const stats = [best.w && ['Best weight', `${numStr(best.w)} kg`], best.e1rm && ['Best e1RM', `${numStr(best.e1rm)} kg`], ex.type === 'bodyweight' && best.reps && ['Best reps', best.reps], best.sec && ['Best hold', `${best.sec} s`]].filter(Boolean);
  const media = formMedia(ex);
  const meta = [ex.equipment, ex.level, ex.mechanic].filter(Boolean).map(cap).join(' · ');
  const steps = Array.isArray(ex.steps) ? ex.steps.filter(Boolean) : [];
  sheet({
    title: ex.name,
    onClose: media.stop,
    content: h('div', { class: 'stack tr-detail' },
      media.el,
      meta ? h('div', { class: 'tr-metaline' }, meta) : null,
      (ex.muscles || []).length ? h('div', { class: 'tr-mus' }, ex.muscles.map((m, i) => h('span', { class: 'tr-mus-chip' + (i === 0 ? ' pri' : ''), style: `--mc:${muscleColor(m)}` }, MUSCLE_LABELS[m] || cap(m)))) : null,
      steps.length ? h('div', null, h('h3', { class: 'tr-sub' }, 'How to'), h('ol', { class: 'tr-steps' }, steps.map((t) => h('li', null, h('span', null, t))))) : null,
      block('Coach cues', ex.cues), block('Avoid', ex.mistakes, 'tr-avoid'),
      h('a', { class: 'btn block tr-yt', href: 'https://www.youtube.com/results?search_query=' + encodeURIComponent(ex.name + ' proper form'), target: '_blank', rel: 'noopener' }, icon('play', 18), 'Watch form videos on YouTube'),
      stats.length ? tiles(stats) : h('div', { class: 'small muted' }, 'Not logged yet. Your bests will show here.'),
      last ? h('div', { class: 'card flat pad-s' }, h('div', { class: 'small muted' }, `Last session · ${fmtDateLabel(last.date, todayKey())}`), h('div', { class: 'strong' }, last.sets.map((s) => setText(ex.type, s, true)).join('  ·  '))) : null,
      last ? trendChart(ex, hist) : null),
    actions: state.active && !inWorkout ? (api) => h('button', { class: 'btn primary', onClick: () => { api.close(); addToWorkout(ex); } }, icon('plus'), 'Add to current workout') : undefined,
  });
}

// ---------- routines ----------
function dayLines(day, max = 6) {
  const rows = day.exercises.map((d) => [findExercise(d.ex), `${d.sets} × ${d.reps}`]).filter((r) => r[0]);
  return h('div', { class: 'tr-lines' }, rows.slice(0, max).map(([ex, t]) => h('button', { class: 'tr-line', 'aria-label': `Form guide for ${ex.name}`, onClick: () => detailSheet(ex.id) },
    h('span', { class: 'tr-line-name' }, h('span', { class: 'ellipsis' }, ex.name), icon('info', 14)), h('span', { class: 'muted' }, t))),
  rows.length > max ? h('div', { class: 'small muted' }, `+ ${rows.length - max} more`) : null);
}
function startDay(r, idx) {
  if (state.active) return toast('Finish or discard your current workout first');
  const day = r.days[idx];
  const exercises = day.exercises.map((d) => { const ex = findExercise(d.ex); return ex && entryFor(ex, d.sets || 3, { plan: { reps: d.reps, restSec: d.restSec, sets: d.sets } }); }).filter(Boolean);
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
  const cur = state.settings.currentRoutineId === r.id;
  sheet({
    title: r.name,
    content: (api) => h('div', { class: 'stack' },
      h('div', { class: 'row wrap' }, h('span', { class: 'pill' }, r.level), h('span', { class: 'pill' }, `${r.daysPerWeek} days / week`), r.goal ? h('span', { class: 'pill' }, r.goal) : null),
      r.desc ? h('p', { class: 'small muted' }, r.desc) : null,
      r.days.map((d, i) => h('div', { class: 'tr-day' }, h('div', { class: 'row between' }, h('h3', null, d.name), h('button', { class: 'btn sm', onClick: () => { api.close(); startDay(r, i); } }, `Start ${d.name}`)), dayLines(d, 99)))),
    actions: (api) => h('button', { class: 'btn primary', disabled: cur, onClick: () => { state.settings.currentRoutineId = r.id; state.settings.routineDayIndex = 0; commit('settings'); api.close(); toast(`${r.name} is now your routine`); } }, cur ? 'Current routine' : 'Use this routine'),
  });
}

// ---------- session builder: planned entries, body-map picker ----------
const EQUIP = [{ id: 'all', label: 'All' }, { id: 'machine', label: 'Machine' }, { id: 'cable', label: 'Cable' }, { id: 'barbell', label: 'Barbell' }, { id: 'dumbbell', label: 'Dumbbell' }, { id: 'bodyweight', label: 'Bodyweight' }];
const equipMatch = (ex, f) => f === 'all' || (f === 'bodyweight' ? ex.equipment === 'bodyweight' || ex.equipment === 'none' : ex.equipment === f);
const MY_ROUTINE_ID = 'routine_my_sessions';
const MOBILITY_PICKS = ['cat_cow', 'worlds_greatest_stretch', 'hip_flexor_stretch', 'thoracic_rotation', 'hamstring_stretch', 'childs_pose'];

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
  if (d <= 0) return 'today'; if (d === 1) return 'yesterday'; if (d < 14) return `${d} days ago`;
  return d < 60 ? `${Math.round(d / 7)} weeks ago` : `${Math.round(d / 30)} months ago`;
}
function lastGhost(ex, idx) {
  const l = idx.get(ex.id); if (!l) return null;
  return `Last: ${setText(ex.type, bestSet(l.sets) || l.sets[0], true)} · ${agoText(l.date)}`;
}
// Workout entry with planned reps from repRange and, when there is history, the weight nextSuggestion recommends.
function plannedEntry(ex, { n, plan, restSec } = {}) {
  const range = repRange(ex), hist = lastSetsFor(ex.id);
  const count = Math.max(1, Math.min(6, n || hist.filter(isWork).length || 3));
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

// Thumbnail: first demo image when there is one, otherwise a muscle-group coloured tile.
function thumb(ex) {
  const box = h('span', { class: 'tr-thumb', style: `--tc:${exColor(ex)}`, 'aria-hidden': 'true' }, icon('dumbbell', 20));
  const url = Array.isArray(ex.img) ? ex.img[0] : null;
  if (url) { const img = h('img', { src: url, alt: '', loading: 'lazy', decoding: 'async', onError: () => img.remove() }); box.append(img); }
  return box;
}

function musclePicker({ muscles = [], title = 'Build your session' } = {}) {
  const sel = new Set(muscles), picked = [], f = { equip: 'all', q: '', show: {} };
  const idx = lastIndex();
  let map, selBox, selActions, list, startBtn, saveBtn, seeBtn, count = 0;
  const syncMap = () => map.setSelected([...sel]);

  function syncFooter() {
    const n = picked.length;
    startBtn.textContent = n ? `Start workout · ${n} exercise${n === 1 ? '' : 's'}` : 'Start workout';
    startBtn.disabled = !n; saveBtn.disabled = !n;
  }
  function paintSel() {
    clear(selBox);
    selActions.classList.toggle('hide', !sel.size);
    if (!sel.size) return append(selBox, h('div', { class: 'tr-sel-hint' }, 'Tap muscles on the body to see matching exercises.'));
    append(selBox, [...sel].map((m) => h('button', { class: 'tr-mchip', style: `--mc:${muscleColor(m)}`, 'aria-label': `Remove ${MUSCLE_LABELS[m] || m}`, onClick: () => { sel.delete(m); syncMap(); paintSel(); paintList(); } }, h('i'), MUSCLE_LABELS[m] || m, icon('x', 14))));
  }
  function row(ex) {
    const on = () => picked.includes(ex.id);
    const sub = [h('span', { class: 'pill' }, cap(ex.equipment || 'other'))];
    const ghost = lastGhost(ex, idx); if (ghost) sub.push(h('span', { class: 'tr-ghost' }, ghost));
    const check = h('span', { class: 'tr-check' }, icon('check', 16));
    const main = h('button', { class: 'tr-prow-main', 'aria-pressed': on() ? 'true' : 'false', 'aria-label': `${ex.name}. ${on() ? 'Selected' : 'Not selected'}` }, thumb(ex), h('div', { class: 'grow' }, h('div', { class: 'title' }, ex.name), h('div', { class: 'tr-prow-sub' }, sub)), check);
    const el = h('div', { class: 'tr-prow' + (on() ? ' on' : '') }, main, h('button', { class: 'icon-btn plain tr-info', 'aria-label': `Form guide for ${ex.name}`, onClick: () => detailSheet(ex.id) }, icon('info', 20)));
    main.addEventListener('click', () => {
      const i = picked.indexOf(ex.id); if (i >= 0) picked.splice(i, 1); else picked.push(ex.id);
      el.classList.toggle('on', on()); main.setAttribute('aria-pressed', on() ? 'true' : 'false'); main.setAttribute('aria-label', `${ex.name}. ${on() ? 'Selected' : 'Not selected'}`);
      haptic(); syncFooter();
    });
    return el;
  }
  // Cardio and mobility last; exercises you have done before first (most recent first), then the rest in library order.
  const rank = (e) => (e.cat === 'Cardio' || e.cat === 'Mobility' || e.type === 'cardio' ? 2 : idx.has(e.id) ? 0 : 1);
  const byRank = (a, b) => rank(a) - rank(b) || (rank(a) === 0 ? (idx.get(b.id).date < idx.get(a.id).date ? -1 : idx.get(b.id).date > idx.get(a.id).date ? 1 : 0) : 0);
  const PAGE = 24, SEC_PAGE = 8;
  const more = (key, base, n) => h('button', { class: 'btn sm block ghost', onClick: () => { f.show[key] = (f.show[key] || base) + PAGE; paintList(); } }, `Show ${Math.min(n, PAGE)} more`);
  function paintList() {
    clear(list);
    const pool = searchExercises(f.q, '', 400).filter((e) => equipMatch(e, f.equip));
    const body = [];
    if (!sel.size) {
      count = f.q ? pool.length : 0;
      if (!f.q) body.push(emptyState('Pick a muscle above', 'Tap the body, or search by name. The exercises that train it show up here.'));
      else if (!pool.length) body.push(emptyState('No exercises found', `Nothing matches "${f.q}".`));
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
      if (!count) body.push(emptyState('No exercises match', 'Try another equipment filter or clear the search.'));
    }
    append(list, body);
    seeBtn.classList.toggle('hide', !count);
    seeBtn.textContent = `See ${count} exercise${count === 1 ? '' : 's'}`;
  }

  sheet({
    title, full: true,
    content: (api) => {
      map = bodyMap({ selected: [...sel], onToggle: (m, now) => { if (now) sel.add(m); else sel.delete(m); paintSel(); paintList(); } });
      selBox = h('div', { class: 'tr-sel' });
      list = h('div', { class: 'tr-plist' });
      seeBtn = h('button', { class: 'btn sm tr-see hide', onClick: () => list.scrollIntoView({ behavior: 'smooth', block: 'start' }) });
      selActions = h('div', { class: 'tr-sel-actions hide' }, seeBtn, h('button', { class: 'tr-clear', onClick: () => { sel.clear(); syncMap(); paintSel(); paintList(); } }, 'Clear'));
      const input = h('input', { type: 'search', placeholder: 'Search exercises', enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'none', 'aria-label': 'Search exercises', onInput: (e) => { f.q = e.target.value; f.show = {}; paintList(); } });
      startBtn = h('button', { class: 'btn primary', disabled: true, onClick: () => { api.close(); startFromPicks(picked.slice()); } }, 'Start workout');
      saveBtn = h('button', { class: 'btn sm ghost', disabled: true, onClick: () => saveAsDay(picked.slice(), sessionName(picked.map(findExercise).filter(Boolean))) }, 'Save as routine day…');
      api.footer = h('div', { class: 'tr-foot' }, startBtn, saveBtn);
      paintSel(); paintList(); syncFooter();
      return h('div', { class: 'tr-picker stack' }, map, selBox, selActions, chips(EQUIP, f.equip, (v) => { f.equip = v; f.show = {}; paintList(); }), h('div', { class: 'search' }, icon('search'), input), list);
    },
    actions: (api) => api.footer,
  });
}

// ---------- habit: "your habit says…", week strip, trained-this-week map ----------
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const SHORT_DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const GROUP_ORDER = ['Chest', 'Back', 'Shoulders', 'Arms', 'Legs', 'Core'];
const dotsFor = (groups, max = 3) => groups.slice(0, max).map((g) => h('i', { class: 'tr-gdot', style: `background:${groupColor(catGroup(g))}`, title: g }));
const heatOf = (muscles) => Object.fromEntries(muscles.map((m) => [m, 1]));
function miniMap(opts, cls = '') { const m = bodyMap(opts); m.classList.add('bm-compact'); if (cls) m.classList.add(cls); return m; }
const exCount = (w) => (w?.exercises || []).length;

function daySheet(plan) {
  const t = plan.template, muscles = musclesForCats(plan.groups);
  const kids = [];
  if (plan.kind === 'train') {
    kids.push(
      h('div', { class: 'tr-gchips' }, plan.groups.map((g) => h('span', { class: 'tr-gchip', style: `--mc:${groupColor(catGroup(g))}` }, h('i'), g))),
      muscles.length ? miniMap({ heat: heatOf(muscles), view: 'both' }, 'tr-day-map') : null,
      h('div', { class: 'small muted' }, `${plan.hits} of the last ${plan.weeksObserved} ${plan.dayName}s`),
      plan.lastDate ? h('div', { class: 'card flat pad-s' }, h('div', { class: 'small muted' }, 'Last session'), h('div', { class: 'strong' }, `${fmtDateLabel(plan.lastDate, todayKey())}${t ? ` · ${t.name || 'Workout'} · ${exCount(t)} exercises` : ''}`)) : null);
  } else if (plan.kind === 'rest') {
    kids.push(h('div', { class: 'tr-rest-note' }, icon('moon', 28), h('div', null, h('b', null, 'Usually a rest day'), h('div', { class: 'small muted' }, 'Recovery is where muscle grows.'))));
  } else {
    kids.push(h('div', { class: 'empty' }, h('b', null, `No pattern on ${plan.dayName}s yet`), plan.dataWeeks < 2 ? 'ShredLog learns your weekly pattern after about two weeks of logging.' : 'Train on this day a few times and it will remember.'));
  }
  sheet({
    title: `${plan.dayName}s`,
    content: h('div', { class: 'stack' }, kids),
    actions: (api) => h('div', { class: 'tr-foot' },
      plan.kind === 'train' && t ? h('button', { class: 'btn primary', onClick: () => { api.close(); startFromTemplate(t); } }, 'Start this') : null,
      plan.kind === 'rest' ? h('button', { class: 'btn primary', onClick: () => { api.close(); startMobility(); } }, 'Light mobility (10 min)') : null,
      h('button', { class: plan.kind === 'unknown' ? 'btn primary' : 'btn', onClick: () => { api.close(); musclePicker({ muscles }); } }, 'Pick muscles')),
  });
}

function weekStrip(plans) {
  const today = new Date().getDay();
  return h('div', { class: 'tr-week-strip', role: 'group', 'aria-label': 'Your usual training week' }, WEEK_ORDER.map((wd) => {
    const p = plans[wd], what = p.kind === 'train' ? p.label : p.kind === 'rest' ? 'usually rest' : 'no pattern yet';
    const mark = p.kind === 'train' ? h('span', { class: 'tr-wk-dots' }, dotsFor(p.groups)) : p.kind === 'rest' ? h('span', { class: 'tr-wk-rest' }, '–') : h('span', { class: 'tr-wk-dots' }, h('i', { class: 'tr-gdot empty' }));
    return h('button', { class: `tr-wk ${p.kind}${wd === today ? ' today' : ''}`, 'aria-label': `${p.dayName}: ${what}`, 'aria-current': wd === today ? 'date' : null, onClick: () => daySheet(p) }, h('span', { class: 'tr-wk-d' }, SHORT_DAY[wd]), mark);
  }));
}

// Card for today's weekday: what you usually do, one tap to repeat it, and the Mon–Sun strip.
function habitCard(plans) {
  const p = plans[new Date().getDay()], t = p.template, muscles = musclesForCats(p.groups);
  const done = workoutsOn(todayKey());
  const copy = [h('div', { class: 'micro muted' }, `${p.dayName} · Today`), h('h3', null, 'Your habit says…')];
  const btns = [];
  let art = null;
  if (p.kind === 'train') {
    copy.push(h('div', { class: 'tr-plan-sum', 'aria-label': p.summary }, h('span', { class: 'tr-plan-dots', 'aria-hidden': 'true' }, dotsFor(p.groups)), 'You usually train ', h('b', null, p.label), ` (${p.hits} of last ${p.weeksObserved} ${p.dayName}s)`));
    if (t) copy.push(h('div', { class: 'small muted' }, `Last ${p.dayName}: ${t.name || 'Workout'} · ${exCount(t)} exercises`));
    if (t) btns.push(h('button', { class: 'btn primary', onClick: () => startFromTemplate(t) }, icon('reset', 16), `Repeat last ${p.dayName}`));
    btns.push(h('button', { class: 'btn', onClick: () => musclePicker({ muscles }) }, 'Pick muscles'));
    if (muscles.length) art = miniMap({ heat: heatOf(muscles), view: 'both' }, 'tr-plan-art');
  } else if (p.kind === 'rest') {
    copy.push(h('div', { class: 'tr-plan-sum' }, p.summary));
    btns.push(h('button', { class: 'btn', onClick: startMobility }, icon('moon', 16), 'Light mobility (10 min)'));
    art = h('div', { class: 'tr-plan-moon', 'aria-hidden': 'true' }, icon('moon', 30));
  } else {
    copy.push(h('div', { class: p.dataWeeks < 2 ? 'small muted' : 'tr-plan-sum' }, p.summary));
  }
  return h('div', { class: 'card tr-plan-card tr-plan-' + p.kind },
    h('div', { class: 'tr-plan-top' }, h('div', { class: 'tr-plan-copy' }, copy), art),
    done.length ? h('div', { class: 'tr-plan-done' }, icon('check', 14), `Logged today: ${done.map((w) => w.name || 'Workout').join(', ')}`) : null,
    btns.length ? h('div', { class: 'tr-plan-btns' }, btns) : null,
    weekStrip(plans));
}

function sessionCard() {
  const art = miniMap({ heat: { chest: 1, 'front delts': 0.7, 'side delts': 0.7, biceps: 0.5, abs: 0.35, quads: 0.6 }, view: 'both' }, 'tr-build-art');
  return h('div', { class: 'card tr-build-card' },
    h('div', { class: 'tr-build-copy' }, h('h3', null, "Build today's session from the body"), h('p', { class: 'small' }, 'Tap the muscles you want to train. Pick from every exercise that works them.'),
      h('button', { class: 'btn primary', onClick: () => musclePicker() }, icon('target', 18), 'Pick muscles')),
    art);
}

// "Trained this week": last 7 days of hard sets as a heat map (10+ sets = full colour) plus a sets-per-group bar for each group.
function weekMapCard() {
  const keys = lastNDays(7), vol = weeklyVolume(keys), groups = volumeByGroup(keys);
  const heat = Object.fromEntries(Object.entries(vol).map(([m, v]) => [m, Math.min(1, v / 10)]));
  const map = miniMap({ heat, view: 'both', formatHeat: (m) => (vol[m] ? `${fmt(vol[m], 1)} sets` : 'not yet') }, 'tr-weekmap-fig');
  const max = Math.max(10, ...GROUP_ORDER.map((g) => groups[g] || 0)), any = Object.keys(vol).length > 0;
  return h('div', { class: 'card tr-weekmap' },
    h('div', { class: 'tr-weekmap-body' }, map,
      h('div', { class: 'tr-gbars' }, GROUP_ORDER.map((g) => h('div', { class: 'tr-gbar' }, h('span', { class: 'tr-gbar-l' }, g), h('span', { class: 'tr-gbar-t' }, h('i', { style: `width:${Math.round(((groups[g] || 0) / max) * 100)}%;background:${groupColor(g)}` })), h('b', null, fmt(groups[g] || 0, 0)))))),
    h('div', { class: 'micro muted tr-weekmap-note' }, any ? 'Hard sets in the last 7 days (helper muscles count half). Tap a muscle for its number.' : 'Nothing logged in the last 7 days. The muscles you train will light up here.'));
}

// ---------- home ----------
function begin(w) {
  const exercises = w.exercises || [];
  startWorkout({ prs: [], rest: null, ...w, prBase: Object.fromEntries(exercises.map((e) => [e.exId, bestFor(e.exId)])) });
  window.scrollTo(0, 0); view.draw();
}
function nextCard() {
  const r = allRoutines().find((x) => x.id === state.settings.currentRoutineId);
  if (!r?.days?.length) return null;
  const idx = (state.settings.routineDayIndex || 0) % r.days.length, day = r.days[idx];
  return h('div', { class: 'card tr-next' },
    h('div', { class: 'row between' }, h('div', { class: 'grow' }, h('div', { class: 'micro muted' }, `Day ${idx + 1} of ${r.days.length}`), h('h3', null, `Next: ${day.name} · ${r.name}`)),
      h('button', { class: 'btn primary', onClick: () => startDay(r, idx) }, icon('play', 16), 'Start')),
    h('div', { class: 'tr-dots', 'aria-hidden': 'true' }, r.days.map((d, i) => h('i', { class: i === idx ? 'on' : i < idx ? 'past' : '', title: d.name }))),
    dayLines(day, 4));
}
function routinesList() {
  const all = allRoutines();
  if (!all.length) return emptyState('No routines yet', 'Routines will appear here once they load.');
  return h('div', { class: 'stack' }, all.map((r) => h('button', { class: 'card flat pad-s tr-routine', onClick: () => routineSheet(r) },
    h('div', { class: 'row between' }, h('h3', null, r.name), state.settings.currentRoutineId === r.id ? h('span', { class: 'pill good' }, 'Current') : icon('right', 18)),
    h('div', { class: 'row wrap', style: { marginTop: '6px' } }, h('span', { class: 'pill' }, r.level), h('span', { class: 'pill' }, `${r.daysPerWeek} days / week`)),
    r.goal ? h('div', { class: 'small muted', style: { marginTop: '6px' } }, r.goal) : null)));
}
function historyList() {
  const all = [...state.workouts].sort((a, b) => b.start - a.start);
  if (!all.length) return emptyState('No workouts yet', 'Start one above and it will show up here.');
  const shown = all.slice(0, ui.hist);
  return h('div', null,
    h('div', { class: 'list' }, shown.map((w) => {
      const sec = w.durationSec ?? Math.round(((w.end || w.start) - w.start) / 1000);
      return h('button', { class: 'list-item', onClick: () => summarySheet(w) },
        h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, w.name || 'Workout'),
          h('div', { class: 'sub' }, [fmtDateLabel(dateKey(new Date(w.start)), todayKey()), fmtDur(sec), `${countSets(w)} sets`, w.kcal ? `${fmt(w.kcal)} kcal` : null].filter(Boolean).join(' · '))),
        h('div', { class: 'trail' }, h('b', null, `${fmt(w.volume ?? volumeOf(w))} kg`), w.prs?.length ? h('span', { class: 'pr-tag' }, icon('trophy', 11), `${w.prs.length} PR`) : null));
    })),
    all.length > ui.hist ? h('button', { class: 'btn sm block ghost', style: { marginTop: '8px' }, onClick: () => { ui.hist += 10; view.draw(); } }, `Show more (${all.length - ui.hist} older)`) : null);
}
function summarySheet(w) {
  const sec = w.durationSec ?? Math.round(((w.end || w.start) - w.start) / 1000);
  const remove = async (api) => {
    if (!(await confirmSheet(`Delete "${w.name || 'Workout'}" from your history?`, { ok: 'Delete', danger: true, title: 'Delete workout?' }))) return;
    api.close(); deleteWorkout(w.id);
    toast('Workout deleted', { action: 'Undo', ms: 5000, onAction: () => { state.workouts.push(w); commit('workout'); } });
  };
  const repeat = (api) => {
    api.close();
    begin({ name: w.name, exercises: (w.exercises || []).map((e) => entryFor({ id: e.exId, name: e.name, type: e.type, met: e.met }, Math.max(1, e.sets.filter(isWork).length))) });
  };
  sheet({
    title: w.name || 'Workout',
    content: h('div', { class: 'stack' },
      h('div', { class: 'small muted' }, `${fmtDateLabel(dateKey(new Date(w.start)), todayKey())} · ${fmtTime(w.start)}${w.feel ? ' · felt ' + w.feel : ''}`),
      tiles([['Duration', fmtDur(sec)], ['Volume', `${fmt(w.volume ?? volumeOf(w))} kg`], ['Sets', countSets(w)], ['Calories', w.kcal ? `${fmt(w.kcal)} kcal` : '–']]),
      w.prs?.length ? h('div', { class: 'card flat pad-s' }, h('div', { class: 'strong' }, 'Personal records'), w.prs.map((p) => h('div', { class: 'small' }, `${p.name} · ${p.text || ''}`))) : null,
      (w.exercises || []).length ? (w.exercises).map((e) => h('div', { class: 'card flat pad-s' }, h('div', { class: 'strong' }, e.name),
        e.sets.map((s, i) => h('div', { class: 'tr-sumset' }, h('span', { class: 'tr-tag mini t-' + (s.t || 'N').toLowerCase() }, setLabel(e, i)), h('span', null, setText(e.type, s, true)), s.pr ? h('span', { class: 'pr-tag' }, 'PR') : null)),
        e.notes ? h('div', { class: 'small muted', style: { marginTop: '4px' } }, e.notes) : null)) : emptyState('No sets saved', 'This workout has no exercises.')),
    actions: (api) => [h('button', { class: 'btn danger', onClick: () => remove(api) }, icon('trash', 18), 'Delete'), state.active ? null : h('button', { class: 'btn primary', onClick: () => repeat(api) }, 'Repeat workout')],
  });
}
function drawHome(root) {
  const week = state.workouts.filter((w) => w.start > Date.now() - 7 * 864e5).length;
  append(root, [
    h('div', { class: 'screen-head' }, h('div', null, h('h1', null, 'Train'), h('div', { class: 'sub' }, week ? `${week} workout${week === 1 ? '' : 's'} in the last 7 days` : 'Nothing logged in the last 7 days'))),
    nextCard(),
    habitCard(weekPlans()),
    sessionCard(),
    h('button', { class: 'btn block tr-empty-start', onClick: () => begin({ name: 'Workout' }) }, icon('plus'), 'Start empty workout'),
    section('Trained this week', weekMapCard()),
    section('Routines', routinesList()),
    section('History', historyList()),
    section('Exercises', exercisePicker(ui.ex, { mode: 'browse', onPick: (ex) => detailSheet(ex.id) }),
      h('button', { class: 'link', onClick: () => customSheet('', (ex) => detailSheet(ex.id)) }, '+ New')),
  ]);
}

// ---------- active workout ----------
function addToWorkout(ex) {
  const a = state.active;
  if (!a) return toast('Start a workout first');
  a.exercises.push(entryFor(ex, 3)); (a.prBase ||= {})[ex.id] ||= bestFor(ex.id);
  commit(); view.draw();
  const cards = document.querySelectorAll('.tr-ex');
  cards[cards.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
function replaceExercise(ei, ex) {
  const a = state.active, old = a.exercises[ei];
  a.prs = (a.prs || []).filter((p) => !old.sets.some((s) => s.k === p.k));
  a.exercises[ei] = entryFor(ex, old.sets.length || 3, { notes: old.notes, plan: old.plan, restSec: old.restSec });
  (a.prBase ||= {})[ex.id] ||= bestFor(ex.id);
  commit(); view.draw();
}
async function removeExercise(ei) {
  const a = state.active, ex = a.exercises[ei];
  if (ex.sets.some((s) => s.done || !isBlank(ex.type, s)) && !(await confirmSheet(`Remove ${ex.name} and its sets from this workout?`, { ok: 'Remove', danger: true, title: 'Remove exercise?' }))) return;
  a.prs = (a.prs || []).filter((p) => !ex.sets.some((s) => s.k === p.k));
  a.exercises.splice(ei, 1); commit(); view.draw();
}
function addSet(ex) {
  const src = [...ex.sets].reverse().find(isWork) || ex.sets[ex.sets.length - 1], s = newSet(ex.type);
  if (src) for (const [k] of fieldsOf(ex.type)) s[k] = src[k];
  ex.sets.push(s); commit(); view.draw();
}
async function deleteSet(ex, i, ask) {
  if (ask && !(await confirmSheet(`Delete set ${setLabel(ex, i)} of ${ex.name}?`, { ok: 'Delete', danger: true, title: 'Delete set?' }))) return;
  const [s] = ex.sets.splice(i, 1);
  state.active.prs = (state.active.prs || []).filter((p) => p.k !== s.k);
  commit(); view.draw();
}
function addWarmups(ei) {
  const ex = state.active.exercises[ei];
  if (ex.type !== 'strength') return toast('Warm-up sets are for weighted exercises');
  if (ex.sets[0]?.t === 'W') return toast('Warm-up sets are already there');
  const W = ex.sets.find((s) => isWork(s) && s.w)?.w || prevSets(ex.exId).n.find((s) => s.w)?.w;
  if (!W) return toast('Enter your first working weight so I can work out the warm-ups');
  const plan = [[0.4, 8], [0.6, 5], [0.8, 3]].map(([f, r]) => [round25(W * f), r]).filter(([w], i, arr) => w > 0 && w < W && (i === 0 || w !== arr[i - 1][0]));
  ex.sets.unshift(...plan.map(([w, r]) => ({ ...newSet(ex.type), t: 'W', w, r })));
  commit(); view.draw();
}
function toggleDone(ex, s) {
  const a = state.active;
  if (s.done) { s.done = false; delete s.at; applyPR(ex, s, true); return commit(), true; }
  if (!hasNeed(ex.type, s)) { toast(`Add ${need(ex.type)[1]} first`); return false; }
  s.done = true; s.at = Date.now();
  if (s.w) lastW = s.w;
  applyPR(ex, s);
  startRest(ex);
  commit(); tick();
  return true;
}

// --- rows & cards ---
function paintRow(ref) {
  const { ex, i, prev } = ref, s = ex.sets[i], p = prevFor(ex, i, prev), fs = fieldsOf(ex.type);
  ref.nBtn.textContent = setLabel(ex, i);
  ref.nBtn.className = 'n tr-tag t-' + (s.t || 'N').toLowerCase();
  ref.nBtn.setAttribute('aria-label', `Set ${setLabel(ex, i)}, ${SET_NAMES[s.t || 'N']}. Tap to change type`);
  clear(ref.prevEl); append(ref.prevEl, s.pr ? h('span', { class: 'pr-tag' }, icon('trophy', 11), 'PR') : setText(ex.type, p) || '–');
  fs.forEach(([k], fi) => { ref.inputs[fi].placeholder = p && p[k] != null ? numStr(p[k]) : (k === 'r' && ex.plan?.reps) || ''; });
  ref.el.classList.toggle('is-done', !!s.done);
  ref.el.classList.toggle('tr-blank', isBlank(ex.type, s) && !s.done && ex.sets.length > 1);
  ref.doneBtn.classList.toggle('on', !!s.done);
  ref.doneBtn.setAttribute('aria-pressed', s.done ? 'true' : 'false');
}
function buildRow(ex, i, prev, repaint) {
  const s = ex.sets[i], fs = fieldsOf(ex.type), ref = { ex, i, prev };
  ref.nBtn = h('button', { class: 'n tr-tag', onClick: () => {
    s.t = SET_TYPES[(SET_TYPES.indexOf(s.t || 'N') + 1) % SET_TYPES.length];
    if (s.done) applyPR(ex, s, true);
    commit(); repaint();
  } });
  ref.prevEl = h('div', { class: 'prev' });
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
    if (toggleDone(ex, s)) haptic(); else ref.inputs[Math.max(0, fs.findIndex(([k]) => k === need(ex.type)[0]))].focus();
    repaint();
  } }, icon('check', 20));
  const del = h('button', { class: 'tr-x', 'aria-label': `Delete set ${i + 1}`, onClick: () => deleteSet(ex, i, false) }, icon('x', 12));
  ref.el = h('div', { class: 'set-row tr-set', onContextmenu: (e) => e.preventDefault() }, del, ref.nBtn, ref.prevEl, ref.inputs, ref.doneBtn);
  longPress(ref.el, () => deleteSet(ex, i, true));
  return ref;
}
function buildCard(ex, ei) {
  const prev = prevSets(ex.exId), rows = [];
  const repaint = () => rows.forEach(paintRow);
  const body = h('div', { class: 'tr-sets' }, ex.sets.map((s, i) => { const r = buildRow(ex, i, prev, repaint); rows.push(r); return r.el; }));
  repaint();
  const hint = hintFor(ex), muscles = findExercise(ex.exId)?.muscles?.join(', ');
  const plan = ex.plan ? `Plan ${ex.plan.sets || ex.sets.length} × ${ex.plan.reps}` : '';
  return h('section', { class: 'card tr-ex' },
    h('div', { class: 'tr-ex-head' },
      h('button', { class: 'tr-ex-name', onClick: () => detailSheet(ex.exId, { inWorkout: true }) }, ex.name),
      h('button', { class: 'icon-btn plain tr-info', 'aria-label': `Form guide for ${ex.name}`, onClick: () => detailSheet(ex.exId, { inWorkout: true }) }, icon('info', 20)),
      h('button', { class: 'icon-btn plain', 'aria-label': `Options for ${ex.name}`, onClick: () => exerciseMenu(ei) }, icon('more'))),
    h('div', { class: 'small muted' }, [muscles, plan].filter(Boolean).join(' · ')),
    hint ? h('div', { class: 'tr-hint' }, h('span', { class: 'pill ' + hint.cls }, hint.text)) : null,
    h('input', { class: 'tr-note', type: 'text', value: ex.notes || '', placeholder: 'Add a note', enterkeyhint: 'done', 'aria-label': `Note for ${ex.name}`,
      onInput: (e) => { ex.notes = e.target.value; commit(); }, onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } }),
    h('div', { class: 'set-row head' }, h('div', null, 'Set'), h('div', null, 'Previous'), fieldsOf(ex.type).map(([, l]) => h('div', null, l)), h('div', null, '✓')),
    body,
    h('button', { class: 'btn sm block ghost', onClick: () => addSet(ex) }, icon('plus', 16), 'Add set'));
}
function exerciseMenu(ei) {
  const ex = state.active.exercises[ei], weighted = ex.type === 'strength';
  sheet({
    title: ex.name,
    content: (api) => h('div', { class: 'stack' },
      h('div', { class: 'list' },
        menuItem('swap', 'Replace exercise', () => { api.close(); pickExercise('Replace with…', (n) => replaceExercise(ei, n)); }),
        weighted ? menuItem('timer', 'Add warm-up sets', () => { api.close(); addWarmups(ei); }) : null,
        weighted ? menuItem('scale', 'Plate calculator', () => { api.close(); plateSheet(ex.sets.find(isWork)?.w || lastW); }) : null,
        menuItem('trash', 'Remove exercise', () => { api.close(); removeExercise(ei); }, true)),
      h('div', null, h('div', { class: 'small strong', style: { marginBottom: '6px' } }, 'Rest time after each set'),
        chips([{ id: '0', label: 'Default' }, ...REST_CHOICES.map((s) => ({ id: String(s), label: `${s} s` }))], String(ex.restSec || 0), (v) => { if (+v) ex.restSec = +v; else delete ex.restSec; commit(); }))),
  });
}
function workoutMenu() {
  const a = state.active;
  const weighted = a.exercises.map((e, i) => [e, i]).filter(([e]) => e.type === 'strength');
  const warm = (api) => {
    api.close();
    if (!weighted.length) return toast('Add a weighted exercise first');
    if (weighted.length === 1) return addWarmups(weighted[0][1]);
    sheet({ title: 'Warm up which exercise?', content: (s2) => h('div', { class: 'list' }, weighted.map(([e, i]) => menuItem('timer', e.name, () => { s2.close(); addWarmups(i); }))) });
  };
  const discard = async (api) => {
    api.close();
    if (!(await confirmSheet('This throws away everything you logged in this workout. Nothing is saved.', { ok: 'Discard', danger: true, title: 'Discard workout?' }))) return;
    discardWorkout(); toast('Workout discarded'); view.draw();
  };
  sheet({ title: 'Workout options', content: (api) => h('div', { class: 'list' },
    menuItem('scale', 'Plate calculator', () => { api.close(); plateSheet(lastW); }),
    menuItem('timer', 'Add warm-up sets', () => warm(api)),
    menuItem('trash', 'Discard workout', () => discard(api), true)) });
}
function drawActive(root) {
  const a = state.active;
  const elapsed = h('span'), stats = h('span');
  const time = h('div', { class: 'time' }, '0:00'), label = h('div', { class: 'micro ellipsis' });
  const banner = h('div', { class: 'rest-banner hide', role: 'timer' }, icon('timer', 22), h('div', { class: 'tr-rest-col' }, time, label),
    h('button', { class: 'btn', onClick: () => changeRest((s) => { s.rest.endAt += 30000; }) }, '+30 s'),
    h('button', { class: 'btn', onClick: () => changeRest((s) => { s.rest = null; }) }, 'Skip'));
  live = { id: a.id, root, elapsed, stats, banner, time, label };
  append(root, [
    h('div', { class: 'tr-head' },
      h('input', { class: 'tr-name', type: 'text', value: a.name || '', placeholder: 'Workout name', enterkeyhint: 'done', 'aria-label': 'Workout name', onInput: (e) => { a.name = e.target.value; commit(); }, onKeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } }),
      h('button', { class: 'btn primary sm', onClick: finishSheet }, 'Finish'),
      h('button', { class: 'icon-btn', 'aria-label': 'Workout options', onClick: workoutMenu }, icon('more'))),
    h('div', { class: 'tr-meta' }, icon('clock', 15), elapsed, h('span', { class: 'muted' }, '·'), stats),
    a.exercises.length ? a.exercises.map(buildCard) : emptyState('No exercises yet', 'Add your first exercise to start logging sets.'),
    h('button', { class: 'btn block tr-add', onClick: () => pickExercise('Add exercise', addToWorkout) }, icon('plus'), 'Add exercise'),
    banner,
  ]);
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
  const save = (api) => {
    const w = finishWorkout({ name: (a.name || '').trim() || 'Workout', exercises, kcal, volume, prs, durationSec: sec, feel: a.feel, rest: undefined, prBase: undefined });
    advanceRoutine(w); api.close();
    toast(prs.length ? `Workout saved · ${prs.length} new PR${prs.length > 1 ? 's' : ''}` : 'Workout saved');
    view.draw();
  };
  const countThem = (api) => { for (const [e, s] of pending) { s.done = true; s.at = Date.now(); applyPR(e, s, true); } commit(); api.close(); view.draw(); finishSheet(); };
  sheet({
    title: 'Finish workout',
    content: (api) => h('div', { class: 'stack' },
      tiles([['Duration', fmtDur(sec)], ['Exercises', exercises.length], ['Sets done', nSets], ['Volume', `${fmt(volume)} kg`], ['Calories', `~${fmt(kcal)} kcal`], ['New PRs', prs.length]]),
      capped ? h('div', { class: 'small muted' }, 'This ran for a long time, so the clock stops at your last set.') : null,
      nSets ? null : h('div', { class: 'callout' }, icon('info'), h('div', null, 'No sets are ticked yet. Tick a set to save this workout, or discard it from the ⋯ menu.')),
      pending.length ? h('div', { class: 'callout' }, icon('warn'), h('div', { class: 'grow' }, `${pending.length} set${pending.length > 1 ? 's have' : ' has'} numbers but ${pending.length > 1 ? "aren't" : "isn't"} ticked, so ${pending.length > 1 ? "they won't" : "it won't"} be saved.`,
        h('div', { style: { marginTop: '8px' } }, h('button', { class: 'btn sm', onClick: () => countThem(api) }, 'Count them')))) : null,
      prs.length ? h('div', { class: 'card flat pad-s' }, h('div', { class: 'strong' }, 'Personal records'), prs.map((p) => h('div', { class: 'row small', style: { marginTop: '4px' } }, h('span', { class: 'pr-tag' }, icon('trophy', 11), 'PR'), `${p.name} · ${p.text}`))) : null,
      h('div', null, h('h3', { style: { marginBottom: '8px' } }, 'How did it feel?'), segmented(FEEL, a.feel, (v) => { a.feel = v; commit(); }))),
    actions: (api) => [h('button', { class: 'btn', onClick: () => api.close() }, 'Keep going'), h('button', { class: 'btn primary', disabled: !nSets, onClick: () => save(api) }, 'Save workout')],
  });
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
    if (under || !target) return append(result, h('div', { class: 'small muted' }, target ? 'That is lighter than the bar.' : 'Type the weight you want on the bar.'));
    const stack = out.flatMap(([n, p]) => Array(n).fill(p));
    append(result, [
      h('div', { class: 'tr-bar', 'aria-hidden': 'true' }, h('div', { class: 'tr-rod' }), stack.map((p) => h('div', { class: 'tr-plate p' + String(p).replace('.', '_'), style: { height: 28 + p * 1.6 + 'px' } }, p)), h('div', { class: 'tr-collar' })),
      h('div', { class: 'strong' }, out.length ? out.map(([n, p]) => `${n} × ${p} kg`).join(', ') + ' per side' : 'Just the bar'),
      rem > 0.001 ? h('div', { class: 'small muted' }, `Closest you can load is ${numStr(target - rem * 2)} kg (${numStr(rem * 2)} kg short).`) : null,
    ]);
  };
  sheet({
    title: 'Plate calculator',
    content: h('div', { class: 'stack' },
      field('Target weight (kg)', h('input', { type: 'text', inputmode: 'decimal', value: numStr(target), enterkeyhint: 'done', onFocus: (e) => e.target.select(), onInput: (e) => { target = parseNum(e.target.value) || 0; paint(); } })),
      field('Bar', segmented([20, 15, 10].map((n) => ({ id: String(n), label: `${n} kg` })), String(bar), (v) => { bar = +v; state.settings.plateBar = bar; commit('settings'); paint(); })),
      result),
  });
  paint();
}

// ---------- entry ----------
const sigNow = () => {
  const a = state.active, s = state.settings;
  return a ? `a:${a.id}:${a.exercises.map((e) => e.exId + e.sets.length).join(',')}` : `h:${state.workouts.length}:${s.currentRoutineId}:${s.routineDayIndex}:${state.customRoutines.length}`;
};
export function render(container, ctx) {
  const root = h('div', { class: 'tr' });
  container.append(root);
  let sig = '', mode = '';
  const draw = () => {
    const y = window.scrollY, next = state.active ? 'active' : 'home';
    clear(root); root.classList.remove('tr-has-rest');
    sig = sigNow();
    if (next === 'active') { drawActive(root); startTimer(); } else { stopTimer(); drawHome(root); }
    if (next === mode) window.scrollTo(0, y);
    mode = next;
  };
  view = { draw, ctx };
  draw();
  if (ctx?.params?.exId) detailSheet(ctx.params.exId, { inWorkout: !!state.active });
  return () => { if (sigNow() !== sig) draw(); else if (state.active) tick(); };
}
