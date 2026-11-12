// Weekday pattern learner: "on Mondays you usually train chest, triceps and shoulders; Sundays are rest".
// Pure functions over state.workouts (and the exercise library for each exercise's category). No side effects, no caching.
import { state, dateKey, parseKey, shiftDate, findExercise } from './state.js';
import { MUSCLE_GROUPS } from './insights.js';

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const isWork = (s) => s && s.done && s.t !== 'W';
const MIN_HITS = 2, MIN_SHARE = 0.5, JACCARD = 0.5, TOP_GROUPS = 3;

// The group an exercise trains: its category, else the coarse group of its primary muscle. 'Mobility' is not a training group.
function groupOf(exId) {
  const def = findExercise(exId); if (!def) return null;
  return def.cat || MUSCLE_GROUPS[def.muscles?.[0]] || null;
}
// One workout → { id, start, date, groups } or null when it was not a real training session (nothing done, or mobility only).
function sessionOf(w) {
  const done = (w.exercises || []).map((e) => ({ g: groupOf(e.exId), n: (e.sets || []).filter(isWork).length })).filter((x) => x.n > 0);
  const real = done.filter((x) => x.g !== 'Mobility');
  if (!real.length) return null;
  const strong = real.filter((x) => x.n >= 2 && x.g);
  const pool = strong.length ? strong : real.filter((x) => x.g);   // fall back to single-set exercises (e.g. one cardio block)
  return { id: w.id, start: w.start, date: dateKey(new Date(w.start)), groups: [...new Set(pool.map((x) => x.g))] };
}
function jaccard(a, b) {
  if (!a.size && !b.size) return 1;
  let inter = 0; for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
// Largest cluster of similar sessions (sessions are newest first). Returns { items, groups } where groups are the top groups by frequency.
function dominant(sessions) {
  const clusters = [];
  for (const s of sessions) {
    const set = new Set(s.groups);
    let c = clusters.find((x) => jaccard(x.rep, set) >= JACCARD);
    if (!c) { c = { rep: set, items: [] }; clusters.push(c); }
    c.items.push(s);
  }
  clusters.sort((a, b) => b.items.length - a.items.length || b.items[0].start - a.items[0].start);
  const best = clusters[0];
  const freq = new Map();
  for (const s of best.items) for (const g of s.groups) freq.set(g, (freq.get(g) || 0) + 1);
  const order = best.items[0].groups;           // ties: the order the latest session did them in
  const groups = [...freq.keys()].sort((a, b) => freq.get(b) - freq.get(a) || order.indexOf(a) - order.indexOf(b)).slice(0, TOP_GROUPS);
  return { items: best.items, groups };
}

/** Whole weeks between the first logged training session and today (0 when there is none). */
export function weeksOfData(now = new Date()) {
  let first = null;
  for (const w of state.workouts) { const s = sessionOf(w); if (s && (!first || s.date < first)) first = s.date; }
  if (!first) return 0;
  const days = Math.round((parseKey(dateKey(now)) - parseKey(first)) / 864e5);
  return Math.max(0, Math.floor(days / 7));
}

/**
 * Pattern per weekday (index 0 = Sunday … 6 = Saturday, like Date.getDay()).
 * 'train' when at least half of the observed weeks (and at least 2) had a session that day,
 * 'rest' when the user trains most weeks but this weekday was empty over the last four weeks, otherwise 'unknown'.
 * Today is never counted as a miss, so the answer does not change while the day is still in progress.
 */
export function weekdayPattern(weeks = 8, now = new Date()) {
  const today = dateKey(now);
  const sessions = state.workouts.map(sessionOf).filter(Boolean).sort((a, b) => b.start - a.start);
  const byDate = new Map();
  for (const s of sessions) { if (!byDate.has(s.date)) byDate.set(s.date, []); byDate.get(s.date).push(s); }
  const firstDate = sessions.length ? sessions[sessions.length - 1].date : null;

  const days = [];                                    // observed past days, newest first: { key, wd, block, list }
  if (firstDate) for (let k = 1; k <= weeks * 7; k++) {
    const key = shiftDate(today, -k);
    if (key < firstDate) break;
    days.push({ key, wd: parseKey(key).getDay(), block: Math.floor((k - 1) / 7), list: byDate.get(key) || [] });
  }
  const activeBlocks = [0, 1, 2, 3].filter((b) => days.some((d) => d.block === b && d.list.length)).length;

  const out = [];
  for (let wd = 0; wd < 7; wd++) {
    const mine = days.filter((d) => d.wd === wd);
    const hitDays = mine.filter((d) => d.list.length);
    const own = hitDays.flatMap((d) => d.list);       // newest first
    const lastToday = byDate.get(today)?.length && parseKey(today).getDay() === wd ? today : null;
    const entry = { kind: 'unknown', groups: [], confidence: 0, hits: hitDays.length, weeksObserved: mine.length, sessions: own.map((s) => s.id), templateWorkoutId: null, lastDate: lastToday || hitDays[0]?.key || null };
    if (hitDays.length >= MIN_HITS && hitDays.length / mine.length >= MIN_SHARE) {
      const dom = dominant(hitDays.map((d) => ({ id: d.list[0].id, start: d.list[0].start, groups: [...new Set(d.list.flatMap((x) => x.groups))] })));
      entry.kind = 'train'; entry.groups = dom.groups; entry.confidence = +(dom.items.length / mine.length).toFixed(2); entry.templateWorkoutId = dom.items[0].id;
    } else {
      const recent = mine.filter((d) => d.block < 4);
      if (activeBlocks >= 3 && recent.length >= 3 && recent.every((d) => !d.list.length)) { entry.kind = 'rest'; entry.confidence = +(activeBlocks / 4).toFixed(2); }
    }
    out.push(entry);
  }
  return out;
}

function enrich(entry, wd, now, dataWeeks) {
  const dayName = DAY_NAMES[wd], label = entry.groups.join(' · ');
  const template = entry.templateWorkoutId ? state.workouts.find((w) => w.id === entry.templateWorkoutId) || null : null;
  let summary;
  if (entry.kind === 'train') summary = `You usually train ${label || 'something'} (${entry.hits} of last ${entry.weeksObserved} ${dayName}s)`;
  else if (entry.kind === 'rest') summary = 'Usually your rest day. Recovery is where muscle grows.';
  else summary = dataWeeks < 2 ? 'ShredLog learns your weekly pattern after about two weeks of logging.' : `No regular pattern on ${dayName}s yet.`;
  return { ...entry, weekday: wd, dayName, label, summary, template, dataWeeks, isToday: wd === now.getDay() };
}
/** All seven weekday plans (pattern + label, summary, template workout), index 0 = Sunday. */
export function weekPlans(now = new Date(), weeks = 8) {
  const dataWeeks = weeksOfData(now);
  return weekdayPattern(weeks, now).map((e, wd) => enrich(e, wd, now, dataWeeks));
}
/** The plan for one weekday (0 = Sunday). */
export function dayPlan(weekday, now = new Date(), weeks = 8) { return weekPlans(now, weeks)[weekday]; }
/** The plan for the weekday of `date` (default: today). */
export function todayPlan(date = new Date()) { return dayPlan(date.getDay(), date); }

/**
 * This calendar week, Monday first, with what was actually trained on each day.
 * Each entry: { key, weekday (0 = Sunday), isToday, isFuture, trained: [groups], workouts: [ids] }.
 * `groups` are the same exercise categories weekPlans() uses, so a trained day and a planned day colour the same way.
 */
export function weekThisWeek(now = new Date()) {
  const today = dateKey(now);
  const monday = shiftDate(today, -((now.getDay() + 6) % 7));
  const sessions = state.workouts.map(sessionOf).filter(Boolean);
  return Array.from({ length: 7 }, (_, i) => {
    const key = shiftDate(monday, i), mine = sessions.filter((s) => s.date === key);
    return { key, weekday: parseKey(key).getDay(), isToday: key === today, isFuture: key > today, trained: [...new Set(mine.flatMap((s) => s.groups))], workouts: mine.map((s) => s.id) };
  });
}

/** Consecutive training weeks (Monday to Sunday), counted back from this week. A week that is still empty does not break the streak. */
export function weekStreak(now = new Date()) {
  const today = dateKey(now);
  const monday = shiftDate(today, -((now.getDay() + 6) % 7));
  const days = new Set(state.workouts.map(sessionOf).filter(Boolean).map((s) => s.date));
  const has = (start) => Array.from({ length: 7 }, (_, i) => shiftDate(start, i)).some((k) => days.has(k));
  const thisWeek = has(monday);
  let weeks = thisWeek ? 1 : 0, start = shiftDate(monday, -7);
  for (let i = 0; i < 260 && has(start); i++) { weeks++; start = shiftDate(start, -7); }
  return { weeks, thisWeek };
}

/**
 * What you did the last time it was this weekday: the most recent real training session on `weekday` (0 = Sunday, default today)
 * within the last `weeks` weeks. Today itself is never returned (it is the day being planned), and it does not need a learned
 * pattern: one session is enough. Used for "Start like last Thursday" and to pre-tick the picker.
 * Returns { workout, date, weekday, dayName, daysAgo, exercises: [{ exId, name, type, sets }], nSets } or null.
 */
export function sameWeekdaySession(weekday = new Date().getDay(), now = new Date(), weeks = 4) {
  const today = dateKey(now), byDate = new Map();
  for (const w of state.workouts) { const s = sessionOf(w); if (!s) continue; if (!byDate.has(s.date)) byDate.set(s.date, []); byDate.get(s.date).push(w); }
  const doneSets = (w) => (w.exercises || []).reduce((n, e) => n + (e.sets || []).filter(isWork).length, 0);
  for (let k = 1; k <= weeks * 7; k++) {
    const key = shiftDate(today, -k);
    if (parseKey(key).getDay() !== weekday || !byDate.has(key)) continue;
    const w = byDate.get(key).slice().sort((a, b) => doneSets(b) - doneSets(a) || b.start - a.start)[0];
    const exercises = (w.exercises || []).map((e) => ({ exId: e.exId, name: e.name, type: e.type, sets: (e.sets || []).filter((s) => s.done).length })).filter((e) => e.sets > 0);
    if (!exercises.length) continue;
    return { workout: w, date: key, weekday, dayName: DAY_NAMES[weekday], daysAgo: k, exercises, nSets: doneSets(w) };
  }
  return null;
}
