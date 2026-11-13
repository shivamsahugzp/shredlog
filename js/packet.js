// "Scan a packet": barcode reading, Open Food Facts lookup and search, label-to-product helpers. No DOM, no state imports,
// so every function here runs in Node. The sheet that uses it is openPacketScanner() in views/food-scan.js.
//
// Nutrition data for packaged foods: Open Food Facts (ODbL), https://world.openfoodfacts.org. It is crowd-sourced, so every
// product carries `complete` / `suspect` flags and the UI always lets the user edit the numbers.
//
// Product shape used everywhere:
//   { name, brand, per100: { kcal, p, c, f, fiber, sugar, sodium /* mg */ } | null, serving: { label, g }, pack: { label, g } | null,
//     unit: 'g' | 'ml', image, source: 'off' | 'label' | 'manual' | 'saved', code, complete, suspect, missing: [...], estimated }

const TIMEOUT_MS = 6000;
const HOSTS = { world: 'https://world.openfoodfacts.org', in: 'https://in.openfoodfacts.org' };
const PRODUCT_FIELDS = 'product_name,product_name_en,brands,quantity,serving_size,serving_quantity,nutriments,image_front_small_url,categories_tags,countries_tags';
const SEARCH_FIELDS = 'code,product_name,product_name_en,brands,quantity,nutriments,serving_size,serving_quantity,image_front_small_url,categories_tags';
const mockPacket = () => (typeof window !== 'undefined' ? window.__shredlogMockPacket : undefined);

// ---- errors ----
export class PacketError extends Error {
  constructor(message, kind = 'http') { super(message); this.name = 'PacketError'; this.kind = kind; }
}
const MSG = {
  offline: "No internet connection. Type the numbers from the pack instead.",
  timeout: 'Open Food Facts took too long. Try again, or type the numbers from the pack.',
  busy: 'Open Food Facts is busy right now. Wait a minute and try again, or type the numbers from the pack.',
  notfound: "Open Food Facts doesn't have this barcode yet.",
  http: 'Open Food Facts did not answer properly. Try again in a minute.',
};
const perr = (kind, extra) => new PacketError(extra || MSG[kind] || MSG.http, kind);

// ---- small helpers ----
const nz = (v) => { if (v == null || v === '') return null; const x = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.')); return Number.isFinite(x) ? x : null; };
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const cl = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
export const normText = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
// "SUPERYOU" -> "Superyou" (shouting names are common on OFF); mixed case is left alone.
export const tidyText = (s) => { const t = clip(s, 90); return t && t === t.toUpperCase() && /[A-Z]/.test(t) && t.length > 3 ? t.toLowerCase().replace(/(^|[\s(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : t; };

// ---- barcodes ----
// Digits only, 8 / 12 / 13 / 14 long (EAN-8, UPC-A, EAN-13, GTIN-14), or ''.
export function cleanCode(text) { const d = String(text == null ? '' : text).replace(/\D+/g, ''); return [8, 12, 13, 14].includes(d.length) ? d : ''; }
// GS1 check digit (EAN-8, UPC-A, EAN-13, GTIN-14).
export function isValidGTIN(code) {
  const d = String(code || '');
  if (!/^\d{8}$|^\d{12,14}$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length - 1; i++) sum += +d[d.length - 2 - i] * (i % 2 === 0 ? 3 : 1);
  return (10 - (sum % 10)) % 10 === +d[d.length - 1];
}
// Codes to try on Open Food Facts: as read, UPC-A as EAN-13 (leading 0), GTIN-14 without its packaging digit.
export function codeVariants(code) {
  const c = cleanCode(code); if (!c) return [];
  const out = [c];
  if (c.length === 12) out.push('0' + c);
  if (c.length === 14) out.push(c.slice(1));
  return out;
}

// ---- weights and servings ----
// "40 g", "1 bar (40g)", "6 x 40 g", "1.5 L", "250 ml" -> { g, unit } or null. A leading "N x" multiplies.
export function parseWeight(text) {
  const t = String(text || '').toLowerCase().replace(',', '.');
  const re = /(?:(\d+)\s*[x×*]\s*)?(\d+(?:\.\d+)?)\s*(kg|gms?|grams?|g|ltr|litres?|liters?|lt|l|ml)\b/g;
  let m, first = null, bracket = null;
  while ((m = re.exec(t))) {
    const u = m[3], big = /^(kg|l|lt|ltr|litre|litres|liter|liters)$/.test(u);
    const g = Math.round(+m[2] * (big ? 1000 : 1) * (m[1] ? +m[1] : 1) * 10) / 10, unit = /^(ml|l|lt|ltr|litre|litres|liter|liters)$/.test(u) ? 'ml' : 'g';
    if (!(g > 0 && g <= 20000)) continue;
    const hit = { g, unit };
    if (!first) first = hit;
    if (!bracket && t.lastIndexOf('(', m.index) > t.lastIndexOf(')', m.index)) bracket = hit; // the number inside brackets: "1 bar (40 g)"
  }
  return bracket || first;
}
const U = (unit) => (unit === 'ml' ? 'ml' : 'g');
function servingLabel(text, g, unit) {
  const t = clip(text, 60).replace(/\s*\(\s*/g, ' (').replace(/\s*\)/g, ')').replace(/(\d)(gms?|g|ml)\b/gi, '$1 $2');
  if (!t) return `1 serving (${r1(g)} ${U(unit)})`;
  if (/^\d+(\.\d+)?\s*(g|gm|gms|gram|grams|ml)$/i.test(t)) return `1 serving (${r1(g)} ${U(unit)})`; // a bare "40 g"
  const hasWeight = new RegExp('\\b' + String(r1(g)).replace('.', '\\.') + '\\s*(g|gm|gms|ml)\\b', 'i').test(t);
  const out = hasWeight ? t : `${t} (${r1(g)} ${U(unit)})`;
  return out.length <= 40 ? (/^\d/.test(out) ? out : '1 ' + out) : `1 serving (${r1(g)} ${U(unit)})`;
}

// ---- Open Food Facts product -> our shape ----
const CAT_RULES = [
  [/protein|supplement|bodybuilding|whey|energy-bar|protein-bar/, 'Protein & Supplements'],
  [/beverage|drink|juice|soda|water|milk-drink|energy-drink|lassi|chaas|buttermilk/, 'Beverages'],
  [/chocolate|confection|candies|sweet|dessert|biscuit|cookie|cake|wafer/, 'Sweets & Desserts'],
  [/snack|chips|crisps|namkeen|nuts|cereal|bar/, 'Snacks & Street Food'],
];
export function categoryFor(tags) {
  const t = (Array.isArray(tags) ? tags : []).join(' ').toLowerCase();
  for (const [re, cat] of CAT_RULES) if (re.test(t)) return cat;
  return 'Packaged';
}

// Raw OFF product (or a search hit) -> product. Handles kcal vs kJ, per-serving-only values, missing fields, odd serving text.
export function normaliseProduct(raw, code) {
  if (!raw || typeof raw !== 'object') return null;
  const n = raw.nutriments && typeof raw.nutriments === 'object' ? raw.nutriments : {};
  const name = tidyText(raw.product_name || raw.product_name_en || raw.generic_name || '');
  const brand = tidyText(String(raw.brands || '').split(',')[0]);
  const pack = parseWeight(raw.quantity);
  let sq = nz(raw.serving_quantity), sunit = null;
  const parsedServing = parseWeight(raw.serving_size);
  if (!(sq > 0) && parsedServing) { sq = parsedServing.g; sunit = parsedServing.unit; }
  if (sq > 0 && !sunit) sunit = parsedServing ? parsedServing.unit : pack ? pack.unit : 'g';
  const unit = sunit || (pack && pack.unit) || 'g';

  const get = (k) => { // per 100 g, else derived from the per-serving value
    const a = nz(n[k + '_100g']); if (a != null) return a;
    const s = nz(n[k + '_serving']); return s != null && sq > 0 ? (s * 100) / sq : null;
  };
  let kcal = get('energy-kcal'), estimated = false, suspect = false;
  const kj = nz(n['energy-kj_100g']) ?? nz(n['energy_100g']) ?? (nz(n['energy_serving']) != null && sq > 0 ? (nz(n['energy_serving']) * 100) / sq : null);
  if (kcal == null && kj != null) kcal = kj / 4.184;
  if (kcal != null && kcal > 920) { // a kJ value typed into the kcal field
    const alt = kj != null && kj / 4.184 <= 920 ? kj / 4.184 : kcal / 4.184 <= 920 ? kcal / 4.184 : null;
    if (alt != null) { kcal = alt; } suspect = true;
  }
  const p = get('proteins'), c = get('carbohydrates'), f = get('fat'), fiber = get('fiber'), sugar = get('sugars');
  let sodium = nz(n.sodium_100g);
  if (sodium != null) sodium = sodium * 1000; else { const salt = nz(n.salt_100g); if (salt != null) sodium = (salt / 2.5) * 1000; }
  if (kcal == null && (p != null || c != null || f != null)) { kcal = 4 * (p || 0) + 4 * (c || 0) + 9 * (f || 0); estimated = true; }

  const missing = [];
  if (kcal == null) missing.push('calories');
  if (p == null) missing.push('protein');
  if (c == null) missing.push('carbs');
  if (f == null) missing.push('fat');
  const empty = kcal == null && p == null && c == null && f == null;
  const complete = !empty && p != null && c != null && f != null && kcal != null;
  if (!empty) {
    const macros = (p || 0) + (c || 0) + (f || 0);
    if (macros > 102) suspect = true;
    if (!estimated && p != null && c != null && f != null && kcal != null) { const atw = 4 * p + 4 * c + 9 * f; if (Math.abs(kcal - atw) > Math.max(60, 0.4 * Math.max(kcal, atw))) suspect = true; }
  }
  const per100 = empty ? null : { kcal: Math.round(cl(kcal || 0, 0, 900)), p: r1(cl(p || 0, 0, 100)), c: r1(cl(c || 0, 0, 100)), f: r1(cl(f || 0, 0, 100)), fiber: r1(cl(fiber || 0, 0, 100)), sugar: r1(cl(sugar || 0, 0, 100)), ...(sodium != null ? { sodium: Math.round(cl(sodium, 0, 40000)) } : {}) };

  let serving, packInfo = pack ? { label: `1 pack (${r1(pack.g)} ${U(pack.unit)})`, g: pack.g } : null;
  if (sq > 0) serving = { label: servingLabel(raw.serving_size, sq, unit), g: sq, from: 'serving' };
  else if (packInfo && pack.g <= 500) { serving = { ...packInfo, from: 'pack' }; packInfo = null; } // a single bar or sachet: the pack is the serving
  else serving = { label: `100 ${U(unit)}`, g: 100, from: 'default' };
  if (packInfo && Math.abs(packInfo.g - serving.g) < 0.5) packInfo = null;

  return {
    name: name || (brand ? '' : 'Packaged food'), brand, per100, serving, pack: packInfo, unit, image: clip(raw.image_front_small_url, 300) || '',
    source: 'off', code: cleanCode(code || raw.code) || String(code || raw.code || ''), complete, suspect, missing, estimated,
    cat: categoryFor(raw.categories_tags),
  };
}

// Anything a caller (or the test hook) hands over: a raw OFF object, or something already in our shape.
function asProduct(x, code) {
  if (!x || typeof x !== 'object') return null;
  if (x.per100 && typeof x.per100 === 'object') {
    const per = x.per100, g = nz(x.serving && x.serving.g) || 100;
    return { name: clip(x.name, 90), brand: clip(x.brand, 60), per100: { kcal: nz(per.kcal) || 0, p: nz(per.p) || 0, c: nz(per.c) || 0, f: nz(per.f) || 0, fiber: nz(per.fiber) || 0, sugar: nz(per.sugar) || 0, ...(nz(per.sodium) != null ? { sodium: nz(per.sodium) } : {}) },
      serving: { label: x.serving && x.serving.label ? x.serving.label : `${g} g`, g }, pack: x.pack || null, unit: x.unit === 'ml' ? 'ml' : 'g', image: x.image || '', source: x.source || 'off',
      code: cleanCode(x.code || code) || '', complete: x.complete !== false, suspect: !!x.suspect, missing: x.missing || [], estimated: !!x.estimated, cat: x.cat || 'Packaged' };
  }
  return normaliseProduct(x, code);
}

// ---- network ----
async function getJSON(url, { signal } = {}) {
  const ctl = new AbortController();
  let timedOut = false;
  const ms = (typeof window !== 'undefined' && window.__shredlogPacketTimeoutMs) || TIMEOUT_MS; // override is for tests only
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  const onAbort = () => ctl.abort();
  if (signal) { if (signal.aborted) ctl.abort(); else signal.addEventListener('abort', onAbort); }
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) { /* not JSON: Open Food Facts serves an HTML "temporarily unavailable" page when it throttles */ }
    if (!json) throw perr(res.status === 404 ? 'http' : 'busy');
    return { status: res.status, json };
  } catch (e) {
    if (e instanceof PacketError) throw e;
    if (e && e.name === 'AbortError') throw timedOut ? perr('timeout') : perr('aborted', 'Cancelled');
    if (e instanceof TypeError) throw perr('offline');
    throw perr('http');
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
const aborted = (e) => !!e && e.kind === 'aborted';
export const isAborted = aborted;

// Look a barcode up. Resolves a product (check `.complete`), or throws PacketError: notfound | offline | timeout | busy | http.
export async function lookupBarcode(code, { signal } = {}) {
  const m = mockPacket();
  if (m) {
    if (m.delayMs) await new Promise((r) => setTimeout(r, m.delayMs));
    if (m.error) throw perr(m.error === true ? 'http' : m.error);
    const c = cleanCode(code);
    if (m.product && (!m.barcode || codeVariants(c).includes(cleanCode(m.barcode)))) return asProduct(m.product, c);
    throw perr('notfound');
  }
  const variants = codeVariants(code);
  if (!variants.length) throw perr('notfound', 'That barcode has the wrong number of digits.');
  let lastErr = null;
  for (const c of variants) {
    for (const host of [HOSTS.world, HOSTS.in]) {
      try {
        const { status, json } = await getJSON(`${host}/api/v2/product/${encodeURIComponent(c)}.json?fields=${PRODUCT_FIELDS}`, { signal });
        if (json.product && (json.status === 1 || json.status == null)) { const p = normaliseProduct(json.product, c); if (p) return p; }
        lastErr = perr('notfound'); break; // a clean "no such product": the other host has the same data
      } catch (e) {
        if (aborted(e)) throw e;
        lastErr = e;
        if (e.kind === 'offline') throw e; // the other host would fail the same way
      }
    }
    if (lastErr && lastErr.kind !== 'notfound') break; // busy or timeout on both hosts: do not hammer
  }
  throw lastErr || perr('notfound');
}

const searchCache = new Map();
function searchURL(host, q) {
  return `${host}/cgi/search.pl?search_terms=${encodeURIComponent(q)}&search_simple=1&action=process&json=1&page_size=8&sort_by=unique_scans_n&fields=${SEARCH_FIELDS}`;
}
// Search by name. Returns up to 8 products (ones with numbers first). Throws PacketError when every host fails.
// Open Food Facts throttles search to roughly 10 a minute per phone, so results are cached and the UI searches on submit only.
export async function searchProducts(query, { signal } = {}) {
  const q = clip(query, 80), key = normText(q);
  if (!key) return [];
  const m = mockPacket();
  if (m) {
    if (m.delayMs) await new Promise((r) => setTimeout(r, m.delayMs));
    if (m.error) throw perr(m.error === true ? 'http' : m.error);
    return (m.results || (m.product ? [m.product] : [])).map((x) => asProduct(x)).filter(Boolean);
  }
  if (searchCache.has(key)) return searchCache.get(key);
  const words = key.split(' ');
  const attempts = [[HOSTS.in, q], [HOSTS.world, q]];
  if (words.length > 2) attempts.push([HOSTS.in, words.slice(0, 2).join(' ')]); // "superyou protein bar" -> "superyou protein"
  let lastErr = null;
  for (const [host, term] of attempts) {
    try {
      const { json } = await getJSON(searchURL(host, term), { signal });
      const list = (Array.isArray(json.products) ? json.products : []).map((r) => normaliseProduct(r, r.code)).filter((p) => p && p.code && (p.name || p.brand));
      if (list.length) { const seen = new Set(), out = []; for (const p of list.sort((a, b) => (b.per100 ? 1 : 0) - (a.per100 ? 1 : 0))) if (!seen.has(p.code)) { seen.add(p.code); out.push(p); } searchCache.set(key, out.slice(0, 8)); return out.slice(0, 8); }
    } catch (e) {
      if (aborted(e)) throw e;
      lastErr = e;
      if (e.kind === 'offline') throw e;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

// ---- products from other sources ----
const labelNum = (x) => nz(x);
// AI-read label ({per, kcal, protein_g, ...}) -> product, flagged source 'label'. Values per serving are converted with the serving weight.
export function labelProduct(label, { name = '', brand = '', code = '', servingText = '' } = {}) {
  if (!label || typeof label !== 'object') return null;
  const v = { kcal: labelNum(label.kcal), p: labelNum(label.protein_g), c: labelNum(label.carbs_g), f: labelNum(label.fat_g), fiber: labelNum(label.fiber_g), sugar: labelNum(label.sugar_g), sodium: labelNum(label.sodium_mg) };
  if (v.kcal == null && v.p == null && v.c == null && v.f == null) return null;
  const sv = parseWeight(servingText);
  const perServing = /serv|pack|piece|bar/i.test(String(label.per || '')) && !/100/.test(String(label.per || ''));
  const g = sv ? sv.g : null, unit = sv ? sv.unit : 'g';
  const k = perServing ? (g ? 100 / g : 1) : 1;
  const sc = (x) => (x == null ? null : x * k);
  const raw = { nutriments: { 'energy-kcal_100g': sc(v.kcal), proteins_100g: sc(v.p), carbohydrates_100g: sc(v.c), fat_100g: sc(v.f), fiber_100g: sc(v.fiber), sugars_100g: sc(v.sugar), sodium_100g: v.sodium == null ? null : sc(v.sodium) / 1000 },
    product_name: name, brands: brand, serving_quantity: g, serving_size: servingText };
  const p = normaliseProduct(raw, code);
  if (!p) return null;
  p.source = 'label'; p.name = tidyText(name) || 'Packaged food'; p.brand = tidyText(brand); p.code = cleanCode(code) || '';
  if (perServing && !g) { p.serving = { label: '1 serving', g: 100, from: 'default' }; p.noGrams = true; } // the label gave no weight: keep the serving as the only unit
  if (perServing && g) p.serving = { label: servingLabel(servingText, g, unit), g, from: 'serving' };
  return p;
}

// Typed-in label values. per: '100' (per 100 g/ml) or 'serving'. servingG is the weight of one serving (needed for 'serving').
export function manualProduct({ name, brand = '', per = '100', servingG = null, kcal = null, p = null, c = null, f = null, fiber = null, sugar = null, code = '' } = {}) {
  const sg = nz(servingG), k = per === 'serving' && sg > 0 ? 100 / sg : 1;
  const sc = (x) => (nz(x) == null ? null : nz(x) * k);
  const raw = { product_name: name, brands: brand, serving_quantity: sg > 0 ? sg : null,
    nutriments: { 'energy-kcal_100g': sc(kcal), proteins_100g: sc(p), carbohydrates_100g: sc(c), fat_100g: sc(f), fiber_100g: sc(fiber), sugars_100g: sc(sugar) } };
  const prod = normaliseProduct(raw, code);
  if (!prod) return null;
  prod.source = 'manual'; prod.name = clip(name, 90) || 'Packaged food'; prod.brand = clip(brand, 60);
  if (!(sg > 0)) prod.serving = { label: '100 g', g: 100, from: 'default' };
  return prod;
}

// "Superyou" + "Superyou Protein Wafer" -> "Superyou Protein Wafer"; "Yoga Bar" + "Protein bar" -> "Yoga Bar Protein bar".
export function productTitle(p) {
  const name = clip(p.name, 90), brand = clip(p.brand, 60);
  if (!brand) return name || 'Packaged food';
  if (!name) return brand;
  return normText(name).includes(normText(brand)) ? name : `${brand} ${name}`;
}

// ---- grams and per-portion numbers ----
// Numbers for `g` grams of a product (same rounding as calc.scaleFood so a logged entry matches the card).
export function portion(p, g) {
  const m = p.per100 || { kcal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0 }, k = g / 100;
  return { kcal: Math.round(m.kcal * k), p: +(m.p * k).toFixed(1), c: +(m.c * k).toFixed(1), f: +(m.f * k).toFixed(1), fiber: +((m.fiber || 0) * k).toFixed(1), sugar: +((m.sugar || 0) * k).toFixed(1), sodium: m.sodium == null ? null : Math.round(m.sodium * k) };
}

// A custom food (state.customFoods entry, minus id) from a product. Extra fields: barcode, brand, source, image.
export function productToFood(p) {
  const g = p.serving.g > 0 ? p.serving.g : 100;
  const servings = [{ label: p.serving.label, g }];
  if (p.pack && Math.abs(p.pack.g - g) > 0.5) servings.push({ label: p.pack.label, g: p.pack.g });
  const per = p.per100 || { kcal: 0, p: 0, c: 0, f: 0, fiber: 0, sugar: 0 };
  const title = productTitle(p);
  const kw = [...new Set([...normText(title).split(' ').filter((w) => w.length > 2), ...(p.code ? [p.code] : []), 'packet', 'packaged'])].slice(0, 12);
  return {
    name: title, cat: p.cat || 'Packaged',
    per100: { kcal: per.kcal, p: per.p, c: per.c, f: per.f, fiber: per.fiber || 0, sugar: per.sugar || 0, ...(per.sodium != null ? { sodium: per.sodium } : {}) },
    servings, tags: ['custom', 'packaged'], kw, barcode: p.code || null, brand: p.brand || '', source: p.source === 'saved' ? 'off' : p.source,
    ...(p.image && p.source === 'off' ? { image: p.image } : {}), ...(p.unit === 'ml' ? { unit: 'ml' } : {}),
  };
}
// The reverse: a saved custom food back into a product, so a known barcode skips the network.
export function foodToProduct(f) {
  if (!f || !f.per100) return null;
  const sv = (f.servings && f.servings[0]) || { label: '100 g', g: 100 }, pack = f.servings && f.servings[1];
  return { name: f.name, brand: '', per100: { ...f.per100 }, serving: { label: sv.label, g: sv.g }, pack: pack ? { label: pack.label, g: pack.g } : null, unit: f.unit === 'ml' ? 'ml' : 'g',
    image: f.image || '', source: 'saved', origin: f.source || 'off', code: f.barcode || '', complete: true, suspect: false, missing: [], estimated: false, cat: f.cat, foodId: f.id };
}

// ---- the chain: barcode -> name -> label ----
const tokens = (s) => normText(s).split(' ').filter((w) => w.length > 1);
function nameScore(read, p) {
  const a = tokens(read), b = new Set(tokens(productTitle(p)));
  if (!a.length) return 0;
  return a.filter((w) => b.has(w)).length / a.length;
}
const close = (a, b, tol) => (a == null || b == null ? true : Math.abs(a - b) <= Math.max(tol * Math.max(a, b), 2));
// Do two per-100 sets describe the same product (calories and protein within about 20 %)?
export function agrees(a, b) { return !!a && !!b && close(a.kcal, b.kcal, 0.2) && close(a.p, b.p, 0.25); }

// What the model read from the photo goes in as `read` ({ barcode_digits, product_name, brand, serving_text, nutrition_label }).
// Resolves { product, via: 'barcode'|'name'|'label', trail: [strings], candidates }, product null when nothing worked.
export async function resolvePacket({ code = '', name = '', brand = '', servingText = '', label = null, signal } = {}) {
  const trail = [], cleanC = cleanCode(code);
  let off = null, barcodeErr = null, searchErr = null, candidates = [];
  if (cleanC) {
    try { off = await lookupBarcode(cleanC, { signal }); trail.push(`Barcode ${cleanC}: found on Open Food Facts.`); }
    catch (e) { if (aborted(e)) throw e; barcodeErr = e; trail.push(`Barcode ${cleanC}: ${e.kind === 'notfound' ? 'not on Open Food Facts' : e.message}`); }
    if (off && off.complete) return { product: off, via: 'barcode', trail, candidates };
  }
  const lab = label ? labelProduct(label, { name, brand, code: cleanC, servingText }) : null;
  if (off) { // known to Open Food Facts but without numbers: borrow them from the photo of the label if there is one
    if (lab) { trail.push('Open Food Facts has no nutrition values for it, so the numbers come from your photo of the label.'); return { product: { ...lab, name: off.name || lab.name, brand: off.brand || lab.brand, image: off.image || '', code: off.code, cat: off.cat || lab.cat }, via: 'label', trail, candidates }; }
    return { product: off, via: 'barcode', trail, candidates };
  }
  const q = [brand, name].filter(Boolean).join(' ').trim();
  const unreachable = barcodeErr && ['offline', 'busy', 'timeout'].includes(barcodeErr.kind);
  if (q && !(unreachable && lab)) { // by name: only a clear, single match is taken; otherwise the label (if read) wins
    try {
      const found = await searchProducts(q, { signal });
      const scored = found.map((p) => ({ p, s: nameScore(q, p) })).sort((x, y) => y.s - x.s || (y.p.per100 ? 1 : 0) - (x.p.per100 ? 1 : 0));
      candidates = scored.map((x) => x.p);
      const top = scored[0], second = scored[1];
      if (top && top.p.complete && top.s >= 0.75 && (!second || top.s - second.s >= 0.2) && (!lab || agrees(top.p.per100, lab.per100))) {
        trail.push(`Matched "${productTitle(top.p)}" by name on Open Food Facts.`);
        return { product: top.p, via: 'name', trail, candidates };
      }
      trail.push(found.length ? 'Several products on Open Food Facts look similar.' : 'No match by name on Open Food Facts.');
    } catch (e) { if (aborted(e)) throw e; searchErr = e; trail.push(e.message); }
  }
  if (lab) { trail.push('Using the numbers read from your photo of the label.'); return { product: lab, via: 'label', trail, candidates }; }
  const hard = barcodeErr && barcodeErr.kind !== 'notfound' ? barcodeErr : null; // offline, busy or timeout beats "not found"
  return { product: null, via: null, trail, candidates, error: hard || (cleanC ? null : searchErr), searchError: searchErr, barcodeError: barcodeErr };
}

// ================= barcode reading: native BarcodeDetector, else a small EAN/UPC scan-line decoder =================
const L_W = [[3, 2, 1, 1], [2, 2, 2, 1], [2, 1, 2, 2], [1, 4, 1, 1], [1, 1, 3, 2], [1, 2, 3, 1], [1, 1, 1, 4], [1, 3, 1, 2], [1, 2, 1, 3], [3, 1, 1, 2]];
const G_W = L_W.map((w) => w.slice().reverse()); // G-code is the mirror of the R-code, which has the same widths as L
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

function digitAt(w, i, tables) { // 4 run widths -> { d, t } or null (compared as ratios, so blur and distance do not matter)
  const sum = w[i] + w[i + 1] + w[i + 2] + w[i + 3];
  if (!(sum > 0)) return null;
  const k = 7 / sum; let best = null;
  for (const [t, table] of tables) for (let d = 0; d < 10; d++) {
    let e = 0; for (let j = 0; j < 4; j++) { const x = w[i + j] * k - table[d][j]; e += x * x; }
    if (!best || e < best.e) best = { d, t, e };
  }
  return best && best.e < 1.5 ? best : null;
}
const LT = [['L', L_W], ['G', G_W]], RT = [['R', L_W]], L_ONLY = [['L', L_W]];
function guardOK(w, i, n, m) { for (let j = 0; j < n; j++) if (!(w[i + j] > 0.45 * m && w[i + j] < 1.9 * m)) return false; return true; }

// r: run widths (r[i] is a black bar). Tries EAN-13 / UPC-A, then EAN-8, starting at run i.
function decodeAt(r, i) {
  const m = (r[i] + r[i + 1] + r[i + 2]) / 3;
  if (!(m > 0.7) || !guardOK(r, i, 3, m)) return null;
  if (i > 1 && r[i - 1] < 1.5 * m) return null; // a quiet zone before the start guard (a tight crop may cut it short)
  if (i + 58 < r.length) { // EAN-13
    let digits = '', par = '', ok = true;
    for (let k = 0; k < 6 && ok; k++) { const x = digitAt(r, i + 3 + 4 * k, LT); if (!x) ok = false; else { digits += x.d; par += x.t; } }
    if (ok && guardOK(r, i + 27, 5, m)) {
      let right = '';
      for (let k = 0; k < 6 && ok; k++) { const x = digitAt(r, i + 32 + 4 * k, RT); if (!x) ok = false; else right += x.d; }
      const first = PARITY.indexOf(par);
      if (ok && first >= 0 && guardOK(r, i + 56, 3, m)) { const code = first + digits + right; if (isValidGTIN(code)) return code; }
    }
  }
  if (i + 42 < r.length) { // EAN-8
    let left = '', ok = true;
    for (let k = 0; k < 4 && ok; k++) { const x = digitAt(r, i + 3 + 4 * k, L_ONLY); if (!x) ok = false; else left += x.d; }
    if (ok && guardOK(r, i + 19, 5, m)) {
      let right = '';
      for (let k = 0; k < 4 && ok; k++) { const x = digitAt(r, i + 24 + 4 * k, RT); if (!x) ok = false; else right += x.d; }
      if (ok && guardOK(r, i + 40, 3, m)) { const code = left + right; if (isValidGTIN(code)) return code; }
    }
  }
  return null;
}

// One scan line of grey values -> runs [[isBlack, length], ...] with sub-pixel edges, using a local mid-level threshold so
// uneven light does not matter. Flat (low contrast) stretches count as white.
function runsOf(line) {
  const n = line.length, B = 32;
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = (line[i > 0 ? i - 1 : 0] + 2 * line[i] + line[i < n - 1 ? i + 1 : n - 1]) / 4;
  if (n > 40) { // unsharp mask: blurred, low-resolution photos lose the peak of thin bars, this gives it back
    const K = 4, bl = new Float32Array(n); let acc = 0;
    for (let i = 0; i < n; i++) { acc += s[i]; if (i >= 2 * K + 1) acc -= s[i - 2 * K - 1]; if (i >= K) bl[i - K] = acc / Math.min(i + 1, 2 * K + 1); }
    for (let i = n - K; i < n; i++) bl[i] = s[i];
    for (let i = 0; i < n; i++) s[i] = cl(s[i] + 0.9 * (s[i] - bl[i]), 0, 255);
  }
  const nb = Math.ceil(n / B), mn = new Float32Array(nb).fill(255), mx = new Float32Array(nb);
  for (let i = 0; i < n; i++) { const b = (i / B) | 0; if (s[i] < mn[b]) mn[b] = s[i]; if (s[i] > mx[b]) mx[b] = s[i]; }
  const d = new Float32Array(n); // signed distance below the local mid-level (negative = bar); flat areas are +1000
  for (let i = 0; i < n; i++) {
    const b = (i / B) | 0; let lo = 255, hi = 0;
    for (let q = Math.max(0, b - 2); q <= Math.min(nb - 1, b + 2); q++) { if (mn[q] < lo) lo = mn[q]; if (mx[q] > hi) hi = mx[q]; }
    d[i] = hi - lo >= 28 ? s[i] - (lo + hi) / 2 : 1000;
  }
  const runs = []; let black = d[0] < 0, start = 0;
  for (let i = 1; i < n; i++) {
    const bi = d[i] < 0;
    if (bi === black) continue;
    const flat = d[i] === 1000 || d[i - 1] === 1000, t = flat ? 0.5 : cl(d[i - 1] / (d[i - 1] - d[i]), 0, 1);
    const edge = i - 1 + t;
    runs.push([black, edge - start]); start = edge; black = bi;
  }
  runs.push([black, n - start]);
  return runs;
}
function decodeRuns(runs) {
  const w = runs.map((x) => x[1]);
  for (let i = 0; i < runs.length; i++) { if (!runs[i][0]) continue; const code = decodeAt(w, i); if (code) return code; }
  return null;
}
export function decodeLine(line) {
  const c = decodeRuns(runsOf(line));
  if (c) return c;
  return decodeRuns(runsOf(Array.prototype.slice.call(line).reverse()));
}

// Gray image (Uint8 array, row-major) -> { code, votes } or null. Scans many lines at a few angles, both directions.
export function decodeGray(gray, w, h, { lines = 56 } = {}) {
  const votes = new Map(), cx = (w - 1) / 2, cy = (h - 1) / 2;
  const angles = [0, 90, 8, -8, 98, 82, 16, -16, 106, 74];
  const step = Math.max(w, h) < 1000 ? 0.5 : 1; // small photos: sample between pixels so thin bars keep their width
  const buf = new Float32Array(Math.ceil(Math.hypot(w, h) / step) + 4);
  for (const deg of angles) {
    const th = (deg * Math.PI) / 180, dx = Math.cos(th), dy = Math.sin(th), nx = -dy, ny = dx;
    const R = (w * Math.abs(nx) + h * Math.abs(ny)) / 2;
    for (let li = 0; li < lines; li++) {
      const t = -R * 0.96 + ((2 * R * 0.96) * li) / (lines - 1);
      const ox = cx + nx * t, oy = cy + ny * t; // a point on the line; walk along (dx, dy) while inside the image
      let s0 = -Math.hypot(w, h), s1 = Math.hypot(w, h);
      for (const [o, d, hi] of [[ox, dx, w - 1], [oy, dy, h - 1]]) {
        if (Math.abs(d) < 1e-9) { if (o < 0 || o > hi) { s0 = 1; s1 = 0; } continue; }
        const a = (0 - o) / d, b = (hi - o) / d; s0 = Math.max(s0, Math.min(a, b)); s1 = Math.min(s1, Math.max(a, b));
      }
      const n = Math.floor((s1 - s0) / step);
      if (n < 120) continue;
      for (let i = 0; i < n; i++) {
        const sp = s0 + i * step, x = ox + dx * sp, y = oy + dy * sp, x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0;
        buf[i] = (gray[y0 * w + x0] * (1 - fx) + gray[y0 * w + x1] * fx) * (1 - fy) + (gray[y1 * w + x0] * (1 - fx) + gray[y1 * w + x1] * fx) * fy;
      }
      const code = decodeLine(buf.subarray(0, n));
      if (code) { const v = (votes.get(code) || 0) + 1; votes.set(code, v); if (v >= 3) return { code, votes: v }; }
    }
  }
  let top = null;
  for (const [code, v] of votes) if (!top || v > top.votes || (v === top.votes && code.length > top.code.length)) top = { code, votes: v };
  if (top && top.code.length === 8 && top.votes < 2) return null; // EAN-8 has few digits to check: want two lines to agree
  return top;
}

async function loadBitmap(src) {
  const blob = typeof src === 'string' ? await (await fetch(src)).blob() : src;
  if (typeof createImageBitmap === 'function') { try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch (e) { /* fall through */ } }
  return await new Promise((res, rej) => {
    const url = URL.createObjectURL(blob), img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); res(img); }; img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('image')); }; img.src = url;
  });
}
// A File/Blob or data: URL -> { code, via: 'native' | 'js' } or null. Tries the phone's BarcodeDetector first, then the decoder above.
export async function detectBarcode(src, { maxSide = 2000 } = {}) {
  const m = mockPacket();
  if (m && m.barcode) return { code: cleanCode(m.barcode), via: 'mock' };
  let bmp;
  try { bmp = await loadBitmap(src); } catch (e) { return null; }
  try {
    const BD = typeof window !== 'undefined' ? window.BarcodeDetector : undefined;
    if (BD) {
      try {
        const det = new BD({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
        const hits = await det.detect(bmp);
        for (const hit of hits || []) { const c = cleanCode(hit.rawValue); if (c && (isValidGTIN(c) || hit.format === 'upc_e')) return { code: c, via: 'native' }; }
      } catch (e) { /* unsupported formats or a failed decode: use the JS decoder */ }
    }
    const sw = bmp.width || bmp.naturalWidth, sh = bmp.height || bmp.naturalHeight;
    if (!sw || !sh || typeof document === 'undefined') return null;
    const big = Math.max(sw, sh), sizes = [Math.min(big, maxSide)];
    if (big > maxSide * 1.3) sizes.push(Math.min(big, 3200)); // a small barcode in a big photo: look again at higher resolution
    for (const side of sizes) {
      const k = side / big, w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const g = cv.getContext('2d', { willReadFrequently: true }); g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); g.drawImage(bmp, 0, 0, w, h);
      const px = g.getImageData(0, 0, w, h).data, gray = new Uint8ClampedArray(w * h);
      for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
      const res = decodeGray(gray, w, h);
      if (res) return { code: res.code, via: 'js' };
    }
    return null;
  } finally { if (bmp && bmp.close) bmp.close(); }
}
