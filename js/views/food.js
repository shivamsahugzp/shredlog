// Food tab: compact summary + search and log foods, diary by meal (swipe to delete, copy / repeat a meal), quantity sheet,
// quick add, recipes, text quick-log, starter plates. Entry fields and state keys are unchanged (see docs/design.md, data safety).
import {
  state, dayIfAny, dayTotals, commit, shiftDate, parseKey, findFood, searchFoods, recentFoods, frequentFoods, allFoods, lastNDays,
  toggleFav, logFood, logFoods, removeFood, removeFoods, setPartial, updateFood, addCustomFood, removeCustomFood,
  addSavedMeal, removeSavedMeal,
} from '../state.js';
import {
  h, icon, sheet, toast, stepper, chips, segmented, field, toggle, clear, setActive, promptSheet, ring, longPress,
  fmt, fmtDateLabel, fmtShortDate, fmtTime, haptic,
} from '../ui.js';
import { countUp, odometer, fill, pop, pulse, stagger, quiet, swipeReveal, seen, prefersReducedMotion } from '../motion.js';
import { scaleFood } from '../calc.js';
import {
  MEALS, MEAL_LABEL, OIL_CATS, OIL_KCAL, OIL_FAT, RECIPE_CAT, r1, r2, servingsOf, unitsOf, isGrams, convertQty,
  buildEntry, measuresLine, measuresMap, lookup, buildRecipeFood, recipeTotals, splitParts, parsePart, resolveUnit,
  PRESETS, resolvePreset, STAPLE_IDS, shortCat, SPOTS, segFix, tidyName, coachCard, targetsSheet, gradientRing,
} from './food-extras.js';
import { openScanner, openPacketScanner, cameraIcon } from './food-scan.js';

const seg = (options, value, onChange, cls) => segFix(segmented(options, value, onChange, cls), options, value);

// ---- constants ----
const MAX_RESULTS = 60;
const POOLS = [
  { id: '@recent', label: 'Recent' }, { id: '@staples', label: 'Staples' }, { id: '@protein', label: 'High protein' }, { id: 'all', label: 'All' },
  { id: '@frequent', label: 'Frequent' }, { id: '@fav', label: 'Favourites' }, { id: '@mine', label: 'My foods' }, { id: '@meals', label: 'Saved meals' },
];
const BROWSE = new Set(['@recent', '@staples', '@frequent']); // typing a search leaves these and looks through every food
const SEARCH_PH = 'Search dal, paneer, biryani…', TEXT_PH = 'e.g. 2 roti, 1 katori dal, chai';

// ---- module state (survives re-renders) ----
let query = '';
let cat = null; // null until the first render picks Recent (or Staples when nothing was logged yet)
let restoreCat = null; // the browse pool to come back to when the search box is cleared
let view = 'add'; // 'add' | 'diary'
let textMode = false; // "type it like you say it"
let textQuery = '';
let textRows = [];
let textMeal = null; // null = time rule (drinks stay in Drinks)
let activeSheet = null;
let seenParams = null;
let pendingEdit = null; // {id, date}: Today asked to edit an entry
let pendingDate = null;
let justLogged = { ids: new Set(), foodIds: new Set(), at: 0 };
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
const lc = (s) => String(s).toLowerCase();

function mealByTime(d = new Date()) { const hr = d.getHours(); return hr < 11 ? 'breakfast' : hr < 16 ? 'lunch' : hr < 19 ? 'snacks' : 'dinner'; }
const defaultMeal = (food) => (food?.cat === 'Beverages' ? 'drinks' : mealByTime());
const mealForItem = (it) => (it.cat === 'Beverages' || it.meal === 'drinks' ? 'drinks' : mealByTime());
const defaultCat = () => (recentFoods(1).length ? '@recent' : '@staples');

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

// Scroll a chip strip so its active chip is fully in view (with a peek of the chip before it).
function showActiveChip(el) {
  const on = el && el.querySelector('.on');
  if (!on || !el.isConnected) return;
  const c = el.getBoundingClientRect(), r = on.getBoundingClientRect();
  if (r.left < c.left + 8 || r.right > c.right - 44) el.scrollLeft = Math.max(0, el.scrollLeft + r.left - c.left - 28); // only when it is not already fully visible
}

const spot = (kind) => h('span', { class: 'spot fd-spot', html: SPOTS[kind] || SPOTS.bowl });
// Empty state: one spot illustration, one sentence, one action.
const empty = (kind, title, sub, action) => h('div', { class: 'empty fd-empty' }, spot(kind), h('b', null, title), sub, action ? h('div', { class: 'fd-empty-act' }, action) : null);

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

// A successful log: success toast with Undo, and the row / summary acknowledge it.
function markLogged(entries) {
  justLogged = { ids: new Set(entries.map((e) => e.id)), foodIds: new Set(entries.map((e) => e.foodId).filter(Boolean)), at: Date.now() };
  requestAnimationFrame(() => requestAnimationFrame(flashLogged));
}
function loggedToast(msg, date, entries) {
  markLogged(entries);
  toast(msg, { ms: 4000, kind: 'success', undo: () => removeFoods(date, entries.map((e) => e.id)) });
}
function flashLogged() {
  if (!slots || Date.now() - justLogged.at > 8000) return;
  slots.results.querySelectorAll('.fd-row').forEach((el) => {
    if (!justLogged.foodIds.has(el.dataset.fid) || el.dataset.flash) return;
    el.dataset.flash = '1'; el.classList.add('fd-flash'); pop(el.querySelector('.fd-kc'));
    setTimeout(() => { el.classList.remove('fd-flash'); delete el.dataset.flash; }, 1400);
  });
  if (view === 'diary') slots.diary.querySelectorAll('.fd-erow').forEach((el) => { if (justLogged.ids.has(el.dataset.id) && !el.dataset.popped) { el.dataset.popped = '1'; pop(el.querySelector('.fd-kc')); el.classList.add('fd-flash'); setTimeout(() => el.classList.remove('fd-flash'), 1400); } });
  const n = slots.sum.querySelector('.fd-ln'); if (n && !prefersReducedMotion()) pulse(n, { scale: 1.08, ms: 360 });
}
function deleteEntry(date, entry) {
  const copy = { ...entry };
  removeFood(date, entry.id);
  toast(`Removed ${entry.name}`, { ms: 4000, undo: () => logFood(date, copy) });
}
const syncStar = (id, on) => { if (slots) slots.results.querySelectorAll(`.fd-row[data-fid="${id}"] .fd-star`).forEach((b) => { b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }); };

// ---- summary strip: "1,311 of 2,150 kcal · 839 left", then each macro as "x / y g" with what is still to go. Stays on screen while the list scrolls. ----
function paintSummary() {
  const t = dayTotals(C.date), T = state.targets || {};
  const has = T.kcal > 0, left = (T.kcal || 0) - t.kcal, over = has && left < -0.5;
  const pct = has ? Math.min(100, (t.kcal / T.kcal) * 100) : 0;
  const rg = ring({ size: 48, stroke: 6, pct, color: over ? 'var(--bad)' : 'var(--accent)', cls: 'fd-ring', children: h('span', { class: 'fd-pct' }, has ? Math.round((t.kcal / T.kcal) * 100) + '%' : String(t.n)) });
  if (!over) gradientRing(rg, 'fd-grad');
  rg.setAttribute('role', 'img'); rg.setAttribute('aria-label', has ? `${fmt(t.kcal)} of ${fmt(T.kcal)} kcal eaten, ${fmt(Math.abs(left))} ${over ? 'over' : 'left'}` : `${fmt(t.kcal)} kcal eaten`);
  fill(rg.fillEl, pct, { axis: 'ring', key: 'fd:ring', ms: seen('fd:ring') ? 500 : 900 });
  const n = h('b', { class: 'num fd-ln' });
  countUp(n, t.kcal, { key: 'fd:eaten', ms: 600, fmt: (v) => fmt(Math.round(v)) });
  const lft = h('b', { class: 'num' });
  countUp(lft, Math.abs(left), { key: 'fd:left', ms: 600, fmt: (v) => fmt(Math.round(v)) });
  const macs = [['p', 'Protein', t.p, T.p], ['c', 'Carbs', t.c, T.c], ['f', 'Fat', t.f, T.f], ['fiber', 'Fibre', t.fiber, T.fiber]].map(([k, label, eaten, target], i) => {
    const bar = h('i', { style: { background: `var(--${k})` } });
    fill(bar, target > 0 ? Math.min(100, (eaten / target) * 100) : 0, { key: 'fd:m:' + k, delay: i * 50, ms: 500 });
    const to = target > 0 ? Math.round(target - eaten) : null, done = to != null && to <= 0;
    const goTxt = to == null ? '' : !done ? `${fmt(to)} g to go` : k === 'p' || k === 'fiber' ? 'Done' : `${fmt(-to)} g over`;
    return h('div', { class: 'fd-mac', 'aria-label': target ? `${label} ${fmt(eaten, 0)} of ${fmt(target, 0)} grams${to != null ? (done ? ', reached' : `, ${fmt(to)} to go`) : ''}` : `${label} ${fmt(eaten, 0)} grams` },
      h('div', { class: 'fd-ml' }, h('i', { class: 'dot ' + k }), label),
      h('div', { class: 'fd-mv' }, h('b', { class: 'num' }, fmt(eaten, 0)), h('small', null, target ? ` / ${fmt(target, 0)} g` : ' g')),
      h('div', { class: 'fd-mbar' }, bar),
      h('div', { class: 'fd-mg' + (done ? (k === 'p' || k === 'fiber' ? ' hit' : ' over') : '') }, done && (k === 'p' || k === 'fiber') ? icon('check', 11) : null, goTxt));
  });
  clear(slots.sum);
  slots.sum.append(
    h('div', { class: 'fd-sum-top' }, rg,
      h('div', { class: 'fd-kc2' }, h('div', { class: 'fd-eat' }, n, h('span', { class: 'fd-of' }, has ? ` of ${fmt(T.kcal)} kcal` : ' kcal eaten')), has ? h('div', { class: 'fd-left' + (over ? ' over' : '') }, lft, over ? ' kcal over' : ' kcal left') : null),
      h('button', { class: 'chip fd-tchip', 'aria-label': 'How your targets are set', onClick: () => targetsSheet(C) }, icon('target', 15), 'Targets')),
    h('div', { class: 'fd-macs' }, macs));
  paintCoach();
}
// The coach, compact: one headline and a row of meals that fit what is left. Only for today; tapping a card opens it, + logs it.
function paintCoach() {
  const box = slots.nudge, keep = box.querySelector('.fd-co-cards')?.scrollLeft || 0;
  clear(box);
  const card = C.date === C.today ? coachCard(C, C.date, { compact: true }) : null;
  box.classList.toggle('hide', !card);
  if (!card) return;
  box.append(card);
  const sc = card.querySelector('.fd-co-cards'); if (sc && keep) sc.scrollLeft = keep;
}

// ---- search & results ----
const dietOk = (f, diet) => {
  const t = f.tags || [];
  if (!diet || diet === 'nonveg') return true;
  if (diet === 'vegan') return t.includes('vegan');
  if (diet === 'egg') return t.includes('veg') || t.includes('vegan') || t.includes('egg');
  return t.includes('veg') || t.includes('vegan');
};
// Most protein per calorie, for the diet in the profile.
function proteinFoods() {
  const diet = state.profile?.diet;
  return allFoods().filter((f) => f.cat !== 'Alcohol' && dietOk(f, diet)).map((f) => { const s = scaleFood(f, servingsOf(f)[0].g); return { f, p: s.p, r: s.p / Math.max(1, s.kcal) }; })
    .filter((x) => x.p >= 8 && x.r >= 0.07).sort((a, b) => b.r - a.r).slice(0, MAX_RESULTS).map((x) => x.f);
}
function poolFoods(c) {
  if (c === '@recent') return recentFoods(40);
  if (c === '@staples') return STAPLE_IDS.map(findFood).filter(Boolean);
  if (c === '@frequent') return frequentFoods(40);
  if (c === '@protein') return proteinFoods();
  if (c === '@fav') return state.favFoods.map(findFood).filter(Boolean);
  if (c === '@mine') return state.customFoods.slice().sort((a, b) => !!b.recipe - !!a.recipe); // recipes first
  return null;
}
// searchFoods ranks by name length, so "egg" put Egg White above Egg (boiled) and "poha" put the raw flakes above a plate of
// kanda poha. Within a search: names that start with what was typed first, then what the user eats (recent, favourite, staple),
// and raw / uncooked / powder entries last unless that is what was asked for.
const RAWISH = /\b(raw|uncooked|dry|powder)\b/i;
const plainName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
function rankSearch(list) {
  const q = plainName(query), first = q.split(' ')[0];
  if (!first || list.length < 2) return list;
  const known = new Set([...recentFoods(40).map((f) => f.id), ...state.favFoods, ...STAPLE_IDS]);
  const wantsRaw = RAWISH.test(query);
  const key = (f) => (plainName(f.name).startsWith(first) ? 0 : 10) + (known.has(f.id) ? 0 : 2) + (!wantsRaw && RAWISH.test(f.name) ? 4 : 0);
  return list.map((f, i) => [f, i, key(f)]).sort((a, b) => a[2] - b[2] || a[1] - b[1]).map((x) => x[0]);
}
function resultFoods() {
  const pool = poolFoods(cat);
  if (!pool) return rankSearch(searchFoods(query, cat === 'all' ? '' : cat, 1000));
  if (!query.trim()) return pool;
  const ids = new Set(pool.map((f) => f.id));
  return rankSearch(searchFoods(query, '', 1000).filter((f) => ids.has(f.id)));
}

// Name, then the category pill + serving; kcal and protein as condensed numbers on the right.
function rowBody(name, catLabel, serving, kcal, protein, extra) {
  return [
    h('span', { class: 'fd-info' }, h('span', { class: 'fd-name' }, name, extra), h('span', { class: 'fd-sub' }, catLabel ? h('span', { class: 'fd-cat' }, catLabel) : null, h('span', { class: 'fd-serv' }, serving))),
    h('span', { class: 'fd-nums' }, h('span', { class: 'fd-kc' }, h('b', { class: 'num' }, fmt(kcal)), ' kcal'), h('span', { class: 'fd-pr' }, h('b', { class: 'num' }, fmt(protein, 1)), ' g protein')),
  ];
}
function foodRow(f, fav) {
  const sv = servingsOf(f)[0], s = scaleFood(f, sv.g);
  const main = h('button', { class: 'fd-main fd-body', 'aria-label': `${f.name}, ${sv.label}, ${s.kcal} kcal, ${s.p} g protein`, onClick: () => openFoodSheet(f) }, rowBody(tidyName(f.name), shortCat(f), sv.label, s.kcal, s.p));
  if (f.recipe) longPress(main, () => openRecipeMenu(f));
  return h('div', { class: 'list-item fd-row', dataset: { fid: f.id } }, main,
    f.recipe ? h('button', { class: 'fd-more', 'aria-label': `More for ${f.name}`, onClick: () => openRecipeMenu(f) }, icon('more')) : null,
    h('button', {
      class: 'fd-star' + (fav ? ' on' : ''), 'aria-label': `Favourite ${f.name}`, 'aria-pressed': fav ? 'true' : 'false',
      onClick: (ev) => { const b = ev.currentTarget, on = toggleFav(f.id); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); if (on) { pop(b.firstChild); haptic(); } },
    }, icon('star', 22)));
}

function noResults() {
  const q = query.trim();
  if (q) {
    const meal = /\d/.test(q) || /\band\b|\+|&/i.test(q) ? btn('', [kbIcon(), 'Log it as a meal'], () => { textQuery = q.replace(/\s+(?=\d)/g, ', '); query = ''; if (restoreCat) { cat = restoreCat; restoreCat = null; setActive(slots.chips, cat); showActiveChip(slots.chips); } setTextMode(true); reparse(); paintResults(true); slots.input.focus(); }) : null;
    return empty('search', `No match for “${q}”`, 'Save it as your own food and it shows up here next time.', h('div', { class: 'row', style: { justifyContent: 'center', gap: '8px', flexWrap: 'wrap' } }, btn('primary', [icon('plus', 16), `Create “${q.length > 22 ? q.slice(0, 22) + '…' : q}”`], () => openCreateSheet(q)), meal));
  }
  if (cat === '@recent') return empty('bowl', 'No recent foods yet', 'Foods you log show up here first.', btn('', 'Browse staples', () => pickPool('@staples')));
  if (cat === '@frequent') return empty('bowl', 'Nothing frequent yet', 'Your most-logged foods land here after a few days.', btn('', 'Browse staples', () => pickPool('@staples')));
  if (cat === '@fav') return empty('star', 'No favourites yet', 'Tap the star on a food to keep it one tap away.', btn('', 'Browse staples', () => pickPool('@staples')));
  if (cat === '@mine') return empty('bowl', 'No foods of your own yet', 'Create a food or build a recipe to see it here.', btn('primary', 'Create food', () => openCreateSheet('')));
  return empty('bowl', 'Nothing here yet', 'Try another category.', btn('', 'Show everything', () => pickPool('all')));
}

const resultsSig = () => [cat, query.trim().toLowerCase(), state.customFoods.map((f) => f.id + f.per100.kcal).join(','), state.savedMeals.map((m) => m.id).join(','), cat === '@fav' ? state.favFoods.join(',') : ''].join('|');
function paintResults(force) {
  const sig = resultsSig();
  if (!force && slots.resSig === sig) return; // data changes (a log, a star) must not reshuffle the list under the thumb
  slots.resSig = sig;
  const box = slots.results;
  clear(box);
  if (cat === '@meals') { box.append(savedMealsPane()); return; }
  const list = resultFoods();
  if (!list.length) { box.append(noResults()); return; }
  const favs = new Set(state.favFoods);
  const el = h('div', { class: 'list fd-list' }, list.slice(0, MAX_RESULTS).map((f) => foodRow(f, favs.has(f.id))));
  box.append(el);
  if (list.length > MAX_RESULTS) box.append(h('div', { class: 'fd-note' }, `Showing ${MAX_RESULTS} of ${list.length}. Search or pick a category to narrow it down.`));
  stagger(el, { key: 'fd-results' });
}

// Pool + category chips: rebuilt only when the set changes (e.g. the first recipe adds "My recipes").
const chipOptions = () => POOLS.concat(categories().map((c) => ({ id: c, label: c })));
const makeChips = () => chips(chipOptions(), cat, (id) => { cat = id; restoreCat = null; paintResults(); });
function syncChips() {
  const ids = chipOptions().map((o) => o.id).join('|');
  if (slots.chipIds === ids) return;
  if (!chipOptions().some((o) => o.id === cat)) cat = defaultCat();
  const next = makeChips(), old = slots.chips;
  slots.chipIds = ids; slots.chips = next;
  if (old && old.isConnected) { old.replaceWith(next); next.scrollLeft = old.scrollLeft; }
}
function pickPool(id) {
  cat = id; restoreCat = null;
  if (slots.chips) { setActive(slots.chips, id); showActiveChip(slots.chips); }
  paintResults();
}

// ---- saved meals + starter plates ----
const subhead = (text) => h('div', { class: 'fd-subhead' }, text);
function savedMealsPane() {
  const q = query.trim().toLowerCase(), hit = (n) => !q || n.toLowerCase().includes(q);
  const presets = PRESETS.map(resolvePreset).filter((p) => p.items.length && hit(p.name));
  const meals = state.savedMeals.filter((m) => hit(m.name));
  return h('div', null,
    subhead('Your meals'),
    meals.length ? h('div', { class: 'list' }, meals.map(savedRow)) : empty('bowl', 'No saved meals yet', 'In your diary, tap Save as meal under any meal.', btn('', 'Open diary', () => setView('diary'))),
    presets.length ? [subhead('Starter plates'), h('div', { class: 'list' }, presets.map(presetRow))] : null);
}
function mealSub(items) { return `${plural(items.length, 'item')} · ${fmt(sum(items, 'kcal'))} kcal · ${fmt(sum(items, 'p'), 1)} g protein`; }
function presetRow(p) {
  return h('div', { class: 'list-item fd-mrow' },
    h('div', { class: 'grow' },
      h('div', { class: 'title ellipsis' }, p.name), h('div', { class: 'sub ellipsis' }, mealSub(p.items)),
      h('div', { class: 'sub ellipsis' }, p.items.map((i) => i.name).join(', ')),
      h('button', { class: 'fd-link', onClick: () => savePreset(p) }, 'Save as my meal')),
    btn('primary sm', 'Log', () => logItems(p.name, p.items)));
}
function savedRow(m) {
  return h('div', { class: 'list-item fd-mrow' },
    h('div', { class: 'grow' },
      h('div', { class: 'title ellipsis' }, m.name), h('div', { class: 'sub ellipsis' }, mealSub(m.items)),
      h('div', { class: 'sub ellipsis' }, m.items.map((i) => i.name).join(', '))),
    btn('primary sm', 'Log', () => logItems(m.name, m.items)),
    h('button', { class: 'icon-btn plain', 'aria-label': `Delete ${m.name}`, onClick: () => deleteSaved(m) }, icon('trash')));
}
// Re-log a set of snapshots for the selected day (meal by time rule, drinks stay in Drinks).
function logItems(name, items) {
  const date = C.date;
  const made = logFoods(date, items.map((it, i) => { const meal = mealForItem(it); return { ...stripIds(it), meal, ...tsFor(date, meal, i) }; }));
  haptic('success');
  loggedToast(`Logged ${name} · ${fmt(sum(made, 'kcal'))} kcal`, date, made);
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
  return h('button', { class: 'list-item fd-row fd-erow fd-body', dataset: { id: e.id }, 'aria-label': `${e.name}, ${e.kcal} kcal. Tap to edit, swipe to delete.`, onClick: () => openEntry(e) },
    rowBody(tidyName(e.name), e.ts ? fmtTime(e.ts) : '', unitText(e.qty ?? 1, e.unit), e.kcal, e.p));
}
const actChip = (ico, label, onClick, title) => h('button', { class: 'chip fd-actchip', title, onClick }, icon(ico, 15), label);

// Most recent earlier day (up to 30 days back) that has entries for this meal.
function lastMealBefore(meal, date) {
  for (let i = 1; i <= 30; i++) { const k = shiftDate(date, -i), items = mealEntries(k, meal); if (items.length) return { key: k, items }; }
  return null;
}
function mealGroup({ m, items, yest, last, prev }) {
  const name = lc(m.label), when = C.date === C.today ? 'yesterday’s' : 'previous day’s';
  const list = items.length ? h('div', { class: 'list fd-list' }, items.map(entryRow)) : null;
  if (list) items.forEach((e, i) => swipeReveal(list.children[i], { label: 'Delete', onAction: () => deleteEntry(C.date, e) }));
  const acts = [
    yest.length ? actChip('copy', `Copy ${when} ${name}`, () => copyEntries(m, yest, 'Copied')) : null,
    last && last.key !== prev ? actChip('reset', `Repeat last ${name}`, () => copyEntries(m, last.items, 'Repeated'), fmtShortDate(last.key)) : null,
    items.length ? actChip('plus', 'Save meal', () => saveMeal(m, items)) : null,
  ].filter(Boolean);
  return h('div', { class: 'fd-group' },
    h('div', { class: 'fd-ghead' }, h('h3', null, m.label),
      items.length ? h('span', { class: 'fd-gsum' }, h('b', { class: 'num' }, fmt(sum(items, 'kcal'))), ' kcal', h('span', { class: 'fd-gp' }, h('b', { class: 'num' }, fmt(sum(items, 'p'), 1)), ' g protein')) : h('span', { class: 'fd-gsum' }, 'Nothing yet')),
    list, acts.length ? h('div', { class: 'chips wrap fd-gacts' }, acts) : null);
}

const diarySig = () => {
  const d = C.date, prev = shiftDate(d, -1);
  return [d, state.savedMeals.map((m) => m.id + m.items.length).join(','), dayFood(prev).length,
    ...MEALS.map((m) => mealEntries(d, m.id).map((e) => [e.id, e.name, e.kcal, e.qty, e.unit?.label, e.meal].join(':')).join(','))].join('|');
};
function paintDiary(force) {
  const n = dayFood(C.date).length, tab = slots.seg.querySelector('[data-id="diary"]');
  if (tab) tab.textContent = n ? `Diary · ${n}` : 'Diary';
  const sig = diarySig();
  if (!force && slots.diarySig === sig) return;
  slots.diarySig = sig;
  const box = slots.diary, prev = shiftDate(C.date, -1);
  const groups = MEALS.map((m) => ({ m, items: mealEntries(C.date, m.id), yest: mealEntries(prev, m.id), last: lastMealBefore(m.id, C.date), prev }))
    .filter((g) => g.items.length || (g.m.id !== 'drinks' && (g.yest.length || g.last)));
  clear(box);
  if (groups.length) groups.forEach((g) => box.append(mealGroup(g)));
  else box.append(empty('bowl', 'Nothing logged yet', 'Search for a food, scan your plate, or use Quick add.', btn('primary', 'Find food', () => setView('add'))));
  box.append(quickMeals(), h('div', { class: 'card pad-s fd-partial' }, toggle(C.date === C.today ? "I didn't log everything today" : "I didn't log everything this day", !!dayIfAny(C.date)?.partial,
    (on) => setPartial(C.date, on), 'Keeps this day out of your calorie-burn estimate.')));
}

// Saved meals and starter plates as tappable cards.
function quickMeals() {
  const cards = state.savedMeals.slice(0, 8).map((m) => ({ name: m.name, items: m.items }))
    .concat(PRESETS.map(resolvePreset).filter((p) => p.items.length).slice(0, 6).map((p) => ({ name: p.name, items: p.items })));
  if (!cards.length) return null;
  return h('div', { class: 'fd-quick' },
    h('div', { class: 'section-head' }, h('h2', null, 'Log a saved meal'), h('button', { class: 'link', onClick: () => { setView('add'); pickPool('@meals'); } }, 'See all')),
    h('div', { class: 'chips fd-cards' }, cards.map((c) => h('button', { class: 'fd-card', onClick: () => logItems(c.name, c.items) },
      h('span', { class: 'fd-card-n' }, c.name),
      h('span', { class: 'fd-card-m' }, h('b', { class: 'num' }, fmt(sum(c.items, 'kcal'))), ' kcal'),
      h('span', { class: 'fd-card-p' }, h('b', { class: 'num' }, fmt(sum(c.items, 'p'), 0)), ' g protein'),
      h('span', { class: 'fd-card-go' }, icon('plus', 14), 'Log')))));
}

function copyEntries(m, from, verb) {
  const date = C.date;
  const made = logFoods(date, from.map((e, i) => ({ ...stripIds(e), meal: m.id, ...tsFor(date, m.id, i) })));
  haptic('success');
  loggedToast(`${verb} ${plural(made.length, 'item')} to ${m.label}`, date, made);
}
async function saveMeal(m, items) {
  const name = await promptSheet('Save as meal', m.label, { placeholder: 'Meal name' });
  if (!name) return;
  addSavedMeal({ name, items: items.map(stripIds) });
  toast(`Saved “${name}”`, { action: 'View', onAction: () => { setTextMode(false); setView('add'); pickPool('@meals'); } });
}
function openEntry(e) {
  const food = e.foodId && findFood(e.foodId);
  if (food) openFoodSheet(food, e); else openQuickSheet(e);
}

// ---- quantity sheet (add or edit) ----
// Live tiles. keys: which of kcal / p / c / f / fiber to show. kcal rolls like an odometer.
const TILE = { kcal: ['kcal', null], p: ['Protein', 'p'], c: ['Carbs', 'c'], f: ['Fat', 'f'], fiber: ['Fibre', 'fiber'] };
function previewTiles(keys = ['kcal', 'p', 'c', 'f'], cls = '') {
  const vals = {};
  const el = h('div', { class: `fd-prev n${keys.length} ${cls}` }, keys.map((k) => {
    const tile = h('div', { class: 'fd-tile' + (k === 'kcal' ? ' kcal' : '') }, h('div', { class: 'lbl' }, TILE[k][1] ? h('span', { class: 'dot ' + TILE[k][1] }) : null, TILE[k][0]), (vals[k] = h('div', { class: 'val' })));
    tile.style.setProperty('--tc', k === 'kcal' ? 'var(--accent)' : `var(--${TILE[k][1]})`);
    return tile;
  }));
  const set = (e) => keys.forEach((k) => {
    const v = vals[k];
    if (k === 'kcal') { if (!v.firstChild) { v.append(h('span', { class: 'num fd-odo' })); } odometer(v.firstChild, e.kcal, { fmt: (x) => fmt(x, 0) }); return; }
    clear(v); v.append(h('span', { class: 'num' }, fmt(e[k], 1)), h('small', null, ' g'));
  });
  return { el, set };
}

// The latest entry of this food in the last 45 days, so the sheet opens with "same as last time".
function lastEntryFor(foodId) {
  for (const k of lastNDays(45, C.today).reverse()) { const list = dayFood(k); for (let i = list.length - 1; i >= 0; i--) if (list[i].foodId === foodId) return list[i]; }
  return null;
}

function openFoodSheet(food, entry = null) {
  const date = C.date, units = unitsOf(food);
  const st = { unit: 0, qty: 1, meal: defaultMeal(food), oil: 0 };
  const seed = entry || lastEntryFor(food.id);
  if (seed && seed.unit && seed.unit.g > 0) {
    let i = units.findIndex((u) => u.label === seed.unit.label && u.g === seed.unit.g);
    if (i < 0) { units.unshift({ ...seed.unit }); i = 0; }
    Object.assign(st, { unit: i, qty: seed.qty || 1, oil: seed.oilTsp || 0 });
  }
  if (entry) st.meal = mealOf(entry);
  const unit = () => units[st.unit];
  const cur = () => buildEntry(food, { qty: st.qty, unit: unit(), meal: st.meal, oilTsp: st.oil });
  const prev = previewTiles(), note = h('span', { class: 'fd-grams' }), qtyBox = h('div', { class: 'fd-qty' });
  const gramsHint = h('div', { class: 'hint' });
  const multEl = h('div', { class: 'fd-mult', role: 'group', 'aria-label': 'Quick amounts' });
  let primary = null;
  const mults = [[0.5, '½'], [1, '1'], [1.5, '1½'], [2, '2']];
  const base = () => (isGrams(unit()) ? 100 : 1);
  const refresh = () => {
    const e = cur(); prev.set(e); note.textContent = isGrams(unit()) ? '' : `≈ ${fmt(e.g, 0)} g`;
    [...multEl.children].forEach((b, i) => b.classList.toggle('on', Math.abs(st.qty - mults[i][0] * base()) < 1e-6));
  };
  const drawQty = () => {
    const gm = isGrams(unit());
    clear(qtyBox);
    qtyBox.append(stepper({ value: st.qty, min: gm ? 10 : 0.5, max: gm ? 5000 : 50, step: gm ? 10 : 0.5, onChange: (v) => { st.qty = v; refresh(); } }), note);
    gramsHint.textContent = gm ? measuresLine(state.data.knowledge?.indianMeasures) : '';
    gramsHint.classList.toggle('hide', !gm);
  };
  mults.forEach(([m, label]) => multEl.append(h('button', { class: 'chip fd-m', 'aria-label': `${label} times`, onClick: () => { st.qty = m * base(); drawQty(); refresh(); haptic(); pulse(qtyBox.querySelector('input'), { scale: 1.1, ms: 260 }); } }, label + '×')));
  const pick = (id) => { const from = unit(); st.unit = +id; st.qty = convertQty(st.qty, from, unit()); drawQty(); refresh(); };
  const unitChips = chips(units.map((u, i) => ({ id: String(i), label: u.label })), String(st.unit), pick);
  unitChips.classList.add('wrap', 'fd-units'); unitChips.setAttribute('role', 'group'); unitChips.setAttribute('aria-label', 'Serving'); // wrap, so every serving label stays fully readable
  const oilField = OIL_CATS.has(food.cat)
    ? h('div', { class: 'fd-oil' }, h('span', { class: 'well chai' }, icon('oil', 20)), h('div', { class: 'grow' }, h('div', { class: 'strong' }, 'Oil or ghee (tsp)'), h('div', { class: 'small muted' }, `+${OIL_KCAL} kcal per tsp`)),
      stepper({ value: st.oil, min: 0, max: 5, step: 0.5, onChange: (v) => { st.oil = v; refresh(); } }))
    : null;
  const mealSeg = seg(MEALS.map(({ id, label }) => ({ id, label })), st.meal, (id) => { st.meal = id; if (primary && !entry) primary.textContent = `Log to ${MEAL_LABEL[id]}`; }, 'fd-meals');
  const links = !entry && (food.recipe || food.custom) ? h('div', { class: 'fd-links' },
    food.recipe ? h('button', { class: 'fd-link', onClick: () => openRecipeSheet(food) }, 'Edit recipe') : null,
    h('button', { class: 'fd-link fd-danger', onClick: () => deleteCustom(food, s) }, food.recipe ? 'Delete this recipe' : 'Delete this custom food')) : null;
  const star = h('button', { class: 'icon-btn plain fd-sheetstar' + (state.favFoods.includes(food.id) ? ' on' : ''), 'aria-label': 'Favourite', onClick: (ev) => { const on = toggleFav(food.id); ev.currentTarget.classList.toggle('on', on); syncStar(food.id, on); pop(ev.currentTarget.firstChild); haptic(); } }, icon('star', 22));
  const content = h('div', { class: 'stack fd-qsheet' },
    h('div', { class: 'fd-qhead' }, h('span', { class: 'pill fd-pillcat' }, shortCat(food)), h('span', { class: 'fd-per' }, `per 100 g: ${fmt(food.per100.kcal)} kcal, ${fmt(food.per100.p, 1)} g protein`), star),
    !entry && seed ? h('div', { class: 'fd-last' }, icon('clock', 14), `Same as last time: ${unitText(seed.qty ?? 1, seed.unit)}`) : null,
    prev.el,
    h('div', { class: 'stack' }, qtyBox, multEl, gramsHint),
    unitChips,
    oilField, mealSeg, links);
  drawQty(); refresh();
  const s = showSheet({
    title: food.name, content,
    actions: (api) => (entry ? [
      btn('danger', [icon('trash', 18), 'Delete'], () => { api.close(); deleteEntry(date, entry); }),
      btn('primary', 'Save changes', () => { api.close(); updateFood(date, entry.id, cur()); toast('Saved', { kind: 'success' }); }),
    ] : [(primary = btn('primary', `Log to ${MEAL_LABEL[st.meal]}`, () => {
      api.close();
      const e = logFood(date, { ...cur(), ...tsFor(date, st.meal) });
      haptic('success'); loggedToast(`Logged ${food.name} · ${fmt(e.kcal)} kcal`, date, [e]);
    }))]),
  });
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
  kcal.classList.add('fd-bigin');
  const p = numInput('0', pre(entry?.p)), c = numInput('0', pre(entry?.c)), f = numInput('0', pre(entry?.f));
  let primary = null;
  const valid = () => { if (primary) primary.disabled = !(num(kcal) > 0); };
  kcal.addEventListener('input', valid);
  const fields = () => ({ name: name.value.trim() || 'Quick add', kcal: Math.round(num(kcal)), p: r1(num(p)), c: r1(num(c)), f: r1(num(f)), meal });
  const content = h('div', { class: 'stack' },
    field('Name', name), field('Calories (kcal)', kcal, 'Required. Everything else is optional.'),
    h('div', { class: 'grid-3 fd-macin' }, field('Protein (g)', p), field('Carbs (g)', c), field('Fat (g)', f)),
    field('Meal', seg(MEALS.map(({ id, label }) => ({ id, label })), meal, (id) => { meal = id; if (primary && !entry) primary.textContent = `Log to ${MEAL_LABEL[id]}`; }, 'fd-meals')));
  showSheet({
    title: entry ? 'Edit entry' : 'Quick add', content,
    actions: (api) => {
      if (entry) {
        primary = btn('primary', 'Save changes', () => { api.close(); updateFood(date, entry.id, fields()); toast('Saved', { kind: 'success' }); });
        return [btn('danger', [icon('trash', 18), 'Delete'], () => { api.close(); deleteEntry(date, entry); }), primary];
      }
      primary = btn('primary', `Log to ${MEAL_LABEL[meal]}`, () => {
        api.close();
        const e = logFood(date, { foodId: null, cat: 'Quick add', qty: 1, unit: { label: 'Quick add', g: 0 }, g: 0, fiber: 0, sugar: 0, micro: null, triggers: [], oilTsp: 0, ...fields(), ...tsFor(date, meal) });
        haptic('success'); loggedToast(`Logged ${e.name} · ${fmt(e.kcal)} kcal`, date, [e]);
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
    seg([{ id: 'serving', label: 'Per serving' }, { id: 'per100', label: 'Per 100 g' }], mode, setMode),
    h('div', { class: 'grid-2' }, field('Serving name', label), field('Serving size (g)', grams)),
    head, hint,
    h('div', { class: 'grid-2' }, field('Calories (kcal)', v.kcal), field('Protein (g)', v.p), field('Carbs (g)', v.c), field('Fat (g)', v.f), field('Fibre (g)', v.fiber)));
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
  const note = h('div', { class: 'small muted' }), pot = previewTiles(['kcal', 'p', 'c', 'f']), kat = previewTiles(['kcal', 'p', 'c', 'f']);
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
      h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, f.name), h('div', { class: 'sub' }, `${servingsOf(f)[0].g} g to start · ${fmt(f.per100.kcal)} kcal per 100 g`)), icon('plus', 18)))) : h('div', { class: 'small muted' }, 'No match. Try another word.'));
  });
  cookedIn.addEventListener('input', () => { st.cooked = num(cookedIn); refresh(); });
  makesIn.addEventListener('input', () => { st.makes = num(makesIn); refresh(); });
  const content = h('div', { class: 'stack' },
    field('Recipe name', name),
    field('Ingredients (raw weight, grams)', h('div', { class: 'stack' }, ingBox, h('div', { class: 'search' }, icon('search'), find), results)),
    field('Oil or ghee used in the pot', h('div', { class: 'stack' },
      seg([{ id: 'oil', label: 'Oil' }, { id: 'ghee', label: 'Ghee' }], st.fat, (id) => { st.fat = id; refresh(); }),
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
    if (existing) { replaceCustom(existing.id, food); toast('Recipe updated', { kind: 'success' }); } else openFoodSheet(addCustomFood(food));
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
  const upd = () => { if (row.food) { const e = rowEntry(row); clear(sum1); sum1.append(h('b', { class: 'num' }, fmt(e.kcal)), ' kcal', h('div', { class: 'fd-pr' }, h('b', { class: 'num' }, fmt(e.p, 1)), ' g protein')); } };
  upd();
  el.append(h('div', { class: 'fd-trow-top' },
    h('button', { class: 'fd-trow-name', onClick: () => openPickSheet(row) },
      h('span', { class: 'title' }, row.food ? row.food.name : 'Not found. Tap to search'),
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
  if (!textRows.length) { box.append(empty('bowl', 'Type it like you say it', 'Try 2 roti, 1 katori dal, chai. Separate items with commas.')); return; }
  const n = textRows.filter((r) => r.food).length, miss = textRows.length - n;
  const logBtn = btn('primary block lg', `Log ${plural(n, 'item')}`, logText);
  logBtn.disabled = !n;
  box.append(
    h('div', { class: 'fd-textmeal' }, seg(MEALS.map(({ id, label }) => ({ id, label })), textMeal || mealByTime(), (id) => { textMeal = id; }, 'fd-meals'), h('div', { class: 'hint small muted' }, 'Drinks go to Drinks unless you pick a meal.')),
    h('div', { class: 'stack' }, textRows.map((row) => { const el = h('div', { class: 'fd-trow' }); drawRow(el, row); return el; })),
    h('div', { class: 'fd-logbar mo-sticky glass' }, miss ? h('div', { class: 'small muted' }, `${miss} not found. Tap it to search.`) : null, logBtn));
}

function logText() {
  const date = C.date, rows = textRows.filter((r) => r.food);
  if (!rows.length) return;
  const made = logFoods(date, rows.map((r, i) => { const meal = textMeal || defaultMeal(r.food); return { ...rowEntry(r, meal), ...tsFor(date, meal, i) }; }));
  textQuery = ''; textRows = []; textMeal = null; slots.input.value = '';
  paintText(); haptic('success');
  loggedToast(`Logged ${plural(made.length, 'item')} · ${fmt(sum(made, 'kcal'))} kcal`, date, made);
}

// Pick a different food for a parsed row (or search when nothing matched).
function openPickSheet(row) {
  const input = h('input', { type: 'search', value: row.p.rest || row.raw, placeholder: 'Search foods', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
  const list = h('div', { class: 'list' });
  const draw = () => {
    clear(list);
    const found = lookup(input.value, 8);
    if (!found.length) { list.append(h('div', { class: 'empty' }, 'No match. Try another word.')); return; }
    found.forEach((f) => { const sv = servingsOf(f)[0]; list.append(h('button', { class: 'list-item', onClick: () => { api.close(); applyFood(row, f); paintText(); } }, h('div', { class: 'grow' }, h('div', { class: 'title ellipsis' }, f.name), h('div', { class: 'sub' }, `${sv.label} · ${fmt(scaleFood(f, sv.g).kcal)} kcal`)))); });
  };
  input.addEventListener('input', draw);
  const api = showSheet({ title: 'Pick a food', content: h('div', { class: 'stack' }, h('div', { class: 'search' }, icon('search'), input), list) });
  draw();
}

// ---- view chrome ----
function setView(v) { view = v; applyView(); if (v === 'diary') requestAnimationFrame(flashLogged); }
function applyView() {
  slots.addPane.classList.toggle('hide', view !== 'add');
  slots.diary.classList.toggle('hide', view !== 'diary');
  setActive(slots.seg, view);
  if (view === 'diary') stagger(slots.diary, { key: 'fd-diary' }); // first time the diary is shown
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
    timer = setTimeout(() => {
      if (textMode) { textQuery = input.value; reparse(); return; }
      // "2 roti, 1 katori dal" typed into the search box is a meal, not a food name: read it as one instead of "No match"
      if (/[,;]/.test(input.value) && splitParts(input.value).length > 1) {
        textQuery = input.value; query = '';
        if (restoreCat) { cat = restoreCat; restoreCat = null; setActive(slots.chips, cat); showActiveChip(slots.chips); }
        paintResults(); setTextMode(true); reparse(); return;
      }
      query = input.value;
      const searching = !!query.trim();
      // Recent / Staples / Frequent are shortcuts for an empty box; typing looks through every food.
      if (searching && BROWSE.has(cat)) { restoreCat = cat; cat = 'all'; setActive(slots.chips, cat); }
      else if (!searching && restoreCat) { cat = restoreCat; restoreCat = null; setActive(slots.chips, cat); showActiveChip(slots.chips); }
      paintResults();
    }, 120);
  });
  slots.input = input;
  slots.kb = h('button', { class: 'icon-btn fd-kb' + (textMode ? ' on' : ''), 'aria-label': 'Type your meal in words', 'aria-pressed': textMode ? 'true' : 'false', onClick: () => { setTextMode(!textMode); slots.input.focus(); } }, kbIcon());
  if (!chipOptions().some((o) => o.id === cat)) cat = defaultCat();
  slots.chips = makeChips(); slots.chipIds = chipOptions().map((o) => o.id).join('|');
  requestAnimationFrame(() => showActiveChip(slots.chips));
  const acts = h('div', { class: 'chips wrap fd-acts' },
    h('button', { class: 'chip accent on fd-scan', onClick: () => openScanner(C, { date: C.date, meal: mealByTime() }) }, cameraIcon(16), 'Scan'),
    h('button', { class: 'chip fd-scan-packet', onClick: () => openPacketScanner(C, { date: C.date, meal: mealByTime() }) }, icon('scan', 16), 'Scan a packet'),
    h('button', { class: 'chip', onClick: () => openQuickSheet() }, 'Quick add'),
    h('button', { class: 'chip', onClick: () => openCreateSheet(query.trim()) }, 'Create'),
    h('button', { class: 'chip', onClick: () => openRecipeSheet() }, 'Recipe'));
  slots.browse = h('div', { class: 'fd-browse' }, slots.nudge, slots.chips, slots.results);
  slots.text = h('div', { class: 'fd-text' });
  return h('div', null, h('div', { class: 'fd-searchrow' }, h('div', { class: 'search' }, icon('search'), input), slots.kb), acts, slots.browse, slots.text);
}

function paint() { syncChips(); paintSummary(); paintResults(); paintDiary(); applyView(); applyMode(); }
const update = () => quiet(paint); // a redraw caused by data changing is quiet: nothing replays

// One-shot per navigation (ctx.params keeps the same identity until go() is called again).
function applyParams(p) {
  if (!p || p === seenParams) return false;
  seenParams = p;
  query = typeof p.q === 'string' ? p.q : '';
  cat = null; restoreCat = null; textMode = false; textQuery = ''; textRows = []; textMeal = null;
  view = p.view === 'diary' ? 'diary' : 'add';
  pendingEdit = p.edit ? { id: p.edit, date: p.date || null } : null;
  pendingDate = !p.edit && p.date ? p.date : null;
  return true;
}
// Today opens an entry for editing: switch to its day first (that re-renders), then open the sheet.
function consumePending() {
  if (pendingDate) { const d = pendingDate; pendingDate = null; if (d !== C.date && d <= C.today) { C.setDate(d); return; } }
  if (!pendingEdit) return;
  const { id, date } = pendingEdit, want = date || C.date;
  if (want !== C.date) { C.setDate(want); return; }
  pendingEdit = null;
  const e = dayFood(want).find((x) => x.id === id);
  if (!e) { toast('That entry is no longer there'); return; }
  view = 'diary'; applyView(); openEntry(e);
}

export function render(container, ctx) {
  C = ctx;
  const fresh = applyParams(ctx.params);
  if (cat == null) { cat = defaultCat(); if (query.trim() && BROWSE.has(cat)) { restoreCat = cat; cat = 'all'; } }
  slots = { sum: h('div', { class: 'fd-sum glass' }), nudge: h('div', { class: 'fd-nudgebox' }), results: h('div', { class: 'fd-results' }), diary: h('div', { class: 'fd-diary' }), chips: null, chipIds: '', input: null, kb: null, browse: null, text: null, seg: null, addPane: null, resSig: '', diarySig: '' };
  slots.seg = seg([{ id: 'add', label: 'Add food' }, { id: 'diary', label: 'Diary' }], view, setView, 'fd-view');
  slots.addPane = h('div', { class: 'fd-pane' });
  slots.addPane.append(searchPane());
  // the switch sits in a wrapper: app.js writes --i (the section's stagger index) on each child of this list, and on the switch itself that moves its thumb
  container.append(h('div', { class: 'fd' }, header(), slots.sum, h('div', { class: 'fd-viewbox' }, slots.seg), slots.addPane, slots.diary));
  paint(); paintText();
  if (fresh && ctx.params.quick) openQuickSheet();
  consumePending();
  return update;
}
