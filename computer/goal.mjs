// THE ROLEX GOAL (ROLEX_GOAL_USD, default $20,000): the realized profit of every position the bot closes, kept
// in one file next to the study journal (Render: /var/data/rolex-goal.json), shared by paper and live so the
// meter survives restarts and the switch to live. LIVE profit fills the watch on the dashboard; PAPER profit is
// the practice meter beside it and never counts toward the Rolex.
// Entry: {mode, mint, symbol, t (closed at), boughtAt, sol (realized SOL, fees in), cost (SOL spent), usd (at the
// SOL price when it closed; null = price unknown then, valued at today's price), rule}.
import fs from 'node:fs';
import { dayKey, pace, eta, pathToGoal } from './dashcalc.mjs';

const keyOf = (e) => `${e.mode}|${e.mint}|${e.t}`;
const r2 = (x) => Math.round(x * 100) / 100;

export function createGoal({ file = null, goalUsd = 20000, name = 'Rolex GMT-Master II', timezone = 'UTC', maxEntries = 20000, log = () => {} } = {}) {
  let d = { version: 1, entries: [], carried: {} };
  if (file) { try { const o = JSON.parse(fs.readFileSync(file, 'utf8')); if (o?.version === 1 && Array.isArray(o.entries)) d = { version: 1, entries: o.entries, carried: o.carried || {} }; } catch { /* first run */ } }
  const keys = new Set(d.entries.map(keyOf));
  let timer = null;
  const save = () => {
    clearTimeout(timer); timer = null;
    if (!file) return;
    try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 }); fs.renameSync(tmp, file); } catch (e) { log(`Rolex goal ledger not saved: ${e.message}`); }
  };
  const saveSoon = () => { if (file && !timer) { timer = setTimeout(save, 2000); timer.unref?.(); } };

  /** One closed position (an entry of the engine's closed-trade ledger). false = already counted. */
  function add(mode, t, solUsd = null, { soon = false } = {}) {
    if (!t?.mint || !Number.isFinite(t.pnlSol) || !['live', 'paper'].includes(mode)) return false;
    const e = { mode, mint: t.mint, symbol: t.symbol || null, t: t.closedAt ?? Date.now(), boughtAt: t.boughtAt ?? null, sol: t.pnlSol, cost: Number.isFinite(t.costSol) ? t.costSol : null, usd: solUsd > 0 ? r2(t.pnlSol * solUsd) : null, rule: t.rule || null };
    const k = keyOf(e);
    if (keys.has(k)) return false;
    keys.add(k); d.entries.push(e);
    // past the limit the oldest entries fold into a carried total per mode: the meter never loses them
    if (d.entries.length > maxEntries) for (const old of d.entries.splice(0, d.entries.length - maxEntries)) {
      const c = (d.carried[old.mode] ||= { sol: 0, usd: 0, n: 0, wins: 0, cost: 0 });
      c.sol += old.sol; c.usd += old.usd ?? 0; c.n++; c.wins += old.sol > 0 ? 1 : 0; c.cost += old.cost || 0; keys.delete(keyOf(old));
    }
    if (soon) saveSoon(); else save();
    return true;
  }
  /** Positions closed before this file existed (or while it was missing): from the engine's own ledger. */
  function seed(mode, closed = [], solUsd = null) {
    let n = 0;
    for (const t of closed || []) if (add(mode, t, solUsd, { soon: true })) n++;
    if (n) save();
    return n;
  }
  function side(mode, solUsd, now, withEntries) {
    const list = d.entries.filter((e) => e.mode === mode), c = d.carried[mode] || { sol: 0, usd: 0, n: 0, wins: 0, cost: 0 };
    const usdOf = (e) => (e.usd != null ? e.usd : solUsd > 0 ? e.sol * solUsd : 0);
    const days = {};
    for (const e of list) { const g = (days[dayKey(e.t, timezone)] ||= { usd: 0, sol: 0, n: 0, wins: 0 }); g.usd += usdOf(e); g.sol += e.sol; g.n++; if (e.sol > 0) g.wins++; }
    for (const g of Object.values(days)) { g.usd = r2(g.usd); g.sol = Math.round(g.sol * 1e6) / 1e6; }
    const usd = c.usd + list.reduce((a, e) => a + usdOf(e), 0), sol = c.sol + list.reduce((a, e) => a + e.sol, 0);
    const n = c.n + list.length, wins = c.wins + list.filter((e) => e.sol > 0).length, remaining = Math.max(0, goalUsd - usd);
    const p7 = pace(days, { now, tz: timezone, windowDays: 7 }), p30 = pace(days, { now, tz: timezone, windowDays: 30 });
    const out = {
      usd: r2(usd), sol, n, wins, winRate: n ? wins / n : null, pct: goalUsd > 0 ? Math.max(0, usd) / goalUsd : 0, remaining: r2(remaining), reached: usd >= goalUsd,
      first: list[0]?.t ?? null, last: list.at(-1)?.t ?? null, days, pace7: p7, pace30: p30, eta7: eta(remaining, p7?.perDay, now), eta30: eta(remaining, p30?.perDay, now),
      path: pathToGoal(list, { remainingUsd: remaining, solUsd, now }), unknownPrice: list.filter((e) => e.usd == null).length,
      best: list.reduce((b, e) => (!b || usdOf(e) > usdOf(b) ? e : b), null),
    };
    if (out.best) out.best = { mint: out.best.mint, symbol: out.best.symbol, t: out.best.t, usd: r2(usdOf(out.best)), sol: out.best.sol };
    if (withEntries) out.entries = list.slice(-1500).map((e) => ({ t: e.t, mint: e.mint, symbol: e.symbol, sol: e.sol, usd: r2(usdOf(e)), cost: e.cost, rule: e.rule }));
    return out;
  }
  /** Everything the Rolex meter and the profit calendar show. open: unrealized result of coins held now (not counted). */
  function summary({ solUsd = null, mode = null, open = null, now = Date.now(), entries = false } = {}) {
    return { name, goalUsd, timezone, mode, solUsd, now, open, milestones: [0.05, 0.25, 0.5, 0.75, 1].map((f) => Math.round(goalUsd * f)),
      live: side('live', solUsd, now, entries), paper: side('paper', solUsd, now, entries) };
  }
  return { add, seed, summary, save, flush: () => { if (timer) save(); }, entries: () => d.entries };
}
