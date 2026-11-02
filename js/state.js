// Single in-memory state, persisted whole to IndexedDB (with a localStorage mirror).
import { defaultTargets } from './calc.js';

const DB_NAME = 'shredlog', STORE = 'kv', KEY = 'state', LS_KEY = 'shredlog-backup';
const listeners = {};
export function on(evt, fn) { (listeners[evt] ||= []).push(fn); return () => { listeners[evt] = listeners[evt].filter((f) => f !== fn); }; }
export function emit(evt, data) { (listeners[evt] || []).forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kvGet(k) { const db = await openDB(); return new Promise((res, rej) => { const t = db.transaction(STORE, 'readonly').objectStore(STORE).get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); }
async function kvSet(k, v) { const db = await openDB(); return new Promise((res, rej) => { const tx = db.transaction(STORE, 'readwrite'); tx.objectStore(STORE).put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); }

const initial = () => ({
  meta: { v: 1, created: Date.now(), lastBackup: null },
  profile: null,
  targets: null,
  settings: { theme: 'auto', restSec: 90, glassMl: 250, recents: [], onboarded: false, lastWeeklyReview: null },
  log: {},
  workouts: [],
  active: null,
  customFoods: [],
  favFoods: [],
  savedMeals: [],
  customRoutines: [],
  customExercises: [],
});
const PERSIST = Object.keys(initial());

export const state = { ready: false, data: { foods: [], exercises: [], routines: [], knowledge: null }, ...initial() };

export function snapshot() { const o = {}; for (const k of PERSIST) o[k] = state[k]; return o; }
export function hydrate(obj) { const base = initial(); for (const k of PERSIST) { if (obj[k] !== undefined && obj[k] !== null) state[k] = k === 'settings' ? { ...base.settings, ...obj[k] } : obj[k]; } }

let saveTimer = null;
export function save(immediate) {
  clearTimeout(saveTimer);
  const run = async () => {
    const snap = JSON.parse(JSON.stringify(snapshot()));
    try { await kvSet(KEY, snap); } catch (e) { console.warn('IndexedDB save failed', e); }
    try { localStorage.setItem(LS_KEY, JSON.stringify(snap)); } catch (e) { /* quota — ignore, IDB is primary */ }
  };
  if (immediate) return run();
  saveTimer = setTimeout(run, 250);
}
export function commit(evt) { save(); if (evt) emit(evt); emit('change'); }

export async function load() {
  let saved = null;
  try { saved = await kvGet(KEY); } catch (e) { console.warn('IndexedDB unavailable', e); }
  if (!saved) { try { const ls = localStorage.getItem(LS_KEY); if (ls) saved = JSON.parse(ls); } catch (e) { /* ignore */ } }
  if (saved) hydrate(saved);
  const [foods, exercises, routines, knowledge] = await Promise.all(['foods', 'exercises', 'routines', 'knowledge'].map((n) => fetch(`./data/${n}.json`).then((r) => r.json()).catch(() => (n === 'knowledge' ? null : []))));
  state.data = { foods, exercises, routines, knowledge };
  state.ready = true;
  try { navigator.storage?.persist?.(); } catch (e) { /* ignore */ }
}

// ---- dates ----
export const pad = (n) => String(n).padStart(2, '0');
export function dateKey(d = new Date()) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
export const todayKey = () => dateKey(new Date());
export function parseKey(key) { return new Date(key + 'T12:00:00'); }
export function shiftDate(key, days) { const d = parseKey(key); d.setDate(d.getDate() + days); return dateKey(d); }
export function lastNDays(n, end = todayKey()) { const out = []; for (let i = n - 1; i >= 0; i--) out.push(shiftDate(end, -i)); return out; }
export function weekKeys(end = todayKey()) { return lastNDays(7, end); }
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ---- day records ----
export function day(key) {
  return (state.log[key] ||= { food: [], habits: [], water: 0, sleep: null, steps: null, weight: null, notes: '', measurements: null, partial: false });
}
export const dayIfAny = (key) => state.log[key];

// ---- foods ----
export const allFoods = () => state.customFoods.concat(state.data.foods);
export const findFood = (id) => state.customFoods.find((f) => f.id === id) || state.data.foods.find((f) => f.id === id);
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
export function searchFoods(q, cat, limit = 80) {
  const nq = norm(q); const toks = nq.split(' ').filter(Boolean);
  let list = allFoods();
  if (cat) list = list.filter((f) => f.cat === cat);
  if (!toks.length) return list.slice(0, limit);
  const scored = [];
  for (const f of list) {
    const name = norm(f.name); const kw = (f.kw || []).map(norm).join(' ');
    let score = 0;
    for (const t of toks) {
      if (name.startsWith(t)) score += 6; else if (name.split(' ').some((w) => w.startsWith(t))) score += 4; else if (name.includes(t)) score += 2;
      else if (kw.split(' ').some((w) => w.startsWith(t))) score += 3; else if (kw.includes(t)) score += 1;
      else { score = -1; break; }
    }
    if (score > 0) scored.push([score, f]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].name.length - b[1].name.length);
  return scored.slice(0, limit).map((x) => x[1]);
}
export function touchRecent(foodId) { if (!foodId) return; state.settings.recents = [foodId, ...(state.settings.recents || []).filter((x) => x !== foodId)].slice(0, 40); }
export function recentFoods(n = 12) { return (state.settings.recents || []).map(findFood).filter(Boolean).slice(0, n); }
export function frequentFoods(n = 12, days = 60) {
  const counts = {};
  for (const k of lastNDays(days)) for (const e of (dayIfAny(k)?.food || [])) if (e.foodId) counts[e.foodId] = (counts[e.foodId] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([id]) => findFood(id)).filter(Boolean).slice(0, n);
}
export function toggleFav(foodId) { const i = state.favFoods.indexOf(foodId); if (i >= 0) state.favFoods.splice(i, 1); else state.favFoods.unshift(foodId); commit(); return i < 0; }
export function logFood(key, entry) { const e = { id: uid(), ts: Date.now(), meal: 'snacks', ...entry }; day(key).food.push(e); touchRecent(e.foodId); commit('food'); return e; }
export function logFoods(key, entries) { const out = entries.map((entry) => { const e = { id: uid(), ts: Date.now(), meal: 'snacks', ...entry }; day(key).food.push(e); touchRecent(e.foodId); return e; }); commit('food'); return out; }
export function removeFoods(key, ids) { const d = day(key); const set = new Set(ids); d.food = d.food.filter((e) => !set.has(e.id)); commit('food'); }
export function setPartial(key, v) { day(key).partial = !!v; commit('food'); }
export function addSavedMeal(m) { const s = { id: uid(), ...m }; state.savedMeals.unshift(s); commit(); return s; }
export function removeSavedMeal(id) { state.savedMeals = state.savedMeals.filter((m) => m.id !== id); commit(); }
export function removeFood(key, id) { const d = day(key); d.food = d.food.filter((e) => e.id !== id); commit('food'); }
export function updateFood(key, id, patch) { const e = day(key).food.find((x) => x.id === id); if (e) Object.assign(e, patch); commit('food'); return e; }
export function addCustomFood(food) { const f = { ...food, id: food.id || 'custom_' + uid(), custom: true }; state.customFoods.unshift(f); commit(); return f; }
export function removeCustomFood(id) { state.customFoods = state.customFoods.filter((f) => f.id !== id); commit(); }

// ---- habits (cig / water / coffee / craving / note) ----
export function logHabit(key, type, meta = {}) { const e = { id: uid(), ts: Date.now(), type, ...meta }; day(key).habits.push(e); commit('habit'); return e; }
export function removeHabit(key, id) { const d = day(key); d.habits = d.habits.filter((e) => e.id !== id); commit('habit'); }
export function habitEntries(key, type) { return (dayIfAny(key)?.habits || []).filter((h) => h.type === type); }
export function habitCount(key, type) { return habitEntries(key, type).length; }
export function habitByDate(type, days = 30, end = todayKey()) { const o = {}; for (const k of lastNDays(days, end)) o[k] = habitCount(k, type); return o; }
export function lastHabitTs(type) { let m = 0; for (const d of Object.values(state.log)) for (const h of d.habits || []) if (h.type === type && h.ts > m) m = h.ts; return m || null; }
export function waterMl(key) { return habitEntries(key, 'water').reduce((a, h) => a + (h.ml || state.settings.glassMl || 250), 0); }
// chai & coffee are food entries tagged as drinks; count them by food id prefix
export const isChai = (e) => /^(chai|tea|black_tea|green_tea|masala_chai|kadak|cutting)/.test(e.foodId || '') || /\b(chai|tea)\b/i.test(e.name || '');
export const isCoffee = (e) => /coffee/.test(e.foodId || '') || /coffee/i.test(e.name || '');
export function chaiCount(key) { return (dayIfAny(key)?.food || []).filter(isChai).length; }
export function coffeeCount(key) { return (dayIfAny(key)?.food || []).filter(isCoffee).length; }

// ---- check-ins & symptoms ----
export function setCheckin(key, patch) { day(key).checkin = { ...(day(key).checkin || {}), ts: Date.now(), ...patch }; commit('checkin'); }
export function logSymptom(key, type, sev, meta = {}) { const e = { id: uid(), ts: Date.now(), type, sev, ...meta }; (day(key).symptoms ||= []).push(e); commit('checkin'); return e; }
export function removeSymptom(key, id) { const d = day(key); d.symptoms = (d.symptoms || []).filter((e) => e.id !== id); commit('checkin'); }
export function setRedFlags(key, flags) { day(key).redFlags = flags; commit('checkin'); }

// ---- body ----
export function setWeight(key, kg) { day(key).weight = kg ? +kg : null; commit('weight'); }
export function weights() { return Object.entries(state.log).filter(([, d]) => d.weight).map(([date, d]) => ({ date, kg: d.weight })).sort((a, b) => a.date.localeCompare(b.date)); }
export function latestWeight() { const w = weights(); return w.length ? w[w.length - 1] : (state.profile ? { date: null, kg: state.profile.weightKg } : null); }
export function setMeasurements(key, m) { day(key).measurements = { ...(day(key).measurements || {}), ...m }; commit(); }
export function measurementSeries(field) { return Object.entries(state.log).filter(([, d]) => d.measurements && d.measurements[field]).map(([date, d]) => ({ date, v: d.measurements[field] })).sort((a, b) => a.date.localeCompare(b.date)); }

// ---- totals ----
export function dayTotals(key) {
  const t = { kcal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, n: 0 };
  for (const e of (dayIfAny(key)?.food || [])) { t.kcal += e.kcal || 0; t.p += e.p || 0; t.c += e.c || 0; t.f += e.f || 0; t.fiber += e.fiber || 0; t.sugar += e.sugar || 0; t.n++; }
  for (const k of ['p', 'c', 'f', 'fiber', 'sugar']) t[k] = Math.round(t[k] * 10) / 10;
  t.kcal = Math.round(t.kcal);
  return t;
}
export function intakeByDate(days = 30, end = todayKey()) { const o = {}; for (const k of lastNDays(days, end)) { const d = dayIfAny(k); if (d && d.food.length && !d.partial) o[k] = dayTotals(k).kcal; } return o; }
export function workoutsOn(key) { return state.workouts.filter((w) => dateKey(new Date(w.start)) === key); }
export function dayBurn(key) { return workoutsOn(key).reduce((a, w) => a + (w.kcal || 0), 0); }

// ---- exercises & workouts ----
export const allExercises = () => state.customExercises.concat(state.data.exercises);
export const findExercise = (id) => state.customExercises.find((e) => e.id === id) || state.data.exercises.find((e) => e.id === id);
export function searchExercises(q, cat, limit = 80) {
  const nq = norm(q); const toks = nq.split(' ').filter(Boolean);
  let list = allExercises(); if (cat) list = list.filter((e) => e.cat === cat);
  if (!toks.length) return list.slice(0, limit);
  return list.filter((e) => { const hay = norm(e.name) + ' ' + (e.kw || []).map(norm).join(' ') + ' ' + (e.muscles || []).join(' '); return toks.every((t) => hay.includes(t)); }).slice(0, limit);
}
export function addCustomExercise(ex) { const e = { cues: [], mistakes: [], kw: [], muscles: [], met: 4, type: 'strength', equipment: 'other', ...ex, id: ex.id || 'custom_' + uid(), custom: true }; state.customExercises.unshift(e); commit(); return e; }
export const allRoutines = () => state.customRoutines.concat(state.data.routines);
export function saveRoutine(r) { const i = state.customRoutines.findIndex((x) => x.id === r.id); if (i >= 0) state.customRoutines[i] = r; else state.customRoutines.unshift({ ...r, id: r.id || 'routine_' + uid(), custom: true }); commit(); }
export function removeRoutine(id) { state.customRoutines = state.customRoutines.filter((r) => r.id !== id); commit(); }

export function exerciseHistory(exId, limit = 20) {
  const out = [];
  for (const w of [...state.workouts].sort((a, b) => b.start - a.start)) {
    for (const ex of w.exercises) if (ex.exId === exId) { const sets = ex.sets.filter((s) => s.done && s.t !== 'W'); if (sets.length) out.push({ workoutId: w.id, date: dateKey(new Date(w.start)), sets }); }
    if (out.length >= limit) break;
  }
  return out;
}
export function lastSetsFor(exId) { const h = exerciseHistory(exId, 1); return h.length ? h[0].sets : []; }
export function bestFor(exId) {
  let best = { w: 0, r: 0, e1rm: 0, vol: 0, reps: 0, sec: 0 };
  for (const w of state.workouts) for (const ex of w.exercises) if (ex.exId === exId) for (const s of ex.sets) if (s.done && s.t !== 'W') {
    const e = s.w && s.r ? s.w * (1 + s.r / 30) : 0;
    if ((s.w || 0) > best.w) best.w = s.w || 0;
    if (e > best.e1rm) { best.e1rm = Math.round(e * 10) / 10; }
    if ((s.w || 0) * (s.r || 0) > best.vol) best.vol = (s.w || 0) * (s.r || 0);
    if ((s.r || 0) > best.reps) best.reps = s.r || 0;
    if ((s.sec || 0) > best.sec) best.sec = s.sec || 0;
  }
  return best;
}
export function startWorkout(w) { state.active = { id: uid(), start: Date.now(), name: 'Workout', exercises: [], notes: '', ...w }; commit('workout'); return state.active; }
export function finishWorkout(summary) { const w = { ...state.active, end: Date.now(), ...summary }; state.workouts.push(w); state.active = null; commit('workout'); return w; }
export function discardWorkout() { state.active = null; commit('workout'); }
export function deleteWorkout(id) { state.workouts = state.workouts.filter((w) => w.id !== id); commit('workout'); }

// ---- profile / targets ----
export function setProfile(p) {
  state.profile = { ...(state.profile || {}), ...p };
  if (!state.targets || state.targets.auto !== false) state.targets = { ...defaultTargets(state.profile), auto: true };
  state.settings.onboarded = true;
  commit('profile');
}
export function setTargets(t) { state.targets = { ...(state.targets || {}), ...t, auto: false }; commit('profile'); }
export function recomputeTargets() { state.targets = { ...defaultTargets(state.profile), auto: true }; commit('profile'); }
export function setSetting(k, v) { state.settings[k] = v; commit('settings'); }

// ---- backup ----
export function exportJSON() { return JSON.stringify({ app: 'shredlog', version: 1, exported: new Date().toISOString(), ...snapshot() }); }
export async function importJSON(text) {
  const o = JSON.parse(text);
  if (o.app !== 'shredlog') throw new Error('This file is not a ShredLog backup.');
  hydrate(o); state.meta.lastBackup = Date.now(); await save(true); emit('change');
}
export async function resetAll() { Object.assign(state, initial()); await save(true); emit('change'); }
