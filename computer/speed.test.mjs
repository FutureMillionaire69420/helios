import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStream} from './stream.mjs';
import {holderVerdict, exitSim} from './learn.mjs';
import {createStudy, research, latencyLine, toCsv} from './study.mjs';
import {setFetch, setStream, refreshFees, currentFees, solUsdNow, confirm, holderCount} from './copybot.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-speed-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return path.join(d, 'study.jsonl'); };

// A fake Helius websocket: records what the bot sends, lets the test answer and push.
class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; FakeWS.all.push(this); setTimeout(() => this.onopen?.(), 0); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.onclose?.(); }
  ack(method, subId) { const m = this.sent.findLast((x) => x.method === method); this.onmessage({data: JSON.stringify({jsonrpc: '2.0', id: m.id, result: subId})}); }
  push(method, subId, result) { this.onmessage({data: JSON.stringify({jsonrpc: '2.0', method, params: {subscription: subId, result}})}); }
}

test('push stream: blocks, confirmations and curve changes arrive pushed; reconnects and re-subscribes', async (t) => {
  FakeWS.all = [];
  const s = createStream({url: 'wss://x', WebSocketImpl: FakeWS, pingMs: 60_000}); t.after(() => s.stop());
  await sleep(5);
  const ws = FakeWS.all[0];
  assert.ok(s.connected()); assert.equal(ws.sent[0].method, 'slotSubscribe');
  ws.ack('slotSubscribe', 11); ws.push('slotNotification', 11, {slot: 123});
  assert.equal(s.slot(), 123, 'current block');
  const conf = s.waitSignature('SIG', {timeoutMs: 2000});
  ws.ack('signatureSubscribe', 12); ws.push('signatureNotification', 12, {value: {err: null}});
  assert.deepEqual(await conf, {err: null}, 'confirmed by push');
  assert.ok(ws.sent.some((x) => x.method === 'signatureUnsubscribe'), 'one-shot subscription closed');
  const got = [];
  const un = s.watchAccount('CURVE', (b64) => got.push(b64));
  assert.equal(un.ready(), false, 'not ready until the server acknowledges');
  ws.ack('accountSubscribe', 13); assert.equal(un.ready(), true);
  ws.push('accountNotification', 13, {value: {data: ['AAEC', 'base64']}});
  assert.deepEqual(got, ['AAEC']);
  ws.close(); assert.equal(s.connected(), false); assert.equal(s.slot(), null, 'no stale block while down'); assert.equal(un.ready(), false);
  await sleep(600);
  const ws2 = FakeWS.all[1];
  assert.ok(ws2, 'reconnected');
  assert.deepEqual(ws2.sent.map((x) => x.method).sort(), ['accountSubscribe', 'slotSubscribe'], 're-subscribed (the finished signature is not)');
  ws2.ack('accountSubscribe', 21); ws2.push('accountNotification', 21, {value: {data: ['BBBB', 'base64']}});
  assert.deepEqual(got, ['AAEC', 'BBBB']);
  un(); assert.ok(ws2.sent.some((x) => x.method === 'accountUnsubscribe' && x.params[0] === 21));
  const [late] = await Promise.all([s.waitSignature('LATE', {timeoutMs: 20}), sleep(40)]); // (its timer is unref'd)
  assert.equal(late, null, 'times out to null (the caller keeps polling)');
});

test('push stream: a silent (stalled) socket is not trusted and is replaced', async (t) => {
  FakeWS.all = [];
  const s = createStream({url: 'wss://x', WebSocketImpl: FakeWS, pingMs: 60_000, freshMs: 40, staleMs: 100}); t.after(() => s.stop());
  await sleep(5);
  const ws = FakeWS.all[0]; ws.ack('slotSubscribe', 1);
  const un = s.watchAccount('CURVE', () => {}); ws.ack('accountSubscribe', 2);
  assert.equal(un.ready(), true);
  await sleep(60);
  assert.equal(un.ready(), false, 'no messages for a while: pushed prices are not trusted (the bot polls)');
  assert.equal(s.connected(), false);
  await sleep(1700);
  assert.ok(FakeWS.all.length >= 2, 'stalled socket replaced');
  const ws2 = FakeWS.all.at(-1);
  assert.ok(ws2.sent.some((x) => x.method === 'accountSubscribe'), 're-subscribed on the new socket');
  ws.onclose?.(); // the old socket's late close changes nothing
  assert.equal(FakeWS.all.at(-1), ws2);
  const late = s.waitSignature('X', {timeoutMs: 5}); un();
  ws2.ack('accountSubscribe', 9); assert.ok(ws2.sent.some((x) => x.method === 'accountUnsubscribe' && x.params[0] === 9), 'answered after cancel: closed on the server too');
  await Promise.all([late, sleep(20)]);
});

test('holder rule: 10k needs 1000 holders, 20k needs 2500, 30k needs 4000', () => {
  assert.deepEqual(holderVerdict(500, 8000), {holders: 500, mcapUsd: 8000, required: 0, ceilingUsd: 10000, safe: true});
  assert.equal(holderVerdict(900, 12000).safe, false, 'above $10k with under 1000 holders: RISKY');
  assert.equal(holderVerdict(1200, 12000).safe, true);
  assert.equal(holderVerdict(1200, 12000).ceilingUsd, 20000, '1200 holders support up to $20k');
  assert.equal(holderVerdict(2400, 21000).safe, false);
  assert.equal(holderVerdict(3000, 25000).safe, true);
  assert.equal(holderVerdict(3000, 31000).required, 4000);
  assert.equal(holderVerdict(5000, 90000).ceilingUsd, null);
  assert.equal(holderVerdict(null, 9000), null, 'no count: no verdict (never a guess)');
  assert.equal(holderVerdict(500, 15000, [[20000, 600]]).safe, true, 'custom HOLDER_RULES');
});

test('test c: -20% on your money sells where the organic stop does not yet; test d: holders behind mcap', () => {
  const c = [-0.09, -0.12, -0.15, -0.22, -0.3, -0.35, -0.4];
  const organic = exitSim({curve: c}, {}), money = exitSim({curve: c}, {costStop: 0.2});
  assert.equal(money.how, 'stop on your money'); assert.equal(money.sec, 3); assert.equal(money.pnl, -0.3, 'decided at 3 s, filled at 4 s');
  assert.equal(organic.how, 'stop'); assert.equal(organic.sec, 4, 'organic -20% counts from -9% at entry');
  const rise = [-0.05, 0.05, 0.15, 0.3, 0.3, 0.3];
  const path = [{s: 0, holders: 800, mcapUsd: 9000}];
  const d = exitSim({curve: rise, holderPath: path}, {holders: true});
  assert.equal(d.how, 'holders behind mcap'); assert.equal(d.sec, 2, 'mcap passes $10k at 2 s with only 800 holders');
  assert.equal(exitSim({curve: rise, holderPath: [{s: 0, holders: 1500, mcapUsd: 9000}]}, {holders: true}).how, 'holding at 15 s');
  assert.equal(exitSim({curve: rise}, {holders: true}), null, 'no holder counts: left out, not zero');
});

test('alerts: price-vs-price premium, 10% / 15% (trading) / 25% labels, holders line, skipped buys alerted only inside 25%', async (t) => {
  const alerts = [];
  const s = createStudy({file: tmp(t), quoteSell: async () => 0.1, notify: (a) => alerts.push(a), stepMs: 1, feeSol: () => 0.008, slip: 0, reportPcts: [10, 25], notesOpts: {maxPayPct: 15}, skippedAlerts: 'report',
    sampleHolders: async () => ({holders: 900, mcapUsd: 12000})});
  const his = {sol: 1, raw: 10000, time: Date.now() / 1000 - 1};
  const rec = await s.start({mint: 'Lbl1', cost: 0.108, raw: '900', his, entryPrice: 1.12e-4, fill: {buyFeeSol: 0.008, actualFill: false}});
  assert.ok(Math.abs(rec.entryGap - 0.12) < 1e-9, 'price vs price'); assert.equal(rec.premiumDef, 'price');
  assert.ok(rec.costPremium > rec.entryGap, 'the cost basis includes the fees');
  assert.match(alerts[0].body, /Filters: 10% SKIP · 15% \(trading\) TAKE · 25% TAKE/);
  assert.match(alerts[0].body, /entry premium \+12\.0% \(price vs price\) · fees -0\.0160 SOL \(16\.0% of the trade, buy\+sell\)/);
  assert.match(alerts[0].body, /Holders: 900 · mcap \$12,000 → RISKY \(holders support up to \$10k\)/);
  assert.match(alerts[0].body, /Test c, stop -20% on your money/); assert.match(alerts[0].body, /Test d, holder momentum: holders behind mcap at 0s/);
  assert.equal(rec.holderVerdict.safe, false);
  const n = alerts.length;
  await s.start({mint: 'Skip20', cost: 0.1, raw: '800', his, entryPrice: 1.2e-4, shadow: 'entry premium 20% above Decu'});
  assert.equal(alerts.filter((a) => /SKIPPED/.test(a.title)).length, 1, 'skipped at 20%: inside the 25% report band, alerted');
  await s.start({mint: 'Skip40', cost: 0.1, raw: '700', his, entryPrice: 1.4e-4, shadow: 'entry premium 40% above Decu'});
  assert.equal(alerts.filter((a) => /SKIPPED/.test(a.title)).length, 1, 'skipped at 40%: studied silently');
  assert.ok(alerts.length > n);
  const R = s.research();
  assert.deepEqual(R.filters.map((f) => [f.pct, f.trades, f.trading]), [[10, 0, false], [15, 1, true], [25, 2, false]]);
  assert.equal(R.holders.risky.trades, 3);
  assert.equal(R.exitTests[1].name, 'holder momentum'); assert.equal(R.exitTests[1].trades, 3);
  const csv = toCsv(s.records).split('\n');
  assert.match(csv[0], /premium_basis,cost_premium_pct,buy_fee_sol,sell_fee_sol,holder_rule,holders_needed,test_c_stop_on_money_pct/);
  assert.match(csv[1], /,price,/); assert.match(csv[1], /,RISKY,1000,/);
});

test('latency line shows detection in exact blocks', () => {
  assert.match(latencyLine({detectMs: 900, detectBlocks: 2, decodeMs: 1, decideMs: 0, buildMs: 60, landMs: 650, simulatedMs: 600, botMs: 711, route: 'paper', blocksAfter: 4, blocksEstimated: true}), /^Latency: seen 2 blocks after his \(exact; ≈900 ms by his whole-second clock\)/);
  assert.equal(research([{time: new Date().toISOString(), mint: 'a', fcat: 0.1, latency: {detectBlocks: 3}}]).latency.detectBlocksMedian, 3);
});

test('fees: max mode follows Jito\'s 99th percentile tip, falls back to the caps when unknown', async (t) => {
  const saved = {...process.env}; t.after(() => { setFetch(null); for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });
  Object.assign(process.env, {FEE_MODE: 'max', TIP_MAX_SOL: '0.005', PRIORITY_FEE_MAX_SOL: '0.003'});
  setFetch(async (url) => ({ok: true, json: async () => (/tip_floor/.test(url) ? [{landed_tips_99th_percentile: 0.0021}] : {result: {priorityFeeEstimate: 1_000_000}})}));
  await refreshFees();
  assert.equal(currentFees().tipSol, 0.0021, '99th percentile of landed tips');
  assert.ok(currentFees().priorityFeeSol > 0 && currentFees().priorityFeeSol <= 0.003);
  setFetch(async (url) => (/tip_floor/.test(url) ? {ok: false, status: 503, text: async () => ''} : {ok: true, json: async () => ({result: {priorityFeeEstimate: 9e12}})}));
  await refreshFees();
  assert.equal(currentFees().tipSol, 0.005, 'unknown: the cap (never stuck on a low tip)');
  assert.ok(currentFees().priorityFeeSol <= 0.003, 'never above the priority cap');
});

test('SOL price never blocks a buy; confirmation comes from the push when it is live', async (t) => {
  t.after(() => { setFetch(null); setStream(null); });
  let calls = 0;
  setFetch(() => { calls++; return new Promise(() => {}); }); // every price source hangs
  const t0 = Date.now(); const v = solUsdNow();
  assert.ok(Date.now() - t0 < 5 && v > 0, 'answers at once (last known / fallback) and refreshes in the background');
  await sleep(5); assert.ok(calls >= 1, 'background refresh started');
  setFetch(async () => ({ok: true, json: async () => ({result: {value: [null]}})})); // polling never sees it
  setStream({connected: () => true, waitSignature: async () => { await sleep(20); return {err: null}; }});
  const t1 = Date.now(); const r = await confirm('SIG', 3000);
  assert.deepEqual(r, {ok: true}); assert.ok(Date.now() - t1 < 400, 'push answered before a second poll');
});

test('holder count: unique owners with a balance, not counting the bonding curve, paged', async (t) => {
  t.after(() => setFetch(null));
  const page1 = Array.from({length: 1000}, (_, i) => ({owner: 'O' + (i % 990), amount: i === 5 ? '0' : '10'}));
  const page2 = [{owner: 'Z1', amount: '5'}, {owner: 'O1', amount: '7'}];
  setFetch(async (_u, init) => { const b = JSON.parse(init.body); return {ok: true, json: async () => ({result: {token_accounts: b.params.page === 1 ? page1 : page2}})}; });
  assert.equal(await holderCount('siBF3bcDKAH9so6zFSRLVer6ua3sFJ8m279aF2cpump'), 991);
});
