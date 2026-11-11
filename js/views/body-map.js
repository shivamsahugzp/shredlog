// Interactive anatomical body map (front + back figures) used by the Train tab.
// Select mode: tap a muscle to toggle it. Heat mode: muscles are tinted 0..1 and not tappable.
// Muscle shapes are drawn once for the right-hand side of each figure and mirrored for the left; both sides carry the same data-muscle.
import { h } from '../ui.js';
import { MUSCLE_GROUPS } from '../insights.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const W = 150, H = 330;
const TRAIN_ORDER = (m) => Math.max(0, ['chest', 'front delts', 'side delts', 'rear delts', 'biceps', 'triceps', 'forearms', 'abs', 'obliques', 'hip flexors', 'lats', 'upper back', 'traps', 'lower back', 'glutes', 'quads', 'hamstrings', 'adductors', 'calves'].indexOf(m));

// ---------- vocabulary ----------
export const MUSCLES = ['chest', 'front delts', 'side delts', 'rear delts', 'biceps', 'triceps', 'forearms', 'abs', 'obliques', 'hip flexors', 'lats', 'upper back', 'traps', 'lower back', 'glutes', 'quads', 'hamstrings', 'adductors', 'calves'];
export const MUSCLE_LABELS = Object.fromEntries(MUSCLES.map((m) => [m, m.charAt(0).toUpperCase() + m.slice(1)]));
// coarse group → CSS colour token (same fixed order as the Progress tab: Chest, Back, Shoulders, Arms, Legs, Core)
export const GROUP_VAR = { Chest: '--g1', Back: '--g2', Shoulders: '--g3', Arms: '--g4', Legs: '--g5', Core: '--g6' };
export const GROUP_FALLBACK = { Chest: '#2a78d6', Back: '#eb6834', Shoulders: '#1baf7a', Arms: '#eda100', Legs: '#e87ba4', Core: '#6250d6' };
export const groupOf = (muscle) => MUSCLE_GROUPS[muscle] || null;
export const groupColor = (group) => (GROUP_VAR[group] ? `var(${GROUP_VAR[group]}, ${GROUP_FALLBACK[group]})` : 'var(--muted)');
export const muscleColor = (muscle) => groupColor(groupOf(muscle));
// exercise `cat` (category) → coarse group
const CAT_GROUP = { Chest: 'Chest', Back: 'Back', Shoulders: 'Shoulders', Biceps: 'Arms', Triceps: 'Arms', Forearms: 'Arms', Quads: 'Legs', Hamstrings: 'Legs', Glutes: 'Legs', Calves: 'Legs', Core: 'Core' };
export const catGroup = (cat) => CAT_GROUP[cat] || MUSCLE_GROUPS[String(cat || '').toLowerCase()] || null;
export const catColor = (cat) => groupColor(catGroup(cat));
// exercise category → muscles to pre-select in the picker
const CAT_MUSCLES = { Chest: ['chest'], Shoulders: ['front delts', 'side delts', 'rear delts'], Back: ['lats', 'upper back', 'traps'], Biceps: ['biceps'], Triceps: ['triceps'], Forearms: ['forearms'], Quads: ['quads'], Hamstrings: ['hamstrings'], Glutes: ['glutes'], Calves: ['calves'], Core: ['abs', 'obliques'] };
export const musclesForCats = (cats) => [...new Set((cats || []).flatMap((c) => CAT_MUSCLES[c] || []))];

const FRONT_ONLY = new Set(['chest', 'front delts', 'side delts', 'biceps', 'abs', 'obliques', 'hip flexors', 'quads', 'adductors']);
const BACK_ONLY = new Set(['traps', 'rear delts', 'upper back', 'lats', 'lower back', 'triceps', 'glutes', 'hamstrings']);
// which single figure shows a muscle best ('front' | 'back')
export const viewFor = (muscle) => (BACK_ONLY.has(muscle) ? 'back' : 'front');

// ---------- geometry (150 x 330 viewBox; every path uses absolute M/L/C/Z so it can be mirrored) ----------
function mirror(d) {
  const t = d.match(/[MLCQZ]|-?\d*\.?\d+/g) || [];
  let n = 0;
  return t.map((s) => { if (/[A-Z]/.test(s)) { n = 0; return s; } const v = n++ % 2 === 0 ? W - parseFloat(s) : parseFloat(s); return String(+v.toFixed(2)); }).join(' ');
}
const rr = (x0, y0, x1, y1, r) => `M ${x0} ${y0 + r} C ${x0} ${y0} ${x0} ${y0} ${x0 + r} ${y0} L ${x1 - r} ${y0} C ${x1} ${y0} ${x1} ${y0} ${x1} ${y0 + r} L ${x1} ${y1 - r} C ${x1} ${y1} ${x1} ${y1} ${x1 - r} ${y1} L ${x0 + r} ${y1} C ${x0} ${y1} ${x0} ${y1} ${x0} ${y1 - r} Z`;

// Right-hand half of the body outline, from the top of the neck on the midline round to the crotch.
const CONTOUR_START = [75, 40];
const CONTOUR = [
  ['L', 82.5, 40], ['C', 82.5, 47, 83, 51.5, 86, 55.5],
  ['C', 94, 57.5, 104, 58.5, 114, 61],                                  // trapezius slope
  ['C', 121, 62, 125, 68, 125.5, 77], ['C', 126, 90, 125.5, 103, 125, 116], // shoulder cap, upper arm
  ['C', 125.5, 124, 129, 142, 133, 158], ['C', 134, 163, 135, 168, 136, 174], // forearm, wrist
  ['C', 138, 180, 138, 188, 135, 196], ['C', 133, 199, 129, 199, 128, 196],  // hand
  ['C', 127, 190, 126, 178, 125.5, 166], ['C', 124.5, 154, 119, 134, 113.5, 120], // inner forearm
  ['C', 111.5, 112, 108.5, 100, 106.5, 92],                              // inner upper arm to armpit
  ['C', 105.5, 102, 103.5, 120, 102, 138], ['C', 101.5, 148, 104, 160, 107, 168], // torso side, hip
  ['C', 110.5, 184, 110.5, 206, 106.5, 228], ['C', 104, 238, 101.5, 245, 100.8, 252], // thigh
  ['C', 102, 264, 102, 278, 98.5, 290], ['C', 96.5, 298, 93.8, 306, 92.8, 313],     // calf
  ['C', 93.6, 320, 97, 324, 98, 328], ['C', 96, 331, 86, 331, 83, 328],             // foot
  ['C', 82, 322, 82.5, 316, 83, 311], ['C', 83.5, 300, 84, 288, 83.5, 276],
  ['C', 83, 266, 82.5, 258, 82, 250], ['C', 81, 236, 78.5, 214, 77.5, 198],
  ['C', 76.5, 188, 75.5, 182, 75, 178],
];
function silhouette() {
  const nodes = [CONTOUR_START, ...CONTOUR.map((s) => s.slice(-2))];
  const fwd = CONTOUR.map((s) => s.join(' ').replace(/^(\w) /, '$1 ')).join(' ');
  const back = [];
  for (let i = CONTOUR.length - 1; i >= 0; i--) {
    const s = CONTOUR[i], to = nodes[i];
    const m = (x, y) => `${+(W - x).toFixed(2)} ${y}`;
    back.push(s[0] === 'L' ? `L ${m(to[0], to[1])}` : `C ${m(s[3], s[4])} ${m(s[1], s[2])} ${m(to[0], to[1])}`);
  }
  return `M ${CONTOUR_START.join(' ')} ${fwd} ${back.join(' ')} Z`;
}
const BODY = silhouette();
const HEAD = 'M 75 5 C 84.5 5 89.5 12.5 89.5 23 C 89.5 34 83.5 44 75 44.5 C 66.5 44 60.5 34 60.5 23 C 60.5 12.5 65.5 5 75 5 Z';

// Muscles: [name, right-hand path]. Outer edges overshoot the body outline slightly; the figure clips them to it.
const FOREARM = 'M 113.5 122 C 118 121.5 122.5 120.5 126.8 119.5 C 127.8 129 130.5 143 134 157 C 134.8 160 135.4 163 135.8 166.5 L 125.3 166.5 C 124.5 154 119.5 135 113.5 122 Z';
const FRONT = [
  ['chest', 'M 76 64.5 C 88 61 99 61.5 108 63.5 C 107 72 106.5 80 106.5 88 C 101 97.5 92 102.5 84 101.5 C 80.5 101 77.5 99.5 76 97.5 Z'],
  ['front delts', 'M 107.5 61 C 112.5 58.5 116.5 59.5 118 61.5 C 119 74 117.5 88 113.5 99.5 C 109.5 97.5 106.2 94 106 88 C 105.4 78 105.5 70 107.5 61 Z'],
  ['side delts', 'M 118 61.5 C 122.5 62.5 126.5 69 126.8 78 C 127 87 126 94 124.8 100.5 C 121.5 102.3 117 101.8 113.5 99.5 C 117.5 88 119 74 118 61.5 Z'],
  ['biceps', 'M 108.2 98.5 C 112.5 102 118.5 103.5 125.5 102 C 126.8 107 126.8 113 126.8 118.5 C 121.5 120 117 120.5 113.5 120.5 C 111.8 113 109.8 104 108.2 98.5 Z'],
  ['forearms', FOREARM],
  ['abs', [rr(77, 103.5, 92, 116.5, 4), rr(77.2, 118.6, 92.2, 131.2, 4), rr(77.4, 133.3, 91.6, 145.6, 4), rr(77.8, 147.7, 90.4, 158.6, 4)].join(' ')],
  ['obliques', 'M 93.6 105 C 97.5 104.5 102 102 106.8 98 C 107.8 110 104.8 124 103.8 138 C 103.2 148 105 156 107.5 162 C 102 162.5 97.5 161.5 93.6 159.5 Z'],
  ['hip flexors', 'M 78.5 162 C 84 164 88.5 163.5 92.6 161.5 C 98 162.5 103 164 108 166.5 C 108.8 169.5 109.3 171.5 109.5 173 C 101.5 175.5 92.5 179.5 85.5 184.5 C 81.5 178 79.5 170 78.5 162 Z'],
  ['adductors', 'M 75.8 182 C 79.5 182 83 183 85.5 184.5 C 88 196 88.5 214 85 237 C 83.5 238.5 82 238 81 236.5 C 79.5 224 77.8 208 76.5 196 C 76 191 75.6 186 75.8 182 Z'],
  ['quads', 'M 109.5 174 C 101.5 175.5 92.5 179.5 85.5 184.5 C 88 196 88.5 214 85 237 C 86.5 241.5 89 245 91.5 246.5 C 95 248 98.5 248 101 246.5 C 102.5 243 104.5 238 107 228 C 111.5 207 111.5 187 109.5 174 Z'],
  ['calves', 'M 85.5 253.5 C 90 251.5 96.5 251.5 101 253.5 C 103 265 103 279 99.5 291 C 97.5 298 95.5 304 94.3 309 C 90.5 310.5 87 310.5 84 309 C 84.5 298 84.8 288 84.2 277 C 83.7 267 84.2 259 85.5 253.5 Z'],
];
const BACK = [
  ['traps', 'M 75.6 43.5 C 79 43.5 82.5 45 83 48.5 C 83.2 51.5 84 53.5 86.5 55.5 C 94 57.5 104 58.5 114.5 60.8 C 110.5 66 103.5 71 96 77 C 88 84 80.5 94 75.6 107 Z'],
  ['rear delts', 'M 114.3 60.5 C 121.5 61.5 126.2 68 126.6 78 C 126.8 87 125.8 95 124.5 100.5 C 119 102.5 113 100 109 93.5 C 106.8 86.5 106.5 77 108.6 71 C 110 66.5 112 63 114.3 60.5 Z'],
  ['upper back', 'M 110.8 66 C 108.5 68.5 106 72 105.8 77 C 105.2 83 105 88 105.8 92.5 C 98 96.5 90 100 84.4 103 L 76.8 107 C 80 95 87 86 94.8 79 C 100 74 106 70 110.8 66 Z'],
  ['lats', 'M 106.5 93.8 C 99 98.8 92 101.5 85.5 104.2 C 86.2 108 86.6 112 86.8 118 C 87.2 128 87.2 135 87.2 140 C 87.2 145 87.8 148.5 88.8 151.5 C 93.5 151 98.5 150 103 149 C 103 146 102.8 142 102.6 138 C 104 120 105.8 103 106.8 93.8 Z'],
  ['lower back', 'M 76.4 109.5 C 80.5 109 83.5 111 84.4 115 C 85.4 121 85.4 128 85.4 134 C 85.4 142 85 148 85.8 152.8 C 82.5 154.5 79.5 154.5 76.4 153.2 Z'],
  ['triceps', 'M 108.2 96 C 113.5 101.5 119.5 103.8 125.5 102.5 C 126.8 108 126.8 113 126.8 119 C 121.5 120.8 117.2 121.3 113.6 121.5 C 111.5 113.5 109.5 104 108.2 96 Z'],
  ['forearms', FOREARM],
  ['glutes', 'M 76.4 152.5 C 85 149.5 97 150 104 157.5 C 108 162 110.5 168 110.8 176 C 111 185 108.5 191 103 194.5 C 98 197 91 197.5 85 195.5 C 80.5 194 77.5 190.5 76.4 186.5 C 76 175 76 162 76.4 152.5 Z'],
  ['hamstrings', 'M 76.6 190.5 C 82 197 92 200.5 100.5 198 C 104.5 196.5 108 194 111 190.5 C 111.2 205 108.8 218 106.3 229 C 104.2 238 101.8 244 101 248 C 96.5 249.5 91 249.5 85 247.5 C 83 245 82 242 81.2 237.5 C 79.5 224 77.5 206 76.6 190.5 Z'],
  ['calves', 'M 84.3 253.5 C 90 250.5 98 250.5 101.6 254.5 C 103.4 264 103 276 99.8 287 C 98.3 293 95.5 300 94.2 308.5 C 90.5 310.5 87 310.5 84 308.5 C 84.5 298 84.2 288 83.4 277 C 82.8 268 83.2 260 84.3 253.5 Z'],
];
/** Raw geometry for canvas drawing (share card): new Path2D(d) works on every string. Left and right sides are separate entries. */
export function bodyShapes() {
  const both = (defs) => defs.flatMap(([m, d]) => [[m, d], [m, mirror(d)]]);
  return { W, H, body: BODY, head: HEAD, front: both(FRONT), back: both(BACK) };
}
const DETAIL_FRONT = ['M 85.5 250 C 89 248.5 93.5 248.5 97.5 250 C 94 252.2 89 252.2 85.5 250 Z'];  // kneecap
const DETAIL_BACK = ['M 75 46 L 75 107', 'M 85 249.5 C 90 251.5 96 251.5 100.5 249.5'];             // spine, knee crease

// ---------- small helpers ----------
const svg = (tag, attrs, ...kids) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) el.setAttribute(k, v === true ? '' : v);
  for (const c of kids.flat()) if (c) el.append(c);
  return el;
};
let seq = 0;
const clamp01 = (v) => Math.max(0, Math.min(1, +v || 0));

/**
 * bodyMap({ selected, onToggle, heat, view, formatHeat })
 *  selected   array/Set of muscle names (select mode)
 *  onToggle   (muscle, nowSelected) => void
 *  heat       {muscle: 0..1} switches to heat mode (read-only tint, no toggling)
 *  view       'both' (default) | 'front' | 'back'
 *  formatHeat (muscle, value) => string shown after the name in the tap label (heat mode)
 * Returns a DOM element with setSelected(iterable), setHeat(obj) and getSelected().
 */
export function bodyMap({ selected = [], onToggle, heat = null, view = 'both', formatHeat } = {}) {
  const id = ++seq, isHeat = !!heat && typeof heat === 'object';
  const sel = new Set(selected || []);
  let heatNow = isHeat ? { ...heat } : null;
  const byMuscle = new Map();           // muscle → [path elements across both sides and figures]
  let tipTimer = 0;

  const tip = h('div', { class: 'bm-tip', 'aria-hidden': 'true' });
  const wrap = h('div', { class: 'bm-wrap bm-' + view + (isHeat ? ' bm-heat' : '') });

  const label = (m) => MUSCLE_LABELS[m] || m;
  function paint(m) {
    for (const p of byMuscle.get(m) || []) {
      if (isHeat) {
        const v = clamp01(heatNow[m]);
        p.classList.toggle('hot', v > 0);
        p.style.setProperty('--bm-o', String(+(0.22 + 0.78 * v).toFixed(2)));
      } else {
        const on = sel.has(m);
        p.classList.toggle('on', on);
        p.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }
  }
  function showTip(path, m) {
    const wr = wrap.getBoundingClientRect(), pr = path.getBoundingClientRect();
    let text = label(m);
    if (isHeat && formatHeat) { const extra = formatHeat(m, clamp01(heatNow[m])); if (extra) text += ' · ' + extra; }
    tip.textContent = text; tip.classList.add('on');
    const x = Math.max(44, Math.min(wr.width - 44, pr.left + pr.width / 2 - wr.left));
    tip.style.left = x + 'px'; tip.style.top = Math.max(14, pr.top - wr.top - 6) + 'px';
    clearTimeout(tipTimer); tipTimer = setTimeout(() => tip.classList.remove('on'), 1200);
  }
  function pulse(m) {
    for (const p of byMuscle.get(m) || []) { p.classList.remove('bm-pulse'); void p.getBoundingClientRect(); p.classList.add('bm-pulse'); }
  }
  function activate(path) {
    const m = path.dataset.muscle; if (!m) return;
    showTip(path, m);
    if (isHeat) return;
    const now = !sel.has(m);
    if (now) sel.add(m); else sel.delete(m);
    paint(m); pulse(m);
    if (onToggle) onToggle(m, now);
  }
  wrap.addEventListener('click', (e) => { const p = e.target.closest && e.target.closest('path[data-muscle]'); if (p && wrap.contains(p)) activate(p); });
  wrap.addEventListener('animationend', (e) => { if (e.target.classList) e.target.classList.remove('bm-pulse'); });
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const p = e.target.closest && e.target.closest('path[data-muscle]'); if (!p) return;
    e.preventDefault(); activate(p);
  });
  const focusSet = (e, on) => { const m = e.target.dataset && e.target.dataset.muscle; if (!m) return; for (const p of byMuscle.get(m) || []) if (p.closest('svg') === e.target.closest('svg')) p.classList.toggle('bm-focus', on); };
  wrap.addEventListener('focusin', (e) => { let vis = true; try { vis = e.target.matches(':focus-visible'); } catch (err) { /* old engines: always show */ } if (vis) focusSet(e, true); });
  wrap.addEventListener('focusout', (e) => focusSet(e, false));

  function figure(side) {
    const defs = side === 'front' ? FRONT : BACK;
    const clipId = `bm-clip-${id}-${side}`;
    const muscles = svg('g', { class: 'bm-muscles', 'clip-path': `url(#${clipId})` });
    const seen = new Set();
    for (const [m, d] of defs) {
      const first = !seen.has(m + side); seen.add(m + side);
      // one path per body side so left and right both carry data-muscle; only the first is a tab stop
      [d, mirror(d)].forEach((dd, i) => {
        const attrs = { d: dd, class: 'bm-p', 'data-muscle': m, style: `--bm-c:${muscleColor(m)};--bm-i:${TRAIN_ORDER(m)}` };
        if (!isHeat) Object.assign(attrs, { role: 'button', 'aria-label': label(m), 'aria-pressed': 'false', tabindex: i === 0 && first ? '0' : '-1', 'aria-hidden': i === 0 ? null : 'true' });
        const p = svg('path', attrs, isHeat ? null : svg('title', null));
        if (!isHeat) p.firstChild.textContent = label(m);
        muscles.append(p);
        if (!byMuscle.has(m)) byMuscle.set(m, []);
        byMuscle.get(m).push(p);
      });
    }
    const details = (side === 'front' ? DETAIL_FRONT : DETAIL_BACK).flatMap((d) => [d, mirror(d)]).map((d) => svg('path', { d, class: 'bm-detail' }));
    if (side === 'front') details.push(svg('ellipse', { cx: 75, cy: 139.5, rx: 1.5, ry: 2.3, class: 'bm-detail bm-navel' }));
    const el = svg('svg', { class: 'bm-svg', viewBox: `0 0 ${W} ${H}`, role: isHeat ? null : 'group', 'aria-label': isHeat ? null : (side === 'front' ? 'Front of body' : 'Back of body'), 'aria-hidden': isHeat ? 'true' : null, focusable: 'false' },
      svg('defs', null, svg('clipPath', { id: clipId }, svg('path', { d: BODY }))),
      svg('path', { d: BODY, class: 'bm-body' }), svg('path', { d: HEAD, class: 'bm-head' }),
      muscles, svg('path', { d: BODY, class: 'bm-outline' }), details);
    return h('figure', { class: 'bm-fig' }, el, h('figcaption', { class: 'bm-cap' }, side === 'front' ? 'Front' : 'Back'));
  }
  for (const side of view === 'front' ? ['front'] : view === 'back' ? ['back'] : ['front', 'back']) wrap.append(figure(side));
  wrap.append(tip);
  for (const m of byMuscle.keys()) paint(m);
  if (isHeat) {
    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', 'Muscles trained: ' + (Object.entries(heatNow).filter(([, v]) => v > 0).map(([m]) => label(m)).join(', ') || 'none yet'));
  }

  wrap.setSelected = (items) => { if (isHeat) return; const prev = new Set(sel); sel.clear(); for (const m of items || []) sel.add(m); for (const m of new Set([...prev, ...sel])) if (prev.has(m) !== sel.has(m)) paint(m); };
  wrap.getSelected = () => [...sel];
  wrap.setHeat = (obj) => { if (!isHeat) return; heatNow = { ...(obj || {}) }; for (const m of byMuscle.keys()) paint(m); };
  return wrap;
}
