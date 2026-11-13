// Helpers for the Food tab (entry snapshots, recipes, text parsing, starter plates: no DOM) and, at the bottom, the coach and the
// "how your targets are set" sheet that Today and Food share (these build DOM with ui.js).
import { state, findFood, searchFoods, dayTotals, workoutsOn, dateKey, logFood, removeFood } from '../state.js';
import { scaleFood, bmr, defaultTargets, ACTIVITY, GOALS } from '../calc.js';
import { nutritionGaps, microAverages, dietOk, proteinIdeas } from '../insights.js';
import { todayPlan } from '../train-plan.js';
import { h, icon, sheet, toast, segmented, fmt, haptic } from '../ui.js';
import { fill, prefersReducedMotion } from '../motion.js';

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

// ---- Food tab presentation data (strings only) ----
// Everyday foods shown first when the user has no recents yet (ids verified with findFood at runtime; missing ids are skipped).
export const STAPLE_IDS = [
  'roti_plain', 'dal_tadka', 'rice_white_boiled', 'egg_boiled', 'paneer_raw', 'curd_full_fat', 'chai_milk_1tsp', 'mix_veg',
  'whey_concentrate', 'milk_toned', 'banana', 'idli', 'dosa_plain', 'poha', 'rajma_curry', 'chole', 'paratha_plain', 'paneer_bhurji',
  'omelette_2egg', 'oats_porridge_milk', 'soya_chunks_cooked', 'moong_sprouts', 'peanuts_roasted', 'almonds', 'khichdi', 'sambar',
  'chicken_biryani', 'butter_chicken', 'bread_brown', 'apple',
];
const CAT_SHORT = {
  'Roti & Breads': 'Roti', 'Rice & Grains': 'Rice', 'Dal & Legumes': 'Dal', 'Sabzi (Veg)': 'Sabzi', 'Paneer & Dairy': 'Dairy', Eggs: 'Egg',
  Chicken: 'Chicken', 'Mutton, Fish & Seafood': 'Meat & fish', 'Mutton, Fish & Seafood ': 'Meat & fish', 'Breakfast & Tiffin': 'Tiffin',
  'Snacks & Street Food': 'Snack', 'Sweets & Desserts': 'Sweet', Beverages: 'Drink', Fruits: 'Fruit', 'Nuts, Seeds & Dry Fruits': 'Nuts',
  'Protein & Supplements': 'Protein', 'Oils, Ghee & Condiments': 'Oil & ghee', 'Western & Fast Food': 'Fast food', Alcohol: 'Alcohol',
  [RECIPE_CAT]: 'Recipe', 'Scanned dishes': 'Scanned', Scanned: 'Scanned', 'Quick add': 'Quick add',
};
export const shortCat = (f) => (f.recipe ? 'Recipe' : CAT_SHORT[f.cat] || String(f.cat || 'Food').split(/[ ,&(]/)[0]);

// Spot illustrations: inline SVG, two palette tones (accent + card-3) and a muted stroke. The colours come from the
// .t1 / .t2 / .t3 / .s classes in food.css and scan.css, so they follow light and dark themes and the accent swap.
const SVG = (vb, inner) => `<svg viewBox="${vb}" aria-hidden="true" focusable="false">${inner}</svg>`;
const BOWL = '<ellipse class="t2" cx="36" cy="63" rx="22" ry="3.6"/><path class="t1" d="M11 35h50c0 14-10 24-25 24S11 49 11 35z"/><ellipse class="t3" cx="36" cy="35" rx="25" ry="6"/>';
const STEAM = '<path class="s" d="M26 25c-3-4 3-6 0-12M38 25c-3-4 3-6 0-12M50 25c-3-4 3-6 0-12"/>';
export const SPOTS = {
  bowl: SVG('0 0 72 72', BOWL + STEAM),
  search: SVG('0 0 72 72', BOWL + '<path class="s" d="M30 25c-3-4 3-6 0-12M42 25c-3-4 3-6 0-12"/><circle class="s" cx="54" cy="50" r="9"/><path class="s" d="M61 57l7 7"/>'),
  star: SVG('0 0 72 72', BOWL + '<path class="t1" transform="translate(22 1) scale(1.1)" d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>'),
  plate: SVG('0 0 120 96', '<path class="s" d="M10 30V16a6 6 0 0 1 6-6h14M90 10h14a6 6 0 0 1 6 6v14M110 66v14a6 6 0 0 1-6 6H90M30 86H16a6 6 0 0 1-6-6V66"/><circle class="t2" cx="60" cy="48" r="29"/><circle class="t3" cx="60" cy="48" r="22"/><circle class="t1" cx="52" cy="43" r="8"/><circle class="t1" cx="69" cy="53" r="6"/><path class="s" d="M54 62c3 3 8 3 11 0"/>'),
  key: SVG('0 0 72 72', '<ellipse class="t2" cx="38" cy="62" rx="24" ry="3.6"/><circle class="t1" cx="22" cy="34" r="14"/><circle class="t2" cx="22" cy="34" r="5.5"/><rect class="t1" x="34" y="31" width="32" height="6" rx="3"/><rect class="t1" x="50" y="35" width="5" height="11" rx="2"/><rect class="t1" x="59" y="35" width="5" height="7" rx="2"/>'),
};

// ui.js segmented() sets --n / --i through Object.assign(el.style), which ignores custom properties, so the thumb is always
// sized for two options and starts on the first. Set them properly (a no-op once ui.js is fixed).
export function segFix(el, options, value) {
  el.style.setProperty('--n', String(options.length));
  el.style.setProperty('--i', String(Math.max(0, options.findIndex((o) => o.id === value))));
  return el;
}

// "Chai (milk, 1 tsp sugar) 150 ml cup" already says its serving next to the name: drop the repeat in lists.
export const tidyName = (n) => String(n || '').replace(/\s+\d+\s*ml\s+cup$/i, '');

// =====================================================================================================================
// Coach + "how your targets are set": shared by Today (full card) and Food (compact strip). Classes are fd-co-* / fd-tg-*, styled in food.css.
// Everything the coach says comes from what is logged today, the clock, the diet and budget in the profile, today's plan and the last
// seven days of nutrients. Nothing is invented: with nothing logged it says what to log first.
// =====================================================================================================================
const rn = Math.round;
const hashStr = (s) => { let x = 0; for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) >>> 0; return x; };
const whenWord = (hr) => (hr < 11 ? 'This morning' : hr < 16 ? 'At lunch' : hr < 19 ? 'This evening' : hr < 22 ? 'Tonight' : 'Before bed');
export const mealNow = (d = new Date()) => { const hr = d.getHours(); return hr < 11 ? 'breakfast' : hr < 16 ? 'lunch' : hr < 19 ? 'snacks' : 'dinner'; };
// "Til / sesame seeds" -> "sesame seeds", "Mushrooms, UV/sun-exposed (check label)" -> "mushrooms"
const shortFood = (n) => String(n || '').split(/\s*[(,]/)[0].split(' / ').sort((a, b) => b.length - a.length)[0].trim().toLowerCase();
const shortName = (n) => String(n || '').replace(/\s*\(.*\)/, '');

// Protein per unit (g) and what each diet suggests (first match wins): the "plus this much" part of a sentence.
const SOURCES = {
  egg: { p: 6, cap: 4, text: (n) => `${n} egg${n > 1 ? 's' : ''}` },
  dal: { p: 7, cap: 2, text: (n) => `${n} katori dal` },
  paneer: { p: 18, cap: 2, text: (n) => `${n * 100} g paneer` },
  whey: { p: 24, cap: 1, text: (n) => `${n} scoop whey` },
  chicken: { p: 30, cap: 3, text: (n) => `${n * 100} g chicken` },
  soya: { p: 16, cap: 2, text: (n) => `${n * 100} g soya chunks (cooked)` },
};
const DIET_SOURCES = { veg: ['paneer', 'dal', 'soya'], jain: ['paneer', 'dal', 'soya'], egg: ['egg', 'paneer'], nonveg: ['chicken', 'egg'], vegan: ['soya', 'dal'] };
export function proteinIdea(left, diet, max = 2, skip = []) {
  let rem = left;
  const parts = [];
  for (const key of (DIET_SOURCES[diet] || DIET_SOURCES.veg).filter((k) => !skip.includes(k))) {
    const s = SOURCES[key];
    const n = Math.min(s.cap, Math.floor(rem / s.p + 0.4));
    if (n < 1) continue;
    parts.push(s.text(n)); rem -= n * s.p;
    if (parts.length === 2) break;
  }
  if (diet !== 'vegan' && !skip.includes('whey') && rem >= 20 && parts.length < max) parts.push(SOURCES.whey.text(1));
  return parts.join(' + ');
}

// Meal ideas from data/knowledge.json that fit the diet, the budget and what is left of today's calories, best first.
// `want` are knowledge tags to favour (pre_workout, post_workout, late_night_light); `lean` keeps only light, protein-dense ones.
const BREAKFASTY = /oats|egg|omelette|idli|poha|upma|chilla|dosa|banana|yogurt|toast|shake|smoothie|sprouts|paratha|besan|ragi/i, HEAVY = /curry|rice|biryani|\bdal\b|chole|rajma|palak|kadhi|thali|khichdi|sabzi/i;
function pickIdeas({ diet, budget, left, pLeft, hour, key, want = [], gapIds = [], lean = false, max = 3, exclude = [] }) {
  const aim = Math.min(45, Math.max(18, pLeft / (hour < 11 ? 3 : hour < 16 ? 2 : 1)));
  return (state.data.knowledge?.mealIdeas || [])
    .filter((i) => i.approx && dietOk(i.diet, diet) && (budget !== 'tight' || i.fixes.includes('cheap') || (i.costInr || 0) <= 60) && !exclude.includes(i.id))
    .filter((i) => (lean ? (i.fixes.includes('low_kcal') || i.approx.kcal <= 220) && i.approx.p >= 10 : i.approx.p >= 14) && i.approx.kcal <= Math.max(0, left) + 60)
    .map((i) => ({ i, s: (i.fixes.includes('protein') ? 3 : 0) + want.filter((w) => i.fixes.includes(w)).length * 3
      + gapIds.filter((g) => i.fixes.includes(g) || (g === 'vitamin_b12' && i.fixes.includes('b12'))).length * 1.5
      + (hour < 11 ? (BREAKFASTY.test(i.name) ? 3 : 0) - (HEAVY.test(i.name) ? 3 : 0) : 0) // mornings: breakfast food, not a curry
      - Math.abs(i.approx.p - aim) / 12 + (hashStr(key + i.id) % 100) / 100 + (lean ? (i.approx.p / Math.max(60, i.approx.kcal)) * 6 : 0) }))
    .sort((a, b) => b.s - a.s).slice(0, max).map((x) => x.i);
}

// Nutrients that were low over the last seven days, only when there is enough data to say so (3+ logged days with nutrient data).
function gapList() {
  let g = null;
  try { g = nutritionGaps(7); } catch (e) { return []; }
  const ma = microAverages(7);
  if (!g || g.days < 3 || !ma || !Object.keys(ma.avg).length) return [];
  return g.micros.filter((m) => m.status !== 'green' && m.id !== 'sodium' && m.rda).slice(0, 2)
    .map((m) => ({ id: m.id, name: shortName(m.name), unit: m.unit, avg: m.avg, rda: m.rda, pct: m.pct, status: m.status, why: m.why, vegNote: m.vegNote, foods: m.foods || [], days: g.days }));
}

// What to say right now. full=false skips the slow parts (nutrient gaps) for the compact Food strip.
export function coachFor(key, { full = true, now = new Date() } = {}) {
  const t = state.targets || {}, p = state.profile || {}, diet = p.diet || 'veg', budget = p.budget;
  if (!t.kcal) return null;
  const tot = dayTotals(key), hour = now.getHours();
  const left = rn(t.kcal - tot.kcal), pLeft = rn((t.p || 0) - tot.p), over = left < -Math.max(60, t.kcal * 0.04);
  const gaps = full ? gapList() : [], gapIds = gaps.map((g) => g.id), when = whenWord(hour), late = hour >= 21;
  const base = { diet, budget, hour, key, gapIds };
  const out = { key, tot, t, left, pLeft, over, hour, when, diet, headline: null, ideas: [], rest: '', train: null, gaps, notes: [], ok: false };

  if (!tot.n) {
    out.headline = { kind: 'first', title: 'Log your first meal', body: `Nothing is logged yet, so I cannot tell what is missing. Today’s target is ${fmt(t.kcal)} kcal and ${fmt(t.p)} g protein.` };
    out.ideas = pickIdeas({ ...base, left: t.kcal, pLeft: t.p, want: late ? ['late_night_light'] : [], max: 2 });
  } else if (over) {
    const lean = pLeft >= 15;
    out.headline = { kind: 'over', title: `${fmt(-left)} kcal over your target`, body: `One day will not undo your week. Keep the rest of today to water, curd and salad.${lean ? ` Protein is still ${pLeft} g short, so pick something lean.` : ''}` };
    if (lean) out.ideas = pickIdeas({ ...base, left: 220, pLeft, lean: true, max: 2 });
  } else if (pLeft >= 12) {
    const lean = left < 250;
    out.ideas = pickIdeas({ ...base, left, pLeft, want: late ? ['late_night_light'] : [], lean, max: full ? 3 : 2 });
    const first = out.ideas[0];
    let body;
    if (first) {
      const used = [/egg/i.test(first.name) && 'egg', /paneer/i.test(first.name) && 'paneer', /chicken/i.test(first.name) && 'chicken', /soya|soy/i.test(first.name) && 'soya', /whey/i.test(first.name) && 'whey', /dal|chana|chole|rajma|sprout/i.test(first.name) && 'dal'].filter(Boolean); // do not top up with the same thing
      const rem = pLeft - first.approx.p, more = rem >= 10 ? proteinIdea(Math.min(rem, 45), diet, 2, used) : '';
      body = `${when}: ${first.name} gives about ${first.approx.p} g${more ? `, then ${more} for the rest` : ' and nearly closes it'}.`;
      out.rest = more;
    } else {
      const idea = proteinIdeas(pLeft, diet);
      body = idea ? `${when} that is ${idea}.` : `A glass of milk, curd or two eggs would help.`;
    }
    if (lean) body = `Only ${fmt(Math.max(0, left))} kcal left, so go lean. ${body}`;
    out.headline = { kind: 'protein', title: `Protein: ${pLeft} g to go`, body };
  } else if (pLeft > 6) {
    out.headline = { kind: 'protein', title: `Protein: ${pLeft} g to go`, body: diet === 'vegan' ? 'A katori of dal or a handful of peanuts finishes it.' : 'A glass of milk, a katori of curd or two eggs finishes it.' };
  } else {
    out.headline = { kind: 'done', title: 'Protein target hit', body: `${rn(tot.p)} of ${rn(t.p)} g.${left > 250 ? ` ${fmt(left)} kcal left: spend it on dal, veg and fruit.` : ' Calories are about right too.'}` };
  }

  // before or after training
  if (key === dateKey(now) && !state.active) {
    const ws = workoutsOn(key);
    let plan = null; try { plan = todayPlan(now); } catch (e) { plan = null; }
    const ex = out.ideas.map((i) => i.id);
    if (ws.length) {
      const last = ws.reduce((a, w) => Math.max(a, w.end || w.start), 0);
      if (now.getTime() - last < 4 * 3600e3 && !over) out.train = { phase: 'post', title: 'Just trained: refuel', text: '25–30 g protein and some carbs within about 2 hours.', idea: pickIdeas({ ...base, left, pLeft: Math.min(40, Math.max(20, pLeft)), want: ['post_workout'], max: 1, exclude: ex })[0] || null };
    } else if (plan && plan.kind === 'train' && hour < 20) {
      out.train = { phase: 'pre', title: `Train day${plan.label ? `: ${plan.label}` : ''}`, text: '30–40 g carbs + 20 g protein, 60–90 min before you train.', idea: pickIdeas({ ...base, left, pLeft: 25, want: ['pre_workout'], max: 1, exclude: ex })[0] || null };
    }
  }

  // fibre and sugar, only when they are off
  if (tot.n && full) {
    if (t.fiber && hour >= 15 && tot.fiber < t.fiber * 0.6) out.notes.push({ kind: 'fibre', ico: 'leaf', text: `Fibre is ${rn(tot.fiber)} of ${rn(t.fiber)} g. A katori of dal, a fruit or a salad closes most of it.` });
    const sugarCap = rn((t.kcal * 0.1) / 4);
    if (tot.sugar > sugarCap) out.notes.push({ kind: 'sugar', ico: 'warn', text: `Sugar is ${rn(tot.sugar)} g, over the ${sugarCap} g guide (10% of calories). Check chai, sweets and juice.` });
  }
  if (out.train && out.ideas.length > 2) out.ideas.length = 2; // the train-day row carries a third idea
  out.ok = !!tot.n && !over && pLeft <= 12 && !out.train && !gaps.length && !out.notes.length;
  return out;
}

// One tap: add an idea to the diary as a Quick add entry (numbers are the idea's typical home portion), with Undo.
export function logIdea(ctx, idea, key = ctx.date, meal = mealNow()) {
  const a = idea.approx;
  const e = logFood(key, { foodId: null, name: idea.name, cat: 'Quick add', qty: 1, unit: { label: 'Quick add', g: 0 }, g: 0, kcal: a.kcal, p: a.p, c: a.c, f: a.f, fiber: 0, sugar: 0, micro: null, triggers: [], meal, oilTsp: 0 });
  haptic('success');
  toast(`Logged ${shortName(idea.name)} · ${fmt(a.kcal)} kcal`, { kind: 'success', ms: 4000, undo: () => removeFood(key, e.id) });
  return e;
}

const FIX_LABEL = { protein: 'High protein', cheap: 'Budget', fiber: 'Fibre', iron: 'Iron', calcium: 'Calcium', low_kcal: 'Light', late_night_light: 'Late-night friendly', post_workout: 'After training', pre_workout: 'Before training', vitamin_b12: 'B12', vitamin_c: 'Vitamin C', vitamin_d: 'Vitamin D' };

// ---- the meal idea sheet: what is in it, how it fits today's numbers, one button to log it ----
export function ideaSheet(ctx, idea, key = ctx.date) {
  const a = idea.approx, T = state.targets || {}, tot = dayTotals(key), left = rn((T.kcal || 0) - tot.kcal), pLeft = rn((T.p || 0) - tot.p);
  let meal = mealNow(), primary = null;
  const tile = (k, label, c) => { const el = h('div', { class: 'fd-tile' + (k === 'kcal' ? ' kcal' : '') }, h('div', { class: 'lbl' }, c ? h('span', { class: 'dot ' + c }) : null, label), h('div', { class: 'val' }, h('span', { class: 'num' }, fmt(a[k])), k !== 'kcal' ? h('small', null, ' g') : null)); el.style.setProperty('--tc', k === 'kcal' ? 'var(--accent)' : `var(--${c})`); return el; };
  const meter = (label, used, avail, unit, key2) => {
    const pct = avail > 0 ? Math.min(100, (used / avail) * 100) : 100, bar = h('i', { class: used > avail ? 'bad' : '' });
    setTimeout(() => fill(bar, pct, { key: key2, ms: 600 }), 180);
    return h('div', { class: 'fd-fit' }, h('div', { class: 'fd-fit-top' }, h('span', null, label), h('b', { class: 'num' }, `${fmt(used)} / ${fmt(Math.max(0, avail))} ${unit}`)), h('div', { class: 'fd-fit-t' }, bar));
  };
  const chipsRow = [...new Set((idea.fixes || []).map((f) => FIX_LABEL[f]).filter(Boolean))].slice(0, 4);
  const body = h('div', { class: 'stack fd-idea' },
    h('div', { class: 'fd-prev n4' }, tile('kcal', 'kcal'), tile('p', 'Protein', 'p'), tile('c', 'Carbs', 'c'), tile('f', 'Fat', 'f')),
    h('div', { class: 'fd-idea-items' }, icon('bowl', 18), h('span', null, idea.items)),
    h('div', { class: 'fd-idea-meta' }, idea.prepMin ? h('span', { class: 'pill' }, icon('clock', 13), `${idea.prepMin} min`) : null, idea.costInr != null ? h('span', { class: 'pill accent' }, `₹${fmt(idea.costInr)}`) : null, chipsRow.map((c) => h('span', { class: 'pill' }, c))),
    h('div', { class: 'fd-fits' }, meter('Of your calories left', a.kcal, left, 'kcal', 'idea:k'), pLeft > 0 ? meter('Of your protein to go', a.p, pLeft, 'g', 'idea:p') : null),
    h('p', { class: 'micro muted' }, 'Numbers are for a typical home portion. Logged as a Quick add, so edit it in the diary if yours differs.'),
    segmented(MEALS.map(({ id, label }) => ({ id, label })), meal, (id) => { meal = id; if (primary) primary.textContent = `Log to ${MEAL_LABEL[id]}`; }, 'fd-meals'));
  const q = idea.name.split(/[+(]/)[0].trim();
  return sheet({ title: idea.name, content: body, actions: (api) => [
    h('button', { class: 'btn', onClick: () => { api.close(); ctx.go('food', { q, date: key }); } }, 'Find the foods'),
    (primary = h('button', { class: 'btn primary', onClick: () => { api.close(); logIdea(ctx, idea, key, meal); } }, `Log to ${MEAL_LABEL[meal]}`))] });
}

// ---- a low nutrient: how low, why it matters, which foods fix it ----
export function gapSheet(ctx, g) {
  const pct = Math.min(100, Math.round(g.pct * 100)), bar = h('i', { class: g.status });
  setTimeout(() => fill(bar, pct, { key: 'gap:' + g.id, ms: 700 }), 180);
  const foods = g.foods.slice(0, 6);
  const body = h('div', { class: 'stack fd-gapsheet' },
    h('div', { class: 'fd-gap-hero' }, h('div', { class: 'fd-gap-pct' }, h('b', { class: 'num' }, `${pct}%`), h('span', null, 'of your daily need, averaged over the last 7 days')), h('div', { class: 'fd-fit-t' }, bar),
      h('div', { class: 'micro muted' }, `${fmt(g.avg, g.unit === 'mcg' ? 1 : 0)} ${g.unit} a day on average, you need about ${fmt(g.rda, g.unit === 'mcg' ? 1 : 0)} ${g.unit}. Based on ${g.days} logged days.`)),
    g.why ? h('p', { class: 'small' }, g.why) : null,
    foods.length ? h('div', { class: 'fd-gap-foods' }, h('h3', null, 'Foods that help'), h('div', { class: 'list' }, foods.map((f) => h('div', { class: 'list-item fd-gap-food' }, h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, f.name), h('div', { class: 'sub ellipsis' }, f.serving || '')), h('div', { class: 'trail' }, h('b', { class: 'num' }, fmt(f.perServing, 1)), ` ${g.unit}`))))) : null,
    g.vegNote ? h('div', { class: 'callout info small' }, icon('info'), h('div', null, g.vegNote)) : null);
  const q = foods[0] ? shortFood(foods[0].name) : '';
  return sheet({ title: `${g.name} is low`, content: body, actions: (api) => [h('button', { class: 'btn', onClick: api.close }, 'Close'), q ? h('button', { class: 'btn primary', onClick: () => { api.close(); ctx.go('food', { q }); } }, `Find ${q}`) : null] });
}

// ---- "How your targets are set": the same arithmetic the app used, with this person's numbers ----
export function targetsSheet(ctx) {
  const p = state.profile || {}, T = state.targets || {}, manual = T.auto === false;
  let calc = null; try { calc = defaultTargets(p); } catch (e) { calc = null; }
  const act = ACTIVITY.find((x) => x.id === p.activity) || ACTIVITY[1], goal = GOALS.find((x) => x.id === p.goal) || GOALS[1];
  const base = p.weightKg ? bmr({ sex: p.sex || 'male', weightKg: p.weightKg, heightCm: p.heightCm || 170, age: p.age || 28 }) : null;
  const maint = p.tdeeOverride || (base ? Math.round(base * act.mult) : null);
  const perKg = String(p.goal || 'cut').startsWith('cut') ? 2.0 : p.goal === 'bulk' ? 1.6 : 1.8;
  const step = (op, tone, label, sub, val, unit) => h('div', { class: 'fd-tg-step ' + tone },
    h('span', { class: 'fd-tg-op', 'aria-hidden': 'true' }, op), h('div', { class: 'grow' }, h('div', { class: 'fd-tg-l' }, label), sub ? h('div', { class: 'fd-tg-s' }, sub) : null),
    h('b', { class: 'num fd-tg-n' }, val, unit ? h('small', null, unit) : null));
  const chain = base && maint && calc ? h('div', { class: 'fd-tg-chain' },
    step(icon('body', 16), 'a', 'Your body at rest', `Age ${p.age || '–'}, ${p.heightCm || '–'} cm, ${p.weightKg} kg. What you burn lying still.`, fmt(base), ' kcal'),
    p.tdeeOverride ? step('=', 'b', 'Maintenance, set by you', 'You entered your own burn, so activity is not multiplied in.', fmt(maint), ' kcal')
      : [step(icon('x', 14), 'a', 'Daily activity', act.label, String(act.mult)), step('=', 'b', 'Maintenance', 'Roughly what keeps your weight steady.', fmt(maint), ' kcal')],
    step(goal.kcal < 0 ? icon('minus', 14) : goal.kcal > 0 ? icon('plus', 14) : '=', 'a', `Your goal: ${goal.label}`, goal.sub, `${goal.kcal < 0 ? '−' : goal.kcal > 0 ? '+' : ''}${fmt(Math.abs(goal.kcal))}`, ' kcal'),
    step('=', 'total', 'Daily target', 'Rounded to the nearest 10, never below 1,200.', fmt(calc.kcal), ' kcal')) : h('p', { class: 'small muted' }, 'Add your age, height, weight and goal in Settings to see how the target is worked out.');
  const mk = (k, label, g, how, cls, kcalPer) => ({ k, label, g, how, cls, kcal: g * kcalPer });
  const m = [mk('p', 'Protein', T.p, `${perKg} g for each kg of body weight`, 'p', 4), mk('c', 'Carbs', T.c, 'Whatever calories are left', 'c', 4), mk('f', 'Fat', T.f, '25% of calories', 'f', 9)];
  const tk = m.reduce((a, x) => a + x.kcal, 0) || 1;
  const bars = h('div', { class: 'fd-tg-split', 'aria-hidden': 'true' }, m.map((x) => { const i = h('i', { class: x.cls }); setTimeout(() => fill(i, 100, { key: 'tg:' + x.k, ms: 650 }), 200); return h('span', { style: { flex: `${x.kcal} 1 0` } }, i); }));
  const macroRows = h('div', { class: 'fd-tg-macros' }, m.map((x) => h('div', { class: 'fd-tg-m' }, h('i', { class: 'dot ' + x.cls }), h('div', { class: 'grow' }, h('div', { class: 'fd-tg-l' }, x.label), manual ? null : h('div', { class: 'fd-tg-s' }, x.how)), h('b', { class: 'num fd-tg-n' }, fmt(x.g), h('small', null, ' g')))),
    h('div', { class: 'fd-tg-m' }, h('i', { class: 'dot fiber' }), h('div', { class: 'grow' }, h('div', { class: 'fd-tg-l' }, 'Fibre'), manual ? null : h('div', { class: 'fd-tg-s' }, '14 g for every 1,000 kcal')), h('b', { class: 'num fd-tg-n' }, fmt(T.fiber), h('small', null, ' g'))));
  const body = h('div', { class: 'stack fd-tg' },
    manual ? h('div', { class: 'callout' }, icon('sliders'), h('div', null, h('b', null, 'You set these by hand. '), `Your target is ${fmt(T.kcal)} kcal${calc ? `; the calculated number for your profile would be ${fmt(calc.kcal)}` : ''}. Tap Use auto in Settings to go back.`)) : null,
    h('section', { class: 'fd-tg-sec' }, h('h3', null, manual ? 'How the calculated number works' : 'Calories'), chain),
    h('section', { class: 'fd-tg-sec' }, h('h3', null, manual ? 'Your split' : 'Then the calories are split'), bars, macroRows),
    h('div', { class: 'callout info small' }, icon('info'), h('div', null, h('b', null, 'To change it: '), 'Settings, then Daily targets. Pick Auto, or type your own numbers. Change your goal there and everything above follows.')));
  return sheet({ title: 'How your targets are set', content: body, actions: (api) => [h('button', { class: 'btn', onClick: api.close }, 'Close'), h('button', { class: 'btn primary', onClick: () => { api.close(); ctx.go('settings'); } }, 'Open Settings')] });
}

// ---- the coach card ----
// compact: a headline and a row of tappable ideas (top of Food). Otherwise the full card (Today).
export function coachCard(ctx, key, { compact = false, fresh = false } = {}) {
  let c = null;
  try { c = coachFor(key, { full: !compact }); } catch (e) { console.error(e); return null; }
  if (!c || !c.headline) return null;
  const hl = c.headline, K = { first: ['plus', 'accent'], protein: ['target', 'p'], over: ['warn', 'warn'], done: ['check', 'good'] }[hl.kind];
  const addBtn = (idea) => h('button', { class: 'fd-co-add', 'aria-label': `Log ${idea.name}`, onClick: (e) => { e.stopPropagation(); e.preventDefault(); logIdea(ctx, idea, key); } }, icon('plus', 18));
  const meta = (a, idea, short) => `${fmt(a.kcal)} kcal · ${fmt(a.p)} g protein${idea.prepMin && !short ? ` · ${idea.prepMin} min` : ''}`;
  const row = (idea, tag) => h('div', { class: 'fd-co-idea' },
    h('button', { class: 'fd-co-main', onClick: () => ideaSheet(ctx, idea, key) }, h('span', { class: 'well ' + (tag ? 'train' : 'food') }, icon(tag ? 'dumbbell' : 'bowl')),
      h('span', { class: 'fd-co-txt' }, h('span', { class: 'fd-co-in' }, idea.name), h('span', { class: 'fd-co-im' }, tag ? h('b', null, tag + ': ') : null, meta(idea.approx, idea)))),
    addBtn(idea));
  const card = h('div', { class: 'card fd-co' + (compact ? ' compact pad-s' : '') + (fresh ? ' fresh' : ''), 'data-coach': hl.kind });
  const headRow = h('div', { class: 'fd-co-head' }, h('span', { class: 'fd-co-ic ' + K[1] }, icon(K[0], compact ? 18 : 20)),
    h('div', { class: 'grow' }, h('div', { class: 'fd-co-title' }, hl.title), compact ? null : h('div', { class: 'fd-co-body' }, hl.body)));
  card.append(headRow);
  if (compact) {
    if (c.ideas.length) card.append(h('div', { class: 'chips fd-co-cards' }, c.ideas.map((idea) => h('div', { class: 'fd-co-card' },
      h('button', { class: 'fd-co-cmain', onClick: () => ideaSheet(ctx, idea, key) }, h('span', { class: 'fd-co-cn' }, idea.name), h('span', { class: 'fd-co-im' }, meta(idea.approx, idea, true))), addBtn(idea)))));
    else if (hl.body) card.append(h('p', { class: 'fd-co-body' }, hl.body));
    return card;
  }
  if (c.ideas.length) card.append(h('div', { class: 'fd-co-ideas' }, c.ideas.map((i) => row(i, null))));
  if (c.train) {
    const tr = c.train;
    card.append(h('div', { class: 'fd-co-train' }, h('div', { class: 'fd-co-head sub' }, h('span', { class: 'fd-co-ic train' }, icon('dumbbell', 18)), h('div', { class: 'grow' }, h('div', { class: 'fd-co-title sm' }, tr.title), h('div', { class: 'fd-co-body' }, tr.text))),
      tr.idea ? row(tr.idea, tr.phase === 'pre' ? 'Before training' : 'After training') : null));
  }
  if (c.notes.length) card.append(h('ul', { class: 'fd-co-notes' }, c.notes.map((n) => h('li', null, h('span', { class: 'fd-co-ic sm ' + (n.kind === 'sugar' ? 'warn' : 'good') }, icon(n.ico, 13)), h('span', null, n.text)))));
  if (c.gaps.length) card.append(h('div', { class: 'fd-co-gaps' }, c.gaps.map((g) => { const foods = g.foods.slice(0, 3).map((f) => shortFood(f.name)).join(', ');
    return h('button', { class: 'fd-co-gap ' + g.status, onClick: () => gapSheet(ctx, g) }, h('span', { class: 'fd-co-gd' }), h('span', { class: 'fd-co-gt' }, h('b', null, `${g.name} low this week`), foods ? h('span', null, `Try ${foods}`) : null), icon('right', 16)); })));
  if (c.ok) card.append(h('div', { class: 'fd-co-ok' }, icon('check', 16), 'On track today. Nothing to fix right now.'));
  return card;
}

// Gradient stroke for a ui.js ring(): accent to accent-2, drawn with an SVG linearGradient so it follows light, dark and the accent swap.
export function gradientRing(rg, id) {
  const NS = 'http://www.w3.org/2000/svg', svg = rg.querySelector('svg');
  if (!svg || !rg.fillEl) return rg;
  const defs = document.createElementNS(NS, 'defs'), g = document.createElementNS(NS, 'linearGradient');
  g.setAttribute('id', id); g.setAttribute('x1', '0'); g.setAttribute('y1', '0'); g.setAttribute('x2', '1'); g.setAttribute('y2', '1');
  [['0', 'var(--accent)'], ['1', 'var(--accent-2)']].forEach(([o, col]) => { const s = document.createElementNS(NS, 'stop'); s.setAttribute('offset', o); s.style.stopColor = col; g.append(s); });
  defs.append(g); svg.prepend(defs);
  rg.fillEl.style.stroke = `url(#${id})`;
  return rg;
}
