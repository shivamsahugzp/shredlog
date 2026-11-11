// First-run wizard: you → goal & activity → food → habits → plan reveal.
import { state, setProfile, setWeight, todayKey, allFoods, save } from '../state.js';
import { h, icon, stepper, toggle, field, clear, toast, haptic, fmt, ring } from '../ui.js';
import { ACTIVITY, GOALS, bmr, tdee, defaultTargets, bmi } from '../calc.js';
import { countUp, fill, pulse, stagger, canIntro, celebrate, EASE_OUT } from '../motion.js';

const TOTAL = 5;
let step = 0;
let d = null;
let dir = 1;

const DIETS = [
  { id: 'veg', title: 'Vegetarian', sub: 'Dairy, no egg or meat', ico: 'leaf' },
  { id: 'egg', title: 'Eggetarian', sub: 'Veg plus eggs', ico: 'egg' },
  { id: 'nonveg', title: 'Non-veg', sub: 'Chicken, fish, mutton', ico: 'drum' },
  { id: 'vegan', title: 'Vegan', sub: 'Plants only', ico: 'sprout' },
  { id: 'jain', title: 'Jain', sub: 'No root vegetables', ico: 'sun' },
];
const REGIONS = [{ id: 'north', label: 'North (roti-heavy)' }, { id: 'south', label: 'South (rice-heavy)' }, { id: 'east', label: 'East (rice, fish)' }, { id: 'west', label: 'West (Gujarati, Marathi)' }, { id: 'mixed', label: 'Mixed / hostel / PG' }];
const BUDGETS = [{ id: 'tight', title: 'Tight', sub: 'Dal, soya, eggs, milk', n: 1 }, { id: 'moderate', title: 'Moderate', sub: 'Paneer, chicken, curd', n: 2 }, { id: 'flexible', title: 'Flexible', sub: 'Whey, fish, Greek yogurt', n: 3 }];
const GOAL_ICO = { cut_fast: 'arrowDown', cut: 'arrowDown', cut_slow: 'arrowDown', maintain: 'eq', bulk: 'arrowUp' };

const NS = 'http://www.w3.org/2000/svg';
const GLYPH = {
  egg: 'M12 3c3.4 0 6 5.2 6 9.2a6 6 0 0 1-12 0C6 8.2 8.6 3 12 3z',
  drum: 'M14.5 4a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zM10.6 13.4 5.5 18.5M4 17a1.8 1.8 0 1 0 2.6 2.6M6.2 20.4a1.8 1.8 0 1 0 2.6-2.6',
  sprout: 'M12 21v-9M12 12c0-4 3-6 7-6 0 4-3 6-7 6zM12 15c0-3-2-5-6-5 0 3 2 5 6 5z',
  eq: 'M5 9h14M5 15h14',
};
function svgEl(tag, attrs = {}) { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; }
function glyph(name, size = 22) {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
  svg.append(svgEl('path', { d: GLYPH[name] })); return svg;
}
const ico = (name, size = 22) => (GLYPH[name] ? glyph(name, size) : icon(name, size));
// A drinking glass filled to ml/300 of the way up.
function glassGlyph(ml) {
  const svg = svgEl('svg', { viewBox: '0 0 32 40', width: 32, height: 40, 'aria-hidden': 'true', class: 'on-glass' });
  const lvl = 6 + (1 - ml / 330) * 28;
  svg.append(svgEl('clipPath', { id: 'g' + ml }));
  svg.firstChild.append(svgEl('path', { d: 'M6 4h20l-2.4 31a3 3 0 0 1-3 2.7h-9.2a3 3 0 0 1-3-2.7z' }));
  const water = svgEl('rect', { x: 0, y: lvl, width: 32, height: 40 - lvl, 'clip-path': `url(#g${ml})`, class: 'water' });
  svg.append(water, svgEl('path', { d: 'M6 4h20l-2.4 31a3 3 0 0 1-3 2.7h-9.2a3 3 0 0 1-3-2.7z', fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', class: 'rim' }));
  return svg;
}
const levelGlyph = (n) => h('span', { class: 'on-lvl', 'aria-hidden': 'true' }, [1, 2, 3, 4, 5].map((i) => h('i', { class: i <= n ? 'on' : '' })));
const signed = (v) => (v === 0 ? '±0' : (v > 0 ? '+' : '−') + Math.abs(v)) + ' kcal';

function init() {
  const p = state.profile || {};
  const draft = state.settings.onboardingDraft;
  if (draft && draft.d && typeof draft.d === 'object') { d = { ...draft.d }; step = Math.min(Math.max(draft.step | 0, 0), TOTAL - 1); return; }
  d = { name: p.name || '', sex: p.sex || 'male', age: p.age || 25, heightCm: p.heightCm || 170, weightKg: p.weightKg || 70, activity: p.activity || 'light', goal: p.goal || 'cut', targetWeightKg: p.targetWeightKg || null,
    diet: p.diet || 'veg', region: p.region || 'north', budget: p.budget || 'moderate', chaiCups: p.chaiCups ?? 2, chaiFoodId: p.chaiFoodId || 'chai_milk_1tsp', coffee: p.coffee || false,
    smoker: p.smoker || false, cigBaseline: p.cigBaseline || 5, cigCost: p.cigCost || 18, sleepTarget: p.sleepTarget || 7.5, glassMl: state.settings.glassMl || 250 };
}
// The draft is rewritten after every change, not only on Next, so a half-filled step survives the app being killed.
const persist = () => { state.settings.onboardingDraft = { step, d }; save(); };

export function render(container, ctx) {
  if (!d) init();
  const root = h('div', { class: 'onb' });
  container.append(root);
  let jobs = [];
  const nav = { go(delta) { dir = delta; step = Math.min(TOTAL - 1, Math.max(0, step + delta)); draw(true); }, later(fn) { jobs.push(fn); } };
  const draw = (moved) => {
    jobs = [];
    const el = steps[step](ctx, nav);
    clear(root); root.append(el);
    if (moved) window.scrollTo({ top: 0 });
    persist();
    if (moved && canIntro()) el.animate([{ opacity: 0, transform: `translateX(${dir * 28}px)` }, { opacity: 1, transform: 'none' }], { duration: 300, easing: EASE_OUT });
    const bar = root.querySelectorAll('.steps i')[step];
    if (bar && canIntro()) { bar.style.transformOrigin = '0 50%'; bar.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 480, easing: EASE_OUT, fill: 'backwards' }); }
    for (const j of jobs) { try { j(); } catch (e) { console.error(e); } }
  };
  draw(false);
}

// ---------- pieces ----------
function frame({ title, sub, hero, body, next, nextLabel = 'Next', last = false }, nav) {
  const nextBtn = h('button', { class: 'btn primary lg grow on-next', onClick: () => { if (next() !== false) nav.go(1); } }, nextLabel, last ? null : icon('right', 18));
  return h('div', { class: 'on-step' },
    h('div', { class: 'on-top' },
      h('div', { class: 'steps', role: 'progressbar', 'aria-label': `Step ${step + 1} of ${TOTAL}`, 'aria-valuemin': '1', 'aria-valuemax': String(TOTAL), 'aria-valuenow': String(step + 1) }, [0, 1, 2, 3, 4].map((i) => h('i', { class: i <= step ? 'on' : '' }))),
      h('span', { class: 'on-count' }, `${step + 1} / ${TOTAL}`)),
    hero || null,
    h('div', { class: 'on-head' }, h('h1', null, title), sub ? h('p', { class: 'on-sub' }, sub) : null),
    h('div', { class: 'on-body' }, body),
    h('div', { class: 'on-foot glass' },
      step > 0 ? h('button', { class: 'icon-btn on-back', 'aria-label': 'Back', onClick: () => nav.go(-1) }, icon('left')) : null,
      nextBtn));
}

// Big tappable cards. Selection changes in place (no redraw), so the page never jumps back to the top.
function choices(opts, value, onPick, { cols = 1, cls = '' } = {}) {
  const wrap = h('div', { class: `on-choices c${cols} ${cls}`, role: 'radiogroup' });
  for (const o of opts) {
    const on = o.id === value;
    const b = h('button', { type: 'button', class: 'on-choice' + (on ? ' on' : ''), role: 'radio', 'aria-checked': on ? 'true' : 'false', dataset: { id: String(o.id) }, onClick: () => {
      wrap.querySelectorAll('.on-choice').forEach((x) => { const sel = x === b; x.classList.toggle('on', sel); x.setAttribute('aria-checked', sel ? 'true' : 'false'); });
      pulse(b, { scale: 1.04, ms: 280 }); haptic('tap'); onPick(o.id); persist();
    } },
      o.glyph ? h('span', { class: 'on-ch-g' }, o.glyph) : null,
      h('span', { class: 'on-ch-t' }, h('span', { class: 'on-ch-top' }, h('b', null, o.title), o.tag ? h('em', { class: 'on-ch-tag' }, o.tag) : null), o.sub ? h('small', null, o.sub) : null),
      h('span', { class: 'on-tick', 'aria-hidden': 'true' }, icon('check', 14)));
    wrap.append(b);
  }
  return wrap;
}
const sub = (text) => h('h3', { class: 'on-sh' }, text);

// Scoreboard-style number tile: the whole tile focuses the input.
function numTile(key, label, unit, { min, max, step: st = 1, placeholder } = {}) {
  const i = h('input', { type: 'number', inputmode: 'decimal', value: d[key] ?? '', min, max, step: st, placeholder, 'aria-label': label, enterkeyhint: 'done', onInput: (e) => { d[key] = e.target.value === '' ? null : +e.target.value; persist(); } });
  return h('label', { class: 'on-num' }, h('span', { class: 'on-num-l' }, label), h('span', { class: 'on-num-v' }, i, unit ? h('small', null, unit) : null));
}
const bump = (key) => (v) => { d[key] = v; persist(); };

// ---------- steps ----------
const steps = [
  // 1. you
  (ctx, nav) => frame({
    title: 'Let’s set you up', sub: 'One minute. Everything stays on this phone.',
    hero: h('div', { class: 'on-hero card accent' },
      h('div', { class: 'mark' }, 'S'),
      h('div', { class: 'on-hero-chips' }, h('span', { class: 'on-hchip' }, icon('bowl', 16), 'Dal, roti, paneer'), h('span', { class: 'on-hchip' }, icon('cup', 16), 'Chai counted'), h('span', { class: 'on-hchip' }, icon('dumbbell', 16), 'Sets and PRs'))),
    body: [
      h('div', { class: 'card stack on-card' },
        field('Your name', h('input', { type: 'text', class: 'on-name', value: d.name, placeholder: 'Shivam', autocomplete: 'given-name', autocapitalize: 'words', enterkeyhint: 'next', onInput: (e) => { d.name = e.target.value.trim(); persist(); } })),
        field('Sex (for the calorie formula)', choices([{ id: 'male', title: 'Male' }, { id: 'female', title: 'Female' }], d.sex, (v) => { d.sex = v; }, { cols: 2, cls: 'slim' }))),
      h('div', { class: 'on-nums' }, numTile('age', 'Age', 'years', { min: 13, max: 90 }), numTile('heightCm', 'Height', 'cm', { min: 120, max: 230 }), numTile('weightKg', 'Weight', 'kg', { min: 30, max: 250, step: 0.1 })),
    ],
    next: () => { if (!d.age || !d.heightCm || !d.weightKg) { toast('Add your age, height and weight to continue'); haptic('warn'); return false; } },
  }, nav),

  // 2. goal and activity
  (ctx, nav) => {
    return frame({
      title: 'What are you here for?', sub: 'Pick the honest option. You can change it later.',
      body: [
        choices(GOALS.map((g) => ({ id: g.id, title: g.label, sub: g.sub, tag: signed(g.kcal), glyph: ico(GOAL_ICO[g.id] || 'target', 22) })), d.goal, (v) => { d.goal = v; }, { cls: 'goals' }),
        sub('How active are you?'),
        choices(ACTIVITY.map((a, i) => { const [t, s] = a.label.includes(':') ? a.label.split(':') : a.label.split(','); return { id: a.id, title: t.trim(), sub: s ? s.trim().replace(/^./, (c) => c.toUpperCase()).replace(' / week', ' a week') : '', glyph: levelGlyph(i + 1) }; }), d.activity, (v) => { d.activity = v; }, { cls: 'acts' }),
        h('div', { class: 'card on-card' }, field('Target weight (optional)', h('div', { class: 'on-nums one' }, numTile('targetWeightKg', 'Goal weight', 'kg', { min: 30, max: 250, step: 0.5, placeholder: 'Optional' })), 'Leave it empty if you are not chasing a number.')),
      ],
      next: () => {},
    }, nav);
  },

  // 3. food
  (ctx, nav) => {
    const chaiOptions = allFoods().filter((f) => /^(chai|black_tea|green_tea|masala_chai|kadak|cutting|tea)/.test(f.id)).slice(0, 10);
    return frame({
      title: 'How do you eat?', sub: 'This tunes food suggestions, protein ideas and budgets.',
      body: [
        sub('Diet'),
        choices(DIETS.map((x) => ({ id: x.id, title: x.title, sub: x.sub, glyph: ico(x.ico, 22) })), d.diet, (v) => { d.diet = v; }, { cols: 2, cls: 'diets' }),
        sub('Food budget'),
        choices(BUDGETS.map((b) => ({ id: b.id, title: b.title, sub: b.sub, glyph: h('span', { class: 'on-rupee' }, '₹'.repeat(b.n)) })), d.budget, (v) => { d.budget = v; }, { cols: 3, cls: 'budgets' }),
        sub('Home cuisine'),
        h('div', { class: 'chips wrap' }, REGIONS.map((r) => h('button', { class: 'chip' + (d.region === r.id ? ' on' : ''), onClick: (e) => { d.region = r.id; persist(); e.currentTarget.parentNode.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === e.currentTarget)); } }, r.label))),
        h('div', { class: 'card stack on-card' },
          field('Chai per day', h('div', { class: 'row between' }, stepper({ value: d.chaiCups, min: 0, max: 12, onChange: bump('chaiCups') }), h('span', { class: 'muted small' }, 'cups'))),
          field('Your usual chai', h('select', { onChange: (e) => { d.chaiFoodId = e.target.value; persist(); } }, chaiOptions.map((f) => h('option', { value: f.id, selected: f.id === d.chaiFoodId }, f.name))), 'One tap on Today logs this exact cup.'),
          toggle('I drink coffee too', d.coffee, (v) => { d.coffee = v; persist(); })),
      ],
      next: () => {},
    }, nav);
  },

  // 4. habits
  (ctx, nav) => {
    const smokeFields = h('div', { class: 'grid-2 on-smoke' + (d.smoker ? '' : ' hide') },
      field('Cigarettes a day now', stepper({ value: d.cigBaseline, min: 1, max: 60, onChange: bump('cigBaseline') })),
      field('Cost per cigarette', h('div', { class: 'on-nums one' }, numTile('cigCost', 'Cost', '₹', { min: 1, max: 100 }))));
    return frame({
      title: 'Habits to track', sub: 'Honest tracking beats guilt. Nothing here judges you.',
      body: [
        h('div', { class: 'card stack on-card' },
          toggle('I smoke', d.smoker, (v) => { d.smoker = v; smokeFields.classList.toggle('hide', !v); persist(); }, 'Counts cigarettes, time since last, money and a lower-than-usual streak'),
          smokeFields),
        h('div', { class: 'card stack on-card' },
          field('Sleep target', h('div', { class: 'row between' }, stepper({ value: d.sleepTarget, min: 4, max: 12, step: 0.5, onChange: bump('sleepTarget') }), h('span', { class: 'muted small' }, 'hours a night')))),
        sub('Water glass size'),
        choices([200, 250, 300].map((ml) => ({ id: ml, title: `${ml} ml`, glyph: glassGlyph(ml) })), d.glassMl, (v) => { d.glassMl = v; }, { cols: 3, cls: 'glasses' }),
      ],
      next: () => {},
    }, nav);
  },

  // 5. the plan
  (ctx, nav) => {
    const t = defaultTargets(d), b = bmr(d), e = tdee(d), goal = GOALS.find((g) => g.id === d.goal) || GOALS[1];
    const energy = [t.p * 4, t.c * 4, t.f * 9], total = energy.reduce((a, x) => a + x, 0) || 1;
    const COLORS = ['var(--p)', 'var(--c)', 'var(--f)'], NAMES = ['Protein', 'Carbs', 'Fat'], GRAMS = [t.p, t.c, t.f];
    const kcalEl = h('span', { class: 'num-lg on-kcal' }, '0');
    const SIZE = 208, STROKE = 18;
    const donut = ring({ size: SIZE, stroke: STROKE, pct: 0, cls: 'on-donut', children: [kcalEl, h('small', null, 'kcal / day')] });
    const GAP = 1.4; let acc = 0;
    const arcs = energy.map((en, i) => {
      const share = en / total, a = i === 0 ? donut.fillEl : donut.fillEl.cloneNode();
      a.style.stroke = COLORS[i]; a.setAttribute('transform', `rotate(${(acc + GAP / 200) * 360} ${SIZE / 2} ${SIZE / 2})`);
      if (i) donut.fillEl.parentNode.append(a);
      acc += share; return { a, pct: Math.max(0, share * 100 - GAP) };
    });
    const gramEls = GRAMS.map(() => h('span', { class: 'num-sm' }, '0'));
    const rows = [['Resting burn', b, 'Mifflin-St Jeor formula', 'var(--muted)'], ['With your activity', e, 'Maintenance', 'var(--c)'], [`${goal.label} target`, t.kcal, `${signed(goal.kcal)} from maintenance`, 'var(--accent)']];
    const top = Math.max(b, e, t.kcal, 1);
    const barEls = rows.map(([, v, , col]) => h('i', { style: { width: (v / top * 100) + '%', background: col } }));
    const valEls = rows.map(() => h('b', null, '0'));
    nav.later(() => {
      countUp(kcalEl, t.kcal, { from: 0, ms: 1100, fmt: (v) => fmt(Math.round(v)) });
      arcs.forEach(({ a, pct }, i) => fill(a, pct, { axis: 'ring', ms: 900, delay: i * 160 }));
      gramEls.forEach((el, i) => countUp(el, GRAMS[i], { from: 0, ms: 900 }));
      barEls.forEach((el, i) => fill(el, parseFloat(el.style.width), { ms: 700, delay: 350 + i * 130 }));
      valEls.forEach((el, i) => countUp(el, rows[i][1], { from: 0, ms: 900, fmt: (v) => fmt(Math.round(v)) }));
      stagger(document.querySelector('.onb .on-reveal'), { step: 70 });
    });
    return frame({
      title: 'Your plan', sub: `Hi ${d.name || 'there'}. Here is where you start.`,
      body: h('div', { class: 'on-reveal' },
        h('div', { class: 'card on-plan' }, donut,
          h('div', { class: 'on-legend' }, [0, 1, 2].map((i) => h('div', null, h('div', { class: 'lbl' }, h('i', { class: 'dot', style: { background: COLORS[i] } }), NAMES[i]), h('div', { class: 'on-gv' }, gramEls[i], h('small', null, ' g')), h('div', { class: 'micro muted' }, `${Math.round(energy[i] / total * 100)}% of kcal`))))),
        h('div', { class: 'card on-bars' }, sub('How we got there'), rows.map(([label, , note], i) => h('div', { class: 'on-bar' },
          h('div', { class: 'row between' }, h('span', { class: 'strong' }, label), valEls[i]),
          h('div', { class: 'on-track' }, barEls[i]), h('div', { class: 'micro muted' }, note)))),
        h('div', { class: 'on-stats' },
          h('div', { class: 'tile' }, h('div', { class: 'lbl' }, 'Protein'), h('div', { class: 'val' }, (t.p / d.weightKg).toFixed(1), h('small', null, ' g/kg'))),
          h('div', { class: 'tile' }, h('div', { class: 'lbl' }, 'BMI'), h('div', { class: 'val' }, bmi(d.weightKg, d.heightCm))),
          h('div', { class: 'tile' }, h('div', { class: 'lbl' }, 'Fibre'), h('div', { class: 'val' }, t.fiber, h('small', null, ' g')))),
        h('div', { class: 'callout' }, icon('info'), h('div', null, 'After 2–3 weeks of logging food and weight, the app estimates your real burn from your own data and suggests a new target. Formulas are a starting point, not truth.'))),
      nextLabel: 'Start logging', last: true,
      next: () => {
        celebrate(document.querySelector('.on-next'), { kind: 'goal' });
        const { glassMl, ...profile } = d;
        state.settings.glassMl = glassMl;
        delete state.settings.onboardingDraft;
        setProfile(profile);
        setWeight(todayKey(), d.weightKg);
        step = 0; d = null;
        ctx.go('today');
        return false;
      },
    }, nav);
  },
];
