// Pure helpers for the Food tab: entry snapshots, recipes, text parsing, starter plates. No DOM here.
import { state, findFood, searchFoods } from '../state.js';
import { scaleFood } from '../calc.js';

// ---- shared constants ----
export const MEALS = [
  { id: 'breakfast', label: 'Breakfast', hour: 8 }, { id: 'lunch', label: 'Lunch', hour: 13 },
  { id: 'snacks', label: 'Snacks', hour: 17 }, { id: 'dinner', label: 'Dinner', hour: 20 },
  { id: 'drinks', label: 'Drinks', hour: 11 },
];
export const MEAL_LABEL = Object.fromEntries(MEALS.map((m) => [m.id, m.label]));
export const OIL_CATS = new Set(['Sabzi (Veg)', 'Dal & Legumes', 'Paneer & Dairy', 'Chicken', 'Mutton', 'Fish & Seafood', 'Mutton, Fish & Seafood', 'Rice & Grains', 'Breakfast & Tiffin', 'Eggs', 'Roti & Breads']);
export const OIL_KCAL = 40, OIL_FAT = 4.5;
export const RECIPE_CAT = 'My recipes';
export const GRAMS = { label: 'grams', g: 1 };

export const r1 = (x) => Math.round(x * 10) / 10;
export const r2 = (x) => Math.round(x * 100) / 100;
export const servingsOf = (f) => (f.servings && f.servings.length ? f.servings : [{ label: '100 g', g: 100 }]);
export const unitsOf = (f) => servingsOf(f).concat([GRAMS]);
export const isGrams = (u) => u.label === 'grams';
const leadN = (label) => { const m = /^(\d+)\s/.exec(label); return m ? +m[1] : 1; };

// Keep the grams total roughly the same when the unit changes.
export function convertQty(qty, from, to) {
  const grams = qty * from.g;
  return isGrams(to) ? Math.max(10, Math.round(grams / 10) * 10) : Math.max(0.5, Math.round((grams / (to.g || 1)) * 2) / 2);
}

export function scaleMicro(micro, g) {
  if (!micro) return null;
  const out = {};
  for (const [k, v] of Object.entries(micro)) if (typeof v === 'number') out[k] = Math.round(((v * g) / 100) * 1000) / 1000;
  return out;
}

// The diary entry snapshot for a food at a given quantity.
export function buildEntry(food, { qty, unit, meal, oilTsp = 0 }) {
  const g = r1(qty * unit.g);
  const s = scaleFood(food, g);
  const oil = OIL_CATS.has(food.cat) ? oilTsp : 0;
  return {
    foodId: food.id, name: food.name, cat: food.cat, qty, unit: { label: unit.label, g: unit.g }, g,
    kcal: Math.round(s.kcal + oil * OIL_KCAL), p: s.p, c: s.c, f: r1(s.f + oil * OIL_FAT), fiber: s.fiber, sugar: s.sugar,
    micro: scaleMicro(food.micro || null, g), triggers: food.triggers || [], meal, oilTsp: oil,
  };
}

// Indian measures: from data/knowledge.json when present, else sensible defaults.
export function measuresLine(km) {
  if (typeof km === 'string') return km;
  const M = { katori_ml: 150, glass_ml: 250, bowl_g: 200, tbsp_g: 15, roti_medium_g: 40, ...(km && typeof km === 'object' && !Array.isArray(km) ? km : {}) };
  return `katori ≈${M.katori_ml} g · glass ${M.glass_ml} ml · bowl ${M.bowl_g} g · tbsp ${M.tbsp_g} g · roti ${M.roti_medium_g} g`;
}
export function measuresMap(km) {
  const k = km && typeof km === 'object' ? km : {};
  return { katori: k.katori_ml || 150, bowl: k.bowl_g || 200, cup: k.cup_chai_ml || 150, glass: k.glass_ml || 250, plate: k.plate_rice_g || 200, tbsp: k.tbsp_g || 15, tsp: 5, scoop: 30, slice: 30 };
}

// ---- food lookup with a plural fallback (rotis -> roti) ----
const singular = (w) => (w.length > 3 && w.endsWith('es') ? w.slice(0, -2) : w.length > 2 && w.endsWith('s') ? w.slice(0, -1) : w);
export function lookup(text, n = 5) {
  const t = text.trim();
  if (!t) return [];
  const hit = searchFoods(t, '', n);
  return hit.length ? hit : searchFoods(t.split(/\s+/).map(singular).join(' '), '', n);
}

// Common words map to the everyday version of the food (verified with findFood at runtime).
const STAPLES = {
  roti: 'roti_plain', chapati: 'roti_plain', phulka: 'roti_plain', dal: 'dal_tadka', rice: 'rice_white_boiled', chawal: 'rice_white_boiled',
  chai: 'chai_milk_1tsp', tea: 'chai_milk_1tsp', coffee: 'coffee_milk_sugar', egg: 'egg_boiled', milk: 'milk_toned', curd: 'curd_full_fat',
  dahi: 'curd_full_fat', sabzi: 'mix_veg', bread: 'bread_brown', whey: 'whey_concentrate', paneer: 'paneer_raw', dosa: 'dosa_plain',
  paratha: 'paratha_plain', poha: 'poha', upma: 'upma', rajma: 'rajma_curry', chole: 'chole', idli: 'idli', lassi: 'lassi_sweet',
};
// Best matches for a typed food: a recently logged food that starts with the text, else the staple, else search order.
export function bestMatches(text, n = 5) {
  const found = lookup(text, 30);
  const key = text.trim().toLowerCase().split(/\s+/).map(singular).join(' ');
  const staple = STAPLES[key] ? findFood(STAPLES[key]) : null;
  const recent = new Set(state.settings.recents || []);
  const first = found.find((f) => recent.has(f.id) && f.name.toLowerCase().startsWith(key)) || staple || null;
  return (first ? [first, ...found.filter((f) => f.id !== first.id)] : found).slice(0, n);
}

// ---- recipes ----
export const RECIPE_SERVINGS = [{ label: '1 katori (150 g)', g: 150 }, { label: '1 small katori (100 g)', g: 100 }, { label: '1 bowl (200 g)', g: 200 }];
const FAT_KCAL = { oil: [40, 4.5], ghee: [45, 5] };

// items: [{food, g}] raw ingredients. Whole-pot totals incl. added fat; micro summed when any ingredient has it.
export function recipeTotals(items, oilTsp = 0, fat = 'oil') {
  const t = { kcal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0, micro: null };
  for (const { food, g } of items) {
    const k = g / 100;
    for (const key of ['kcal', 'p', 'c', 'f', 'fiber', 'sugar']) t[key] += (food.per100[key] || 0) * k;
    if (food.micro) { t.micro ||= {}; for (const [mk, v] of Object.entries(food.micro)) if (typeof v === 'number') t.micro[mk] = (t.micro[mk] || 0) + v * k; }
  }
  const [kc, fg] = FAT_KCAL[fat] || FAT_KCAL.oil;
  t.kcal += oilTsp * kc; t.f += oilTsp * fg;
  return t;
}

// veg / vegan only if every ingredient has the tag; egg / nonveg if any ingredient does.
export function dietTags(foods) {
  const has = (tag, f) => (f.tags || []).includes(tag);
  return [...['veg', 'vegan'].filter((t) => foods.every((f) => has(t, f))), ...['egg', 'nonveg'].filter((t) => foods.some((f) => has(t, f)))];
}

export function buildRecipeFood({ name, items, oilTsp, fat, cooked, makes }) {
  const tot = recipeTotals(items, oilTsp, fat), k = 100 / cooked, foods = items.map((i) => i.food);
  const food = {
    name, cat: RECIPE_CAT,
    per100: { kcal: r2(tot.kcal * k), p: r2(tot.p * k), c: r2(tot.c * k), f: r2(tot.f * k), fiber: r2(tot.fiber * k), sugar: r2(tot.sugar * k) },
    servings: RECIPE_SERVINGS.map((s) => ({ ...s })),
    tags: ['custom', 'recipe', ...dietTags(foods)],
    triggers: [...new Set(foods.flatMap((f) => f.triggers || []))],
    kw: ['recipe', ...name.toLowerCase().split(/\s+/).filter(Boolean)],
    recipe: { items: items.map(({ food: f, g }) => ({ foodId: f.id, g })), oilTsp, fat, cookedWeight: cooked, makes: makes || null },
  };
  if (tot.micro) food.micro = Object.fromEntries(Object.entries(tot.micro).map(([key, v]) => [key, Math.round(v * k * 1000) / 1000]));
  return food;
}

// ---- text quick-log: "2 roti, 1 katori dal, chai" ----
const FRAC = { '½': 0.5, '¼': 0.25, '¾': 0.75 };
const UNIT = '(katoris?|bowls?|cups?|glass(?:es)?|plates?|pieces?|pcs?|scoops?|slices?|tsps?|teaspoons?|tbsps?|tablespoons?|gms?|grams?|g|ml)';
const UNIT_RE = new RegExp('^' + UNIT + '\\b\\.?\\s*', 'i');
const TRAIL_RE = new RegExp('^(.*\\S)\\s+(\\d+(?:\\.\\d+)?)\\s*' + UNIT + '?\\s*$', 'i');
const ALIAS = { katoris: 'katori', bowls: 'bowl', cups: 'cup', glasses: 'glass', plates: 'plate', pieces: 'piece', pcs: 'piece', pc: 'piece', scoops: 'scoop', slices: 'slice', tsps: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp', tbsps: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp', gm: 'g', gms: 'g', gram: 'g', grams: 'g', ml: 'g' };
const canon = (w) => { const x = w.toLowerCase(); return ALIAS[x] || x; };

export function splitParts(text) {
  return text.split(/[,;\n]|\s+\+\s+|\s+&\s+|\s+and\s+/i).map((s) => s.trim()).filter(Boolean);
}

// Leading quantity: 2, 0.5, 1/2, 1 1/2, ½, 1½, half, a/an/one. Returns [qty, rest] or null.
function takeQty(s) {
  let m;
  if ((m = /^(\d+)\s+(\d+)\s*\/\s*(\d+)\b/.exec(s))) return [+m[1] + (+m[3] ? m[2] / m[3] : 0), s.slice(m[0].length)];
  if ((m = /^(\d+(?:\.\d+)?)?\s*([½¼¾])/.exec(s))) return [(+m[1] || 0) + FRAC[m[2]], s.slice(m[0].length)];
  if ((m = /^(\d+)\s*\/\s*(\d+)\b/.exec(s))) return [+m[2] ? m[1] / m[2] : +m[1], s.slice(m[0].length)];
  if ((m = /^(\d+(?:\.\d+)?|\.\d+)/.exec(s))) return [+m[1], s.slice(m[0].length)];
  if ((m = /^(half|adha|aadha)\b/.exec(s))) return [0.5, s.slice(m[0].length)];
  if ((m = /^(a|an|one)\s+/.exec(s))) return [1, s.slice(m[0].length)];
  return null;
}

// One comma-separated part -> {raw, qty, word, hasQty, rest, matches}
export function parsePart(raw) {
  let s = raw.trim().toLowerCase(), qty = 1, word = null, hasQty = false;
  const lead = takeQty(s);
  if (lead) {
    hasQty = true; qty = lead[0];
    s = lead[1].replace(/^\s*[x×]\s*/, '').trim();
    const u = UNIT_RE.exec(s);
    if (u) { word = canon(u[1]); s = s.slice(u[0].length).replace(/^of\b\s*/, '').trim(); }
  } else {
    const t = TRAIL_RE.exec(s);
    if (t) { hasQty = true; qty = +t[2]; word = t[3] ? canon(t[3]) : null; s = t[1].trim(); }
  }
  return { raw, qty: qty > 0 ? qty : 1, word, hasQty, rest: s, matches: s ? bestMatches(s, 5) : [] };
}

// Decide quantity + unit index (into unitsOf(food)) for a parsed part.
export function resolveUnit(food, { qty, word, hasQty }, measures) {
  const sv = servingsOf(food), gi = sv.length;
  if (word === 'g') return { qty, idx: gi };
  if (word) {
    const i = sv.findIndex((s) => s.label.toLowerCase().includes(word));
    if (i >= 0) { const n = leadN(sv[i].label); return n > 1 ? { qty: Math.round((qty * sv[i].g) / n), idx: gi } : { qty, idx: i }; }
    if (measures[word]) return { qty: Math.round(qty * measures[word]), idx: gi };
  }
  const n = leadN(sv[0].label);
  if (!word && hasQty && n > 1) return { qty: Math.round((qty * sv[0].g) / n), idx: gi };
  return { qty, idx: 0 };
}

// ---- starter plates (templates; ids verified against foods.json at runtime) ----
// item = [foodId, qty, servingIndex = 0]
export const PRESETS = [
  { id: 'hostel', name: 'Hostel / PG thali', items: [['roti_plain', 3], ['dal_tadka', 1], ['mix_veg', 1], ['rice_white_boiled', 1, 2], ['curd_full_fat', 1]] },
  { id: 'office', name: 'Office canteen thali', items: [['roti_plain', 2], ['dal_tadka', 1], ['mix_veg', 1], ['rice_white_boiled', 1], ['salad_kachumber', 1], ['chai_milk_1tsp', 1]] },
  { id: 'dalchawal', name: 'Dal-chawal plate', items: [['rice_white_boiled', 1, 2], ['dal_tadka', 1], ['curd_full_fat', 1], ['papad_roasted', 1]] },
  { id: 'rotisabzidal', name: 'Roti-sabzi-dal', items: [['roti_plain', 3], ['mix_veg', 1], ['dal_tadka', 1]] },
  { id: 'southbf', name: 'South Indian breakfast', items: [['idli', 3], ['sambar', 1], ['coconut_chutney', 1], ['filter_coffee', 1]] },
  { id: 'eggbf', name: 'Egg breakfast', items: [['omelette_2egg', 1], ['bread_brown', 2], ['chai_milk_1tsp', 1]] },
  { id: 'shake', name: 'Protein shake + banana', items: [['whey_concentrate', 1], ['banana', 1], ['milk_toned', 1]] },
];

// Entry snapshots for a preset (missing ids are skipped) plus totals.
export function resolvePreset(p) {
  const items = [];
  for (const [id, qty, si = 0] of p.items) {
    const f = findFood(id);
    if (f) items.push(buildEntry(f, { qty, unit: servingsOf(f)[si] || servingsOf(f)[0], meal: 'snacks', oilTsp: 0 }));
  }
  return { id: p.id, name: p.name, items, kcal: items.reduce((a, e) => a + e.kcal, 0), p: r1(items.reduce((a, e) => a + e.p, 0)) };
}
