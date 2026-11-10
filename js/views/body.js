// Body: how you feel (symptoms, evening check-in), habits (cigarettes, chai, water, sleep, steps),
// measurements, and food-to-symptom patterns. Full redraw on every change; sheets live outside the screen.
import { state, day, dayIfAny, setCheckin, logSymptom, removeSymptom, setRedFlags, logHabit, removeHabit, habitCount, habitByDate, lastHabitTs, waterMl, chaiCount, coffeeCount, setMeasurements, measurementSeries, setWeight, latestWeight, weights, lastNDays, shiftDate, commit, isChai, isCoffee } from '../state.js';
import { cigStats } from '../calc.js';
import { SYMPTOMS, TAG_LABELS, RED_FLAGS, symptomPatterns } from '../insights.js';
import { barChart, lineChart, legend } from '../charts.js';
import { h, icon, sheet, toast, stepper, append, clear, fmt, fmtTime, fmtDateLabel, fmtShortDate, fmtDow, sinceText, haptic } from '../ui.js';
import { quiet, stagger, growBars } from '../motion.js';

let seenParams = null; // one-shot ctx.params handling (params keep the same identity until go() is called again)

// ---------- small helpers ----------
const dt = (k) => new Date(k + 'T12:00:00').getTime();
const signed = (n, d = 1) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(+(+n).toFixed(d));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const num1 = (v) => String(+(+v).toFixed(1));
const bar = (pct, color) => h('div', { class: 'mini-bar' }, h('i', { style: { width: Math.max(0, Math.min(100, pct)) + '%', background: color } }));
// Logs for a past day get a noon timestamp so they never reset "since last" or land at the wrong hour.
const metaFor = (key, today, extra = {}) => (key === today ? extra : { ...extra, ts: dt(key) });
const firstLogKey = () => Object.keys(state.log).sort()[0] || null;
const sec = (title, ...kids) => h('div', { class: 'section' }, title ? h('div', { class: 'section-head' }, h('h2', null, title)) : null, kids);
const head = (ico, cls, title, right) => h('div', { class: 'bd-head' }, h('span', { class: 'ico ' + cls }, icon(ico)), h('h3', { class: 'grow' }, title), right || null);
const numField = (label, input, hint) => h('div', { class: 'field' }, h('label', null, label), input, hint ? h('div', { class: 'hint' }, hint) : null);

// ---------- entry ----------
export function render(container, ctx) {
  const root = h('div', { class: 'bd' });
  container.append(root);
  const ui = { pending: null, since: null };
  let drawn = false;
  // Build first, swap second (a throwing build cannot blank the screen). Chart intros and the card stagger play on the first draw only.
  const draw = () => {
    const run = () => { ui.since = null; const next = build(ctx, ui, draw); clear(root); root.append(next); };
    if (drawn) quiet(run); else run();
    growBars(root, '.mini-bar > i', { key: 'bd' });
    if (!drawn) stagger(root.firstElementChild, { key: 'body' });
    drawn = true;
  };
  draw();
  const timer = setInterval(() => { if (!root.isConnected) clearInterval(timer); else paintSince(ui); }, 30000);
  if (ctx.params && ctx.params.open === 'checkin' && ctx.params !== seenParams) { seenParams = ctx.params; checkinSheet(ctx.params.date || ctx.date, ctx.today); }
  return draw;
}

function build(ctx, ui, redraw) {
  const c = { ctx, ui, redraw, key: ctx.date, today: ctx.today, p: state.profile || {}, t: state.targets || {} };
  const f = h('div');
  append(f, [header(), redFlagBanner(c), dateNav(c), stomachSection(c), checkinSection(c), habitsSection(c), measuresSection(c), patternsSection(c), ironNudge(c)]);
  return f;
}

const header = () => h('div', { class: 'screen-head' }, h('div', null, h('h1', null, 'Body'), h('div', { class: 'sub' }, 'How you feel, what you do, what it adds up to.')));

function dateNav({ key, today, ctx }) {
  const isToday = key === today;
  return h('div', { class: 'date-nav bd-nav' },
    h('button', { class: 'icon-btn', 'aria-label': 'Previous day', onClick: () => ctx.setDate(shiftDate(key, -1)) }, icon('left')),
    h('div', { class: 'label' }, fmtDateLabel(key, today), h('small', null, isToday ? 'Log as you go' : 'Viewing a past day'), !isToday ? h('button', { class: 'btn sm ghost', onClick: () => ctx.setDate(today) }, 'Today') : null),
    h('button', { class: 'icon-btn', 'aria-label': 'Next day', disabled: isToday, onClick: () => ctx.setDate(shiftDate(key, 1)) }, icon('right')));
}

function redFlagBanner({ today }) {
  const seen = new Map();
  for (const k of lastNDays(7, today)) for (const f of dayIfAny(k)?.redFlags || []) if (!seen.has(f)) seen.set(f, k);
  if (!seen.size) return null;
  return h('div', { class: 'callout bd-red', role: 'alert' }, icon('warn'), h('div', { class: 'grow' },
    h('b', null, 'Some of these need a doctor, not an app. Please get checked.'),
    h('ul', { class: 'bd-red-list' }, [...seen].map(([f, k]) => h('li', null, f, h('span', { class: 'muted' }, ` · ${fmtDateLabel(k, today)}`))))));
}

// ---------- 2. Right now: stomach quick card ----------
const STOMACH = [{ id: 'all_good', label: 'All good' }, { id: 'bloating', label: 'Bloating' }, { id: 'gas', label: 'Gas' }, { id: 'acidity', label: 'Acidity' }, { id: 'cramps', label: 'Cramps' }, { id: 'headache', label: 'Headache' }, { id: 'sleepy', label: 'Sleepy / heavy', noun: 'sleepiness or heaviness' }, { id: 'heat', label: 'Garmi', noun: 'body heat' }];
const SEV = [{ v: 1, label: 'Mild' }, { v: 2, label: 'Moderate' }, { v: 3, label: 'Strong' }];
const SYM_LABEL = Object.fromEntries(STOMACH.map((s) => [s.id, s.label]));
const SEV_LABEL = Object.fromEntries(SEV.map((s) => [s.v, s.label]));
// Short chip label first, then the insights SYMPTOMS label, so any logged type displays properly.
const symLabel = (type) => SYM_LABEL[type] || SYMPTOMS.find((x) => x.id === type)?.label || type;
const symNoun = (type) => (STOMACH.find((x) => x.id === type)?.noun || symLabel(type)).toLowerCase();

function addSymptom({ key, today }, type, sev) {
  const e = logSymptom(key, type, sev, metaFor(key, today));
  haptic();
  toast(type === 'all_good' ? 'Logged: all good' : `Logged: ${symNoun(type)}, ${SEV_LABEL[sev].toLowerCase()}`, { action: 'Undo', onAction: () => removeSymptom(key, e.id) });
}

function symptomPill(e, key) {
  const lvl = e.type === 'all_good' ? 'good' : e.sev >= 3 ? 'bad' : e.sev === 2 ? 'warn' : '';
  const label = e.type === 'all_good' ? 'All good' : `${symLabel(e.type)} · ${SEV_LABEL[e.sev] || ''}`;
  return h('span', { class: 'pill bd-sym ' + lvl }, `${fmtTime(e.ts)} · ${label}`,
    h('button', { class: 'bd-x', 'aria-label': `Remove ${label}`, onClick: () => removeSymptom(key, e.id) }, icon('x', 14)));
}

function stomachSection(c) {
  const { key, today, ui, redraw } = c;
  const pick = (id) => { if (id === 'all_good') { ui.pending = null; addSymptom(c, 'all_good', 0); } else { ui.pending = ui.pending === id ? null : id; redraw(); } };
  const card = h('div', { class: 'card' }, h('div', { class: 'bd-q-title' }, 'How do you feel after eating?'),
    h('div', { class: 'bd-chips' }, STOMACH.map((s) => h('button', { class: 'chip bd-chip' + (ui.pending === s.id ? ' on' : ''), 'aria-pressed': ui.pending === s.id ? 'true' : 'false', onClick: () => pick(s.id) }, s.label))));
  if (ui.pending) {
    card.append(h('div', { class: 'bd-sev' }, h('div', { class: 'small strong' }, `How strong is the ${symNoun(ui.pending)}?`),
      h('div', { class: 'bd-chips' }, SEV.map((s) => h('button', { class: 'chip bd-chip sev' + s.v, onClick: () => { const t = ui.pending; ui.pending = null; addSymptom(c, t, s.v); } }, s.label)),
        h('button', { class: 'btn sm ghost', onClick: () => { ui.pending = null; redraw(); } }, 'Cancel'))));
  }
  const list = (dayIfAny(key)?.symptoms || []).slice().sort((a, b) => a.ts - b.ts);
  card.append(list.length ? h('div', { class: 'bd-chips bd-entries' }, list.map((e) => symptomPill(e, key))) : h('div', { class: 'small muted bd-none' }, 'Nothing logged yet.'));
  card.append(h('div', { class: 'small muted bd-note' }, 'Log 2–3 hours after meals. Logging good days matters as much as bad ones.'));
  return sec(key === today ? 'Right now' : 'Symptoms that day', card);
}

// ---------- 3. Evening check-in ----------
const CK_FIELDS = ['energy', 'mood', 'hunger', 'cravings', 'stool', 'skin', 'headache', 'sleepQ'];
const DOTS = [1, 2, 3, 4, 5].map((v) => ({ v, label: () => h('i', { class: 'bd-dot' }, v) })); // label may be a factory: DOM nodes can't be shared across rows
const RATINGS = [
  { k: 'energy', label: 'Energy today', lo: 'Drained', hi: 'Buzzing' },
  { k: 'mood', label: 'Mood', lo: 'Low', hi: 'Great' },
  { k: 'hunger', label: 'Hunger between meals', lo: 'Starving', hi: 'Stuffed', hint: '3 means comfortably satisfied.' },
];
const CRAVE = [{ v: 'none', label: 'None' }, { v: 'sweet', label: 'Sweet' }, { v: 'salty', label: 'Salty' }, { v: 'fried', label: 'Fried' }];
const STOOL = [1, 2, 3, 4, 5, 6, 7].map((v) => ({ v, label: v === 1 ? '1 hard' : v === 7 ? '7 liquid' : String(v) })).concat([{ v: null, label: 'None today' }]);
const BRISTOL = ['', 'Hard, separate lumps', 'Lumpy, sausage-shaped', 'Sausage with cracks', 'Smooth, soft sausage', 'Soft blobs, easy to pass', 'Mushy, fluffy pieces', 'Watery, no solid pieces'];
const SKIN = [{ v: 0, label: 'Clear' }, { v: 1, label: 'A few spots' }, { v: 2, label: 'Breakout' }];
const HEAD = [{ v: 0, label: 'None' }, { v: 1, label: 'Mild' }, { v: 2, label: 'Moderate' }, { v: 3, label: 'Strong' }];

function checkinBits(ck) {
  const b = [];
  if (ck.energy != null) b.push(`Energy ${ck.energy}/5`);
  if (ck.mood != null) b.push(`Mood ${ck.mood}/5`);
  if (ck.hunger != null) b.push(`Hunger ${ck.hunger}/5`);
  if (ck.sleepQ != null) b.push(`Sleep ${ck.sleepQ}/5`);
  if (ck.stool != null) b.push(`Stool ${ck.stool}`);
  if (ck.cravings && ck.cravings !== 'none') b.push(`Craving: ${ck.cravings}`);
  return b.slice(0, 4);
}

function checkinSection({ key, today }) {
  const ck = dayIfAny(key)?.checkin;
  const bits = ck ? checkinBits(ck) : [];
  return sec('Evening check-in', h('div', { class: 'card' }, h('div', { class: 'row between' },
    h('div', { class: 'grow' }, h('h3', null, ck ? `Saved at ${fmtTime(ck.ts)}` : 'How was today?'),
      h('div', { class: 'small muted' }, bits.length ? bits.join(' · ') : ck ? 'Notes saved.' : 'Energy, mood, hunger, digestion, sleep. About 30 seconds. The app links it to what you ate.')),
    h('button', { class: 'btn ' + (ck ? '' : 'primary'), onClick: () => checkinSheet(key, today) }, ck ? 'Edit' : 'Check in'))));
}

// Single-choice row. Tapping the selected option again clears it, so skipped questions stay unanswered (undefined).
function pickRow(options, draft, k, cls = '', onChange) {
  const row = h('div', { class: 'bd-pick ' + cls, role: 'group' });
  const paint = () => [...row.children].forEach((b, i) => { const on = draft[k] === options[i].v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); });
  options.forEach((o) => row.append(h('button', { type: 'button', class: 'bd-opt', onClick: () => { if (draft[k] === o.v) delete draft[k]; else draft[k] = o.v; paint(); haptic(); onChange && onChange(); } }, typeof o.label === 'function' ? o.label() : o.label)));
  paint();
  return row;
}
const question = (label, ctl, extra) => h('div', { class: 'bd-q' }, h('div', { class: 'bd-ql' }, label), ctl, extra || null);
const ends = (lo, hi, hint) => h('div', { class: 'bd-ends' }, h('span', null, lo), hint ? h('span', { class: 'bd-hint' }, hint) : null, h('span', null, hi));

function sleepHoursControl(extra, start) {
  const box = h('div');
  const show = () => { clear(box); box.append(h('div', { class: 'row' }, stepper({ value: extra.sleep, min: 0, max: 14, step: 0.5, onChange: (v) => { extra.sleep = v; } }), h('span', { class: 'muted' }, 'hours'))); };
  if (extra.sleep != null) show();
  else box.append(h('button', { type: 'button', class: 'btn sm', onClick: () => { extra.sleep = start; show(); } }, icon('plus', 16), 'Add hours slept'));
  return box;
}

function redFlagsBlock(flags) {
  return h('details', { class: 'bd-flags', open: flags.size > 0 }, h('summary', null, 'Anything worrying?'),
    h('p', { class: 'small muted' }, 'If any of these are true, please see a doctor. An app cannot judge them.'),
    RED_FLAGS.map((f) => h('label', { class: 'bd-flag' }, h('input', { type: 'checkbox', checked: flags.has(f), onChange: (e) => { if (e.target.checked) flags.add(f); else flags.delete(f); } }), f)));
}

function checkinSheet(key, today) {
  const d = dayIfAny(key) || {}, ck = d.checkin || {};
  const draft = { ...ck };
  const extra = { sleep: d.sleep > 0 ? d.sleep : null, steps: d.steps ?? null, notes: ck.notes || '', flags: new Set(d.redFlags || []) };
  const stoolNote = h('div', { class: 'bd-hint' }, BRISTOL[draft.stool] || '');
  const form = h('div', { class: 'bd-form' });
  for (const r of RATINGS) form.append(question(r.label, pickRow(DOTS, draft, r.k, 'bd-dots'), ends(r.lo, r.hi, r.hint)));
  form.append(question('Cravings today', pickRow(CRAVE, draft, 'cravings')));
  form.append(question('Stool (Bristol scale)', pickRow(STOOL, draft, 'stool', 'bd-stool', () => { stoolNote.textContent = BRISTOL[draft.stool] || ''; }), stoolNote));
  form.append(question('Skin', pickRow(SKIN, draft, 'skin')));
  form.append(question('Headache', pickRow(HEAD, draft, 'headache')));
  form.append(question('Last night’s sleep quality', pickRow(DOTS, draft, 'sleepQ', 'bd-dots'), ends('Poor', 'Great')));
  form.append(question('Hours slept', sleepHoursControl(extra, state.profile?.sleepTarget || 7.5)));
  form.append(question('Steps today', h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 100000, placeholder: 'For example 6500', value: extra.steps ?? '', onInput: (e) => { const v = parseInt(e.target.value, 10); extra.steps = Number.isFinite(v) && v >= 0 ? v : null; } })));
  form.append(question('Notes', h('textarea', { rows: 3, maxlength: 500, placeholder: 'Poor night, stressful day, travel, new food…', value: extra.notes, onInput: (e) => { extra.notes = e.target.value; } })));
  form.append(redFlagsBlock(extra.flags));
  sheet({ title: `Check-in · ${fmtDateLabel(key, today)}`, content: form,
    actions: (api) => [h('button', { class: 'btn', onClick: api.close }, 'Cancel'), h('button', { class: 'btn primary', onClick: () => { saveCheckin(key, d, ck, draft, extra); api.close(); } }, 'Save')] });
}

function saveCheckin(key, d, ck, draft, extra) {
  const patch = {};
  for (const k of CK_FIELDS) if (k in draft || k in ck) patch[k] = draft[k]; // undefined clears an old answer
  const notes = extra.notes.trim();
  if (notes) patch.notes = notes; else if (ck.notes) patch.notes = undefined;
  const answered = Object.values(patch).some((v) => v !== undefined);
  let wrote = false;
  if (extra.sleep != null && extra.sleep !== d.sleep) day(key).sleep = extra.sleep;
  if (extra.steps !== (d.steps ?? null)) day(key).steps = extra.steps;
  const flags = RED_FLAGS.filter((f) => extra.flags.has(f)), before = d.redFlags || [];
  if (flags.length !== before.length || flags.some((f) => !before.includes(f))) { setRedFlags(key, flags); wrote = true; }
  if (answered || d.checkin) { setCheckin(key, patch); wrote = true; }
  if (!wrote) commit();
  toast(answered ? 'Check-in saved' : 'Saved');
}

// ---------- 4. Habits ----------
function habitsSection(c) {
  const grid = h('div', { class: 'bd-grid' });
  append(grid, [c.p.smoker ? cigCard(c) : null, chaiCard(c), stepsCard(c), waterCard(c), sleepCard(c)]);
  return sec('Habits', grid);
}

const MILESTONES = [
  { min: 20, label: '20 min', text: 'Pulse normalises' }, { min: 480, label: '8 h', text: 'Carbon monoxide halves' },
  { min: 1440, label: '24 h', text: 'Heart-attack risk starts falling' }, { min: 2880, label: '48 h', text: 'Taste and smell improve' },
  { min: 4320, label: '72 h', text: 'Breathing gets easier' }, { min: 20160, label: '2 weeks', text: 'Circulation improves' },
  { min: 43200, label: '1 month', text: 'Lung function goes up' },
];

function milestoneList(last) {
  const mins = last ? (Date.now() - last) / 60000 : 0;
  const done = last ? MILESTONES.filter((m) => mins >= m.min).length : 0;
  return h('div', null, h('div', { class: 'bd-sub' }, last ? `Health milestones · ${done} of ${MILESTONES.length} reached` : 'Health milestones start counting from your last logged cigarette'),
    h('ul', { class: 'bd-ms' }, MILESTONES.map((m) => { const ok = last && mins >= m.min; return h('li', { class: ok ? 'done' : '' }, h('i', null, ok ? icon('check', 12) : null), h('b', null, m.label), m.text); })));
}

function paintSince(ui) {
  if (!ui.since) return;
  const last = lastHabitTs('cig');
  ui.since.big.textContent = sinceText(last);
  clear(ui.since.list); ui.since.list.append(milestoneList(last));
}

// Days in a row (ending at key) with fewer cigarettes than the usual baseline. Stops at the first day the app has any record of.
function lowerStreak(key, baseline) {
  const first = firstLogKey();
  if (!baseline || !first) return 0;
  let n = 0, k = key;
  while (k >= first && n < 365 && habitCount(k, 'cig') < baseline) { n++; k = shiftDate(k, -1); }
  return n;
}

// Days in a row (ending at key) with zero cigarettes, counted only from the first log record onward.
function smokeFree(key) {
  const first = firstLogKey();
  if (!first) return 0;
  let n = 0, k = key;
  while (k >= first && n < 365 && habitCount(k, 'cig') === 0) { n++; k = shiftDate(k, -1); }
  return n;
}

function cigAdd(c, type, msg) {
  const e = logHabit(c.key, type, metaFor(c.key, c.today)); haptic();
  const n = habitCount(c.key, type), lim = c.t.cigLimit;
  toast(type === 'cig' ? `Cigarette ${n} today${lim ? ` · limit ${lim}` : ''}` : msg, { action: 'Undo', onAction: () => removeHabit(c.key, e.id) });
}

function cigVsUsual(n, base) {
  if (!base) return null;
  return n < base ? h('span', { class: 'pill good' }, `${base - n} fewer than usual`) : n === base ? h('span', { class: 'pill' }, 'Same as usual') : h('span', { class: 'pill bad' }, `${n - base} more than usual`);
}

function cigCard(c) {
  const { key, today, p, t, ui } = c;
  const n = habitCount(key, 'cig'), beaten = habitCount(key, 'craving'), lim = t.cigLimit || 0, base = p.cigBaseline || 0, last = lastHabitTs('cig');
  const first = firstLogKey();
  const used = Object.fromEntries(Object.entries(habitByDate('cig', 30, key)).filter(([k]) => first && k >= first));
  const cs = cigStats(used, base, p.cigCost);
  const wk = Object.entries(habitByDate('cig', 7, key)).filter(([k]) => first && k >= first).map(([, v]) => v), wkAvg = avg(wk), streak = lowerStreak(key, base);
  const free = smokeFree(key), sameRun = free >= 1 && free === streak; // same run: show smoke-free as the headline instead of "under usual"
  const facts = [];
  if (base) { facts.push(`Usual ${base} a day`); if (wkAvg != null) facts.push(`7-day average ${num1(wkAvg)}`); if (streak && !sameRun) facts.push(`under usual ${streak} day${streak > 1 ? 's' : ''} in a row`); }
  if (free >= 1 && !sameRun) facts.push(`Smoke-free days: ${free}`);
  const big = h('div', { class: 'bd-big' }, sinceText(last)), list = h('div', { class: 'bd-mslist' }, milestoneList(last));
  ui.since = { big, list };
  const lastTxt = last ? `Last cigarette ${new Date(last).toDateString() === new Date().toDateString() ? 'today' : new Date(last).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} at ${fmtTime(last)}` : 'No cigarette logged yet';
  const bars = lastNDays(30, key).map((k) => ({ label: fmtShortDate(k), value: habitCount(k, 'cig'), tip: `${fmtDateLabel(k, today)}: ${habitCount(k, 'cig')}` }));
  const card = h('div', { class: 'card bd-wide' }, head('cig', 'cig', 'Cigarettes', sameRun ? h('span', { class: 'pill good' }, `Smoke-free days: ${free}`) : cigVsUsual(n, base)),
    h('div', { class: 'bd-since' }, h('div', { class: 'bd-cap' }, 'Since last'), big, h('div', { class: 'small muted' }, lastTxt)),
    h('div', { class: 'bd-two' },
      h('div', null, h('div', { class: 'bd-cap' }, key === today ? 'Today' : fmtDateLabel(key, today)), h('div', { class: 'bd-num' + (lim && n > lim ? ' bad' : '') }, n, h('small', null, lim ? ` / ${lim} limit` : ' · no limit set'))),
      h('div', null, h('div', { class: 'bd-cap' }, 'Cravings beaten'), h('div', { class: 'bd-num good' }, beaten))),
    h('div', { class: 'bd-btns' }, h('button', { class: 'btn', onClick: () => cigAdd(c, 'cig') }, '+1 cigarette'),
      h('button', { class: 'btn primary', onClick: () => cigAdd(c, 'craving', 'Craving beaten. Nice one.') }, icon('check', 18), 'Craving beaten')),
    facts.length ? h('div', { class: 'small muted bd-facts' }, facts.join(' · ')) : null,
    p.cigCost ? h('div', { class: 'bd-two bd-money' },
      h('div', { class: 'bd-tile' }, h('div', { class: 'bd-num good' }, '₹ ', fmt(cs.moneySaved)), h('div', { class: 'small muted' }, 'saved vs usual, 30 days')),
      h('div', { class: 'bd-tile' }, h('div', { class: 'bd-num' }, '₹ ', fmt(cs.moneySpent)), h('div', { class: 'small muted' }, 'spent, 30 days'))) : null,
    list,
    h('div', { class: 'bd-sub' }, 'Last 30 days'),
    barChart({ bars, target: lim > 0 ? lim : undefined, height: 130, color: 'var(--cig)', colorOver: 'var(--bad)' }),
    legend([{ color: 'var(--cig)', label: 'Cigarettes' }].concat(lim > 0 ? [{ color: 'var(--bad)', label: 'Over limit' }] : [])));
  return card;
}

// ---- chai & coffee ----
function sugarTsp(e) {
  const m = /(\d+(?:\.\d+)?)\s*tsp\s*sugar/i.exec(e.name || '');
  const per = m ? +m[1] : (e.triggers || []).includes('sugar') ? 1 : 0;
  const q = Number.isFinite(e.qty) && e.qty > 0 && e.qty <= 6 ? e.qty : 1; // qty above 6 is a gram amount, not cups
  return per * q;
}

function chaiCard({ key, ctx }) {
  const food = dayIfAny(key)?.food || [];
  const chai = chaiCount(key), coffee = coffeeCount(key), total = chai + coffee;
  const logged = lastNDays(14, key).filter((k) => dayIfAny(k)?.food?.length);
  const avg14 = avg(logged.map((k) => chaiCount(k) + coffeeCount(k)));
  const tsp = Math.round(food.filter((e) => isChai(e) || isCoffee(e)).reduce((a, e) => a + sugarTsp(e), 0) * 2) / 2;
  const late = food.some((e) => isChai(e) && new Date(e.ts).getHours() >= 16);
  return h('div', { class: 'card' }, head('cup', 'chai', 'Chai & coffee'),
    h('div', { class: 'bd-num' }, total, h('small', null, total === 1 ? ' cup' : ' cups')),
    total ? h('div', { class: 'small muted' }, `${chai} chai · ${coffee} coffee`) : h('div', { class: 'small muted' }, 'None logged yet'),
    h('div', { class: 'small bd-line' }, avg14 != null ? `14-day average ${num1(avg14)} a day` : 'Average shows after a few logged days'),
    tsp ? h('div', { class: 'small bd-line' }, `About ${num1(tsp)} tsp sugar today`) : null,
    late ? h('div', { class: 'small bd-tip' }, icon('moon', 14), 'Last chai before 4 pm helps sleep.') : null,
    h('button', { class: 'btn sm bd-link', onClick: () => ctx.go('food') }, 'Log in Food'));
}

// ---- steps ----
const stepGoal = () => state.settings.stepTarget || 8000;

function stepsCard({ key }) {
  const goal = stepGoal(), steps = dayIfAny(key)?.steps || 0;
  const wk = lastNDays(7, key).map((k) => dayIfAny(k)?.steps).filter((v) => v > 0), wkAvg = avg(wk);
  return h('button', { class: 'card bd-tap', 'aria-label': 'Edit steps', onClick: () => stepsSheet(key) }, head('steps', 'train', 'Steps'),
    h('div', { class: 'bd-num' }, steps ? fmt(steps) : '–'), h('div', { class: 'small muted' }, `of ${fmt(goal)} goal`),
    bar((steps / goal) * 100, steps >= goal ? 'var(--good)' : 'var(--p)'),
    h('div', { class: 'small bd-line' }, wkAvg != null ? `7-day average ${fmt(wkAvg)}` : 'Tap to add today’s steps'));
}

function stepsSheet(key) {
  const d = dayIfAny(key) || {}; let goal = stepGoal();
  const input = h('input', { type: 'number', inputmode: 'numeric', min: 0, max: 100000, placeholder: 'For example 6500', value: d.steps ?? '' });
  sheet({ title: 'Steps', content: h('div', { class: 'stack' },
    numField('Steps today', input, 'Read it from your phone’s health app.'),
    numField('Daily goal', h('div', { class: 'row' }, stepper({ value: goal, min: 1000, max: 30000, step: 500, onChange: (v) => { goal = v; } }), h('span', { class: 'muted' }, 'steps')))),
  actions: (api) => [h('button', { class: 'btn', onClick: api.close }, 'Cancel'), h('button', { class: 'btn primary', onClick: () => {
    const v = parseInt(input.value, 10);
    if (Number.isFinite(v) && v >= 0) day(key).steps = v; else if (input.value === '' && d.steps != null) day(key).steps = null;
    state.settings.stepTarget = goal; commit('settings'); api.close(); toast('Steps saved');
  } }, 'Save')] });
}

// ---- water ----
function addWater(c, ml) {
  const e = logHabit(c.key, 'water', metaFor(c.key, c.today, { ml })); haptic();
  toast(`Water: ${fmt((waterMl(c.key)) / 1000, 2)} L`, { action: 'Undo', onAction: () => removeHabit(c.key, e.id) });
}

function waterCard(c) {
  const { key, today, t } = c;
  const glass = state.settings.glassMl || 250, goal = (t.water || 8) * glass, ml = waterMl(key);
  const bars = lastNDays(7, key).map((k) => ({ label: fmtDow(k)[0], hl: k === today, value: waterMl(k), tip: `${fmtDateLabel(k, today)}: ${fmt(waterMl(k) / 1000, 2)} L` }));
  return h('div', { class: 'card bd-wide' }, head('drop', 'water', 'Water', h('span', { class: 'small muted' }, `${fmt(ml / glass, 1)} of ${t.water || 8} glasses`)),
    h('div', { class: 'bd-num' }, fmt(ml / 1000, 2), h('small', null, ` L of ${fmt(goal / 1000, 1)} L`)),
    bar((ml / goal) * 100, ml >= goal ? 'var(--good)' : 'var(--water)'),
    h('div', { class: 'bd-btns' }, h('button', { class: 'btn', onClick: () => addWater(c, glass) }, icon('plus', 18), 'glass'), h('button', { class: 'btn', onClick: () => addWater(c, 500) }, icon('plus', 18), '500 ml')),
    h('div', { class: 'bd-sub' }, 'Last 7 days, litres'),
    barChart({ bars, target: goal, height: 110, color: 'var(--water)', fmtY: (v) => String(Math.round(v / 100) / 10) }));
}

// ---- sleep ----
function sleepSheet(key) {
  let v = dayIfAny(key)?.sleep || state.profile?.sleepTarget || 7.5;
  sheet({ title: 'Sleep last night', content: h('div', { class: 'row', style: { justifyContent: 'center' } }, stepper({ value: v, min: 0, max: 14, step: 0.5, onChange: (x) => { v = x; } }), h('span', { class: 'muted' }, 'hours')),
    actions: (api) => [h('button', { class: 'btn primary', onClick: () => { day(key).sleep = v; commit(); api.close(); toast(`Sleep saved: ${v} h`); } }, 'Save')] });
}

function sleepCard({ key, p }) {
  const target = p.sleepTarget || 7.5, d = dayIfAny(key), hrs = d?.sleep > 0 ? d.sleep : null;
  const pts = lastNDays(14, key).map((k) => { const v = dayIfAny(k)?.sleep; return { x: fmtShortDate(k), y: v > 0 ? v : null }; });
  const vals = pts.map((x) => x.y).filter((v) => v != null), mean = avg(vals);
  const status = hrs == null ? null : hrs >= target - 0.25 ? h('span', { class: 'pill good' }, 'On target') : h('span', { class: 'pill warn' }, `${num1(target - hrs)} h short`);
  return h('div', { class: 'card bd-wide' }, head('moon', 'weight', 'Sleep', h('button', { class: 'btn sm', onClick: () => sleepSheet(key) }, hrs == null ? 'Log' : 'Edit')),
    h('div', { class: 'row wrap' }, h('div', { class: 'bd-num' }, hrs == null ? '–' : num1(hrs), h('small', null, ` h of ${num1(target)} h target`)), status),
    d?.checkin?.sleepQ != null ? h('div', { class: 'small muted' }, `Quality ${d.checkin.sleepQ}/5 in your check-in`) : null,
    vals.length >= 2 ? h('div', null, h('div', { class: 'bd-sub' }, `Last 14 days · average ${num1(mean)} h`),
      lineChart({ series: [{ name: 'Sleep', color: 'var(--sleep)', points: pts, dots: true }], target, height: 150, fmtY: num1, unit: ' h', xLabels: 2 }))
      : h('div', { class: 'small muted bd-none' }, 'Log sleep for a few nights to see the trend.'));
}

// ---------- 5. Measurements ----------
const TAPE = [['waist', 'Waist'], ['chest', 'Chest'], ['arms', 'Arms'], ['thighs', 'Thighs'], ['hips', 'Hips'], ['neck', 'Neck']];

const removeLabel = (key, today) => (key === today ? 'Remove today’s entry' : 'Remove this day’s entry');

function weightSheet(key, today) {
  const prev = dayIfAny(key)?.weight || null;
  let v = prev || latestWeight()?.kg || 70;
  sheet({ title: 'Weigh in', content: (api) => h('div', { class: 'stack' }, h('p', { class: 'small muted' }, 'Best first thing in the morning, after the loo, before chai. Same scale every time.'),
    h('div', { class: 'row', style: { justifyContent: 'center' } }, stepper({ value: v, min: 30, max: 250, step: 0.1, onChange: (x) => { v = x; } }), h('span', { class: 'muted' }, 'kg')),
    prev ? h('button', { type: 'button', class: 'bd-rm', onClick: () => { api.close(); setWeight(key, null); toast('Weight entry removed', { action: 'Undo', onAction: () => setWeight(key, prev) }); } }, removeLabel(key, today)) : null),
  actions: (api) => [h('button', { class: 'btn primary', onClick: () => { setWeight(key, v); api.close(); toast(`Weight saved: ${v} kg`); } }, 'Save')] });
}

function measureSheet(key, today) {
  const cur = { ...(dayIfAny(key)?.measurements || {}) };
  const hasAny = TAPE.some(([f]) => cur[f]);
  const inputs = TAPE.map(([f, label]) => {
    const latest = measurementSeries(f).slice(-1)[0];
    return [f, label, h('input', { type: 'number', inputmode: 'decimal', step: '0.1', min: 10, max: 300, placeholder: latest ? String(latest.v) : 'cm', value: cur[f] ?? '' })];
  });
  const clearDay = (api) => { api.close(); setMeasurements(key, Object.fromEntries(TAPE.map(([f]) => [f, null]))); toast('Measurements removed', { action: 'Undo', onAction: () => setMeasurements(key, cur) }); };
  sheet({ title: 'Measure', content: (api) => h('div', { class: 'stack' },
    h('p', { class: 'small muted' }, 'Tape snug, not tight, on bare skin. Waist at the navel after breathing out. Same spots, same time of day.'),
    h('div', { class: 'grid-2' }, inputs.map(([, label, input]) => numField(`${label} (cm)`, input))),
    hasAny ? h('button', { type: 'button', class: 'bd-rm', onClick: () => clearDay(api) }, removeLabel(key, today)) : null),
  actions: (api) => [h('button', { class: 'btn', onClick: api.close }, 'Cancel'), h('button', { class: 'btn primary', onClick: () => {
    const m = {};
    for (const [f, , input] of inputs) { const v = parseFloat(input.value); if (Number.isFinite(v) && v >= 10 && v <= 300) m[f] = v; }
    api.close();
    if (Object.keys(m).length) { setMeasurements(key, m); toast('Measurements saved'); }
  } }, 'Save')] });
}

// Waist change vs weight change between the first and last tape reading.
function waistNote(ws) {
  const a = ws[0], b = ws[ws.length - 1], all = weights();
  const near = (date) => all.reduce((best, w) => (!best || Math.abs(dt(w.date) - dt(date)) < Math.abs(dt(best.date) - dt(date)) ? w : best), null);
  const wa = near(a.date), wb = near(b.date), dW = wa && wb && wa.date !== wb.date ? wb.kg - wa.kg : null, dWaist = b.v - a.v;
  const text = `Since ${fmtShortDate(a.date)}: waist ${signed(dWaist)} cm${dW != null ? ` · weight ${signed(dW)} kg` : ''}`;
  return h('div', { class: 'row wrap bd-facts' }, h('span', { class: 'small strong' }, text), dWaist <= -1 && dW != null && Math.abs(dW) <= 0.5 ? h('span', { class: 'pill good' }, 'Recomping') : null);
}

function measuresSection({ key, today }) {
  const lw = latestWeight(), ws = weights(), waist = measurementSeries('waist');
  const delta = ws.length >= 2 ? ws[ws.length - 1].kg - ws[0].kg : null;
  const tiles = TAPE.map(([f, label]) => {
    const s = measurementSeries(f), now = s.length ? s[s.length - 1].v : null, d = s.length >= 2 ? now - s[0].v : null;
    return h('div', { class: 'bd-tile' }, h('div', { class: 'bd-cap' }, label), h('div', { class: 'bd-num sm' }, now != null ? num1(now) : '–', h('small', null, now != null ? ' cm' : '')), d != null ? h('div', { class: 'micro ' + (d < 0 ? 'good' : 'muted') }, `${signed(d)} cm`) : null);
  });
  const card = h('div', { class: 'card' }, head('scale', 'weight', 'Weight and tape'),
    h('div', { class: 'row between' }, h('div', { class: 'grow' }, h('div', { class: 'bd-num' }, lw ? num1(lw.kg) : '–', h('small', null, ' kg')),
      h('div', { class: 'small muted' }, lw && lw.date ? `Weighed ${fmtShortDate(lw.date)}${delta != null ? ` · ${signed(delta)} kg since ${fmtShortDate(ws[0].date)}` : ''}` : 'From your profile. Weigh in to start tracking.')),
    h('button', { class: 'btn', onClick: () => weightSheet(key, today) }, 'Weigh in')),
    h('div', { class: 'bd-tapehead' }, h('div', { class: 'bd-sub' }, 'Tape measurements'), h('button', { class: 'btn sm', onClick: () => measureSheet(key, today) }, icon('edit', 16), 'Measure')),
    h('div', { class: 'bd-tapes' }, tiles));
  if (waist.length >= 2) append(card, [h('div', { class: 'bd-sub' }, 'Waist over time'), lineChart({ series: [{ name: 'Waist', color: 'var(--p)', points: waist.map((w) => ({ x: fmtShortDate(w.date), y: w.v })), dots: true }], height: 150, fmtY: num1, unit: ' cm' }), waistNote(waist)]);
  else card.append(h('div', { class: 'small muted bd-none' }, 'Measure your waist every week or two. The tape often moves before the scale does.'));
  card.append(h('div', { class: 'small muted bd-note' }, 'Waist down + weight flat = you are recomping. Trust the tape.'));
  return sec('Measurements', card);
}

// ---------- 6. Patterns ----------
let patCache = { sig: '', res: null };
// symptomPatterns() runs permutation tests (random), so cache it: same data gives the same answer between redraws.
function patterns() {
  const sig = lastNDays(60).map((k) => { const d = dayIfAny(k); return d ? `${(d.food || []).length}.${(d.symptoms || []).length}.${d.checkin?.ts || 0}` : '-'; }).join('|') + '|' + Math.floor(Date.now() / 3600000);
  if (patCache.sig !== sig) {
    try { patCache = { sig, res: symptomPatterns(60) }; } catch (e) { console.error(e); patCache = { sig, res: { ready: false, covered: 0, patterns: [], protective: [], tooCommon: [] } }; }
  }
  return patCache.res;
}

// Generic tips from knowledge.symptomHints matched to the day's food triggers (tags) or food ids. Up to 3.
function generalTips(key) {
  const sh = state.data.knowledge?.symptomHints;
  if (!sh) return [];
  const food = dayIfAny(key)?.food || [], tags = new Set(), ids = new Map();
  for (const e of food) { (e.triggers || []).forEach((t) => tags.add(t)); if (e.foodId) ids.set(e.foodId, e.name); }
  const out = [], seen = new Set();
  for (const hint of Array.isArray(sh) ? sh : Object.values(sh)) {
    const tr = hint.trigger || {}, tag = [].concat(tr.tags || []).find((t) => tags.has(t)), fid = [].concat(tr.foodIds || []).find((i) => ids.has(i));
    if (!hint.hint || (!tag && !fid) || seen.has(hint.hint)) continue;
    seen.add(hint.hint);
    out.push({ label: tr.label || (tag ? TAG_LABELS[tag] || tag : ids.get(fid)), text: hint.hint });
    if (out.length === 3) break;
  }
  return out;
}

const CONF = { early: ['warn', 'Early pattern'], repeating: ['good', 'Repeating'], strong: ['good', 'Strong'] };
const cmpRow = (label, v, color) => h('div', { class: 'bd-cmp' }, h('span', { class: 'small' }, label), bar(v * 100, color), h('b', { class: 'small' }, Math.round(v * 100) + '%'));

function patternCard(p) {
  const [cls, label] = CONF[p.confidence] || CONF.early;
  return h('div', { class: 'card flat bd-pat' },
    h('div', { class: 'row between' }, h('h3', { class: 'grow' }, `${p.symptomLabel} → ${p.tagLabel}`), h('span', { class: 'pill ' + cls }, label)),
    h('div', { class: 'bd-cmps' }, cmpRow(`After ${p.tagLabel.toLowerCase()}`, p.pT, 'var(--warn)'), cmpRow('Other meals', p.pN, 'var(--good)')),
    h('div', { class: 'small' }, p.text), h('div', { class: 'small muted' }, p.caveat), h('div', { class: 'small bd-pat-tip' }, p.tip));
}

function patternsSection({ key }) {
  const res = patterns(), card = h('div', { class: 'card' });
  card.append(head('heart', 'food', 'Food patterns', res.ready ? h('span', { class: 'small muted' }, `${res.covered} days of check-ins`) : null));
  if (!res.ready) {
    card.append(h('div', { class: 'bd-num sm' }, res.covered, h('small', null, ' of 14 days with check-ins')), bar((res.covered / 14) * 100, 'var(--accent)'),
      h('div', { class: 'small bd-line' }, 'After two weeks of check-ins the app looks for foods that keep showing up before bloating, gas, acidity, low energy or poor sleep.'));
    const tips = generalTips(key);
    if (tips.length) append(card, [h('div', { class: 'bd-sub' }, 'General tips'), tips.map((t) => h('div', { class: 'bd-gtip' }, h('b', { class: 'small' }, t.label), h('div', { class: 'small' }, t.text)))]);
  } else {
    if (!res.patterns.length) card.append(h('div', { class: 'small bd-line' }, 'No clear food pattern yet. That is good news, or it means more check-ins are needed.'));
    else card.append(h('div', { class: 'bd-pats' }, res.patterns.map(patternCard)));
    const prot = [...new Set((res.protective || []).map((r) => r.tagLabel))];
    if (prot.length) card.append(h('div', { class: 'small muted bd-line' }, `Fewer problems after: ${prot.join(' · ')}`));
    if ((res.tooCommon || []).length) card.append(h('div', { class: 'small muted bd-line' }, `Eaten too often to judge: ${res.tooCommon.join(' · ')}`));
  }
  card.append(h('div', { class: 'small muted bd-note' }, 'These are patterns, not diagnoses. Try a two-week swap, then re-check. Don’t cut a whole food group on one pattern.'));
  return sec('Patterns', card);
}

// ---------- 7. Iron nudge ----------
function ironNudge({ key }) {
  const food = dayIfAny(key)?.food || [];
  const caf = food.filter((e) => (e.triggers || []).includes('caffeine')), iron = food.filter((e) => (e.micro?.iron || 0) >= 3);
  if (!caf.some((c) => iron.some((f) => f !== c && Math.abs(c.ts - f.ts) <= 3600000))) return null;
  return sec(null, h('div', { class: 'callout' }, icon('info'), h('div', null, 'Chai within an hour of an iron-rich meal blocks a lot of the iron. Try a 1-hour gap or add lemon.')));
}
