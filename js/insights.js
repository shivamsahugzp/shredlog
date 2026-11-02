// Insights engine: food→symptom patterns, training progression, nutrient gaps, budget protein.
import { state, dayIfAny, lastNDays, todayKey, dayTotals, allExercises, findExercise, weights } from './state.js';
import { e1rm } from './calc.js';

// ---------- symptoms ----------
// kind 'meal' = evaluated per meal episode in a lag window; 'day' = per day using the evening check-in.
export const SYMPTOMS = [
  { id: 'bloating', label: 'Bloating', kind: 'meal', lag: [1, 6], max: 3 },
  { id: 'gas', label: 'Gas', kind: 'meal', lag: [1, 8], max: 3 },
  { id: 'acidity', label: 'Acidity / heartburn', kind: 'meal', lag: [0, 3], max: 3 },
  { id: 'cramps', label: 'Cramps / stomach pain', kind: 'meal', lag: [0.5, 6], max: 3 },
  { id: 'headache', label: 'Headache / brain fog', kind: 'meal', lag: [1, 24], max: 3 },
  { id: 'sleepy', label: 'Sleepy / heavy after eating', kind: 'meal', lag: [0.5, 3], max: 3 },
  { id: 'heat', label: 'Body heat (garmi)', kind: 'meal', lag: [1, 12], max: 3 },
  { id: 'low_energy', label: 'Low energy', kind: 'day', field: 'energy', bad: (v) => v <= 2 },
  { id: 'poor_sleep', label: 'Poor sleep', kind: 'day', field: 'sleepQ', bad: (v) => v <= 2, shift: 1, eveningOnly: true },
  { id: 'low_mood', label: 'Low mood', kind: 'day', field: 'mood', bad: (v) => v <= 2 },
  { id: 'loose_stool', label: 'Loose stool', kind: 'day', field: 'stool', bad: (v) => v >= 6 },
  { id: 'hard_stool', label: 'Constipation', kind: 'day', field: 'stool', bad: (v) => v <= 2, shift: 1 },
  { id: 'skin', label: 'Skin breakout', kind: 'day', field: 'skin', bad: (v) => v >= 1, shift: 1 },
  { id: 'cravings', label: 'Cravings', kind: 'day', field: 'cravings', bad: (v) => v && v !== 'none' },
];
export const TAG_LABELS = { dairy: 'Dairy', lactose_high: 'Milk / whey (lactose)', legume: 'Dal, rajma, chana', fodmap_high: 'High-FODMAP foods', wheat: 'Wheat (roti, bread)', fried: 'Fried food', spicy: 'Spicy food', high_sodium: 'Salty / namkeen', sugar: 'Sweets & sugar', caffeine: 'Chai / coffee', alcohol: 'Alcohol', soy: 'Soya', raw_sprouts: 'Raw sprouts', onion_garlic: 'Onion & garlic', artificial_sweetener: 'Diet sweeteners', red_meat: 'Mutton / red meat', egg: 'Eggs', nuts: 'Nuts', high_fat: 'Heavy, oily meals', ultra_processed: 'Packaged food', large_meal: 'Very large meal', late_night: 'Late-night eating', evening_caffeine: 'Chai / coffee after 4 pm' };
export const RED_FLAGS = ['Blood or black stool', 'Unexplained weight loss', 'Vomiting that keeps coming back', 'Symptoms that wake you at night', 'Severe or worsening pain', 'Loose stools for more than 6 weeks', 'A lump you can feel', 'Breathlessness, palpitations or looking pale'];

const H = 3600000;
function mealsWithTags(key) {
  const d = dayIfAny(key); if (!d || !d.food.length) return [];
  const kcals = d.food.map((e) => e.kcal || 0).filter(Boolean).sort((a, b) => a - b);
  const median = kcals.length ? kcals[Math.floor(kcals.length / 2)] : 0;
  return d.food.map((e) => {
    const tags = new Set(e.triggers || []);
    const hr = new Date(e.ts).getHours();
    if (median && (e.kcal || 0) > Math.max(400, 1.3 * median)) tags.add('large_meal');
    if (hr >= 22 || hr < 4) tags.add('late_night');
    if (tags.has('caffeine') && hr >= 16) tags.add('evening_caffeine');
    return { ts: e.ts, tags, kcal: e.kcal || 0 };
  });
}
function episodes(keys, mergeMs = H) {
  const all = keys.flatMap(mealsWithTags).sort((a, b) => a.ts - b.ts); const out = [];
  for (const m of all) { const last = out[out.length - 1]; if (last && m.ts - last.end <= mergeMs) { last.end = m.ts; m.tags.forEach((t) => last.tags.add(t)); } else out.push({ ts: m.ts, end: m.ts, tags: new Set(m.tags) }); }
  return out;
}
function permP(hits, exposed, observed, n = 400) {
  // permutation test on the difference pT − pN
  let worse = 0; const idx = hits.map((_, i) => i);
  for (let k = 0; k < n; k++) {
    for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
    let a = 0, b = 0, c = 0, d = 0;
    for (let i = 0; i < hits.length; i++) { const hit = hits[idx[i]]; if (exposed[i]) { hit ? a++ : b++; } else { hit ? c++ : d++; } }
    const diff = (a + 0.5) / (a + b + 1) - (c + 0.5) / (c + d + 1); if (diff >= observed) worse++;
  }
  return worse / n;
}
function twoByTwo(rows, symptom, tag) {
  let a = 0, b = 0, c = 0, d = 0; const hits = [], exp = [];
  for (const r of rows) { const ex = r.tags.has(tag); hits.push(r.hit); exp.push(ex); if (ex) r.hit ? a++ : b++; else r.hit ? c++ : d++; }
  const pT = (a + 0.5) / (a + b + 1), pN = (c + 0.5) / (c + d + 1), rr = pT / pN, diff = pT - pN;
  const total = rows.length, tooCommon = (a + b) / Math.max(1, total) > 0.7;
  const half = Math.floor(rows.length / 2); const same = (() => { const f = rows.slice(0, half), s = rows.slice(half); const dd = (rs) => { let aa = 0, bb = 0, cc = 0, dd2 = 0; for (const r of rs) { const ex = r.tags.has(tag); if (ex) r.hit ? aa++ : bb++; else r.hit ? cc++ : dd2++; } return (aa + 0.5) / (aa + bb + 1) - (cc + 0.5) / (cc + dd2 + 1); }; return dd(f) > 0 && dd(s) > 0; })();
  const result = { symptom: symptom.id, symptomLabel: symptom.label, tag, tagLabel: TAG_LABELS[tag] || tag, a, b, c, d, pT, pN, rr, diff, tooCommon, same };
  if (a >= 3 && a + b >= 5 && rr >= 1.75 && diff >= 0.25 && !tooCommon) result.p = permP(hits, exp, diff);
  if (rr <= 0.5 && b >= 5 && c >= 4) result.protective = true;
  return result;
}
// Returns { ready, days, covered, patterns:[...], protective:[...] }
export function symptomPatterns(days = 60) {
  const keys = lastNDays(days);
  const covered = keys.filter((k) => { const d = dayIfAny(k); return d && (d.checkin || (d.symptoms || []).length); }).length;
  const results = [];
  // meal-level
  const eps = episodes(keys);
  const records = keys.flatMap((k) => (dayIfAny(k)?.symptoms || []));
  for (const s of SYMPTOMS.filter((x) => x.kind === 'meal')) {
    const rows = [];
    for (const ep of eps) {
      const lo = ep.ts + s.lag[0] * H, hi = ep.end + s.lag[1] * H; if (hi > Date.now()) continue;
      const inWin = records.filter((r) => r.ts >= lo && r.ts <= hi && (r.type === s.id || r.type === 'all_good'));
      if (!inWin.length) continue;
      rows.push({ tags: ep.tags, hit: inWin.some((r) => r.type === s.id && r.sev >= 2) });
    }
    if (rows.filter((r) => r.hit).length < 4) continue;
    const tags = new Set(); rows.forEach((r) => r.tags.forEach((t) => tags.add(t)));
    for (const tag of tags) results.push(twoByTwo(rows, s, tag));
  }
  // day-level
  for (const s of SYMPTOMS.filter((x) => x.kind === 'day')) {
    const rows = [];
    for (const k of keys) {
      const d = dayIfAny(k); const v = d?.checkin?.[s.field]; if (v == null || v === '') continue;
      const srcKeys = s.shift ? [lastNDays(2, k)[0], k] : [k];
      const tags = new Set(); for (const sk of srcKeys) for (const m of mealsWithTags(sk)) m.tags.forEach((t) => tags.add(t));
      if (!tags.size) continue;
      if (s.eveningOnly) { for (const t of [...tags]) if (!['evening_caffeine', 'late_night', 'alcohol', 'large_meal', 'spicy', 'fried', 'high_fat'].includes(t)) tags.delete(t); }
      rows.push({ tags, hit: !!s.bad(v) });
    }
    if (rows.filter((r) => r.hit).length < 4) continue;
    const tags = new Set(); rows.forEach((r) => r.tags.forEach((t) => tags.add(t)));
    for (const tag of tags) { const r = twoByTwo(rows, s, tag); if (r.a + r.b >= 5 && r.c + r.d >= 5) results.push(r); }
  }
  const patterns = results.filter((r) => r.p != null && r.p < 0.1).map((r) => {
    r.confidence = r.a >= 8 && r.p < 0.05 && r.same ? 'strong' : r.a >= 5 && r.same ? 'repeating' : 'early';
    r.score = r.diff * Math.min(1, (r.a + r.b) / 10) * (r.same ? 1 : 0.7);
    const s = SYMPTOMS.find((x) => x.id === r.symptom);
    const when = s.kind === 'meal' ? `within ${s.lag[0]}–${s.lag[1]} h` : s.shift ? 'the next day' : 'that day';
    r.text = `${r.symptomLabel} followed ${r.a} of ${r.a + r.b} meals with ${r.tagLabel.toLowerCase()} (${Math.round(r.pT * 100)}%) vs ${r.c} of ${r.c + r.d} other meals (${Math.round(r.pN * 100)}%) ${when}.`;
    r.caveat = r.confidence === 'early' ? 'Early pattern, may be coincidence.' : r.confidence === 'repeating' ? 'Repeating pattern.' : 'Strong, consistent pattern.';
    r.tip = TIPS[r.tag] || 'Try a 2-week swap and re-check. Don’t cut a whole food group on one pattern.';
    return r;
  }).sort((a, b) => b.score - a.score);
  // top 3 per symptom
  const perSym = {}; const top = [];
  for (const p of patterns) { perSym[p.symptom] = (perSym[p.symptom] || 0) + 1; if (perSym[p.symptom] <= 3) top.push(p); }
  const protective = results.filter((r) => r.protective).slice(0, 5);
  const tooCommon = [...new Set(results.filter((r) => r.tooCommon).map((r) => r.tagLabel))];
  return { ready: covered >= 14, days, covered, patterns: top, protective, tooCommon };
}
const TIPS = {
  legume: 'Soak dals 8–12 h, discard the water, pressure-cook, add hing and jeera. Try moong or masoor instead of rajma or chole for two weeks.',
  fodmap_high: 'Rajma, chole, gobi, cabbage and onion-heavy gravies are high-FODMAP. Smaller portions, well cooked, see if it settles.',
  lactose_high: 'Milk and whey concentrate carry lactose. Try curd or paneer, lactose-free milk, or whey isolate for two weeks.',
  dairy: 'Try switching milk to curd or paneer for two weeks, then re-check.',
  wheat: 'Try rice, jowar or bajra roti for two weeks and compare.',
  fried: 'Fried food slows digestion and triggers acidity. Air-fry, roast or keep it to one small portion.',
  spicy: 'Go easier on red chilli for two weeks; keep the flavour with jeera, dhania and ginger.',
  caffeine: 'Chai and coffee relax the valve that holds acid down. Try fewer cups and none on an empty stomach.',
  evening_caffeine: 'Caffeine within 6–8 h of bed cuts deep sleep. Make the last chai before 4 pm.',
  late_night: 'Finish the last meal 2–3 h before bed. A light, smaller dinner usually helps.',
  large_meal: 'Spread the same food over two sittings. A big single meal is the common cause of post-lunch slump.',
  sugar: 'Sweets spike and crash energy and drive cravings. Pair sugar with protein or keep it after a meal.',
  alcohol: 'Alcohol wrecks sleep quality even in small amounts. Try alcohol-free weeks and compare.',
  high_sodium: 'Namkeen, pickle and restaurant food hold water and bloat. Watch the day-after scale, not the food.',
  soy: 'Some people bloat with soya. Try smaller portions or tofu instead of chunks.',
  onion_garlic: 'Onion and garlic are the most common hidden triggers in Indian gravies. Try hing-based tadka for two weeks.',
  high_fat: 'Heavy, oily meals sit longer in the stomach. Measure oil with a spoon, not a pour.',
  raw_sprouts: 'Lightly steam sprouts instead of eating them raw.',
  artificial_sweetener: 'Diet drinks and sugar-free sweets can bloat. Try plain water or nimbu pani without sweetener.',
  ultra_processed: 'Packaged food is salty and low-fibre. Swap one packet a day for fruit, chana or peanuts.',
};

// ---------- training ----------
const COMPOUND = /squat|deadlift|bench|press|row|pull_up|chin_up|hip_thrust|lunge|dip/;
export function repRange(ex) {
  if (!ex) return [8, 12];
  if (ex.type === 'timed' || ex.type === 'cardio') return null;
  if (['Biceps', 'Triceps', 'Calves', 'Forearms', 'Core'].includes(ex.cat) || /fly|raise|curl|extension|pushdown|kickback|pull_apart|face_pull/.test(ex.id)) return [10, 15];
  if (COMPOUND.test(ex.id) && ['barbell', 'smith'].includes(ex.equipment)) return [6, 10];
  return [8, 12];
}
export function increment(ex) { if (!ex) return 2.5; if (ex.equipment === 'dumbbell' || ex.equipment === 'kettlebell') return 2; if (ex.equipment === 'machine' || ex.equipment === 'cable') return 5; if (ex.equipment === 'bodyweight' || ex.equipment === 'none' || ex.equipment === 'band') return 0; return 2.5; }
const working = (sets) => sets.filter((s) => s.done && s.t !== 'W');
function sessionsFor(exId, limit = 6) {
  const out = [];
  for (const w of [...state.workouts].sort((a, b) => b.start - a.start)) { for (const ex of w.exercises) if (ex.exId === exId) { const sets = working(ex.sets); if (sets.length) out.push({ start: w.start, sets, feel: ex.feel || w.feel, plan: ex.plan }); } if (out.length >= limit) break; }
  return out;
}
// Suggestion for the next session of an exercise, from the log.
export function nextSuggestion(exId, planReps) {
  const ex = findExercise(exId); const hist = sessionsFor(exId, 4); if (!hist.length || !ex) return null;
  const last = hist[0]; const range = parseRange(planReps || last.plan?.reps) || repRange(ex); if (!range) return null;
  const inc = increment(ex); const isBw = inc === 0;
  const w = Math.max(...last.sets.map((s) => s.w || 0)); const minReps = Math.min(...last.sets.map((s) => s.r || 0));
  const daysSince = (Date.now() - last.start) / 86400000;
  const best = (sess) => Math.max(...sess.sets.map((s) => (isBw ? (s.r || 0) : e1rm(s.w || 0, s.r || 0))));
  const stalled = hist.length >= 3 && Math.abs(best(hist[0]) - best(hist[2])) / Math.max(1, best(hist[2])) < 0.01 && Math.abs(best(hist[0]) - best(hist[1])) / Math.max(1, best(hist[1])) < 0.01;
  if (daysSince >= 14) return { kind: 'layoff', text: `Last done ${Math.round(daysSince)} days ago. Start 5–10% lighter and build back.`, weight: round(w * 0.92, inc || 2.5), reps: range[0] };
  if (stalled) return { kind: 'stall', text: `Stuck for 3 sessions at ${isBw ? minReps + ' reps' : w + ' kg'}. Add one rep, a tiny jump, or swap the variation.`, weight: w, reps: minReps + 1 };
  if (minReps >= range[1] && last.feel !== 'failed') return isBw ? { kind: 'increase', text: `All sets hit ${range[1]} reps. Add a rep, slow the tempo, or add weight.`, weight: w, reps: range[1] + 1 } : { kind: 'increase', text: `All sets hit ${range[1]} at ${w} kg. Try ${round(w + inc, inc)} kg for ${range[0]}.`, weight: round(w + inc, inc), reps: range[0] };
  if (minReps >= range[0]) return { kind: 'reps', text: `Keep ${isBw ? 'the same load' : w + ' kg'}; aim for ${minReps + 1} on the weakest set.`, weight: w, reps: minReps + 1 };
  const misses = hist.slice(0, 2).filter((s) => Math.min(...s.sets.map((x) => x.r || 0)) < range[0]).length;
  if (misses >= 2 && !isBw) { const e = Math.max(...last.sets.map((s) => e1rm(s.w || 0, s.r || 0))); const target = round(e / (1 + range[0] / 30), inc); return { kind: 'reduce', text: `Below ${range[0]} reps two sessions running. Drop to ${target} kg and rebuild.`, weight: target, reps: range[0] }; }
  return { kind: 'hold', text: `Hold ${isBw ? 'the load' : w + ' kg'} and get every set to ${range[0]}+.`, weight: w, reps: range[0] };
}
const parseRange = (s) => { const m = /^(\d+)\s*[-–]\s*(\d+)$/.exec(String(s || '').trim()); return m ? [+m[1], +m[2]] : null; };
const round = (v, inc) => (inc ? Math.round(v / inc) * inc : Math.round(v));

// Hard sets per muscle for a set of day keys (primary 1, secondary 0.5; warm-ups excluded).
export function weeklyVolume(keys) {
  const set = new Set(keys); const vol = {};
  for (const w of state.workouts) { const k = new Date(w.start); const key = `${k.getFullYear()}-${String(k.getMonth() + 1).padStart(2, '0')}-${String(k.getDate()).padStart(2, '0')}`; if (!set.has(key)) continue;
    for (const ex of w.exercises) { const def = findExercise(ex.exId); if (!def || def.type === 'cardio') continue; const n = working(ex.sets).length; if (!n) continue; (def.muscles || []).forEach((m, i) => { vol[m] = (vol[m] || 0) + n * (i === 0 ? 1 : 0.5); }); } }
  return vol;
}
export const MUSCLE_GROUPS = { chest: 'Chest', lats: 'Back', 'upper back': 'Back', traps: 'Back', 'lower back': 'Back', 'rear delts': 'Shoulders', 'front delts': 'Shoulders', 'side delts': 'Shoulders', shoulders: 'Shoulders', biceps: 'Arms', triceps: 'Arms', forearms: 'Arms', quads: 'Legs', hamstrings: 'Legs', glutes: 'Legs', calves: 'Legs', adductors: 'Legs', 'hip flexors': 'Core', abs: 'Core', obliques: 'Core', core: 'Core' };
export function volumeByGroup(keys) { const v = weeklyVolume(keys); const g = {}; for (const [m, n] of Object.entries(v)) { const grp = MUSCLE_GROUPS[m] || 'Other'; g[grp] = (g[grp] || 0) + n; } return g; }
export function volumeStatus(sets, beginner = false) { const lo = beginner ? 6 : 10, hi = beginner ? 12 : 16; if (sets < 6) return { status: 'red', label: 'too little' }; if (sets < lo) return { status: 'amber', label: 'light' }; if (sets <= hi) return { status: 'green', label: 'on target' }; if (sets <= 20) return { status: 'green', label: 'high, watch recovery' }; return { status: 'amber', label: 'very high' }; }
export function recoveryByGroup() {
  const now = Date.now(); const last = {};
  for (const w of state.workouts) for (const ex of w.exercises) { const def = findExercise(ex.exId); if (!def) continue; const n = working(ex.sets).length; if (!n) continue; const grp = MUSCLE_GROUPS[def.muscles?.[0]] || 'Other'; const prev = last[grp]; if (!prev || w.start > prev.ts) last[grp] = { ts: w.end || w.start, sets: n }; }
  const out = {}; for (const [g, v] of Object.entries(last)) { const win = (['Legs', 'Back'].includes(g) || v.sets >= 10 ? 72 : 48) * H; out[g] = Math.min(1, (now - v.ts) / win); }
  return out;
}
export function deloadAdvice() {
  // consecutive training weeks without a light week (<60% of the median weekly set count)
  const weeks = []; for (let i = 0; i < 8; i++) { const end = new Date(); end.setDate(end.getDate() - i * 7); const keys = lastNDays(7, `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`); weeks.push(Object.values(weeklyVolume(keys)).reduce((a, b) => a + b, 0)); }
  const active = weeks.filter((w) => w > 0); if (active.length < 5) return null;
  const med = [...active].sort((a, b) => a - b)[Math.floor(active.length / 2)];
  let streak = 0; for (const w of weeks) { if (w >= 0.6 * med) streak++; else break; }
  const lowDays = lastNDays(7).filter((k) => { const c = dayIfAny(k)?.checkin; return c && ((c.energy && c.energy <= 2) || (c.sleepQ && c.sleepQ <= 2)); }).length;
  if (streak >= 6 || (streak >= 4 && lowDays >= 3)) return { text: `${streak} hard weeks in a row${lowDays >= 3 ? ' and low energy or sleep on ' + lowDays + ' days this week' : ''}. Consider a lighter week: same days, about half the sets, 10% less weight.`, streak, lowDays };
  return null;
}
export function suggestDay(routine) {
  if (!routine?.days?.length) return null;
  const week = volumeByGroup(lastNDays(7)); const rec = recoveryByGroup(); const beginner = (state.workouts.length < 12);
  const target = beginner ? 8 : 12;
  const scored = routine.days.map((d, i) => { const groups = {}; for (const it of d.exercises) { const def = findExercise(it.ex); if (!def) continue; const g = MUSCLE_GROUPS[def.muscles?.[0]] || 'Other'; groups[g] = (groups[g] || 0) + 1; }
    let score = 0; const why = []; for (const g of Object.keys(groups)) { const deficit = Math.max(0, target - (week[g] || 0)) / target; const r = rec[g] ?? 1; score += deficit * r; if (r < 0.8) why.push(`${g} still recovering`); if (deficit > 0.5) why.push(`${g} under-trained this week`); }
    return { dayIndex: i, name: d.name, score, why: [...new Set(why)].slice(0, 2) }; });
  scored.sort((a, b) => b.score - a.score); return scored[0];
}

// ---------- nutrition ----------
const RDA_FALLBACK = { iron: [19, 29, 'mg'], calcium: [1000, 1000, 'mg'], vitamin_d: [15, 15, 'mcg'], vitamin_b12: [2.2, 2.2, 'mcg'], vitamin_c: [80, 65, 'mg'], zinc: [17, 13.2, 'mg'], magnesium: [440, 370, 'mg'], potassium: [3500, 3500, 'mg'], folate: [300, 220, 'mcg'], sodium: [2000, 2000, 'mg'] };
export function microAverages(days = 7) {
  const keys = lastNDays(days).filter((k) => dayIfAny(k)?.food?.length); if (!keys.length) return null;
  const sum = {}; for (const k of keys) for (const e of dayIfAny(k).food) if (e.micro) for (const [m, v] of Object.entries(e.micro)) sum[m] = (sum[m] || 0) + (v || 0);
  const avg = {}; for (const [m, v] of Object.entries(sum)) avg[m] = v / keys.length; return { avg, days: keys.length };
}
export function nutritionGaps(days = 7) {
  const p = state.profile || {}; const t = state.targets || {}; const kn = state.data.knowledge; const keys = lastNDays(days).filter((k) => dayIfAny(k)?.food?.length);
  if (!keys.length) return null;
  const tot = keys.map(dayTotals); const avgOf = (f) => tot.reduce((a, x) => a + x[f], 0) / tot.length;
  const macros = { kcal: { avg: Math.round(avgOf('kcal')), target: t.kcal }, p: { avg: Math.round(avgOf('p')), target: t.p }, fiber: { avg: Math.round(avgOf('fiber')), target: t.fiber }, sugar: { avg: Math.round(avgOf('sugar')) } };
  macros.proteinHitDays = tot.filter((x) => x.p >= (t.p || 0) * 0.9).length;
  const ma = microAverages(days); const micros = [];
  const micList = kn?.micros || Object.keys(RDA_FALLBACK).filter((m) => m !== 'sodium').map((id) => ({ id, name: id.replace('_', ' '), unit: RDA_FALLBACK[id][2], rdaMale: RDA_FALLBACK[id][0], rdaFemale: RDA_FALLBACK[id][1], topFoods: [] }));
  for (const m of micList) { if (m.id === 'fiber') continue; const rda = p.sex === 'female' ? m.rdaFemale : m.rdaMale; const avg = ma?.avg?.[m.id] ?? 0; const pct = rda ? avg / rda : 0;
    micros.push({ id: m.id, name: m.name, unit: m.unit, avg: +avg.toFixed(m.unit === 'mcg' ? 1 : 0), rda, pct, status: m.id === 'sodium' ? (pct > 1.5 ? 'red' : pct > 1.1 ? 'amber' : 'green') : (pct < 0.5 ? 'red' : pct < 0.8 ? 'amber' : 'green'), why: m.whyItMatters, vegNote: m.vegNote, foods: dietFilter(m.topFoods || [], p.diet).slice(0, 6) }); }
  micros.sort((a, b) => a.pct - b.pct);
  const fixes = []; if (macros.p.target && macros.p.avg < macros.p.target * 0.9) fixes.push('protein'); if (macros.fiber.target && macros.fiber.avg < macros.fiber.target * 0.8) fixes.push('fiber'); for (const m of micros) if (m.status !== 'green' && m.id !== 'sodium') fixes.push(m.id);
  const ideas = (kn?.mealIdeas || []).filter((i) => dietOk(i.diet, p.diet) && i.fixes.some((f) => fixes.includes(f)) && (p.budget !== 'tight' || i.fixes.includes('cheap') || (i.costInr || 0) <= 60)).sort((a, b) => b.fixes.filter((f) => fixes.includes(f)).length - a.fixes.filter((f) => fixes.includes(f)).length).slice(0, 6);
  return { days: keys.length, macros, micros, fixes, ideas };
}
const DIET_RANK = { vegan: 0, jain: 0, veg: 1, egg: 2, nonveg: 3 };
export const dietOk = (itemDiet, userDiet) => { if (!itemDiet) return true; const u = DIET_RANK[userDiet] ?? 3; const i = DIET_RANK[itemDiet] ?? 1; return i <= u; };
const NONVEG_WORDS = /chicken|mutton|fish|prawn|liver|egg|anda|meat|rohu|tuna/i;
const dietFilter = (foods, diet) => foods.filter((f) => { const n = f.name || f; if (diet === 'nonveg') return true; if (diet === 'egg') return !/chicken|mutton|fish|prawn|liver|meat|rohu|tuna/i.test(n); return !NONVEG_WORDS.test(n) && (diet !== 'vegan' || !/milk|curd|paneer|dahi|cheese|ghee|yogurt|whey/i.test(n)); });
export function budgetProtein(limit = 10) {
  const p = state.profile || {}; const list = state.data.knowledge?.proteinSources || [];
  const budgetCap = p.budget === 'tight' ? 25 : p.budget === 'moderate' ? 45 : Infinity;
  return list.filter((s) => dietOk(s.diet, p.diet) && (s.inrPer10gProtein <= budgetCap || list.filter((x) => dietOk(x.diet, p.diet)).length < limit)).slice(0, limit);
}
export function proteinIdeas(gramsLeft, diet) {
  if (gramsLeft < 10) return '';
  const opts = { vegan: [['soya chunks (50 g dry)', 26], ['katori dal', 7], ['tofu (100 g)', 12], ['peanuts (30 g)', 8]], jain: [['katori dal', 7], ['paneer (100 g)', 18], ['curd (1 katori)', 5], ['soya chunks (50 g dry)', 26]], veg: [['paneer (100 g)', 18], ['katori dal', 7], ['soya chunks (50 g dry)', 26], ['glass of milk', 8], ['scoop whey', 24]], egg: [['2 eggs', 12], ['paneer (100 g)', 18], ['katori dal', 7], ['scoop whey', 24]], nonveg: [['chicken breast (100 g)', 30], ['2 eggs', 12], ['paneer (100 g)', 18], ['katori dal', 7]] }[diet || 'veg'];
  const out = []; let left = gramsLeft;
  for (const [name, g] of opts) { if (left < 6) break; const n = Math.min(3, Math.floor(left / g)); if (n >= 1) { out.push(n > 1 ? `${n} × ${name}` : name); left -= n * g; } }
  return out.length ? `about ${out.join(' + ')}` : '';
}
// Weight trend, rate and projection
export function weightInsight() {
  const ws = weights(); if (ws.length < 2) return null;
  const last = ws[ws.length - 1]; const start = new Date(last.date + 'T12:00:00'); start.setDate(start.getDate() - 14);
  const sk = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  const win = ws.filter((w) => w.date >= sk); if (win.length < 3) return { last, rate: null };
  const t0 = new Date(win[0].date + 'T12:00:00').getTime(); const xs = win.map((w) => (new Date(w.date + 'T12:00:00').getTime() - t0) / 86400000), ys = win.map((w) => w.kg);
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n; let num = 0, den = 0; for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0; const rate = +(slope * 7).toFixed(2); const target = state.profile?.targetWeightKg;
  let eta = null; if (target && Math.abs(slope) > 0.005 && Math.sign(target - last.kg) === Math.sign(slope)) { const days = (target - last.kg) / slope; if (days < 730) { const d = new Date(); d.setDate(d.getDate() + Math.round(days)); eta = d; } }
  return { last, rate, eta, target };
}
