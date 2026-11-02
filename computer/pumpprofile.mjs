// YOUR PUMP.FUN PROFILE, READ-ONLY. A pump.fun profile is a Solana wallet; its trades are public on-chain.
// This reads that wallet's recent swaps through Solscan (the same decoded history the bot already uses for
// Decu) and summarises them. It never signs, sends, buys or sells anything, and holds no key.
// Cost: one Solscan request per refresh (cached 60 s) plus one per new coin name (names are cached).
import {swapsFromActivities} from './solscan.mjs';

const ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** "https://pump.fun/profile/<address>?tab=..." , "pump.fun/profile/<address>" or a bare address → address, else null. */
export function parseProfile(input) {
  const s = String(input || '').trim();
  if (ADDR.test(s)) return s;
  const m = s.match(/pump\.fun\/(?:profile|user)\/([1-9A-HJ-NP-Za-km-z]{32,44})(?:[/?#]|$)/i);
  return m ? m[1] : null;
}

/** Totals over the last 24 h and 7 days, and per coin (SOL bought vs SOL sold, newest coin first). */
export function summarizeTrades(trades, nowSec = Date.now() / 1000) {
  const win = (sec) => {
    const t = trades.filter((x) => nowSec - x.time <= sec);
    const solIn = t.filter((x) => x.side === 'buy').reduce((a, x) => a + (x.sol || 0), 0);
    const solOut = t.filter((x) => x.side === 'sell').reduce((a, x) => a + (x.sol || 0), 0);
    return { buys: t.filter((x) => x.side === 'buy').length, sells: t.filter((x) => x.side === 'sell').length, solIn, solOut, net: solOut - solIn };
  };
  const coins = new Map();
  for (const x of trades) {
    const c = coins.get(x.mint) || coins.set(x.mint, { mint: x.mint, name: x.name || null, buys: 0, sells: 0, solIn: 0, solOut: 0, last: 0 }).get(x.mint);
    if (x.side === 'buy') { c.buys++; c.solIn += x.sol || 0; } else { c.sells++; c.solOut += x.sol || 0; }
    c.last = Math.max(c.last, x.time || 0); if (!c.name && x.name) c.name = x.name;
  }
  return { day: win(86400), week: win(7 * 86400), coins: [...coins.values()].map((c) => ({ ...c, net: c.solOut - c.solIn })).sort((a, b) => b.last - a.last) };
}

export function createPumpProfile({ activities, tokenMeta = null, solUsd = () => null, now = () => Date.now(), ttlMs = 60_000, minRefreshMs = 15_000, namesPerRefresh = 6 }) {
  if (!activities) return null;
  const cache = new Map(), names = new Map(); let inflight = null;
  async function load(address) {
    const rows = await activities(address, { pageSize: 100 });
    const trades = swapsFromActivities(Array.isArray(rows) ? rows : [], { solUsd: solUsd() }).sort((a, b) => b.time - a.time);
    if (tokenMeta) {
      const want = [...new Set(trades.map((t) => t.mint))].filter((m) => !names.has(m)).slice(0, namesPerRefresh);
      for (const m of want) { try { const meta = await tokenMeta(m); names.set(m, meta?.symbol ? `$${meta.symbol}` : meta?.name || null); } catch { names.set(m, null); } }
      if (names.size > 1000) names.delete(names.keys().next().value);
    }
    const out = trades.map((t) => ({ sig: t.sig, time: t.time, side: t.side, mint: t.mint, name: names.get(t.mint) || null, sol: t.sol, usd: t.usd, quote: t.quote, pump: t.pump }));
    return { address, at: now(), trades: out, summary: summarizeTrades(out, now() / 1000) };
  }
  return {
    async trades(address, { refresh = false } = {}) {
      if (!ADDR.test(address || '')) throw new Error('Not a Solana address');
      const hit = cache.get(address), age = hit ? now() - hit.at : Infinity;
      if (hit && (age < (refresh ? minRefreshMs : ttlMs))) return { ...hit, cached: true };
      if (inflight?.address === address) return inflight.p;
      const p = load(address).then((r) => { cache.clear(); cache.set(address, r); return r; }).finally(() => { if (inflight?.p === p) inflight = null; });
      inflight = { address, p }; return p;
    },
  };
}
