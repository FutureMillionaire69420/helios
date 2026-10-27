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

async function bot(t, env = {}, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-dash-'));
  Object.assign(process.env, {ENGINE_STATE_FILE: path.join(dir, 'engine.json'), PORT: '0', DASHBOARD_TOKEN: TOKEN, STUDY: 'false', PAPER_MAX_PAY_PCT: '0', STALE_DATA_SEC: '0', FULL_PATH_DELAY_MS: '0', NOTE_CHARTS: 'false', VAULT_BACKFILL: '0', ...env});
  let ws;
  const k = {config: {...config, dryRun: true, minLeaderBuyUsd: 1, logFile: path.join(dir, 'log'), paperLandMs: 0, tipSol: 0.001, priorityFeeSol: 0.0005, slippagePct: 20}, redact: (x) => x,
    detectBuy, detectSell, leaderPumpBuys, leaderPumpSells, getSolUsd: async () => 100, solUsdNow: () => 100,
    quoteBuy: async () => ({raw: 1_000_000}), quoteSell: async () => 0.11, getTransaction: async () => null, startWatcher: (cb) => { ws = cb; return () => {}; }, ...extra};
  const r = await startRuntime(k);
  t.after(() => { r.stop(); fs.rmSync(dir, {recursive: true, force: true}); for (const key of Object.keys(process.env)) if (!(key in PRISTINE_ENV)) delete process.env[key]; Object.assign(process.env, PRISTINE_ENV); });
  return {r, dir, ws: (...a) => ws(...a), base: `http://127.0.0.1:${r.server.address().port}`};
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
