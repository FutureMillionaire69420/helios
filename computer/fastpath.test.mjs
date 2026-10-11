import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startRuntime} from './runtime.mjs';
import {config, detectBuy, detectSell, leaderPumpBuys, leaderPumpSells} from './copybot.mjs';

// Real websocket logs of Decu's trades on 2026-10-11 (coin siBF3b…): a 0.2475 SOL buy and his full sell.
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/leader-ws-logs.json', import.meta.url), 'utf8'));
// The trades happened hours ago and the bot rightly refuses buys older than 30 s. Restamp the
// on-chain timestamp inside each pump.fun event (i64 at byte 89) to "now".
const fresh = (logs) => logs.map((l) => { if (!l.startsWith('Program data: ')) return l; const b = Buffer.from(l.slice(14), 'base64'); if (b.length >= 97) b.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 89); return 'Program data: ' + b.toString('base64'); });
fx.buy.logs = fresh(fx.buy.logs); fx.sell.logs = fresh(fx.sell.logs);
const MINT = 'siBF3bcDKAH9so6zFSRLVer6ua3sFJ8m279aF2cpump';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('decoder reads his real pump.fun buy and sell from the logs', () => {
  const [b] = leaderPumpBuys(fx.buy.logs, config.leader);
  assert.equal(b.mint, MINT); assert.equal(b.tokenAmount, 2254826796163); assert.ok(Math.abs(b.solAmount / 1e9 - 0.2444) < 1e-3);
  const [s] = leaderPumpSells(fx.sell.logs, config.leader);
  assert.equal(s.mint, MINT); assert.ok(s.solAmount / 1e9 > 4.9);
  assert.equal(leaderPumpBuys(fx.buy.logs, 'Someone1111111111111111111111111111111111111').length, 0, 'only his trades');
});

async function bot(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-fast-')), saved = {...process.env};
  Object.assign(process.env, {ENGINE_STATE_FILE: path.join(dir, 'engine.json'), PORT: '0', DASHBOARD_TOKEN: 'fastpath-test-token-24-characters', STUDY: 'false', ...env});
  let ws; const fetches = [];
  const k = {config: {...config, dryRun: true, minLeaderBuyUsd: 1, logFile: path.join(dir, 'log'), paperLandMs: 0, tipSol: 0.001, priorityFeeSol: 0.0005, slippagePct: 20}, redact: (x) => x,
    detectBuy, detectSell, leaderPumpBuys, leaderPumpSells, getSolUsd: async () => 116,
    quoteBuy: async () => ({raw: 1_000_000}), quoteSell: async () => 0.11,
    getTransaction: async (sig) => { fetches.push(sig); return null; }, // full path unavailable: proves the fast path alone trades
    startWatcher: (cb) => { ws = cb; return () => {}; }};
  const r = await startRuntime(k);
  t.after(() => { r.stop(); fs.rmSync(dir, {recursive: true, force: true}); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  return {r, ws: (...a) => ws(...a), fetches};
}

test('fast path: buys from the websocket logs without waiting for the transaction', async (t) => {
  const {r, ws} = await bot(t);
  const t0 = Date.now();
  await ws(fx.buy.signature, 'ws', fx.buy.logs);
  await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT]?.raw, '1000000', 'bought');
  assert.ok(Date.now() - t0 < 1000);
  // the same signature arriving again (poll, Solscan, full path) never buys twice
  await ws(fx.buy.signature, 'solscan'); await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  assert.equal(r.engine.d.events.filter((e) => e.type === 'confirmed' && e.side === 'buy').length, 1);
});

test('auto-sell style: sells EVERYTHING the moment he first sells', async (t) => {
  const {r, ws} = await bot(t, {MAX_HOLD_SEC: '0'});
  r.engine.style('auto');
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  await ws(fx.sell.signature, 'ws', fx.sell.logs); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '0', 'fully sold at his first sell');
});

test('auto-sell style: if he has not sold after MAX_HOLD_SEC, the bot sells anyway', async (t) => {
  const {r, ws} = await bot(t, {MAX_HOLD_SEC: '0.2'});
  r.engine.style('auto');
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '1000000');
  await sleep(400); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '0', 'sold at the time limit');
  assert.ok(r.engine.d.events.some((e) => e.type === 'detected' && e.side === 'sell' && e.leaderSignature.startsWith('maxhold-')));
});

test('manual-sell style: no automatic sell, only the SOLD alert', async (t) => {
  const {r, ws} = await bot(t, {MAX_HOLD_SEC: '0.1'});
  r.engine.style('manual');
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  await ws(fx.sell.signature, 'ws', fx.sell.logs); await sleep(250); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '1000000', 'kept');
  assert.ok(r.engine.d.events.some((e) => e.type === 'leader-sold' && e.mint === MINT));
});

test('after a restart, a position past the time limit is sold right away', async (t) => {
  const first = await bot(t, {MAX_HOLD_SEC: '0'});
  first.r.engine.style('auto');
  await first.ws(fx.buy.signature, 'ws', fx.buy.logs); await first.r.engine.idle();
  first.r.engine.d.positions[MINT].boughtAt = Date.now() - 60_000; first.r.engine.save();
  const file = process.env.ENGINE_STATE_FILE; first.r.stop();
  const again = await bot(t, {MAX_HOLD_SEC: '15', ENGINE_STATE_FILE: file});
  await sleep(100); await again.r.engine.idle();
  assert.equal(again.r.engine.d.positions[MINT].raw, '0');
});
