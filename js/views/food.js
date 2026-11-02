// Food tab: search and log foods, diary by meal, quick add, recipes, text quick-log, starter plates.
import {
  state, dayIfAny, dayTotals, commit, shiftDate, parseKey, findFood, searchFoods, recentFoods, frequentFoods,
  toggleFav, logFood, logFoods, removeFood, removeFoods, setPartial, updateFood, addCustomFood, removeCustomFood,
  addSavedMeal, removeSavedMeal,
} from '../state.js';
import {
  h, icon, sheet, toast, stepper, chips, segmented, field, toggle, emptyState, clear, setActive, promptSheet,
  fmt, fmtDateLabel, fmtShortDate, haptic,
} from '../ui.js';
import { scaleFood } from '../calc.js';
import {
  MEALS, MEAL_LABEL, OIL_CATS, OIL_KCAL, OIL_FAT, RECIPE_CAT, r1, r2, servingsOf, unitsOf, isGrams, convertQty,
  buildEntry, measuresLine, measuresMap, lookup, buildRecipeFood, recipeTotals, splitParts, parsePart, resolveUnit,
  PRESETS, resolvePreset,
} from './food-extras.js';

// ---- constants ----
const MAX_RESULTS = 60;
const POOLS = [{ id: 'all', label: 'All' }, { id: '@recent', label: 'Recent' }, { id: '@frequent', label: 'Frequent' }, { id: '@fav', label: 'Favourites' }, { id: '@mine', label: 'My foods' }, { id: '@meals', label: 'Saved meals' }];
const EMPTY_COPY = { '@recent': 'Foods you log will show up here.', '@frequent': 'Your most-logged foods will show up here.', '@fav': 'Tap the star on a food to keep it here.', '@mine': 'Foods you create will show up here.' };
const SEARCH_PH = 'Search dal, paneer, biryani…', TEXT_PH = 'e.g. 2 roti, 1 katori dal, chai';

// Protein per unit (g) for the nudge line, and what each diet suggests (first match wins).
const SOURCES = {
  egg: { p: 6, cap: 4, text: (n) => `${n} egg${n > 1 ? 's' : ''}` },
  dal: { p: 7, cap: 2, text: (n) => `${n} katori dal` },
  paneer: { p: 18, cap: 2, text: (n) => `${n * 100} g paneer` },
  whey: { p: 24, cap: 1, text: (n) => `${n} scoop whey` },
  chicken: { p: 30, cap: 3, text: (n) => `${n * 100} g chicken` },
  soya: { p: 16, cap: 2, text: (n) => `${n * 100} g soya chunks (cooked)` },
};
const DIET_SOURCES = { veg: ['paneer', 'dal', 'soya'], jain: ['paneer', 'dal', 'soya'], egg: ['egg', 'paneer'], nonveg: ['chicken', 'egg'], vegan: ['soya', 'dal'] };

// ---- module state (survives re-renders) ----
let query = '';
let cat = 'all';
let view = 'add'; // 'add' | 'diary'
let textMode = false; // "type it like you say it"
let textQuery = '';
let textRows = [];
let textMeal = null; // null = time rule (drinks stay in Drinks)
let activeSheet = null;
let seenParams = null;
let C = null; // latest ctx
let slots = null; // live DOM slots of the current render

// ---- small helpers ----
const sum = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);
const num = (el) => parseFloat(el.value) || 0;
const clone = (o) => JSON.parse(JSON.stringify(o));
const stripIds = (e) => { const { id, ts, ...rest } = e; return clone(rest); };
const dayFood = (key) => dayIfAny(key)?.food || [];
const mealOf = (e) => (MEAL_LABEL[e.meal] ? e.meal : 'snacks');
const mealEntries = (key, meal) => dayFood(key).filter((e) => mealOf(e) === meal).sort((a, b) => (a.ts || 0) - (b.ts || 0));
const dataCats = () => [...new Set(state.data.foods.map((f) => f.cat))];
const categories = () => (state.customFoods.some((f) => f.cat === RECIPE_CAT) ? dataCats().concat(RECIPE_CAT) : dataCats());
const numInput = (ph, value) => h('input', { type: 'number', inputmode: 'decimal', placeholder: ph, min: 0, value });
const measures = () => measuresMap(state.data.knowledge?.indianMeasures);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const rawFirst = (list) => list.slice().sort((a, b) => /\b(raw|uncooked)\b/i.test(b.name) - /\b(raw|uncooked)\b/i.test(a.name)); // recipe ingredients are raw

function mealByTime(d = new Date()) { const hr = d.getHours(); return hr < 11 ? 'breakfast' : hr < 16 ? 'lunch' : hr < 19 ? 'snacks' : 'dinner'; }
const defaultMeal = (food) => (food?.cat === 'Beverages' ? 'drinks' : mealByTime());
const mealForItem = (it) => (it.cat === 'Beverages' || it.meal === 'drinks' ? 'drinks' : mealByTime());

// Timestamp override for entries on other days (today uses the state clock).
function tsFor(date, meal, i = 0) {
  if (date === C.today) return {};
  const hour = MEALS.find((m) => m.id === meal)?.hour ?? 12;
  return { ts: parseKey(date).getTime() + (hour - 12) * 3600000 + i };
}

function unitText(qty, unit) {
  if (!unit) return fmt(qty, 1);
  if (isGrams(unit)) return `${fmt(qty, 1)} g`;
  return qty === 1 ? unit.label : `${fmt(qty, 1)} × ${unit.label.replace(/^1\s+(?!\d)/, '')}`;
}

function proteinNudge(left, diet) {
  let rem = left;
  const parts = [];
  for (const key of DIET_SOURCES[diet] || DIET_SOURCES.veg) {
    const s = SOURCES[key];
    const n = Math.min(s.cap, Math.floor(rem / s.p + 0.4));
    if (n < 1) continue;
    parts.push(s.text(n)); rem -= n * s.p;
    if (parts.length === 2) break;
  }
  if (diet !== 'vegan' && rem >= 20) parts.push(SOURCES.whey.text(1));
  return `Protein left: ${Math.round(left)} g — about ${parts.join(' + ')}`;
}

// Scroll a chip strip so its active chip is in view.
function showActiveChip(el) {
  const on = el.querySelector('.on');
  if (on && el.isConnected) el.scrollLeft = on.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft - 16;
}

// ---- sheets plumbing ----
function showSheet(opts) {
  if (activeSheet) activeSheet.close();
  const api = sheet({ ...opts, onClose: () => { if (activeSheet === api) activeSheet = null; if (opts.onClose) opts.onClose(); } });
  activeSheet = api;
  return api;
}
const btn = (cls, label, onClick) => h('button', { class: 'btn ' + cls, onClick }, label);
const kbIcon = () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: 22, height: 22, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10');
  svg.appendChild(p);
  return svg;
};

function undoToast(msg, date, ids) { toast(msg, { ms: 4000, undo: () => removeFoods(date, ids) }); }
function deleteEntry(date, entry) {
  const copy = { ...entry };
  removeFood(date, entry.id);
  toast(`Removed ${entry.name}`, { ms: 4000, undo: () => logFood(date, copy) });
}
function longPress(el, fn) {
  let t = null, fired = false;
  el.addEventListener('pointerdown', () => { fired = false; t = setTimeout(() => { fired = true; fn(); }, 550); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) el.addEventListener(ev, () => clearTimeout(t));
  el.addEventListener('click', (e) => { if (fired) { fired = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
}

// ---- summary strip ----
function macroCell(label, key, eaten, target) {
  const pct = target > 0 ? Math.min(100, (eaten / target) * 100) : 0;
  return h('div', { class: 'fd-macro' },
    h('div', { class: 'lbl' }, h('span', { class: 'dot ' + key }), label),
    h('div', { class: 'val' }, h('b', null, fmt(eaten, 0)), ` / ${fmt(target, 0)} g`),
    h('div', { class: 'mini-bar' }, h('i', { style: { width: pct + '%', background: `var(--${key})` } })));
}

function paintSummary() {
  const t = dayTotals(C.date), T = state.targets || {};
  const left = (T.kcal || 0) - t.kcal, over = left < 0;
  const pct = T.kcal > 0 ? Math.min(100, (t.kcal / T.kcal) * 100) : 0;
  const card = h('div', { class: 'card fd-sum' },
    h('div', { class: 'row between' },
      h('div', null, h('span', { class: 'num fd-kcal' }, fmt(t.kcal)), h('span', { class: 'muted' }, ` / ${fmt(T.kcal)} kcal`)),
      T.kcal ? h('div', { class: 'right fd-left' + (over ? ' over' : '') }, h('b', null, fmt(Math.abs(left))), over ? ' kcal over' : ' kcal left') : null),
    h('div', { class: 'mini-bar fd-bar' + (over ? ' over' : '') }, h('i', { style: { width: pct + '%' } })),
    h('div', { class: 'fd-macros' }, macroCell('Protein', 'p', t.p, T.p), macroCell('Carbs', 'c', t.c, T.c), macroCell('Fat', 'f', t.f, T.f), macroCell('Fiber', 'fiber', t.fiber, T.fiber)),
    toggle(C.date === C.today ? "I didn't log everything today" : "I didn't log everything this day", !!dayIfAny(C.date)?.partial,
      (on) => setPartial(C.date, on), 'Keeps this day out of your calorie-burn estimate.'));
  const pLeft = (T.p || 0) - t.p;
  clear(slots.summary);
  slots.summary.append(card, pLeft > 20 ? h('div', { class: 'callout fd-nudge' }, icon('bowl'), proteinNudge(pLeft, state.profile?.diet)) : null);
}

// ---- search & results ----
function poolFoods() {
  if (cat === '@recent') return recentFoods(40);
  if (cat === '@frequent') return frequentFoods(40);
  if (cat === '@fav') return state.favFoods.map(findFood).filter(Boolean);
  if (cat === '@mine') return state.customFoods.slice().sort((a, b) => !!b.recipe - !!a.recipe); // recipes first
  return null;
}
function resultFoods() {
  const pool = poolFoods();
  if (!pool) return searchFoods(query, cat === 'all' ? '' : cat, 1000);
  if (!query.trim()) return pool;
  const ids = new Set(pool.map((f) => f.id));
  return searchFoods(query, '', 1000).filter((f) => ids.has(f.id));
}

function foodRow(f, fav) {
  const sv = servingsOf(f)[0], s = scaleFood(f, sv.g);
  const main = h('button', { class: 'fd-main', onClick: () => openFoodSheet(f) },
    h('div', { class: 'title' }, f.name, f.recipe ? h('span', { class: 'pill fd-pill' }, 'recipe') : null),
    h('div', { class: 'sub' }, `${sv.label} · ${fmt(s.kcal)} kcal · ${fmt(s.p, 1)} g protein`));
  if (f.recipe) longPress(main, () => openRecipeMenu(f));
  return h('div', { class: 'list-item fd-split' }, main,
    f.recipe ? h('button', { class: 'fd-more', 'aria-label': `More for ${f.name}`, onClick: () => openRecipeMenu(f) }, icon('more')) : null,
    h('button', {
      class: 'fd-star' + (fav ? ' on' : ''), 'aria-label': `Favourite ${f.name}`, 'aria-pressed': fav ? 'true' : 'false',
      onClick: (ev) => { const on = toggleFav(f.id); ev.currentTarget.classList.toggle('on', on); ev.currentTarget.setAttribute('aria-pressed', on ? 'true' : 'false'); },
    }, icon('star', 22)));
}

function noResults() {
  const q = query.trim();
  const title = q ? `No match for “${q}”` : 'Nothing here yet';
  const sub = q ? 'Add it quickly, or save it as your own food.' : (EMPTY_COPY[cat] || 'Try another category.');
  return emptyState(title, sub, h('div', { class: 'fd-empty-actions' },
    btn('', [icon('plus', 16), 'Quick add'], () => openQuickSheet()),
    btn('', [icon('plus', 16), 'Create food'], () => openCreateSheet(q))));
}

function paintResults() {
  const box = slots.results;
  clear(box);
  if (cat === '@meals') { box.append(savedMealsPane()); return; }
  const list = resultFoods();
  if (!list.length) { box.append(noResults()); return; }
  const favs = new Set(state.favFoods);
  box.append(h('div', { class: 'list' }, list.slice(0, MAX_RESULTS).map((f) => foodRow(f, favs.has(f.id)))));
  if (list.length > MAX_RESULTS) box.append(h('div', { class: 'fd-note' }, `Showing ${MAX_RESULTS} of ${list.length}. Search or pick a category to narrow it down.`));
}

// Category chips: rebuilt only when the set changes (e.g. the first recipe adds "My recipes").
const chipOptions = () => POOLS.concat(categories().map((c) => ({ id: c, label: c })));
const makeChips = () => chips(chipOptions(), cat, (id) => { cat = id; paintResults(); });
function syncChips() {
  const ids = chipOptions().map((o) => o.id).join('|');
  if (slots.chipIds === ids) return;
  if (!chipOptions().some((o) => o.id === cat)) cat = 'all';
  const next = makeChips(), old = slots.chips;
  slots.chipIds = ids; slots.chips = next;
  if (old && old.isConnected) { old.replaceWith(next); next.scrollLeft = old.scrollLeft; }
}

// ---- saved meals + starter plates ----
const subhead = (text) => h('div', { class: 'fd-subhead' }, text);
function savedMealsPane() {
  const q = query.trim().toLowerCase(), hit = (n) => !q || n.toLowerCase().includes(q);
  const presets = PRESETS.map(resolvePreset).filter((p) => p.items.length && hit(p.name));
  const meals = state.savedMeals.filter((m) => hit(m.name));
  return h('div', null,
    presets.length ? [subhead('Starter plates'), h('div', { class: 'list' }, presets.map(presetRow))] : null,
    subhead('Your meals'),
    meals.length ? h('div', { class: 'list' }, meals.map(savedRow)) : emptyState('No saved meals yet', 'In your diary, tap “Save as meal” under any meal.'));
}
function mealSub(items) { return `${plural(items.length, 'item')} · ${fmt(sum(items, 'kcal'))} kcal · ${fmt(sum(items, 'p'), 1)} g protein`; }
function presetRow(p) {
  return h('div', { class: 'list-item' },
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, p.name), h('div', { class: 'sub' }, mealSub(p.items)),
      h('div', { class: 'sub ellipsis' }, p.items.map((i) => i.name).join(', ')),
      h('button', { class: 'fd-link', onClick: () => savePreset(p) }, 'Save as my meal')),
    btn('primary', 'Log', () => logItems(p.name, p.items)));
}
function savedRow(m) {
  return h('div', { class: 'list-item' },
    h('div', { class: 'grow' },
      h('div', { class: 'title' }, m.name), h('div', { class: 'sub' }, mealSub(m.items)),
      h('div', { class: 'sub ellipsis' }, m.items.map((i) => i.name).join(', '))),
    btn('primary', 'Log', () => logItems(m.name, m.items)),
    h('button', { class: 'icon-btn plain', 'aria-label': `Delete ${m.name}`, onClick: () => deleteSaved(m) }, icon('trash')));
}
// Re-log a set of snapshots for the selected day (meal by time rule, drinks stay in Drinks).
function logItems(name, items) {
  const date = C.date;
  const made = logFoods(date, items.map((it, i) => { const meal = mealForItem(it); return { ...stripIds(it), meal, ...tsFor(date, meal, i) }; }));
  haptic();
  undoToast(`Logged ${name}`, date, made.map((e) => e.id));
}
function savePreset(p) {
  addSavedMeal({ name: p.name, items: p.items.map((e) => ({ ...stripIds(e), meal: mealForItem(e) })) });
  toast(`Saved “${p.name}” to your meals`);
}
function deleteSaved(m) {
  removeSavedMeal(m.id);
  toast(`Deleted ${m.name}`, { ms: 4000, undo: () => addSavedMeal(m) });
}

// ---- diary ----
function entryRow(e) {
  return h('button', { class: 'list-item', onClick: () => openEntry(e) },
    h('div', { class: 'grow' }, h('div', { class: 'title' }, e.name), h('div', { class: 'sub' }, `${unitText(e.qty ?? 1, e.unit)} · ${fmt(e.p, 1)} g protein`)),
    h('div', { class: 'trail' }, h('b', null, fmt(e.kcal)), 'kcal'));
}
const linkBtn = (label, onClick) => h('button', { class: 'fd-link', onClick }, label);

function mealGroup({ m, items, prevCount }) {
  const when = C.date === C.today ? 'yesterday' : 'the day before';
  return h('div', { class: 'fd-group' },
    h('div', { class: 'fd-ghead' }, h('h3', null, m.label), items.length ? h('span', { class: 'muted small' }, `${fmt(sum(items, 'kcal'))} kcal · ${fmt(sum(items, 'p'), 1)} g protein`) : null),
    items.length ? h('div', { class: 'list' }, items.map(entryRow)) : null,
    h('div', { class: 'fd-links' }, prevCount ? linkBtn(`Copy from ${when}`, () => copyMeal(m)) : null, items.length ? linkBtn('Save as meal', () => saveMeal(m, items)) : null));
}

function paintDiary() {
  const box = slots.diary, prev = shiftDate(C.date, -1);
  const groups = MEALS.map((m) => ({ m, items: mealEntries(C.date, m.id), prevCount: mealEntries(prev, m.id).length })).filter((g) => g.items.length || g.prevCount);
  clear(box);
  if (groups.length) groups.forEach((g) => box.append(mealGroup(g)));
  else box.append(emptyState('Nothing logged yet', 'Search for a food, or use Quick add.', btn('primary', 'Find food', () => setView('add'))));
  const n = dayFood(C.date).length;
  slots.seg.querySelector('[data-id="diary"]').textContent = n ? `Diary · ${n}` : 'Diary';
}

function copyMeal(m) {
  const date = C.date;
  const made = logFoods(date, mealEntries(shiftDate(date, -1), m.id).map((e, i) => ({ ...stripIds(e), meal: m.id, ...tsFor(date, m.id, i) })));
  haptic();
  undoToast(`Copied ${plural(made.length, 'item')}`, date, made.map((e) => e.id));
}
async function saveMeal(m, items) {
  const name = await promptSheet('Save as meal', m.label, { placeholder: 'Meal name' });
  if (!name) return;
  addSavedMeal({ name, items: items.map(stripIds) });
  toast(`Saved “${name}”`, { action: 'View', onAction: () => { setTextMode(false); cat = '@meals'; setActive(slots.chips, cat); setView('add'); paintResults(); } });
}
function openEntry(e) {
  const food = e.foodId && findFood(e.foodId);
  if (food) openFoodSheet(food, e); else openQuickSheet(e);
}

// ---- quantity sheet (add or edit) ----
function previewTiles() {
  const vals = {};
  const defs = [['kcal', 'kcal'], ['p', 'Protein'], ['c', 'Carbs'], ['f', 'Fat'], ['fiber', 'Fiber']];
  const el = h('div', { class: 'fd-prev' }, defs.map(([k, label]) => h('div', { class: 'tile' }, h('div', { class: 'lbl' }, k === 'kcal' ? null : h('span', { class: 'dot ' + k }), label), (vals[k] = h('div', { class: 'val' })))));
  const set = (e) => defs.forEach(([k]) => { clear(vals[k]); vals[k].append(fmt(e[k], k === 'kcal' ? 0 : 1)); if (k !== 'kcal') vals[k].append(h('small', null, 'g')); });
  return { el, set };
}

function openFoodSheet(food, entry = null) {
  const date = C.date, units = unitsOf(food);
  const st = { unit: 0, qty: 1, meal: defaultMeal(food), oil: 0 };
  if (entry) {
    let i = units.findIndex((u) => u.label === entry.unit?.label && u.g === entry.unit?.g);
    if (i < 0 && entry.unit) { units.unshift({ ...entry.unit }); i = 0; }
    Object.assign(st, { unit: Math.max(0, i), qty: entry.qty || 1, meal: mealOf(entry), oil: entry.oilTsp || 0 });
  }
  const unit = () => units[st.unit];
  const cur = () => buildEntry(food, { qty: st.qty, unit: unit(), meal: st.meal, oilTsp: st.oil });
  const prev = previewTiles(), note = h('span', { class: 'muted small' }), qtyBox = h('div', { class: 'fd-step' });
  const gramsHint = h('div', { class: 'hint' });
  let primary = null;
  const refresh = () => { const e = cur(); prev.set(e); note.textContent = isGrams(unit()) ? '' : `= ${fmt(e.g, 0)} g`; };
  const drawQty = () => {
    const gm = isGrams(unit());
    clear(qtyBox);
    qtyBox.append(stepper({ value: st.qty, min: gm ? 10 : 0.5, max: gm ? 5000 : 50, step: gm ? 10 : 0.5, onChange: (v) => { st.qty = v; refresh(); } }), note);
    gramsHint.textContent = gm ? measuresLine(state.data.knowledge?.indianMeasures) : '';
    gramsHint.classList.toggle('hide', !gm);
  };
  const pick = (id) => { const from = unit(); st.unit = +id; st.qty = convertQty(st.qty, from, unit()); drawQty(); refresh(); showActiveChip(unitChips); };
  const unitChips = chips(units.map((u, i) => ({ id: String(i), label: u.label })), String(st.unit), pick);
  const oilField = OIL_CATS.has(food.cat)
    ? field('Oil or ghee added (tsp)', h('div', { class: 'fd-step' }, stepper({ value: st.oil, min: 0, max: 5, step: 0.5, onChange: (v) => { st.oil = v; refresh(); } })), `Each tsp adds ${OIL_KCAL} kcal and ${OIL_FAT} g fat.`)
    : null;
  const mealSeg = segmented(MEALS.map(({ id, label }) => ({ id, label })), st.meal, (id) => { st.meal = id; if (primary && !entry) primary.textContent = `Add to ${MEAL_LABEL[id]}`; }, 'fd-meals');
  const qtyField = field('Quantity', qtyBox);
  qtyField.append(gramsHint);
  const links = !entry && (food.recipe || food.custom) ? h('div', { class: 'fd-links' },
    food.recipe ? linkBtn('Edit recipe', () => openRecipeSheet(food)) : null,
    h('button', { class: 'fd-link fd-danger', onClick: () => deleteCustom(food, s) }, food.recipe ? 'Delete this recipe' : 'Delete this custom food')) : null;
  const content = h('div', { class: 'stack' },
    h('div', { class: 'muted small' }, `${food.cat} · per 100 g: ${fmt(food.per100.kcal)} kcal, ${fmt(food.per100.p, 1)} g protein`),
    field('Serving', unitChips),
    qtyField, prev.el, oilField, field('Meal', mealSeg), links);
  drawQty(); refresh();
  const s = showSheet({
    title: food.name, content,
    actions: (api) => (entry ? [
      btn('danger', [icon('trash', 18), 'Delete'], () => { api.close(); deleteEntry(date, entry); }),
      btn('primary', 'Save', () => { api.close(); updateFood(date, entry.id, cur()); toast('Saved'); }),
    ] : [(primary = btn('primary', `Add to ${MEAL_LABEL[st.meal]}`, () => {
      api.close();
      const e = logFood(date, { ...cur(), ...tsFor(date, st.meal) });
      haptic(); undoToast(`Added ${food.name}`, date, [e.id]);
    }))]),
  });
  showActiveChip(unitChips);
}

function deleteCustom(food, s) {
  removeCustomFood(food.id); if (s) s.close();
  toast(`Deleted ${food.name}`, { ms: 4000, undo: () => addCustomFood(food) });
}

// ---- quick add sheet (add or edit) ----
function openQuickSheet(entry = null) {
  const date = C.date;
  let meal = entry ? mealOf(entry) : mealByTime();
  const name = h('input', { type: 'text', placeholder: 'Quick add', maxlength: 60, value: entry ? entry.name : '' });
  const pre = (x) => (entry && x ? x : undefined);
  const kcal = numInput('0', pre(entry?.kcal));
  const p = numInput('0', pre(entry?.p)), c = numInput('0', pre(entry?.c)), f = numInput('0', pre(entry?.f));
  let primary = null;
  const valid = () => { if (primary) primary.disabled = !(num(kcal) > 0); };
  kcal.addEventListener('input', valid);
  const fields = () => ({ name: name.value.trim() || 'Quick add', kcal: Math.round(num(kcal)), p: r1(num(p)), c: r1(num(c)), f: r1(num(f)), meal });
  const content = h('div', { class: 'stack' },
    field('Name', name), field('Calories (kcal)', kcal, 'Required. Everything else is optional.'),
    h('div', { class: 'grid-3' }, field('Protein (g)', p), field('Carbs (g)', c), field('Fat (g)', f)),
    field('Meal', segmented(MEALS.map(({ id, label }) => ({ id, label })), meal, (id) => { meal = id; if (primary && !entry) primary.textContent = `Add to ${MEAL_LABEL[id]}`; }, 'fd-meals')));
  showSheet({
    title: entry ? 'Edit entry' : 'Quick add', content,
    actions: (api) => {
      if (entry) {
        primary = btn('primary', 'Save', () => { api.close(); updateFood(date, entry.id, fields()); toast('Saved'); });
        return [btn('danger', [icon('trash', 18), 'Delete'], () => { api.close(); deleteEntry(date, entry); }), primary];
      }
      primary = btn('primary', `Add to ${MEAL_LABEL[meal]}`, () => {
        api.close();
        const e = logFood(date, { foodId: null, cat: 'Quick add', qty: 1, unit: { label: 'Quick add', g: 0 }, g: 0, fiber: 0, sugar: 0, micro: null, triggers: [], oilTsp: 0, ...fields(), ...tsFor(date, meal) });
        haptic(); undoToast(`Added ${e.name}`, date, [e.id]);
      });
      return [primary];
    },
  });
  valid();
}

// ---- create food sheet ----
function openCreateSheet(prefill = '') {
  let mode = 'serving';
  const name = h('input', { type: 'text', value: prefill, placeholder: 'e.g. Mom’s rajma', maxlength: 60, autocapitalize: 'words' });
  const catSel = h('select', null, dataCats().map((c) => h('option', { value: c, selected: c === 'Snacks & Street Food' }, c)));
  const label = h('input', { type: 'text', placeholder: '1 katori', maxlength: 40 }), grams = numInput('150');
  const v = { kcal: numInput('0'), p: numInput('0'), c: numInput('0'), f: numInput('0'), fiber: numInput('0') };
  const head = h('div', { class: 'fd-sub' }), hint = h('div', { class: 'small muted' });
  const copy = {
    serving: ['Nutrition in one serving', 'Numbers for the serving size above.'],
    per100: ['Nutrition per 100 g', 'Copy these from the pack. Add a serving size above to log by katori or piece (optional).'],
  };
  const setMode = (m) => { mode = m; head.textContent = copy[m][0]; hint.textContent = copy[m][1]; };
  setMode(mode);
  const content = h('div', { class: 'stack' },
    field('Name', name), field('Category', catSel),
    segmented([{ id: 'serving', label: 'Per serving' }, { id: 'per100', label: 'Per 100 g' }], mode, setMode),
    h('div', { class: 'grid-2' }, field('Serving name', label), field('Serving size (g)', grams)),
    head, hint,
    h('div', { class: 'grid-2' }, field('Calories (kcal)', v.kcal), field('Protein (g)', v.p), field('Carbs (g)', v.c), field('Fat (g)', v.f), field('Fiber (g)', v.fiber)));
  const save = (api) => {
    const g = num(grams), nm = name.value.trim();
    if (!nm) { toast('Give the food a name'); return; }
    if (!(num(v.kcal) > 0)) { toast('Enter the calories'); return; }
    if (mode === 'serving' && !(g > 0)) { toast('Enter the serving size in grams'); return; }
    const k = mode === 'serving' ? 100 / g : 1;
    const per100 = { kcal: r2(num(v.kcal) * k), p: r2(num(v.p) * k), c: r2(num(v.c) * k), f: r2(num(v.f) * k), fiber: r2(num(v.fiber) * k), sugar: 0 };
    const sv = g > 0 ? { label: label.value.trim() || (mode === 'serving' ? '1 serving' : `${fmt(g)} g`), g } : { label: '100 g', g: 100 };
    const food = addCustomFood({ name: nm, cat: catSel.value, per100, servings: [sv], tags: ['custom'], kw: [] });
    api.close(); openFoodSheet(food);
  };
  showSheet({ title: 'Create food', content, actions: (api) => [btn('', 'Cancel', api.close), btn('primary', 'Save food', () => save(api))] });
}

// ---- pot recipe builder ("cook once, log by katori") ----
function replaceCustom(id, food) {
  const i = state.customFoods.findIndex((f) => f.id === id);
  if (i < 0) return;
  state.customFoods[i] = { ...food, id, custom: true };
  commit();
}

function openRecipeMenu(food) {
  const api = showSheet({
    title: food.name,
    content: h('div', { class: 'stack' },
      btn('', [icon('edit', 18), 'Edit recipe'], () => { api.close(); openRecipeSheet(food); }),
      btn('danger', [icon('trash', 18), 'Delete recipe'], () => deleteCustom(food, api))),
  });
}

function openRecipeSheet(existing = null) {
  const R = existing?.recipe;
  const st = { items: R ? R.items.map(({ foodId, g }) => ({ food: findFood(foodId), g })).filter((i) => i.food) : [], oil: R?.oilTsp || 0, fat: R?.fat || 'oil', cooked: R && !R.makes ? R.cookedWeight : 0, makes: R?.makes || 4 };
  if (R && st.items.length < R.items.length) toast('Some ingredients no longer exist and were dropped');
  const name = h('input', { type: 'text', value: existing ? existing.name : '', placeholder: 'e.g. Sunday rajma', maxlength: 60, autocapitalize: 'words' });
  const ingBox = h('div', { class: 'stack' }), results = h('div');
  const cookedIn = numInput('optional', st.cooked || undefined), makesIn = numInput('4', st.makes);
  const note = h('div', { class: 'small muted' }), pot = previewTiles(), kat = previewTiles();
  const cookedG = () => (st.cooked > 0 ? st.cooked : st.makes * 150);
  const refresh = () => {
    const tot = recipeTotals(st.items, st.oil, st.fat), c = cookedG(), k = c > 0 ? 150 / c : 0;
    pot.set(tot); kat.set({ kcal: tot.kcal * k, p: tot.p * k, c: tot.c * k, f: tot.f * k, fiber: tot.fiber * k });
    note.textContent = c > 0 ? `Pot weighs ${fmt(c)} g, about ${fmt(c / 150, 1)} katoris.` : 'Enter the cooked weight or how many katoris it makes.';
  };
  const ingRow = (it) => {
    const sub = h('span', { class: 'muted small' });
    const upd = () => { const s = scaleFood(it.food, it.g); sub.textContent = `${fmt(s.kcal)} kcal · ${fmt(s.p, 1)} g protein`; };
    upd();
    return h('div', { class: 'fd-ing' },
      h('div', { class: 'row between' }, h('div', { class: 'strong grow ellipsis' }, it.food.name),
        h('button', { class: 'icon-btn plain', 'aria-label': `Remove ${it.food.name}`, onClick: () => { st.items.splice(st.items.indexOf(it), 1); drawIng(); refresh(); } }, icon('x'))),
      h('div', { class: 'fd-step' }, stepper({ value: it.g, min: 1, max: 20000, step: 10, onChange: (v) => { it.g = v; upd(); refresh(); } }), h('span', { class: 'muted small' }, 'g'), sub));
  };
  const drawIng = () => {
    clear(ingBox);
    if (!st.items.length) ingBox.append(h('div', { class: 'small muted' }, 'No ingredients yet. Search below and tap to add.'));
    st.items.forEach((it) => ingBox.append(ingRow(it)));
  };
  const find = h('input', { type: 'search', placeholder: 'Add ingredient: dal, rice, paneer…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Search ingredients' });
  const addIng = (f) => { st.items.push({ food: f, g: servingsOf(f)[0].g }); find.value = ''; clear(results); drawIng(); refresh(); find.focus(); };
  find.addEventListener('input', () => {
    clear(results);
    if (!find.value.trim()) return;
    const found = rawFirst(lookup(find.value, 14)).filter((f) => !existing || f.id !== existing.id).slice(0, 6);
    results.append(found.length ? h('div', { class: 'list' }, found.map((f) => h('button', { class: 'list-item', onClick: () => addIng(f) },
      h('div', { class: 'grow' }, h('div', { class: 'title' }, f.name), h('div', { class: 'sub' }, `${servingsOf(f)[0].g} g to start · ${fmt(f.per100.kcal)} kcal per 100 g`)), icon('plus', 18)))) : h('div', { class: 'small muted' }, 'No match. Try another word.'));
  });
  cookedIn.addEventListener('input', () => { st.cooked = num(cookedIn); refresh(); });
  makesIn.addEventListener('input', () => { st.makes = num(makesIn); refresh(); });
  const content = h('div', { class: 'stack' },
    field('Recipe name', name),
    field('Ingredients (raw weight, grams)', h('div', { class: 'stack' }, ingBox, h('div', { class: 'search' }, icon('search'), find), results)),
    field('Oil or ghee used in the pot', h('div', { class: 'stack' },
      segmented([{ id: 'oil', label: 'Oil' }, { id: 'ghee', label: 'Ghee' }], st.fat, (id) => { st.fat = id; refresh(); }),
      h('div', { class: 'fd-step' }, stepper({ value: st.oil, min: 0, max: 10, step: 0.5, onChange: (v) => { st.oil = v; refresh(); } }), h('span', { class: 'muted small' }, 'tsp'))), 'Oil is 40 kcal per tsp, ghee 45.'),
    h('div', { class: 'grid-2' }, field('Cooked weight (g)', cookedIn), field('Or makes (katoris)', makesIn)),
    note,
    h('div', { class: 'fd-sub' }, 'Whole pot'), pot.el, h('div', { class: 'fd-sub' }, 'Per katori (150 g)'), kat.el);
  drawIng(); refresh();
  const save = (api) => {
    const nm = name.value.trim(), c = cookedG();
    if (!nm) { toast('Name your recipe'); return; }
    if (!st.items.length) { toast('Add at least one ingredient'); return; }
    if (!(c > 0)) { toast('Enter the cooked weight or how many katoris'); return; }
    const food = buildRecipeFood({ name: nm, items: st.items, oilTsp: st.oil, fat: st.fat, cooked: c, makes: st.cooked > 0 ? null : st.makes });
    api.close();
    if (existing) { replaceCustom(existing.id, food); toast('Recipe updated'); } else openFoodSheet(addCustomFood(food));
  };
  showSheet({ title: existing ? 'Edit recipe' : 'Build a recipe', content, actions: (api) => [btn('', 'Cancel', api.close), btn('primary', 'Save recipe', () => save(api))] });
}

// ---- text quick-log: "2 roti, 1 katori dal, chai" ----
function applyFood(row, food) {
  const r = resolveUnit(food, row.p, measures());
  Object.assign(row, { food, qty: r.qty, unitIdx: r.idx, oil: 0 });
}
function makeRow(p) {
  const row = { raw: p.raw, p, food: null, qty: 1, unitIdx: 0, oil: 0 };
  if (p.matches[0]) applyFood(row, p.matches[0]);
  return row;
}
const rowEntry = (row, meal = 'snacks') => buildEntry(row.food, { qty: row.qty, unit: unitsOf(row.food)[row.unitIdx], meal, oilTsp: row.oil });

function reparse() {
  const prev = new Map(textRows.map((r) => [r.raw, r])); // keep edits for unchanged parts
  textRows = splitParts(textQuery).map((raw) => prev.get(raw) || makeRow(parsePart(raw)));
  paintText();
}

function drawRow(el, row) {
  clear(el);
  el.classList.toggle('miss', !row.food);
  const sum1 = h('div', { class: 'fd-trow-sum' });
  const upd = () => { if (row.food) { const e = rowEntry(row); sum1.textContent = `${fmt(e.kcal)} kcal · ${fmt(e.p, 1)} g protein`; } };
  upd();
  el.append(h('div', { class: 'fd-trow-top' },
    h('button', { class: 'fd-trow-name', onClick: () => openPickSheet(row) },
      h('span', { class: 'title' }, row.food ? row.food.name : 'Not found — tap to search'),
      h('span', { class: 'sub' }, row.food ? 'Tap to pick another match' : `“${row.p.rest || row.raw}”`)),
    row.food ? sum1 : null));
  if (!row.food) return;
  const units = unitsOf(row.food), gm = isGrams(units[row.unitIdx]);
  const sel = h('select', { class: 'fd-unit', 'aria-label': 'Unit' }, units.map((u, i) => h('option', { value: i, selected: i === row.unitIdx }, isGrams(u) ? 'grams' : u.label)));
  sel.addEventListener('change', () => { const to = +sel.value; row.qty = convertQty(row.qty, units[row.unitIdx], units[to]); row.unitIdx = to; drawRow(el, row); });
  el.append(h('div', { class: 'fd-step' }, stepper({ value: row.qty, min: gm ? 10 : 0.5, max: gm ? 5000 : 50, step: gm ? 10 : 0.5, onChange: (v) => { row.qty = v; upd(); } }), sel));
  if (OIL_CATS.has(row.food.cat)) {
    el.append(h('div', { class: 'fd-step fd-oilrow' }, h('span', { class: 'small muted' }, 'Oil or ghee (tsp)'), stepper({ value: row.oil, min: 0, max: 5, step: 0.5, onChange: (v) => { row.oil = v; upd(); } })));
  }
}

function paintText() {
  const box = slots.text;
  clear(box);
  if (!textRows.length) { box.append(emptyState('Type it like you say it', 'Try: 2 roti, 1 katori dal, chai. Separate items with commas.')); return; }
  const n = textRows.filter((r) => r.food).length, miss = textRows.length - n;
  const logBtn = btn('primary block', `Log ${plural(n, 'item')}`, logText);
  logBtn.disabled = !n;
  box.append(
    h('div', { class: 'fd-textmeal' }, segmented(MEALS.map(({ id, label }) => ({ id, label })), textMeal || mealByTime(), (id) => { textMeal = id; }, 'fd-meals'), h('div', { class: 'hint small muted' }, 'Drinks go to Drinks unless you pick a meal.')),
    h('div', { class: 'stack' }, textRows.map((row) => { const el = h('div', { class: 'fd-trow' }); drawRow(el, row); return el; })),
    h('div', { class: 'fd-logbar' }, miss ? h('div', { class: 'small muted' }, `${miss} not found. Tap it to search.`) : null, logBtn));
}

function logText() {
  const date = C.date, rows = textRows.filter((r) => r.food);
  if (!rows.length) return;
  const made = logFoods(date, rows.map((r, i) => { const meal = textMeal || defaultMeal(r.food); return { ...rowEntry(r, meal), ...tsFor(date, meal, i) }; }));
  textQuery = ''; textRows = []; textMeal = null; slots.input.value = '';
  paintText(); haptic();
  undoToast(`Logged ${plural(made.length, 'item')}`, date, made.map((e) => e.id));
}

// Pick a different food for a parsed row (or search when nothing matched).
function openPickSheet(row) {
  const input = h('input', { type: 'search', value: row.p.rest || row.raw, placeholder: 'Search foods', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'list' });
  const draw = () => {
    clear(list);
    const found = lookup(input.value, 8);
    if (!found.length) { list.append(h('div', { class: 'empty' }, 'No match. Try another word.')); return; }
    found.forEach((f) => { const sv = servingsOf(f)[0]; list.append(h('button', { class: 'list-item', onClick: () => { api.close(); applyFood(row, f); paintText(); } }, h('div', { class: 'grow' }, h('div', { class: 'title' }, f.name), h('div', { class: 'sub' }, `${sv.label} · ${fmt(scaleFood(f, sv.g).kcal)} kcal`)))); });
  };
  input.addEventListener('input', draw);
  const api = showSheet({ title: 'Pick a food', content: h('div', { class: 'stack' }, h('div', { class: 'search' }, icon('search'), input), list) });
  draw();
}

// ---- view chrome ----
function setView(v) { view = v; applyView(); }
function applyView() {
  slots.addPane.classList.toggle('hide', view !== 'add');
  slots.diary.classList.toggle('hide', view !== 'diary');
  setActive(slots.seg, view);
}
function applyMode() {
  slots.browse.classList.toggle('hide', textMode);
  slots.text.classList.toggle('hide', !textMode);
}
function setTextMode(on) {
  textMode = on;
  slots.input.value = on ? textQuery : query;
  slots.input.placeholder = on ? TEXT_PH : SEARCH_PH;
  slots.kb.classList.toggle('on', on); slots.kb.setAttribute('aria-pressed', on ? 'true' : 'false');
  applyMode();
  if (on) paintText();
}

function header() {
  const { date, today } = C;
  const label = fmtDateLabel(date, today);
  return h('div', { class: 'fd-head' },
    h('h1', null, 'Food'),
    h('div', { class: 'date-nav fd-nav' },
      h('button', { class: 'icon-btn', 'aria-label': 'Previous day', onClick: () => C.setDate(shiftDate(date, -1)) }, icon('left')),
      h('div', { class: 'label' }, label, label === 'Today' || label === 'Yesterday' ? h('small', null, fmtShortDate(date)) : null),
      h('button', { class: 'icon-btn', 'aria-label': 'Next day', disabled: date >= today, onClick: () => C.setDate(shiftDate(date, 1)) }, icon('right'))));
}

function searchPane() {
  let timer = null;
  const input = h('input', { type: 'search', placeholder: textMode ? TEXT_PH : SEARCH_PH, value: textMode ? textQuery : query, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: textMode ? 'done' : 'search', 'aria-label': 'Search foods' });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (textMode) { textQuery = input.value; reparse(); } else { query = input.value; paintResults(); } }, 120);
  });
  slots.input = input;
  slots.kb = h('button', { class: 'icon-btn fd-kb' + (textMode ? ' on' : ''), 'aria-label': 'Type your meal in words', 'aria-pressed': textMode ? 'true' : 'false', onClick: () => { setTextMode(!textMode); slots.input.focus(); } }, kbIcon());
  if (!chipOptions().some((o) => o.id === cat)) cat = 'all';
  slots.chips = makeChips(); slots.chipIds = chipOptions().map((o) => o.id).join('|');
  requestAnimationFrame(() => showActiveChip(slots.chips));
  slots.browse = h('div', null, slots.chips,
    h('div', { class: 'fd-actions' },
      btn('', [icon('plus', 16), 'Quick add'], () => openQuickSheet()),
      btn('', [icon('plus', 16), 'Create food'], () => openCreateSheet(query.trim())),
      btn('fd-wide', [icon('bowl', 16), 'Build a recipe'], () => openRecipeSheet())),
    slots.results);
  slots.text = h('div', { class: 'fd-text' });
  return h('div', null, h('div', { class: 'fd-searchrow' }, h('div', { class: 'search' }, icon('search'), input), slots.kb), slots.browse, slots.text);
}

function paint() { syncChips(); paintSummary(); paintResults(); paintDiary(); applyView(); }

// One-shot per navigation (ctx.params keeps the same identity until go() is called again).
function applyParams(p) {
  if (!p || p === seenParams) return false;
  seenParams = p;
  if (typeof p.q === 'string') query = p.q;
  if (p.view === 'diary' || p.view === 'add') view = p.view;
  return true;
}

export function render(container, ctx) {
  C = ctx;
  const fresh = applyParams(ctx.params);
  slots = { summary: h('div'), results: h('div', { class: 'fd-results' }), diary: h('div', { class: 'fd-diary' }), chips: null, chipIds: '', input: null, kb: null, browse: null, text: null, seg: null, addPane: null };
  slots.seg = segmented([{ id: 'add', label: 'Add food' }, { id: 'diary', label: 'Diary' }], view, setView, 'fd-view');
  slots.addPane = h('div', { class: 'fd-pane' });
  slots.addPane.append(searchPane());
  container.append(h('div', { class: 'fd' }, header(), slots.summary, slots.seg, slots.addPane, slots.diary));
  paint(); applyMode(); paintText();
  if (fresh && ctx.params.quick) openQuickSheet();
  return paint;
}
