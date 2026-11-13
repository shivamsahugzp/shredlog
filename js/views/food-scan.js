// AI plate scanner UI: capture -> analyse -> review (edit, answer questions) -> log. Plus the Settings section (key, memory).
// Engine, prompt and memory live in ../scan.js. Called from the Food tab (and a Today tile): openScanner(ctx, { date, meal }).
import { state, commit, todayKey, parseKey, recentFoods, findFood, addCustomFood, logFoods, removeFoods } from '../state.js';
import { h, icon, sheet, toast, confirmSheet, promptSheet, stepper, segmented, toggle, field, clear, ring, fmt, haptic } from '../ui.js';
import { fill, stagger } from '../motion.js';
import { scaleFood } from '../calc.js';
import { MEALS, MEAL_LABEL, scaleMicro, lookup, buildEntry, r1, r2, SPOTS, segFix } from './food-extras.js';
import * as AI from '../scan.js';
import * as PK from '../packet.js';

const seg = (options, value, onChange, cls) => segFix(segmented(options, value, onChange, cls), options, value);

// ---- icons (ui.js has no camera; use its own if one is ever added) ----
const SVGNS = 'http://www.w3.org/2000/svg';
function svgIcon(d, size = 20) {
  const s = document.createElementNS(SVGNS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
  const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.appendChild(p);
  return s;
}
const CAMERA_D = 'M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 9.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z';
const IMAGE_D = 'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 16l-5-5-8 8';
export function cameraIcon(size = 20) {
  const a = icon('camera', size), b = icon('__none__', size); // icon() falls back to "info" for unknown names
  return a.firstChild.getAttribute('d') === b.firstChild.getAttribute('d') ? svgIcon(CAMERA_D, size) : a;
}
const imageIcon = (size = 20) => svgIcon(IMAGE_D, size);

// ---- small helpers ----
const mealByTime = (d = new Date()) => { const hr = d.getHours(); return hr < 11 ? 'breakfast' : hr < 16 ? 'lunch' : hr < 19 ? 'snacks' : 'dinner'; };
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isWeight = (u) => u === 'g' || u === 'ml';
const PLURAL_UNIT = { piece: 'pieces', slice: 'slices', cup: 'cups', glass: 'glasses', bowl: 'bowls', plate: 'plates' };
const unitWord = (unit, qty) => (qty === 1 ? unit : PLURAL_UNIT[unit] || unit);
const sumBy = (arr, k) => arr.reduce((a, x) => a + (x[k] || 0), 0);
const humanId = (id) => String(id || '').replace(/_/g, ' ');
// Same timestamp rule as the Food tab for entries on another day.
function tsFor(date, meal, i = 0) {
  if (date === todayKey()) return {};
  const hour = MEALS.find((m) => m.id === meal)?.hour ?? 12;
  return { ts: parseKey(date).getTime() + (hour - 12) * 3600000 + i };
}
const mealOptions = (meal) => MEALS.filter((m) => m.id !== 'drinks' || meal === 'drinks').map(({ id, label }) => ({ id, label }));

let seq = 0;
// An item on the review screen. `base` is what the model said at `base.qty`; everything rescales from it.
function makeItem(r, extra = {}) {
  const it = { uid: ++seq, name: r.name, desc: r.desc || '', qty: r.qty, unit: r.unit, conf: r.confidence ?? 0.6, hint: r.hint || '', local: null, useLocal: false, manual: false, ...extra };
  // Show tidy quantities: halves for countable units, 5 g steps for weights. Macros rescale with it.
  const q0 = it.qty;
  it.qty = isWeight(it.unit) ? Math.max(5, Math.round(q0 / 5) * 5) : Math.max(0.5, Math.round(q0 * 2) / 2);
  const k = q0 > 0 ? it.qty / q0 : 1;
  it.base = { qty: it.qty, grams: r.grams * k, kcal: r.kcal * k, p: r.p * k, c: r.c * k, f: r.f * k, fiber: r.fiber * k };
  if (!extra.local) attachLocal(it);
  return it;
}
function attachLocal(it) {
  it.local = AI.matchLocalFood(it.name, it.hint);
  it.useLocal = !!it.local; // default ON whenever the local list has numbers
}

// ================= the scanner sheet =================
export function openScanner(ctx, opts = {}) {
  const date = opts.date || ctx?.date || todayKey();
  const st = {
    step: 'capture', meal: MEALS.some((m) => m.id === opts.meal) ? opts.meal : mealByTime(), img: null,
    items: [], qs: [], notes: '', remember: true, busy: false, removed: new Set(), ctl: null, run: 0,
  };
  const root = h('div', { class: 'sc-root' });
  const foot = h('div', { class: 'sc-foot' });
  let closed = false; // the sheet's DOM lingers a moment while it animates out, so track closing ourselves
  const api = sheet({ title: 'Scan plate', full: true, dismissable: false, content: root, actions: foot, onClose: () => { closed = true; st.run++; if (st.ctl) st.ctl.abort(); } });
  api.el.classList.add('sc-sheet');
  const actionsEl = foot.parentElement;
  const alive = () => !closed;
  const setFoot = (...kids) => { clear(foot); kids.flat().forEach((k) => k && foot.append(k)); actionsEl.classList.toggle('hide', !foot.childNodes.length); api.el.classList.toggle('sc-nofoot', !foot.childNodes.length); };
  const goSettings = () => { api.close(); if (ctx && ctx.go) ctx.go('settings', { open: 'ai' }); };

  // ---- step: no key yet ----
  function drawSetup() {
    st.step = 'setup'; clear(root); setFoot();
    root.append(h('div', { class: 'sc-setup' },
      h('span', { class: 'sc-spot sc-hero', html: SPOTS.key }),
      h('h3', null, 'Scan your plate'),
      h('p', { class: 'sc-lede' }, 'Snap a photo and AI estimates the carbs, protein and portion size. If it cannot tell something, it asks you once and remembers your answer.'),
      h('div', { class: 'callout sc-privacy' }, icon('info'), h('div', null, 'Photos go from your phone straight to the AI provider you choose. ShredLog has no server. The key stays on this phone and is never in backups.')),
      h('button', { class: 'btn primary block lg sc-goset', onClick: goSettings }, 'Set up in Settings'),
      h('div', { class: 'small muted sc-free' }, 'Gemini has a free tier, no card needed.'),
      h('button', { class: 'btn block sc-to-packet', onClick: () => { api.close(); openPacketScanner(ctx, { date, meal: st.meal }); } }, 'Scan a packet instead, no key needed')));
  }

  // ---- step: capture ----
  function fileInput(cls, camera) {
    const input = h('input', { type: 'file', accept: 'image/*', class: cls, style: { display: 'none' }, ...(camera ? { capture: 'environment' } : {}) });
    input.addEventListener('change', () => { const f = input.files && input.files[0]; input.value = ''; if (f) useImage(f); });
    return input;
  }
  function pickBtn(cls, ico, label, sub, input) {
    return h('button', { class: 'sc-pickbtn ' + cls, onClick: () => { if (window.__shredlogMockImage) useImage(window.__shredlogMockImage); else input.click(); } },
      h('span', { class: 'sc-pickico' }, ico), h('b', null, label), h('span', { class: 'small' }, sub));
  }
  function drawCapture() {
    st.step = 'capture'; clear(root); setFoot();
    const cam = fileInput('sc-input-cam', true), gal = fileInput('sc-input-gal', false);
    const cfg = AI.getAI(), P = cfg && AI.PROVIDERS[cfg.provider];
    root.append(h('div', { class: 'sc-capture' },
      h('div', { class: 'sc-finder' }, h('span', { class: 'sc-spot sc-plate', html: SPOTS.plate }), h('div', { class: 'sc-tip' }, 'Fit the whole plate in the frame and shoot from above.')),
      h('div', { class: 'sc-pickrow' },
        pickBtn('sc-btn-camera primary', cameraIcon(26), 'Take photo', 'Opens the camera', cam),
        pickBtn('sc-btn-gallery', imageIcon(26), 'Gallery', 'Use a saved photo', gal)),
      h('div', { class: 'sc-meal' }, h('div', { class: 'sc-meal-l' }, 'Log it to'), seg(mealOptions(st.meal), st.meal, (id) => { st.meal = id; }, 'sc-meals')),
      h('div', { class: 'small muted sc-using' }, P ? `Using ${P.label}, ${cfg.model}. ` : 'Test mode. ', h('button', { class: 'sc-link', onClick: goSettings }, 'AI settings')),
      h('div', { class: 'small muted sc-using' }, 'Scanning a packaged food? ', h('button', { class: 'sc-link sc-to-packet', onClick: () => { api.close(); openPacketScanner(ctx, { date, meal: st.meal }); } }, 'Scan a packet')),
      cam, gal));
  }

  async function useImage(src) {
    const run = ++st.run;
    st.img = null; drawAnalysing('Preparing photo…');
    let img;
    try { img = await AI.imageToJpeg(src); }
    catch (e) { if (run === st.run && alive()) drawError(new AI.ScanError(e.message || "Couldn't read that photo.", { kind: 'image' })); return; }
    if (run !== st.run || !alive()) return;
    st.img = img;
    analyse();
  }

  // ---- step: analysing ----
  const preview = (scanning, label) => h('div', { class: 'sc-prev' + (scanning ? ' sc-scanning' : ''), style: st.img ? { aspectRatio: String(Math.min(1.5, Math.max(0.8, st.img.width / st.img.height))) } : null },
    st.img ? h('img', { src: st.img.dataUrl, alt: 'Your plate' }) : null,
    scanning ? h('div', { class: 'sc-prev-label' }, h('span', { class: 'sc-spin' }), label || 'Reading your plate…') : null);
  function drawAnalysing(label) {
    st.step = 'analysing'; clear(root); setFoot();
    const skel = (cls) => h('span', { class: 'skeleton ' + cls });
    root.append(h('div', { class: 'sc-analysing' }, preview(true, label),
      h('div', { class: 'sc-skel', 'aria-hidden': 'true' },
        h('div', { class: 'sc-skel-tot' }, skel('sc-sk-ring'), h('div', { class: 'sc-sk-lines' }, skel('sc-sk-l1'), skel('sc-sk-l2'))),
        [0, 1, 2].map(() => h('div', { class: 'sc-skel-item' }, skel('sc-sk-l3'), skel('sc-sk-l4'), skel('sc-sk-l5')))),
      h('div', { class: 'small muted sc-wait' }, 'This usually takes 5 to 15 seconds.'),
      h('button', { class: 'btn ghost sc-cancel', onClick: () => { st.run++; if (st.ctl) st.ctl.abort(); drawCapture(); } }, 'Cancel')));
  }
  async function analyse() {
    const run = ++st.run;
    drawAnalysing();
    st.ctl = new AbortController();
    try {
      const res = await AI.analysePlate({ dataUrlJpeg: st.img.dataUrl, base64: st.img.base64, context: AI.buildContext({ meal: MEAL_LABEL[st.meal] }), signal: st.ctl.signal });
      if (run !== st.run || !alive()) return;
      st.removed = new Set();
      st.items = res.items.map((r) => makeItem(r));
      st.qs = res.questions.map((q) => ({ ...q, answer: null, applied: false, custom: null }));
      st.notes = res.notes || '';
      drawReview();
    } catch (e) {
      if (e.kind === 'aborted' || run !== st.run || !alive()) return;
      if (e.kind === 'nokey') { drawSetup(); return; }
      drawError(e);
    }
  }

  // ---- step: error ----
  function drawError(e) {
    st.step = 'error'; clear(root); setFoot();
    root.append(h('div', { class: 'sc-error' },
      st.img ? preview(false) : null,
      h('div', { class: 'callout danger' }, icon('warn'), h('div', null, h('b', null, e.message || 'Something went wrong'), e.detail && e.detail !== e.message ? h('div', { class: 'small muted sc-detail' }, e.detail) : null)),
      h('div', { class: 'sc-errbtns' },
        st.img && e.kind !== 'image' ? h('button', { class: 'btn primary', onClick: analyse }, 'Try again') : null,
        h('button', { class: 'btn', onClick: drawCapture }, st.img ? 'Another photo' : 'Back'),
        e.kind === 'auth' ? h('button', { class: 'btn', onClick: goSettings }, 'Check key') : null)));
  }

  // ---- step: review ----
  let listEl, qBox, busyEl, noteEl, tot, reBtn, logBtn, thumbBox;
  const itemEls = new Map();

  function totals() {
    const vs = st.items.map(AI.computeItem);
    return { kcal: Math.round(sumBy(vs, 'kcal')), p: r1(sumBy(vs, 'p')), c: r1(sumBy(vs, 'c')), f: r1(sumBy(vs, 'f')), fiber: r1(sumBy(vs, 'fiber')) };
  }
  function refreshTotals() {
    if (!tot) return;
    const t = totals();
    tot.kcal.textContent = fmt(t.kcal);
    tot.p.textContent = fmt(t.p, 1); tot.c.textContent = fmt(t.c, 1); tot.f.textContent = fmt(t.f, 1); tot.fiber.textContent = fmt(t.fiber, 1);
    const T = state.targets && state.targets.kcal, pct = T > 0 ? Math.min(100, (t.kcal / T) * 100) : 0;
    if (tot.ring) { fill(tot.ring.fillEl, pct, { axis: 'ring', key: 'sc:ring', ms: 420 }); tot.ring.title = T > 0 ? `${Math.round((t.kcal / T) * 100)}% of today's calories` : ''; }
    if (logBtn) {
      logBtn.textContent = st.items.length ? `Log to ${MEAL_LABEL[st.meal]} · ${fmt(t.kcal)} kcal` : 'Nothing to log';
      logBtn.disabled = !st.items.length || st.busy;
    }
  }

  function itemRow(it) {
    const kc = h('b', { class: 'num sc-kc' }), gramsEl = h('span', { class: 'sc-grams' }), unitEl = h('span', { class: 'sc-unit' });
    const m = { p: h('b', { class: 'num' }), c: h('b', { class: 'num' }), f: h('b', { class: 'num' }), fiber: h('b', { class: 'num' }) };
    const chip = (k, label, el) => h('span', { class: 'sc-m' }, h('i', { class: 'dot ' + k }), label + ' ', el, h('small', null, ' g'));
    const upd = () => {
      const v = AI.computeItem(it);
      kc.textContent = fmt(v.kcal);
      m.p.textContent = fmt(v.p, 1); m.c.textContent = fmt(v.c, 1); m.f.textContent = fmt(v.f, 1); m.fiber.textContent = fmt(v.fiber, 1);
      gramsEl.textContent = `≈ ${fmt(v.grams)} g`;
      unitEl.textContent = unitWord(it.unit, it.qty);
      refreshTotals();
    };
    const w = isWeight(it.unit);
    const conf = it.conf >= 0.75 ? null : h('span', { class: 'pill sc-conf ' + (it.conf >= 0.5 ? '' : 'warn') }, it.conf >= 0.5 ? 'estimate' : 'guess');
    const row = h('div', { class: 'sc-item', dataset: { uid: it.uid, name: it.name, conf: it.conf >= 0.75 ? 'hi' : it.conf >= 0.5 ? 'mid' : 'low' } },
      h('div', { class: 'sc-item-top' },
        h('button', { class: 'sc-name', 'aria-label': `Rename ${it.name}`, onClick: () => rename(it) }, h('span', { class: 'sc-name-t' }, it.name), icon('edit', 14)),
        conf,
        h('button', { class: 'icon-btn plain sc-del', 'aria-label': `Remove ${it.name}`, onClick: () => removeItem(it) }, icon('x'))),
      it.desc ? h('div', { class: 'sc-desc' }, it.desc) : null,
      h('div', { class: 'sc-qty' },
        stepper({ value: it.qty, min: w ? 10 : 0.5, max: w ? 3000 : 30, step: w ? 10 : 0.5, onChange: (v) => { it.qty = v; upd(); } }),
        unitEl, gramsEl),
      h('div', { class: 'sc-macros' }, h('span', { class: 'sc-m sc-mk' }, kc, ' kcal'), chip('p', 'P', m.p), chip('c', 'C', m.c), chip('f', 'F', m.f), chip('fiber', 'Fibre', m.fiber)),
      it.local && !it.manual ? toggle('Use my food list numbers', it.useLocal, (on) => { it.useLocal = on; upd(); }, `${it.local.name} · ${fmt(it.local.per100.kcal)} kcal per 100 g`) : null);
    upd();
    return row;
  }

  function paintItems() {
    clear(listEl); itemEls.clear();
    if (!st.items.length) listEl.append(h('div', { class: 'empty sc-empty' }, h('b', null, 'Nothing left to log'), 'Add an item, or retake the photo.'));
    for (const it of st.items) { const el = itemRow(it); itemEls.set(it.uid, el); listEl.append(el); }
    refreshTotals();
  }
  async function rename(it) {
    const v = await promptSheet('Rename item', it.name, { placeholder: 'Food name', ok: 'Save' });
    if (!v || v === it.name) return;
    it.name = v.slice(0, 80); it.hint = ''; attachLocal(it);
    paintItems();
  }
  function removeItem(it) {
    st.items = st.items.filter((x) => x !== it);
    if (!it.manual) st.removed.add(AI.normName(it.name));
    paintItems();
  }

  // Add an item the model missed, from the local food list.
  function openAdd() {
    const input = h('input', { type: 'search', placeholder: 'Search dal, roti, paneer…', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Search foods' });
    const list = h('div', { class: 'list' });
    const s = sheet({ title: 'Add an item', content: h('div', { class: 'stack' }, h('div', { class: 'search' }, icon('search'), input), list) });
    s.el.classList.add('sc-addsheet');
    const draw = () => {
      clear(list);
      const q = input.value.trim(), found = q ? lookup(q, 10) : recentFoods(8);
      if (!found.length) { list.append(h('div', { class: 'empty' }, q ? 'No match. Try another word.' : 'Type a food to search.')); return; }
      for (const f of found) {
        const sv = (f.servings && f.servings[0]) || { label: '100 g', g: 100 };
        list.append(h('button', { class: 'list-item', onClick: () => { s.close(); addLocal(f, sv); } },
          h('div', { class: 'grow' }, h('div', { class: 'title' }, f.name), h('div', { class: 'sub' }, `${sv.label} · ${fmt(scaleFood(f, sv.g).kcal)} kcal`)), icon('plus', 18)));
      }
    };
    input.addEventListener('input', draw);
    draw(); setTimeout(() => input.focus(), 60);
  }
  function addLocal(f, sv) {
    const g = sv.g, s = scaleFood(f, g);
    st.items.push({ uid: ++seq, name: f.name, desc: sv.label, qty: g, unit: 'g', conf: 1, hint: '', local: f, useLocal: true, manual: true, base: { qty: g, grams: g, kcal: s.kcal, p: s.p, c: s.c, f: s.f, fiber: s.fiber } });
    paintItems();
    listEl.lastElementChild?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // ---- questions ----
  const pending = () => st.qs.filter((q) => q.answer && !q.applied);
  function syncQuestionState() {
    const n = pending().length;
    if (reBtn) reBtn.disabled = !n || st.busy;
    const hint = qBox && qBox.querySelector('.sc-pendhint');
    if (hint) { hint.classList.toggle('hide', !n); hint.querySelector('span').textContent = `You answered ${plural(n, 'question')}. Tap Re-estimate to update the numbers.`; }
  }
  function questionEl(q) {
    const set = (v) => { q.answer = q.answer === v ? null : v; q.applied = false; paintQuestion(q); };
    const opts = q.options.slice();
    if (q.custom && !opts.includes(q.custom)) opts.push(q.custom);
    return h('div', { class: 'sc-question' + (q.applied ? ' applied' : ''), dataset: { id: q.id } },
      h('div', { class: 'sc-qtext' }, q.text),
      q.affects.length ? h('div', { class: 'sc-qaff' }, 'Affects ' + q.affects.join(', ')) : null,
      h('div', { class: 'sc-opts' },
        opts.map((o) => h('button', { class: 'chip sc-opt' + (q.answer === o ? ' on accent' : ''), 'aria-pressed': q.answer === o ? 'true' : 'false', onClick: () => set(o) }, o)),
        h('button', { class: 'chip sc-opt sc-other', onClick: async () => { const v = await promptSheet(q.text, q.custom || '', { placeholder: 'Type your answer', ok: 'Use this' }); if (v) { q.custom = v.slice(0, 60); q.answer = q.custom; q.applied = false; paintQuestion(q); } } }, 'Other…')),
      q.applied ? h('div', { class: 'sc-applied small' }, icon('check', 14), 'Applied') : null);
  }
  function paintQuestion(q) {
    const old = qBox.querySelector(`.sc-question[data-id="${q.id}"]`);
    if (old) old.replaceWith(questionEl(q));
    syncQuestionState();
  }
  function paintQuestions() {
    clear(qBox);
    if (!st.qs.length) return;
    const rem = toggle('Remember my answers', st.remember, (on) => { st.remember = on; }, 'So I do not ask these again next time.');
    rem.classList.add('sc-remember');
    reBtn = h('button', { class: 'btn primary block sc-reestimate', onClick: reestimate }, 'Re-estimate');
    qBox.append(
      h('div', { class: 'sc-qhead' }, h('h3', null, 'Help me get this right'), h('div', { class: 'small muted' }, 'Each of these changes the calories by more than about 15%.')),
      ...st.qs.map(questionEl),
      h('div', { class: 'callout sc-pendhint hide' }, icon('info'), h('span')),
      rem, reBtn);
    syncQuestionState();
  }

  async function reestimate() {
    const answers = st.qs.filter((q) => q.answer).map((q) => ({ id: q.id, q: q.text, a: q.answer }));
    if (!pending().length || st.busy) return;
    st.busy = true; listEl.classList.add('sc-busy'); busyEl.classList.remove('hide'); syncQuestionState(); refreshTotals();
    st.ctl = new AbortController();
    try {
      const previous = st.items.map((it) => { const v = AI.computeItem(it); return { name: it.name, qty: it.qty, unit: it.unit, grams: Math.round(v.grams), kcal: Math.round(v.kcal) }; });
      const res = await AI.analysePlate({ dataUrlJpeg: st.img.dataUrl, base64: st.img.base64, context: AI.buildContext({ meal: MEAL_LABEL[st.meal], answers, previous }), signal: st.ctl.signal });
      if (!alive()) return;
      const manual = st.items.filter((i) => i.manual);
      st.items = res.items.filter((r) => !st.removed.has(AI.normName(r.name))).map((r) => makeItem(r)).concat(manual);
      for (const q of st.qs) if (q.answer) q.applied = true;
      const known = new Set(st.qs.map((q) => q.id));
      for (const q of res.questions) if (!known.has(q.id)) st.qs.push({ ...q, answer: null, applied: false, custom: null });
      if (res.notes) { st.notes = res.notes; noteEl.textContent = res.notes; noteEl.classList.remove('hide'); }
      st.busy = false;
      paintItems(); paintQuestions();
      toast('Updated with your answers');
    } catch (e) {
      if (e.kind !== 'aborted' && alive()) toast(e.message || 'Could not re-estimate', { ms: 4000 });
    } finally {
      st.busy = false;
      if (alive()) { listEl.classList.remove('sc-busy'); busyEl.classList.add('hide'); syncQuestionState(); refreshTotals(); }
    }
  }

  // ---- log ----
  function unitFor(it, v) {
    if (isWeight(it.unit)) return { qty: Math.round(v.grams), unit: { label: 'grams', g: 1 } };
    const per = it.qty > 0 ? v.grams / it.qty : v.grams;
    return { qty: it.qty, unit: { label: `1 ${it.unit} (${fmt(per)} g)`, g: r1(per) } };
  }
  // A reusable custom food for a dish the local list does not have (skipped when the same name already exists).
  function customFor(it, v) {
    const key = AI.normName(it.name);
    const dup = state.customFoods.find((f) => AI.normName(f.name) === key);
    if (dup) return dup;
    if (!(v.grams > 0) || !(v.kcal > 0)) return null;
    const k = 100 / v.grams, g = Math.round(v.grams);
    const per100 = { kcal: r2(v.kcal * k), p: r2(v.p * k), c: r2(v.c * k), f: r2(v.f * k), fiber: r2(v.fiber * k), sugar: 0 };
    const servings = [{ label: it.desc && it.desc.length <= 36 ? `${it.desc} (${g} g)` : isWeight(it.unit) ? `${g} g` : `${fmt(it.qty, 1)} ${it.unit} (${g} g)`, g }];
    if (!isWeight(it.unit) && it.qty !== 1 && it.qty > 0) servings.push({ label: `1 ${it.unit} (${fmt(v.grams / it.qty)} g)`, g: Math.round(v.grams / it.qty) });
    return addCustomFood({ name: it.name, cat: 'Scanned dishes', per100, servings, tags: ['custom', 'scan'], kw: [], source: 'scan' });
  }
  function toEntry(it, i) {
    const v = AI.computeItem(it), u = unitFor(it, v), meal = st.meal;
    const base = { name: it.name, qty: u.qty, unit: u.unit, g: r1(v.grams), kcal: Math.round(v.kcal), p: r1(v.p), c: r1(v.c), f: r1(v.f), fiber: r1(v.fiber), sugar: r1(v.sugar || 0), meal, oilTsp: 0, src: 'scan', ...tsFor(date, meal, i) };
    if (it.local && it.useLocal) return { ...base, foodId: it.local.id, cat: it.local.cat, micro: scaleMicro(it.local.micro || null, v.grams), triggers: it.local.triggers || [] };
    if (it.local) return { ...base, foodId: null, cat: 'Scanned', micro: null, triggers: [] }; // user preferred the AI numbers: keep them on edit
    const custom = customFor(it, v);
    return { ...base, foodId: custom ? custom.id : null, cat: custom ? custom.cat : 'Scanned', micro: null, triggers: [] };
  }
  function doLog() {
    if (!st.items.length || st.busy) return;
    const entries = st.items.map(toEntry);
    for (const it of st.items) { const v = AI.computeItem(it); AI.rememberDish({ name: it.name, qty: isWeight(it.unit) ? Math.round(v.grams) : it.qty, unit: it.unit, grams: v.grams, kcal: v.kcal, p: v.p, c: v.c, f: v.f, fiber: v.fiber }); }
    if (st.remember) for (const q of st.qs) if (q.answer) AI.rememberPref(q.id, q.text, q.answer);
    const made = logFoods(date, entries); // commits memory + custom foods + entries together
    const kcal = Math.round(sumBy(made, 'kcal'));
    haptic('success'); api.close();
    toast(`Logged ${plural(made.length, 'item')} · ${fmt(kcal)} kcal`, { ms: 5000, kind: 'success', undo: () => removeFoods(date, made.map((e) => e.id)) });
  }

  function drawReview() {
    st.step = 'review'; clear(root);
    tot = { kcal: h('span', { class: 'num sc-kcal' }), p: h('b', { class: 'num' }), c: h('b', { class: 'num' }), f: h('b', { class: 'num' }), fiber: h('b', { class: 'num' }) };
    tot.ring = ring({ size: 78, stroke: 8, pct: 0, cls: 'sc-ring', children: [tot.kcal, h('small', null, 'kcal')] });
    const mac = (k, label, el) => h('div', { class: 'sc-tm' }, h('div', { class: 'lbl' }, h('i', { class: 'dot ' + k }), label), h('div', { class: 'val' }, el, h('small', null, ' g')));
    thumbBox = h('div', { class: 'sc-thumbbox' }, st.img ? h('img', { class: 'sc-thumb', src: st.img.dataUrl, alt: 'Your plate' }) : null,
      h('button', { class: 'sc-link', onClick: () => { st.items = []; st.qs = []; drawCapture(); } }, 'Retake'));
    listEl = h('div', { class: 'sc-items' });
    qBox = h('div', { class: 'sc-questions' });
    busyEl = h('div', { class: 'sc-busybar hide' }, h('span', { class: 'sc-spin' }), 'Re-estimating with your answers…');
    noteEl = h('div', { class: 'small muted sc-note' + (st.notes ? '' : ' hide') }, st.notes);
    logBtn = h('button', { class: 'btn primary block sc-log', onClick: doLog });
    root.append(h('div', { class: 'sc-review' },
      h('div', { class: 'sc-totals' }, thumbBox, tot.ring,
        h('div', { class: 'sc-tmain' }, h('div', { class: 'sc-tgrid' }, mac('p', 'Protein', tot.p), mac('c', 'Carbs', tot.c), mac('f', 'Fat', tot.f), mac('fiber', 'Fibre', tot.fiber)))),
      field('Log it to', seg(mealOptions(st.meal), st.meal, (id) => { st.meal = id; refreshTotals(); }, 'sc-meals')),
      noteEl, busyEl, listEl,
      h('button', { class: 'btn block sc-add', onClick: openAdd }, icon('plus', 18), 'Add item'),
      qBox,
      h('div', { class: 'small muted sc-disclaimer' }, 'AI estimates are a good guess, not a lab number. Tap a name to fix it, or use the stepper to change the amount.')));
    paintItems(); paintQuestions();
    setFoot(logBtn); refreshTotals();
    stagger(listEl, { key: 'sc-items:' + st.run, step: 40 }); // the review is its own moment: items rise in, at most six
  }

  // ---- go ----
  if (opts.image) useImage(opts.image);
  else if (!AI.isReady()) drawSetup();
  else drawCapture();
  return api;
}

// ================= Settings section: AI plate scanner =================
let lastTest = null; // survives re-draws of Settings
let seenOpen = null;
const ml = (s) => h('a', { href: s.keyUrl, target: '_blank', rel: 'noopener' }, s.keyLabel || s.keyUrl);

export function aiSettingsSection(ctx) {
  const wrap = h('div', { class: 'sc-settings' });
  let hintMsg = ''; // shown once after a pasted key switches the provider
  const draw = () => {
    clear(wrap);
    const cfg = AI.getAI() || { provider: 'gemini', model: AI.PROVIDERS.gemini.default, key: '' };
    const P = AI.PROVIDERS[cfg.provider];
    const ready = !!cfg.key;
    const models = P.models.some((m) => m.id === cfg.model) ? P.models : P.models.concat([{ id: cfg.model, label: cfg.model }]);
    const resultEl = h('div', { class: 'sc-testres' });
    const showResult = () => {
      clear(resultEl);
      if (!lastTest) return;
      resultEl.append(h('span', { class: 'pill ' + (lastTest.ok ? 'good' : 'bad') }, lastTest.ok ? lastTest.message : `Failed: ${lastTest.message}`));
      if (!lastTest.ok && lastTest.detail && lastTest.detail !== lastTest.message) resultEl.append(h('div', { class: 'small muted sc-detail' }, lastTest.detail));
    };

    const keyIn = h('input', { class: 'sc-key', type: 'password', placeholder: P.keyHint, value: cfg.key, autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': `${P.label} API key` });
    const keyHint = h('div', { class: 'hint sc-keyhint' });
    const showBtn = h('button', { class: 'btn sm sc-showkey', 'aria-label': 'Show or hide the key', type: 'button', onClick: () => { const show = keyIn.type === 'password'; keyIn.type = show ? 'text' : 'password'; showBtn.textContent = show ? 'Hide' : 'Show'; } }, 'Show');
    keyIn.addEventListener('input', () => {
      const v = keyIn.value.trim(), g = AI.guessProvider(v);
      lastTest = null;
      if (g && g !== cfg.provider) { AI.setAI({ provider: g, key: v }); lastTest = null; hintMsg = `That looks like a ${AI.PROVIDERS[g].label} key, so I switched provider.`; draw(); const k = wrap.querySelector('.sc-key'); if (k) { k.focus(); } return; }
      AI.setAI({ key: v }); showResult(); keyHint.textContent = ''; removeBtn.disabled = !v;
    });
    keyHint.textContent = hintMsg; hintMsg = '';

    const testBtn = h('button', { class: 'btn soft sc-test', onClick: async () => {
      testBtn.disabled = true; clear(resultEl); resultEl.append(h('span', { class: 'pill' }, 'Testing…'));
      AI.setAI({ key: keyIn.value.trim() });
      lastTest = await AI.testKey();
      testBtn.disabled = false; showResult();
    } }, 'Test key');
    const removeBtn = h('button', { class: 'btn danger sc-remove', disabled: !cfg.key, onClick: async () => {
      if (!(await confirmSheet('The key is deleted from this phone. Your remembered answers stay.', { ok: 'Remove key', danger: true, title: 'Remove key?' }))) return;
      AI.setAI({ key: '' }); lastTest = null; draw(); toast('Key removed from this phone');
    } }, 'Remove key');

    const steps = cfg.provider === 'gemini'
      ? [h('li', null, 'Open ', ml(P), ' (aistudio.google.com/apikey) and sign in with Google.'), h('li', null, 'Tap “Create API key” and copy it.'), h('li', null, 'Paste it above and tap “Test key”.')]
      : [h('li', null, 'Open ', ml(P), ' and sign in.'), h('li', null, 'Create an API key and copy it.'), h('li', null, 'Paste it above and tap “Test key”. Add a little credit if the test fails.')];

    const lrow = (label, note, ...body) => h('div', { class: 'sc-lrow' }, h('div', { class: 'sc-lab' }, h('span', null, label), note ? h('span', { class: 'sc-lab-n' }, note) : null), ...body);
    wrap.append(
      h('div', { class: 'section-head', style: { marginTop: '18px' } }, h('h2', null, 'AI plate scanner'), h('span', { class: 'pill ' + (ready ? 'good' : '') }, ready ? [icon('check', 12), 'Ready'] : 'Not set up')),
      h('div', { class: 'card stack sc-card' },
        h('div', { class: 'sc-intro' }, h('span', { class: 'sc-introico' }, cameraIcon(22)), h('div', { class: 'small' }, 'Photograph your plate and AI estimates the carbs, protein and portion. You bring your own key; it is used only from this phone.')),
        h('div', { class: 'list sc-list' },
          lrow('Provider', null, seg(Object.values(AI.PROVIDERS).map((p) => ({ id: p.id, label: p.label })), cfg.provider, (id) => {
            const keep = AI.guessProvider(cfg.key) === id ? cfg.key : ''; // keep the key only if it belongs to the new provider
            AI.setAI({ provider: id, key: keep }); lastTest = null; draw();
          }, 'sc-provider'), h('div', { class: 'hint' }, P.free)),
          lrow('Model', null, h('select', { class: 'sc-model', 'aria-label': 'Model', onChange: (e) => { AI.setAI({ model: e.target.value }); lastTest = null; showResult(); } }, models.map((m) => h('option', { value: m.id, selected: m.id === cfg.model }, m.label)))),
          lrow('API key', P.keyNote, h('div', { class: 'row' }, keyIn, showBtn), keyHint)),
        h('div', { class: 'sc-actions' }, testBtn, removeBtn), resultEl,
        h('details', { class: 'sc-how', open: !ready }, h('summary', null, h('span', null, cfg.provider === 'gemini' ? 'How to get a free Gemini key' : `How to get a ${P.label} key`), icon('down', 16)), h('ol', { class: 'sc-steps' }, steps)),
        h('div', { class: 'sc-memhead' }, h('div', { class: 'strong' }, 'What it remembers')),
        memoryBlock(),
        h('div', { class: 'callout small' }, icon('info'), h('div', null, 'Photos go from your phone straight to the AI provider you choose. ShredLog has no server. The key stays on this phone and is never in backups.'))));
    showResult();
  };
  draw();
  if (ctx && ctx.params && ctx.params.open === 'ai' && ctx.params !== seenOpen) {
    seenOpen = ctx.params;
    setTimeout(() => requestAnimationFrame(() => { if (!wrap.isConnected) return; wrap.scrollIntoView({ block: 'start', behavior: 'smooth' }); wrap.classList.add('sc-flash'); }), 80);
  }
  return wrap;
}

function memoryBlock() {
  const m = AI.memory();
  const prefs = Object.entries(m.prefs).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const dishes = Object.entries(m.dishes).sort((a, b) => (b[1].times || 0) - (a[1].times || 0) || (b[1].at || 0) - (a[1].at || 0));
  if (!prefs.length && !dishes.length) return h('div', { class: 'small muted sc-memempty' }, 'Nothing yet. When you answer a question or log a scanned plate, it is remembered here so I never ask twice.');
  const del = (label, fn) => h('button', { class: 'icon-btn plain sc-memdel', 'aria-label': label, onClick: fn }, icon('x', 18));
  return h('div', { class: 'stack sc-mem' },
    prefs.length ? h('details', { class: 'sc-memgroup', open: true }, h('summary', null, `Answers · ${prefs.length}`),
      h('div', { class: 'list' }, prefs.map(([id, v]) => h('div', { class: 'list-item sc-memrow', dataset: { id } },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, v.q || humanId(id)), h('div', { class: 'sub' }, '→ ' + v.a)), del(`Forget ${humanId(id)}`, () => AI.forgetPref(id)))))) : null,
    dishes.length ? h('details', { class: 'sc-memgroup', open: !prefs.length }, h('summary', null, `Dishes · ${dishes.length}`),
      h('div', { class: 'list' }, dishes.map(([key, d]) => h('div', { class: 'list-item sc-memrow', dataset: { id: key } },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, d.name || key), h('div', { class: 'sub' }, `${fmt(d.qty, 1)} ${d.unit} · ${fmt(d.grams)} g · ${fmt(d.kcal)} kcal${d.times > 1 ? ` · logged ${d.times}×` : ''}`)), del(`Forget ${d.name || key}`, () => AI.forgetDish(key)))))) : null,
    h('button', { class: 'btn danger sm sc-forget', onClick: async () => { if (await confirmSheet('Forgets every remembered answer and portion. The scanner will ask again.', { ok: 'Forget all', danger: true, title: 'Forget everything?' })) { AI.forgetAll(); toast('Forgotten'); } } }, 'Forget all'));
}


// ================= Scan a packet =================
// capture (photo, or type the barcode / a name) -> read the barcode -> Open Food Facts -> product card -> log or save.
// Lookup, search and the barcode reader live in ../packet.js; the AI label reader is AI.readPacket in ../scan.js.
const PACKET_SPOT = '<svg viewBox="0 0 120 96" aria-hidden="true" focusable="false"><path class="s" d="M10 30V16a6 6 0 0 1 6-6h14M90 10h14a6 6 0 0 1 6 6v14M110 66v14a6 6 0 0 1-6 6H90M30 86H16a6 6 0 0 1-6-6V66"/>'
  + '<rect class="t2" x="26" y="22" width="68" height="52" rx="8"/><rect class="t3" x="26" y="22" width="68" height="13" rx="6"/>'
  + '<g class="t1"><rect x="34" y="42" width="3" height="22"/><rect x="40" y="42" width="2" height="22"/><rect x="45" y="42" width="4" height="22"/><rect x="52" y="42" width="2" height="22"/><rect x="57" y="42" width="3" height="22"/><rect x="63" y="42" width="5" height="22"/><rect x="71" y="42" width="2" height="22"/><rect x="76" y="42" width="3" height="22"/><rect x="82" y="42" width="2" height="22"/><rect x="87" y="42" width="2" height="22"/></g>'
  + '<path class="s" d="M16 53h88"/></svg>';
const SRC_PILL = { off: ['Open Food Facts', 'good'], saved: ['Saved in My foods', 'accent'], label: ['Read from the label', 'warn'], manual: ['Typed by you', ''] };
// A product picture: the scan icon shows until the image arrives (Open Food Facts images can take a second), then it fades in.
function thumb(url, cls, size = 26) {
  const wrap = h('span', { class: cls + ' sc-pk-noimg sc-pk-thumb' }, icon('scan', size));
  if (url) { const im = h('img', { src: url, alt: '', onLoad: () => im.classList.add('on'), onError: () => im.remove() }); wrap.append(im); }
  return wrap;
}
const num1 = (x) => (x == null || x === '' ? null : Number.isFinite(+x) ? +x : null);

export function openPacketScanner(ctx, opts = {}) {
  const date = opts.date || ctx?.date || todayKey();
  const st = { step: 'capture', meal: MEALS.some((m) => m.id === opts.meal) ? opts.meal : mealByTime(), img: null, product: null, via: '', notes: [], mode: 'serving', qty: 1, saved: null, ctl: null, run: 0, read: null, labelEl: null };
  const root = h('div', { class: 'sc-pk-root' });
  const foot = h('div', { class: 'sc-foot' });
  let closed = false;
  const api = sheet({ title: 'Scan a packet', full: true, dismissable: false, content: root, actions: foot, onClose: () => { closed = true; st.run++; if (st.ctl) st.ctl.abort(); } });
  api.el.classList.add('sc-sheet', 'sc-packet');
  const actionsEl = foot.parentElement;
  const alive = () => !closed;
  const setFoot = (...kids) => { clear(foot); kids.flat().forEach((k) => k && foot.append(k)); actionsEl.classList.toggle('hide', !foot.childNodes.length); api.el.classList.toggle('sc-nofoot', !foot.childNodes.length); };
  const goSettings = () => { api.close(); if (ctx && ctx.go) ctx.go('settings', { open: 'ai' }); };
  const newRun = () => { const run = ++st.run; if (st.ctl) st.ctl.abort(); st.ctl = new AbortController(); return { run, signal: st.ctl.signal, stale: () => run !== st.run || closed }; };
  const backTo = () => (st.product ? drawCard() : drawCapture());

  // ---- step: capture ----
  function fileInput(cls, camera) {
    const input = h('input', { type: 'file', accept: 'image/*', class: cls, style: { display: 'none' }, ...(camera ? { capture: 'environment' } : {}) });
    input.addEventListener('change', () => { const f = input.files && input.files[0]; input.value = ''; if (f) useImage(f); });
    return input;
  }
  const pick = (cls, ico, label, sub, input) => h('button', { class: 'sc-pickbtn ' + cls, onClick: () => { if (window.__shredlogMockImage) useImage(window.__shredlogMockImage); else input.click(); } },
    h('span', { class: 'sc-pickico' }, ico), h('b', null, label), h('span', { class: 'small' }, sub));

  function drawCapture() {
    st.step = 'capture'; st.run++; if (st.ctl) st.ctl.abort(); clear(root); setFoot();
    const cam = fileInput('sc-input-cam', true), gal = fileInput('sc-input-gal', false);
    const cfg = AI.getAI(), P = cfg && AI.PROVIDERS[cfg.provider], ready = AI.isReady();
    // type the digits
    const codeIn = h('input', { type: 'text', inputmode: 'numeric', pattern: '[0-9 ]*', maxlength: '20', placeholder: 'Barcode digits', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go', 'aria-label': 'Barcode digits' });
    const codeHint = h('div', { class: 'sc-pk-hint', 'aria-live': 'polite' });
    const goCode = h('button', { class: 'btn soft sc-pk-go', disabled: true, onClick: () => submitCode() }, 'Look up');
    const codeOf = () => PK.cleanCode(codeIn.value);
    const submitCode = () => { const c = codeOf(); if (c) byCode(c); };
    codeIn.addEventListener('input', () => {
      const d = codeIn.value.replace(/\D+/g, ''), c = codeOf();
      goCode.disabled = !c;
      codeHint.className = 'sc-pk-hint';
      if (!d) codeHint.textContent = '';
      else if (!c) codeHint.textContent = `${d.length} digit${d.length === 1 ? '' : 's'} so far. Barcodes have 8, 12 or 13.`;
      else if (PK.isValidGTIN(c)) { codeHint.textContent = `${c.length} digits, looks right.`; codeHint.classList.add('ok'); }
      else { codeHint.textContent = 'The last digit does not match. Check the numbers, or look it up anyway.'; codeHint.classList.add('warn'); }
    });
    codeIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitCode(); } });
    // type a name
    const nameIn = h('input', { type: 'search', placeholder: 'Or search by name', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Search by product name' });
    const goName = () => { const q = nameIn.value.trim(); if (q) drawSearch(q, { auto: true }); };
    nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); goName(); } });
    root.append(h('div', { class: 'sc-pk-capture' },
      h('div', { class: 'sc-finder' }, h('span', { class: 'sc-spot sc-pk-spot', html: PACKET_SPOT }), h('div', { class: 'sc-tip' }, 'Fill the frame with the barcode, or the nutrition label. Good light, hold steady.')),
      h('div', { class: 'sc-pickrow' },
        pick('sc-btn-camera sc-packet-camera primary', cameraIcon(26), 'Take photo', 'Barcode or label', cam),
        pick('sc-btn-gallery sc-packet-gallery', imageIcon(26), 'Gallery', 'Use a saved photo', gal)),
      h('div', { class: 'sc-pk-or' }, 'or type it'),
      h('div', { class: 'sc-pk-type' },
        h('div', { class: 'sc-packet-code' }, h('div', { class: 'sc-pk-row' }, codeIn, goCode), codeHint),
        h('div', { class: 'sc-pk-find' }, h('div', { class: 'sc-pk-row' }, h('div', { class: 'search' }, icon('search'), nameIn), h('button', { class: 'btn sc-pk-search', onClick: goName }, 'Search')))),
      h('div', { class: 'small muted sc-using' },
        ready ? `Barcodes are read on this phone. ${P ? P.label : 'The AI'} reads the printed digits and the label when needed. ` : 'No AI key needed: barcodes are read on this phone, or type the digits or a name. ',
        h('button', { class: 'sc-link', onClick: goSettings }, ready ? 'AI settings' : 'Add a key to also read labels')),
      h('div', { class: 'small muted sc-using' }, 'Scanning a meal instead? ', h('button', { class: 'sc-link sc-to-plate', onClick: () => { api.close(); openScanner(ctx, { date, meal: st.meal }); } }, 'Scan plate')),
      cam, gal));
  }

  // ---- step: reading ----
  const setLabel = (t) => { if (st.labelEl) st.labelEl.textContent = t; };
  function drawReading(label) {
    st.step = 'reading'; clear(root); setFoot();
    st.labelEl = h('span', null, label);
    const skel = (cls) => h('span', { class: 'skeleton ' + cls });
    root.append(h('div', { class: 'sc-pk-reading' },
      st.img
        ? h('div', { class: 'sc-prev sc-scanning sc-pk-prev', style: { aspectRatio: String(Math.min(1.5, Math.max(0.8, st.img.width / st.img.height))) } }, h('img', { src: st.img.dataUrl, alt: 'Your photo' }), h('div', { class: 'sc-prev-label' }, h('span', { class: 'sc-spin' }), st.labelEl))
        : h('div', { class: 'sc-pk-busy' }, h('span', { class: 'sc-spin' }), st.labelEl),
      h('div', { class: 'sc-pk-sk', 'aria-hidden': 'true' },
        h('div', { class: 'sc-pk-sk-head' }, skel('sc-pk-sk-img'), h('div', { class: 'sc-pk-sk-lines' }, skel('sc-sk-l1'), skel('sc-sk-l2'))),
        h('div', { class: 'sc-pk-sk-head' }, skel('sc-sk-ring'), h('div', { class: 'sc-pk-sk-lines' }, skel('sc-sk-l5'), skel('sc-sk-l2')))),
      h('button', { class: 'btn ghost sc-cancel', onClick: () => { drawCapture(); } }, 'Cancel')));
  }

  // ---- the pipeline: photo -> barcode -> Open Food Facts -> (AI read) -> product ----
  const readArgs = (r) => (r ? { name: r.product_name, brand: r.brand, servingText: r.serving_text, label: r.nutrition_label } : {});
  async function useImage(src) {
    const { run, signal, stale } = newRun();
    st.img = null; st.product = null; st.saved = null; drawReading('Preparing photo…');
    try { st.img = await AI.imageToJpeg(src, 1280, 0.82); }
    catch (e) { if (!stale()) drawNotFound({ title: "Couldn't read that photo", detail: e.message || 'Try another photo.' }); return; }
    if (stale()) return;
    drawReading('Looking for the barcode…');
    const det = await PK.detectBarcode(src).catch(() => null);
    if (stale()) return;
    identify({ code: det ? det.code : '', run, signal, stale });
  }
  async function identify({ code, signal, stale }) {
    let read = null, aiErr = null, aiTried = false;
    const readAI = async () => {
      if (aiTried || !st.img || !AI.isReady()) return read; // one AI call per photo, even when it failed
      aiTried = true; setLabel('Reading the pack…');
      try { return await AI.readPacket(st.img, { signal }); } catch (e) { if (e.kind === 'aborted') throw e; aiErr = e; return null; }
    };
    try {
      if (!code) { read = await readAI(); if (stale()) return; if (read && read.barcode_digits) code = read.barcode_digits; }
      st.read = read;
      const known = code && AI.packetFood(code);
      if (known) { showKnown(known); return; }
      let res = null;
      if (code || read) { setLabel(code ? 'Finding it on Open Food Facts…' : 'Searching Open Food Facts…'); res = await PK.resolvePacket({ code, ...readArgs(read), signal }); if (stale()) return; }
      if ((!res || !res.product) && !read) { // a barcode we could not place: the photo may still show the name or the label
        read = await readAI(); if (stale()) return;
        st.read = read;
        if (read) {
          if (!code && read.barcode_digits) { code = read.barcode_digits; const k2 = AI.packetFood(code); if (k2) { showKnown(k2); return; } }
          setLabel('Finding it on Open Food Facts…');
          res = await PK.resolvePacket({ code, ...readArgs(read), signal }); if (stale()) return;
        }
      }
      if (res && res.product) { showCard(res.product, res.via, { trail: res.trail }); return; }
      drawNotFound({ code, res, aiErr, noCode: !code && !read });
    } catch (e) { if (!stale() && e.kind !== 'aborted') drawNotFound({ error: e, code }); }
  }
  async function byCode(code) {
    const { signal, stale } = newRun();
    st.img = null; st.product = null; st.saved = null; st.read = null;
    drawReading(`Looking up ${code}…`);
    const known = AI.packetFood(code);
    if (known) { showKnown(known); return; }
    try {
      const res = await PK.resolvePacket({ code, signal });
      if (stale()) return;
      if (res.product) showCard(res.product, res.via, { trail: res.trail }); else drawNotFound({ code, res });
    } catch (e) { if (!stale() && e.kind !== 'aborted') drawNotFound({ error: e, code }); }
  }
  function showKnown(food) {
    const p = PK.foodToProduct(food);
    if (!p) { drawNotFound({ code: food && food.barcode }); return; }
    showCard(p, 'saved', { trail: ['You saved this one before, so no lookup was needed.'] });
  }

  // ---- step: not found / error ----
  function drawNotFound({ code = '', res = null, aiErr = null, noCode = false, error: err = null, title = '', detail = '' } = {}) {
    st.step = 'notfound'; clear(root); setFoot();
    const error = err || (res && res.error) || null; // offline, busy or timeout: not "no such product"
    const searchNote = !error && res && res.searchError ? res.searchError.message : '';
    const cands = (res && res.candidates || []).slice(0, 4);
    const head = title || (error ? (error.kind === 'offline' ? 'No internet connection' : "Couldn't reach Open Food Facts") : noCode ? 'No barcode found in that photo' : 'Not on Open Food Facts yet');
    const why = detail || (error ? error.message : noCode
      ? 'Get closer, keep the barcode flat and well lit, and fill the frame. You can also type the digits or search by name.'
      : `${code ? `Barcode ${code}. ` : ''}Anyone can add it at openfoodfacts.org. For now, search by name or type the numbers from the pack.`);
    const rd = st.read || {};
    root.append(h('div', { class: 'sc-pk-nf' },
      st.img ? h('div', { class: 'sc-prev sc-pk-prev', style: { aspectRatio: String(Math.min(1.5, Math.max(0.8, st.img.width / st.img.height))) } }, h('img', { src: st.img.dataUrl, alt: 'Your photo' })) : null,
      h('div', { class: 'callout ' + (error || title ? 'danger' : 'info') }, icon('warn'), h('div', null, h('b', null, head), h('div', { class: 'small muted sc-detail' }, why),
        searchNote ? h('div', { class: 'small muted sc-detail' }, 'Name search: ' + searchNote) : null,
        aiErr ? h('div', { class: 'small muted sc-detail' }, 'AI: ' + (aiErr.message || 'could not read the photo')) : null,
        !AI.isReady() && !error && !title ? h('div', { class: 'small muted sc-detail' }, 'With an AI key in Settings I can also read the printed digits and the nutrition label from a photo.') : null)),
      cands.length ? h('div', { class: 'sc-pk-cands' }, h('h3', null, 'Closest matches'), h('div', { class: 'list' }, cands.map((p) => resultRow(p)))) : null,
      h('div', { class: 'sc-pk-nfbtns' },
        h('button', { class: 'btn primary block sc-pk-tosearch', onClick: () => drawSearch([rd.brand, rd.product_name].filter(Boolean).join(' ')) }, icon('search', 18), 'Search by name'),
        h('button', { class: 'btn block sc-pk-tomanual', onClick: () => drawManual({ name: rd.product_name || '', brand: rd.brand || '', code: PK.cleanCode(code) }) }, icon('edit', 18), 'Type the numbers from the pack'),
        h('button', { class: 'btn ghost block', onClick: drawCapture }, 'Try another photo'))));
  }

  // ---- step: search ----
  function resultRow(p) {
    return h('button', { class: 'list-item sc-pk-res', dataset: { code: p.code }, onClick: () => choose(p) },
      thumb(p.image, 'sc-pk-rimg', 18),
      h('div', { class: 'grow sc-pk-rtext' }, h('div', { class: 'title sc-pk-rt' }, PK.productTitle(p)),
        h('div', { class: 'sub' }, p.per100 ? `${fmt(p.per100.kcal)} kcal · P ${fmt(p.per100.p, 1)} g per 100 ${p.unit}` : 'No nutrition listed')),
      icon('right', 16));
  }
  async function choose(p) {
    const { signal, stale } = newRun();
    let prod = p;
    if (!p.complete && p.code) { // search hits are trimmed; the full record sometimes has the numbers
      drawReading('Getting the full record…');
      try { const full = await PK.lookupBarcode(p.code, { signal }); if (full && (full.per100 || !p.per100)) prod = full; } catch (e) { if (e.kind === 'aborted') return; }
      if (stale()) return;
    }
    const known = prod.code && AI.packetFood(prod.code);
    if (known) { showKnown(known); return; }
    showCard(prod, 'search', { trail: [] });
  }
  function drawSearch(q = '', { auto = false } = {}) {
    st.step = 'search'; st.run++; if (st.ctl) st.ctl.abort(); clear(root); setFoot();
    const input = h('input', { type: 'search', placeholder: 'e.g. superyou protein bar', value: q, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-label': 'Search products' });
    const list = h('div', { class: 'sc-pk-results' });
    async function run() {
      const query = input.value.trim(); if (!query) return;
      const { signal, stale } = newRun();
      clear(list); list.append(h('div', { class: 'sc-pk-sk' }, [0, 1, 2, 3].map(() => h('div', { class: 'sc-pk-sk-head' }, h('span', { class: 'skeleton sc-pk-sk-img' }), h('div', { class: 'sc-pk-sk-lines' }, h('span', { class: 'skeleton sc-sk-l1' }), h('span', { class: 'skeleton sc-sk-l2' }))))));
      try {
        const found = await PK.searchProducts(query, { signal });
        if (stale()) return;
        clear(list);
        if (!found.length) { list.append(h('div', { class: 'empty sc-empty' }, h('b', null, 'No match'), 'Try fewer words, like the brand and one more word.')); return; }
        list.append(h('div', { class: 'list' }, found.map(resultRow)), h('div', { class: 'small muted sc-pk-credit' }, 'Product data from Open Food Facts. Tap one to see its numbers.'));
      } catch (e) {
        if (stale() || e.kind === 'aborted') return;
        clear(list); list.append(h('div', { class: 'callout danger' }, icon('warn'), h('div', null, h('b', null, e.kind === 'offline' ? 'No internet connection' : 'Search did not work'), h('div', { class: 'small muted sc-detail' }, e.message))));
      }
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); run(); } });
    root.append(h('div', { class: 'sc-pk-search-step' },
      h('button', { class: 'sc-link sc-pk-back', onClick: backTo }, icon('left', 14), st.product ? 'Back to the product' : 'Back'),
      h('div', { class: 'sc-pk-row' }, h('div', { class: 'search' }, icon('search'), input), h('button', { class: 'btn soft sc-pk-search', onClick: () => { input.blur(); run(); } }, 'Search')),
      list,
      h('button', { class: 'btn block sc-pk-tomanual', onClick: () => drawManual({ name: input.value.trim(), code: st.product ? st.product.code : '' }) }, icon('edit', 18), 'Not here? Type the numbers from the pack')));
    if (auto && q.trim()) run(); else setTimeout(() => input.focus(), 60);
  }

  // ---- step: type the numbers from the pack ----
  function drawManual(pre = {}) {
    st.step = 'manual'; st.run++; if (st.ctl) st.ctl.abort(); clear(root);
    const per = pre.per100 || null, sv = pre.serving && pre.serving.from !== 'default' ? pre.serving.g : null;
    const ins = {};
    const numIn = (key, label, val, optional) => { ins[key] = h('input', { type: 'number', inputmode: 'decimal', step: 'any', min: '0', placeholder: optional ? 'optional' : '0', value: val == null ? '' : String(val), 'aria-label': label }); return field(label, ins[key]); };
    const nameIn = h('input', { type: 'text', value: pre.name || '', placeholder: 'e.g. Protein bar, chocolate', autocomplete: 'off', 'aria-label': 'Product name' });
    const brandIn = h('input', { type: 'text', value: pre.brand || '', placeholder: 'optional', autocomplete: 'off', 'aria-label': 'Brand' });
    let basis = '100';
    const servField = numIn('serving', 'Serving size (g)', sv, true);
    const err = h('div', { class: 'callout danger hide sc-pk-err' }, icon('warn'), h('div'));
    const basisSeg = seg([{ id: '100', label: 'Per 100 g' }, { id: 'serving', label: 'Per serving' }], basis, (id) => { basis = id; servField.querySelector('label').textContent = id === 'serving' ? 'Serving size (g), needed' : 'Serving size (g), optional'; }, 'sc-pk-basis');
    servField.querySelector('label').textContent = 'Serving size (g), optional';
    const showErr = (msg) => { err.classList.toggle('hide', !msg); err.lastChild.textContent = msg || ''; };
    const use = h('button', { class: 'btn primary block sc-pk-use', onClick: () => {
      const val = (k) => num1(ins[k].value), name = nameIn.value.trim();
      if (!name) { showErr('Add a name so you can find it later.'); nameIn.focus(); return; }
      if (val('kcal') == null && val('p') == null && val('c') == null && val('f') == null) { showErr('Add the calories, or at least protein, carbs and fat.'); return; }
      if (basis === 'serving' && !(val('serving') > 0)) { showErr('Add the serving size in grams, so I can scale it.'); ins.serving.focus(); return; }
      const prod = PK.manualProduct({ name, brand: brandIn.value.trim(), per: basis, servingG: val('serving'), kcal: val('kcal'), p: val('p'), c: val('c'), f: val('f'), fiber: val('fiber'), sugar: val('sugar'), code: pre.code || '' });
      if (!prod || !prod.per100) { showErr('Those numbers could not be used. Check them against the pack.'); return; }
      if (pre.serving && val('serving') > 0 && Math.abs(pre.serving.g - val('serving')) < 0.01) { prod.serving = pre.serving; if (pre.pack) prod.pack = pre.pack; }
      if (pre.cat) prod.cat = pre.cat;
      if (pre.image) prod.image = pre.image;
      prod.edited = true;
      st.saved = pre.foodId ? findFood(pre.foodId) || null : null;
      showCard(prod, 'manual', { trail: [] });
    } }, 'Use these numbers');
    setFoot(use);
    root.append(h('div', { class: 'sc-pk-manual' },
      h('button', { class: 'sc-link sc-pk-back', onClick: backTo }, icon('left', 14), st.product ? 'Back to the product' : 'Back'),
      h('div', { class: 'small muted' }, 'Copy them from the nutrition table on the pack.', pre.code ? ` Barcode ${pre.code}: save it to My foods and it is found instantly next time.` : ''),
      field('Name', nameIn), field('Brand', brandIn),
      field('The pack lists numbers', basisSeg),
      servField,
      h('div', { class: 'sc-pk-grid' }, numIn('kcal', 'Calories (kcal)', per ? per.kcal : null), numIn('p', 'Protein (g)', per ? per.p : null), numIn('c', 'Carbs (g)', per ? per.c : null), numIn('f', 'Fat (g)', per ? per.f : null), numIn('fiber', 'Fibre (g)', per ? per.fiber : null, true), numIn('sugar', 'Sugar (g)', per ? per.sugar : null, true)),
      err));
    setTimeout(() => { if (!nameIn.value) nameIn.focus(); }, 60);
  }

  // ---- step: the product card ----
  function showCard(product, via, { trail = [] } = {}) {
    if (!product.per100) { // Open Food Facts knows the product but lists no numbers
      drawManual({ ...product }); const top = root.querySelector('.sc-pk-manual'); if (top) top.prepend(h('div', { class: 'callout' }, icon('info'), h('div', null, h('b', null, `${PK.productTitle(product)} has no nutrition on Open Food Facts`), h('div', { class: 'small muted sc-detail' }, 'Type the numbers from the pack and I will use them.'))));
      return;
    }
    st.product = product; st.via = via; st.mode = 'serving'; st.qty = 1;
    if (!(via === 'manual' && st.saved)) st.saved = product.foodId ? findFood(product.foodId) || null : (product.code ? AI.packetFood(product.code) : null);
    if (product.serving.from === 'default' && !product.noGrams) { st.mode = 'grams'; st.qty = 100; }
    drawCard(trail);
  }

  function drawCard(trail = []) {
    st.step = 'card'; clear(root);
    const P = st.product, via = st.via, liquid = P.unit === 'ml', gl = liquid ? 'ml' : 'g';
    const unitG = (m) => (m === 'pack' && P.pack ? P.pack.g : m === 'grams' ? 1 : P.serving.g);
    const gramsNow = () => st.qty * unitG(st.mode);
    const per = P.per100;

    // identity
    const [srcLabel, srcTone] = SRC_PILL[P.source] || SRC_PILL.off;
    const img = st.img && P.source === 'label' ? h('img', { class: 'sc-pk-img sc-pk-photo', src: st.img.dataUrl, alt: 'Your photo' }) : thumb(P.image, 'sc-pk-img', 26);
    const showBrand = P.brand && !AI.normName(P.name).includes(AI.normName(P.brand));
    const idBlock = h('div', { class: 'sc-pk-id' },
      showBrand ? h('div', { class: 'sc-pk-brand' }, P.brand) : null,
      h('h3', { class: 'sc-pk-name' }, P.name || P.brand || 'Packaged food'),
      h('div', { class: 'sc-pk-pills' }, h('span', { class: 'pill ' + srcTone }, srcTone === 'good' ? icon('check', 12) : null, srcLabel), P.code ? h('span', { class: 'micro muted sc-pk-code' }, P.code) : null));
    const editBtn = h('button', { class: 'icon-btn plain sc-pk-edit', 'aria-label': 'Edit numbers', title: 'Edit numbers', onClick: () => drawManual({ ...P, foodId: st.saved ? st.saved.id : P.foodId }) }, icon('edit', 18));

    // numbers for the chosen amount
    const kc = h('span', { class: 'num sc-kcal' });
    const ringEl = ring({ size: 82, stroke: 8, pct: 0, cls: 'sc-ring', children: [kc, h('small', null, 'kcal')] });
    const mv = { p: h('b', { class: 'num' }), c: h('b', { class: 'num' }), f: h('b', { class: 'num' }), fiber: h('b', { class: 'num' }) };
    const mac = (k, label, el) => h('div', { class: 'sc-tm' }, h('div', { class: 'lbl' }, h('i', { class: 'dot ' + k }), label), h('div', { class: 'val' }, el, h('small', null, ' g')));
    const per100 = P.noGrams ? null : h('div', { class: 'sc-pk-100' },
      h('div', null, h('b', null, `Per 100 ${gl}`), `  ${fmt(per.kcal)} kcal · P ${fmt(per.p, 1)} · C ${fmt(per.c, 1)} · F ${fmt(per.f, 1)} g`),
      per.sugar || per.sodium != null || per.fiber ? h('div', null, [per.fiber ? `Fibre ${fmt(per.fiber, 1)} g` : '', per.sugar ? `Sugar ${fmt(per.sugar, 1)} g` : '', per.sodium != null ? `Sodium ${fmt(per.sodium)} mg` : ''].filter(Boolean).join(' · ')) : null);

    // quantity
    const qtyBox = h('div', { class: 'sc-pk-qtybox' });
    const gramsEl = h('span', { class: 'sc-grams' }), unitEl = h('span', { class: 'sc-unit' }), noteEl = h('div', { class: 'small muted sc-pk-unitnote' });
    const modes = [{ id: 'serving', label: 'Serving' }, ...(P.pack ? [{ id: 'pack', label: 'Pack' }] : []), ...(P.noGrams ? [] : [{ id: 'grams', label: liquid ? 'ml' : 'Grams' }])];
    let logBtn, saveBtn;
    const upd = () => {
      const g = gramsNow(), v = PK.portion(P, g), T = state.targets && state.targets.kcal;
      kc.textContent = fmt(v.kcal); mv.p.textContent = fmt(v.p, 1); mv.c.textContent = fmt(v.c, 1); mv.f.textContent = fmt(v.f, 1); mv.fiber.textContent = fmt(v.fiber, 1);
      fill(ringEl.fillEl, T > 0 ? Math.min(100, (v.kcal / T) * 100) : 0, { axis: 'ring', key: 'sc:pk-ring', ms: 420 });
      ringEl.title = T > 0 ? `${Math.round((v.kcal / T) * 100)}% of today's calories` : '';
      gramsEl.textContent = st.mode === 'grams' ? '' : `≈ ${fmt(g)} ${gl}`;
      unitEl.textContent = st.mode === 'grams' ? gl : st.mode === 'pack' ? (st.qty === 1 ? 'pack' : 'packs') : (st.qty === 1 ? 'serving' : 'servings');
      noteEl.textContent = st.mode === 'serving' ? '1 serving = ' + (/^1 serving/i.test(P.serving.label) ? `${fmt(P.serving.g)} ${gl}` : P.serving.label) : st.mode === 'pack' ? `1 pack = ${fmt(P.pack.g)} ${gl}` : '';
      if (logBtn) logBtn.textContent = `Log to ${MEAL_LABEL[st.meal]} · ${fmt(v.kcal)} kcal`;
    };
    const paintQty = () => {
      clear(qtyBox);
      const g = st.mode === 'grams';
      if (modes.length > 1) qtyBox.append(seg(modes, st.mode, (id) => setMode(id), 'sc-pk-modes'));
      qtyBox.append(h('div', { class: 'sc-qty sc-pk-qty' }, stepper({ value: st.qty, min: g ? 5 : 0.5, max: g ? 5000 : 30, step: g ? 5 : 0.5, onChange: (v) => { st.qty = v; upd(); } }), unitEl, gramsEl), noteEl);
    };
    const setMode = (m) => {
      if (m === st.mode) return;
      const grams = gramsNow(); st.mode = m;
      st.qty = m === 'grams' ? Math.max(5, Math.round(grams / 5) * 5) : m === 'pack' ? 1 : Math.max(0.5, Math.round((grams / unitG(m)) * 2) / 2); // choosing Pack means "I had the pack
      paintQty(); upd();
    };

    // honest notes about where the numbers came from
    const notes = [];
    if (via === 'label' || P.source === 'label') notes.push(['warn', 'Read from your photo of the label', 'This is not from a database. Check the numbers against the pack, and edit them if one is off.']);
    else if (via === 'name') notes.push(['info', 'Matched by name', 'No barcode, so I picked the closest product. Wrong flavour or size? Tap Wrong product.']);
    else if (via === 'search') notes.push(['info', 'Picked from the search list', 'Open Food Facts is edited by volunteers. Compare with the pack.']);
    if (P.suspect) notes.push(['warn', 'These numbers look off', 'Calories and macros do not add up. Check the pack, and tap the pencil to fix them.']);
    else if (!P.complete && P.source === 'off') notes.push(['warn', `Missing on Open Food Facts: ${P.missing.join(', ')}`, 'They show as 0. Tap the pencil to add them from the pack.']);
    else if (P.estimated) notes.push(['info', 'Calories worked out from the macros', 'The listing has no calorie value.']);
    const noteEls = notes.slice(0, 2).map(([tone, head, body]) => h('div', { class: 'callout sc-pk-note' + (tone === 'info' ? ' info' : '') }, icon(tone === 'warn' ? 'warn' : 'info'), h('div', null, h('b', null, head), h('div', { class: 'small muted sc-detail' }, body))));

    root.append(h('div', { class: 'sc-pk-cardstep' },
      h('div', { class: 'card sc-packet-card', dataset: { code: P.code || '', source: P.source } },
        h('div', { class: 'sc-pk-head' }, img, idBlock, editBtn),
        h('div', { class: 'sc-pk-nums' }, ringEl, h('div', { class: 'sc-tgrid sc-pk-grid4' }, mac('p', 'Protein', mv.p), mac('c', 'Carbs', mv.c), mac('f', 'Fat', mv.f), mac('fiber', 'Fibre', mv.fiber))),
        per100),
      ...noteEls,
      h('div', { class: 'card pad-s sc-pk-qtycard' }, qtyBox),
      field('Log it to', seg(mealOptions(st.meal), st.meal, (id) => { st.meal = id; upd(); }, 'sc-meals')),
      h('div', { class: 'small muted sc-disclaimer' }, P.source === 'off' ? 'Nutrition data: Open Food Facts (ODbL). Anyone can edit it, so check it against the pack.' : 'Check these numbers against the pack.')));

    // footer: log, save, wrong product
    logBtn = h('button', { class: 'btn primary block sc-packet-log', onClick: doLog });
    saveBtn = h('button', { class: 'btn sc-packet-save', onClick: () => { const f = saveProduct(); if (f) { paintSave(); toast(st.saveKind === 'exists' ? 'Already in My foods' : st.saveKind === 'updated' ? 'My food updated' : 'Saved to My foods', { kind: 'success' }); } } });
    const paintSave = () => { clear(saveBtn); saveBtn.disabled = !!st.saved && !P.edited; saveBtn.append(...(st.saved && !P.edited ? [icon('check', 18), 'Saved'] : [icon('star', 18), st.saved ? 'Update My food' : 'Save to My foods'])); };
    paintSave();
    setFoot(logBtn, h('div', { class: 'sc-pk-foot2' }, saveBtn, h('button', { class: 'btn sc-pk-wrong', onClick: () => drawSearch(PK.productTitle(P), { auto: true }) }, 'Wrong product?')));
    paintQty(); upd();
  }

  // ---- save and log ----
  // Creates the custom food (once per barcode), remembers barcode -> food id, and returns it. An edited product updates the saved food.
  function saveProduct() {
    const P = st.product; st.saveKind = 'created';
    const title = PK.productTitle(P);
    const dup = st.saved || (P.code ? state.customFoods.find((f) => f.barcode === P.code) : state.customFoods.find((f) => AI.normName(f.name) === AI.normName(title) && f.source === P.source));
    let food;
    if (dup) {
      food = dup; st.saveKind = P.edited ? 'updated' : 'exists';
      if (P.edited) { const nf = PK.productToFood(P); Object.assign(food, { name: nf.name, per100: nf.per100, servings: nf.servings, brand: nf.brand, source: nf.source }); }
    } else food = addCustomFood(PK.productToFood(P)); // commits
    if (P.code) AI.rememberPacket(P.code, food.id);
    commit();
    st.saved = food; P.edited = false;
    return food;
  }
  function entryFor() {
    const P = st.product, grams = st.qty * (st.mode === 'pack' && P.pack ? P.pack.g : st.mode === 'grams' ? 1 : P.serving.g), meal = st.meal;
    const unit = st.mode === 'grams' ? { label: 'grams', g: 1 } : st.mode === 'pack' && P.pack ? { label: P.pack.label, g: P.pack.g } : { label: P.serving.label, g: P.serving.g };
    const extra = { src: 'packet', ...tsFor(date, meal) };
    if (st.saved && !P.edited) return { ...buildEntry(st.saved, { qty: st.qty, unit, meal, oilTsp: 0 }), ...extra };
    const v = PK.portion(P, grams);
    return { foodId: null, name: PK.productTitle(P), cat: P.cat || 'Packaged', qty: st.qty, unit, g: r1(grams), kcal: v.kcal, p: v.p, c: v.c, f: v.f, fiber: v.fiber, sugar: v.sugar, micro: null, triggers: [], meal, oilTsp: 0, ...extra };
  }
  function doLog() {
    if (!st.product) return;
    const made = logFoods(date, [entryFor()]);
    const kcal = Math.round(sumBy(made, 'kcal'));
    haptic('success'); api.close();
    toast(`Logged ${PK.productTitle(st.product)} · ${fmt(kcal)} kcal`, { ms: 5000, kind: 'success', undo: () => removeFoods(date, made.map((e) => e.id)) });
  }

  drawCapture();
  return api;
}
