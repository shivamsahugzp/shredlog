// Motion helpers. Everything here is transform/opacity (plus stroke-dashoffset for line charts), never layout,
// and every function is a no-op under prefers-reduced-motion. No imports: ui.js, charts.js and the views import this.

const mq = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
// In-app setting wins: data-motion="full" animates even when the OS asks for less, "reduced" never animates, "auto" follows the OS.
export const prefersReducedMotion = () => { const m = typeof document !== 'undefined' ? document.documentElement.getAttribute('data-motion') : null; if (m === 'reduced') return true; if (m === 'full') return false; return !!(mq && mq.matches); };
const canAnimate = () => !prefersReducedMotion() && typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';

export const EASE_OUT = 'cubic-bezier(.22,1,.36,1)';
export const EASE_SPRING = 'cubic-bezier(.2,.9,.25,1.15)';
export const EASE_IN = 'cubic-bezier(.4,0,1,1)';
export const EASE_SHEET = 'cubic-bezier(.32,.72,0,1)'; // Vaul's drawer curve
// Real spring easing as a CSS linear() curve (Safari 17.2+, Chrome 113+). duration in s, bounce 0..1. Falls back to EASE_SPRING.
// Settles in about 2x `d`, so use that as the transition/animation duration.
export function springEase(d = 0.5, b = 0.2, n = 40) {
  try { if (typeof CSS === 'undefined' || !CSS.supports('transition-timing-function', 'linear(0, 1)')) return EASE_SPRING; } catch (e) { return EASE_SPRING; }
  const w = 2 * Math.PI / d, z = Math.min(0.99, 1 - b), wd = w * Math.sqrt(1 - z * z), T = 2 * d;
  const f = (t) => 1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t));
  return `linear(${Array.from({ length: n + 1 }, (_, i) => (i === n ? 1 : +f((T * i) / n).toFixed(4))).join(',')})`;
}
export const SPRING_SOFT = springEase(0.4, 0.15); // toggles, thumbs, chips (barely bouncy); duration 800 ms
export const SPRING_POP = springEase(0.5, 0.3);   // PR / goal pops only (noticeable bounce); duration 1000 ms
// Durations (ms): micro taps, element enters, hero moments.
export const DUR = { micro: 150, enter: 260, hero: 520 };

// Last painted value per key. Views rebuild their DOM on every state change, so this is what lets a number
// tick from its previous value instead of replaying from zero, and what makes "first paint only" possible.
const mem = new Map();
export const seen = (key) => mem.has(key);
export const remember = (key, v = true) => { mem.set(key, v); return v; };
export const recall = (key, dflt) => (mem.has(key) ? mem.get(key) : dflt);
// True exactly once per key for the page session.
export function once(key) { if (mem.has(key)) return false; mem.set(key, true); return true; }

// While a view redraws because data changed (not because it was just opened) charts must not replay their intro.
let quietDepth = 0;
export function quiet(fn) { quietDepth++; try { return fn(); } finally { quietDepth--; } }
export const isQuiet = () => quietDepth > 0;
export const canIntro = () => canAnimate() && quietDepth === 0;

// ---- numbers ----
// Ease-out count. Writes text only; never reads layout. Falls back to the final text under reduced motion.
export function countUp(el, to, { from, ms = 400, fmt = (v) => String(Math.round(v)), key } = {}) {
  if (!el) return;
  if (el._moRaf) { cancelAnimationFrame(el._moRaf); el._moRaf = 0; }
  const start = from != null ? from : key != null && mem.has(key) ? mem.get(key) : 0;
  if (key != null) mem.set(key, to);
  if (!canAnimate() || ms <= 0 || !isFinite(start) || !isFinite(to) || Math.abs(start - to) < 1e-9) { el.textContent = fmt(to); return; }
  el.textContent = fmt(start);
  const t0 = performance.now();
  const step = (now) => {
    if (!el.isConnected && now - t0 > 100) { el._moRaf = 0; return; }
    const t = Math.min(1, (now - t0) / ms), e = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(t >= 1 ? to : start + (to - start) * e);
    el._moRaf = t < 1 ? requestAnimationFrame(step) : 0;
  };
  el._moRaf = requestAnimationFrame(step);
}

// ---- bars and rings ----
// The element is always laid out at its FINAL size (so a screenshot, a reduced-motion user or a failed animation
// is still correct); growth is a compositor transform that plays towards that size.
// axis: 'x' (width, default) | 'y' (height, grows from the bottom) | 'ring' (SVG circle, stroke-dashoffset)
export function fill(el, pct, { ms = 400, delay = 0, key, axis = 'x' } = {}) {
  if (!el) return;
  pct = Math.max(0, Math.min(100, +pct || 0));
  const prev = key != null && mem.has(key) ? mem.get(key) : 0;
  if (key != null) mem.set(key, pct);
  if (axis === 'ring') {
    const r = +el.getAttribute('r') || 20, C = 2 * Math.PI * r;
    el.setAttribute('stroke-dasharray', C.toFixed(2)); el.setAttribute('stroke-dashoffset', (C * (1 - pct / 100)).toFixed(2));
    if (canAnimate() && Math.abs(prev - pct) > 0.5) el.animate([{ strokeDashoffset: C * (1 - prev / 100) }, { strokeDashoffset: C * (1 - pct / 100) }], { duration: ms, delay, easing: EASE_OUT, fill: 'backwards' });
    return;
  }
  if (axis === 'y') el.style.height = pct + '%'; else el.style.width = pct + '%';
  if (!canAnimate() || pct <= 0 || Math.abs(prev - pct) < 0.5) return;
  const ratio = prev / pct; // <1 grows, >1 shrinks
  el.style.transformOrigin = axis === 'y' ? '50% 100%' : '0 50%';
  const sc = axis === 'y' ? 'scaleY' : 'scaleX';
  el.animate([{ transform: `${sc}(${ratio})` }, { transform: `${sc}(1)` }], { duration: ms, delay, easing: EASE_OUT, fill: 'backwards' });
}

// Animate every bar matched under `root` towards the width already written in its inline style (so no per-bar plumbing in the views).
export function growBars(root, selector, { key = 'bars', step = 18, maxDelay = 160, ms = 400 } = {}) {
  if (!root || !canAnimate()) return;
  root.querySelectorAll(selector).forEach((el, i) => {
    const pct = parseFloat(el.style.width);
    if (isNaN(pct)) return;
    fill(el, pct, { key: `${key}:${i}`, delay: Math.min(i * step, maxDelay), ms });
  });
}

// ---- emphasis ----
function ensureBox(el) { // transforms do nothing on inline boxes
  if (el instanceof HTMLElement && getComputedStyle(el).display === 'inline') el.style.display = 'inline-block';
}
export function pulse(el, { scale = 1.12, ms = 420 } = {}) {
  if (!el || !canAnimate()) return;
  ensureBox(el);
  el.animate([{ transform: 'scale(1)' }, { transform: `scale(${scale})`, offset: 0.35 }, { transform: 'scale(1)' }], { duration: ms, easing: EASE_OUT });
}
export function pop(el, { ms = 480 } = {}) {
  if (!el || !canAnimate()) return;
  ensureBox(el);
  el.animate([{ transform: 'scale(.6)', opacity: 0.2 }, { transform: 'scale(1.18)', opacity: 1, offset: 0.55 }, { transform: 'scale(1)', opacity: 1 }], { duration: ms, easing: EASE_SPRING });
}
// Touch ripple: one expanding circle from the tap point. The host needs position:relative; overflow:hidden (see motion.css .mo-ripple-host).
export function ripple(host, ev) {
  if (!host || !canAnimate()) return;
  const r = host.getBoundingClientRect();
  const x = ev && ev.clientX != null && (ev.clientX || ev.clientY) ? ev.clientX - r.left : r.width / 2;
  const y = ev && ev.clientY != null && (ev.clientX || ev.clientY) ? ev.clientY - r.top : r.height / 2;
  const d = Math.max(r.width, r.height) * 1.6;
  const s = document.createElement('span');
  s.className = 'mo-ripple'; s.style.cssText = `width:${d}px;height:${d}px;left:${x - d / 2}px;top:${y - d / 2}px`;
  host.append(s);
  const a = s.animate([{ transform: 'scale(.1)', opacity: 0.26 }, { transform: 'scale(1)', opacity: 0 }], { duration: 480, easing: 'ease-out' });
  a.onfinish = () => s.remove(); setTimeout(() => s.remove(), 700);
}

// ---- celebration ----
const PALETTE = {
  pr: ['--accent', '--p', '--f', '--c', '--fiber'],
  streak: ['--c', '--bad', '--accent', '--warn', '--c'],
  goal: ['--good', '--fiber', '--water', '--accent', '--p'],
};
// CSS-only confetti: 10 particles, one transform+opacity keyframe each, removed after 1.2 s. anchorEl may be null (screen top third).
export function celebrate(anchorEl, { kind = 'pr', count = 10 } = {}) {
  if (!canAnimate()) return;
  let cx = innerWidth / 2, cy = innerHeight * 0.33;
  if (anchorEl && anchorEl.getBoundingClientRect) { const r = anchorEl.getBoundingClientRect(); if (r.width || r.height) { cx = r.left + r.width / 2; cy = r.top + r.height / 2; } }
  const cols = PALETTE[kind] || PALETTE.pr, box = document.createElement('div');
  box.className = 'mo-burst'; box.setAttribute('aria-hidden', 'true'); box.style.cssText = `left:${cx}px;top:${cy}px`;
  const n = Math.max(8, Math.min(12, count));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + (i % 2 ? 0.25 : -0.15), dist = 46 + (i % 3) * 18;
    const p = document.createElement('i');
    p.style.cssText = `--dx:${Math.round(Math.cos(a) * dist)}px;--dy:${Math.round(Math.sin(a) * dist - 16)}px;--rot:${(i % 2 ? 1 : -1) * (120 + i * 37)}deg;--c:var(${cols[i % cols.length]});animation-delay:${(i % 4) * 25}ms`;
    if (i % 3 === 0) p.className = 'r';
    box.append(p);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 1200);
}


// ---- odometer: digits roll up/down like a mechanical counter (NumberFlow-style), only the digits that changed move ----
// el is a container; call again with a new value to animate. Uses the key memory so a redraw continues from the last value.
export function odometer(el, value, { fmt = (v) => String(Math.round(v)), key } = {}) {
  if (!el) return;
  const text = fmt(value);
  const prevText = key != null && mem.has('odo:' + key) ? mem.get('odo:' + key) : el.dataset.odo;
  if (key != null) mem.set('odo:' + key, text);
  el.dataset.odo = text;
  el.classList.add('mo-odo');
  if (!canAnimate() || prevText == null || prevText === text) { el.textContent = ''; for (const ch of text) el.append(digit(ch)); return; }
  // align right: compare from the end so "1,530" -> "1,480" only rolls the changed digits
  const a = [...prevText], b = [...text];
  el.textContent = '';
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < b.length; i++) {
    const ch = b[i], old = a[i - (b.length - a.length)];
    const d = digit(ch);
    if (old !== ch) {
      d.classList.add('in');
      if (old != null) { const o = digit(old); o.classList.add('out'); const wrap = document.createElement('span'); wrap.className = 'd'; wrap.style.position = 'relative'; wrap.append(d, o); d.classList.remove('d'); d.style.display = 'inline-block'; el.append(wrap); setTimeout(() => o.remove(), 320); continue; }
    }
    el.append(d);
  }
  void n;
}
function digit(ch) { const s = document.createElement('span'); s.className = 'd'; s.textContent = ch; return s; }

// ---- swipe a row sideways to reveal a destructive action (iOS Mail style) ----
// row: the element to wrap in place. onAction fires on a full swipe or a tap on the revealed button. Returns a teardown.
const swipeOpen = new Set();
if (typeof document !== 'undefined') document.addEventListener('pointerdown', (e) => { for (const fn of [...swipeOpen]) fn(e); }, { passive: true });
export function swipeReveal(row, { label = 'Delete', onAction, width = 96 } = {}) {
  if (!row || !row.parentNode) return () => {};
  const wrap = document.createElement('div'); wrap.className = 'mo-swipe';
  const act = document.createElement('button'); act.className = 'mo-swipe-act'; act.type = 'button'; act.textContent = label;
  const body = document.createElement('div'); body.className = 'mo-swipe-body';
  row.parentNode.insertBefore(wrap, row); body.append(row); wrap.append(act, body);
  let id = null, x0 = 0, y0 = 0, dx = 0, raw = 0, open = false, locked = false, dead = false, raf = 0;
  const paint = () => { raf = 0; body.style.transform = `translate3d(${dx}px,0,0)`; };
  const settle = (to) => { dx = to; open = to < 0; wrap.classList.toggle('open', open); if (canAnimate()) body.style.transition = 'transform .24s cubic-bezier(.22,1,.36,1)'; body.style.transform = `translate3d(${to}px,0,0)`; setTimeout(() => { body.style.transition = ''; if (!open) wrap.classList.remove('dragging'); }, 260); };
  const down = (e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; id = e.pointerId; x0 = e.clientX; y0 = e.clientY; raw = 0; locked = false; dead = false; body.style.transition = ''; };
  const move = (e) => {
    if (e.pointerId !== id || dead) return;
    const mx = e.clientX - x0 + (open ? -width : 0), my = e.clientY - y0;
    if (!locked) { if (Math.abs(my) > 8 && Math.abs(my) > Math.abs(mx - (open ? -width : 0))) { dead = true; return; } if (Math.abs(mx - (open ? -width : 0)) < 8) return; locked = true; wrap.classList.add('dragging'); }
    dx = Math.min(0, Math.max(-wrap.clientWidth, mx)); raw = dx; if (dx < -width) dx = -width - (-dx - width) * 0.25;
    if (!raf) raf = requestAnimationFrame(paint);
    e.preventDefault();
  };
  const up = (e) => {
    if (e.pointerId !== id) return; id = null; if (!locked) return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (raw < -wrap.clientWidth * 0.6) { settle(-wrap.clientWidth); setTimeout(() => onAction && onAction(), 120); }
    else if (dx < -width * 0.5) settle(-width); else settle(0);
    body.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); }, { capture: true, once: true });
  };
  body.addEventListener('pointerdown', down); body.addEventListener('pointermove', move); body.addEventListener('pointerup', up); body.addEventListener('pointercancel', up);
  act.addEventListener('click', () => { settle(-wrap.clientWidth); setTimeout(() => onAction && onAction(), 120); });
  // one document listener for every row: tapping anywhere else closes the open row; detached rows drop out of the set by themselves
  const closer = (e) => { if (!wrap.isConnected) { swipeOpen.delete(closer); return; } if (open && !wrap.contains(e.target)) settle(0); };
  swipeOpen.add(closer);
  return () => { swipeOpen.delete(closer); body.removeEventListener('pointerdown', down); body.removeEventListener('pointermove', move); body.removeEventListener('pointerup', up); body.removeEventListener('pointercancel', up); };
}

// ---- small attention shake (wrong PIN, invalid input) ----
export function shake(el) {
  if (!el || !canAnimate()) return;
  el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-4px)' }, { transform: 'translateX(0)' }], { duration: 360, easing: 'ease-out' });
}

// ---- lists ----
// First paint only: children fade/rise in with a 30 ms stagger (capped so a long list never takes more than ~400 ms).
export function stagger(listEl, { step = 30, key, rise = 8, ms = 220, max = 6 } = {}) {
  if (!listEl || !canAnimate()) return;
  if (key != null && !once('stagger:' + key)) return;
  const kids = [...listEl.children];
  kids.forEach((c, i) => {
    if (!c.animate) return;
    c.animate([{ opacity: 0, transform: `translateY(${rise}px)` }, { opacity: 1, transform: 'none' }], { duration: ms, delay: Math.min(i, max) * step, easing: EASE_OUT, fill: 'backwards' });
  });
}

// ---- horizontal swipe (Today day navigation) ----
// Attach to an element with touch-action: pan-y. Vertical scroll wins (the browser fires pointercancel), a drag follows the
// finger with resistance, and a release past `threshold` (or a quick flick) calls onSwipe(-1 | +1): -1 = finger moved right.
export function swipeNav(el, { onSwipe, canGo = () => true, threshold = 64, edge = 16 } = {}) {
  let id = null, x0 = 0, y0 = 0, t0 = 0, dx = 0, locked = false, dead = false, raf = 0, suppress = false;
  const blocked = (t) => !!(t && t.closest && t.closest('.chart, .chips, input, textarea, select, [data-no-swipe]'));
  const paint = () => { raf = 0; el.style.transform = `translate3d(${dx}px,0,0)`; el.style.opacity = String(1 - Math.min(0.35, Math.abs(dx) / 500)); };
  const reset = (animate) => {
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (animate && canAnimate()) {
      const a = el.animate([{ transform: `translate3d(${dx}px,0,0)`, opacity: el.style.opacity || 1 }, { transform: 'translate3d(0,0,0)', opacity: 1 }], { duration: 220, easing: EASE_OUT });
      a.onfinish = () => { el.style.transform = ''; el.style.opacity = ''; el.style.willChange = ''; };
    }
    el.style.transform = ''; el.style.opacity = ''; el.style.willChange = '';
  };
  const down = (e) => {
    if (id != null || (e.pointerType === 'mouse' && e.button !== 0) || blocked(e.target) || e.clientX < edge || e.clientX > innerWidth - edge) return;
    id = e.pointerId; x0 = e.clientX; y0 = e.clientY; t0 = performance.now(); dx = 0; locked = false; dead = false;
  };
  const move = (e) => {
    if (e.pointerId !== id || dead) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (!locked) {
      if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { dead = true; return; } // vertical scroll dominates: stand down
      if (Math.abs(mx) < 10 || Math.abs(mx) < Math.abs(my) * 1.4) return;
      locked = true; el.style.willChange = 'transform, opacity';
    }
    const dir = mx > 0 ? -1 : 1; // finger right => previous (-1)
    dx = canGo(dir) ? mx * 0.7 : mx * 0.18; // rubber band where there is nowhere to go
    if (!raf) raf = requestAnimationFrame(paint);
  };
  const up = (e) => {
    if (e.pointerId !== id) return;
    const wasLocked = locked; id = null;
    if (!wasLocked) return;
    suppress = true; setTimeout(() => { suppress = false; }, 350); // a drag must not also click the tile under the finger
    const dir = dx > 0 ? -1 : 1, v = Math.abs(dx) / Math.max(1, performance.now() - t0);
    if (canGo(dir) && (Math.abs(dx) > threshold || (v > 0.45 && Math.abs(dx) > 28))) {
      const off = (dx > 0 ? 1 : -1) * Math.min(innerWidth * 0.35, 140);
      if (canAnimate()) {
        const a = el.animate([{ transform: `translate3d(${dx}px,0,0)`, opacity: el.style.opacity || 1 }, { transform: `translate3d(${off}px,0,0)`, opacity: 0 }], { duration: 130, easing: 'ease-in', fill: 'forwards' });
        // The old view stays parked off-screen (fill: forwards) until the caller swaps it out, so there is no flash of it snapping back.
        a.onfinish = () => { try { onSwipe(dir); } finally { setTimeout(() => { if (el.isConnected) { a.cancel(); reset(false); } }, 400); } };
      } else { reset(false); onSwipe(dir); }
    } else reset(true);
  };
  const cancel = (e) => { if (e.pointerId !== id) return; id = null; if (locked) reset(true); locked = false; };
  el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel); el.addEventListener('lostpointercapture', cancel);
  el.addEventListener('click', (e) => { if (suppress) { e.stopPropagation(); e.preventDefault(); } }, true);
  return () => { el.removeEventListener('pointerdown', down); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', cancel); };
}
