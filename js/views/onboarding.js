// First-run wizard: profile → lifestyle → food → habits → plan.
import { state, setProfile, setWeight, todayKey, allFoods } from '../state.js';
import { h, icon, chips, segmented, stepper, field, toggle, clear } from '../ui.js';
import { ACTIVITY, GOALS, bmr, tdee, defaultTargets, bmi } from '../calc.js';

let step = 0;
let d = null;

const DIETS = [{ id: 'veg', label: 'Vegetarian' }, { id: 'egg', label: 'Eggetarian' }, { id: 'nonveg', label: 'Non-veg' }, { id: 'vegan', label: 'Vegan' }, { id: 'jain', label: 'Jain' }];
const REGIONS = [{ id: 'north', label: 'North (roti-heavy)' }, { id: 'south', label: 'South (rice-heavy)' }, { id: 'east', label: 'East (rice, fish)' }, { id: 'west', label: 'West (Gujarati, Marathi)' }, { id: 'mixed', label: 'Mixed / hostel / PG' }];
const BUDGETS = [{ id: 'tight', label: 'Tight', sub: 'dal, soya, eggs, milk' }, { id: 'moderate', label: 'Moderate', sub: 'paneer, chicken, curd' }, { id: 'flexible', label: 'Flexible', sub: 'whey, fish, Greek yogurt' }];

function init() {
  const p = state.profile || {};
  d = { name: p.name || '', sex: p.sex || 'male', age: p.age || 25, heightCm: p.heightCm || 170, weightKg: p.weightKg || 70, activity: p.activity || 'light', goal: p.goal || 'cut', targetWeightKg: p.targetWeightKg || null,
    diet: p.diet || 'veg', region: p.region || 'north', budget: p.budget || 'moderate', chaiCups: p.chaiCups ?? 2, chaiFoodId: p.chaiFoodId || 'chai_milk_1tsp', coffee: p.coffee || false,
    smoker: p.smoker || false, cigBaseline: p.cigBaseline || 5, cigCost: p.cigCost || 18, sleepTarget: p.sleepTarget || 7.5, glassMl: state.settings.glassMl || 250 };
}

export function render(container, ctx) {
  if (!d) init();
  const root = h('div', { class: 'onb' });
  container.append(root);
  const draw = () => { clear(root); root.append(steps[step](draw, ctx)); window.scrollTo({ top: 0 }); };
  draw();
}

function frame(title, sub, body, { back, next, nextLabel = 'Next', draw }) {
  return h('div', null,
    h('div', { class: 'steps' }, [0, 1, 2, 3, 4].map((i) => h('i', { class: i <= step ? 'on' : '' }))),
    h('div', { class: 'screen-head' }, h('div', null, h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null)),
    h('div', { class: 'stack' }, body),
    h('div', { class: 'row', style: { marginTop: '24px' } },
      step > 0 ? h('button', { class: 'btn', onClick: () => { step--; draw(); } }, icon('left'), 'Back') : null,
      h('button', { class: 'btn primary grow', onClick: () => { if (next() !== false) { step++; draw(); } } }, nextLabel)));
}

const numInput = (key, { min, max, step: st = 1, unit } = {}) => {
  const i = h('input', { type: 'number', inputmode: 'decimal', value: d[key] ?? '', min, max, step: st, onInput: (e) => { d[key] = e.target.value === '' ? null : +e.target.value; } });
  return unit ? h('div', { class: 'row' }, i, h('span', { class: 'muted small', style: { flex: 'none', width: '34px' } }, unit)) : i;
};

const steps = [
  (draw) => frame('Let’s set you up', 'Takes about a minute. Everything stays on your phone.', [
    h('div', { class: 'card stack' },
      field('Your name', h('input', { type: 'text', value: d.name, placeholder: 'Shivam', autocomplete: 'given-name', onInput: (e) => { d.name = e.target.value.trim(); } })),
      field('Sex (for the calorie formula)', segmented([{ id: 'male', label: 'Male' }, { id: 'female', label: 'Female' }], d.sex, (v) => { d.sex = v; })),
      h('div', { class: 'grid-3' }, field('Age', numInput('age', { min: 13, max: 90 })), field('Height', numInput('heightCm', { min: 120, max: 230, unit: 'cm' })), field('Weight', numInput('weightKg', { min: 30, max: 250, step: 0.1, unit: 'kg' })))),
  ], { next: () => { if (!d.age || !d.heightCm || !d.weightKg) { alert('Please fill age, height and weight.'); return false; } }, draw }),

  (draw) => frame('How active are you?', 'Pick the honest option. You can change it later.', [
    h('div', { class: 'card stack' },
      field('Activity', h('div', { class: 'stack' }, ACTIVITY.map((a) => h('button', { class: 'list-item card flat pad-s' + (d.activity === a.id ? ' sel' : ''), style: { borderColor: d.activity === a.id ? 'var(--accent)' : '' }, onClick: () => { d.activity = a.id; draw(); } }, h('div', { class: 'grow' }, h('div', { class: 'title' }, a.label)), d.activity === a.id ? icon('check') : null)))),
      field('Goal', h('div', { class: 'stack' }, GOALS.map((g) => h('button', { class: 'list-item card flat pad-s', style: { borderColor: d.goal === g.id ? 'var(--accent)' : '' }, onClick: () => { d.goal = g.id; draw(); } }, h('div', { class: 'grow' }, h('div', { class: 'title' }, g.label), h('div', { class: 'sub' }, g.sub)), d.goal === g.id ? icon('check') : null)))),
      field('Target weight (optional)', numInput('targetWeightKg', { min: 30, max: 250, step: 0.5, unit: 'kg' }))),
  ], { next: () => {}, draw }),

  (draw) => {
    const chaiOptions = allFoods().filter((f) => /^(chai|black_tea|green_tea|masala_chai|kadak|cutting|tea)/.test(f.id)).slice(0, 10);
    return frame('How do you eat?', 'This tunes food suggestions, protein ideas and budgets.', [
      h('div', { class: 'card stack' },
        field('Diet', chips(DIETS, d.diet, (v) => { d.diet = v; })),
        field('Home cuisine', chips(REGIONS, d.region, (v) => { d.region = v; })),
        field('Food budget', h('div', { class: 'grid-3' }, BUDGETS.map((b) => h('button', { class: 'card flat pad-s', style: { textAlign: 'left', borderColor: d.budget === b.id ? 'var(--accent)' : '' }, onClick: () => { d.budget = b.id; draw(); } }, h('div', { class: 'strong' }, b.label), h('div', { class: 'micro muted' }, b.sub))))),
        field('Chai per day', h('div', { class: 'row between' }, stepper({ value: d.chaiCups, min: 0, max: 12, onChange: (v) => { d.chaiCups = v; } }), h('span', { class: 'muted small' }, 'cups'))),
        field('Your usual chai', h('select', { onChange: (e) => { d.chaiFoodId = e.target.value; } }, chaiOptions.map((f) => h('option', { value: f.id, selected: f.id === d.chaiFoodId }, f.name))), 'One tap on Today logs this exact cup.'),
        toggle('I drink coffee too', d.coffee, (v) => { d.coffee = v; })),
    ], { next: () => {}, draw });
  },

  (draw) => frame('Habits to track', 'Honest tracking beats guilt. Nothing here judges you.', [
    h('div', { class: 'card stack' },
      toggle('I smoke', d.smoker, (v) => { d.smoker = v; draw(); }, 'Counts cigarettes, time since last, money and a lower-than-usual streak'),
      d.smoker ? h('div', { class: 'grid-2' }, field('Cigarettes a day now', stepper({ value: d.cigBaseline, min: 1, max: 60, onChange: (v) => { d.cigBaseline = v; } })), field('Cost per cigarette', numInput('cigCost', { min: 1, max: 100, unit: '₹' }))) : null,
      field('Sleep target', h('div', { class: 'row' }, stepper({ value: d.sleepTarget, min: 4, max: 12, step: 0.5, onChange: (v) => { d.sleepTarget = v; } }), h('span', { class: 'muted small' }, 'hours'))),
      field('Water glass size', segmented([{ id: 200, label: '200 ml' }, { id: 250, label: '250 ml' }, { id: 300, label: '300 ml' }], d.glassMl, (v) => { d.glassMl = v; }))),
  ], { next: () => {}, draw }),

  (draw, ctx) => {
    const t = defaultTargets(d); const b = bmr(d), e = tdee(d); const goal = GOALS.find((g) => g.id === d.goal);
    return frame('Your plan', `Hi ${d.name || 'there'}. Here is where you start.`, [
      h('div', { class: 'fuel' },
        h('div', { class: 'top' }, h('div', { class: 'big' }, t.kcal.toLocaleString('en-IN'), h('small', null, 'kcal / day')), h('div', { class: 'status' }, 'Maintenance', h('b', null, e.toLocaleString('en-IN')))),
        h('div', { class: 'macro-legend' },
          h('div', null, h('div', { class: 'lbl' }, h('i', { class: 'dot p' }), 'Protein'), h('div', { class: 'val' }, t.p, h('small', null, ' g'))),
          h('div', null, h('div', { class: 'lbl' }, h('i', { class: 'dot c' }), 'Carbs'), h('div', { class: 'val' }, t.c, h('small', null, ' g'))),
          h('div', null, h('div', { class: 'lbl' }, h('i', { class: 'dot f' }), 'Fat'), h('div', { class: 'val' }, t.f, h('small', null, ' g'))))),
      h('div', { class: 'card stack small' },
        h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'Resting burn (Mifflin-St Jeor)'), h('b', null, b, ' kcal')),
        h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'With your activity'), h('b', null, e, ' kcal')),
        h('div', { class: 'row between' }, h('span', { class: 'muted' }, goal.label + ' adjustment'), h('b', null, (goal.kcal > 0 ? '+' : '') + goal.kcal, ' kcal')),
        h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'Protein'), h('b', null, (t.p / d.weightKg).toFixed(1), ' g per kg')),
        h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'BMI'), h('b', null, bmi(d.weightKg, d.heightCm))),
        h('div', { class: 'row between' }, h('span', { class: 'muted' }, 'Fibre target'), h('b', null, t.fiber, ' g'))),
      h('div', { class: 'callout' }, icon('info'), h('div', null, 'After 2–3 weeks of logging food and weight, the app estimates your real burn from your own data and suggests a new target. Formulas are a starting point, not truth.')),
    ], { nextLabel: 'Start logging', draw, next: () => {
      const { glassMl, ...profile } = d;
      state.settings.glassMl = glassMl;
      setProfile(profile);
      setWeight(todayKey(), d.weightKg);
      step = 0; d = null;
      ctx.go('today');
      return false;
    } });
  },
];
