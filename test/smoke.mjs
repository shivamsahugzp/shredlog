// Headless Chrome smoke test over CDP: loads the app, runs onboarding-free checks, captures console errors + screenshots.
// Usage: node test/smoke.mjs [port]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = process.argv[2] || 8765;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync('test/out', { recursive: true });
const server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1'], { cwd: process.cwd(), stdio: 'ignore' });
const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=9333', '--window-size=390,844', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', `--user-data-dir=/tmp/shredlog-chrome-${Date.now()}`, 'about:blank'], { stdio: 'ignore' });
await sleep(1200);
const targets = await (await fetch('http://127.0.0.1:9333/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const errors = []; const logs = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) logs.push(m.params.type + ': ' + m.params.args.map((a) => a.value || a.description).join(' '));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logs.push('log: ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval failed'); return r.result.result.value; };
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(`test/out/${name}.png`, Buffer.from(r.result.data, 'base64')); };
await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true });

const base = `http://127.0.0.1:${PORT}/`;
const results = [];
const check = (name, ok, info = '') => { results.push({ name, ok, info }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${info}`); };
try {
  await send('Page.navigate', { url: base }); await sleep(1500);
  check('boot renders onboarding', await evalJs(`!!document.querySelector('.onb')`));
  await shot('01-onboarding');
  // seed a profile directly through the module to skip the wizard, then reload
  await evalJs(`(async()=>{const s=await import('./js/state.js'); s.setProfile({name:'Test',sex:'male',age:28,heightCm:175,weightKg:78,activity:'moderate',goal:'cut',diet:'egg',region:'north',budget:'moderate',chaiCups:2,chaiFoodId:'chai_milk_1tsp',coffee:false,smoker:true,cigBaseline:6,cigCost:18,sleepTarget:7.5}); s.setWeight(s.todayKey(),78); s.setSetting('trackWater', true); await s.save(true); return true;})()`);
  await send('Page.navigate', { url: base + '#today' }); await sleep(1500);
  check('today renders fuel bar', await evalJs(`!!document.querySelector('.fuel')`));
  const kcal = await evalJs(`(async()=>(await import('./js/state.js')).state.targets.kcal)()`); check('targets computed', kcal > 1200 && kcal < 4000, `kcal=${kcal}`);
  await shot('02-today-empty');
  // quick logs
  await evalJs(`[...document.querySelectorAll('.quick button')].find(b=>b.textContent.includes('Chai')).click()`); await sleep(300);
  await evalJs(`[...document.querySelectorAll('.quick button')].find(b=>b.textContent.includes('Cigarette')).click()`); await sleep(300);
  await evalJs(`[...document.querySelectorAll('.quick button')].find(b=>b.textContent.includes('Water')).click()`); await sleep(400);
  const tot = await evalJs(`(async()=>{const s=await import('./js/state.js');return JSON.stringify({t:s.dayTotals(s.todayKey()),cig:s.habitCount(s.todayKey(),'cig'),water:s.waterMl(s.todayKey())})})()`);
  check('quick logs stored', /"kcal":[1-9]/.test(tot) && /"cig":1/.test(tot) && /"water":250/.test(tot), tot);
  await shot('03-today-logged');
  // v2: counter tiles can undo an accidental tap with the minus button; accent setting applies to the document
  await evalJs(`document.querySelector('.quick .qt .minus')?.dispatchEvent(new MouseEvent('click',{bubbles:true}))`); await sleep(400);
  const afterMinus = await evalJs(`(async()=>{const s=await import('./js/state.js');return JSON.stringify({chai:s.chaiCount(s.todayKey()),cig:s.habitCount(s.todayKey(),'cig'),minus:document.querySelectorAll('.quick .qt .minus').length})})()`);
  check('tile minus removes the latest chai', /"chai":0/.test(afterMinus) && /"cig":1/.test(afterMinus), afterMinus);
  await evalJs(`(async()=>{const s=await import('./js/state.js'); s.setSetting('accent','neel'); return 1})()`); await sleep(200);
  check('accent setting applies to the document', await evalJs(`document.documentElement.getAttribute('data-accent')==='neel'`));
  await evalJs(`(async()=>{const s=await import('./js/state.js'); s.setSetting('accent','haldi'); return 1})()`); await sleep(100);
  const segOk = await evalJs(`(()=>{const el=document.querySelector('.seg'); if(!el) return 'noseg'; const n=el.querySelectorAll('button[data-id]').length; const th=el.querySelector('.seg-thumb'); return th && Math.abs(th.getBoundingClientRect().width*n - (el.clientWidth-6)) < 12 ? 'ok' : 'bad '+n+' '+(th&&th.getBoundingClientRect().width)+' '+el.clientWidth})()`);
  check('segmented thumb sized to its options', segOk === 'ok' || segOk === 'noseg', segOk);
  // data safety: a daily safety copy exists after the first save; a v1-shaped backup imports with every entry intact and a pre-import copy is kept
  const bk = await evalJs(`(async()=>{const s=await import('./js/state.js'); s.logHabit(s.todayKey(),'note',{note:'x'}); await s.flush(); await new Promise(r=>setTimeout(r,300)); s.removeHabit(s.todayKey(), s.habitEntries(s.todayKey(),'note')[0].id); const l=await s.listBackups(); return JSON.stringify({n:l.length, entries:l[0]?.entries, label:l[0]?.label})})()`);
  check('daily safety copy is written', /"n":[1-9]/.test(bk) && /"entries":[1-9]/.test(bk), bk);
  const legacy = JSON.stringify({ app: 'shredlog', version: 1, exported: '2026-11-02T10:00:00Z', meta: { v: 1, created: 1762000000000, lastBackup: null }, profile: { name: 'Legacy', sex: 'male', age: 30, heightCm: 172, weightKg: 80, activity: 'moderate', goal: 'cut', diet: 'veg', region: 'north', budget: 'moderate', chaiCups: 3, chaiFoodId: 'chai_milk_1tsp', coffee: false, smoker: true, cigBaseline: 8, cigCost: 18, sleepTarget: 7 }, targets: { kcal: 2000, p: 150, c: 220, f: 60, fiber: 28, water: 8, cigLimit: 6, auto: true }, settings: { theme: 'auto', restSec: 90, glassMl: 250, recents: ['dal_tadka'], onboarded: true, lastWeeklyReview: null, currentRoutineId: 'ppl6', routineDayIndex: 2 }, log: { '2026-11-01': { food: [{ id: 'f1', ts: 1761990000000, foodId: 'dal_tadka', name: 'Dal Tadka', cat: 'Dal', qty: 1, unit: { label: '1 katori', g: 150 }, g: 150, kcal: 165, p: 8, c: 20, f: 6, fiber: 4, sugar: 2, micro: null, triggers: ['legume'], meal: 'lunch', oilTsp: 1 }], habits: [{ id: 'h1', ts: 1761995000000, type: 'cig' }, { id: 'h2', ts: 1761996000000, type: 'water', ml: 250 }], water: 0, sleep: 7, steps: 4000, weight: 80.2, notes: '', measurements: { waist: 90 }, partial: false, checkin: { energy: 3, mood: 4, hunger: 2, sleepQ: 3 }, symptoms: [{ id: 's1', ts: 1761997000000, type: 'bloating', sev: 2 }] } }, workouts: [{ id: 'w1', name: 'Legs', start: 1761980000000, end: 1761983600000, exercises: [{ exId: 'barbell_back_squat', name: 'Barbell Back Squat', type: 'strength', met: 6, sets: [{ k: 'a', t: 'N', done: true, w: 80, r: 8 }, { k: 'b', t: 'W', done: true, w: 40, r: 10 }], notes: 'felt ok' }], volume: 640, kcal: 250, prs: [{ exId: 'barbell_back_squat', kind: 'e1rm' }], feel: 'good' }], active: null, customFoods: [{ id: 'custom_x1', name: 'Mum’s rajma', cat: 'Dal', per100: { kcal: 120, p: 7, c: 18, f: 2 }, servings: [{ label: '1 katori', g: 150 }], custom: true }], favFoods: ['dal_tadka'], savedMeals: [{ id: 'm1', name: 'Usual lunch', items: [] }], customRoutines: [], customExercises: [] });
  const imp = await evalJs(`(async()=>{const s=await import('./js/state.js'); await s.importJSON(${JSON.stringify(legacy)}); const d=s.state.log['2026-11-01']; const l=await s.listBackups(); return JSON.stringify({name:s.state.profile.name, food:d.food.length, habits:d.habits.length, sym:d.symptoms.length, weight:d.weight, steps:d.steps, ck:!!d.checkin, workouts:s.state.workouts.length, prs:s.state.workouts[0].prs.length, custom:s.state.customFoods.length, favs:s.state.favFoods.length, meals:s.state.savedMeals.length, routine:s.state.settings.currentRoutineId, trackWater:s.state.settings.trackWater, pre:l.some(b=>b.label.startsWith('before-import'))})})()`);
  check('v1 backup imports with every field intact', /"name":"Legacy"/.test(imp) && /"food":1/.test(imp) && /"habits":2/.test(imp) && /"sym":1/.test(imp) && /"weight":80.2/.test(imp) && /"steps":4000/.test(imp) && /"ck":true/.test(imp) && /"workouts":1/.test(imp) && /"prs":1/.test(imp) && /"custom":1/.test(imp) && /"favs":1/.test(imp) && /"meals":1/.test(imp) && /"routine":"ppl6"/.test(imp) && /"trackWater":false/.test(imp) && /"pre":true/.test(imp), imp);
  for (const tab of ['today', 'food', 'train', 'body', 'progress', 'settings']) { await evalJs(`location.hash='#${tab}'`); await sleep(700); }
  check('legacy data renders on every tab without errors', errors.length === 0, errors.join(' | ').slice(0, 200));
  const back = await evalJs(`(async()=>{const s=await import('./js/state.js'); const l=await s.listBackups(); const pre=l.find(b=>b.label.startsWith('before-import')); await s.restoreBackup(pre.key); return s.state.profile.name})()`);
  check('restore an earlier copy brings the previous data back', back === 'Test', `name=${back}`);
  const H1 = { food: 'Food', train: 'Train', body: 'Body', progress: 'Progress', settings: 'Settings' };
  for (const tab of ['food', 'train', 'body', 'progress', 'settings']) {
    await evalJs(`location.hash='#${tab}'`); await sleep(1000);
    const h1 = await evalJs(`document.querySelector('#app h1')?.textContent || ''`);
    check(`tab ${tab} renders`, h1.startsWith(H1[tab]), `h1="${h1}"`); await shot(`04-${tab}`);
  }
  // train flow: seed an active workout with one set, tick it, finish, verify
  await evalJs(`(async()=>{const s=await import('./js/state.js'); s.startWorkout({name:'Push A', exercises:[{exId:'barbell_bench_press', name:'Barbell Bench Press', type:'strength', met:5, sets:[{k:'s1', w:60, r:10, done:false, t:'N'}], notes:''}]}); return true;})()`);
  await evalJs(`location.hash='#today'`); await sleep(500); await evalJs(`location.hash='#train'`); await sleep(1200);
  const hasRow = await evalJs(`!!document.querySelector('.set-row .done')`); check('active workout renders set rows', hasRow);
  await evalJs(`document.querySelector('.set-row .done')?.click()`); await sleep(500);
  const st = await evalJs(`(async()=>{const s=await import('./js/state.js'); const a=s.state.active; return JSON.stringify({done:a?.exercises[0].sets[0].done, rest:!!a?.rest})})()`);
  check('set ticked + rest timer started', /"done":true/.test(st) && /"rest":true/.test(st), st);
  await shot('05-train-active');
  await evalJs(`(async()=>{const s=await import('./js/state.js'); s.finishWorkout({kcal:120, volume:600, prs:[], durationSec:1800}); return true;})()`);
  await evalJs(`location.hash='#today'`); await sleep(900);
  const todayHasWorkout = await evalJs(`document.body.textContent.includes('Push A')`); check('finished workout shows on Today', todayHasWorkout);
  // body check-in sheet opens
  await evalJs(`location.hash='#body'`); await sleep(1000);
  const bodyBtn = await evalJs(`!!document.querySelector('#app button')`); check('body has actions', bodyBtn);
  await evalJs(`(async()=>{const s=await import('./js/state.js'); s.setCheckin(s.todayKey(), {energy:4, mood:4, hunger:3, sleepQ:3, stool:4, skin:0, headache:0}); s.logSymptom(s.todayKey(), 'bloating', 2); return true;})()`); await sleep(500);
  await shot('06-body-after-checkin');
  await evalJs(`location.hash='#progress'`); await sleep(1200); await shot('07-progress');
  // PIN lock: set a pin, reload, expect lock screen, enter wrong then right pin
  await evalJs(`(async()=>{const s=await import('./js/state.js'); const l=await import('./js/lock.js'); s.setSetting('pinHash', await l.hashPin('1234')); await s.save(true); return true;})()`);
  await send('Page.reload', {}); await sleep(1800);
  check('lock screen shows when PIN set', await evalJs(`!!document.querySelector('.lock')`)); await shot('08-lock');
  for (const k of ['9','9','9','9']) await evalJs(`[...document.querySelectorAll('.lock-key')].find(b=>b.textContent==='${k}').click()`); await sleep(700);
  check('wrong PIN rejected', await evalJs(`!!document.querySelector('.lock')`));
  for (const k of ['1','2','3','4']) await evalJs(`[...document.querySelectorAll('.lock-key')].find(b=>b.textContent==='${k}').click()`); await sleep(900);
  check('correct PIN unlocks the app', await evalJs(`!document.querySelector('.lock') && !!document.querySelector('#app h1')`));
  // persistence: clear the PIN, log something, let the debounce run, reload → data must still be there
  await evalJs(`(async()=>{const s=await import('./js/state.js'); s.setSetting('pinHash', null); s.logHabit(s.todayKey(),'cig'); return true;})()`); await sleep(600);
  await send('Page.reload', {}); await sleep(1800);
  const afterReload = await evalJs(`(async()=>{const s=await import('./js/state.js'); return JSON.stringify({onb:s.state.settings.onboarded, cig:s.habitCount(s.todayKey(),'cig'), src:s.storage.source, ls:s.storage.ls, idb:s.storage.idb, saved:s.storage.lastSaved>0})})()`);
  check('data survives reload', /"onb":true/.test(afterReload) && /"cig":2/.test(afterReload) && /"saved":true/.test(afterReload), afterReload);
  // persistence with IndexedDB hanging (iOS home-screen bug): app must still boot from localStorage within a few seconds
  const { identifier } = (await send('Page.addScriptToEvaluateOnNewDocument', { source: `indexedDB.open = () => ({ set onsuccess(f){}, set onerror(f){}, set onupgradeneeded(f){}, set onblocked(f){} });` })).result;
  await send('Page.reload', {}); await sleep(6500);
  const idbHang = await evalJs(`(async()=>{const s=await import('./js/state.js'); return JSON.stringify({h1:document.querySelector('#app h1')?.textContent||'', onb:s.state.settings.onboarded, cig:s.habitCount(s.todayKey(),'cig'), src:s.storage.source, idb:s.storage.idb, blocked:s.storage.blocked})})()`);
  check('boots from localStorage when IndexedDB hangs', /"onb":true/.test(idbHang) && /"cig":2/.test(idbHang) && /"src":"ls"/.test(idbHang) && /"idb":"failed"/.test(idbHang) && /"blocked":false/.test(idbHang), idbHang);
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
  // onboarding draft: reset, go to step 2 of the wizard, reload → wizard resumes at step 2 with typed values
  await evalJs(`(async()=>{const s=await import('./js/state.js'); await s.resetAll(); return true;})()`);
  await send('Page.reload', {}); await sleep(1800);
  check('reset returns to onboarding', await evalJs(`!!document.querySelector('.onb')`));
  await evalJs(`const i=document.querySelector('.onb input[type=text]'); i.value='Draft'; i.dispatchEvent(new Event('input',{bubbles:true})); [...document.querySelectorAll('.onb button')].find(b=>b.textContent.trim()==='Next').click()`); await sleep(600);
  await send('Page.reload', {}); await sleep(1800);
  const draft = await evalJs(`(async()=>{const s=await import('./js/state.js'); const dr=s.state.settings.onboardingDraft; return JSON.stringify({onb:!!document.querySelector('.onb'), step:dr?.step, name:dr?.d?.name, lit:document.querySelectorAll('.onb .steps i.on').length})})()`);
  check('onboarding resumes where it left off', /"onb":true/.test(draft) && /"step":1/.test(draft) && /"name":"Draft"/.test(draft) && /"lit":2/.test(draft), draft);
  await shot('09-onboarding-resumed');
  // ---- phase 2: catalogue, body map, weekday learner, form guide, plate scanner ----
  await evalJs(`(async()=>{const s=await import('./js/state.js'); s.setProfile({name:'Test',sex:'male',age:28,heightCm:175,weightKg:78,activity:'moderate',goal:'cut',diet:'egg',region:'north',budget:'moderate',chaiCups:2,chaiFoodId:'chai_milk_1tsp',coffee:false,smoker:false,sleepTarget:7.5}); s.setWeight(s.todayKey(),78);
    // seed 4 Mondays of chest/triceps/shoulders and 4 Wednesdays of back/biceps
    const DAY=864e5; const now=new Date(); const mk=(exId,name,cat,w)=>({exId,name,cat,type:'strength',met:5,sets:[{k:'a',t:'N',done:true,w,r:10},{k:'b',t:'N',done:true,w,r:9},{k:'c',t:'N',done:true,w,r:8}]});
    for (let k=1;k<=4;k++){ for (const [dow,exs] of [[1,[mk('barbell_bench_press','Barbell Bench Press','Chest',60),mk('tricep_pushdown_rope','Tricep Pushdown (Rope)','Triceps',25),mk('seated_dumbbell_shoulder_press','Seated Dumbbell Shoulder Press','Shoulders',20)]],[3,[mk('lat_pulldown_wide','Lat Pulldown (Wide)','Back',50),mk('barbell_curl','Barbell Curl','Biceps',25)]]]) { const d=new Date(now); d.setDate(d.getDate()-((d.getDay()-dow+7)%7)-7*k); d.setHours(18,0,0,0); s.state.workouts.push({id:'seed'+dow+k,name:'Seed',start:d.getTime(),end:d.getTime()+3600e3,exercises:exs,kcal:200,volume:3000}); } }
    s.save(true); return s.state.data.exercises.length; })()`).then((n) => check('catalogue has 600 exercises', n === 600, `n=${n}`));
  const pat = await evalJs(`(async()=>{const p=await import('./js/train-plan.js'); const w=p.weekdayPattern(); return JSON.stringify({mon:w[1].kind, monG:w[1].groups, wed:w[3].kind, sun:w[0].kind})})()`);
  check('weekday learner finds Monday pattern', /"mon":"train"/.test(pat) && /Chest/.test(pat) && /"wed":"train"/.test(pat) && /"sun":"rest"/.test(pat), pat);
  await evalJs(`location.hash='#train'`); await sleep(1500);
  check('train home shows plan card + week strip', await evalJs(`!!document.querySelector('.tr-plan-card') && document.querySelectorAll('.tr-week-strip .tr-wk').length === 7`));
  const paths = await evalJs(`new Set([...document.querySelectorAll('.bm-svg path[data-muscle]')].map(p=>p.dataset.muscle)).size`); check('body map covers all 19 muscles', paths === 19, `muscles=${paths}`);
  await shot('10-train-home');
  await evalJs(`document.querySelector('.tr-build-card button.primary').click()`); await sleep(900);
  check('muscle picker opens', await evalJs(`!!document.querySelector('.tr-picker')`));
  await evalJs(`(()=>{const p=document.querySelector('.tr-picker .bm-svg path[data-muscle="chest"][role=button]'); p.dispatchEvent(new MouseEvent('click',{bubbles:true})); if(!p.classList.contains('on')) p.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true})); return p.classList.contains('on')})()`); await sleep(700);
  const rows = await evalJs(`document.querySelectorAll('.tr-picker .tr-prow').length`); check('picking chest lists chest exercises', rows > 5, `rows=${rows}`);
  await shot('11-picker');
  await evalJs(`document.querySelector('.tr-picker .tr-prow .tr-prow-main').click()`); await sleep(300);
  await evalJs(`document.querySelector('.tr-foot button.primary, .tr-foot button').click()`); await sleep(1500);
  check('picker starts a workout', await evalJs(`(async()=>{const s=await import('./js/state.js'); return !!s.state.active && !!document.querySelector('.set-row')})()`));
  await evalJs(`document.querySelector('.tr-ex-head .tr-info')?.click()`); await sleep(900);
  const guide = await evalJs(`JSON.stringify({d:!!document.querySelector('.tr-detail'), media:!!document.querySelector('.tr-media'), steps:document.querySelectorAll('.tr-steps li').length, yt:!!document.querySelector('.tr-yt')})`);
  check('form guide shows media, steps and video link', /"d":true/.test(guide) && /"media":true/.test(guide) && /"steps":[1-9]/.test(guide) && /"yt":true/.test(guide), guide);
  await shot('12-form-guide');
  await evalJs(`(async()=>{const s=await import('./js/state.js'); s.discardWorkout(); document.querySelectorAll('.sheet .close, [aria-label=Close]').forEach(b=>b.click()); return true})()`); await sleep(500);
  // plate scanner with the mock model and a generated photo
  await evalJs(`(()=>{const c=document.createElement('canvas'); c.width=320; c.height=240; const g=c.getContext('2d'); g.fillStyle='#d9a441'; g.fillRect(0,0,320,240); g.fillStyle='#7a4a12'; g.beginPath(); g.arc(160,120,80,0,7); g.fill(); window.__shredlogMockImage=c.toDataURL('image/jpeg');
    const items=[{name:'Dal tadka',desc:'1 katori',qty:1,unit:'katori',grams:150,kcal:180,protein_g:9,carbs_g:24,fat_g:5,fiber_g:6,confidence:0.8,match_hint:'dal tadka'},{name:'Roti',desc:'2 rotis',qty:2,unit:'roti',grams:80,kcal:240,protein_g:8,carbs_g:44,fat_g:3,fiber_g:4,confidence:0.65,match_hint:'roti'}];
    window.__shredlogMockAI={delayMs:200,responses:[{items,questions:[{id:'dal_fat',text:'How much ghee went into the dal?',options:['Light (1 tsp)','Normal (2 tsp)','Heavy (1 tbsp+)'],affects:['Dal tadka']}],notes:''},{items:[{...items[0],kcal:150,fat_g:2.5},items[1]],questions:[],notes:''}]}; return true})()`);
  await evalJs(`location.hash='#food'`); await sleep(1200);
  await evalJs(`document.querySelector('.fd-scan').click()`); await sleep(600);
  check('scanner opens on capture step', await evalJs(`!!document.querySelector('.sc-sheet .sc-capture')`));
  await evalJs(`document.querySelector('.sc-btn-gallery').click()`); await sleep(1800);
  const rev = await evalJs(`JSON.stringify({review:!!document.querySelector('.sc-review'), items:document.querySelectorAll('.sc-item').length, q:document.querySelectorAll('.sc-question').length})`);
  check('scanner shows items and a question', /"review":true/.test(rev) && /"items":2/.test(rev) && /"q":1/.test(rev), rev);
  await shot('13-scan-review');
  await evalJs(`document.querySelector('.sc-question .sc-opt').click()`); await sleep(200);
  await evalJs(`document.querySelector('.sc-reestimate').click()`); await sleep(1500);
  const before = await evalJs(`(async()=>{const s=await import('./js/state.js'); return s.dayTotals(s.todayKey()).kcal})()`);
  await evalJs(`document.querySelector('.sc-log').click()`); await sleep(900);
  const after = await evalJs(`(async()=>{const s=await import('./js/state.js'); return JSON.stringify({kcal:s.dayTotals(s.todayKey()).kcal, pref:!!s.state.settings.foodMemory?.prefs?.dal_fat, dish:Object.keys(s.state.settings.foodMemory?.dishes||{}).length})})()`);
  check('scan logs items and remembers the answer', JSON.parse(after).kcal > before + 300 && /"pref":true/.test(after) && /"dish":[1-9]/.test(after), `before=${before} ${after}`);
  await shot('14-scan-logged');
} catch (e) { check('script', false, e.message); }
await sleep(300);
console.log('\nConsole errors/warnings:'); for (const l of [...errors, ...logs]) console.log('  ' + l.split('\n')[0].slice(0, 220));
if (!errors.length && !logs.length) console.log('  none');
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
ws.close(); chrome.kill(); server.kill();
process.exit(results.every((r) => r.ok) && errors.length === 0 ? 0 : 1);
