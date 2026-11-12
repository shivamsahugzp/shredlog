// Verdicts: how a training session went, and how a whole day adds up (intake vs burn, protein, steps, training).
// Pure reads of state; no DOM. Today renders dayVerdict(); Train renders sessionVerdict() on finish and in history.
import { state, dayIfAny, dayTotals, workoutsOn, findExercise, dateKey, parseKey, shiftDate, lastNDays, stepsOn } from './state.js';
import { bmr, e1rm, workoutVolume } from './calc.js';
import { MUSCLE_GROUPS, repRange } from './insights.js';
import { dayPlan } from './train-plan.js';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const working = (sets) => (sets || []).filter((s) => s.done && s.t !== 'W');
const keyOf = (w) => dateKey(new Date(w.start));
const groupOfEx = (ex) => { const def = findExercise(ex.exId); return MUSCLE_GROUPS[def?.muscles?.[0]] || null; };
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : 0);
const r1 = (v) => Math.round(v * 10) / 10;

// Hard sets per muscle group for one workout (helpers count half, like insights.weeklyVolume).
export function setsByGroup(w) {
  const g = {};
  for (const ex of w.exercises || []) {
    const def = findExercise(ex.exId); if (!def || def.type === 'cardio') continue;
    const n = working(ex.sets).length; if (!n) continue;
    (def.muscles || []).forEach((m, i) => { const grp = MUSCLE_GROUPS[m] || 'Other'; g[grp] = (g[grp] || 0) + n * (i === 0 ? 1 : 0.5); });
  }
  for (const k of Object.keys(g)) g[k] = Math.round(g[k]);
  return g;
}

// Working sets per exercise category (Chest, Triceps, Shoulders, Back, Biceps, Quads…): the vocabulary the weekday learner uses.
export function setsByCat(w) {
  const g = {};
  for (const ex of w.exercises || []) { const def = findExercise(ex.exId); const cat = def?.cat || ex.cat; if (!cat) continue; const n = working(ex.sets).length; if (n) g[cat] = (g[cat] || 0) + n; }
  return g;
}

// The most comparable earlier session: same name, else same weekday within 4 weeks, else the one sharing most exercises.
export function previousComparable(w) {
  const before = state.workouts.filter((x) => x.id !== w.id && x.start < w.start).sort((a, b) => b.start - a.start);
  if (!before.length) return null;
  const name = (w.name || '').trim().toLowerCase();
  const ids = new Set((w.exercises || []).map((e) => e.exId));
  const overlap = (x) => (x.exercises || []).filter((e) => ids.has(e.exId)).length / Math.max(1, ids.size);
  const byName = name && name !== 'workout' ? before.find((x) => (x.name || '').trim().toLowerCase() === name && overlap(x) >= 0.3) : null;
  if (byName) return byName;
  const wd = new Date(w.start).getDay();
  const sameDay = before.find((x) => new Date(x.start).getDay() === wd && w.start - x.start < 29 * 864e5 && overlap(x) >= 0.3);
  if (sameDay) return sameDay;
  let best = null, bestO = 0.49;
  for (const x of before.slice(0, 20)) { const o = overlap(x); if (o > bestO) { bestO = o; best = x; } }
  return best;
}

// Best e1RM per exercise in a workout.
function bestE1rm(w) {
  const out = {};
  for (const ex of w.exercises || []) for (const s of working(ex.sets)) { const e = e1rm(s.w, s.r); if (e > (out[ex.exId] || 0)) out[ex.exId] = e; }
  return out;
}

/**
 * sessionVerdict(workout) → { score 0..100, grade 'strong'|'solid'|'light', headline, wins[], improve[], stats, compare }
 * Honest, specific, and short: every line names a number the user can act on.
 */
export function sessionVerdict(w) {
  if (!w) return null;
  const sets = (w.exercises || []).reduce((n, e) => n + working(e.sets).length, 0);
  const planned = (w.exercises || []).reduce((n, e) => n + (e.sets || []).filter((s) => s.t !== 'W').length, 0);
  const skipped = Math.max(0, planned - sets);
  const volume = w.volume || workoutVolume(w);
  const mins = w.end && w.start ? Math.round((w.end - w.start) / 60000) : null;
  const groups = setsByGroup(w);
  const prev = previousComparable(w);
  const prs = (w.prs || []).length;
  const wins = [], improve = [];
  let score = 55;

  // completion
  if (planned && !skipped) { wins.push(`All ${sets} planned sets done`); score += 10; }
  else if (skipped) { improve.push(`${skipped} set${skipped > 1 ? 's' : ''} left unticked`); score -= Math.min(15, skipped * 3); }

  // volume vs last comparable
  let compare = null;
  if (prev) {
    const pv = prev.volume || workoutVolume(prev), ps = (prev.exercises || []).reduce((n, e) => n + working(e.sets).length, 0);
    const dv = pct(volume, pv);
    const pk = keyOf(prev), lastWeek = pk === shiftDate(keyOf(w), -7);
    compare = { id: prev.id, name: prev.name || 'last session', date: pk, label: lastWeek ? `last ${DAY_NAMES[parseKey(pk).getDay()]}` : `${prev.name || 'last session'}, ${pk.slice(8)}/${pk.slice(5, 7)}`, volume: pv, sets: ps, volumeDelta: dv, setsDelta: sets - ps };
    if (pv && dv >= 3) { wins.push(`Volume up ${dv}% vs ${compare.name} (${keyOf(prev) === shiftDate(keyOf(w), -7) ? 'last week' : 'last time'})`); score += Math.min(15, 5 + dv / 2); }
    else if (pv && dv <= -10) { improve.push(`Volume down ${Math.abs(dv)}% vs last time. Fine if planned, otherwise add a set or 2.5 kg next time`); score -= 8; }
    else if (pv) { wins.push(`Matched last time's volume (${Math.round(volume).toLocaleString('en-IN')} kg)`); score += 5; }
    // per-exercise strength
    const now = bestE1rm(w), was = bestE1rm(prev);
    const ups = [], downs = [];
    for (const [id, e] of Object.entries(now)) { if (!was[id]) continue; const d = pct(e, was[id]); const name = (w.exercises.find((x) => x.exId === id) || {}).name || id; if (d >= 2) ups.push(`${name} +${d}%`); else if (d <= -5) downs.push(`${name} ${d}%`); }
    if (ups.length) { wins.push(`Stronger on ${ups.slice(0, 2).join(', ')}`); score += Math.min(10, ups.length * 4); }
    if (downs.length) improve.push(`Weaker on ${downs.slice(0, 2).join(', ')}. Sleep, food or just a day, watch it next session`);
  } else {
    wins.push('First session of this kind logged. Next time gets a comparison');
  }

  // PRs
  if (prs) { wins.push(`${prs} personal record${prs > 1 ? 's' : ''}`); score += Math.min(15, prs * 6); }

  // groups vs what you usually do on this weekday
  try {
    const plan = dayPlan(new Date(w.start).getDay(), new Date(w.start));
    const usual = plan && plan.kind === 'train' ? plan.groups || [] : [];
    const cats = setsByCat(w);
    const missing = usual.filter((g) => !((cats[g] || groups[g] || 0) >= 3));
    if (usual.length && !missing.length) { wins.push(`${usual.join(', ')} all covered, like your usual ${DAY_NAMES[new Date(w.start).getDay()]}`); score += 5; }
    else if (missing.length) { improve.push(`${missing.join(' and ')} got ${missing.map((g) => cats[g] || groups[g] || 0).join(' and ')} sets. You usually train ${missing.length > 1 ? 'them' : 'it'} on ${DAY_NAMES[new Date(w.start).getDay()]}s`); score -= 6 * missing.length; }
  } catch (e) { /* no plan data */ }

  // stalls and rep ranges
  for (const ex of w.exercises || []) {
    const def = findExercise(ex.exId); if (!def || def.type === 'cardio') continue;
    const ws = working(ex.sets); if (ws.length < 2) continue;
    const [lo, hi] = repRange(def);
    const over = ws.filter((s) => s.r > hi + 3).length, under = ws.filter((s) => s.r < lo - 1).length;
    if (over >= 2) improve.push(`${ex.name}: ${over} sets past ${hi} reps. Add weight next time`);
    else if (under >= 2) improve.push(`${ex.name}: ${under} sets under ${lo} reps. Take 2.5 kg off and own the reps`);
  }

  // time
  if (mins != null) {
    if (mins > 95 && sets < 25) improve.push(`${mins} min for ${sets} sets. Shorter rests would keep the intensity up`);
    else if (mins >= 25 && mins <= 75) score += 3;
    if (mins >= 1 && mins < 20 && sets >= 8) improve.push(`${mins} min: very quick. Fine for a short day, check rests were long enough for heavy sets`);
  }

  score = Math.max(20, Math.min(100, Math.round(score)));
  const grade = score >= 78 ? 'strong' : score >= 58 ? 'solid' : 'light';
  const headline = grade === 'strong' ? 'Strong session' : grade === 'solid' ? 'Solid session' : 'Light session';
  return { score, grade, headline, wins: wins.slice(0, 4), improve: improve.slice(0, 3), stats: { sets, planned, skipped, volume, mins, prs, groups }, compare };
}

// Calories walking: about 0.5 kcal per kg per km, stride 0.75 m.
export function stepsKcal(steps, weightKg) { return Math.round((steps || 0) * 0.00075 * 0.5 * (weightKg || 70)); }

/**
 * dayVerdict(key) → intake, burn (resting / steps / workouts / total), net vs goal, protein, training, and one headline.
 * Resting burn is the full-day BMR; the sentence says "so far" while the day is still running.
 */
export function dayVerdict(key, now = new Date()) {
  const p = state.profile || {}, t = state.targets || {};
  const tot = dayTotals(key);
  const d = dayIfAny(key) || {};
  const restingFull = p.weightKg ? bmr({ sex: p.sex || 'male', weightKg: d.weight || p.weightKg, heightCm: p.heightCm || 170, age: p.age || 28 }) : 1600;
  const isToday = key === dateKey(now), hour = now.getHours();
  // While today is still running, resting burn counts only the hours that have passed, so a morning never reads as a huge deficit.
  const dayFrac = isToday ? Math.max(0.05, (hour + now.getMinutes() / 60) / 24) : 1;
  const resting = Math.round(restingFull * dayFrac);
  const steps = stepsOn(key), stepsBurn = stepsKcal(steps, d.weight || p.weightKg);
  const ws = workoutsOn(key);
  const workoutBurn = ws.reduce((a, w) => a + (w.kcal || 0), 0);
  const total = resting + stepsBurn + workoutBurn;
  const net = tot.kcal - total;                          // negative = deficit
  const goalKcal = t.kcal || 0, goalNet = goalKcal ? goalKcal - (restingFull + Math.round(restingFull * 0.25)) : null; // rough: target vs a light-activity day
  const sessions = ws.map((w) => ({ id: w.id, name: w.name || 'Workout', verdict: sessionVerdict(w) }));
  const bestSession = sessions.map((s) => s.verdict).filter(Boolean).sort((a, b) => b.score - a.score)[0] || null;
  const proteinPct = t.p ? Math.round((tot.p / t.p) * 100) : null;

  const lines = [];
  if (!tot.n && isToday && hour < 12) lines.push('Nothing eaten yet. Breakfast first, then the numbers.');
  else if (tot.n) lines.push(`${tot.kcal.toLocaleString('en-IN')} kcal in, about ${total.toLocaleString('en-IN')} out${isToday && hour < 21 ? ' so far' : ''}. ${net < 0 ? `${Math.abs(net).toLocaleString('en-IN')} kcal deficit` : `${net.toLocaleString('en-IN')} kcal surplus`}.`);
  if (bestSession) lines.push(`${bestSession.headline}: ${bestSession.wins[0] || ''}${bestSession.improve[0] ? '. ' + bestSession.improve[0] : ''}`);
  else if (isToday && hour >= 20) lines.push('No training logged today.');
  if (proteinPct != null && tot.n) lines.push(proteinPct >= 95 ? 'Protein target hit.' : `Protein ${Math.max(0, Math.round(t.p - tot.p))} g short.`);

  // 0..100 day score: protein 35, calories within window 30, training 25, steps 10
  let score = 0;
  if (proteinPct != null) score += Math.min(35, Math.round(proteinPct * 0.35));
  if (goalKcal && tot.n) { const off = Math.abs(tot.kcal - goalKcal) / goalKcal; score += off <= 0.1 ? 30 : off <= 0.2 ? 20 : off <= 0.35 ? 10 : 0; }
  if (bestSession) score += Math.round(bestSession.score * 0.25); else { try { const plan = dayPlan(parseKey(key).getDay(), parseKey(key)); if (plan && plan.kind === 'rest') score += 20; } catch (e) { /* ignore */ } }
  const stepGoal = state.settings.stepTarget || 8000; if (steps) score += Math.min(10, Math.round((steps / stepGoal) * 10));
  score = Math.min(100, score);

  return { key, intake: tot.kcal, items: tot.n, protein: { eaten: Math.round(tot.p), target: t.p || 0, pct: proteinPct },
    burn: { resting, restingFull, dayFrac, steps: stepsBurn, workouts: workoutBurn, total }, net, goalKcal, goalNet, steps, stepGoal,
    sessions, training: bestSession, score, lines, partial: !!d.partial };
}

// Last 7 days at a glance, for a weekly recap card.
export function weekVerdict(end = dateKey()) {
  const keys = lastNDays(7, end).map((k) => dayVerdict(k));
  const logged = keys.filter((d) => d.items);
  const avgIn = logged.length ? Math.round(logged.reduce((a, d) => a + d.intake, 0) / logged.length) : 0;
  const avgNet = logged.length ? Math.round(logged.reduce((a, d) => a + d.net, 0) / logged.length) : 0;
  const sessions = keys.reduce((a, d) => a + d.sessions.length, 0);
  const proteinDays = logged.filter((d) => d.protein.pct != null && d.protein.pct >= 95).length;
  const avgScore = Math.round(keys.reduce((a, d) => a + d.score, 0) / 7);
  return { days: keys, loggedDays: logged.length, avgIntake: avgIn, avgNet, sessions, proteinDays, avgScore };
}
