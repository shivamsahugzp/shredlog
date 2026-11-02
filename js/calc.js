// Formulas: energy, targets, lifting math, adaptive expenditure.

export const ACTIVITY = [
  { id: 'sedentary', label: 'Desk job, little exercise', mult: 1.2 },
  { id: 'light', label: 'Light: 1–3 workouts / week', mult: 1.375 },
  { id: 'moderate', label: 'Moderate: 3–5 workouts / week', mult: 1.55 },
  { id: 'active', label: 'Active: 6–7 hard workouts / week', mult: 1.725 },
  { id: 'athlete', label: 'Very active, physical job + training', mult: 1.9 },
];

export const GOALS = [
  { id: 'cut_fast', label: 'Cut fast', sub: 'about −0.75 kg / week', kcal: -825 },
  { id: 'cut', label: 'Cut', sub: 'about −0.5 kg / week', kcal: -550 },
  { id: 'cut_slow', label: 'Lean cut', sub: 'about −0.25 kg / week', kcal: -275 },
  { id: 'maintain', label: 'Maintain', sub: 'recomp at maintenance', kcal: 0 },
  { id: 'bulk', label: 'Lean bulk', sub: 'about +0.25 kg / week', kcal: 275 },
];

// Mifflin-St Jeor
export function bmr({ sex, weightKg, heightCm, age }) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return Math.round(base + (sex === 'male' ? 5 : -161));
}
export function tdee(profile) {
  const a = ACTIVITY.find((x) => x.id === profile.activity) || ACTIVITY[1];
  return Math.round(bmr(profile) * a.mult);
}

// Default macro targets for a given profile.
// Protein 2.0 g/kg on a cut (1.8 maintain, 1.6 bulk), fat 25% of kcal, carbs fill the rest. Fibre 14 g / 1000 kcal.
export function defaultTargets(profile) {
  const goal = GOALS.find((g) => g.id === profile.goal) || GOALS[1];
  const expenditure = profile.tdeeOverride || tdee(profile);
  const kcal = Math.max(1200, Math.round((expenditure + goal.kcal) / 10) * 10);
  const perKg = profile.goal.startsWith('cut') ? 2.0 : profile.goal === 'bulk' ? 1.6 : 1.8;
  const p = Math.round(perKg * profile.weightKg);
  const f = Math.round((kcal * 0.25) / 9);
  const c = Math.max(50, Math.round((kcal - p * 4 - f * 9) / 4));
  const fiber = Math.round((kcal / 1000) * 14);
  return { kcal, p, c, f, fiber, water: 8, cigLimit: profile.smoker ? Math.max(0, Math.floor((profile.cigBaseline || 0) * 0.75)) : 0 };
}

export function bmi(weightKg, heightCm) { const m = heightCm / 100; return +(weightKg / (m * m)).toFixed(1); }

// Scale a food's per-100 values to grams.
export function scaleFood(food, grams) {
  const k = grams / 100, m = food.per100;
  return {
    kcal: Math.round(m.kcal * k), p: +(m.p * k).toFixed(1), c: +(m.c * k).toFixed(1),
    f: +(m.f * k).toFixed(1), fiber: +((m.fiber || 0) * k).toFixed(1), sugar: +((m.sugar || 0) * k).toFixed(1),
  };
}

// Epley estimated one-rep max.
export function e1rm(weight, reps) {
  if (!weight || !reps) return 0;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

// Net calories burned from METs (resting metabolism excluded): kcal = (MET − 1) × kg × hours
export function metBurn(met, weightKg, minutes) {
  return Math.round(Math.max(0, (met || 4) - 1) * (weightKg || 70) * (minutes / 60));
}

// Sum of weight × reps across done sets.
export function workoutVolume(w) {
  let v = 0;
  for (const ex of w.exercises || []) for (const s of ex.sets || []) if (s.done && s.t !== 'W' && s.w && s.r) v += s.w * s.r;
  return Math.round(v);
}

// Adaptive expenditure (MacroFactor-style): over a window with both intake and weight data,
// expenditure ≈ average intake − (weight slope kg/day × 7700).
// weights: [{date:'YYYY-MM-DD', kg}], intake: {date: kcal}
export function adaptiveTdee(weights, intakeByDate, windowDays = 21) {
  const ws = weights.filter((w) => w.kg).sort((a, b) => a.date.localeCompare(b.date));
  if (ws.length < 5) return null;
  const last = ws[ws.length - 1];
  const start = new Date(last.date + 'T00:00:00'); start.setDate(start.getDate() - windowDays);
  const sKey = start.toISOString().slice(0, 10);
  const win = ws.filter((w) => w.date >= sKey);
  if (win.length < 5) return null;
  // least squares slope on day index
  const t0 = new Date(win[0].date + 'T00:00:00').getTime();
  const xs = win.map((w) => (new Date(w.date + 'T00:00:00').getTime() - t0) / 86400000);
  const ys = win.map((w) => w.kg);
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den ? num / den : 0; // kg per day
  const days = [];
  for (let d = new Date(win[0].date + 'T00:00:00'); d <= new Date(last.date + 'T00:00:00'); d.setDate(d.getDate() + 1)) {
    const k = d.toISOString().slice(0, 10);
    if (intakeByDate[k] > 0) days.push(intakeByDate[k]);
  }
  if (days.length < Math.max(5, (xs[n - 1] - xs[0]) * 0.5)) return null;
  const avgIntake = days.reduce((a, b) => a + b, 0) / days.length;
  const est = Math.round(avgIntake - slope * 7700);
  return { tdee: est, slopePerWeek: +(slope * 7).toFixed(2), avgIntake: Math.round(avgIntake), days: days.length, span: Math.round(xs[n - 1] - xs[0]) + 1 };
}

// Trend weight: exponentially weighted moving average (α = 0.1 per day) over sorted weights.
export function trendWeights(weights) {
  const ws = weights.filter((w) => w.kg).sort((a, b) => a.date.localeCompare(b.date));
  let t = null; const out = [];
  for (const w of ws) { t = t == null ? w.kg : t + 0.1 * (w.kg - t); out.push({ date: w.date, kg: w.kg, trend: +t.toFixed(2) }); }
  return out;
}

export function cigStats(entriesByDate, baseline, costPerCig) {
  const dates = Object.keys(entriesByDate).sort();
  const total = dates.reduce((a, d) => a + entriesByDate[d], 0);
  const avoided = baseline ? dates.reduce((a, d) => a + Math.max(0, baseline - entriesByDate[d]), 0) : 0;
  return { total, avoided, moneySaved: Math.round(avoided * (costPerCig || 0)), moneySpent: Math.round(total * (costPerCig || 0)) };
}
