// DOM helpers, icons, sheets, toasts, formatters.
import { prefersReducedMotion, pulse } from './motion.js';

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) { if (sv == null) continue; if (sk.startsWith('--')) el.style.setProperty(sk, String(sv)); else el.style[sk] = sv; } }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
export function append(el, ...children) {
  for (const c of children.flat(Infinity)) { if (c == null || c === false) continue; el.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return el;
}
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export function frag(...children) { const f = document.createDocumentFragment(); append(f, children); return f; }

// ---- icons: Phosphor Icons (MIT), duotone weight, data in js/icons.js (viewBox 0 0 256 256, filled, currentColor) ----
// The import sits here on purpose: this block is the only icon surface in this file. Unknown names fall back to `info`.
import { ICONS, FILLS, VIEWBOX } from './icons.js';
const SVGNS = 'http://www.w3.org/2000/svg';
const has = (name) => Object.prototype.hasOwnProperty.call(ICONS, name);
const TPL = new Map(); // "w:name" -> parsed <svg> template; icon() only clones it
function mkPath(d, cls, opacity) {
  const p = document.createElementNS(SVGNS, 'path');
  if (cls) p.setAttribute('class', cls);
  if (opacity) p.setAttribute('opacity', opacity);
  p.setAttribute('d', d);
  return p;
}
function template(key, build) {
  let t = TPL.get(key);
  if (!t) {
    t = document.createElementNS(SVGNS, 'svg');
    t.setAttribute('viewBox', VIEWBOX); t.setAttribute('fill', 'currentColor'); t.setAttribute('aria-hidden', 'true'); t.setAttribute('focusable', 'false');
    build(t); TPL.set(key, t);
  }
  return t;
}
function stamp(t, size, cls) {
  const svg = t.cloneNode(true);
  svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('class', cls);
  return svg;
}
// Duotone: the soft layer (.d2, 20 % of currentColor, or of --accent when the svg has class "accent") under the solid glyph.
export function icon(name, size = 20, cls = '') {
  const key = has(name) ? name : 'info', g = ICONS[key];
  return stamp(template('d:' + key, (t) => { if (g.d2) t.append(mkPath(g.d2, 'd2', '.2')); t.append(mkPath(g.d)); }), size, 'ph i-' + key + (cls ? ' ' + cls : ''));
}
// Fill weight (solid): used by the active tab. Names without a vendored fill glyph fall back to the duotone main path.
export function iconFill(name, size = 20, cls = '') {
  const key = has(name) ? name : 'info';
  return stamp(template('f:' + key, (t) => t.append(mkPath(FILLS[key] || ICONS[key].d))), size, 'ph ph-fill i-' + key + (cls ? ' ' + cls : ''));
}
icon.fill = iconFill; // so a caller that already imports icon() (app.js tab bar) can ask for the solid weight without a new import

// ---- sheets ----
const sheetsRoot = () => document.getElementById('sheets');
let openSheets = 0;
// Exit animation lives in motion.css (.mo-out); the DOM is removed after it. api.close() stays synchronous in every other way
// (counter, scroll lock, onClose all run immediately) so callers that open a second sheet straight after closing one are unaffected.
function leave(...els) {
  if (prefersReducedMotion()) { els.forEach((e) => e.remove()); return; }
  els.forEach((e) => { e.classList.add('mo-out'); e.style.pointerEvents = 'none'; });
  setTimeout(() => els.forEach((e) => e.remove()), 230);
}
// Drag the grab handle or title bar down to dismiss.
function dragToClose(box, api) {
  let id = null, y0 = 0, dy = 0, t0 = 0, raf = 0;
  const paint = () => { raf = 0; box.style.transform = `translateY(${dy}px)`; };
  const down = (e) => { if (id != null || e.target.closest('button') || (e.pointerType === 'mouse' && e.button !== 0)) return; id = e.pointerId; y0 = e.clientY; dy = 0; t0 = performance.now(); try { e.currentTarget.setPointerCapture(id); } catch (err) { /* ignore */ } };
  const move = (e) => { if (e.pointerId !== id) return; dy = Math.max(0, e.clientY - y0); if (!raf) raf = requestAnimationFrame(paint); };
  const up = (e) => {
    if (e.pointerId !== id) return; id = null; if (raf) { cancelAnimationFrame(raf); raf = 0; }
    const v = dy / Math.max(1, performance.now() - t0);
    if (dy > 90 || (v > 0.6 && dy > 30)) {
      if (!prefersReducedMotion() && box.animate) box.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(100%)' }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
      api.close();
    } else if (dy > 0) {
      if (!prefersReducedMotion() && box.animate) box.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' });
      box.style.transform = '';
    }
    dy = 0;
  };
  for (const el of box.querySelectorAll('.grab, .sheet-head')) { el.classList.add('mo-drag'); el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); }
}
export function sheet({ title, content, actions, onClose, full = false, closeLabel = true, dismissable = true }) {
  const root = sheetsRoot();
  const backdrop = h('div', { class: 'backdrop' });
  const box = h('div', { class: 'sheet' + (full ? ' full' : ''), role: 'dialog', 'aria-modal': 'true' });
  const api = { el: box, onClose, closed: false, close() { if (api.closed || !box.isConnected) return; api.closed = true; openSheets--; if (openSheets <= 0) { openSheets = 0; document.body.style.overflow = ''; } leave(backdrop, box); api.onClose && api.onClose(); } };
  if (dismissable) backdrop.addEventListener('click', api.close);
  box.append(h('div', { class: 'grab' }));
  if (title || closeLabel) box.append(h('div', { class: 'sheet-head' }, h('h2', null, title || ''), closeLabel ? h('button', { class: 'icon-btn plain', 'aria-label': 'Close', onClick: api.close }, icon('x')) : null));
  const body = h('div', { class: 'sheet-body' }); append(body, typeof content === 'function' ? content(api) : content); box.append(body);
  if (actions) { const a = h('div', { class: 'actions' }); append(a, typeof actions === 'function' ? actions(api) : actions); box.append(a); }
  root.append(backdrop, box); openSheets++; document.body.style.overflow = 'hidden';
  dragToClose(box, api);
  return api;
}
export function confirmSheet(message, { ok = 'Yes', danger = false, title = 'Are you sure?' } = {}) {
  return new Promise((res) => {
    const s = sheet({ title, content: h('p', { style: { fontSize: '15px', color: 'var(--ink-2)' } }, message), onClose: () => res(false),
      actions: (api) => [h('button', { class: 'btn', onClick: () => { api.close(); } }, 'Cancel'), h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onClick: () => { if (danger) haptic('warn'); res(true); api.onClose = null; api.close(); } }, ok)] });
    const orig = s.close; s.close = () => { orig(); };
  });
}

// ---- toasts ----
export function toast(msg, { action, onAction, undo, ms = 2800, kind } = {}) {
  if (undo) { action = 'Undo'; onAction = undo; }
  const root = document.getElementById('toasts');
  while (root.children.length >= 3) root.firstChild.remove(); // a burst of quick logs stacks, it never piles up over the UI
  const t = h('div', { class: 'toast' + (kind ? ' ' + kind : '') }, kind === 'success' ? h('span', { class: 'ok' }, icon('check', 16)) : null, h('span', { class: 'msg' }, msg), action ? h('button', { onClick: () => { onAction && onAction(); t.remove(); } }, action) : null);
  root.append(t);
  setTimeout(() => { if (!t.isConnected) return; if (prefersReducedMotion()) return t.remove(); t.classList.add('mo-out'); setTimeout(() => t.remove(), 200); }, ms);
  return t;
}
export function promptSheet(title, value = '', { placeholder = '', ok = 'Save' } = {}) {
  return new Promise((res) => {
    const input = h('input', { type: 'text', value, placeholder, autocomplete: 'off' });
    const s = sheet({ title, content: input, onClose: () => res(null), actions: (api) => [h('button', { class: 'btn primary', onClick: () => { const v = input.value.trim(); res(v || null); api.onClose = null; api.close(); } }, ok)] });
    setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const v = input.value.trim(); res(v || null); s.onClose = null; s.close(); } });
  });
}
export function setActive(el, id) { if (el.classList.contains('seg')) return segSelect(el, id); [...el.children].forEach((b) => b.classList.toggle('on', b.dataset.id === String(id))); }

// ---- controls ----
export function segmented(options, value, onChange, cls = '') {
  const el = h('div', { class: 'seg ' + cls, role: 'tablist', style: { '--n': String(options.length), '--i': String(Math.max(0, options.findIndex((o) => o.id === value))) } });
  el.append(h('span', { class: 'seg-thumb', 'aria-hidden': 'true' }));
  options.forEach((o, i) => el.append(h('button', { class: o.id === value ? 'on' : '', role: 'tab', 'aria-selected': o.id === value ? 'true' : 'false', onClick: () => { segSelect(el, o.id); onChange(o.id); }, dataset: { id: o.id, i: String(i) } }, o.label)));
  return el;
}
// Move the thumb and the .on class to the option with this id (used by segmented() and by views that change value programmatically).
export function segSelect(el, id) {
  const btns = [...el.querySelectorAll('button[data-id]')];
  btns.forEach((b) => { const on = b.dataset.id === String(id); b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); if (on) el.style.setProperty('--i', b.dataset.i || '0'); });
}
export function chips(options, value, onChange) {
  const el = h('div', { class: 'chips' });
  for (const o of options) el.append(h('button', { class: 'chip' + (o.id === value ? ' on' : ''), dataset: { id: o.id }, onClick: () => { [...el.children].forEach((b) => b.classList.toggle('on', b.dataset.id === o.id)); onChange(o.id); } }, o.label));
  return el;
}
export function stepper({ value, min = 0, max = 9999, step = 1, onChange, decimals }) {
  const dec = decimals ?? (String(step).includes('.') ? String(step).split('.')[1].length : 0);
  const input = h('input', { type: 'number', inputmode: dec ? 'decimal' : 'numeric', enterkeyhint: 'done', value: (+value).toFixed(dec), step });
  const cur = () => parseFloat(input.value) || 0;
  const set = (v, snap = true, bump = true) => { v = Math.min(max, Math.max(min, snap ? Math.round(v / step) * step : v)); v = +v.toFixed(Math.max(dec, snap ? dec : 2)); input.value = String(v); onChange(v); if (bump) pulse(input, { scale: 1.1, ms: 260 }); };
  input.addEventListener('change', () => set(cur(), false, false));
  input.addEventListener('focus', () => input.select());
  // Tap = one step; press and hold repeats, and speeds up after a dozen steps (78.0 to 82.5 kg is a hold, not 45 taps).
  const btn = (label, text, dir) => {
    let t = 0, iv = 0, held = false, n = 0;
    const stop = () => { clearTimeout(t); clearInterval(iv); t = iv = 0; };
    const b = h('button', { type: 'button', 'aria-label': label, onClick: (e) => { if (held) { held = false; e.preventDefault(); return; } set(cur() + dir * step); } }, text);
    b.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; held = false; n = 0; stop(); t = setTimeout(() => { held = true; iv = setInterval(() => { n++; set(cur() + dir * step * (n > 12 ? 5 : 1), true, false); }, 85); }, 420); });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach((ev) => b.addEventListener(ev, stop));
    b.addEventListener('contextmenu', (e) => e.preventDefault());
    return b;
  };
  return h('div', { class: 'stepper' }, btn('Less', '−', -1), input, btn('More', '+', 1));
}
export function field(label, control, hint) { return h('div', { class: 'field' }, h('label', null, label), control, hint ? h('div', { class: 'hint' }, hint) : null); }
export function toggle(label, on, onChange, sub) {
  const sw = h('button', { class: 'switch' + (on ? ' on' : ''), role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': label });
  sw.addEventListener('click', () => { const now = !sw.classList.contains('on'); sw.classList.toggle('on', now); sw.setAttribute('aria-checked', now ? 'true' : 'false'); onChange(now); });
  return h('div', { class: 'toggle' }, h('div', null, h('div', { class: 'strong' }, label), sub ? h('div', { class: 'small muted' }, sub) : null), sw);
}
export function emptyState(title, sub, action, { ico } = {}) { return h('div', { class: 'empty' }, ico ? h('span', { class: 'mo-empty-ico' }, icon(ico, 22)) : null, h('b', null, title), sub, action ? h('div', { style: { marginTop: '12px' } }, action) : null); }


// ---- action sheet: a vertical list of actions ----
export function actionSheet(title, items, { sub } = {}) {
  return sheet({ title, content: (api) => h('div', null, sub ? h('p', { class: 'small muted', style: { marginBottom: '8px' } }, sub) : null,
    h('div', { class: 'stack', style: { gap: '2px' } }, items.filter(Boolean).map((it) => h('button', { class: 'menu-item' + (it.danger ? ' danger' : ''), onClick: () => { api.close(); it.onClick && it.onClick(); } },
      h('span', { class: 'well' + (it.cls ? ' ' + it.cls : '') }, icon(it.icon || 'more', 20)), h('span', { class: 'grow' }, h('div', null, it.label), it.sub ? h('div', { class: 'sub' }, it.sub) : null), it.trail ? h('span', { class: 'small muted' }, it.trail) : null)))) });
}

// ---- long press (fires once; a normal tap still clicks) ----
export function longPress(el, fn, ms = 550) {
  let t = 0, fired = false;
  const clear_ = () => { clearTimeout(t); t = 0; };
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; fired = false; clear_(); t = setTimeout(() => { fired = true; haptic(); fn(e); }, ms); });
  ['pointerup', 'pointercancel', 'pointerleave', 'pointermove'].forEach((ev) => el.addEventListener(ev, (e) => { if (ev === 'pointermove' && t && Math.hypot(e.movementX || 0, e.movementY || 0) < 6) return; clear_(); }));
  el.addEventListener('click', (e) => { if (fired) { e.stopPropagation(); e.preventDefault(); fired = false; } }, true);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  return el;
}

// ---- progress ring ----
// Returns a .ring element; the fill circle has class "fill" and is animated with motion.fill(el, pct, {axis:'ring', key}).
export function ring({ size = 120, stroke = 10, pct = 0, color = 'var(--accent)', track, children, cls = '' } = {}) {
  const r = (size - stroke) / 2, C = 2 * Math.PI * r;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`); svg.setAttribute('aria-hidden', 'true');
  const mk = (cl) => { const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); c.setAttribute('cx', size / 2); c.setAttribute('cy', size / 2); c.setAttribute('r', r); c.setAttribute('stroke-width', stroke); c.setAttribute('class', cl); return c; };
  const t = mk('track'); if (track) t.style.stroke = track;
  const f = mk('fill'); f.style.stroke = color; f.setAttribute('stroke-dasharray', C.toFixed(2)); f.setAttribute('stroke-dashoffset', (C * (1 - Math.max(0, Math.min(100, pct)) / 100)).toFixed(2));
  svg.append(t, f);
  const el = h('div', { class: 'ring ' + cls, style: { width: size + 'px', height: size + 'px' } }, svg, h('div', { class: 'ring-in' }, children));
  el.fillEl = f;
  return el;
}

// ---- display number with unit ----
export function hero(num, unit, { size = 'lg', cls = '' } = {}) { return h('div', { class: `num-${size} ${cls}` }, h('span', null, num), unit ? h('small', null, unit) : null); }

// ---- quick-log counter tile ----
// Tap the tile = +1 (onAdd). When count > 0 a small minus button sits top-left (onRemove). Long-press opens the entries (onOpen).
export function counterTile({ cls = '', ico, label, count = 0, sub, bad = false, onAdd, onRemove, onOpen, under, extra = '' }) {
  const b = h('button', { class: 'qt ' + (bad ? 'over ' : '') + extra, 'aria-label': `${label}${count ? `, ${count} today` : ''}. Tap to add one.` },
    under || null,
    count > 0 && onRemove ? h('span', { class: 'minus', role: 'button', 'aria-label': `Remove one ${label}`, onClick: (e) => { e.stopPropagation(); e.preventDefault(); haptic('warn'); onRemove(e); } }, icon('minus', 14)) : null,
    count > 0 ? h('span', { class: 'count' + (bad ? ' bad' : '') }, String(count)) : null,
    h('span', { class: 'well ' + cls }, icon(ico)), h('span', { class: 'lbl' }, label), sub ? h('span', { class: 'sub' }, sub) : null);
  b.addEventListener('click', (e) => { if (e.target.closest('.minus')) return; onAdd && onAdd(e); });
  if (onOpen) longPress(b, onOpen);
  return b;
}

// ---- formatting ----
export const fmt = (n, d = 0) => (n == null || isNaN(n) ? '–' : (+n).toLocaleString('en-IN', { maximumFractionDigits: d, minimumFractionDigits: 0 }));
export const fmtG = (n) => (n == null ? '–' : Math.round(n) + ' g');
export function fmtTime(ts) { const d = new Date(ts); let hh = d.getHours(); const ap = hh >= 12 ? 'pm' : 'am'; hh = hh % 12 || 12; return `${hh}:${String(d.getMinutes()).padStart(2, '0')} ${ap}`; }
export function fmtDur(sec) { sec = Math.max(0, Math.round(sec)); const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60; return hh ? `${hh}h ${String(mm).padStart(2, '0')}m` : mm ? `${mm}m ${String(ss).padStart(2, '0')}s` : `${ss}s`; }
export function fmtClock(sec) { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }
export function relTime(ts) {
  if (!ts) return 'never'; const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) { const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60); return `${hh}h ${mm}m ago`; }
  const d = Math.floor(s / 86400); return d === 1 ? '1 day ago' : `${d} days ago`;
}
export function sinceText(ts) {
  if (!ts) return '—'; const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${hh}h`; if (hh) return `${hh}h ${mm}m`; return `${mm}m`;
}
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDateLabel(key, todayKey) {
  const d = new Date(key + 'T12:00:00');
  if (key === todayKey) return 'Today';
  const y = new Date(todayKey + 'T12:00:00'); y.setDate(y.getDate() - 1);
  if (key === `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`) return 'Yesterday';
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
export function fmtShortDate(key) { const d = new Date(key + 'T12:00:00'); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; }
export function fmtDow(key) { return DAYS[new Date(key + 'T12:00:00').getDay()]; }
export function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename }); document.body.append(a); a.click(); setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1000);
}
export function pickFile(accept = 'application/json,.json') {
  return new Promise((res) => { const i = h('input', { type: 'file', accept, style: { display: 'none' } }); i.addEventListener('change', () => { const f = i.files[0]; i.remove(); if (!f) return res(null); const r = new FileReader(); r.onload = () => res(r.result); r.readAsText(f); }); document.body.append(i); i.click(); });
}
// kind: 'tap' (default) | 'success' | 'warn'. Android vibrates; iOS has no Vibration API, so a hidden <input switch> is toggled inside the
// user gesture, which gives the native switch tick on iOS 17.4+ (a silent no-op on older iOS and on desktop).
export const haptic = (kind = 'tap') => {
  try { if (navigator.vibrate) { if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return; navigator.vibrate(kind === 'warn' ? [18, 40, 18] : kind === 'success' ? [10, 30, 10] : 8); return; } } catch (e) { /* ignore */ }
  try {
    if (!/iPhone|iPad|iPod/.test(navigator.userAgent)) return;
    const tick = () => { const l = document.createElement('label'); l.setAttribute('aria-hidden', 'true'); l.style.display = 'none'; const i = document.createElement('input'); i.type = 'checkbox'; i.setAttribute('switch', ''); l.append(i); document.head.append(l); l.click(); l.remove(); };
    tick(); if (kind !== 'tap') setTimeout(tick, 70);
  } catch (e) { /* ignore */ }
};
// Calendar-day distance, in words: "today", "yesterday", "3 days ago".
export function ago(ts) {
  if (!ts) return 'never';
  const a = new Date(ts), b = new Date(); a.setHours(12, 0, 0, 0); b.setHours(12, 0, 0, 0);
  const d = Math.round((b - a) / 864e5);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}
