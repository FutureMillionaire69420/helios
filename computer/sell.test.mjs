// LIVE-mode sell path, end to end, with every network call faked: a held coin hits its stop-loss and is
// sold by the bot's own sell builder (no PumpPortal), using the pushed token balance and price, closing the
// token account; when the local sell is refused, PumpPortal still sells it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startRuntime} from './runtime.mjs';
import * as P from './pumpbuild.mjs';
import {config, findProgramAddress, associatedTokenAddress as ata, b58decode, b58encode, loadKeypair, signTransaction, parseTransaction, addTransferInstruction, transactionBlockhash, TIP_ACCOUNTS, leaderPumpBuys, leaderPumpSells, detectBuy, detectSell} from './copybot.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PRISTINE = {...process.env};
const MINT = 'siBF3bcDKAH9so6zFSRLVer6ua3sFJ8m279aF2cpump', CREATOR = b58encode(Buffer.alloc(32, 21)), BH = b58encode(Buffer.alloc(32, 7));
const kp = loadKeypair(JSON.stringify([...Buffer.alloc(32, 9)]));
const HELD = 9_000_000n;
const tokenAcct = (amount) => { const b = Buffer.alloc(165); b.writeBigUInt64LE(amount, 64); return b.toString('base64'); };
const instructionsOf = (bytes) => {
  const tx = parseTransaction(bytes), m = tx.message; let o = 3;
  const sv = () => { let n = 0, sh = 0, b; do { b = m[o++]; n |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); return n; };
  const nk = sv(); o += nk * 32 + 32; const ni = sv(); const out = [];
  for (let i = 0; i < ni; i++) { const pid = m[o++]; const na = sv(); const acc = [...m.subarray(o, o + na)].map((x) => tx.keys[x]); o += na; const nd = sv(); out.push({program: tx.keys[pid], acc, data: Buffer.from(m.subarray(o, o + nd))}); o += nd; }
  return out;
};

async function liveBot(t, {refuseLocal = 0, balances = null, cashback = false} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-sell-'));
  const file = path.join(dir, 'engine-live.json');
  // a coin bought earlier (saved with its token program and creator, as the bot now does)
  fs.writeFileSync(file, JSON.stringify({version: 2, mode: 'live', wallet: kp.publicKey, paused: false, autoCopy: true, daily: {}, seen: {}, jobs: {}, queues: {}, events: [], paperBalance: 0,
    positions: {[MINT]: {raw: HELD.toString(), costSol: 0.1, realizedSol: 0, boughtAt: Date.now() - 5000, tokenProgram: P.TOKEN_2022, creator: CREATOR}}}));
  Object.assign(process.env, {ENGINE_STATE_FILE: file, PORT: '0', DASHBOARD_TOKEN: 'sell-test-token-24-characters-x', STUDY: 'false', STALE_DATA_SEC: '0', MAX_HOLD_SEC: '0', MONITOR_MS: '20', FULL_PATH_DELAY_MS: '0', BOT_POWER: ''});
  const seen = {pumpportal: 0, validated: [], sent: [], rpc: [], tokenLookups: 0, accountWatches: [], balanceReads: 0};
  let n = 0;
  const k = {
    config: {...config, dryRun: false, logFile: path.join(dir, 'log'), tipSol: 0.001, priorityFeeSol: 0.0005, slippagePct: 20}, kp, redact: (x) => x,
    findProgramAddress, ata, b58decode, b58encode, signTransaction, addTransferInstruction, transactionBlockhash, TIP_ACCOUNTS,
    rpc: async (method) => {
      seen.rpc.push(method);
      if (method === 'getLatestBlockhash') return {value: {blockhash: BH}};
      if (method === 'getTokenAccountsByOwner') { seen.tokenLookups++; return {value: [{account: {data: {parsed: {info: {tokenAmount: {amount: HELD.toString()}}}}}}]}; }
      return null; // pump.fun global not readable here: the desk uses the SDK's fee recipients
    },
    getBalanceSol: async () => { seen.balanceReads++; return balances ? balances[Math.min(seen.balanceReads, balances.length) - 1] : 1; },
    readCurve: async () => ({vSol: 40_000_000_000n, vTok: 500_000_000_000_000n, complete: false, creator: CREATOR, mayhem: false, cashback, quoteMint: null}),
    quoteSell: async () => (n++ < 2 ? 0.11 : 0.04), // the coin falls ~60%: stop-loss
    // pushes: the wallet's token account (balance) and the coin's curve
    stream: {watchAccount: (pk, cb) => { seen.accountWatches.push(pk); setTimeout(() => cb(tokenAcct(HELD), Date.now()), 0); const un = () => {}; un.ready = () => true; return un; }, slot: () => null, connected: () => true},
    validateTrade: async (bytes, job) => { seen.validated.push({bytes, job}); if (seen.validated.length <= refuseLocal) throw new Error('simulation failed: slippage'); },
    http: async (url) => { if (/pumpportal/.test(url)) { seen.pumpportal++; const kit = {mint: MINT, tokenProgram: P.TOKEN_2022, creator: CREATOR, feeRecipient: P.STATIC_FEE_RECIPIENTS[0], buybackRecipient: P.STATIC_BUYBACK_RECIPIENTS[0]}; return Buffer.from(P.buildSellTransaction({user: kp.publicKey, kit, raw: HELD, minSolOut: 1n, blockhash: BH}, {findProgramAddress, ata, b58decode, b58encode}).bytes); } throw new Error('unexpected ' + url); },
    sendRaw: async (bytes, extra) => { seen.sent.push({bytes, extra}); return 'ok'; },
    senderUrl: () => 'http://slc-sender.helius-rpc.com/fast',
    confirm: async () => ({ok: true}),
    getTransaction: async () => ({slot: 5, transaction: {message: {accountKeys: [{pubkey: kp.publicKey}]}}, meta: {err: null, preBalances: [1e9], postBalances: [1e9 + 0.04e9 + 2_039_280], preTokenBalances: [{owner: kp.publicKey, mint: MINT, uiTokenAmount: {amount: HELD.toString()}}], postTokenBalances: []}}),
    startWatcher: () => () => {},
    leaderPumpBuys: () => [], leaderPumpSells: () => [], detectBuy: () => null, detectSell: () => null,
  };
  const r = await startRuntime(k);
  t.after(() => { r.stop(); fs.rmSync(dir, {recursive: true, force: true}); for (const key of Object.keys(process.env)) if (!(key in PRISTINE)) delete process.env[key]; Object.assign(process.env, PRISTINE); });
  return {r, seen};
}

test('LIVE stop-loss: the bot builds the sell itself (no PumpPortal), from the pushed balance, and closes the token account', async (t) => {
  const {r, seen} = await liveBot(t);
  for (let i = 0; i < 100 && r.engine.d.positions[MINT].raw !== '0'; i++) await sleep(20);
  await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '0', 'sold');
  assert.ok(r.engine.d.events.some((e) => e.type === 'exit-rule' && e.rule === 'stoploss'), 'by the stop-loss');
  assert.equal(seen.pumpportal, 0, 'PumpPortal never asked');
  assert.equal(seen.tokenLookups, 0, 'the token balance came from the push, not an RPC lookup');
  assert.deepEqual(seen.accountWatches, [ata(kp.publicKey, MINT, P.TOKEN_2022)], 'its token account was watched from re-arming after the restart');
  assert.equal(seen.validated.length, 1, 'the full safety check ran once');
  const ixs = instructionsOf(seen.validated[0].bytes);
  const sell = ixs.find((x) => x.program === P.PUMP);
  assert.equal(sell.data.subarray(0, 8).toString('hex'), '33e685a4017f83ad'); assert.equal(sell.data.readBigUInt64LE(8), HELD, 'the whole position');
  const exp = P.solOut({vSol: 40_000_000_000n, vTok: 500_000_000_000_000n}, HELD);
  assert.equal(sell.data.readBigUInt64LE(16), exp * 6500n / 10000n, 'min SOL out from the live curve less the 35% sell slippage');
  const close = ixs.find((x) => x.program === P.TOKEN_2022);
  assert.ok(close && close.data[0] === 9, 'token account closed in the same transaction (rent back)');
  assert.equal(seen.sent.length, 1); assert.deepEqual(seen.sent[0].extra, ['http://slc-sender.helius-rpc.com/fast'], 'sent through Helius Sender');
  assert.equal(r.desk.kit(MINT), null, 'disarmed once fully sold');
  assert.equal(r.desk.stats.closes, 1);
});

test('LIVE: a local sell the safety check refuses is retried without the close, then PumpPortal sells it', async (t) => {
  const {r, seen} = await liveBot(t, {refuseLocal: 2});
  for (let i = 0; i < 100 && r.engine.d.positions[MINT].raw !== '0'; i++) await sleep(20);
  await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '0', 'still sold');
  assert.equal(seen.validated.length, 3, 'local with close, local without close, then PumpPortal');
  assert.ok(instructionsOf(seen.validated[0].bytes).some((x) => x.program === P.TOKEN_2022 && x.data[0] === 9), 'first try closed the account');
  assert.ok(!instructionsOf(seen.validated[1].bytes).some((x) => x.program === P.TOKEN_2022), 'second try did not');
  assert.equal(seen.pumpportal, 1, 'PumpPortal was the last resort');
  assert.equal(r.desk.stats.fallbacks, 1);
  assert.ok(r.engine.d.events.some((e) => e.type === 'connection' && /local sell build failed, using PumpPortal/.test(e.message)));
});

test('LIVE: a short cached SOL balance is read again before a sell is refused for fees', async (t) => {
  const {r, seen} = await liveBot(t, {balances: [0.001, 1]});
  for (let i = 0; i < 100 && r.engine.d.positions[MINT].raw !== '0'; i++) await sleep(20);
  await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '0', 'sold');
  assert.equal(seen.balanceReads, 2, 'cached 0.001 SOL, read again: 1 SOL');
  assert.equal(seen.pumpportal, 0);
});

test('LIVE: a sell the wallet really cannot pay fees for is refused before anything is built', async (t) => {
  const {r, seen} = await liveBot(t, {balances: [0.001]});
  for (let i = 0; i < 100 && !r.engine.d.events.some((e) => e.type === 'failed' && e.side === 'sell'); i++) await sleep(20);
  const failed = r.engine.d.events.find((e) => e.type === 'failed' && e.side === 'sell');
  assert.match(failed?.message || '', /insufficient SOL for sell fees/);
  assert.equal(seen.validated.length, 0, 'nothing built or simulated'); assert.equal(seen.pumpportal, 0);
});

// ---- the local BUY builder and the sell desk together: Decu's real buy (websocket logs) -> the bot's buy
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/leader-ws-logs.json', import.meta.url), 'utf8'));
const restamp = (logs) => logs.map((l) => { if (!l.startsWith('Program data: ')) return l; const b = Buffer.from(l.slice(14), 'base64'); if (b.length >= 97) b.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 89); return 'Program data: ' + b.toString('base64'); });
const GLOBAL = findProgramAddress([Buffer.from('global')], P.PUMP)[0];
const globalAccount = (() => { // pump.fun Global with the SDK's fee and buyback recipients (layout as readGlobal reads it)
  const d = Buffer.alloc(1005), put = (o, key) => Buffer.from(b58decode(key)).copy(d, o);
  put(41, P.STATIC_FEE_RECIPIENTS[0]); P.STATIC_FEE_RECIPIENTS.slice(1, 8).forEach((key, i) => put(162 + i * 32, key));
  d.writeBigUInt64LE(95n, 105); d.writeBigUInt64LE(30n, 154);
  P.STATIC_BUYBACK_RECIPIENTS.forEach((key, i) => put(741 + i * 32, key));
  return d.toString('base64');
})();
const BOUGHT = 2_000_000_000_000n;

// the coin's bonding curve account as the chain returns it (reserves, creator, flags, SOL quote)
const curveAccount = (ctx) => { const b = Buffer.alloc(115); b.writeBigUInt64LE(ctx.vTok, 8); b.writeBigUInt64LE(ctx.vSol, 16); b.writeBigUInt64LE(ctx.realTok, 24); b.writeBigUInt64LE(ctx.realSol, 32); b.writeBigUInt64LE(1_000_000_000_000_000n, 40); Buffer.from(b58decode(ctx.creator)).copy(b, 49); return b.toString('base64'); };

async function liveBuyBot(t, {failAll = false} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-buy-'));
  Object.assign(process.env, {ENGINE_STATE_FILE: path.join(dir, 'engine-live.json'), PORT: '0', DASHBOARD_TOKEN: 'sell-test-token-24-characters-x', STUDY: 'false', STALE_DATA_SEC: '0', MAX_HOLD_SEC: '0', MONITOR_MS: '50', FULL_PATH_DELAY_MS: '0', BOT_POWER: ''});
  const seen = {validated: [], sent: [], pumpportal: 0, watches: [], unwatched: [], armedAtSend: null, watchedAtSend: null, chainReads: []};
  let r = null, ws = null, ataPush = null, ppFeed = null;
  const ctx = P.buyContextFromLogs(fx.buy.logs, config.leader, b58encode);
  const k = {
    config: {...config, dryRun: false, logFile: path.join(dir, 'log'), tipSol: 0.001, priorityFeeSol: 0.0005, slippagePct: 20, minLeaderBuyUsd: 1}, kp, redact: (x) => x,
    findProgramAddress, ata, b58decode, b58encode, signTransaction, addTransferInstruction, transactionBlockhash, TIP_ACCOUNTS,
    leaderPumpBuys, leaderPumpSells, detectBuy, detectSell, getSolUsd: async () => 116,
    rpc: async (method, params) => {
      if (method === 'getLatestBlockhash') return {value: {blockhash: BH}};
      if (method === 'getAccountInfo' && params?.[0] === GLOBAL) return {value: {data: [globalAccount, 'base64'], owner: P.PUMP}};
      if (method === 'getMultipleAccounts') { seen.chainReads.push(params[0]); return {value: [{data: [curveAccount(ctx), 'base64'], owner: P.PUMP}, {data: ['', 'base64'], owner: P.TOKEN_2022}]}; }
      return null;
    },
    getBalanceSol: async () => 1,
    quoteBuy: async () => ({raw: 1_000_000}), quoteSell: async () => 0.1,
    stream: {watchAccount: (pk, cb) => { seen.watches.push(pk); ataPush = cb; const un = () => { seen.unwatched.push(pk); }; un.ready = () => true; return un; }, slot: () => null, connected: () => true},
    // the real safety check is a simulation on the RPC: a network round trip
    validateTrade: async (bytes, job) => { seen.validated.push(job.side); await sleep(5); if (failAll) throw new Error('simulation failed: test'); },
    http: async (url) => { if (/pumpportal/.test(url)) { seen.pumpportal++; await sleep(5); throw new Error('PumpPortal down (test)'); } throw new Error('unexpected ' + url); },
    sendRaw: async (bytes) => { seen.sent.push(bytes); seen.armedAtSend = !!r.desk.kit(MINT)?.userAta; seen.watchedAtSend = seen.watches.length; return 'ok'; },
    senderUrl: () => 'http://slc-sender.helius-rpc.com/fast',
    // landing creates the token account: its balance is pushed like the real websocket does
    confirm: async () => { await sleep(5); ataPush?.(tokenAcct(BOUGHT), Date.now()); return {ok: true}; },
    getTransaction: async (sig) => (sig === fx.buy.signature || sig === fx.sell.signature ? null
      : {slot: 7, transaction: {message: {accountKeys: [{pubkey: kp.publicKey}]}}, meta: {err: null, preBalances: [1e9], postBalances: [1e9 - 0.1e9 - 3_500_000], preTokenBalances: [], postTokenBalances: [{owner: kp.publicKey, mint: MINT, uiTokenAmount: {amount: BOUGHT.toString()}}]}}),
    startWatcher: (cb) => { ws = cb; return () => {}; },
    startPumpPortalWatcher: (cb) => { ppFeed = cb; return {stop: () => {}, status: () => ({connected: true})}; },
  };
  r = await startRuntime(k);
  t.after(() => { r.stop(); fs.rmSync(dir, {recursive: true, force: true}); for (const key of Object.keys(process.env)) if (!(key in PRISTINE)) delete process.env[key]; Object.assign(process.env, PRISTINE); });
  for (let i = 0; i < 50 && !r.desk; i++) await sleep(5);
  await sleep(30); // the pump.fun global and the first blockhash are read at start
  return {r, seen, ws: (...a) => ws(...a), pp: (...a) => ppFeed(...a)};
}

test('LIVE buy -> sell desk: the local buy arms its sell before it is sent; once landed it sells with no lookups', async (t) => {
  const {r, seen, ws} = await liveBuyBot(t);
  await ws(fx.buy.signature, 'ws', restamp(fx.buy.logs));
  await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT]?.raw, BOUGHT.toString(), 'bought');
  assert.equal(seen.pumpportal, 0, 'built locally (no PumpPortal)'); assert.deepEqual(seen.validated, ['buy'], 'full safety check ran');
  assert.equal(seen.armedAtSend, true, 'its sell was armed before the buy was sent');
  assert.equal(seen.watchedAtSend, 1, 'its token account was watched before the buy was sent');
  assert.deepEqual(seen.watches, [ata(kp.publicKey, MINT, P.TOKEN_2022)], 'one watch: the confirmation re-used the armed sell');
  const ctx = P.buyContextFromLogs(fx.buy.logs, config.leader, b58encode);
  const p = r.engine.d.positions[MINT];
  assert.equal(p.tokenProgram, P.TOKEN_2022); assert.equal(p.creator, ctx.creator, 'saved with the position (a restart re-arms with no lookup)');
  assert.equal(r.desk.balance(MINT), BOUGHT, 'the landed balance arrived by push');
  assert.equal(r.desk.blocker(MINT), 'curve flags unknown', 'until the first curve push (or one read) says whether it is a cashback coin');
  r.desk.update(MINT, {vSol: ctx.vSol, vTok: ctx.vTok, complete: false, creator: ctx.creator, mayhem: false, cashback: false, quoteMint: null}); // the first push
  // the sell is pure assembly now: every address worked out at the buy, the price from the push
  const t0 = performance.now();
  const b = r.desk.build({mint: MINT, raw: BOUGHT, slippagePct: 35, blockhash: BH, priorityLamports: 500_000, tipAccount: TIP_ACCOUNTS[0], tipLamports: 1_000_000, closeAccount: true, global: null});
  const ms = performance.now() - t0;
  assert.ok(ms < 5, `sell built in ${ms.toFixed(3)} ms`);
  assert.equal(b.expectedLamports, P.solOut({vSol: ctx.vSol, vTok: ctx.vTok, feeBps: ctx.feeBps, creatorFeeBps: ctx.creatorFeeBps}, BOUGHT));
});

test('LIVE buy that fails: nothing is held, so its armed sell and token-account watch are dropped', async (t) => {
  const {r, seen, ws} = await liveBuyBot(t, {failAll: true});
  await ws(fx.buy.signature, 'ws', restamp(fx.buy.logs));
  await r.engine.idle(); await sleep(5);
  assert.ok(r.engine.d.events.some((e) => e.type === 'failed' && e.side === 'buy'), 'the buy failed');
  assert.equal(seen.sent.length, 0, 'nothing sent'); assert.equal(seen.pumpportal, 1, 'PumpPortal was tried after the local build was refused');
  assert.deepEqual(seen.watches, [ata(kp.publicKey, MINT, P.TOKEN_2022)], 'it was armed during the attempt');
  assert.equal(r.desk.kit(MINT), null, 'disarmed');
  assert.deepEqual(seen.unwatched, seen.watches, 'and its token-account watch closed');
});

test('LIVE: a cashback coin (only its curve says so) is sold with its extra account, locally', async (t) => {
  const {r, seen} = await liveBot(t, {cashback: true});
  for (let i = 0; i < 100 && r.engine.d.positions[MINT].raw !== '0'; i++) await sleep(20);
  await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT].raw, '0', 'sold');
  assert.equal(seen.pumpportal, 0, 'built locally');
  const sell = instructionsOf(seen.validated[0].bytes).find((x) => x.program === P.PUMP);
  const uva = findProgramAddress([Buffer.from('user_volume_accumulator'), b58decode(kp.publicKey)], P.PUMP)[0];
  assert.equal(sell.acc.length, 17, '14 + volume account + bonding-curve-v2 + buyback');
  assert.equal(sell.acc[14], uva, "the user's volume account comes first after the IDL accounts");
});

test('LIVE: PumpPortal saw his buy first (no Helius trade event yet): one chain read, then the bot builds the buy itself', async (t) => {
  const {r, seen, pp} = await liveBuyBot(t);
  const [b] = leaderPumpBuys(fx.buy.logs, config.leader);
  pp({sig: fx.buy.signature, mint: MINT, trader: config.leader, side: 'buy', sol: b.solAmount / 1e9, raw: b.tokenAmount, pool: 'pump', vSol: null, vTok: null});
  for (let i = 0; i < 100 && !r.engine.d.positions[MINT]; i++) await sleep(10);
  await r.engine.idle();
  assert.equal(r.engine.d.positions[MINT]?.raw, BOUGHT.toString(), 'bought');
  assert.equal(seen.pumpportal, 0, 'built locally: no PumpPortal round trip, no 0.5% fee');
  assert.equal(seen.chainReads.length, 1, 'one read of the curve and the mint');
  assert.deepEqual(seen.chainReads[0], [findProgramAddress([Buffer.from('bonding-curve'), b58decode(MINT)], P.PUMP)[0], MINT]);
  const ctx = P.buyContextFromLogs(fx.buy.logs, config.leader, b58encode);
  const p = r.engine.d.positions[MINT];
  assert.equal(p.tokenProgram, P.TOKEN_2022, 'token program from the mint'); assert.equal(p.creator, ctx.creator, 'creator from the curve');
  assert.equal(r.desk.kit(MINT).cashback, false, 'the curve read also told it is not a cashback coin');
});
