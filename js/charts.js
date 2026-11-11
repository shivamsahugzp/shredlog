// Hand-rolled SVG charts: line (monotone-cubic, optional area), bars (rounded tops), stacked bars, sparkline, legend.
// Tooltips follow the finger or pointer. Intro animation plays on first render only (motion.js canIntro(); redraws inside
// quiet() skip it): lines draw in via pathLength, areas fade after, bars grow from the baseline with a 30 ms stagger.
// Colours are CSS tokens only (var(--p) etc.); extra chart CSS (.series-line dots, hover states) lives in css/progress.css.
import { canIntro, EASE_OUT } from './motion.js';
const NS = 'http://www.w3.org/2000/svg';
const W = 340;
let gradSeq = 0;

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
  const bg = S('rect', { class: 'tip-bg', rx: 8, ry: 8, height: 24 });
  const t = S('text', { class: 'tip-text', y: 16 });
  g.append(bg, t); svg.append(g);
  let hideT = 0;
  return {
    show(x, y, label) {
      clearTimeout(hideT);
      t.textContent = label; g.setAttribute('visibility', 'visible');
      let w = 0; try { w = t.getComputedTextLength(); } catch (e) { /* not rendered */ }
      w = (w || label.length * 6.2) + 16;
      const bx = Math.max(2, Math.min(W - w - 2, x - w / 2)); let by = y - 34; if (by < 0) by = y + 12;
      bg.setAttribute('x', bx); bg.setAttribute('width', w); bg.setAttribute('y', by); t.setAttribute('x', bx + 8); t.setAttribute('y', by + 16);
    },
    hide() { g.setAttribute('visibility', 'hidden'); },
    // a finger lifts the moment you tap: keep the readout up for a moment so it can be read
    later(ms = 2200) { clearTimeout(hideT); hideT = setTimeout(() => g.setAttribute('visibility', 'hidden'), ms); },
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
// series: [{name, color (css var), points:[{x:label, y}], dots, dash, width, opacity, line (false = dots only), smooth, end (halo on last point)}]
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
  let areaDone = false, drawMs = 0;
  const marks = []; // per series: [{x, y, color}] for the hover focus dots
  series.forEach((s, si) => {
    const pts = s.points.map((p, i) => (p.y == null ? null : [sx(i), sy(p.y)]));
    marks[si] = pts;
    const sm = s.smooth ?? smooth, segs = segments(pts), color = s.color || 'var(--accent-text)';
    const wantLine = s.line !== false;
    if (area && !areaDone && wantLine && segs.some((g) => g.length > 1)) {
      areaDone = true;
      const gid = 'cg' + (++gradSeq), defs = S('defs'), grad = S('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
      grad.append(S('stop', { offset: '0%', 'stop-color': s.areaColor || color, 'stop-opacity': 0.30 }), S('stop', { offset: '100%', 'stop-color': s.areaColor || color, 'stop-opacity': 0 }));
      defs.append(grad); svg.append(defs);
      for (const g of segs) {
        if (g.length < 2) continue;
        const a = S('path', { class: 'area', d: `${sm ? smoothPath(g) : polyPath(g)}L${g[g.length - 1][0].toFixed(1)} ${base}L${g[0][0].toFixed(1)} ${base}Z`, fill: `url(#${gid})` });
        svg.append(a);
        if (intro) a.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 500, delay: 380, easing: 'ease-out', fill: 'backwards' });
      }
    }
    if (wantLine) for (const g of segs) {
      if (g.length < 2) continue;
      const path = S('path', { class: 'series-line', d: sm ? smoothPath(g) : polyPath(g), stroke: color, 'stroke-width': s.width || 2.25, 'stroke-dasharray': s.dash ? '4 4' : null, opacity: s.opacity ?? 1 });
      svg.append(path);
      if (intro) {
        if (s.dash) path.animate([{ opacity: 0 }, { opacity: s.opacity ?? 1 }], { duration: 400, delay: 200, fill: 'backwards' });
        else { path.setAttribute('pathLength', '1'); path.animate([{ strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDasharray: '1 1', strokeDashoffset: 0 }], { duration: 750, easing: EASE_OUT, fill: 'backwards' }); drawMs = 750; }
      }
    }
    if (s.dots) pts.forEach((pt, i) => {
      if (!pt) return;
      const dot = S('circle', { class: 'dot', cx: pt[0], cy: pt[1], r: s.dotR || 3.4, fill: color });
      svg.append(dot);
      if (intro) { dot.style.transformBox = 'fill-box'; dot.style.transformOrigin = 'center'; dot.animate([{ opacity: 0, transform: 'scale(.2)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 220, delay: Math.min(520, 140 + (i / Math.max(1, pts.length)) * 420), easing: EASE_OUT, fill: 'backwards' }); }
    });
    if (s.end) {
      const last = [...pts].reverse().find(Boolean);
      if (last) {
        const halo = S('circle', { class: 'end-halo', cx: last[0], cy: last[1], r: 9, fill: color }), dot = S('circle', { class: 'end-dot', cx: last[0], cy: last[1], r: 4.6, fill: color });
        svg.append(halo, dot);
        if (intro) for (const el of [halo, dot]) { el.style.transformBox = 'fill-box'; el.style.transformOrigin = 'center'; el.animate([{ opacity: 0, transform: 'scale(.2)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 320, delay: drawMs ? drawMs - 120 : 200, easing: EASE_OUT, fill: 'backwards' }); }
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
      tip.show(sx(best), topY, `${labels[best]}: ${parts.join(' · ')}`);
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
  const tip = tooltipLayer(svg);
  const intro = canIntro();
  const items = [], rects = [];
  bars.forEach((b, i) => {
    const x = padL + i * slot + (slot - bw) / 2, v = b.value || 0, y = sy(v);
    const fill = b.color || (colorOver && target != null && v > target ? colorOver : color);
    if (b.hl) svg.append(S('rect', { class: 'hl-bg', x: padL + i * slot, y: padT - 4, width: slot, height: H - padT - padB + 8, rx: 6 }));
    let rect = null;
    if (v > 0) {
      rect = S('path', { class: 'bar', d: roundedBar(x, base, Math.min(y, base - 2), bw, Math.min(5, bw / 2)), fill });
      svg.append(rect);
      if (intro) { rect.style.transformOrigin = `${x + bw / 2}px ${base}px`; rect.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 420, delay: Math.min(i * 30, 480), easing: EASE_OUT, fill: 'backwards' }); }
    }
    rects[i] = rect;
    items.push({ x: x + bw / 2, label: b.label, hl: b.hl });
  });
  xAxis(svg, items, H - 6, xLabels);
  if (target != null) {
    svg.append(S('line', { class: 'target-line', x1: padL, x2: W - padR, y1: sy(target), y2: sy(target) }));
    if (targetLabel) targetTag(svg, sy(target), typeof targetLabel === 'string' ? targetLabel : `Target ${fmtY(target)}`, padR);
  }
  let on = -1;
  const mark = (i) => { if (on >= 0 && rects[on]) rects[on].classList.remove('on'); on = i; if (i >= 0 && rects[i]) rects[i].classList.add('on'); svg.classList.toggle('has-hover', i >= 0 && !!rects[i]); };
  scrub(svg, {
    onAt(px) {
      const i = Math.max(0, Math.min(n - 1, Math.floor((px - padL) / slot))), b = bars[i];
      if (!b) return;
      mark(i);
      tip.show(padL + i * slot + slot / 2, sy(b.value || 0), b.tip || `${b.label}: ${fmtY(b.value || 0)}`);
    },
    onEnd(touch) { if (touch) { tip.later(); setTimeout(() => mark(-1), 2200); } else { mark(-1); tip.hide(); } },
  });
  svg.append(svg.querySelector('.tip')); // tooltip sits above the bars
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
  const tip = tooltipLayer(svg);
  const intro = canIntro(), cols = [], items = [];
  groups.forEach((g, i) => {
    const x = padL + i * slot + (slot - bw) / 2; let acc = 0;
    const col = S('g', { class: 'bar' });
    const live = keys.filter((k) => g.parts[k.key]);
    live.forEach((k, j) => {
      const v = g.parts[k.key]; const y0 = sy(acc), y1 = sy(acc + v); const top = j === live.length - 1;
      const hgt = Math.max(1.5, y0 - y1 - (top ? 0 : 1.5));
      col.append(S('path', { d: roundedBar(x, y0, y0 - hgt, bw, top ? Math.min(5, bw / 2) : 0), fill: k.color }));
      acc += v;
    });
    svg.append(col); cols[i] = acc ? col : null;
    if (intro && acc) { col.style.transformOrigin = `${x + bw / 2}px ${sy(0)}px`; col.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }], { duration: 420, delay: Math.min(i * 30, 480), easing: EASE_OUT, fill: 'backwards' }); }
    items.push({ x: x + bw / 2, label: g.label });
  });
  xAxis(svg, items, H - 6, xLabels);
  let on = -1;
  const mark = (i) => { if (on >= 0 && cols[on]) cols[on].classList.remove('on'); on = i; if (i >= 0 && cols[i]) cols[i].classList.add('on'); svg.classList.toggle('has-hover', i >= 0 && !!cols[i]); };
  scrub(svg, {
    onAt(px) {
      const i = Math.max(0, Math.min(n - 1, Math.floor((px - padL) / slot))), g = groups[i];
      if (!g) return;
      mark(i);
      tip.show(padL + i * slot + slot / 2, sy(totals[i]), `${g.label}: ${keys.filter((k) => g.parts[k.key]).map((k) => `${k.label} ${fmtY(g.parts[k.key])}`).join(' · ') || '0'}`);
    },
    onEnd(touch) { if (touch) { tip.later(); setTimeout(() => mark(-1), 2200); } else { mark(-1); tip.hide(); } },
  });
  svg.append(svg.querySelector('.tip'));
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
    const gid = 'cg' + (++gradSeq), defs = S('defs'), grad = S('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    grad.append(S('stop', { offset: '0%', 'stop-color': color, 'stop-opacity': 0.28 }), S('stop', { offset: '100%', 'stop-color': color, 'stop-opacity': 0 }));
    defs.append(grad); svg.append(defs);
    for (const g of segs) if (g.length > 1) { const a = S('path', { class: 'area', d: `${smoothPath(g)}L${g[g.length - 1][0].toFixed(1)} ${height}L${g[0][0].toFixed(1)} ${height}Z`, fill: `url(#${gid})` }); svg.append(a); if (intro) a.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay: 300, fill: 'backwards' }); }
  }
  for (const g of segs) {
    if (g.length < 2) continue;
    const p = S('path', { class: 'series-line', d: smoothPath(g), stroke: color, 'stroke-width': strokeWidth });
    svg.append(p);
    if (intro) { p.setAttribute('pathLength', '1'); p.animate([{ strokeDasharray: '1 1', strokeDashoffset: 1 }, { strokeDasharray: '1 1', strokeDashoffset: 0 }], { duration: 600, easing: EASE_OUT, fill: 'backwards' }); }
  }
  const last = [...pts].reverse().find(Boolean);
  if (last) { const d = S('circle', { class: 'end-dot', cx: last[0], cy: last[1], r: 2.6, fill: color }); svg.append(d); if (intro) d.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 520, fill: 'backwards' }); }
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
