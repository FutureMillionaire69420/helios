import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startRuntime} from './runtime.mjs';
import {config, detectBuy, detectSell, leaderPumpBuys, leaderPumpSells, b58encode} from './copybot.mjs';
import {buyContextFromLogs, tokensOut} from './pumpbuild.mjs';

// Real websocket logs of Decu's trades on 2026-10-11 (coin siBF3b…): a 0.2475 SOL buy and his full sell.
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/leader-ws-logs.json', import.meta.url), 'utf8'));
// The trades happened hours ago and the bot rightly refuses buys older than 30 s. Restamp the
// on-chain timestamp inside each pump.fun event (i64 at byte 89) to "now".
const fresh = (logs) => logs.map((l) => { if (!l.startsWith('Program data: ')) return l; const b = Buffer.from(l.slice(14), 'base64'); if (b.length >= 97) b.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 89); return 'Program data: ' + b.toString('base64'); });
fx.buy.logs = fresh(fx.buy.logs); fx.sell.logs = fresh(fx.sell.logs);
const MINT = 'siBF3bcDKAH9so6zFSRLVer6ua3sFJ8m279aF2cpump';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRISTINE_ENV = {...process.env};

test('decoder reads his real pump.fun buy and sell from the logs', () => {
  const [b] = leaderPumpBuys(fx.buy.logs, config.leader);
  assert.equal(b.mint, MINT); assert.equal(b.tokenAmount, 2254826796163); assert.ok(Math.abs(b.solAmount / 1e9 - 0.2444) < 1e-3);
  const [s] = leaderPumpSells(fx.sell.logs, config.leader);
  assert.equal(s.mint, MINT); assert.ok(s.solAmount / 1e9 > 4.9);
  assert.equal(leaderPumpBuys(fx.buy.logs, 'Someone1111111111111111111111111111111111111').length, 0, 'only his trades');
});

let confirmedSell = true;
const confirmedSellTx = () => ({blockTime: Math.floor(Date.now() / 1000), slot: 9, transaction: {signatures: [fx.sell.signature], message: {accountKeys: [{pubkey: config.leader, signer: true}]}},
  meta: {err: null, fee: 5000, logMessages: fx.sell.logs, preBalances: [10e9], postBalances: [10e9 + 4.9e9], preTokenBalances: [{owner: config.leader, mint: MINT, uiTokenAmount: {amount: '2254826796163', decimals: 6, uiAmountString: '2254826.796163'}}], postTokenBalances: [{owner: config.leader, mint: MINT, uiTokenAmount: {amount: '0', decimals: 6, uiAmountString: '0'}}]}});
async function bot(t, env = {}, quote = async () => 0.11, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-fast-')), saved = PRISTINE_ENV; // two bots in one test can't leak each other's settings
  Object.assign(process.env, {ENGINE_STATE_FILE: path.join(dir, 'engine.json'), PORT: '0', DASHBOARD_TOKEN: 'fastpath-test-token-24-characters', STUDY: 'false', PAPER_MAX_PAY_PCT: '0', STALE_DATA_SEC: '0', FULL_PATH_DELAY_MS: '0', ...env});
  let ws; const fetches = [], fetchedAt = [];
  const k = {config: {...config, dryRun: true, minLeaderBuyUsd: 1, logFile: path.join(dir, 'log'), paperLandMs: 0, tipSol: 0.001, priorityFeeSol: 0.0005, slippagePct: 20}, redact: (x) => x,
    detectBuy, detectSell, leaderPumpBuys, leaderPumpSells, getSolUsd: async () => 116,
    quoteBuy: async () => ({raw: 1_000_000}), quoteSell: (...a) => quote(...a),
    // Buys: full path unavailable, proving the fast path alone buys. His SELL: only the confirmed
    // transaction (full path) makes the bot sell, so the sell signature returns a confirmed tx.
    getTransaction: async (sig) => { fetches.push(sig); fetchedAt.push([sig, Date.now()]); return sig === fx.sell.signature && confirmedSell ? confirmedSellTx() : null; },
    startWatcher: (cb) => { ws = cb; return () => {}; }, ...extra};
  const r = await startRuntime(k);
  t.after(() => { r.stop(); fs.rmSync(dir, {recursive: true, force: true}); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  return {r, ws: (...a) => ws(...a), fetches, fetchedAt};
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

test('auto-sell style: reached +15% -> sells at the gate, counted from DECU\'S buy (his on-chain time)', async (t) => {
  const {r, ws} = await bot(t, {MAX_HOLD_SEC: '2.5', MONITOR_MS: '20'}, async () => 0.13); // ~+26%
  r.engine.style('auto');
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '1000000');
  // his event time is "now" rounded down to the second, so the gate fires 1.5-2.5 s after the bot's buy
  await sleep(2700); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '0', 'sold at the time limit');
  assert.ok(r.engine.d.events.some((e) => e.type === 'exit-rule' && e.rule === 'gain-target'));
});

test('auto-sell style: never reached +15% -> keeps holding until Decu sells', async (t) => {
  const {r, ws} = await bot(t, {MAX_HOLD_SEC: '0.1', MONITOR_MS: '20'}, async () => 0.11); // ~+6%
  r.engine.style('auto');
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  await sleep(300); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '1000000', 'still held after the window');
  assert.ok(r.engine.d.events.some((e) => e.type === 'exit-rule' && e.rule === 'hold-until-his-sell'));
  await ws(fx.sell.signature, 'ws', fx.sell.logs); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '0', 'sold at his sell');
});

test('organic stop-loss: fees at entry ignored; a further -20% move sells everything (both styles)', async (t) => {
  for (const style of ['auto', 'manual']) {
    let n = 0; // starts -8% after fees (0.095), stays there, then the coin itself falls 25%
    const {r, ws} = await bot(t, {MAX_HOLD_SEC: '15', MONITOR_MS: '20'}, async () => (n++ < 3 ? 0.095 : 0.071));
    r.engine.style(style);
    await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
    await sleep(200); await r.engine.idle();
    assert.equal(r.engine.d.positions[MINT].raw, '0', `${style}: stop-loss sold`);
    const ev = r.engine.d.events.find((e) => e.type === 'exit-rule' && e.rule === 'stoploss');
    assert.ok(ev && ev.move <= -0.2 && ev.move > -0.3, JSON.stringify(ev));
    r.stop();
  }
});

test('organic stop ignores the entry fee dip; can be limited to the auto style', async (t) => {
  const flat = await bot(t, {MONITOR_MS: '20', MAX_HOLD_SEC: '15'}, async () => 0.08); // -21% after fees, but flat
  flat.r.engine.style('auto');
  await flat.ws(fx.buy.signature, 'ws', fx.buy.logs); await flat.r.engine.idle(); await sleep(150);
  assert.equal(flat.r.engine.d.positions[MINT].raw, '1000000', 'fee dip alone does not trigger the organic stop');
  flat.r.stop();
  let n = 0;
  const {r, ws} = await bot(t, {MONITOR_MS: '20', STOP_LOSS_MANUAL: 'false'}, async () => (n++ < 2 ? 0.1 : 0.06));
  r.engine.style('manual');
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  await sleep(150); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '1000000');
});

test('manual-sell style: no automatic sell, only the SOLD alert', async (t) => {
  const {r, ws} = await bot(t, {MAX_HOLD_SEC: '0.1', MONITOR_MS: '20'});
  r.engine.style('manual');
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  await ws(fx.sell.signature, 'ws', fx.sell.logs); await sleep(250); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '1000000', 'kept');
  assert.ok(r.engine.d.events.some((e) => e.type === 'leader-sold' && e.mint === MINT));
});

test('after a restart, held coins are watched again: stop-loss still protects them', async (t) => {
  let price = 0.11;
  const first = await bot(t, {MAX_HOLD_SEC: '0', MONITOR_MS: '20'}, async () => price);
  first.r.engine.style('auto');
  await first.ws(fx.buy.signature, 'ws', fx.buy.logs); await first.r.engine.idle();
  first.r.engine.d.positions[MINT].boughtAt = Date.now() - 60_000; first.r.engine.save();
  const file = process.env.ENGINE_STATE_FILE; first.r.stop();
  const again = await bot(t, {MAX_HOLD_SEC: '15', MONITOR_MS: '20', ENGINE_STATE_FILE: file}, async () => price);
  await sleep(120); await again.r.engine.idle();
  assert.equal(again.r.engine.d.positions[MINT].raw, '1000000', 'past 15 s without a known +15%: held for his sell');
  price = 0.08; await sleep(150); await again.r.engine.idle();
  assert.equal(again.r.engine.d.positions[MINT].raw, '0', 'stop-loss sold it');
});

test('Solscan gap report: grouped, says what the trade was; LaunchLab / bonk.fun coins ignored completely', async (t) => {
  const alerts = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-gap-')), saved = {...process.env};
  Object.assign(process.env, {ENGINE_STATE_FILE: path.join(dir, 'engine.json'), PORT: '0', DASHBOARD_TOKEN: 'gap-test-token-24-characters-xx', STUDY: 'false', GAP_GRACE_SEC: '0', GAP_ALERT_SEC: '0.05', GAP_ALERTS: 'true'});
  let ss;
  const LEADER = config.leader;
  const launchLab = {blockTime: Math.floor(Date.now() / 1000) - 12, slot: 1, transaction: {signatures: ['g'], message: {accountKeys: [{pubkey: LEADER, signer: true}]}},
    meta: {err: null, fee: 5005000, logMessages: ['Program FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9 invoke [1]', 'Program LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj invoke [2]'],
      preBalances: [10e9], postBalances: [10e9 - 265005000], preTokenBalances: [], postTokenBalances: [{owner: LEADER, mint: '5dzSbvLaunchLabCoin1111111111111111111111111', uiTokenAmount: {amount: '2313951000000', decimals: 6, uiAmountString: '2313951'}}]}};
  const pumpSell = {blockTime: Math.floor(Date.now() / 1000) - 8, slot: 2, transaction: {signatures: ['p'], message: {accountKeys: [{pubkey: LEADER, signer: true}]}},
    meta: {err: null, fee: 5000, logMessages: ['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]'],
      preBalances: [10e9], postBalances: [10e9 + 300e6], preTokenBalances: [{owner: LEADER, mint: '7pumpCoin11111111111111111111111111111111pump', uiTokenAmount: {amount: '5000000000', decimals: 6, uiAmountString: '5000'}}], postTokenBalances: [{owner: LEADER, mint: '7pumpCoin11111111111111111111111111111111pump', uiTokenAmount: {amount: '0', decimals: 6, uiAmountString: '0'}}]}};
  const txs = {lab1: launchLab, lab2: launchLab, sell1: pumpSell, sell2: pumpSell};
  const k = {config: {...config, dryRun: true, logFile: path.join(dir, 'log')}, redact: (x) => x, detectBuy, detectSell, getSolUsd: async () => 116, notify: async (a) => alerts.push(a),
    venueOf: (await import('./copybot.mjs')).venueOf, getTransaction: async (sig) => txs[sig], startWatcher: () => () => {}, startSolscanWatcher: (cb) => { ss = cb; return () => {}; }};
  const r = await startRuntime(k);
  t.after(() => { r.stop(); fs.rmSync(dir, {recursive: true, force: true}); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  await ss('lab1', 'solscan'); await ss('lab2', 'solscan');
  await sleep(150);
  assert.ok(!alerts.some((x) => /Solscan caught/.test(x.title)), 'LaunchLab trades never alert');
  assert.ok(!r.engine.d.events.some((e) => e.mint === '5dzSbvLaunchLabCoin1111111111111111111111111'), 'and never reach the copy engine');
  await ss('sell1', 'solscan'); await ss('sell2', 'solscan');
  await sleep(150);
  const a = alerts.find((x) => /Solscan caught 2 Decu trades/.test(x.title));
  assert.ok(a, JSON.stringify(alerts.map((x) => x.title)));
  assert.match(a.body, /SELL 7pumpC…  ?(0\.300 SOL )?on pump\.fun, \ds late: sell of a coin the bot does not hold/);
});

test('30% entry-premium filter applies in paper like live (PAPER_MAX_PAY_PCT=0 turns it off in paper)', async (t) => {
  const free = await bot(t, {PAPER_MAX_PAY_PCT: '0'});
  await free.ws(fx.buy.signature, 'ws', fx.buy.logs); await free.r.engine.idle();
  assert.equal(free.r.engine.d.positions[MINT].raw, '1000000', 'filter off: bought');
  free.r.stop();
  const {r, ws} = await bot(t, {PAPER_MAX_PAY_PCT: '30'}); // the default when unset: the live value (30)
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  // his price 0.2444 SOL / 2.25e12 raw; the paper quote gives only 1e6 raw for 0.1 SOL -> far above him
  assert.equal(r.engine.d.positions[MINT], undefined);
  assert.ok(r.engine.d.events.some((e) => e.type === 'failed' && /above Decu's/.test(e.message)));
});

test('execution latency: every stage of a paper copy is timed, with the simulated wait shown separately', async (t) => {
  const {r, ws} = await bot(t, {});
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  const L = r.latency(MINT);
  assert.ok(L, 'timed'); assert.equal(L.route, 'paper'); assert.equal(L.source, 'websocket (fast path)');
  for (const k of ['detectMs', 'decodeMs', 'decideMs', 'buildMs', 'landMs', 'botMs']) assert.ok(Number.isFinite(L[k]), k);
  assert.ok(L.decodeMs >= 0 && L.decodeMs < 1000);
  assert.equal(L.simulatedMs, Number(process.env.PAPER_LAND_MS || 0) || L.simulatedMs, 'simulated wait recorded');
  assert.ok(L.landMs >= L.simulatedMs, 'land time includes the simulated wait');
});

test('his sell is only acted on once CONFIRMED: an unconfirmed fast-path sell never sells', async (t) => {
  const {r, ws} = await bot(t, {MAX_HOLD_SEC: '0', MONITOR_MS: '20'}, async () => 0.11);
  r.engine.style('auto');
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  confirmedSell = false;
  try { await ws(fx.sell.signature, 'ws', fx.sell.logs); await sleep(50); await r.engine.idle(); }
  finally { confirmedSell = true; }
  assert.equal(r.engine.d.positions[MINT].raw, '1000000', 'processed-only sell signal: held');
});

test('stop-loss reliability: failed price checks alert, then sell anyway; failed sells retry, then CAN\'T SELL', async (t) => {
  let n = 0;
  const {r, ws} = await bot(t, {MAX_HOLD_SEC: '0', MONITOR_MS: '10', QUOTE_TIMEOUT_MS: '20', PRICE_FAIL_ALERT: '2', PRICE_FAIL_SELL: '4'}, async () => (n++ < 2 ? 0.1 : null));
  r.engine.style('auto');
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  await sleep(200); await r.engine.idle();
  assert.ok(r.engine.d.events.some((e) => e.type === 'price-check-failing'), 'alerted');
  assert.ok(r.engine.d.events.some((e) => e.type === 'exit-rule' && e.rule === 'no-price'), 'sold without a price');
});

test('failed exit sells are retried, then CAN\'T SELL is alerted', async (t) => {
  let n = 0;
  const {r, ws} = await bot(t, {MAX_HOLD_SEC: '15', MONITOR_MS: '10', SELL_RETRIES: '2'}, async () => (n++ < 2 ? 0.1 : 0.06)); // -40%: stop
  r.engine.style('auto');
  const realSend = r.engine.a.send; let sells = 0;
  r.engine.a.send = async (job) => (job.side === 'sell' ? (sells++, {status: 'failed', error: 'slippage exceeded'}) : realSend(job));
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  await sleep(1500); await r.engine.idle();
  assert.ok(sells >= 3, `${sells} sell attempts`);
  assert.ok(r.engine.d.events.some((e) => e.type === 'unsellable'), 'CAN\'T SELL alerted');
  assert.ok(r.engine.d.events.filter((e) => e.type === 'exit-rule' && e.rule === 'stoploss').length >= 1);
});

test('position-closed alert compares the fill with the exit trigger', async () => {
  const {alertFor} = await import('./runtime.mjs');
  const a = alertFor({type: 'confirmed', side: 'sell', mint: MINT, solDelta: 0.075, closed: true, pnl: -0.25, trigger: -0.21, rule: 'stoploss', signature: 's'}, 'live');
  assert.match(a.title, /POSITION CLOSED siBF3b… -25.0% \(stop-loss\)/); assert.match(a.body, /Triggered at -21.0% · closed at -25.0% \(4.0 points worse/);
  assert.match(alertFor({type: 'unsellable', mint: MINT, attempts: 4, message: 'x'}, 'live').title, /CAN'T SELL/);
  assert.match(alertFor({type: 'exit-rule', rule: 'stoploss', mint: MINT, pnl: -0.21, move: -0.2}, 'live').title, /STOP TRIGGERED/);
  assert.match(alertFor({type: 'submitted', side: 'sell', mint: MINT, signature: 's', rule: 'stoploss'}, 'live').title, /SELL SENT/);
  assert.equal(alertFor({type: 'submitted', side: 'sell', mint: MINT, signature: 's'}, 'paper'), null, 'paper: no extra alert');
});

test('a later Decu buy that gets copied is measured against THAT buy, not his first one', async (t) => {
  const {r, ws} = await bot(t, {MAX_OPEN_POSITIONS: '0'}, async () => 0.11);
  // his first buy arrives while buys are paused (skipped), his second buy of the same coin is copied
  r.engine.pause(true);
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  r.engine.pause(false);
  const second = fx.buy.logs.map((l) => { if (!l.startsWith('Program data: ')) return l; const b = Buffer.from(l.slice(14), 'base64'); if (b.length >= 97) b.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000) + 30), 89); return 'Program data: ' + b.toString('base64'); });
  await ws('second-buy-sig', 'ws', second); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '1000000');
  const L = r.latency(MINT);
  assert.ok(L.detectMs < 0, `measured from his second buy (its clock is 30 s ahead in this test): ${L.detectMs}`);
});

test('exits are push-driven: a curve change over the websocket triggers the stop at once (no polling wait)', async (t) => {
  let push = null, unsubs = 0;
  const watchCurve = (mint, cb) => { push = cb; const un = () => { unsubs++; }; un.ready = () => true; return un; };
  const {r, ws} = await bot(t, {MAX_HOLD_SEC: '0', MONITOR_MS: '60000'}, async () => 0.11, {watchCurve, curveSell: (curve) => curve.v});
  r.engine.style('auto');
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  await sleep(30);
  assert.ok(push, 'held coin is watched over the websocket');
  assert.equal(r.engine.d.positions[MINT].raw, '1000000');
  const t0 = Date.now();
  push({v: 0.06, complete: false}, Date.now()); // the coin falls ~45%: no poll is due for 60 s
  await sleep(30); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '0', 'sold on the push');
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(r.engine.d.events.some((e) => e.type === 'exit-rule' && e.rule === 'stoploss'));
  assert.ok(unsubs >= 1, 'stopped watching the sold coin');
});

test('max fees: paper P&L pays the live fee of that moment; detection counted in exact blocks', async (t) => {
  const stream = {slot: () => 105, connected: () => true};
  const {r, ws} = await bot(t, {}, async () => 0.11, {fees: () => ({priorityFeeSol: 0.003, tipSol: 0.005}), stream});
  await ws(fx.buy.signature, 'ws', fx.buy.logs, 100); await r.engine.idle();
  const p = r.engine.d.positions[MINT];
  assert.ok(Math.abs(p.costSol - (0.1 + 0.008005)) < 1e-9, `paper cost includes the max fee: ${p.costSol}`);
  const L = r.latency(MINT);
  assert.equal(L.detectBlocks, 5, 'seen in block 105, his trade in block 100');
  assert.equal(L.blocksAfter, 5, 'landing block from the pushed slot');
});

test("holder rule: the dev is taken from Decu's own trade event (written by pump.fun), even in paper", async (t) => {
  const asked = [];
  const holderStats = async (mint, o) => { asked.push({mint, creator: o?.creator}); return {holders: 40, mcapUsd: 9000, valueUsd: 2500, devPct: 0.05, devKnown: true}; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-holder-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const ctx = buyContextFromLogs(fx.buy.logs, config.leader, b58encode), expected = Number(tokensOut(ctx, Math.floor(0.1 * 0.995 * 1e9)));
  const {r, ws} = await bot(t, {STUDY: 'true', STUDY_FILE: path.join(dir, 'study.jsonl'), STUDY_WINDOW_SEC: '1'}, async () => 0.11, {holderStats, b58encode, quoteBuy: async () => ({raw: expected})});
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  await sleep(1500);
  const dev = ctx.creator;
  assert.equal(r.engine.d.positions[MINT].raw, String(expected), 'bought (paper fill consistent with his trade event)');
  assert.ok(dev && asked.length >= 1, 'sampled');
  assert.equal(asked[0].mint, MINT); assert.equal(asked[0].creator, dev);
  const rec = r.study.records.at(-1);
  assert.equal(rec.holderVerdict.safe, true); assert.equal(rec.holderVerdict.heldUsd, 2500);
});

test('paper build like the live local builder: expected tokens from Decu\'s trade event, no network call', async (t) => {
  const ctx = buyContextFromLogs(fx.buy.logs, config.leader, b58encode), expected = Number(tokensOut(ctx, Math.floor(0.1 * 0.995 * 1e9)));
  let quotes = 0;
  const {r, ws} = await bot(t, {}, async () => 0.11, {b58encode, quoteBuy: async () => { quotes++; return {raw: expected}; }});
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, String(expected));
  assert.equal(quotes, 1, 'only the landing quote (the simulated fill); the build asked nothing');
  assert.ok(r.latency(MINT).buildMs < 50, `build ${r.latency(MINT).buildMs} ms`);
});

test('a buy already acted on from the websocket fetches its full transaction later; his sells right away', async (t) => {
  const {r, ws, fetchedAt} = await bot(t, {FULL_PATH_DELAY_MS: '500'});
  const t0 = Date.now(); ws(fx.buy.signature, 'ws', fx.buy.logs);
  await sleep(50); await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '1000000', 'bought without waiting for the full transaction');
  assert.equal(fetchedAt.filter(([s]) => s === fx.buy.signature).length, 0, 'not fetched yet');
  await sleep(550);
  const at = fetchedAt.find(([s]) => s === fx.buy.signature);
  assert.ok(at && at[1] - t0 >= 480, 'fetched once it can exist');
  const t1 = Date.now(); confirmedSell = false; // only when it is fetched matters here
  try { await ws(fx.sell.signature, 'ws', fx.sell.logs); } finally { confirmedSell = true; }
  const sellAt = fetchedAt.find(([s]) => s === fx.sell.signature);
  assert.ok(sellAt && sellAt[1] - t1 < 200, 'his sell (acted on only once confirmed) is fetched at once');
});

test('power OFF stops every data source (Helius, Solscan, push, refreshes); ON restarts them; saved across restarts', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-power-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const n = {watch: 0, unwatch: 0, scan: 0, unscan: 0, on: 0, off: 0}, alerts = [];
  const extra = () => ({startWatcher: () => { n.watch++; return () => n.unwatch++; }, startSolscanWatcher: () => { n.scan++; return () => n.unscan++; },
    power: {on: () => n.on++, off: () => n.off++}, notify: async (a) => alerts.push(a)});
  const env = {ENGINE_STATE_FILE: path.join(dir, 'engine.json')};
  const a = await bot(t, env, async () => 0.11, extra());
  assert.deepEqual([n.watch, n.scan, n.on], [1, 1, 1], 'starts ON');
  assert.equal(a.r.setPower(false), null);
  assert.deepEqual([n.unwatch, n.unscan, n.off], [1, 1, 1], 'OFF stopped Decu\'s watchers and the background loops');
  assert.equal(a.r.engine.d.dataOff, true);
  await new Promise((r) => setImmediate(r));
  assert.ok(alerts.some((x) => /Bot OFF: no Helius or Solscan use/.test(x.title)), 'phone alert');
  a.r.stop();
  const b = await bot(t, env, async () => 0.11, extra());
  assert.equal(n.watch, 1, 'restarted OFF: nothing started'); assert.equal(n.on, 1);
  assert.equal(b.r.setPower(true), null);
  assert.deepEqual([n.watch, n.scan, n.on], [2, 2, 2], 'ON started everything again');
  b.r.stop();
});

test('BOT_POWER on the server wins once when changed; after that the dashboard button decides', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-power-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  let watch = 0; const extra = {startWatcher: () => { watch++; return () => {}; }};
  const env = {ENGINE_STATE_FILE: path.join(dir, 'engine.json'), BOT_POWER: 'off'};
  const a = await bot(t, env, async () => 0.11, extra);
  assert.equal(watch, 0, 'BOT_POWER=off: starts OFF'); a.r.setPower(true); assert.equal(watch, 1); a.r.stop();
  const b = await bot(t, env, async () => 0.11, extra);
  assert.equal(watch, 2, 'same BOT_POWER, button said ON: stays ON'); b.r.stop();
});

test('dashboard power buttons: /api/power/off and /on need the token and switch the bot', async (t) => {
  let watch = 0;
  const {r} = await bot(t, {}, async () => 0.11, {startWatcher: () => { watch++; return () => {}; }});
  const base = `http://127.0.0.1:${r.server.address().port}`, auth = {Authorization: 'Bearer fastpath-test-token-24-characters'};
  assert.equal((await fetch(base + '/api/power/off', {method: 'POST'})).status, 401, 'no token, no switch');
  assert.equal((await fetch(base + '/api/power/off', {method: 'POST', headers: auth})).status, 200);
  assert.equal((await (await fetch(base + '/api/status', {headers: auth})).json()).power, 'off');
  assert.equal((await fetch(base + '/api/power/on', {method: 'POST', headers: auth})).status, 200);
  assert.equal((await (await fetch(base + '/api/status', {headers: auth})).json()).power, 'on');
  assert.equal(watch, 2);
});

test('Solscan schedule: rare while Helius is healthy and nothing is held, often while holding, never when off or over budget', async (t) => {
  let opts = null, usage = {requests: 10, budget: 2500, left: 2490};
  const {r, ws} = await bot(t, {}, async () => 0.11, {startSolscanWatcher: (cb, o) => { opts = o; return () => {}; }, solscanUsage: () => usage});
  const plan = () => opts.schedule();
  opts.status.websocket = 'disconnected';
  assert.deepEqual(plan(), {ms: 15000, mode: 'Helius websocket down: Solscan watching'});
  opts.status.websocket = 'subscribed';
  assert.equal(plan().ms, 600000, 'healthy and nothing held: every 10 min');
  await ws(fx.buy.signature, 'ws', fx.buy.logs); await r.engine.idle();
  assert.equal(plan().ms, 30000, 'holding a coin: every 30 s (a missed sell of his matters)');
  usage = {requests: 2500, budget: 2500, left: 0};
  assert.equal(plan().ms, Infinity); assert.match(plan().mode, /daily budget used/);
  usage = {requests: 10, budget: 2500, left: 2490};
  r.setPower(false);
  assert.equal(plan().ms, Infinity, 'power off: never');
});
