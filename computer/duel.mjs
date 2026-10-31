// DIP vs FCAT DUEL (PAPER ONLY): two independent paper traders, plus their test variants, all fed the SAME Decu
// buys and the SAME market observations, each with its own settings, paper balance, trade ledger, results and
// brain (duelbrain.mjs). Nothing here signs or sends a transaction, touches the engine, its rules, the study or
// any live setting: runtime.mjs hands it a copy of each of Decu's trades and it simulates the rest.
//
// For every Decu buy (a "candidate"):
//  1. Facts known when the bot spots it: Decu's price (from his own trade event: SOL into the curve per token,
//     fees excluded), his buy in $, the market cap right after his buy, seconds and blocks since his buy.
//  2. Shared market observations, started at once: the coin's curve (or PumpSwap pool) pushed over the websocket
//     with a poll as backup, a holder snapshot (every holder, the money they hold, the dev's share, the top 10,
//     ...) when spotted and again 60 s later, and the buyers that were already ahead at the moment the bot
//     decided (counted from the chain ~3 s later, only up to the block it decided in: no look-ahead).
//  3. Each trader decides. FCAT sends as soon as the checks pass (it waits for the holder check, as a live bot
//     would). DIP waits up to 60 s for the price to come back to Decu's price. A paper buy lands PAPER_LAND_MS
//     after it is sent and fills at the curve's price at that moment (the engine's paper recipe: 0.5% haircut,
//     the pool fee, the network fee per side). Until the buyers-ahead count is in, a position is provisional:
//     if the count fails the rule, the trade is voided (it never counted).
//  4. Exits: +18% within 15 s of the bot's buy, +24.5% after, Decu's sell; DIP also its stop. A paper sell lands
//     PAPER_LAND_MS after the decision, at the curve's price then.
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS, entryChecks, isMissing, dipTriggered, exitCheck, markPnl, buyRaw, sellSol, netPrice, buyPriceNow, sellPriceNow, mcapUsd, holderCheck, calibrateK, kFloor, summarize, headToHead, fin, CHECK_NAMES, evidence } from './duelmath.mjs';
import { dayKey } from './dashcalc.mjs';
import { createDuelBrain, notePaths, homeNote, brainNote, dayNote, holderNote, dipsNote, holdersNote } from './duelbrain.mjs';

const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const TRADE_EVENT_DISC = Buffer.from([189, 219, 127, 211, 78, 230, 97, 238]); // sha256("event:TradeEvent")[0..8]

/** Every pump.fun trade event in a transaction's logs (any user): {mint, isBuy, user, sol}. */
export function tradeEventsFromLogs(logs, b58encode) {
  const out = [];
  for (const l of logs || []) {
    if (typeof l !== 'string' || !l.startsWith('Program data: ')) continue;
    let b; try { b = Buffer.from(l.slice(14).trim(), 'base64'); } catch { continue; }
    if (b.length < 8 + 32 + 8 + 8 + 1 + 32 || !b.subarray(0, 8).equals(TRADE_EVENT_DISC)) continue;
    out.push({ mint: b58encode(b.subarray(8, 40)), sol: Number(b.readBigUInt64LE(40)) / 1e9, isBuy: b[56] === 1, user: b58encode(b.subarray(57, 89)) });
  }
  return out;
}

/** The three main ways the dip is measured (DIP trades the first; the two others are for the What-if tab). */
export function standardVariants(base = {}) {
  const dip = { ...DEFAULTS.dip, ...(base.dip || {}) }, fcat = { ...DEFAULTS.fcat, ...(base.fcat || {}) };
  return [
    { id: 'dip', label: 'DIP', strategy: 'dip', role: 'main', p: dip },
    { id: 'fcat', label: 'FCAT', strategy: 'fcat', role: 'main', p: fcat },
    { id: 'dip-high10', label: 'DIP: 10% off the high', strategy: 'dip', role: 'analytics', p: { ...dip, dipTrigger: 'off-high', offHighPct: 10 } },
    { id: 'dip-under10', label: 'DIP: 10% under his price', strategy: 'dip', role: 'analytics', p: { ...dip, dipTrigger: 'his-price', dipPct: 10 } },
    // NO FILTERS: what every Decu buy would have done under each trader's buy and exit rules. This is how a
    // brain knows what a filter cost or saved (the "blame" of each filter) and how the holder rule experiment
    // compares the coins it newly lets in.
    { id: 'dip-all', label: 'DIP, no filters', strategy: 'dip', role: 'unfiltered', filters: false, p: { ...dip } },
    { id: 'fcat-all', label: 'FCAT, no filters', strategy: 'fcat', role: 'unfiltered', filters: false, p: { ...fcat } },
  ];
}

export function createDuel({
  k, mode = 'paper', dir = '.', landMs = 1000, sideFee = () => 0.002, poolFee = 0.0125, pumpSwapFee = null, solUsd = () => null,
  holderRules = [[10000, 1000], [20000, 2500], [30000, 4000]], creatorOf = () => null, leader = null, timezone = 'America/New_York',
  startBalanceSol = 3, settings = {}, holderWaitMs = 2500, holderSnapSec = [0, 60], crowdDelayMs = 3000, crowdMaxTx = 8,
  relax = { on: true, target: 1.7, floorUsd: 500, window: 200, minSamples: 20, every: 5 }, autoTune = true, brainEveryMin = 10,
  notes = null, notify = null, log = () => {}, now = () => Date.now(), maxCands = 3000, minUsd = 20, powered: startPowered = true, graceMs = 5000, padMs = 2000,
} = {}) {
  const swapFee = pumpSwapFee ?? poolFee;
  const feeOf = (st) => (st?.pumpswap ? swapFee : poolFee);
  const stateFile = path.join(dir, `duel-${mode}.json`), journalFile = path.join(dir, `duel-${mode}.jsonl`);
  const timers = new Set();
  let stopped = false, powered = startPowered, dirty = false, saving = false;
  const later = (ms, f) => { const t = setTimeout(() => { timers.delete(t); if (!stopped) { try { const r = f(); if (r?.catch) r.catch((e) => fault('timer', e)); } catch (e) { fault('timer', e); } } }, Math.max(0, ms)); t.unref?.(); timers.add(t); return t; };
  const status = { started: new Date(now()).toISOString(), candidates: 0, errors: 0, lastError: null, rpc: { calls: 0, failed: 0, byMethod: {} }, voided: 0, feeds: 0 };
  const fault = (where, e) => { status.errors++; status.lastError = `${where}: ${String(e?.message || e).slice(0, 160)}`; };
  const call = async (method, params, ms = 4000) => {
    status.rpc.calls++; status.rpc.byMethod[method] = (status.rpc.byMethod[method] || 0) + 1;
    try { return await k.rpc(method, params, ms); } catch (e) { status.rpc.failed++; throw e; }
  };

  // ---------- the traders (variants) ----------
  const variants = new Map();
  const newVariant = (def) => ({
    id: def.id, label: def.label, strategy: def.strategy, role: def.role, filters: def.filters !== false, p: { ...def.p },
    version: def.version || 1, createdAt: def.createdAt || now(), parent: def.parent || null, diff: def.diff || null,
    startBalance: def.role === 'main' ? startBalanceSol : null, balance: def.role === 'main' ? (def.balance ?? startBalanceSol) : null,
    open: new Map(), inflight: new Map(), trades: [], held: new Set(),
  });
  for (const d of standardVariants(settings)) variants.set(d.id, newVariant(d));

  // ---------- persistence: state (balances, open positions, brains) + an append-only journal ----------
  let queue = Promise.resolve();
  const append = (obj) => { const line = JSON.stringify(obj) + '\n'; queue = queue.then(() => fs.promises.appendFile(journalFile, line, { mode: 0o600 })).catch((e) => fault('journal', e)); };
  const snapshotState = () => ({
    v: 1, savedAt: new Date(now()).toISOString(),
    variants: [...variants.values()].map((v) => ({ id: v.id, label: v.label, strategy: v.strategy, role: v.role, filters: v.filters, p: v.p, version: v.version, createdAt: v.createdAt, parent: v.parent, diff: v.diff, balance: v.balance, open: [...v.open.values()] })),
    holderCal, brains: Object.fromEntries(Object.entries(brains).map(([s, b]) => [s, b.save()])),
  });
  const save = () => { dirty = true; if (saving) return; saving = true; later(1000, async () => { try { while (dirty) { dirty = false; const tmp = stateFile + '.tmp'; await fs.promises.writeFile(tmp, JSON.stringify(snapshotState()), { mode: 0o600 }); await fs.promises.rename(tmp, stateFile); } } catch (e) { fault('state', e); } finally { saving = false; } }); };
  const saveNow = () => { try { const tmp = stateFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(snapshotState()), { mode: 0o600 }); fs.renameSync(tmp, stateFile); } catch (e) { fault('state', e); } };

  // ---------- holder rule (baseline kept, relaxed experiment calibrated on PAST coins only) ----------
  const kMin = kFloor(holderRules, relax.floorUsd ?? 500);
  let holderCal = { k: kMin, kMin, samples: [], history: [], last: null, since: 0 };
  const recalibrate = () => {
    if (!relax.on) { holderCal.k = 1; return; }
    const rows = holderCal.samples.slice(-(relax.window || 200));
    if (rows.length < (relax.minSamples || 20)) { holderCal.k = kMin; holderCal.last = { ...calibrateK(rows, holderRules, { target: relax.target, kMin }), k: kMin, note: `fewer than ${relax.minSamples || 20} coins with holder data yet: loosest allowed k` }; return; }
    const r = calibrateK(rows, holderRules, { target: relax.target, kMin });
    holderCal.k = r.k; holderCal.last = { ...r, at: new Date(now()).toISOString() };
    holderCal.history.push({ at: holderCal.last.at, k: r.k, n: r.n, baseline: r.baseline, accepted: r.accepted, increase: r.increase, targetMet: r.targetMet }); if (holderCal.history.length > 200) holderCal.history.shift();
  };

  // ---------- candidates and shared market observations ----------
  const cands = new Map(), done = []; // done: finished candidates (newest last), also replayed from the journal
  const feeds = new Map();
  const curvePda = (mint) => k.findProgramAddress([Buffer.from('bonding-curve'), Buffer.from(k.b58decode(mint))], PUMP)[0];
  const normState = (s, src) => (s && s.vSol != null && s.vTok != null ? { vSol: BigInt(s.vSol), vTok: BigInt(s.vTok), complete: !!s.complete, pumpswap: !!s.pumpswap, pool: s.pool || null, src } : null);

  const readState = async (mint) => {
    const c = await k.readCurve(mint).catch(() => null);
    if (c && !c.complete) return normState(c, 'poll');
    if ((c?.complete || !c) && k.readPool) { const p = await k.readPool(mint).catch(() => null); if (p) return normState(p, 'poll'); }
    return null;
  };
  /** The current state of a coin: the live push when its subscription is trusted, else one read. */
  const stateNow = async (f) => {
    const un = f.unwatch;
    if (f.state && f.state.src === 'push' && un?.ready?.() && !(un.readyAt?.() != null && f.at < un.readyAt())) return f.state;
    if (f.state && now() - f.readAt < 400) return f.state;
    const s = await readState(f.mint);
    if (s) onState(f, s, now()); return s || f.state;
  };
  const onState = (f, st, at) => {
    if (!st || (st.complete && !st.pumpswap)) return; // a finished curve has no price: the pool's pushes take over
    f.state = st; f.at = at || now(); if (st.src === 'poll') f.readAt = now();
    for (const c of f.cands) { try { observe(c, st, f.at); } catch (e) { fault('observe', e); } }
    for (const v of variants.values()) { const pos = v.open.get(f.mint); if (pos) { try { checkExit(v, pos, st); } catch (e) { fault('exit', e); } } }
  };
  const feedFor = (mint) => {
    let f = feeds.get(mint);
    if (f) return f;
    f = { mint, state: null, at: 0, readAt: 0, unwatch: null, cands: new Set(), holders: 0, polling: false };
    feeds.set(mint, f); status.feeds = feeds.size;
    if (powered && k.watchCurve) { try { f.unwatch = k.watchCurve(mint, (curve, at) => { if (feeds.get(mint) === f) onState(f, normState(curve, 'push'), at); }); } catch { f.unwatch = null; } }
    poll(f);
    return f;
  };
  const busyFeed = (f) => [...f.cands].some((c) => now() - c.hisMs < 75_000) || [...variants.values()].some((v) => { const p = v.open.get(f.mint); return p && now() - p.fillAt < 20_000; });
  const poll = (f) => {
    if (f.polling || stopped) return; f.polling = true;
    const tick = async () => {
      if (feeds.get(f.mint) !== f || stopped) { f.polling = false; return; }
      try {
        const un = f.unwatch, trusted = f.state?.src === 'push' && un?.ready?.() && !(un.readyAt?.() != null && f.at < un.readyAt());
        if (powered && (!trusted || now() - f.at > 10_000)) { const s = await readState(f.mint); if (s) onState(f, s, now()); }
      } catch (e) { fault('poll', e); }
      if (feeds.get(f.mint) === f && !stopped) later(busyFeed(f) ? 1000 : 5000, tick); else f.polling = false;
    };
    tick();
  };
  const releaseFeed = (mint) => {
    const f = feeds.get(mint);
    if (!f || f.cands.size || f.holders > 0) return;
    try { f.unwatch?.(); } catch {}
    feeds.delete(mint); status.feeds = feeds.size;
  };

  // A path of the coin's curve per candidate (for the brain's replays and the charts): every change, thinned
  // with time (4 a second for the first 20 s, 1 a second to 2 min, then 1 per 5 s), at most 500 points.
  const record = (c, st, at) => {
    const t = at - c.hisMs, last = c.path[c.path.length - 1], gap = t < 20_000 ? 250 : t < 120_000 ? 1000 : 5000;
    const row = [t, Number(st.vSol), Number(st.vTok)];
    if (!last) { c.path.push(row); return; }
    if (row[1] === last[1] && row[2] === last[2]) return;
    if (t - last[0] < gap && c.path.length > 1) { c.path[c.path.length - 1] = row; return; } // keep the newest in its slot
    if (c.path.length < 500) c.path.push(row); else c.path[c.path.length - 1] = row;
  };
  const observe = (c, st, at) => {
    record(c, st, at);
    const spend = c.sizeSol * 0.995, px = buyPriceNow(st, spend, feeOf(st));
    if (fin(px)) { c.high = Math.max(c.high || 0, px); c.low = c.low == null ? px : Math.min(c.low, px); if (c.firstPx == null) c.firstPx = px; }
    const m = mcapUsd(st, c.solUsd); if (fin(m)) { if (c.mcapSeen == null) c.mcapSeen = m; if (m > (c.mcapPeak || 0)) { c.mcapPeak = m; c.mcapPeakMs = at - c.hisMs; } c.mcapLast = m; }
    if (c.hisMcapUsd == null && fin(m) && at - c.hisMs < 3000) { c.hisMcapUsd = m; c.mcapApprox = true; }
    // DIP traders waiting for their dip
    for (const v of variants.values()) {
      const d = c.decisions[v.id];
      if (d?.status !== 'armed' || !fin(px)) continue;
      if (at > c.hisMs + v.p.dipWindowSec * 1000) continue; // the window timer closes it
      if (dipTriggered(v.p, { buyPx: px, P: c.P, high: c.high })) { d.triggeredAt = at; d.triggerPx = px; tryBuy(v, c, d, 'dip'); }
    }
  };

  // ---------- holder snapshots ----------
  /** Every holder of the coin (Helius DAS, up to 4000 token accounts) at the current price: the money held by
   *  everyone except the curve/pool and the dev, how many hold it, the dev's and the top holders' shares. */
  const holderSnap = async (c) => {
    const t0 = now(), f = feedFor(c.mint);
    const pages = async () => { const rows = []; for (let page = 1; page <= 4; page++) { const list = (await call('getTokenAccounts', { mint: c.mint, limit: 1000, page }, 4000))?.token_accounts || []; rows.push(...list); if (list.length < 1000) return { rows, partial: false }; } return { rows, partial: true }; };
    const [st, { rows, partial }] = await Promise.all([stateNow(f), pages()]);
    if (!st) return { status: 'failed', why: 'no price', ms: now() - t0 };
    const mcap = mcapUsd(st, c.solUsd ?? solUsd());
    if (!fin(mcap)) return { status: 'failed', why: 'no SOL price', ms: now() - t0 };
    const usdPerRaw = mcap / 1e15, dev = creatorOf(c.mint) || null, curveOwner = st.pumpswap ? (st.pool || null) : curvePda(c.mint);
    const by = new Map(); let devRaw = 0, curveRaw = 0, othersRaw = 0;
    for (const a of rows) {
      const amt = Number(a.amount) || 0; if (!(amt > 0) || !a.owner) continue;
      if (curveOwner && a.owner === curveOwner) { curveRaw += amt; continue; }
      if (dev && a.owner === dev) { devRaw += amt; continue; }
      othersRaw += amt; by.set(a.owner, (by.get(a.owner) || 0) + amt);
    }
    const amounts = [...by.values()].sort((a, b) => b - a), usd = amounts.map((x) => x * usdPerRaw);
    if (partial) othersRaw = Math.max(othersRaw, 1e15 - curveRaw - devRaw);
    const top = (n) => amounts.slice(0, n).reduce((a, x) => a + x, 0);
    const mid = usd.length ? (usd.length % 2 ? usd[usd.length >> 1] : (usd[usd.length / 2 - 1] + usd[usd.length / 2]) / 2) : null;
    return {
      status: 'done', at: now(), ms: now() - t0, sec: Math.round((now() - c.hisMs) / 100) / 10, venue: st.pumpswap ? 'pumpswap' : 'curve', partial,
      holders: by.size, heldUsd: othersRaw * usdPerRaw, devUsd: devRaw * usdPerRaw, devPct: devRaw / 1e15, devKnown: !!dev, mcapUsd: mcap,
      top1Pct: top(1) / 1e15, top10Pct: top(10) / 1e15, top10Share: othersRaw > 0 ? top(10) / othersRaw : null,
      n10: usd.filter((x) => x >= 10).length, n100: usd.filter((x) => x >= 100).length, n1000: usd.filter((x) => x >= 1000).length, medianUsd: mid,
    };
  };
  const takeHolders = (c, slot) => {
    const f = feedFor(c.mint); f.holders++;
    const run = async () => {
      let snap;
      try { snap = await holderSnap(c); } catch (e) { snap = { status: 'failed', why: String(e?.message || e).slice(0, 120) }; }
      f.holders--; if (!f.cands.size) releaseFeed(c.mint);
      if (slot === 0) {
        if (snap.status === 'done') snap.verdict = holderCheck(snap.heldUsd, snap.mcapUsd, holderRules, relax.on ? holderCal.k : 1);
        c.holder0 = snap; c.holderArrivedAt = now(); onFacts(c);
      } else c[`holder${slot}`] = snap;
      maybeFinish(c);
    };
    if (slot === 0) run(); else later(c.hisMs + slot * 1000 - now(), run);
  };

  // ---------- buyers already ahead when the bot decided ----------
  // One getSignaturesForAddress on the coin's curve (or pool) ~3 s after his buy, kept only up to the block the bot
  // was on when it decided; then each of those transactions is read (at most crowdMaxTx) to tell buys from sells.
  let txBusy = 0; const txWait = [];
  const txSlot = () => (txBusy < 2 ? (txBusy++, Promise.resolve()) : new Promise((r) => txWait.push(r)));
  const txFree = () => { const n = txWait.shift(); if (n) n(); else txBusy--; };
  const countAhead = async (c) => {
    const acct = c.venue === 'pumpswap' ? (feeds.get(c.mint)?.state?.pool || (await k.graduatedPool?.(c.mint).catch(() => null))) : curvePda(c.mint);
    if (!acct) throw new Error('no curve or pool');
    const list = (await call('getSignaturesForAddress', [acct, { until: c.sig, limit: 100, commitment: 'confirmed' }], 4000)) || [];
    const cut = fin(c.decisionSlot) ? c.decisionSlot : null;
    const ahead = list.filter((x) => !x.err && x.signature !== c.sig && (cut == null || x.slot <= cut) && (!fin(c.hisSlot) || x.slot >= c.hisSlot)).reverse(); // oldest first
    let buys = 0, sells = 0, classified = 0;
    if (c.venue !== 'pumpswap' && k.b58encode) {
      for (const x of ahead.slice(0, crowdMaxTx)) {
        await txSlot();
        try {
          const tx = await call('getTransaction', [x.signature, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }], 4000);
          const evs = tradeEventsFromLogs(tx?.meta?.logMessages, k.b58encode).filter((e) => e.mint === c.mint && e.user !== leader);
          if (evs.length) { classified++; if (evs.some((e) => e.isBuy)) buys++; else sells++; } else classified++;
        } finally { txFree(); }
      }
    }
    const exact = c.venue !== 'pumpswap' && classified === ahead.length;
    return { status: 'done', tradesAhead: ahead.length, buysAhead: exact ? buys : c.venue === 'pumpswap' ? (ahead.length <= 0 ? 0 : null) : (buys + (ahead.length - classified)), sellsAhead: sells, classified, exact, cutSlot: cut, capped: list.length >= 100, at: now() };
  };
  const verifyCrowd = (c) => {
    // counted only while some trader still needs it (saves the reads on buys every trader already rejected)
    const needed = [...variants.values()].some((v) => v.filters && v.p.maxBuysAhead != null && !entryChecks({ ...c, crowd: { status: 'done', buysAhead: 0 }, holder0: { status: 'done', verdict: { safe: true, relaxedPass: true } } }, v.p).fails.length);
    if (!needed) { c.crowd = { status: 'skipped' }; return; }
    later(Math.max(0, c.hisMs + crowdDelayMs - now()), async () => {
      let r = null;
      for (let i = 0; i < 2 && !r; i++) { try { r = await countAhead(c); } catch (e) { if (i === 0) await new Promise((res) => { later(2000, res); }); else r = { status: 'failed', why: String(e?.message || e).slice(0, 120) }; } }
      // a pool trade can't be told apart here: more trades than allowed means "can't prove it", not "fine"
      if (r.status === 'done' && r.buysAhead == null) r = { ...r, status: 'failed', why: 'PumpSwap trades not classified' };
      c.crowd = r; onFacts(c); maybeFinish(c);
    });
  };

  // ---------- decisions ----------
  const reasonText = (keys) => keys.map((x) => CHECK_NAMES[x] || x).join(', ');
  const skip = (v, c, d, keys, extra = {}) => { d.status = 'skipped'; d.fails = keys; d.missing = keys.length > 0 && keys.every(isMissing); d.at = now(); Object.assign(d, extra); maybeFinish(c); };
  const decide = (v, c) => {
    const d = c.decisions[v.id] || (c.decisions[v.id] = { status: 'checking', fails: [] });
    if (d.status !== 'checking' && d.status !== 'waiting' && d.status !== 'armed') return;
    if (d.status === 'checking' && (v.open.has(c.mint) || v.inflight.has(c.mint))) return skip(v, c, d, ['holding']);
    const { fails, pending } = entryChecks(c, v.p, { filters: v.filters });
    if (fails.length) return skip(v, c, d, fails);
    if (!fin(c.P)) return skip(v, c, d, ['data:price']);
    if (v.p.kind === 'fcat') {
      if (pending.includes('holder')) { // the holder check comes first (a live bot waits too), at most holderWaitMs
        if (d.status !== 'waiting') { d.status = 'waiting'; later(holderWaitMs, () => { if (d.status === 'waiting') skip(v, c, d, ['data:holder'], { late: true }); }); }
        return;
      }
      return tryBuy(v, c, d, 'fcat');
    }
    if (d.status !== 'armed') { d.status = 'armed'; d.armedAt = now(); later(c.hisMs + v.p.dipWindowSec * 1000 - now(), () => { if (d.status === 'armed') skip(v, c, d, ['no-dip']); }); }
    const f = feeds.get(c.mint); if (f?.state) observe(c, f.state, now()); // already at the trigger?
  };
  const onFacts = (c) => {
    for (const v of variants.values()) {
      const d = c.decisions[v.id];
      if (!d) continue;
      if (['checking', 'waiting', 'armed'].includes(d.status)) decide(v, c);
      else if (d.status === 'bought' || d.status === 'sending') verify(v, c, d);
      if (d.status === 'armed' && d.triggeredAt && !d.sentAt) tryBuy(v, c, d, 'dip'); // triggered while the holder check was out
    }
    if (c.crowd?.status && c.holder0?.status && !c.calibrated) addCalibrationSample(c);
  };
  /** A provisional trade becomes final when the buyers-ahead count is in and passes; else it is voided. */
  const verify = (v, c, d) => {
    if (!v.filters || d.final) return;
    const { fails, pending } = entryChecks(c, v.p, { filters: true });
    if (pending.length) return;
    if (fails.length) { voidTrade(v, c, d, fails); return; }
    d.final = true;
    const t = v.trades.find((x) => x.id === d.tradeId && x.provisional);
    if (t) { t.provisional = false; append({ t: 'trade', ...t }); afterTrade(v, t); }
    const pos = d.tradeId ? [...v.open.values()].find((p) => p.id === d.tradeId) : null; if (pos) { pos.provisional = false; save(); }
  };
  const voidTrade = (v, c, d, fails) => {
    const pos = [...v.open.values()].find((p) => p.id === d.tradeId), infl = v.inflight.get(c.mint);
    if (pos) { v.open.delete(pos.mint); v.held.delete(pos.mint); if (v.balance != null) v.balance += pos.cost; maybeRelease(pos.mint); }
    if (infl?.candId === c.id) { v.inflight.delete(c.mint); if (v.balance != null && infl.reserved) v.balance += infl.reserved; infl.void = true; }
    const i = v.trades.findIndex((x) => x.id === d.tradeId && x.provisional);
    if (i >= 0) { const t = v.trades[i]; v.trades.splice(i, 1); if (v.balance != null) v.balance += t.cost - t.proceeds; }
    d.voided = true; status.voided++;
    skip(v, c, d, fails, { voidedAfter: d.status });
    save();
  };
  const tryBuy = (v, c, d, why) => {
    if (d.sentAt || stopped) return;
    const { fails, pending } = entryChecks(c, v.p, { filters: v.filters });
    if (fails.length) return skip(v, c, d, fails);
    if (pending.includes('holder')) return; // sent once the holder check is in
    if (v.open.has(c.mint) || v.inflight.has(c.mint)) return skip(v, c, d, ['holding']);
    const fee = sideFee(), need = v.p.sizeSol + fee;
    if (v.balance != null && v.balance < need) return skip(v, c, d, ['balance']);
    d.status = 'sending'; d.sentAt = now(); d.why = why;
    if (v.balance != null) v.balance -= need;
    const inf = { candId: c.id, reserved: v.balance != null ? need : 0, fee, sentAt: d.sentAt };
    v.inflight.set(c.mint, inf);
    later(landMs, () => fill(v, c, d, inf));
  };
  const fill = async (v, c, d, inf) => {
    if (inf.void || v.inflight.get(c.mint) !== inf) return;
    const f = feedFor(c.mint), st = await stateNow(f);
    v.inflight.delete(c.mint);
    if (inf.void) return;
    const refund = () => { if (v.balance != null) v.balance += inf.reserved; };
    if (!st) { refund(); return skip(v, c, d, ['data:price']); }
    const fee = feeOf(st), spend = v.p.sizeSol * 0.995, raw = buyRaw(st, spend, fee), entry = netPrice(spend, raw, fee), premium = fin(entry) ? entry / c.P - 1 : null;
    if (!(raw > 0) || !fin(premium)) { refund(); return skip(v, c, d, ['data:price']); }
    if (v.filters && premium > v.p.maxPayPct / 100) { refund(); return skip(v, c, d, ['pay'], { premium }); }
    const pos = {
      id: `${v.id}:${c.id}`, variant: v.id, version: v.version, mint: c.mint, sym: c.sym || null, candId: c.id, P: c.P, raw, cost: v.p.sizeSol + inf.fee, entry, premium,
      sentAt: d.sentAt, fillAt: now(), venue: st.pumpswap ? 'pumpswap' : 'curve', why: d.why, triggerPx: d.triggerPx ?? null, peak: null, worst: null, peakAt: null,
      provisional: v.filters && !!entryChecks(c, v.p, { filters: true }).pending.length, his: { usd: c.hisUsd, mcap: c.hisMcapUsd, sec: c.secAtSeen, blocks: c.blocksAtSeen },
    };
    v.open.set(c.mint, pos); v.held.add(c.mint); f.holders++;
    d.status = 'bought'; d.tradeId = pos.id; d.premium = premium; d.fillAt = pos.fillAt; d.final = !pos.provisional;
    save();
    if (c.hisSell && c.hisSell.at <= now()) return exitNow(v, pos, 'his-sell');
    checkExit(v, pos, st);
    if (!pos.provisional) maybeFinish(c); else verify(v, c, d);
  };

  // ---------- exits ----------
  const checkExit = (v, pos, st) => {
    if (pos.exiting) return;
    const fee = feeOf(st), value = sellSol(st, pos.raw, fee), pnl = markPnl(value, pos.cost, sideFee()), t = now();
    if (fin(pnl)) { if (pos.peak == null || pnl > pos.peak) { pos.peak = pnl; pos.peakAt = t - pos.fillAt; } if (pos.worst == null || pnl < pos.worst) pos.worst = pnl; pos.last = pnl; pos.lastAt = t; }
    const e = exitCheck(v.p, pos, { now: t, pnl, sellPx: sellPriceNow(st, pos.raw, fee) });
    if (e) exitNow(v, pos, e.rule, e.pnl);
  };
  const exitNow = (v, pos, rule, triggerPnl = null) => {
    if (pos.exiting) return;
    pos.exiting = { rule, at: now(), triggerPnl };
    later(landMs, async () => {
      const f = feedFor(pos.mint), st = await stateNow(f);
      const proceeds = st ? sellSol(st, pos.raw, feeOf(st)) * 0.995 - sideFee() : (fin(pos.last) ? pos.last * pos.cost + pos.cost : 0); // no price at all: the last known value
      closeTrade(v, pos, proceeds, !st);
    });
  };
  const closeTrade = (v, pos, proceeds, blind) => {
    if (v.open.get(pos.mint) !== pos) return; // voided meanwhile
    v.open.delete(pos.mint); v.held.delete(pos.mint);
    const f = feeds.get(pos.mint); if (f) f.holders--;
    if (v.balance != null) v.balance += proceeds;
    const c = cands.get(pos.candId);
    const t = {
      id: pos.id, variant: v.id, strategy: v.strategy, version: pos.version, mint: pos.mint, sym: pos.sym || c?.sym || null, candId: pos.candId,
      hisTime: c ? Math.round(c.hisMs / 1000) : null, sentAt: pos.sentAt, fillAt: pos.fillAt, exitAt: pos.exiting.at, closedAt: now(), exit: pos.exiting.rule, blind: !!blind,
      cost: pos.cost, proceeds, pnlSol: proceeds - pos.cost, ret: (proceeds - pos.cost) / pos.cost, triggerPnl: pos.exiting.triggerPnl, peak: pos.peak, worst: pos.worst, peakAtSec: pos.peakAt != null ? Math.round(pos.peakAt / 100) / 10 : null,
      holdSec: Math.round((now() - pos.fillAt) / 100) / 10, entry: pos.entry, premium: pos.premium, P: pos.P, venue: pos.venue, why: pos.why,
      his: pos.his, provisional: !!pos.provisional, solUsd: c?.solUsd ?? solUsd(), day: dayKey(now(), timezone),
    };
    v.trades.push(t); if (v.trades.length > 20000) v.trades.shift();
    if (!t.provisional) { append({ t: 'trade', ...t }); afterTrade(v, t); }
    maybeRelease(pos.mint); save();
    if (c) maybeFinish(c);
  };
  const afterTrade = (v, t) => {
    if (v.role === 'main' && notify) { try { notify(t, v); } catch {} }
    brains[v.strategy]?.onTrade(t);
  };
  const maybeRelease = (mint) => { const f = feeds.get(mint); if (f && !f.cands.size && f.holders <= 0) releaseFeed(mint); };

  // ---------- his sells ----------
  const onLeaderSell = (s, ctx = {}) => {
    try {
      if (!s?.mint || s.side !== 'sell' || stopped) return;
      const at = now();
      for (const c of cands.values()) if (c.mint === s.mint && !c.hisSell && at >= c.hisMs) c.hisSell = { at, sec: Math.round((at - c.hisMs) / 100) / 10, sig: s.sig || null, sol: s.sol ?? null, source: ctx.source || null };
      for (const v of variants.values()) {
        const pos = v.open.get(s.mint);
        if (pos && v.p.sellOnHisSell !== false) exitNow(v, pos, 'his-sell');
        for (const c of cands.values()) { const d = c.decisions[v.id]; if (c.mint === s.mint && d?.status === 'armed') skip(v, c, d, ['his-sold']); }
      }
    } catch (e) { fault('his sell', e); }
  };
  // A missed sell of his (no time exit exists) is caught here: once a minute, for each coin a trader has held
  // for over a minute, his token balance is read; if it fell, he sold.
  const balanceCheck = async () => {
    if (!powered || !leader) return;
    const mints = new Set(); for (const v of variants.values()) for (const p of v.open.values()) if (now() - p.fillAt > 60_000 && !p.exiting) mints.add(p.mint);
    let n = 0;
    for (const mint of mints) {
      if (++n > 20) break;
      try {
        const r = await call('getTokenAccountsByOwner', [leader, { mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }], 4000);
        const amt = (r?.value || []).reduce((a, x) => a + Number(x.account?.data?.parsed?.info?.tokenAmount?.amount || 0), 0);
        const c = [...cands.values(), ...done].find((x) => x.mint === mint);
        const had = c?.hisRaw || 0;
        if (amt === 0 || (had > 0 && amt < had * 0.5)) { onLeaderSell({ mint, side: 'sell', sig: null }, { source: 'balance check' }); for (const v of variants.values()) { const p = v.open.get(mint); if (p?.exiting?.rule === 'his-sell') p.exiting.rule = 'his-sell-late'; } }
      } catch {}
    }
  };
  const balanceTimer = setInterval(() => { balanceCheck().catch((e) => fault('balance check', e)); }, 60_000); balanceTimer.unref?.();

  // ---------- his buys ----------
  const onLeaderBuy = (s, ctx = {}) => {
    try {
      if (!s?.mint || !s.sig || s.side !== 'buy' || s.pump === false || stopped) return;
      const id = `${s.sig}:${s.mint}`, have = cands.get(id);
      if (!have && fin(s.usd) && s.usd < minUsd) return; // his few-dollar test buys are not trades
      const trade = ctx.trade && ctx.trade.mint === s.mint && ctx.trade.solAmount != null ? ctx.trade : null;
      if (have) { // a later arrival of the same trade: fill in what the first one lacked
        if (!have.hisTimeExact && ctx.source !== 'pumpportal' && fin(s.time)) { have.hisTimeOnChain = s.time; }
        if (have.hisSlot == null && fin(ctx.hisSlot)) have.hisSlot = ctx.hisSlot;
        if (ctx.gross && fin(s.sol)) have.grossSol = s.sol;
        if (have.priceBasis !== 'net' && trade) { have.P = Number(trade.solAmount) / 1e9 / Number(trade.tokenAmount); have.priceBasis = 'net'; }
        return;
      }
      const seenAt = fin(ctx.seenAt) ? ctx.seenAt : now(), u = solUsd() ?? (fin(s.usd) && s.sol > 0 ? s.usd / s.sol : null);
      const exactTime = ctx.source !== 'pumpportal' && fin(s.time);
      const hisMs = exactTime ? s.time * 1000 : seenAt;
      // Decu's price on the trade event's basis (SOL into the curve, fees excluded), the same as our fills
      let P = null, basis = 'gross', hisSol = s.sol, hisRaw = Number(s.raw) || 0;
      if (trade) { hisSol = Number(trade.solAmount) / 1e9; hisRaw = Number(trade.tokenAmount); basis = 'net'; }
      else if (s.fast && ctx.source === 'ws') basis = 'net';
      if (hisSol > 0 && hisRaw > 0) P = hisSol / hisRaw;
      const vSol = s.vSol ?? trade?.vSol ?? null, vTok = s.vTok ?? trade?.vTok ?? null;
      const c = {
        id, mint: s.mint, sig: s.sig, source: ctx.source || null, sym: null, sizeSol: DEFAULTS.fcat.sizeSol,
        hisMs, hisTimeExact: exactTime, hisSlot: fin(ctx.hisSlot) ? ctx.hisSlot : null, seenAt, seenSlot: fin(ctx.seenSlot) ? ctx.seenSlot : null,
        hisSol, hisRaw, P, priceBasis: basis, grossSol: ctx.gross ? s.sol : null, solUsd: u, hisUsd: fin(u) ? hisSol * u : (fin(s.usd) ? s.usd : null),
        hisMcapUsd: vSol != null && vTok != null && fin(u) ? mcapUsd({ vSol, vTok }, u) : null, mcapApprox: false, venue: s.pump === false ? 'other' : vSol != null ? 'curve' : 'unknown',
        secAtSeen: Math.max(0, Math.round((seenAt - hisMs) / 100) / 10), blocksAtSeen: fin(ctx.seenSlot) && fin(ctx.hisSlot) ? Math.max(0, ctx.seenSlot - ctx.hisSlot) : null,
        crowd: { status: 'pending' }, holder0: { status: 'pending' }, holder60: null, path: [], high: null, low: null, firstPx: null, hisSell: null, decisions: {}, createdAt: now(), finished: false,
      };
      c.decisionSlot = c.seenSlot ?? (fin(c.hisSlot) ? c.hisSlot + Math.max(0, Math.round((seenAt - hisMs) / 400)) : null);
      if (!exactTime) c.secAtSeen = null; // PumpPortal's time is when it reached us, not his on-chain time
      cands.set(id, c); status.candidates++;
      const f = feedFor(c.mint); f.cands.add(c);
      if (f.state?.pumpswap) c.venue = 'pumpswap';
      if (k.tokenMeta) k.tokenMeta(c.mint).then((m) => { c.sym = m?.symbol || m?.metadata?.symbol || c.sym; }).catch(() => {});
      for (const sec of holderSnapSec) takeHolders(c, sec);
      verifyCrowd(c);
      for (const v of variants.values()) decide(v, c);
      later(Math.max(...[...variants.values()].map((v) => (v.p.dipWindowSec || 0) * 1000), Math.max(...holderSnapSec) * 1000 + graceMs) + padMs + c.hisMs - now(), () => { c.windowOver = true; maybeFinish(c); });
      if (cands.size > 600) for (const [cid, old] of cands) { if (cands.size <= 500) break; if (old.finished) cands.delete(cid); }
    } catch (e) { fault('his buy', e); }
  };

  // A candidate is written to the journal once every trader has decided, the windows are over, and every trade
  // it opened is closed (its price path then covers the exits too).
  const maybeFinish = (c) => {
    if (c.finished || !c.windowOver) return;
    const ds = [...variants.values()].map((v) => c.decisions[v.id]).filter(Boolean);
    if (ds.some((d) => ['checking', 'waiting', 'armed', 'sending'].includes(d.status))) return;
    if (c.crowd?.status === 'pending' || c.holder0?.status === 'pending') return;
    const openHere = [...variants.values()].some((v) => { const p = v.open.get(c.mint); return p && p.candId === c.id; });
    if (openHere && now() - c.hisMs < 6 * 3600e3) return;
    c.finished = true; c.finishedAt = now();
    const f = feeds.get(c.mint); if (f) { f.cands.delete(c); maybeRelease(c.mint); }
    const rec = candRecord(c); append({ t: 'cand', ...rec }); done.push(rec); if (done.length > maxCands) done.shift();
    cands.delete(c.id);
    brains.dip?.onCandidate(rec); brains.fcat?.onCandidate(rec);
  };
  const candRecord = (c) => ({
    id: c.id, mint: c.mint, sym: c.sym, sig: c.sig, source: c.source, hisTime: Math.round(c.hisMs) / 1000, hisTimeExact: c.hisTimeExact, hisSlot: c.hisSlot, seenAt: c.seenAt, seenSlot: c.seenSlot, decisionSlot: c.decisionSlot,
    secAtSeen: c.secAtSeen, blocksAtSeen: c.blocksAtSeen, hisSol: c.hisSol, hisRaw: c.hisRaw, P: c.P, priceBasis: c.priceBasis, grossSol: c.grossSol, solUsd: c.solUsd, hisUsd: c.hisUsd,
    hisMcapUsd: c.hisMcapUsd, mcapApprox: c.mcapApprox, mcapSeen: c.mcapSeen ?? null, mcapPeak: c.mcapPeak ?? null, mcapPeakSec: c.mcapPeakMs != null ? Math.round(c.mcapPeakMs / 100) / 10 : null, mcapLast: c.mcapLast ?? null, venue: c.venue,
    crowd: c.crowd, holder0: c.holder0, holder60: c.holder60, hisSell: c.hisSell, high: c.high, low: c.low, firstPx: c.firstPx, path: c.path,
    decisions: Object.fromEntries(Object.entries(c.decisions).map(([vid, d]) => [vid, { status: d.status, fails: d.fails || [], missing: !!d.missing, tradeId: d.tradeId || null, premium: d.premium ?? null, triggeredSec: d.triggeredAt ? Math.round((d.triggeredAt - c.hisMs) / 100) / 10 : null, sentSec: d.sentAt ? Math.round((d.sentAt - c.hisMs) / 100) / 10 : null, voided: !!d.voided }])),
    k: c.holder0?.verdict?.k ?? null, day: dayKey(c.hisMs, timezone),
  });
  const addCalibrationSample = (c) => {
    c.calibrated = true;
    const h = c.holder0, main = variants.get('fcat')?.p || DEFAULTS.fcat;
    if (h?.status !== 'done') { holderCal.missing = (holderCal.missing || 0) + 1; return; }
    // "otherwise eligible": passes your $ / market cap / timing checks (the buyers-ahead rule is left out so the
    // experiment has enough coins to measure; it is reported with and without it)
    const { fails } = entryChecks({ ...c, crowd: { status: 'done', buysAhead: 0 }, holder0: { status: 'done', verdict: { safe: true, relaxedPass: true } } }, main);
    if (fails.length) return;
    holderCal.samples.push({ heldUsd: h.heldUsd, mcapUsd: h.mcapUsd, crowdOk: c.crowd?.status === 'done' && c.crowd.buysAhead <= main.maxBuysAhead, id: c.id, at: c.hisMs });
    if (holderCal.samples.length > 1000) holderCal.samples.shift();
    if (++holderCal.since >= (relax.every || 5)) { holderCal.since = 0; recalibrate(); }
    save();
  };

  // ---------- brains ----------
  const brains = {};
  const brainApi = {
    variants: () => [...variants.values()], candidates: () => [...done, ...[...cands.values()].map(candRecord)], tradesOf: (id) => variants.get(id)?.trades.filter((t) => !t.provisional) || [],
    addVariant: (def) => { if (variants.has(def.id)) return variants.get(def.id); const v = newVariant({ ...def, createdAt: now() }); variants.set(def.id, v); save(); return v; },
    removeVariant: (id) => { const v = variants.get(id); if (!v || v.role === 'main' || v.role === 'unfiltered' || v.open.size) return false; variants.delete(id); save(); return true; },
    adopt: (strategy, p, why) => { const v = variants.get(strategy); if (!v) return null; const from = { ...v.p }; v.p = { ...v.p, ...p }; v.version++; append({ t: 'adopt', strategy, version: v.version, from, to: v.p, why, at: new Date(now()).toISOString() }); save(); return v.version; },
    holderCal: () => holderCal, fee: () => poolFee, sideFee, landMs, now, autoTune, mode,
  };
  brains.dip = createDuelBrain({ strategy: 'dip', api: brainApi, notes, log });
  brains.fcat = createDuelBrain({ strategy: 'fcat', api: brainApi, notes, log });
  const brainTimer = setInterval(() => { for (const b of Object.values(brains)) { try { b.cycle(); } catch (e) { fault('brain', e); } } save(); }, Math.max(1, brainEveryMin) * 60e3); brainTimer.unref?.();

  // ---------- startup: the journal (results, candidates, calibration) and the saved state ----------
  try {
    let saved = null; try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    if (saved?.variants) for (const sv of saved.variants) {
      const v = variants.get(sv.id) || (sv.role === 'challenger' ? newVariant(sv) : null);
      if (!v) continue;
      v.p = { ...v.p, ...sv.p }; v.version = sv.version || v.version; v.createdAt = sv.createdAt || v.createdAt; v.diff = sv.diff || v.diff; v.parent = sv.parent || v.parent;
      if (v.balance != null && fin(sv.balance)) v.balance = sv.balance;
      for (const p of sv.open || []) { if (p.provisional) { if (v.balance != null) v.balance += p.cost; continue; } delete p.exiting; v.open.set(p.mint, p); v.held.add(p.mint); }
      variants.set(v.id, v);
    }
    if (saved?.holderCal) holderCal = { ...holderCal, ...saved.holderCal, kMin };
    if (saved?.brains) for (const [s, b] of Object.entries(saved.brains)) brains[s]?.load(b);
    let lines = []; try { lines = fs.readFileSync(journalFile, 'utf8').split('\n'); } catch {}
    for (const l of lines) {
      if (!l) continue; let x; try { x = JSON.parse(l); } catch { continue; }
      if (x.t === 'trade') { const v = variants.get(x.variant); if (v && !v.trades.some((t) => t.id === x.id)) v.trades.push(x); }
      else if (x.t === 'cand') { done.push(x); if (done.length > maxCands) done.shift(); }
    }
    for (const b of Object.values(brains)) b.rebuild();
  } catch (e) { fault('startup', e); }
  // positions still open from before a restart: watched again (their peak is unknown)
  const rewatch = () => { for (const v of variants.values()) for (const p of v.open.values()) { const f = feedFor(p.mint); f.holders++; } };
  rewatch();

  // ---------- Obsidian notes (machine/DIP vs FCAT/ in the second-brain vault; pushed with its own GitHub sync) ----------
  const unsynced = new Set(); let syncing = false, notesWritten = false;
  const writeNotes = () => {
    if (!notes?.vault || stopped) return;
    const a = api(), files = {
      [notePaths.home]: homeNote(a), [notePaths.brain('dip')]: brainNote(a.brains.dip), [notePaths.brain('fcat')]: brainNote(a.brains.fcat),
      [notePaths.holder]: holderNote(a.holderRule), [notePaths.dips]: dipsNote(a.variants.filter((v) => v.strategy === 'dip' && (v.role === 'main' || v.role === 'analytics'))), [notePaths.holders]: holdersNote(a.holders),
    };
    const recentDays = new Set([0, 1, 2].map((i) => dayKey(now() - i * 86400e3, timezone)));
    for (const s of ['dip', 'fcat']) {
      const byDay = {}; for (const t of variants.get(s).trades) if (!t.provisional) (byDay[t.day] ||= []).push(t);
      for (const [d, list] of Object.entries(byDay)) if (!notesWritten || recentDays.has(d)) files[notePaths.day(s, d)] = dayNote(s, d, list);
    }
    for (const p of notes.vault.sync(files)) unsynced.add(p);
    notesWritten = true;
  };
  const pushNotes = async () => {
    if (!notes?.gitSync || syncing || !unsynced.size || stopped) return null;
    syncing = true; const paths = [...unsynced]; unsynced.clear();
    try {
      const files = paths.map((p) => { try { return { name: p, data: notes.vault.read(p) }; } catch { return null; } }).filter(Boolean);
      const r = await notes.gitSync.push(files, `DIP vs FCAT: ${files.length} note${files.length === 1 ? '' : 's'} updated`);
      if (String(r).startsWith('failed')) for (const p of paths) unsynced.add(p);
      return r;
    } finally { syncing = false; }
  };
  const notesTimer = notes?.vault ? setInterval(() => { try { writeNotes(); } catch (e) { fault('notes', e); } pushNotes().catch((e) => fault('notes sync', e)); }, Math.max(1, notes.everyMin || 10) * 60e3) : null; notesTimer?.unref?.();
  if (notes?.vault) later(90_000, () => { writeNotes(); return pushNotes(); });

  // ---------- power, stop, the dashboard ----------
  const power = (on) => {
    powered = !!on;
    if (!on) { for (const f of feeds.values()) { try { f.unwatch?.(); } catch {} f.unwatch = null; } }
    else for (const f of feeds.values()) { if (!f.unwatch && k.watchCurve) { try { f.unwatch = k.watchCurve(f.mint, (curve, at) => { if (feeds.get(f.mint) === f) onState(f, normState(curve, 'push'), at); }); } catch {} } poll(f); }
  };
  const stop = () => {
    if (stopped) return; stopped = true;
    clearInterval(balanceTimer); clearInterval(brainTimer); if (notesTimer) clearInterval(notesTimer);
    for (const t of timers) clearTimeout(t); timers.clear();
    for (const f of feeds.values()) { try { f.unwatch?.(); } catch {} }
    saveNow();
  };

  const liveOf = (v) => [...v.open.values()].map((p) => ({ id: p.id, mint: p.mint, sym: p.sym || cands.get(p.candId)?.sym || null, fillAt: p.fillAt, cost: p.cost, pnl: p.last ?? null, peak: p.peak, entry: p.entry, premium: p.premium, provisional: !!p.provisional, exiting: p.exiting?.rule || null, version: p.version }));
  const daysOf = (trades) => { const out = {}; for (const t of trades) { const d = out[t.day] || (out[t.day] = { sol: 0, usd: 0, n: 0, wins: 0 }); d.sol += t.pnlSol; d.usd += t.pnlSol * (t.solUsd || solUsd() || 0); d.n++; if (t.pnlSol > 0) d.wins++; } return out; };
  const pubVariant = (v) => {
    const trades = v.trades.filter((t) => !t.provisional), s = summarize(trades), open = liveOf(v);
    const openSol = open.reduce((a, p) => a + (fin(p.pnl) ? p.pnl * p.cost : 0), 0);
    return { id: v.id, label: v.label, strategy: v.strategy, role: v.role, filters: v.filters, version: v.version, p: v.p, diff: v.diff, createdAt: v.createdAt, startBalance: v.startBalance, balance: v.balance,
      equity: v.balance != null ? v.balance + open.reduce((a, p) => a + p.cost * (1 + (fin(p.pnl) ? p.pnl : 0)), 0) : null, openSol, open, summary: s, evidence: evidence(trades.map((t) => t.ret)) };
  };
  const api = () => {
    const all = [...done, ...[...cands.values()].map(candRecord)];
    const A = variants.get('dip'), B = variants.get('fcat');
    const byCand = {};
    for (const t of A.trades) if (!t.provisional) (byCand[t.candId] ||= { a: null, b: null }).a = t;
    for (const t of B.trades) if (!t.provisional) (byCand[t.candId] ||= { a: null, b: null }).b = t;
    const h2h = headToHead(byCand), diffs = evidence(h2h.diffs, { minN: 30 });
    const leaderId = summarize(A.trades.filter((t) => !t.provisional)).pnlSol >= summarize(B.trades.filter((t) => !t.provisional)).pnlSol ? 'dip' : 'fcat';
    const active = new Set(cands.keys());
    const recent = all.slice(-200).reverse().map((c) => ({ id: c.id, mint: c.mint, sym: c.sym, hisTime: c.hisTime, hisUsd: c.hisUsd, hisMcapUsd: c.hisMcapUsd, secAtSeen: c.secAtSeen, blocksAtSeen: c.blocksAtSeen, crowd: c.crowd, holder0: c.holder0 && { ...c.holder0 }, holder60: c.holder60, hisSell: c.hisSell, mcapPeak: c.mcapPeak, decisions: c.decisions, finished: !active.has(c.id) }));
    const outcomeOf = (vid, c) => { const d = c.decisions?.[vid]; if (!d?.tradeId) return null; const t = variants.get(vid)?.trades.find((x) => x.id === d.tradeId && !x.provisional); return t ? t.ret : null; };
    const holders = all.filter((c) => c.holder0?.status === 'done').slice(-600).map((c) => ({ t: c.hisTime, mint: c.mint, sym: c.sym, holders: c.holder0.holders, heldUsd: c.holder0.heldUsd, devPct: c.holder0.devPct, top10Pct: c.holder0.top10Pct, top10Share: c.holder0.top10Share, n100: c.holder0.n100, n1000: c.holder0.n1000, medianUsd: c.holder0.medianUsd, mcap: c.holder0.mcapUsd, hisMcap: c.hisMcapUsd, holders60: c.holder60?.holders ?? null, held60: c.holder60?.heldUsd ?? null, safe: c.holder0.verdict?.safe ?? null, relaxed: c.holder0.verdict?.relaxedPass ?? null, required: c.holder0.verdict?.required ?? null, k: c.holder0.verdict?.k ?? null, fcatAll: outcomeOf('fcat-all', c), dipAll: outcomeOf('dip-all', c), fcat: outcomeOf('fcat', c), dip: outcomeOf('dip', c) }));
    return {
      on: true, checkNames: CHECK_NAMES, mode, landMs, sizeSol: DEFAULTS.fcat.sizeSol, solUsd: solUsd(), timezone, now: now(), status: { ...status, feeds: feeds.size, active: cands.size },
      traders: { dip: pubVariant(A), fcat: pubVariant(B) }, leader: leaderId,
      variants: [...variants.values()].map(pubVariant),
      days: { dip: daysOf(A.trades.filter((t) => !t.provisional)), fcat: daysOf(B.trades.filter((t) => !t.provisional)) },
      headToHead: { ...h2h, diffs: undefined, evidence: diffs },
      trades: [...A.trades, ...B.trades].filter((t) => !t.provisional).sort((a, b) => b.closedAt - a.closedAt).slice(0, 300),
      candidates: recent, holders,
      holderRule: holderReport(all),
      brains: { dip: brains.dip.report(), fcat: brains.fcat.report() },
    };
  };
  /** The relaxed holder rule vs your baseline: acceptance, missing data, and what the coins it adds did. */
  const holderReport = (all) => {
    const elig = all.filter((c) => c.holder0 && c.holder0.status !== 'pending');
    const withData = elig.filter((c) => c.holder0.status === 'done' && c.holder0.verdict), missing = elig.length - withData.length;
    const base = withData.filter((c) => c.holder0.verdict.safe), relaxed = withData.filter((c) => c.holder0.verdict.relaxedPass), added = relaxed.filter((c) => !c.holder0.verdict.safe);
    const res = (list, vid) => { const r = list.map((c) => { const d = c.decisions?.[vid]; const t = d?.tradeId ? variants.get(vid)?.trades.find((x) => x.id === d.tradeId && !x.provisional) : null; return t?.ret; }).filter(fin); return { n: r.length, avg: r.length ? r.reduce((a, x) => a + x, 0) / r.length : null, wins: r.filter((x) => x > 0).length }; };
    return { on: relax.on, target: relax.target, floorUsd: relax.floorUsd ?? 500, rules: holderRules, k: holderCal.k, kMin, calibration: holderCal.last, history: holderCal.history.slice(-50), coins: elig.length, withData: withData.length, missing,
      baselineSafe: base.length, relaxedPass: relaxed.length, added: added.length, increase: base.length ? relaxed.length / base.length - 1 : null,
      outcomes: { baselineSafe: res(base, 'fcat-all'), added: res(added, 'fcat-all'), rejected: res(withData.filter((c) => !c.holder0.verdict.relaxedPass), 'fcat-all'), missingData: res(elig.filter((c) => !(c.holder0.status === 'done' && c.holder0.verdict)), 'fcat-all'), baselineSafeDip: res(base, 'dip-all'), addedDip: res(added, 'dip-all') } };
  };

  log(`duel: DIP vs FCAT paper traders on (${variants.size} variants, paper balance ${startBalanceSol} SOL each, land ${landMs} ms, holder rule k=${holderCal.k})`);
  return {
    onLeaderBuy, onLeaderSell, power, stop, api, status: () => ({ ...status, feeds: feeds.size, active: cands.size }),
    openMints: () => new Set([...variants.values()].flatMap((v) => [...v.open.keys()])), brains, variants, writeNotes, pushNotes, notesStatus: () => ({ unsynced: unsynced.size, sync: notes?.gitSync?.status?.() ?? null }), _test: { cands, done, feeds, holderCal, recalibrate },
  };
}
