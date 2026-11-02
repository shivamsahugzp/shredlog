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
  await evalJs(`(async()=>{const s=await import('./js/state.js'); s.setProfile({name:'Test',sex:'male',age:28,heightCm:175,weightKg:78,activity:'moderate',goal:'cut',diet:'egg',region:'north',budget:'moderate',chaiCups:2,chaiFoodId:'chai_milk_1tsp',coffee:false,smoker:true,cigBaseline:6,cigCost:18,sleepTarget:7.5}); s.setWeight(s.todayKey(),78); await s.save(true); return true;})()`);
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
} catch (e) { check('script', false, e.message); }
await sleep(300);
console.log('\nConsole errors/warnings:'); for (const l of [...errors, ...logs]) console.log('  ' + l.split('\n')[0].slice(0, 220));
if (!errors.length && !logs.length) console.log('  none');
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
ws.close(); chrome.kill(); server.kill();
process.exit(results.every((r) => r.ok) && errors.length === 0 ? 0 : 1);
