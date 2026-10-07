// Solscan Pro API v2: second, independent view of the chain next to Helius.
// Helius is the execution path (RPC, websocket, Sender). Solscan is used to
//  1. watch the leader independently, so a missed Helius notification is caught and reported,
//  2. cross-check the bot's own trade parser against Solscan's decoded swaps,
//  3. profile how the leader actually trades (ladder buys, hold time, exit speed),
//  4. add token names to alerts and act as a SOL price source.
// Nothing here signs or sends a transaction.

export const SOLSCAN_BASE = 'https://pro-api.solscan.io/v2.0';
// Solscan reports native SOL as the system program id; wrapped SOL is the token mint.
export const SOL_MINTS = new Set(['So11111111111111111111111111111111111111111', 'So11111111111111111111111111111111111111112']);
// Quote assets a pump.fun coin can trade against. pump.fun now also pairs coins with its own PUMP
// token. Checked on Helius 2026-10-07: the leader still pays SOL for those (the route swaps
// SOL→PUMP→coin inside one transaction) and Solscan lists only the PUMP→coin leg.
export const PUMP_TOKEN = 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn';
export const QUOTES = new Map([...[...SOL_MINTS].map((m) => [m, 'SOL']), [PUMP_TOKEN, 'PUMP'], ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'USDC'], ['Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', 'USDT']]);
const PUMP_PROGRAMS = new Set(['6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA']);
const SWAP_TYPES = ['ACTIVITY_TOKEN_SWAP', 'ACTIVITY_AGG_TOKEN_SWAP'];

/** Query string with Solscan's array convention (key[]=a&key[]=b). */
export function solscanQuery(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) for (const x of v) q.append(`${k}[]`, String(x));
    else q.append(k, String(v));
  }
  return q.toString();
}

export function solscanClient({ apiKey, http, base = SOLSCAN_BASE, timeoutMs = 8000 }) {
  const enabled = Boolean(apiKey);
  const get = async (route, params) => {
    if (!enabled) throw new Error('SOLSCAN_API_KEY not set');
    const qs = solscanQuery(params);
    const r = await http(`${base}${route}${qs ? `?${qs}` : ''}`, { headers: { token: apiKey }, timeoutMs });
    if (r?.success === false) throw new Error(`Solscan ${route}: ${r.errors?.message || r.message || 'request failed'}`.slice(0, 200));
    return r?.data ?? r;
  };
  const metaCache = new Map();
  return {
    enabled,
    get,
    lastBlock: async () => (await get('/block/last', { limit: 10 }))?.[0] || null,
    defiActivities: (address, { page = 1, pageSize = 100, fromTime, toTime } = {}) =>
      get('/account/defi/activities', { address, activity_type: SWAP_TYPES, page, page_size: pageSize, sort_by: 'block_time', sort_order: 'desc', from_time: fromTime, to_time: toTime }),
    accountDetail: (address) => get('/account/detail', { address }),
    tokenPrice: async (mint) => {
      const rows = await get('/token/price', { address: mint });
      const p = Number((Array.isArray(rows) ? rows.at(-1) : rows)?.price);
      return p > 0 ? p : null;
    },
    tokenMeta: async (mint) => {
      if (metaCache.has(mint)) return metaCache.get(mint);
      const m = await get('/token/meta', { address: mint });
      const out = { name: m?.name || null, symbol: m?.symbol || null, holders: m?.holder ?? null, priceUsd: m?.price ?? null };
      metaCache.set(mint, out);
      if (metaCache.size > 500) metaCache.delete(metaCache.keys().next().value);
      return out;
    },
  };
}

/**
 * One Solscan swap activity, from the wallet's point of view:
 * {sig, time, slot, side, mint, quote, sol, raw, decimals, usd, pump}.
 * quote is SOL, PUMP, USDC or USDT. For non-SOL quotes, sol is the SOL equivalent of Solscan's
 * USD value (needs solUsd), else null. Returns null for memecoin↔memecoin swaps.
 */
export function swapFromActivity(a, { solUsd } = {}) {
  const r = a?.routers;
  if (!r || !a.trans_id) return null;
  const q1 = QUOTES.get(r.token1), q2 = QUOTES.get(r.token2);
  if (Boolean(q1) === Boolean(q2)) return null; // no quote asset, or quote↔quote: not a coin trade
  const side = q1 ? 'buy' : 'sell', quote = q1 || q2;
  const usd = Number(a.value) || null;
  const sol = quote === 'SOL' ? Number(q1 ? r.amount1 : r.amount2) / 1e9 : usd && solUsd > 0 ? usd / solUsd : null;
  const raw = BigInt(Math.round(Number(q1 ? r.amount2 : r.amount1))).toString();
  return {
    sig: a.trans_id, time: a.block_time, slot: a.block_id, side, quote,
    mint: q1 ? r.token2 : r.token1, decimals: q1 ? r.token2_decimals : r.token1_decimals,
    sol, raw, usd,
    pump: (a.sources || []).some((s) => PUMP_PROGRAMS.has(s)) || (a.platform || []).some((s) => PUMP_PROGRAMS.has(s)),
    platform: a.platform?.[0] || null,
  };
}

/**
 * Solscan lists one row per route leg, so a multi-hop trade shows up as several rows and the row
 * naming a coin can be an intermediate hop. Net all legs of each transaction first: what the
 * wallet ends up holding is the trade. Returns one swap per transaction (newest first kept as given).
 */
export function swapsFromActivities(rows, { solUsd } = {}) {
  const byTx = new Map();
  for (const a of rows || []) if (a?.routers && a.trans_id) (byTx.get(a.trans_id) || byTx.set(a.trans_id, []).get(a.trans_id)).push(a);
  const out = [];
  for (const legs of byTx.values()) {
    if (legs.length === 1) { const s = swapFromActivity(legs[0], { solUsd }); if (s) out.push(s); continue; }
    const net = new Map(), dec = new Map();
    for (const { routers: r } of legs) {
      net.set(r.token1, (net.get(r.token1) || 0n) - BigInt(Math.round(Number(r.amount1)))); dec.set(r.token1, r.token1_decimals);
      net.set(r.token2, (net.get(r.token2) || 0n) + BigInt(Math.round(Number(r.amount2)))); dec.set(r.token2, r.token2_decimals);
    }
    const coins = [...net].filter(([m, d]) => !QUOTES.has(m) && d !== 0n), quotes = [...net].filter(([m, d]) => QUOTES.has(m) && d !== 0n);
    if (coins.length !== 1 || quotes.length < 1) continue;
    const [mint, d] = coins[0], side = d > 0n ? 'buy' : 'sell';
    const solLeg = quotes.find(([m]) => SOL_MINTS.has(m));
    const [qMint, qAmt] = solLeg || quotes[0];
    const a = legs[0], usd = Math.max(...legs.map((x) => Number(x.value) || 0)) || null;
    out.push({
      sig: a.trans_id, time: a.block_time, slot: a.block_id, side, quote: QUOTES.get(qMint), mint, decimals: dec.get(mint),
      sol: solLeg ? Number(qAmt < 0n ? -qAmt : qAmt) / 1e9 : usd && solUsd > 0 ? usd / solUsd : null,
      raw: (d < 0n ? -d : d).toString(), usd,
      pump: legs.some((x) => (x.sources || []).some((p) => PUMP_PROGRAMS.has(p)) || (x.platform || []).some((p) => PUMP_PROGRAMS.has(p))),
      platform: a.platform?.[0] || null, legs: legs.length,
    });
  }
  return out;
}

const median = (xs) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * How the leader trades, from his decoded swaps. A round is one coin from first buy until
 * he has sold what he bought (or a 30-minute pause). For each round: the first buy the bot
 * would copy (usd >= minUsd) and how many seconds he held after it before his first sell.
 * That gap is the copier's whole window.
 */
export function leaderProfile(swaps, { minUsd = 50, roundGapSec = 1800 } = {}) {
  const byMint = new Map();
  for (const s of [...swaps].filter(Boolean).sort((a, b) => a.time - b.time)) {
    const rounds = byMint.get(s.mint) || [];
    let r = rounds.at(-1);
    const flat = r && r.soldRaw >= r.boughtRaw * 0.99 && r.sells > 0;
    if (!r || (s.side === 'buy' && (flat || s.time - r.lastAt > roundGapSec))) rounds.push((r = { mint: s.mint, quote: s.quote, pump: s.pump, buys: 0, sells: 0, buySol: 0, sellSol: 0, boughtRaw: 0, soldRaw: 0, firstAt: s.time, lastAt: s.time, copyAt: null, copyUsd: null, firstSellAt: null, testBuys: 0 }));
    r.lastAt = s.time;
    if (s.side === 'buy') {
      r.buys++; r.buySol += s.sol ?? NaN; r.boughtRaw += Number(s.raw);
      if (r.copyAt === null && (s.usd ?? 0) >= minUsd) { r.copyAt = s.time; r.copyUsd = s.usd; }
      else if (r.copyAt === null) r.testBuys++;
    } else {
      r.sells++; r.sellSol += s.sol ?? NaN; r.soldRaw += Number(s.raw);
      if (r.firstSellAt === null) r.firstSellAt = s.time;
    }
    byMint.set(s.mint, rounds);
  }
  const rounds = [...byMint.values()].flat().filter((r) => r.buys > 0);
  for (const r of rounds) {
    // Sold clearly more than bought: his buys started before the fetched history. Not scored.
    r.partial = r.soldRaw > r.boughtRaw * 1.01;
    r.closed = !r.partial && r.sells > 0 && r.soldRaw >= r.boughtRaw * 0.99;
    r.pnlSol = r.closed && Number.isFinite(r.sellSol - r.buySol) ? r.sellSol - r.buySol : null;
    r.holdSec = r.firstSellAt !== null ? r.firstSellAt - r.firstAt : null;
    r.windowSec = r.copyAt !== null && r.firstSellAt !== null && r.firstSellAt >= r.copyAt ? r.firstSellAt - r.copyAt : null;
  }
  const closed = rounds.filter((r) => r.pnlSol !== null);
  // A round is copyable when one of his buys reached minUsd. PUMP-paired coins count: he pays SOL.
  const copyable = rounds.filter((r) => r.copyAt !== null);
  const quotes = {};
  for (const r of rounds) quotes[r.quote] = (quotes[r.quote] || 0) + 1;
  const windows = copyable.map((r) => r.windowSec).filter((x) => x !== null);
  return {
    swaps: swaps.filter(Boolean).length,
    from: swaps.length ? Math.min(...swaps.filter(Boolean).map((s) => s.time)) : null,
    to: swaps.length ? Math.max(...swaps.filter(Boolean).map((s) => s.time)) : null,
    rounds: rounds.length,
    closedRounds: closed.length,
    partialRounds: rounds.filter((r) => r.partial).length,
    wins: closed.filter((r) => r.pnlSol > 0).length,
    pnlSol: closed.reduce((a, r) => a + r.pnlSol, 0),
    quotes,
    pumpPaired: rounds.filter((r) => r.quote === 'PUMP').length,
    pumpShare: rounds.length ? rounds.filter((r) => r.pump).length / rounds.length : null,
    medianHoldSec: median(rounds.map((r) => r.holdSec)),
    copyableRounds: copyable.length,
    startsWithTestBuy: copyable.filter((r) => r.testBuys > 0).length,
    medianWindowSec: median(windows),
    windowUnder10s: windows.filter((w) => w < 10).length,
    windowUnder30s: windows.filter((w) => w < 30).length,
    roundsDetail: rounds,
  };
}

/**
 * Compare the bot's own detection (Helius transaction + detectBuy/detectSell, via normalize)
 * against Solscan's decoding of the same swap. Returns per-swap verdicts.
 */
export function compareDetection(swap, signals) {
  const match = signals.find((s) => s.side === swap.side && s.mint === swap.mint);
  if (!match) return { sig: swap.sig, ok: false, reason: signals.length ? `bot saw ${signals.map((s) => `${s.side} ${s.mint.slice(0, 6)}`).join(', ')}` : 'bot detected no trade' };
  // The bot measures his whole SOL outlay (network fee, priority fee, tips, account rent);
  // Solscan reports what reached the pool. Measured on 2026-10-07: bot higher by 0.0003–0.042 SOL.
  if (swap.side === 'buy' && swap.quote === 'SOL') {
    const extra = match.sol - swap.sol;
    if (extra < -0.002 || extra > 0.05 + swap.sol * 0.03) return { sig: swap.sig, ok: false, reason: `SOL differs: bot ${match.sol.toFixed(4)} vs Solscan ${swap.sol.toFixed(4)}` };
  }
  if (swap.side === 'buy' && Boolean(match.pump) !== Boolean(swap.pump)) return { sig: swap.sig, ok: false, reason: `pump flag differs: bot ${match.pump} vs Solscan ${swap.pump}` };
  return { sig: swap.sig, ok: true };
}

/**
 * Second watcher on the leader through Solscan. Re-reads the recent window every intervalMs
 * and hands each swap signature to onSignature(sig, 'solscan'). The runtime deduplicates.
 */
export function startSolscanWatcher({ client, leader, intervalMs = 10000, horizonSec = 300, startDelayMs = 15000, onSignature, log = () => {}, status = {} }) {
  if (!client?.enabled || !(intervalMs > 0)) return () => {};
  let stopped = false, timer;
  const poll = async () => {
    if (stopped) return;
    const t0 = Date.now();
    try {
      const rows = await client.defiActivities(leader, { pageSize: 40 });
      const cutoff = Date.now() / 1000 - horizonSec;
      status.solscan = { ok: true, lastPoll: new Date().toISOString(), latencyMs: Date.now() - t0 };
      for (const a of (Array.isArray(rows) ? rows : []).reverse()) if (a.block_time >= cutoff && a.trans_id) onSignature(a.trans_id, 'solscan');
    } catch (e) {
      status.solscan = { ok: false, lastPoll: new Date().toISOString(), error: e.message.slice(0, 160) };
      log('solscan poll error: ' + e.message.slice(0, 160));
    }
    if (!stopped) timer = setTimeout(poll, intervalMs);
  };
  // Start after Helius has replayed its own window, so startup history isn't counted as a gap.
  timer = setTimeout(poll, startDelayMs);
  timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}
