import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The Solscan client reads its key at import time.
process.env.SOLSCAN_API_KEY = 'test-solscan-key';
const {solscanQuery, solscanClient, swapFromActivity, swapsFromActivities, leaderProfile, compareDetection, startSolscanWatcher, PUMP_TOKEN} = await import('./solscan.mjs');
const {classifyUnsupported, startRuntime} = await import('./runtime.mjs');
const {config, setFetch, diagnose, detectBuy, detectSell} = await import('./copybot.mjs');

// Real Solscan v2 rows for Decu's wallet, 2026-10-07: a SOL-paired coin (5qkp…), a PUMP-paired
// coin (2Zpc…) and memecoin↔memecoin swaps (EuZZ…).
const rows = JSON.parse(fs.readFileSync(new URL('./fixtures/solscan-leader-swaps.json', import.meta.url), 'utf8'));
const LEADER = '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9';
const row = (prefix, side) => rows.find((a) => (side === 'buy' ? a.routers.token2 : a.routers.token1).startsWith(prefix) && !a.routers.token1.startsWith('EuZZ') && !a.routers.token2.startsWith('EuZZ'));

test('Solscan query uses key[]=value for arrays and drops empty values', () => {
  assert.equal(solscanQuery({address: 'a', activity_type: ['X', 'Y'], page: 1, from_time: undefined}), 'address=a&activity_type%5B%5D=X&activity_type%5B%5D=Y&page=1');
});

test('Solscan client sends the token header, unwraps data and fails on success:false', async () => {
  const calls = [];
  const http = async (url, opts) => { calls.push({url, opts}); return url.includes('/token/price') ? {success: true, data: [{price: 115.9}]} : {success: false, errors: {message: 'plan'}}; };
  const c = solscanClient({apiKey: 'k', http});
  assert.equal(await c.tokenPrice('So11111111111111111111111111111111111111112'), 115.9);
  assert.equal(calls[0].opts.headers.token, 'k');
  await assert.rejects(c.accountDetail('x'), /plan/);
  await assert.rejects(solscanClient({apiKey: '', http}).lastBlock(), /SOLSCAN_API_KEY/);
});

test('swap decoding: SOL buy, SOL sell, PUMP-paired buy, memecoin swap rejected', () => {
  const b = swapFromActivity(row('5qkp', 'buy'));
  assert.equal(b.side, 'buy'); assert.equal(b.quote, 'SOL'); assert.ok(b.mint.startsWith('5qkp')); assert.ok(b.sol > 0); assert.equal(b.pump, true);
  const s = swapFromActivity(row('5qkp', 'sell'));
  assert.equal(s.side, 'sell'); assert.equal(s.quote, 'SOL');
  const p = swapFromActivity(row('2Zpc', 'buy'), {solUsd: 100});
  assert.equal(p.quote, 'PUMP'); assert.equal(p.side, 'buy'); assert.ok(Math.abs(p.sol - p.usd / 100) < 1e-9);
  assert.equal(swapFromActivity(row('2Zpc', 'buy')).sol, null, 'no SOL value without a SOL price');
  assert.equal(swapFromActivity(rows.find((a) => a.routers.token1.startsWith('EuZZ') || a.routers.token2.startsWith('EuZZ'))), null);
});

test('multi-hop legs are netted per transaction: the coin he ends up holding is the trade', () => {
  // 2jZJJKwTh8…: Solscan lists SOL→7vfC and 7vfC→EuZZ legs; Helius shows he received EuZZ (BUTTERIN).
  const legs = rows.filter((a) => a.trans_id.startsWith('2jZJJKwTh8'));
  assert.equal(legs.length, 2);
  const [s] = swapsFromActivities(legs);
  assert.equal(s.side, 'buy'); assert.ok(s.mint.startsWith('EuZZ'), s.mint); assert.equal(s.quote, 'SOL'); assert.equal(s.legs, 2);
  assert.ok(Math.abs(s.sol - 0.02475) < 1e-6, String(s.sol));
});

test('leader profile on real swaps: rounds, PnL, copy window, PUMP-paired coins counted', () => {
  const p = leaderProfile(swapsFromActivities(rows, {solUsd: 115.9}), {minUsd: 50});
  const r = p.roundsDetail.find((x) => x.mint.startsWith('5qkp'));
  assert.equal(r.quote, 'SOL'); assert.equal(r.buys, 5); assert.equal(r.closed, true);
  assert.ok(Math.abs(r.pnlSol - 0.4917) < 0.001, `pnl ${r.pnlSol}`);
  assert.equal(r.windowSec, 58); // his 1.98 SOL buy at 23:14:52, full exit at 23:15:50
  assert.equal(p.quotes.PUMP, 1); assert.equal(p.pumpPaired, 1);
  assert.ok(p.roundsDetail.some((x) => x.mint.startsWith('EuZZ')), 'multi-hop coin found');
  assert.equal(p.roundsDetail.some((x) => x.mint.startsWith('7vfC')), false, 'intermediate hop is not a trade');
});

test('profile does not score a coin whose buys fall before the fetched history', () => {
  const p = leaderProfile([{sig: 'a', time: 10, side: 'buy', quote: 'SOL', mint: 'm', sol: 0.02, raw: '10', usd: 3}, {sig: 'b', time: 20, side: 'sell', quote: 'SOL', mint: 'm', sol: 2, raw: '1000', usd: 300}]);
  assert.equal(p.roundsDetail[0].partial, true); assert.equal(p.closedRounds, 0); assert.equal(p.pnlSol, 0);
});

test('parser cross-check flags missing trades and SOL disagreements', () => {
  const sw = {sig: 's', side: 'buy', quote: 'SOL', mint: 'm', sol: 1, pump: true};
  assert.equal(compareDetection(sw, [{side: 'buy', mint: 'm', sol: 1.01, pump: true}]).ok, true);
  assert.match(compareDetection(sw, [{side: 'buy', mint: 'm', sol: 1.2, pump: true}]).reason, /SOL differs/);
  assert.match(compareDetection(sw, []).reason, /no trade/);
});

test('Solscan watcher replays the recent window oldest-first and reports errors in status', async () => {
  const now = Math.floor(Date.now() / 1000), seen = [], status = {};
  let fail = false;
  const client = {enabled: true, defiActivities: async () => { if (fail) throw new Error('HTTP 429'); return [{trans_id: 'new', block_time: now}, {trans_id: 'mid', block_time: now - 10}, {trans_id: 'old', block_time: now - 999}]; }};
  const stop = startSolscanWatcher({client, leader: LEADER, intervalMs: 20, horizonSec: 300, startDelayMs: 0, onSignature: (sig, src) => seen.push(sig + ':' + src), status});
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(seen.slice(0, 2), ['mid:solscan', 'new:solscan']);
  assert.equal(status.solscan.ok, true);
  fail = true; await new Promise((r) => setTimeout(r, 40)); stop();
  assert.equal(status.solscan.ok, false); assert.match(status.solscan.error, /429/);
  assert.equal(startSolscanWatcher({client: {enabled: false}})(), undefined, 'no key: no watcher');
});

const bal = (owner, mint, amount) => ({owner, mint, uiTokenAmount: {amount: String(amount), decimals: 6, uiAmountString: String(amount / 1e6)}});
const pumpPairedBuy = {blockTime: Math.floor(Date.now() / 1000), slot: 1, transaction: {signatures: ['sigA'], message: {accountKeys: [{pubkey: LEADER, signer: true}]}},
  meta: {err: null, fee: 5000, preBalances: [10e9], postBalances: [10e9 - 5000], preTokenBalances: [bal(LEADER, PUMP_TOKEN, 5_000_000_000)], postTokenBalances: [bal(LEADER, PUMP_TOKEN, 1_000_000_000), bal(LEADER, 'CoinMint111111111111111111111111111111pump', 777)]}};

test('buys paid with PUMP tokens are classified instead of silently ignored', () => {
  assert.deepEqual(classifyUnsupported(pumpPairedBuy, LEADER), {kind: 'paid-with-pump', mint: 'CoinMint111111111111111111111111111111pump'});
  assert.equal(detectBuy(pumpPairedBuy, LEADER), null, 'the SOL-only copier still refuses to copy it');
  assert.equal(classifyUnsupported({...pumpPairedBuy, meta: {...pumpPairedBuy.meta, err: {x: 1}}}, LEADER), null);
});

test('runtime counts which provider saw each trade first and alerts on Helius gaps', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-providers-')); t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const saved = {...process.env};
  Object.assign(process.env, {ENGINE_STATE_FILE: path.join(dir, 'engine.json'), PORT: '0', DASHBOARD_TOKEN: 'provider-test-token-24-characters'});
  let ws, ss;
  const k = {config: {...config, dryRun: true, logFile: path.join(dir, 'log')}, redact: (x) => x, detectBuy, detectSell, getSolUsd: async () => 100,
    getTransaction: async (sig) => ({...pumpPairedBuy, transaction: {...pumpPairedBuy.transaction, signatures: [sig]}}),
    startWatcher: (cb) => { ws = cb; return () => {}; }, startSolscanWatcher: (cb) => { ss = cb; return () => {}; }};
  const r = await startRuntime(k);
  t.after(() => { r.stop(); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  await ws('seenByHelius', 'ws'); await ss('seenByHelius', 'solscan');
  await ss('missedByHelius', 'solscan'); await ws('missedByHelius', 'poll');
  const s = await (await fetch(`http://127.0.0.1:${r.server.address().port}/api/status`, {headers: {Authorization: 'Bearer ' + process.env.DASHBOARD_TOKEN}})).json();
  assert.deepEqual(s.connection.firstSeen, {ws: 1, poll: 0, solscan: 1});
  assert.equal(s.connection.gaps, 1); assert.equal(s.connection.unsupported, 2);
  assert.equal(s.events.filter((e) => e.type === 'provider-gap').length, 1);
  assert.ok(s.events.some((e) => e.type === 'unsupported' && e.kind === 'paid-with-pump'));
});

test('a dust remainder of a route hop no longer hides a real buy', () => {
  // 422prjq1y2… on 2026-10-07: −0.265 SOL, +877018506549 EuZZ, +1 raw unit of the 7vfC hop.
  const coin = 'EuZZTUXXwZxsjwWtyf9kRBXyQDAHrdACWMYsKUZKpump', hop = '7vfCXTUXXwZxsjwWtyf9kRBXyQDAHrdACWMYsKpump';
  const tx = {blockTime: 1, slot: 1, transaction: {signatures: ['d'], message: {accountKeys: [{pubkey: LEADER, signer: true}]}},
    meta: {err: null, fee: 5005000, preBalances: [10e9], postBalances: [10e9 - 265005000], preTokenBalances: [], postTokenBalances: [bal(LEADER, coin, 877018506549), bal(LEADER, hop, 1)]}};
  const b = detectBuy(tx, LEADER);
  assert.equal(b.bought.length, 1); assert.equal(b.bought[0].mint, coin);
});

test('diagnose: provider health, price spread, coverage gap and PUMP-pair warning (mocked network)', async (t) => {
  t.after(() => setFetch(null));
  const json = (body) => ({ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body)});
  const allSigs = rows.map((a) => a.trans_id), missing = allSigs[3];
  setFetch(async (url, init) => {
    if (url.includes('pro-api.solscan.io')) {
      assert.equal(init.headers.token, 'test-solscan-key');
      if (url.includes('/block/last')) return json({success: true, data: [{current_slot: 454367100}]});
      if (url.includes('/token/price')) return json({success: true, data: [{price: 116}]});
      if (url.includes('/account/defi/activities')) return json({success: true, data: url.includes('page=1') ? rows : []});
    }
    if (url.includes('jup.ag')) return json({So11111111111111111111111111111111111111112: {usdPrice: 116.5}});
    if (url.includes('dexscreener')) return json([]);
    const {method} = JSON.parse(init.body);
    if (method === 'getSlot') return json({result: 454367150});
    if (method === 'getAsset') return json({result: {token_info: {price_info: {price_per_token: 116.2}}}});
    if (method === 'getSignaturesForAddress') return json({result: allSigs.filter((s) => s !== missing).map((signature) => ({signature, blockTime: 0}))});
    throw new Error('unexpected ' + url);
  });
  const r = await diagnose({pages: 1, verify: 0, log: () => {}});
  assert.equal(r.providers.solscan.lagSlots, 50);
  assert.deepEqual(r.prices, {Solscan: 116, Helius: 116.2, Jupiter: 116.5});
  assert.deepEqual(r.coverage.missingFromHelius, [missing]);
  assert.ok(r.warnings.some((w) => /missing from Helius/.test(w)));
  assert.ok(r.warnings.some((w) => /PUMP-paired/.test(w)));
  assert.equal(JSON.stringify(r).includes('test-solscan-key'), false, 'key never written to the report');
});

test('diagnose does not report false gaps when flooded Helius history ends before his swaps', async (t) => {
  t.after(() => setFetch(null));
  const json = (body) => ({ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body)});
  const now = Math.floor(Date.now() / 1000);
  setFetch(async (url, init) => {
    if (url.includes('/block/last')) return json({success: true, data: [{current_slot: 1}]});
    if (url.includes('/account/defi/activities')) return json({success: true, data: url.includes('page=1') ? rows : []});
    if (url.includes('pro-api.solscan.io')) return json({success: true, data: [{price: 116}]});
    if (!init?.body) return json([]);
    const {method} = JSON.parse(init.body);
    if (method === 'getSlot') return json({result: 2});
    // 1000 spam signatures per page, all newer than any of his swaps.
    if (method === 'getSignaturesForAddress') return json({result: Array.from({length: 1000}, (_, i) => ({signature: 'spam' + i + Math.random(), blockTime: now - 5}))});
    return json({result: null});
  });
  const r = await diagnose({pages: 1, verify: 0, log: () => {}});
  assert.equal(r.coverage.comparedSwaps, 0);
  assert.deepEqual(r.coverage.missingFromHelius, []);
  assert.equal(r.warnings.some((w) => /missing from Helius/.test(w)), false);
});
