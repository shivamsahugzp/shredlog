// Hand-rolled SVG charts: line (with trend/dots), bars (with target), stacked bars. Hover/tap tooltips.
const NS = 'http://www.w3.org/2000/svg';
const S = (tag, attrs = {}, ...kids) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v); for (const k of kids) if (k != null) e.append(k.nodeType ? k : document.createTextNode(k)); return e; };
const txt = (x, y, s, attrs = {}) => S('text', { x, y, ...attrs }, s);

function niceTicks(min, max, n = 4) {
  if (max === min) { max = min + 1; }
  const span = max - min, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || mag * 10;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = []; for (let v = lo; v <= hi + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return { lo, hi, ticks };
}

function tooltipLayer(svg, W, H) {
  const g = S('g', { class: 'tip', style: 'pointer-events:none', visibility: 'hidden' });
  const bg = S('rect', { class: 'tip-bg', rx: 6, ry: 6, height: 24 });
  const t = S('text', { class: 'tip-text', y: 16 });
  g.append(bg, t); svg.append(g);
  return {
    show(x, y, label) {
      t.textContent = label; g.setAttribute('visibility', 'visible');
      const w = t.getComputedTextLength ? t.getComputedTextLength() + 16 : label.length * 7 + 16;
      let bx = x - w / 2; bx = Math.max(2, Math.min(W - w - 2, bx)); let by = y - 32; if (by < 0) by = y + 10;
      bg.setAttribute('x', bx); bg.setAttribute('width', w); bg.setAttribute('y', by); t.setAttribute('x', bx + 8); t.setAttribute('y', by + 16);
    },
    hide() { g.setAttribute('visibility', 'hidden'); },
  };
}

// series: [{name, color (css var or hex), points:[{x:label, y}], dots, dash, width}]
export function lineChart({ series, target, height = 170, fmtY = (v) => String(Math.round(v)), yMin, yMax, xLabels = 5, unit = '' }) {
  const W = 360, H = height, padL = 36, padR = 10, padT = 10, padB = 24;
  const allPts = series.flatMap((s) => s.points.filter((p) => p.y != null));
  const n = Math.max(...series.map((s) => s.points.length), 1);
  const ys = allPts.map((p) => p.y).concat(target != null ? [target] : []);
  const rawMin = yMin ?? (ys.length ? Math.min(...ys) : 0), rawMax = yMax ?? (ys.length ? Math.max(...ys) : 1);
  const padY = (rawMax - rawMin) * 0.12 || 1;
  const { lo, hi, ticks } = niceTicks(yMin ?? rawMin - padY, yMax ?? rawMax + padY, 4);
  const sx = (i) => padL + (n <= 1 ? (W - padL - padR) / 2 : (i / (n - 1)) * (W - padL - padR));
  const sy = (v) => padT + (1 - (v - lo) / (hi - lo || 1)) * (H - padT - padB);
  const svg = S('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const grid = S('g', { class: 'grid' });
  for (const tk of ticks) { grid.append(S('line', { x1: padL, x2: W - padR, y1: sy(tk), y2: sy(tk) })); grid.append(txt(padL - 6, sy(tk) + 4, fmtY(tk), { 'text-anchor': 'end' })); }
  svg.append(grid);
  const labels = series[0]?.points.map((p) => p.x) || [];
  const every = Math.max(1, Math.ceil(n / xLabels));
  labels.forEach((l, i) => { if (i % every === 0 || i === n - 1) svg.append(txt(sx(i), H - 6, l, { 'text-anchor': i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle' })); });
  if (target != null) svg.append(S('line', { class: 'target-line', x1: padL, x2: W - padR, y1: sy(target), y2: sy(target) }));
  for (const s of series) {
    const pts = s.points.map((p, i) => (p.y == null ? null : [sx(i), sy(p.y)]));
    let d = '', pen = false;
    pts.forEach((pt) => { if (!pt) { pen = false; return; } d += (pen ? 'L' : 'M') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1); pen = true; });
    if (d) svg.append(S('path', { class: 'series-line', d, stroke: s.color, 'stroke-width': s.width || 2, 'stroke-dasharray': s.dash ? '4 4' : null, opacity: s.opacity ?? 1 }));
    if (s.dots) pts.forEach((pt) => pt && svg.append(S('circle', { cx: pt[0], cy: pt[1], r: 4, fill: s.color, stroke: 'var(--card)', 'stroke-width': 2 })));
  }
  const hover = S('line', { class: 'hover-line', y1: padT, y2: H - padB, visibility: 'hidden' }); svg.append(hover);
  const tip = tooltipLayer(svg, W, H);
  const onMove = (ev) => {
    const r = svg.getBoundingClientRect(); const px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) * (W / r.width);
    let best = 0, bd = 1e9; for (let i = 0; i < n; i++) { const d = Math.abs(sx(i) - px); if (d < bd) { bd = d; best = i; } }
    const parts = series.map((s) => { const p = s.points[best]; return p && p.y != null ? `${s.name ? s.name + ' ' : ''}${fmtY(p.y)}${unit}` : null; }).filter(Boolean);
    if (!parts.length) return tip.hide();
    hover.setAttribute('x1', sx(best)); hover.setAttribute('x2', sx(best)); hover.setAttribute('visibility', 'visible');
    const p0 = series.find((s) => s.points[best]?.y != null)?.points[best];
    tip.show(sx(best), sy(p0.y), `${labels[best]}: ${parts.join(' · ')}`);
  };
  const onLeave = () => { hover.setAttribute('visibility', 'hidden'); tip.hide(); };
  svg.addEventListener('pointermove', onMove); svg.addEventListener('pointerdown', onMove); svg.addEventListener('pointerleave', onLeave); svg.addEventListener('touchmove', (e) => { onMove(e); }, { passive: true });
  return svg;
}

// bars: [{label, value, color, tip}] — target draws a dashed line; values above target may use colorOver
export function barChart({ bars, target, height = 150, fmtY = (v) => String(Math.round(v)), color = 'var(--p)', colorOver, yMax, xLabels = 7 }) {
  const W = 360, H = height, padL = 34, padR = 8, padT = 10, padB = 22, n = bars.length || 1;
  const maxV = Math.max(yMax ?? 0, ...bars.map((b) => b.value || 0), target || 0, 1);
  const { hi, ticks } = niceTicks(0, maxV * 1.08, 3);
  const plotW = W - padL - padR, slot = plotW / n, bw = Math.max(3, Math.min(28, slot - 2));
  const sy = (v) => padT + (1 - v / (hi || 1)) * (H - padT - padB);
  const svg = S('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const grid = S('g', { class: 'grid' });
  for (const tk of ticks) { grid.append(S('line', { x1: padL, x2: W - padR, y1: sy(tk), y2: sy(tk) })); grid.append(txt(padL - 6, sy(tk) + 4, fmtY(tk), { 'text-anchor': 'end' })); }
  svg.append(grid);
  const every = Math.max(1, Math.ceil(n / xLabels));
  const tip = tooltipLayer(svg, W, H);
  bars.forEach((b, i) => {
    const x = padL + i * slot + (slot - bw) / 2, v = b.value || 0, y = sy(v), base = sy(0);
    const hgt = Math.max(0, base - y);
    const fill = b.color || (colorOver && target != null && v > target ? colorOver : color);
    const rect = S('path', { d: `M${x} ${base}V${y + Math.min(4, hgt)}a4 4 0 0 1 4-4h${bw - 8}a4 4 0 0 1 4 4V${base}Z`, fill, opacity: v ? 1 : 0 });
    const hit = S('rect', { x: padL + i * slot, y: padT, width: slot, height: H - padT - padB, fill: 'transparent' });
    const show = () => tip.show(x + bw / 2, y, b.tip || `${b.label}: ${fmtY(v)}`);
    hit.addEventListener('pointerenter', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', tip.hide);
    svg.append(rect, hit);
    if (i % every === 0 || i === n - 1) svg.append(txt(x + bw / 2, H - 6, b.label, { 'text-anchor': 'middle' }));
  });
  if (target != null) svg.append(S('line', { class: 'target-line', x1: padL, x2: W - padR, y1: sy(target), y2: sy(target) }));
  // tooltip must sit above the bars
  svg.append(svg.querySelector('.tip'));
  return svg;
}

// groups: [{label, parts:{key: value}}], keys: [{key, label, color}]
export function stackedBarChart({ groups, keys, height = 160, fmtY = (v) => String(Math.round(v)), xLabels = 7 }) {
  const W = 360, H = height, padL = 34, padR = 8, padT = 10, padB = 22, n = groups.length || 1;
  const totals = groups.map((g) => keys.reduce((a, k) => a + (g.parts[k.key] || 0), 0));
  const { hi, ticks } = niceTicks(0, Math.max(1, ...totals) * 1.08, 3);
  const plotW = W - padL - padR, slot = plotW / n, bw = Math.max(4, Math.min(30, slot - 3));
  const sy = (v) => padT + (1 - v / (hi || 1)) * (H - padT - padB);
  const svg = S('svg', { class: 'chart', viewBox: `0 0 ${W} ${H}`, role: 'img' });
  const grid = S('g', { class: 'grid' });
  for (const tk of ticks) { grid.append(S('line', { x1: padL, x2: W - padR, y1: sy(tk), y2: sy(tk) })); grid.append(txt(padL - 6, sy(tk) + 4, fmtY(tk), { 'text-anchor': 'end' })); }
  svg.append(grid);
  const tip = tooltipLayer(svg, W, H);
  const every = Math.max(1, Math.ceil(n / xLabels));
  groups.forEach((g, i) => {
    const x = padL + i * slot + (slot - bw) / 2; let acc = 0;
    keys.forEach((k) => { const v = g.parts[k.key] || 0; if (!v) return; const y0 = sy(acc), y1 = sy(acc + v); svg.append(S('rect', { x, y: y1 + 1, width: bw, height: Math.max(0, y0 - y1 - 2), fill: k.color, rx: 2 })); acc += v; });
    const hit = S('rect', { x: padL + i * slot, y: padT, width: slot, height: H - padT - padB, fill: 'transparent' });
    const show = () => tip.show(x + bw / 2, sy(acc), `${g.label}: ${keys.filter((k) => g.parts[k.key]).map((k) => `${k.label} ${fmtY(g.parts[k.key])}`).join(' · ') || '0'}`);
    hit.addEventListener('pointerenter', show); hit.addEventListener('pointerdown', show); hit.addEventListener('pointerleave', tip.hide);
    svg.append(hit);
    if (i % every === 0 || i === n - 1) svg.append(txt(x + bw / 2, H - 6, g.label, { 'text-anchor': 'middle' }));
  });
  svg.append(svg.querySelector('.tip'));
  return svg;
}

export function legend(items) {
  const el = document.createElement('div'); el.className = 'chart-legend';
  for (const it of items) { const s = document.createElement('span'); const i = document.createElement('i'); i.style.background = it.color; s.append(i, it.label); el.append(s); }
  return el;
}
