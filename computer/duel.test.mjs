// DIP vs FCAT duel: the math (duelmath.mjs), the brain (duelbrain.mjs) and the paper traders end to end on a fake
// chain (duel.mjs). Nothing here signs or sends anything; the duel has no way to.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buyRaw, sellSol, buyPriceNow, dipTriggered, exitCheck, holderCheck, calibrateK, kFloor, replay, DEFAULTS, entryChecks, allowedChange, bootstrapMean, summarize } from './duelmath.mjs';
import { createDuel, tradeEventsFromLogs } from './duel.mjs';
import { lookBack, brainNote } from './duelbrain.mjs';
import { createVault } from './vault.mjs';

const FEE = 0.0125, RULES = [[10000, 1000], [20000, 2500], [30000, 4000]];
const pre = { vSol: 30e9, vTok: 1.073e15 };
const hisRaw = buyRaw(pre, 1, FEE), post = { vSol: 30e9 + 0.9875e9, vTok: 1.073e15 - hisRaw };
const P = 0.9875 / hisRaw;
const withSol = (vSol) => ({ vSol, vTok: Math.floor((post.vSol * post.vTok) / vSol) }); // a trade moved the curve

test('duelmath: fills, dip triggers, exits and the protected limits', () => {
  const px = buyPriceNow(post, 0.0995, FEE);
  assert.ok(px > P && px / P - 1 < 0.05, 'right after his buy we pay a little more than his average');
  const dipped = withSol(29.5e9);
  assert.equal(dipTriggered(DEFAULTS.dip, { buyPx: buyPriceNow(dipped, 0.0995, FEE), P, high: px }), true);
  assert.equal(dipTriggered({ ...DEFAULTS.dip, dipPct: 10 }, { buyPx: buyPriceNow(dipped, 0.0995, FEE), P, high: px }), false);
  assert.equal(dipTriggered({ ...DEFAULTS.dip, dipTrigger: 'off-high' }, { buyPx: px * 0.89, P, high: px }), true);
  const pos = { fillAt: 0, P };
  assert.equal(exitCheck(DEFAULTS.fcat, pos, { now: 10_000, pnl: 0.19 }).rule, 'tp-early');
  assert.equal(exitCheck(DEFAULTS.fcat, pos, { now: 16_000, pnl: 0.19 }), null, 'after 15 s it needs +24.5%');
  assert.equal(exitCheck(DEFAULTS.fcat, pos, { now: 16_000, pnl: 0.25 }).rule, 'tp-late');
  assert.equal(exitCheck(DEFAULTS.fcat, pos, { now: 16_000, pnl: -0.6, sellPx: P * 0.5 }), null, 'FCAT has no stop');
  assert.equal(exitCheck(DEFAULTS.dip, pos, { now: 16_000, pnl: -0.25, sellPx: P * 0.79 }).rule, 'stop', "DIP stops 20% under Decu's price");
  assert.equal(allowedChange('fcat', 'stopFromHisPct', 20), false, 'a brain can never give FCAT a stop');
  assert.equal(allowedChange('dip', 'maxPayPct', 25), false, 'never pay more than +20%');
  assert.equal(allowedChange('dip', 'maxBuysAhead', 3), false);
  assert.equal(allowedChange('dip', 'tpEarlyPct', 21), true);
  const chk = entryChecks({ hisUsd: 50, hisMcapUsd: 30000, secAtSeen: 9, blocksAtSeen: 30, crowd: { status: 'pending' }, holder0: { status: 'failed' } }, DEFAULTS.fcat);
  assert.deepEqual(chk.fails, ['hisUsd', 'mcap', 'timing', 'data:holder']);
  assert.deepEqual(chk.pending, ['crowd']);
  assert.deepEqual(entryChecks({ hisUsd: 100, hisMcapUsd: 5000, secAtSeen: 9, blocksAtSeen: 4, crowd: { status: 'done', buysAhead: 2 }, holder0: { status: 'done', verdict: { relaxedPass: true } } }, DEFAULTS.fcat).fails, [], '5 s OR 5 blocks');
  const r = buyRaw(post, 0.1, FEE), after = { vSol: post.vSol + 0.1e9 * (1 - FEE), vTok: post.vTok - r };
  assert.ok(Math.abs(sellSol(after, r, FEE) - 0.1 * (1 - FEE) ** 2) < 1e-6, 'buy then sell at once: only the two pool fees are lost');
  const ci = bootstrapMean([0.1, 0.2, 0.15, 0.12, 0.18]); assert.ok(ci.low > 0 && ci.high < 0.25);
  assert.equal(summarize([{ pnlSol: 0.02, ret: 0.2, closedAt: 1, exit: 'tp-early' }, { pnlSol: -0.05, ret: -0.5, closedAt: 2, exit: 'stop' }]).maxDrawdownSol, -0.05);
});

test('holder rule: the baseline is kept, the relaxed label is separate, and k never goes under the $500 floor', () => {
  assert.equal(kFloor(RULES, 500), 0.5);
  const h = holderCheck(700, 12000, RULES, 0.5);
  assert.equal(h.safe, false, 'baseline: $700 at $12k is RISKY');
  assert.equal(h.relaxedPass, true, 'relaxed: accepted, under its own label');
  assert.equal(holderCheck(10, 9000, RULES, 1).safe, true, 'under $10k a coin is always SAFE');
  const samples = [...Array(10)].map((_, i) => ({ heldUsd: 1500, mcapUsd: 12000 })).concat([...Array(10)].map((_, i) => ({ heldUsd: 600 + i * 30, mcapUsd: 15000 })));
  const r = calibrateK(samples, RULES, { target: 1.7, kMin: 0.5 });
  assert.equal(r.baseline, 10); assert.ok(r.accepted >= 17 && r.targetMet && r.k >= 0.5 && r.k < 1);
  const none = calibrateK([...Array(20)].map(() => ({ heldUsd: 5000, mcapUsd: 12000 })), RULES, { target: 1.7, kMin: 0.5 });
  assert.equal(none.targetMet, false); assert.equal(none.k, 0.5); assert.equal(none.maxIncrease, 0, 'nothing rejected: loosening cannot add any coin');
});

test('replay (the brain looks back) agrees with the rules: FCAT takes the early profit, DIP buys the dip and leaves at his sell', () => {
  const path = [[0, post.vSol, post.vTok], [3000, ...Object.values(withSol(36e9))], [8000, ...Object.values(withSol(29.5e9))], [20000, ...Object.values(withSol(31e9))]];
  const f = replay(DEFAULTS.fcat, { path, P, fee: FEE, seenMs: 500, landMs: 500, hisSellMs: 30000 });
  assert.equal(f.rule, 'tp-early'); assert.ok(f.ret > 0.15);
  const d = replay(DEFAULTS.dip, { path, P, fee: FEE, seenMs: 500, landMs: 500, hisSellMs: 30000 });
  assert.equal(d.taken, true); assert.equal(d.rule, 'his-sell'); assert.ok(d.ret > 0);
});

// ---------- a fake chain ----------
const pad = (s) => { const b = Buffer.alloc(32); b.write(s); return b; };
const enc = (b) => Buffer.from(b).toString('utf8').replace(/\0+$/, '');
const DISC = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]);
const tradeLog = (mint, user, isBuy) => { const b = Buffer.alloc(8 + 32 + 8 + 8 + 1 + 32 + 8); DISC.copy(b, 0); pad(mint).copy(b, 8); b.writeBigUInt64LE(10n ** 8n, 40); b.writeBigUInt64LE(10n ** 12n, 48); b[56] = isBuy ? 1 : 0; pad(user).copy(b, 57); return 'Program data: ' + b.toString('base64'); };
function fakeChain({ ahead = [] } = {}) {
  const st = { state: { ...post } }, subs = new Map(), calls = [];
  const k = {
    config: { leader: 'DECU' },
    readCurve: async () => ({ ...st.state, complete: false }),
    watchCurve: (mint, cb) => { subs.set(mint, cb); const un = () => subs.delete(mint); un.ready = () => true; un.readyAt = () => 0; return un; },
    findProgramAddress: (seeds) => [`curve-${Buffer.from(seeds[1]).toString()}`], b58decode: (m) => Buffer.from(m), b58encode: enc,
    rpc: async (method, params) => {
      calls.push(method);
      if (method === 'getTokenAccounts') return { token_accounts: [{ owner: 'curve-MintA', amount: 7e14 }, { owner: 'DECU', amount: hisRaw }, { owner: 'h1', amount: 2e13 }, { owner: 'h2', amount: 5e12 }, { owner: 'dev', amount: 1e13 }] };
      if (method === 'getSignaturesForAddress') return ahead.map((x, i) => ({ signature: `s${i}`, slot: 101, err: null }));
      if (method === 'getTransaction') { const i = Number(params[0].slice(1)); return { meta: { logMessages: [tradeLog('MintA', `user${i}`, ahead[i] === 'buy')] } }; }
      if (method === 'getTokenAccountsByOwner') return { value: [] };
      return null;
    },
  };
  const push = (s) => { st.state = s; subs.get('MintA')?.({ ...s, complete: false }, Date.now()); };
  return { k, push, calls };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hisBuy = (duel) => duel.onLeaderBuy({ sig: 'SIG1', time: Date.now() / 1000, side: 'buy', mint: 'MintA', sol: 0.9875, raw: String(hisRaw), pump: true, fast: true, vSol: post.vSol, vTok: post.vTok, usd: 148 }, { source: 'ws', seenAt: Date.now(), seenSlot: 101, hisSlot: 100 });
const opts = (k, dir, extra = {}) => ({ k, dir, landMs: 30, poolFee: FEE, sideFee: () => 0.001, solUsd: () => 150, holderRules: RULES, creatorOf: () => 'dev', leader: 'DECU', crowdDelayMs: 40, holderSnapSec: [0], graceMs: 50, padMs: 50, settings: { dip: { dipWindowSec: 1 }, fcat: {} }, brainEveryMin: 60, ...extra });

test('the duel: both traders see the same Decu buy; FCAT takes +18% early, DIP buys the dip and sells at his sell; results, notes and restart', async (t) => {
  const dir = fs.mkdtempSync('duel-'), { k, push, calls } = fakeChain();
  const vault = createVault(dir + '/vault');
  let duel = createDuel(opts(k, dir, { notes: { vault } }));
  t.after(() => duel.stop());
  hisBuy(duel);
  await wait(120);
  const c = [...duel._test.cands.values()][0];
  assert.equal(c.holder0.status, 'done'); assert.equal(c.holder0.holders, 3, 'Decu, h1, h2: not the curve, not the dev');
  push(withSol(36e9)); // a pump: FCAT is up far more than 18% within 15 s
  await wait(120);
  push(withSol(29.5e9)); // the dip: back under Decu's price
  await wait(150);
  duel.onLeaderSell({ sig: 'SELL1', side: 'sell', mint: 'MintA', sol: 1 }, { source: 'ws' });
  await wait(1300);
  const fcat = duel.variants.get('fcat').trades, dip = duel.variants.get('dip').trades;
  assert.equal(fcat.length, 1); assert.equal(fcat[0].exit, 'tp-early'); assert.ok(fcat[0].ret > 0.15, `FCAT ret ${fcat[0].ret}`); assert.equal(fcat[0].provisional, false, 'final once the buyers-ahead count came back 0');
  assert.equal(dip.length, 1); assert.equal(dip[0].exit, 'his-sell'); assert.ok(dip[0].premium <= 0, 'DIP paid no more than Decu');
  assert.equal(duel.variants.get('dip-under10').trades.length, 0, 'never 10% under his price');
  assert.equal(duel.variants.get('fcat-all').trades.length, 1);
  assert.ok(!calls.includes('sendTransaction') && !calls.includes('simulateTransaction'), 'never sends anything');
  const a = duel.api();
  assert.equal(a.traders.fcat.summary.n, 1); assert.equal(a.candidates.length, 1); assert.equal(a.headToHead.both.n, 1);
  assert.ok(a.brains.dip && a.brains.fcat.optimizing.length > 3);
  assert.equal(a.holderRule.withData, 1);
  assert.ok(fs.readFileSync(dir + '/duel-paper.jsonl', 'utf8').includes('"t":"cand"'));
  duel.writeNotes();
  assert.ok(vault.has('machine/DIP vs FCAT/DIP vs FCAT.md') && vault.has('machine/DIP vs FCAT/FCAT/FCAT brain.md'));
  assert.match(brainNote(a.brains.fcat), /What I am testing right now[\s\S]*What I believe is working[\s\S]*Signals I rejected[\s\S]*Validated on unseen future data/);
  const bal = duel.variants.get('fcat').balance;
  duel.stop();
  duel = createDuel(opts(k, dir));
  assert.equal(duel.variants.get('fcat').trades.length, 1, 'trades come back after a restart');
  assert.ok(Math.abs(duel.variants.get('fcat').balance - bal) < 1e-9);
});

test('the duel: a provisional FCAT trade is voided when 3 buyers were already ahead; his test buys are ignored', async (t) => {
  const dir = fs.mkdtempSync('duel-'), { k } = fakeChain({ ahead: ['buy', 'sell', 'buy', 'buy'] });
  const duel = createDuel(opts(k, dir));
  t.after(() => duel.stop());
  duel.onLeaderBuy({ sig: 'TEST', time: Date.now() / 1000, side: 'buy', mint: 'MintA', sol: 0.02, raw: '1000', pump: true, usd: 3 }, { source: 'ws' });
  assert.equal(duel._test.cands.size, 0, 'a $3 test buy is not a trade');
  hisBuy(duel);
  await wait(400);
  const c = [...duel._test.cands.values()][0];
  assert.equal(c.crowd.buysAhead, 3); assert.equal(c.crowd.sellsAhead, 1);
  const d = c.decisions.fcat;
  assert.equal(d.status, 'skipped'); assert.deepEqual(d.fails, ['crowd']);
  assert.equal(duel.variants.get('fcat').trades.length, 0); assert.equal(duel.variants.get('fcat').open.size, 0);
  assert.ok(Math.abs(duel.variants.get('fcat').balance - 3) < 1e-9, 'the paper balance is refunded');
  assert.equal(duel.variants.get('fcat-all').open.size + duel.variants.get('fcat-all').trades.length, 1, 'the unfiltered variant keeps it (what the filter saved or cost)');
});

test('trade events: every pump.fun trade in the logs, any user', () => {
  const ev = tradeEventsFromLogs([tradeLog('MintA', 'bob', true), 'Program log: x'], enc);
  assert.deepEqual(ev.map((e) => [e.mint, e.user, e.isBuy]), [['MintA', 'bob', true]]);
});

test('the brain looks back only at buys its filters let through and proposes one change at a time', () => {
  const recs = [...Array(25)].map((_, i) => ({ id: `c${i}`, hisTime: 1000 + i, seenAt: (1000 + i) * 1000 + 500, P, path: [[0, post.vSol, post.vTok], [3000, ...Object.values(withSol(i % 2 ? 36e9 : 33e9))], [20000, ...Object.values(withSol(30e9))]], hisSell: { sec: 25 }, hisUsd: 148, hisMcapUsd: 4500, secAtSeen: 0.5, blocksAtSeen: 1, crowd: { status: 'done', buysAhead: 0 }, holder0: { status: 'done', verdict: { relaxedPass: true, safe: true } }, decisions: { fcat: { status: 'bought' } } }));
  const lb = lookBack('fcat', DEFAULTS.fcat, recs, { fee: () => FEE, sideFee: () => 0.001, landMs: 500 });
  assert.equal(lb.n, 25); assert.ok(lb.ideas.length > 5);
  assert.ok(lb.ideas.every((x) => Object.keys(x.diff).length === 1));
  assert.ok(!lb.ideas.some((x) => 'stopFromHisPct' in x.diff), 'never proposes a stop for FCAT');
});

// ---------- inside the real runtime ----------
test('runtime: in PAPER the duel sees the same websocket buy as the engine, serves /api/duel, and DUEL=off removes it', async (t) => {
  const { startRuntime } = await import('./runtime.mjs');
  const cb = await import('./copybot.mjs');
  const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/leader-ws-logs.json', import.meta.url), 'utf8'));
  fx.buy.logs = fx.buy.logs.map((l) => { if (!l.startsWith('Program data: ')) return l; const b = Buffer.from(l.slice(14), 'base64'); if (b.length >= 97) b.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 89); return 'Program data: ' + b.toString('base64'); });
  const TOKEN = 'dashboard-test-token-24-characters', PRISTINE = { ...process.env };
  const boot = async (env) => {
    const dir = fs.mkdtempSync('rt-');
    Object.assign(process.env, { ENGINE_STATE_FILE: dir + '/engine.json', STUDY_FILE: dir + '/study-paper.jsonl', PORT: '0', DASHBOARD_TOKEN: TOKEN, STUDY: 'false', PAPER_MAX_PAY_PCT: '0', STALE_DATA_SEC: '0', FULL_PATH_DELAY_MS: '0', NOTE_CHARTS: 'false', VAULT_BACKFILL: '0', BOT_POWER: 'on', ...env });
    let ws; const rpcCalls = [];
    const k = { config: { ...cb.config, dryRun: true, minLeaderBuyUsd: 1, logFile: dir + '/log', paperLandMs: 0, tipSol: 0.001, priorityFeeSol: 0.0005, slippagePct: 20 }, redact: (x) => x,
      detectBuy: cb.detectBuy, detectSell: cb.detectSell, leaderPumpBuys: cb.leaderPumpBuys, leaderPumpSells: cb.leaderPumpSells, getSolUsd: async () => 100, solUsdNow: () => 100,
      quoteBuy: async () => ({ raw: 1_000_000 }), quoteSell: async () => 0.11, getTransaction: async () => null, startWatcher: (f) => { ws = f; return () => {}; },
      readCurve: async () => ({ vSol: 40_000_000_000n, vTok: 800_000_000_000_000n, complete: false }), rpc: async (m) => { rpcCalls.push(m); return m === 'getTokenAccounts' ? { token_accounts: [] } : []; },
      findProgramAddress: cb.findProgramAddress, b58decode: cb.b58decode, b58encode: cb.b58encode };
    const r = await startRuntime(k);
    t.after(() => { r.stop(); for (const key of Object.keys(process.env)) if (!(key in PRISTINE)) delete process.env[key]; Object.assign(process.env, PRISTINE); });
    return { r, ws: (...a) => ws(...a), rpcCalls, base: `http://127.0.0.1:${r.server.address().port}` };
  };
  const a = await boot({});
  assert.ok(a.r.duel, 'paper: the duel is on');
  await a.ws(fx.buy.signature, 'ws', fx.buy.logs, 400000000);
  await wait(150);
  const d = await (await fetch(a.base + '/api/duel', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  assert.equal(d.on, true); assert.equal(d.candidates.length, 1, 'the same buy the engine got');
  assert.equal((await fetch(a.base + '/api/duel')).status, 401, 'token required');
  assert.ok(a.rpcCalls.includes('getTokenAccounts'), 'holder snapshot taken');
  assert.equal((await fetch(a.base + '/duelview.js')).status, 200);
  a.r.stop();
  const b = await boot({ DUEL: 'off' });
  assert.equal(b.r.duel, null);
  const off = await (await fetch(b.base + '/api/duel', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
  assert.equal(off.on, false);
});

test('pump.fun developer API: off without PUMP_API_KEY; the key only goes in the server Authorization header; never a trading call', async () => {
  const { createPumpApi } = await import('./pumpapi.mjs');
  assert.equal(createPumpApi({ key: '' }), null);
  const seen = [];
  const api = createPumpApi({ key: 'pf_live_secret', perSec: 1000, fetchImpl: async (url, init) => { seen.push({ url: String(url), auth: init.headers.Authorization }); return { ok: true, headers: { get: () => '119' }, json: async () => ({ ok: 1 }) }; } });
  assert.deepEqual(await api.get('/positions', { wallet: 'DECU' }), { ok: 1 });
  assert.equal(seen[0].auth, 'Bearer pf_live_secret'); assert.ok(!seen[0].url.includes('secret'));
  assert.equal(api.status().remaining, '119');
});
