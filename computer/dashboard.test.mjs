import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startRuntime} from './runtime.mjs';
import {config, detectBuy, detectSell, leaderPumpBuys, leaderPumpSells} from './copybot.mjs';

// Real websocket logs of a Decu buy (see fastpath.test.mjs), restamped to "now" so the buy is fresh.
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/leader-ws-logs.json', import.meta.url), 'utf8'));
fx.buy.logs = fx.buy.logs.map((l) => { if (!l.startsWith('Program data: ')) return l; const b = Buffer.from(l.slice(14), 'base64'); if (b.length >= 97) b.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 89); return 'Program data: ' + b.toString('base64'); });
const MINT = 'siBF3bcDKAH9so6zFSRLVer6ua3sFJ8m279aF2cpump', TOKEN = 'dashboard-test-token-24-characters';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRISTINE_ENV = {...process.env};
const auth = {Authorization: 'Bearer ' + TOKEN};
const said = (x) => x.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');


async function bot(t, env = {}, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-dash-'));
  Object.assign(process.env, {ENGINE_STATE_FILE: path.join(dir, 'engine.json'), PORT: '0', DASHBOARD_TOKEN: TOKEN, STUDY: 'false', PAPER_MAX_PAY_PCT: '0', STALE_DATA_SEC: '0', FULL_PATH_DELAY_MS: '0', NOTE_CHARTS: 'false', VAULT_BACKFILL: '0', ...env});
  let ws, watcher = null;
  const k = {config: {...config, dryRun: true, minLeaderBuyUsd: 1, logFile: path.join(dir, 'log'), paperLandMs: 0, tipSol: 0.001, priorityFeeSol: 0.0005, slippagePct: 20}, redact: (x) => x,
    detectBuy, detectSell, leaderPumpBuys, leaderPumpSells, getSolUsd: async () => 100, solUsdNow: () => 100,
    quoteBuy: async () => ({raw: 1_000_000}), quoteSell: async () => 0.11, getTransaction: async () => null, startWatcher: (cb, o) => { ws = cb; watcher = o?.status; return () => {}; }, ...extra};
  const r = await startRuntime(k);
  t.after(() => { r.stop(); fs.rmSync(dir, {recursive: true, force: true}); for (const key of Object.keys(process.env)) if (!(key in PRISTINE_ENV)) delete process.env[key]; Object.assign(process.env, PRISTINE_ENV); });
  return {r, dir, ws: (...a) => ws(...a), watcher: () => watcher, base: `http://127.0.0.1:${r.server.address().port}`};
}

test('dashboard: coins held with their live value, the Sell button for one coin, the Rolex ledger', async (t) => {
  const {r, dir, ws, base} = await bot(t);
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle(); await sleep(150);
  const s = await (await fetch(base + '/api/status', {headers: auth})).json();
  assert.equal(s.held.length, 1); assert.equal(s.held[0].mint, MINT); assert.ok(s.held[0].costSol > 0);
  assert.ok(Number.isFinite(s.held[0].pnl), 'priced by the monitor'); assert.ok(s.held[0].valueSol > 0);
  assert.equal(s.settings.buySol, config.buySol); assert.equal(s.leader.address, config.leader); assert.equal(s.solUsd, 100);
  // the Sell button: sells ALL of this coin through the normal exit path
  assert.equal((await fetch(base + '/api/sell/' + MINT, {method: 'POST'})).status, 401, 'needs the dashboard token');
  assert.equal((await fetch(base + '/api/sell/' + MINT, {method: 'POST', headers: auth})).status, 200);
  for (let i = 0; i < 40 && r.engine.d.positions[MINT]?.raw !== '0'; i++) { await r.engine.idle(); await sleep(50); }
  assert.equal(r.engine.d.positions[MINT].raw, '0', 'sold');
  assert.ok(r.engine.d.events.some((e) => e.type === 'exit-rule' && e.rule === 'manual-sell'));
  assert.equal((await fetch(base + '/api/sell/' + MINT, {method: 'POST', headers: auth})).status, 404, 'nothing left to sell');
  assert.equal((await fetch(base + '/api/sell/not-a-coin', {method: 'POST', headers: auth})).status, 404);
  // the closed position went into the Rolex ledger as PAPER (practice): the live meter is untouched
  const g = await (await fetch(base + '/api/goal', {headers: auth})).json();
  assert.equal(g.goalUsd, 20000); assert.equal(g.mode, 'paper'); assert.equal(g.paper.n, 1); assert.equal(g.live.n, 0); assert.equal(g.live.usd, 0);
  assert.ok(Number.isFinite(g.paper.usd));
  r.goal.flush();
  assert.ok(fs.existsSync(path.join(dir, 'rolex-goal.json')), 'kept next to the engine state');
  const withEntries = await (await fetch(base + '/api/goal?entries=1', {headers: auth})).json();
  assert.equal(withEntries.paper.entries.length, 1); assert.equal(withEntries.paper.entries[0].mint, MINT);
});

test('dashboard: wallet balance lookup for Solflare/Phantom, files and security policy', async (t) => {
  let calls = 0;
  const {base} = await bot(t, {}, {getBalanceSol: async () => { calls++; return 1.25; }});
  const addr = '45yZa9VTChhA13Ad3aZbwMhiuXTjDqYYar3qH5NBmKeZ';
  assert.equal((await fetch(base + '/api/wallet/balance?address=nope', {headers: auth})).status, 400);
  const b = await (await fetch(base + '/api/wallet/balance?address=' + addr, {headers: auth})).json();
  assert.equal(b.sol, 1.25); assert.equal(b.address, addr);
  await fetch(base + '/api/wallet/balance?address=' + addr, {headers: auth});
  assert.equal(calls, 1, 'cached for 30 s');
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /img-src 'self' data:/, 'wallet icons are data: images');
  assert.doesNotMatch(page.headers.get('content-security-policy'), /script-src[^;]*(unsafe|data:|https)/, 'scripts stay same-origin only');
  for (const f of ['/dashcalc.mjs', '/wallet.js', '/watch.js', '/dashboard.js', '/charts.js']) {
    const res = await fetch(base + f);
    assert.equal(res.status, 200, f); assert.match(res.headers.get('content-type'), /text\/javascript/, f);
  }
  const html = await page.text();
  assert.match(html, /type="module" src="\/dashboard.js"/);
  assert.match(html, /data-download="\/api\/brain\/vault.zip">Download brain notes/, 'the Home download button');
});

test('dashboard: the trade list (compact, gzip, newest only) and one trade in full', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-dash-study-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const t0 = Date.now() - 3600e3, studyFile = path.join(dir, 'study.jsonl');
  const rec = (i, o = {}) => ({time: new Date(t0 + i * 60e3).toISOString(), mint: `Coin${i}Mint`, symbol: `C${i}`, mode: 'paper', taken: i % 5 !== 4, skipReason: i % 5 === 4 ? 'entry premium 40% above Decu' : null, fcat: i % 3 ? 0.08 : -0.12, cost: 0.1015, hisUsd: 250, hisSol: 2.5, entryGap: 0.1, delaySec: 1.8, hisMcapUsd: 9000, curve: Array.from({length: 16}, (_, s) => s / 100), fcatSec: 15, fcatExit: '15s limit', notes: ['a note'], ...o});
  fs.writeFileSync(studyFile, Array.from({length: 30}, (_, i) => JSON.stringify(rec(i))).join('\n') + '\n');
  const {base} = await bot(t, {STUDY: 'true', STUDY_FILE: studyFile});
  const res = await fetch(base + '/api/trades', {headers: {...auth, 'Accept-Encoding': 'gzip'}});
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  const d = await res.json();
  assert.equal(d.mode, 'paper'); assert.equal(d.rows.length, 30); assert.equal(d.total, 30); assert.equal(d.buySol, config.buySol);
  const row = d.rows[4];
  assert.equal(row.bought, false); assert.equal(row.skip, 'entry premium 40% above Decu'); assert.equal(row.solUsd, 100); assert.equal(row.curve.length, 16);
  const newest = await (await fetch(base + `/api/trades?after=${d.rows[27].time}`, {headers: auth})).json();
  assert.deepEqual(newest.rows.map((x) => x.sym), ['C28', 'C29']);
  const one = await (await fetch(base + `/api/trade?mint=Coin3Mint&time=${d.rows[3].time}`, {headers: auth})).json();
  assert.equal(one.symbol, 'C3'); assert.deepEqual(one.notes, ['a note']);
  assert.equal((await fetch(base + '/api/trade?mint=nope', {headers: auth})).status, 404);
});

test('readiness: /ready says yes or no (names only, no token needed), every check behind the token', async (t) => {
  const {r, ws, watcher, base} = await bot(t, {}, {quoteSell: async () => null});
  let res = await fetch(base + '/ready');
  assert.equal(res.status, 503, "Decu's feed has not connected yet");
  let body = await res.json();
  assert.deepEqual(body.blocking, ["Decu's trades feed"]); assert.equal(body.checks, undefined, 'no details without the token');
  watcher().websocket = 'subscribed';
  res = await fetch(base + '/ready'); body = await res.json();
  assert.equal(res.status, 200); assert.equal(body.ready, true);
  // a coin the bot cannot price: its stop-loss is blind, so the bot is NOT ready
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  const full = await (await fetch(base + '/api/ready', {headers: auth})).json();
  assert.equal(full.ready, false); assert.ok(full.blocking.includes('Open coins priced'));
  assert.match(full.checks.find((x) => x.name === 'Open coins priced').detail, /stop-loss is blind/);
  assert.ok(full.checks.some((x) => x.name === 'Disk writable' && x.ok));
  const s = await (await fetch(base + '/api/status', {headers: auth})).json();
  assert.equal(s.readiness.ready, false, 'the dashboard shows it too');
  assert.equal((await fetch(base + '/api/ready')).status, 401, 'details need the token');
  r.engine.style('off'); // Emergency stop: a warning, not a reason to page
  const paused = await (await fetch(base + '/api/ready', {headers: auth})).json();
  assert.ok(paused.warnings.includes('Buying')); assert.ok(!paused.blocking.includes('Buying'));
  r.setPower(false, {force: true});
  body = await (await fetch(base + '/ready')).json();
  assert.ok(body.blocking.includes('Bot power'));
});

test('readiness alert: a real problem pages once (and again when it clears); the bot turned OFF on purpose does not', async (t) => {
  const alerts = [], titles = () => alerts.map((a) => a.title);
  // STALE_DATA_SEC on, as on the server: OFF stops Decu's feed, which must not count as a second problem
  const {r, ws, watcher, base} = await bot(t, {READY_CHECK_MS: '30', READY_ALERT_SEC: '0.1', READY_PRICE_STALE_SEC: '0.2', STALE_DATA_SEC: '0.05'}, {quoteSell: async () => null, notify: async (a) => { alerts.push(a); }});
  watcher().websocket = 'subscribed';
  r.setPower(false); // OFF by the owner, nothing held: /ready says 503, nobody is paged
  await sleep(400);
  assert.ok(!titles().some((x) => /NOT READY/.test(x)), 'no page for a deliberate OFF');
  assert.deepEqual((await (await fetch(base + '/ready')).json()).blocking, ['Bot power']);
  r.setPower(true); watcher().websocket = 'subscribed';
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle(); // a coin it cannot price
  for (let i = 0; i < 40 && !titles().some((x) => /NOT READY/.test(x)); i++) await sleep(50);
  const page = alerts.find((a) => /NOT READY/.test(a.title));
  assert.ok(page, 'a blind stop-loss is paged'); assert.match(page.body, /Open coins priced/);
  assert.equal(titles().filter((x) => /NOT READY/.test(x)).length, 1, 'once, not every check');
  r.engine.d.positions[MINT].raw = '0'; // sold
  for (let i = 0; i < 40 && !titles().some((x) => /ready to trade again/.test(x)); i++) await sleep(50);
  assert.ok(titles().some((x) => /ready to trade again/.test(x)));
});

test('PAPER_BALANCE_SOL on the server wins once when it is changed; after that paper trades move the paper wallet', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-paperbal-'));
  t.after(() => { fs.rmSync(dir, {recursive: true, force: true}); for (const key of Object.keys(process.env)) if (!(key in PRISTINE_ENV)) delete process.env[key]; Object.assign(process.env, PRISTINE_ENV); });
  const start = async (pb) => {
    Object.assign(process.env, {ENGINE_STATE_FILE: path.join(dir, 'engine.json'), PORT: '0', DASHBOARD_TOKEN: TOKEN, STUDY: 'false', PAPER_UNLIMITED: 'false', PAPER_BALANCE_SOL: pb});
    return startRuntime({config: {...config, dryRun: true, logFile: path.join(dir, 'log')}, redact: (x) => x, detectBuy, detectSell, getSolUsd: async () => 100, quoteBuy: async () => ({raw: 1}), quoteSell: async () => 0.1, getTransaction: async () => null, startWatcher: () => () => {}});
  };
  let r = await start('3');
  assert.equal(r.engine.d.paperBalance, 3, 'set from the server');
  assert.ok(r.engine.d.events.some((e) => e.type === 'paper-balance' && e.sol === 3));
  r.engine.d.paperBalance = 2.75; r.engine.save(); r.stop(); // paper trades moved it
  r = await start('3');
  assert.equal(r.engine.d.paperBalance, 2.75, 'a restart with the same setting keeps the paper wallet as trading left it');
  r.stop();
  r = await start('5');
  assert.equal(r.engine.d.paperBalance, 5, 'a new value is applied once');
  r.stop();
});

test('voice: the call script and the audio are public (SignalWire and Twilio fetch them); nothing else is', async (t) => {
  const voiceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-voice-')); fs.writeFileSync(path.join(voiceDir, 'ultron-test.mp3'), Buffer.from('ID3 test audio'));
  t.after(() => fs.rmSync(voiceDir, {recursive: true, force: true}));
  const {base} = await bot(t, {PUBLIC_URL: 'https://bot.example.com', VOICE_DIR: voiceDir});
  for (const method of ['GET', 'POST']) {
    const x = await fetch(base + '/voice/ultron-test.xml', {method});
    assert.equal(x.status, 200, method); assert.match(x.headers.get('content-type'), /xml/);
    assert.equal(await x.text(), '<?xml version="1.0" encoding="UTF-8"?><Response><Play>https://bot.example.com/voice/ultron-test.mp3</Play></Response>');
  }
  const mp3 = await fetch(base + '/voice/ultron-test.mp3'); assert.equal(mp3.status, 200); assert.equal(await mp3.text(), 'ID3 test audio');
  assert.equal((await fetch(base + '/voice/no-such-message.xml')).status, 404, 'only a message that exists');
  assert.notEqual((await fetch(base + '/voice/..%2Fpackage.xml')).status, 200, 'no path tricks');
});

test('voice: a refused test call is written to the log, not only shown on the dashboard', async (t) => {
  const {r, base} = await bot(t, {SIGNALWIRE_PROJECT_ID: 'REPLACE-me', OWNER_PHONE: '+15559998888'});
  const res = await fetch(base + '/api/call/test', {method: 'POST', headers: auth});
  assert.equal(res.status, 400); assert.match(await res.text(), /not set up: SIGNALWIRE_SPACE/);
  assert.ok(r.engine.d.events.some((e) => e.type === 'connection' && /Ultron test call failed: Voice calls are not set up/.test(e.message)));
});

test('ultron: secret-key call scripts, owner-only answering, read-only settings on the dashboard', async (t) => {
  const {r, base} = await bot(t, {SIGNALWIRE_SPACE: 'myspace', SIGNALWIRE_PROJECT_ID: '12345678-90ab-cdef-1234-567890abcdef', SIGNALWIRE_API_TOKEN: 'sw', SIGNALWIRE_FROM_NUMBER: '+15550002222', OWNER_PHONE: '+15559998888', RENDER_EXTERNAL_URL: 'https://bot.example.com', ANTHROPIC_API_KEY: ''});
  const u = await (await fetch(base + '/api/ultron', {headers: auth})).json();
  assert.equal(u.ready, true, 'the phone settings are enough'); assert.equal(u.mode, 'free'); assert.deepEqual(u.missing, []); assert.deepEqual(u.forConversation, ['ANTHROPIC_API_KEY']); assert.equal(u.settings.voice, 'Polly.Brian', 'the British butler voice by default');
  const key = new URL(u.inboundUrl).searchParams.get('k'); assert.equal(key.length, 32);
  assert.equal((await fetch(base + '/api/ultron')).status, 401, 'the dashboard API needs the token');
  assert.equal((await fetch(base + '/voice/agent/in?k=wrong', {method: 'POST'})).status, 404, 'call scripts need the secret key');
  const rej = await fetch(base + '/voice/agent/in?k=' + key, {method: 'POST', body: new URLSearchParams({From: '+15550001111', CallSid: 'C0'})});
  assert.equal(rej.status, 200); assert.match(await rej.text(), /<Reject/, 'a stranger is not answered');
  // the owner calls: free mode answers with the bot's numbers, and the keypad works
  const hi = await (await fetch(base + '/voice/agent/in?k=' + key, {method: 'POST', body: new URLSearchParams({From: '+15559998888', CallSid: 'C1'})})).text();
  assert.match(said(hi), /Good (morning|afternoon|evening), sir\. Ultron[^.]*\. All systems are online, in paper mode\. Profit today is /); assert.match(hi, /<Say voice="Polly.Brian"><amazon:effect name="drc"><prosody rate="(9\d|1\d\d)%" pitch="[+-]\d+%"/, 'the calm Jarvis voice (sample 4) by default, spoken expressively'); assert.match(hi, /<Gather input="dtmf speech" numDigits="1"/);
  const turnUrl = hi.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&').replace('https://bot.example.com', base);
  const coins = await (await fetch(turnUrl, {method: 'POST', body: new URLSearchParams({CallSid: 'C1', Digits: '2'})})).text();
  assert.match(said(coins), /We are not holding any coins right now, sir\. [^<]*sir\?/);
  // every task answers from the real server's data (no "could not read" fallback)
  for (const ask of [{Digits: '6'}, {Digits: '7'}, {Digits: '8'}, {SpeechResult: 'the rolex goal'}, {SpeechResult: 'helius credits'}, {SpeechResult: 'best trade'}, {Digits: '4'}, {Digits: '5'}, {Digits: '1'}, {Digits: '3'}]) {
    const out = await (await fetch(turnUrl, {method: 'POST', body: new URLSearchParams({CallSid: 'C1', ...ask})})).text();
    assert.match(out, /<Gather/, JSON.stringify(ask)); assert.doesNotMatch(out, /could not read|did not understand|escaped me|did not quite follow/, JSON.stringify(ask) + ': ' + out.slice(0, 300));
  }
  const bye = await (await fetch(turnUrl, {method: 'POST', body: new URLSearchParams({CallSid: 'C1', SpeechResult: 'ok goodbye'})})).text();
  assert.match(bye, /<Hangup\/>/);
  const st = await (await fetch(base + '/api/ultron/settings?voice=Polly.Brian&bigWinPct=300&bigWinOn=0&buySol=9', {method: 'POST', headers: auth})).json();
  assert.equal(st.settings.voice, 'Polly.Brian'); assert.equal(st.settings.bigWinPct, 300); assert.equal(st.settings.bigWinOn, false);
  assert.equal(r.engine.d.ultron.voice, 'Polly.Brian'); assert.equal(r.engine.d.ultron.buySol, undefined, 'never a trading setting');
  const s = await (await fetch(base + '/api/status', {headers: auth})).json(); assert.equal(s.ultron.settings.voice, 'Polly.Brian');
});

test('ultron call log: every step of real requests lands in the log file, Render log and dashboard, with no secrets or full phone numbers', async (t) => {
  const SECRET = 'sk-ant-test-secret-1234567890', SW = 'sw-token-secret-0987654321';
  const {base, dir} = await bot(t, {SIGNALWIRE_SPACE: 'myspace', SIGNALWIRE_PROJECT_ID: '12345678-90ab-cdef-1234-567890abcdef', SIGNALWIRE_API_TOKEN: SW, SIGNALWIRE_FROM_NUMBER: 'not-a-number', OWNER_PHONE: '+15559998888', RENDER_EXTERNAL_URL: 'https://bot.example.com', ANTHROPIC_API_KEY: SECRET, ULTRON_LOG_STDOUT: 'false'});
  const key = new URL((await (await fetch(base + '/api/ultron', {headers: auth})).json()).inboundUrl).searchParams.get('k');
  // a test call and an Ultron call that can't be placed (the From number is wrong): both logged with the reason
  assert.equal((await fetch(base + '/api/call/test', {method: 'POST', headers: auth})).status, 400);
  assert.equal((await fetch(base + '/api/ultron/call', {method: 'POST', headers: auth})).status, 400);
  // a stranger calls Ultron's number; a progress report arrives; someone probes without the key
  const rej = await fetch(base + '/voice/agent/in?k=' + key, {method: 'POST', body: new URLSearchParams({From: '+15550001111', CallSid: 'CX', CallStatus: 'ringing', AccountSid: 'acct-1'})});
  assert.match(await rej.text(), /<Reject/);
  assert.equal((await fetch(base + '/voice/agent/status?k=' + key + '&t=test-abc123', {method: 'POST', body: new URLSearchParams({CallSid: 'CT', CallStatus: 'completed', CallDuration: '30', To: '+15559998888', HangupBy: '+15559998888'})})).status, 200);
  assert.equal((await fetch(base + '/voice/agent/turn?k=nope', {method: 'POST'})).status, 404);
  const log = await (await fetch(base + '/api/ultron/log?limit=100', {headers: auth})).json();
  const steps = log.entries.map((e) => e.step);
  for (const s of ['call-requested', 'call-failed', 'respond', 'webhook', 'status', 'webhook-rejected']) assert.ok(steps.includes(s), `logs ${s}: ${steps.join(', ')}`);
  const testFail = log.entries.find((e) => e.step === 'call-failed' && /^test-/.test(e.call));
  assert.match(testFail.error, /SIGNALWIRE_FROM_NUMBER/);
  assert.equal(log.entries.find((e) => e.step === 'status').CallDuration, '30');
  assert.equal(log.entries.find((e) => e.step === 'respond' && e.action === 'reject').why, 'the caller is not OWNER_PHONE');
  assert.ok(log.calls.some((c) => c.call === 'test-abc123'));
  assert.equal(log.file, 'ultron-calls.jsonl');
  const file = fs.readFileSync(path.join(dir, 'ultron-calls.jsonl'), 'utf8');
  assert.equal(file.trim().split('\n').length, log.entries.length, 'the file has every step');
  for (const secret of [SECRET, SW, TOKEN, key, 'acct-1', '5559998888', '5550001111']) assert.ok(!file.includes(secret), `never written: ${secret.slice(0, 6)}…`);
  const dl = await fetch(base + '/api/ultron/log.jsonl', {headers: auth});
  assert.match(dl.headers.get('content-disposition'), /ultron-calls-\d{4}-\d{2}-\d{2}\.jsonl/); assert.equal(await dl.text(), file);
  assert.equal((await fetch(base + '/api/ultron/log')).status, 401, 'the log needs the dashboard token');
});

test('ultron orders end to end: password, confirm, the bot really pauses; the password never reaches the log', async (t) => {
  const {r, base, dir} = await bot(t, {SIGNALWIRE_SPACE: 'myspace', SIGNALWIRE_PROJECT_ID: '12345678-90ab-cdef-1234-567890abcdef', SIGNALWIRE_API_TOKEN: 'sw-fake-token-for-tests-1234567', SIGNALWIRE_FROM_NUMBER: '+15550002222', OWNER_PHONE: '+15559998888', RENDER_EXTERNAL_URL: 'https://bot.example.com', ANTHROPIC_API_KEY: '', ULTRON_PASSPHRASE: 'open sesame', ULTRON_LOG_STDOUT: 'false'});
  const key = new URL((await (await fetch(base + '/api/ultron', {headers: auth})).json()).inboundUrl).searchParams.get('k');
  const hi = await (await fetch(base + '/voice/agent/in?k=' + key, {method: 'POST', body: new URLSearchParams({From: '+15559998888', CallSid: 'P1'})})).text();
  const turnUrl = hi.match(/action="([^"]+)"/)[1].replace(/&amp;/g, '&').replace('https://bot.example.com', base);
  const say = async (SpeechResult) => (await fetch(turnUrl, {method: 'POST', body: new URLSearchParams({CallSid: 'P1', SpeechResult})})).text();
  assert.equal(r.engine.d.paused, false);
  assert.match(said(await say('pause buying')), /Orders are locked, sir/);
  assert.match(said(await say('open sesame')), /Welcome back, sir\. Full access granted\..*To confirm, sir: I will pause new buys/);
  assert.match(said(await say('yes')), /Done, sir\. New buys are paused/);
  assert.equal(r.engine.d.paused, true, 'the bot really paused');
  assert.ok(r.engine.d.events.some((e) => e.type === 'ultron-order' && /new buys paused/.test(e.message)), 'shown on the dashboard');
  const file = fs.readFileSync(path.join(dir, 'ultron-calls.jsonl'), 'utf8');
  assert.match(file, /\[password spoken\]/); assert.doesNotMatch(file, /open sesame/i);
});
