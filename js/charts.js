// Hand-rolled SVG charts: line (monotone-cubic, optional area), bars (rounded tops), stacked bars, sparkline, legend.
// Tooltips follow the finger or pointer. Intro animation plays on first render only (motion.js canIntro(); redraws inside
// quiet() skip it): lines draw in via pathLength, areas fade after, bars grow from the baseline with a 30 ms stagger.
// Colours are CSS tokens only (var(--p) etc.); extra chart CSS (.series-line dots, hover states) lives in css/progress.css.
import { canIntro, EASE_OUT, prefersReducedMotion, seen, recall, remember } from './motion.js';
const NS = 'http://www.w3.org/2000/svg';
const W = 340;
let gradSeq = 0;
const canAnim = () => !prefersReducedMotion() && typeof Element !== 'undefined' && typeof Element.prototype.animate === 'function';

const S = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (typeof v === 'string' && v.startsWith('var(')) e.style.setProperty(k, v); else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const txt = (x, y, s, attrs = {}) => S('text', { x, y, ...attrs }, s);
// one <defs> per svg, created on first use; helpers add gradients and blur filters to it
const defsOf = (svg) => svg._defs || (svg._defs = svg.insertBefore(S('defs'), svg.firstChild));
// Soft blur used for line glow, today-bar glow and ring caps. userSpaceOnUse so a flat (zero-height) path still gets a filter region.
function blurFilter(svg, std, w, h) {
  const id = 'cf' + (++gradSeq), f = S('filter', { id, filterUnits: 'userSpaceOnUse', x: -24, y: -24, width: w + 48, height: h + 48 }, S('feGaussianBlur', { stdDeviation: std }));
  defsOf(svg).append(f); return id;
}
// vertical gradient from a series colour (full) to the same colour faded, one per colour per chart
function barGrad(svg, color, top = 1, bottom = 0.5) {
  const cache = svg._grads || (svg._grads = new Map()), key = color + top + bottom;
  if (cache.has(key)) return cache.get(key);
  const id = 'cg' + (++gradSeq), g = S('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 }), a = S('stop', { offset: '0%' }), b = S('stop', { offset: '100%' });
  a.style.stopColor = color; a.style.stopOpacity = String(top); b.style.stopColor = color; b.style.stopOpacity = String(bottom);
  g.append(a, b); defsOf(svg).append(g); cache.set(key, `url(#${id})`); return `url(#${id})`;
}
const fmtDefault = (v) => String(Math.round(v));
const estW = (s) => String(s).length * 5.7 + 2;

function niceTicks(min, max, n = 3) {
  if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
  if (max === min) max = min + 1;
  const span = max - min, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || mag * 10;
  const lo = Math.floor(min / step + 1e-9) * step, hi = Math.ceil(max / step - 1e-9) * step;
  const ticks = []; for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return { lo, hi, ticks };
}

// ---- d3 curveMonotoneX port: a smooth curve that never overshoots the data (no false dips between points) ----
const sgn = (v) => (v < 0 ? -1 : 1);
export function smoothPath(pts) {
  const n = pts.length;
  if (!n) return '';
  const f = (v) => +v.toFixed(1);
  if (n === 1) return `M${f(pts[0][0])} ${f(pts[0][1])}`;
  if (n === 2) return `M${f(pts[0][0])} ${f(pts[0][1])}L${f(pts[1][0])} ${f(pts[1][1])}`;
  const m = new Array(n);
  for (let i = 1; i < n - 1; i++) {
    const h0 = pts[i][0] - pts[i - 1][0], h1 = pts[i + 1][0] - pts[i][0];
    const s0 = h0 ? (pts[i][1] - pts[i - 1][1]) / h0 : 0, s1 = h1 ? (pts[i + 1][1] - pts[i][1]) / h1 : 0;
    const p = h0 + h1 ? (s0 * h1 + s1 * h0) / (h0 + h1) : 0;
    m[i] = (sgn(s0) + sgn(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
  }
  const end = (a, b, t) => { const h = pts[b][0] - pts[a][0]; return h ? (3 * (pts[b][1] - pts[a][1]) / h - t) / 2 : t; };
  m[0] = end(0, 1, m[1]); m[n - 1] = end(n - 2, n - 1, m[n - 2]);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = (pts[i + 1][0] - pts[i][0]) / 3;
    d += `C${f(pts[i][0] + dx)} ${f(pts[i][1] + dx * m[i])} ${f(pts[i + 1][0] - dx)} ${f(pts[i + 1][1] - dx * m[i + 1])} ${f(pts[i + 1][0])} ${f(pts[i + 1][1])}`;
  }
  return d;
}
const polyPath = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('');
// consecutive non-null points form one segment (gaps in the data break the line)
function segments(pts) { const out = []; let cur = []; for (const p of pts) { if (p) cur.push(p); else if (cur.length) { out.push(cur); cur = []; } } if (cur.length) out.push(cur); return out; }

// ---- x axis labels: thinned to fit, the last one always shown, anything that would collide with it dropped ----
function xAxis(svg, items, y, xLabels) {
  const n = items.length; if (!n) return;
  // even spacing counted back from the newest point, so the last label is always there and none collide
  const wMax = Math.max(...items.map((it) => estW(it.label)));
  const px = n > 1 ? Math.abs(items[1].x - items[0].x) || 1 : 1;
  const step = Math.max(1, Math.ceil(n / Math.max(1, xLabels)), Math.ceil((wMax + 8) / px));
  for (let i = n - 1; i >= 0; i -= step) {
    const it = items[i], w = estW(it.label);
    let x = it.x, anchor = 'middle';
    if (x + w / 2 > W) { x = W; anchor = 'end'; } else if (x - w / 2 < 0) { x = 0; anchor = 'start'; }
    svg.append(txt(x, y, it.label, { 'text-anchor': anchor, class: it.hl ? 'x-hl' : null }));
  }
}

function tooltipLayer(svg) {
  const g = S('g', { class: 'tip', style: 'pointer-events:none', visibility: 'hidden' });
  const bg = S('rect', { class: 'tip-bg', rx: 13, ry: 13, height: 26 });
  const dot = S('circle', { class: 'tip-dot', r: 3.5, cy: 13 });
  const t = S('text', { class: 'tip-text', y: 17 });
  g.append(bg, dot, t); svg.append(g);
  let hideT = 0, shown = false;
  return {
    show(x, y, label, color) {
      clearTimeout(hideT);
      t.textContent = label;
      const was = shown; shown = true; g.setAttribute('visibility', 'visible');
      let w = 0; try { w = t.getComputedTextLength(); } catch (e) { /* not rendered */ }
      const lead = color ? 20 : 12;
      w = (w || label.length * 6.2) + lead + 12;
      const bx = Math.max(2, Math.min(W - w - 2, x - w / 2)); let by = y - 38; if (by < 0) by = y + 14;
      bg.setAttribute('x', bx); bg.setAttribute('width', w); bg.setAttribute('y', by);
      if (color) { dot.style.fill = color; dot.setAttribute('cx', bx + 13); dot.setAttribute('visibility', 'visible'); } else dot.setAttribute('visibility', 'hidden');
      t.setAttribute('x', bx + lead); t.setAttribute('y', by + 17);
      // the chip pops in when it first appears, then simply follows the finger
      if (!was && canAnim()) { g.style.transformBox = 'fill-box'; g.style.transformOrigin = '50% 100%'; g.animate([{ opacity: 0, transform: 'scale(.82) translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: EASE_OUT }); }
    },
    hide() { shown = false; g.setAttribute('visibility', 'hidden'); },
    // a finger lifts the moment you tap: keep the readout up for a moment so it can be read
    later(ms = 2200) { clearTimeout(hideT); hideT = setTimeout(() => { shown = false; g.setAttribute('visibility', 'hidden'); }, ms); },
  };
}

// pointer x in viewBox units (works for mouse, pen and touch; touch keeps reporting while the finger drags)
const pointerX = (svg, ev) => { const r = svg.getBoundingClientRect(); return (ev.clientX - r.left) * (W / (r.width || W)); };
function scrub(svg, { onAt, onEnd }) {
  const at = (ev) => onAt(pointerX(svg, ev));
  svg.addEventListener('pointerdown', at);
  svg.addEventListener('pointermove', at);
  const end = (ev) => onEnd(ev.pointerType === 'touch');
  svg.addEventListener('pointerleave', end); svg.addEventListener('pointerup', end); svg.addEventListener('pointercancel', end);
}

function grid(svg, ticks, sy, padL, padR, fmtY) {
  const g = S('g', { class: 'grid' });
  for (const tk of ticks) { g.append(S('line', { x1: padL, x2: W - padR, y1: sy(tk), y2: sy(tk) })); g.append(txt(padL - 6, sy(tk) + 3.5, fmtY(tk), { 'text-anchor': 'end' })); }
  svg.append(g);
}
const padLeft = (ticks, fmtY) => Math.max(24, Math.max(...ticks.map((t) => String(fmtY(t)).length)) * 5.9 + 10);
function targetTag(svg, y, text, padR) {
  svg.append(txt(W - padR - 2, y - 5, text, { class: 'tgt-lbl', 'text-anchor': 'end' }));
}

// ---------------------------------------------------------------------------------------------------------------
// series: [{name, color (css var), points:[{x:label, y}], dots, dash, width, opacity, line (false = dots only), smooth, end (halo + pulse + value chip on the last point), fmtEnd (text of that chip), glow:false (no blurred twin)}]
// clampTarget: keep the target line out of the y-domain (a far-off goal would squash the data); it is drawn at the edge as a label instead.
// smooth: monotone cubic (default). area: soft gradient under the first series. targetLabel: print the target value on the line.
export function lineChart({ series, target, height = 170, fmtY = fmtDefault, yMin, yMax, xLabels = 5, unit = '', clampTarget = false, smooth = true, area = false, targetLabel = false, label = 'Line chart' }) {
  const H = height, padR = 12, padT = 12, padB = 24;
  const allPts = series.flatMap((s) => s.points.filter((p) => p.y != null));
  const n = Math.max(...series.map((s) => s.points.length), 1);
  const ys = allPts.map((p) => p.y).concat(target != null && !clampTarget ? [target] : []);
  const intro = canIntro();
  const rawMin = yMin ?? (ys.length ? Math.min(...ys) : 0), rawMax = yMax ?? (ys.length ? Math.max(...ys) : 1);
  const padY = (rawMax - rawMin) * 0.14 || 1;
  const { lo, hi, ticks } = niceTicks(yMin ?? rawMin - padY, yMax ?? rawMax + padY, 3);
  const padL = padLeft(ticks, fmtY);
  const sx = (i) => padL + (n <= 1 ? (W - padL - padR) / 2 : (i / (n - 1)) * (W - padL - padR));
  const sy = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const base = H - padB;
  const svg = S('svg', { class: 'chart chart-line', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  grid(svg, ticks, sy, padL, padR, fmtY);
  const labels = series[0]?.points.map((p) => p.x) || [];
  xAxis(svg, labels.map((l, i) => ({ x: sx(i), label: String(l ?? '') })), H - 6, xLabels);
  if (target != null) {
    if (clampTarget && (target > hi || target < lo)) svg.append(txt(W - padR, target > hi ? padT + 11 : base - 5, `Goal ${fmtY(target)}${unit} ${target > hi ? '↑' : '↓'}`, { class: 'tgt-out', 'text-anchor': 'end' }));
    else {
      svg.append(S('line', { class: 'target-line', x1: padL, x2: W - padR, y1: sy(target), y2: sy(target) }));
      if (targetLabel) targetTag(svg, sy(target), typeof targetLabel === 'string' ? targetLabel : `Goal ${fmtY(target)}${unit}`, padR);
    }
  }
  let areaDone = false, drawMs = 0, glowId = null;
  const marks = []; // per series: [{x, y, color}] for the hover focus dots
  series.forEach((s, si) => {
    const pts = s.points.map((p, i) => (p.y == null ? null : [sx(i), sy(p.y)]));
    marks[si] = pts;
    const sm = s.smooth ?? smooth, segs = segments(pts), color = s.color || 'var(--accent-text)';
    const wantLine = s.line !== false;
    if (area && !areaDone && wantLine && segs.some((g) => g.length > 1)) {
      areaDone = true;
      const gid = 'cg' + (++gradSeq), grad = S('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.append(S('stop', { offset: '0%', 'stop-color': s.areaColor || color, 'stop-opacity': 0.35 }), S('stop', { offset: '60%', 'stop-color': s.areaColor || color, 'stop-opacity': 0.1 }), S('stop', { offset: '100%', 'stop-color': s.areaColor || color, 'stop-opacity': 0 }));
      defsOf(svg).append(grad);
      for (const g of segs) {
        if (g.length < 2) continue;
        const a = S('path', { class: 'area', d: `${sm ? smoothPath(g) : polyPath(g)}L${g[g.length - 1][0].toFixed(1)} ${base}L${g[0][0].toFixed(1)} ${base}Z`, fill: `url(#${gid})` });
        svg.append(a);
        if (intro) a.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: 380, easing: 'ease-out', fill: 'backwards' });
      }
    }
    if (wantLine) for (const g of segs) {
      if (g.length < 2) continue;
      const d = sm ? smoothPath(g) : polyPath(g), lw = s.width || 2.25;
      // soft glow: the same path, wider, 25 % opacity, blurred (SVG filter so it renders the same in Safari)
      let glow = null;
      if (!s.dash && s.glow !== false) { glowId ||= blurFilter(svg, 3, W, H); glow = S('path', { class: 'series-line series-glow', d, stroke: color, 'stroke-width': lw * 2.8, opacity: 0.25 * (s.opacity ?? 1), filter: `url(#${glowId})` }); svg.append(glow); }
      const path = S('path', { class: 'series-line', d, stroke: color, 'stroke-width': lw, 'stroke-dasharray': s.dash ? '4 4' : null, opacity: s.opacity ?? 1 });
      svg.append(path);
      if (intro) {
        if (s.dash) path.animate([{ opacity: 0 }, { opacity: s.opacity ?? 1 }], { duration: 400, delay: 200, fill: 'backwards' });
        else for (const el of glow ? [path, glow] : [path]) { el.setAttribute('pathLength', '1'); el.animate([{ strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDasharray: '1 1', strokeDashoffset: 0 }], { duration: 750, easing: EASE_OUT, fill: 'backwards' }); drawMs = 750; }
      }
    }
    if (s.dots) pts.forEach((pt, i) => {
      if (!pt) return;
      const dot = S('circle', { class: 'dot', cx: pt[0], cy: pt[1], r: s.dotR || 3.4, fill: color });
      svg.append(dot);
      if (intro) { dot.style.transformBox = 'fill-box'; dot.style.transformOrigin = 'center'; dot.animate([{ opacity: 0, transform: 'scale(.2)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 220, delay: Math.min(520, 140 + (i / Math.max(1, pts.length)) * 420), easing: EASE_OUT, fill: 'backwards' }); }
    });
    if (s.end) {
      const lastI = pts.map((p, i) => (p ? i : -1)).filter((i) => i >= 0).pop(), last = lastI != null ? pts[lastI] : null;
      if (last) {
        const delay = drawMs ? drawMs - 120 : 200;
        const pulse = S('circle', { class: 'end-pulse', cx: last[0], cy: last[1], r: 8, fill: color }), halo = S('circle', { class: 'end-halo', cx: last[0], cy: last[1], r: 9, fill: color }), dot = S('circle', { class: 'end-dot', cx: last[0], cy: last[1], r: 4.6, fill: color });
        svg.append(pulse, halo, dot);
        if (intro) for (const el of [halo, dot]) { el.style.transformBox = 'fill-box'; el.style.transformOrigin = 'center'; el.animate([{ opacity: 0, transform: 'scale(.2)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 320, delay, easing: EASE_OUT, fill: 'backwards' }); }
        // value pop: a small chip above the end point carrying the latest number
        if (s.endLabel !== false) {
          const text = s.fmtEnd ? s.fmtEnd(s.points[lastI].y) : `${fmtY(s.points[lastI].y)}${unit}`, tw = estW(text) + 12, bx = Math.max(2, Math.min(W - tw - 2, last[0] - tw / 2));
          let by = last[1] - 31; if (by < 2) by = last[1] + 14;
          const tag = S('g', { class: 'end-tag', style: 'pointer-events:none' }, S('rect', { x: bx, y: by, width: tw, height: 20, rx: 10, ry: 10, stroke: color }), txt(bx + tw / 2, by + 14, text, { class: 'end-tag-t', 'text-anchor': 'middle' }));
          svg.append(tag);
          if (intro) { tag.style.transformBox = 'fill-box'; tag.style.transformOrigin = '50% 100%'; tag.animate([{ opacity: 0, transform: 'translateY(6px) scale(.6)' }, { opacity: 1, transform: 'translateY(-2px) scale(1.08)', offset: 0.6 }, { opacity: 1, transform: 'none' }], { duration: 460, delay: delay + 140, easing: EASE_OUT, fill: 'backwards' }); }
        }
      }
    }
  });
  const hover = S('line', { class: 'hover-line', y1: padT, y2: base, visibility: 'hidden' });
  const focus = series.map((s) => S('circle', { class: 'focus-dot', r: 5, fill: s.color || 'var(--accent-text)', visibility: 'hidden' }));
  svg.append(hover, ...focus);
  const tip = tooltipLayer(svg);
  scrub(svg, {
    onAt(px) {
      let best = 0, bd = 1e9; for (let i = 0; i < n; i++) { const d = Math.abs(sx(i) - px); if (d < bd) { bd = d; best = i; } }
      const parts = series.map((s) => { const p = s.points[best]; return p && p.y != null && (s.line !== false || s.dots) ? `${s.name ? s.name + ' ' : ''}${fmtY(p.y)}${unit}` : null; }).filter(Boolean);
      if (!parts.length) { hover.setAttribute('visibility', 'hidden'); focus.forEach((f) => f.setAttribute('visibility', 'hidden')); return tip.hide(); }
      hover.setAttribute('x1', sx(best)); hover.setAttribute('x2', sx(best)); hover.setAttribute('visibility', 'visible');
      let topY = 1e9;
      series.forEach((s, si) => { const pt = marks[si][best]; if (pt) { focus[si].setAttribute('cx', pt[0]); focus[si].setAttribute('cy', pt[1]); focus[si].setAttribute('visibility', 'visible'); topY = Math.min(topY, pt[1]); } else focus[si].setAttribute('visibility', 'hidden'); });
      tip.show(sx(best), topY, `${labels[best]}: ${parts.join(' · ')}`, (series.find((x, i) => marks[i][best] && (x.line !== false || x.dots)) || {}).color);
    },
    onEnd(touch) { const off = () => { hover.setAttribute('visibility', 'hidden'); focus.forEach((f) => f.setAttribute('visibility', 'hidden')); tip.hide(); }; if (touch) { tip.later(); setTimeout(off, 2200); } else off(); },
  });
  return svg;
}

// ---------------------------------------------------------------------------------------------------------------
// bars: [{label, value, color, tip, hl}] — target draws a dashed line; values above target may use colorOver
const roundedBar = (x, base, y, bw, r) => { const rr = Math.max(0, Math.min(r, bw / 2, base - y)); return `M${x} ${base}V${y + rr}${rr ? `a${rr} ${rr} 0 0 1 ${rr} ${-rr}h${bw - 2 * rr}a${rr} ${rr} 0 0 1 ${rr} ${rr}` : `H${x + bw}`}V${base}Z`; };

export function barChart({ bars, target, height = 150, fmtY = fmtDefault, color = 'var(--p)', colorOver, yMax, xLabels = 7, targetLabel = false, label = 'Bar chart' }) {
  const H = height, padR = 8, padT = 12, padB = 22, n = bars.length || 1;
  const maxV = Math.max(yMax ?? 0, ...bars.map((b) => b.value || 0), target || 0, 1);
  const { hi, ticks } = niceTicks(0, maxV * 1.06, 3);
  const padL = padLeft(ticks, fmtY);
  const plotW = W - padL - padR, slot = plotW / n, bw = Math.max(3, Math.min(34, slot - 2));
  const sy = (v) => padT + (1 - v / (hi || 1)) * (H - padT - padB);
  const base = sy(0);
  const svg = S('svg', { class: 'chart chart-bars', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  grid(svg, ticks, sy, padL, padR, fmtY);
  const intro = canIntro();
  let glowId = null;
  const items = [], rects = [];
  bars.forEach((b, i) => {
    const x = padL + i * slot + (slot - bw) / 2, v = b.value || 0, y = sy(v);
    const fill = b.color || (colorOver && target != null && v > target ? colorOver : color);
    if (b.hl) svg.append(S('rect', { class: 'hl-bg', x: padL + i * slot, y: padT - 4, width: slot, height: H - padT - padB + 8, rx: 6 }));
    let rect = null;
    if (v > 0) {
      const d = roundedBar(x, base, Math.min(y, base - 2), bw, Math.min(5, bw / 2)), origin = `${x + bw / 2}px ${base}px`;
      // today's bar carries a soft glow (blurred twin under it) and a brighter gradient
      let glow = null;
      if (b.hl) { glowId ||= blurFilter(svg, 4, W, H); glow = S('path', { class: 'bar-glow', d, fill, opacity: 0.55, filter: `url(#${glowId})` }); svg.append(glow); }
      rect = S('path', { class: 'bar' + (b.hl ? ' hl' : ''), d, fill: barGrad(svg, fill, 1, b.hl ? 0.78 : 0.5) });
      svg.append(rect);
      if (intro) for (const el of glow ? [rect, glow] : [rect]) { el.style.transformOrigin = origin; el.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 420, delay: Math.min(i * 30, 480), easing: EASE_OUT, fill: 'backwards' }); }
    }
    rects[i] = rect;
    items.push({ x: x + bw / 2, label: b.label, hl: b.hl });
  });
  xAxis(svg, items, H - 6, xLabels);
  if (target != null) {
    svg.append(S('line', { class: 'target-line', x1: padL, x2: W - padR, y1: sy(target), y2: sy(target) }));
    if (targetLabel) targetTag(svg, sy(target), typeof targetLabel === 'string' ? targetLabel : `Target ${fmtY(target)}`, padR);
  }
  const tip = tooltipLayer(svg);
  let on = -1;
  const mark = (i) => { if (on >= 0 && rects[on]) rects[on].classList.remove('on'); on = i; if (i >= 0 && rects[i]) rects[i].classList.add('on'); svg.classList.toggle('has-hover', i >= 0 && !!rects[i]); };
  scrub(svg, {
    onAt(px) {
      const i = Math.max(0, Math.min(n - 1, Math.floor((px - padL) / slot))), b = bars[i];
      if (!b) return;
      mark(i);
      const v = b.value || 0;
      tip.show(padL + i * slot + slot / 2, sy(v), b.tip || `${b.label}: ${fmtY(v)}`, b.color || (colorOver && target != null && v > target ? colorOver : color));
    },
    onEnd(touch) { if (touch) { tip.later(); setTimeout(() => mark(-1), 2200); } else { mark(-1); tip.hide(); } },
  });
  return svg;
}

// groups: [{label, parts:{key: value}}], keys: [{key, label, color}]
export function stackedBarChart({ groups, keys, height = 160, fmtY = fmtDefault, xLabels = 7, label = 'Stacked bar chart' }) {
  const H = height, padR = 8, padT = 12, padB = 22, n = groups.length || 1;
  const totals = groups.map((g) => keys.reduce((a, k) => a + (g.parts[k.key] || 0), 0));
  const { hi, ticks } = niceTicks(0, Math.max(1, ...totals) * 1.06, 3);
  const padL = padLeft(ticks, fmtY);
  const plotW = W - padL - padR, slot = plotW / n, bw = Math.max(4, Math.min(34, slot - 4));
  const sy = (v) => padT + (1 - v / (hi || 1)) * (H - padT - padB);
  const svg = S('svg', { class: 'chart chart-bars', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label });
  grid(svg, ticks, sy, padL, padR, fmtY);
  const intro = canIntro(), cols = [], items = [];
  groups.forEach((g, i) => {
    const x = padL + i * slot + (slot - bw) / 2; let acc = 0;
    const col = S('g', { class: 'bar' });
    const live = keys.filter((k) => g.parts[k.key]);
    live.forEach((k, j) => {
      const v = g.parts[k.key]; const y0 = sy(acc), y1 = sy(acc + v); const top = j === live.length - 1;
      const hgt = Math.max(1.5, y0 - y1 - (top ? 0 : 1.5));
      col.append(S('path', { d: roundedBar(x, y0, y0 - hgt, bw, top ? Math.min(5, bw / 2) : 0), fill: barGrad(svg, k.color, 1, 0.62) }));
      acc += v;
    });
    svg.append(col); cols[i] = acc ? col : null;
    if (intro && acc) { col.style.transformOrigin = `${x + bw / 2}px ${sy(0)}px`; col.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 420, delay: Math.min(i * 30, 480), easing: EASE_OUT, fill: 'backwards' }); }
    items.push({ x: x + bw / 2, label: g.label });
  });
  xAxis(svg, items, H - 6, xLabels);
  const tip = tooltipLayer(svg);
  let on = -1;
  const mark = (i) => { if (on >= 0 && cols[on]) cols[on].classList.remove('on'); on = i; if (i >= 0 && cols[i]) cols[i].classList.add('on'); svg.classList.toggle('has-hover', i >= 0 && !!cols[i]); };
  scrub(svg, {
    onAt(px) {
      const i = Math.max(0, Math.min(n - 1, Math.floor((px - padL) / slot))), g = groups[i];
      if (!g) return;
      mark(i);
      const lead = keys.filter((k) => g.parts[k.key]).sort((a, c) => g.parts[c.key] - g.parts[a.key])[0];
      tip.show(padL + i * slot + slot / 2, sy(totals[i]), `${g.label}: ${keys.filter((k) => g.parts[k.key]).map((k) => `${k.label} ${fmtY(g.parts[k.key])}`).join(' · ') || '0'}`, lead && lead.color);
    },
    onEnd(touch) { if (touch) { tip.later(); setTimeout(() => mark(-1), 2200); } else { mark(-1); tip.hide(); } },
  });
  return svg;
}

// ---------------------------------------------------------------------------------------------------------------
// Tiny inline trend. points: numbers or {y}; null/undefined breaks the line. Fixed pixel size (default 84 x 28); fluid:true fills its parent's width at the same aspect ratio.
export function sparkline({ points = [], color = 'var(--accent-text)', height = 28, width = 84, area = true, strokeWidth = 2, fluid = false } = {}) {
  const vals = points.map((p) => (p == null ? null : typeof p === 'object' ? (p.y ?? null) : p));
  const real = vals.filter((v) => v != null && isFinite(v));
  const svg = S('svg', { class: 'spark' + (fluid ? ' fluid' : ''), viewBox: `0 0 ${width} ${height}`, width: fluid ? null : width, height: fluid ? null : height, 'aria-hidden': 'true' });
  if (real.length < 2) { svg.append(S('line', { class: 'spark-flat', x1: 2, x2: width - 2, y1: height / 2, y2: height / 2 })); return svg; }
  const mn = Math.min(...real), mx = Math.max(...real), span = mx - mn || 1, pad = 4;
  const n = vals.length;
  const yOf = (v) => (mx === mn ? height / 2 : pad + (1 - (v - mn) / span) * (height - 2 * pad - 2));
  const pts = vals.map((v, i) => (v == null ? null : [pad + (i / Math.max(1, n - 1)) * (width - 2 * pad), yOf(v)]));
  const segs = segments(pts), intro = canIntro();
  if (area) {
    const gid = 'cg' + (++gradSeq), grad = S('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(S('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.35 }), S('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
    defsOf(svg).append(grad);
    for (const g of segs) if (g.length > 1) { const a = S('path', { class: 'area', d: `${smoothPath(g)}L${g[g.length - 1][0].toFixed(1)} ${height}L${g[0][0].toFixed(1)} ${height}Z`, fill: `url(#${gid})` }); svg.append(a); if (intro) a.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: 300, fill: 'backwards' }); }
  }
  const glowId = segs.some((g) => g.length > 1) ? blurFilter(svg, 2.4, width, height) : null;
  for (const g of segs) {
    if (g.length < 2) continue;
    const d = smoothPath(g);
    const glow = S('path', { class: 'series-line series-glow', d, stroke: color, 'stroke-width': strokeWidth * 2.6, opacity: 0.25, filter: `url(#${glowId})` });
    const p = S('path', { class: 'series-line', d, stroke: color, 'stroke-width': strokeWidth });
    svg.append(glow, p);
    if (intro) for (const el of [glow, p]) { el.setAttribute('pathLength', '1'); el.animate([{ strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDasharray: '1 1', strokeDashoffset: 0 }], { duration: 600, easing: EASE_OUT, fill: 'backwards' }); }
  }
  const last = [...pts].reverse().find(Boolean);
  if (last) {
    const halo = S('circle', { class: 'end-halo', cx: last[0], cy: last[1], r: 5.4, fill: color }), d = S('circle', { class: 'end-dot', cx: last[0], cy: last[1], r: 2.6, fill: color });
    svg.append(halo, d);
    if (intro) for (const el of [halo, d]) { el.style.transformBox = 'fill-box'; el.style.transformOrigin = 'center'; el.animate([{ opacity: 0, transform: 'scale(.2)' }, { opacity: 1, transform: 'none' }], { duration: 260, delay: 520, easing: EASE_OUT, fill: 'backwards' }); }
  }
  return svg;
}

// items: [{label, color, dash, dot, line, value}]
export function legend(items) {
  const el = document.createElement('div'); el.className = 'chart-legend';
  for (const it of items) {
    const s = document.createElement('span'), i = document.createElement('i');
    if (it.dash) { i.className = 'lg-dash'; i.style.borderTopColor = it.color; } else if (it.line) { i.className = 'lg-line'; i.style.background = it.color; } else if (it.dot) { i.className = 'lg-dot'; i.style.background = it.color; } else i.style.background = it.color;
    s.append(i, it.label);
    if (it.value != null) { const b = document.createElement('b'); b.textContent = it.value; s.append(b); }
    el.append(s);
  }
  return el;
}

// ---------------------------------------------------------------------------------------------------------------
// Gradient progress ring with a glowing end-cap that rides the arc. Same shell as ui.ring() (.ring > svg + .ring-in), so app.css styles it.
// pct goes up to 200: the first lap uses the gradient, a second lap (past 100 %) is drawn lighter on top.
// paintRing(p) sets everything at once (dash offset + cap rotation, both CSS-transitionable); animateRing() drives it from rAF so the cap
// stays welded to the arc head. Colours are CSS tokens; color2 defaults to a lighter mix of color.
export function gradRing({ size = 100, stroke = 10, pct = 0, color = 'var(--accent)', color2, track, children, cls = '', cap = true, glow = true } = {}) {
  const r = (size - stroke) / 2, C = 2 * Math.PI * r, c = size / 2, id = 'gr' + (++gradSeq);
  const svg = S('svg', { viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' });
  svg.style.overflow = 'visible';
  const grad = S('linearGradient', { id: 'g' + id, x1: 0, y1: 0, x2: 1, y2: 1 }), a = S('stop', { offset: '0%' }), b = S('stop', { offset: '100%' });
  a.style.stopColor = color2 || `color-mix(in srgb, ${color} 55%, white)`; b.style.stopColor = color;
  grad.append(a, b);
  const blur = S('filter', { id: 'f' + id, filterUnits: 'userSpaceOnUse', x: -size * 0.3, y: -size * 0.3, width: size * 1.6, height: size * 1.6 }, S('feGaussianBlur', { stdDeviation: Math.max(1.6, stroke * 0.42) }));
  const capBlur = S('filter', { id: 'c' + id, filterUnits: 'userSpaceOnUse', x: -size * 0.3, y: -size * 0.3, width: size * 1.6, height: size * 1.6 }, S('feGaussianBlur', { stdDeviation: Math.max(1.2, stroke * 0.3) }));
  svg.append(S('defs', {}, grad, blur, capBlur));
  const circle = (cl, extra = {}) => S('circle', { cx: c, cy: c, r, class: cl, 'stroke-width': stroke, ...extra });
  const trackEl = circle('track'); if (track) trackEl.style.stroke = track;
  svg.append(trackEl);
  const glowEl = glow ? circle('glow', { fill: 'none', 'stroke-linecap': 'round', opacity: 0.4, filter: `url(#f${id})` }) : null;
  if (glowEl) { glowEl.style.stroke = color; svg.append(glowEl); }
  const fillEl = circle('fill', { stroke: `url(#g${id})` });
  const lapEl = circle('fill lap', { fill: 'none', 'stroke-linecap': 'round', opacity: 0 }); lapEl.style.stroke = `color-mix(in srgb, var(--ink) 38%, ${color})`;
  svg.append(fillEl, lapEl);
  // the cap sits at 3 o'clock inside a group that is rotated to the arc head (the whole svg is rotated -90deg by app.css, so 0deg = 12 o'clock on screen)
  let capEl = null;
  if (cap) {
    capEl = S('g', { class: 'cap', opacity: 0 });
    capEl.style.transformOrigin = '50% 50%'; capEl.style.transformBox = 'view-box';
    const halo = S('circle', { cx: c + r, cy: c, r: stroke * 0.78, filter: `url(#c${id})`, opacity: 0.95 }); halo.style.fill = color;
    const core = S('circle', { cx: c + r, cy: c, r: Math.max(1.4, stroke * 0.27), fill: 'white', opacity: 0.95 });
    capEl.append(halo, core); svg.append(capEl);
  }
  fillEl.setAttribute('stroke-dasharray', C.toFixed(2)); lapEl.setAttribute('stroke-dasharray', C.toFixed(2));
  glowEl && glowEl.setAttribute('stroke-dasharray', C.toFixed(2));
  const el = document.createElement('div');
  el.className = 'ring ' + cls; el.style.width = size + 'px'; el.style.height = size + 'px';
  const inner = document.createElement('div'); inner.className = 'ring-in';
  for (const k of [].concat(children || [])) if (k != null) inner.append(k.nodeType ? k : document.createTextNode(String(k)));
  el.append(svg, inner);
  el.fillEl = fillEl; el.glowEl = glowEl; el.capEl = capEl; el.lapEl = lapEl;
  el.paintRing = (p) => {
    p = Math.max(0, Math.min(200, p || 0));
    const one = Math.min(p, 100), two = Math.max(0, p - 100), off = (v) => (C * (1 - v / 100)).toFixed(2);
    // inline style (not attributes) so a CSS transition on stroke-dashoffset / transform can tween it (the rest-timer ring counts down that way)
    fillEl.style.strokeDashoffset = off(one); if (glowEl) glowEl.style.strokeDashoffset = off(one);
    lapEl.style.strokeDashoffset = off(two); lapEl.setAttribute('opacity', two > 0 ? 1 : 0);
    if (capEl) { const head = p > 100 ? p - 100 : p; capEl.style.transform = `rotate(${(head / 100 * 360).toFixed(2)}deg)`; capEl.setAttribute('opacity', p > 0.4 ? 1 : 0); }
  };
  el.paintRing(pct);
  return el;
}
// Move a gradRing to `pct`. Remembers the last value per `key` (like motion.fill) so a redraw continues from there; quiet redraws only
// animate when the value actually changed. Under reduced motion it just sets the final state.
export function animateRing(el, pct, { ms = 900, delay = 0, key } = {}) {
  if (!el || !el.paintRing) return;
  pct = Math.max(0, Math.min(200, +pct || 0));
  const prev = key != null && seen(key) ? recall(key) : 0;
  if (key != null) remember(key, pct);
  if (el._ringRaf) { cancelAnimationFrame(el._ringRaf); el._ringRaf = 0; }
  el.paintRing(prev); 
  if (!canAnim() || Math.abs(prev - pct) <= 0.5) { el.paintRing(pct); return; }
  const t0 = performance.now() + delay;
  const step = (now) => {
    if (!el.isConnected && now - t0 > 120) { el._ringRaf = 0; return; }
    const t = Math.max(0, Math.min(1, (now - t0) / ms)), e = 1 - Math.pow(1 - t, 4);
    el.paintRing(prev + (pct - prev) * e);
    el._ringRaf = t < 1 ? requestAnimationFrame(step) : 0;
  };
  el._ringRaf = requestAnimationFrame(step);
}
