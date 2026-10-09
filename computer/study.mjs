// TRADE STUDY: for every coin the bot buys, re-price the position every second for exactly
// STUDY_WINDOW_SEC (15) seconds, then stop touching that coin. Each finished study is saved to a
// journal and sent as one detailed phone alert. Over many trades the summary answers:
// "what selling rule would have made the most money on Decu's trades?"
//
// Terms used in the alerts:
//   3CAT / 5CAT / 10CAT  profit if the bot sold 3 / 5 / 10 s after its own buy
//   BTSAB                best time to sell after buying: the second (0–15) with the highest profit
//   PCAT                 profit if you had bought at Decu's own first-buy price and sold when he
//                        first sold (or at the 15 s mark if he hadn't sold yet)
//   entry gap            how much more the bot paid per token than Decu did
//   BAND                 the same trade sized at BAND_PCT (10%) of what Decu spent instead of a fixed
//                        0.1 SOL. Uses the same % moves; a bigger buy moves the price more, so real
//                        BAND results would be somewhat worse than shown.
// Read-only: a study never signs or sends anything.

import fs from 'node:fs';

const pct = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
const sol = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(4)}`);
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

/** Outcome of one selling rule on one recorded curve. curve[s] = profit fraction at second s (or null). */
function ruleExit(curve, { tp = null, sl = null, at = null }) {
  const last = curve.length - 1;
  for (let s = 0; s <= last; s++) {
    const v = curve[s];
    if (v == null) continue;
    if (at != null && s >= at) return v;
    if (tp != null && v >= tp) return v;
    if (sl != null && v <= sl) return v;
  }
  for (let s = last; s >= 0; s--) if (curve[s] != null) return curve[s]; // window end
  return null;
}

/** Best rules over all recorded trades: fixed sell second, take-profit, take-profit + stop-loss. */
export function summarize(records, { buySol = 0.1 } = {}) {
  const rs = records.filter((r) => Array.isArray(r.curve) && r.curve.some((v) => v != null));
  const n = rs.length;
  const out = { trades: n, buySol };
  if (!n) return out;
  const score = (rule) => {
    const vals = rs.map((r) => ruleExit(r.curve, rule)).filter((v) => v != null);
    const band = rs.map((r) => [ruleExit(r.curve, rule), r.bandSol]).filter(([v, b]) => v != null && b > 0);
    return { bandPnlSol: band.reduce((a, [v, b]) => a + v * b, 0), pnlSol: vals.reduce((a, v) => a + v * buySol, 0), wins: vals.filter((v) => v > 0).length, trades: vals.length, avg: vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null };
  };
  const len = Math.max(...rs.map((r) => r.curve.length));
  out.bySecond = Array.from({ length: len }, (_, s) => ({ sec: s, ...score({ at: s }) }));
  out.bestSecond = [...out.bySecond].sort((a, b) => b.pnlSol - a.pnlSol)[0];
  const tps = [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1];
  const sls = [-0.05, -0.1, -0.15, -0.2, -0.3];
  out.takeProfit = tps.map((tp) => ({ tp, ...score({ tp }) })).sort((a, b) => b.pnlSol - a.pnlSol);
  out.bestTakeProfit = out.takeProfit[0];
  out.tpSl = tps.flatMap((tp) => sls.map((sl) => ({ tp, sl, ...score({ tp, sl }) }))).sort((a, b) => b.pnlSol - a.pnlSol);
  out.bestTpSl = out.tpSl[0];
  out.cat = Object.fromEntries([3, 5, 10].map((s) => [`${s}CAT`, score({ at: s })]));
  out.perfect = { pnlSol: rs.reduce((a, r) => a + (r.peak ?? 0) * buySol, 0), note: 'selling every coin at its exact best second (impossible upper bound)' };
  out.medianBtsab = median(rs.map((r) => r.btsab));
  out.medianPeak = median(rs.map((r) => r.peak));
  out.medianEntryGap = median(rs.map((r) => r.entryGap));
  out.medianDelaySec = median(rs.map((r) => r.delaySec));
  const p = rs.map((r) => r.pcat).filter(Number.isFinite);
  out.bandSpentSol = rs.reduce((a, r) => a + (r.bandSol > 0 ? r.bandSol : 0), 0);
  out.pcat = { pnlSol: p.reduce((a, v) => a + v * buySol, 0), wins: p.filter((v) => v > 0).length, trades: p.length };
  return out;
}

/** Short text of the summary for alerts and the status command. */
export function summaryText(sm) {
  if (!sm.trades) return 'No studied trades yet.';
  const b = sm.bestSecond, t = sm.bestTakeProfit, ts = sm.bestTpSl;
  return [
    `Study so far: ${sm.trades} trades of ${sm.buySol} SOL`,
    `Best fixed sell: ${b.sec}s after buy → ${sol(b.pnlSol)} SOL total (${b.wins}/${b.trades} wins)`,
    `Best take-profit: sell at ${pct(t.tp)} else at 15s → ${sol(t.pnlSol)} SOL (${t.wins}/${t.trades})`,
    `Best TP+stop: ${pct(ts.tp)} / ${pct(ts.sl)} → ${sol(ts.pnlSol)} SOL (${ts.wins}/${ts.trades})`,
    `3CAT ${sol(sm.cat['3CAT'].pnlSol)} | 5CAT ${sol(sm.cat['5CAT'].pnlSol)} | 10CAT ${sol(sm.cat['10CAT'].pnlSol)} SOL`,
    `BAND (10% of his size, ${sm.bandSpentSol.toFixed(2)} SOL spent): best second ${sol(b.bandPnlSol)} | best TP ${sol(t.bandPnlSol)} | 5CAT ${sol(sm.cat['5CAT'].bandPnlSol)} SOL`,
    `PCAT (his price) ${sol(sm.pcat.pnlSol)} SOL | median BTSAB ${sm.medianBtsab ?? '—'}s, peak ${pct(sm.medianPeak)}, entry gap ${pct(sm.medianEntryGap)}`,
  ].join('\n');
}

/**
 * createStudy({file, quoteSell, notify, meta, ...}).start({...}) after each confirmed bot buy.
 * leaderSell(mint, {time, sol, soldRaw}) records his first sell during the window.
 */
export function createStudy({ file, quoteSell, notify = null, meta = null, mode = 'paper', buySol = 0.1, feeSol = 0.0015, slip = 0.005, windowSec = 15, stepMs = 1000, quoteTimeoutMs = 2500, maxConcurrent = 5, label = 'Decu', bandPct = 0.1, log = () => {} }) {
  const records = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.trim()) records.push(JSON.parse(line));
  } catch { /* first run */ }
  const active = new Map();
  const tag = mode === 'live' ? '' : mode === 'paper' ? '[PAPER] ' : '[DEMO] ';
  const timed = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), quoteTimeoutMs))]);

  async function finish(st) {
    active.delete(st.mint);
    const curve = st.values.map((v) => (v == null ? null : (v * (1 - slip) - feeSol - st.cost) / st.cost));
    const known = curve.map((v, s) => [v, s]).filter(([v]) => v != null);
    const [peak, btsab] = known.length ? known.reduce((a, b) => (b[0] > a[0] ? b : a)) : [null, null];
    const [worst, worstAt] = known.length ? known.reduce((a, b) => (b[0] < a[0] ? b : a)) : [null, null];
    const botPrice = st.cost / st.raw;
    const hisPrice = st.his.sol > 0 && st.his.raw > 0 ? st.his.sol / st.his.raw : null;
    let pcat = null, pcatExit = null;
    if (hisPrice) {
      const hs = st.hisSell;
      const exitPrice = hs && hs.sol > 0 && hs.soldRaw > 0 ? hs.sol / hs.soldRaw : st.values.findLast((v) => v != null) / st.raw;
      if (Number.isFinite(exitPrice)) { pcat = exitPrice / hisPrice - 1 - (2 * feeSol) / buySol; pcatExit = hs ? `his sell at ${hs.atSec}s` : '15s mark'; }
    }
    const m = await (meta ? timed(meta(st.mint).catch(() => null)) : null);
    const rec = {
      time: new Date(st.startedAt).toISOString(), mint: st.mint, symbol: m?.symbol || null, mode,
      hisSol: st.his.sol, hisUsd: st.his.usd, delaySec: st.his.time ? Math.round((st.startedAt / 1000 - st.his.time) * 10) / 10 : null,
      entryGap: hisPrice ? botPrice / hisPrice - 1 : null, cost: st.cost, curve, btsab, peak, worst, worstAt, pcat, pcatExit,
      hisSoldAtSec: st.hisSell?.atSec ?? null, bandSol: st.his.sol > 0 ? st.his.sol * bandPct : null,
      coin: m ? { holders: m.holders ?? null, marketCapUsd: m.marketCapUsd ?? null, ageSec: m.createdTime ? Math.round(st.startedAt / 1000 - m.createdTime) : null } : null,
    };
    records.push(rec);
    if (records.length > 5000) records.shift();
    try { fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 }); } catch (e) { log(`study journal unavailable: ${e.message}`); }
    if (notify) {
      const name = rec.symbol ? `$${rec.symbol}` : `${st.mint.slice(0, 6)}…`;
      const at = (s) => (curve[s] == null ? '—' : pct(curve[s]));
      const body = [
        `${label} bought ${st.his.sol?.toFixed(3) ?? '?'} SOL${st.his.usd ? ` ($${Math.round(st.his.usd)})` : ''} · bot landed ${rec.delaySec ?? '?'}s later, entry ${pct(rec.entryGap)} vs his price`,
        `3CAT ${at(3)} | 5CAT ${at(5)} | 10CAT ${at(10)}`,
        `BTSAB ${btsab ?? '—'}s → ${pct(peak)} (${sol(peak == null ? null : peak * buySol)} SOL) · worst ${pct(worst)} at ${worstAt ?? '—'}s`,
        `PCAT ${pct(pcat)} (bought at his price, sold at ${pcatExit ?? '—'})`,
        rec.bandSol ? `BAND ${rec.bandSol.toFixed(3)} SOL (${Math.round(bandPct * 100)}% of his buy): 3CAT ${sol(curve[3] == null ? null : curve[3] * rec.bandSol)} | 5CAT ${sol(curve[5] == null ? null : curve[5] * rec.bandSol)} | 10CAT ${sol(curve[10] == null ? null : curve[10] * rec.bandSol)} | BTSAB ${sol(peak == null ? null : peak * rec.bandSol)} SOL` : null,
        `Every second: ${curve.map((v, s) => `${s}:${v == null ? '—' : (v * 100).toFixed(0)}`).join(' ')}`,
        rec.coin ? `Coin: ${rec.coin.holders ?? '?'} holders, mcap ${rec.coin.marketCapUsd ? `$${Math.round(rec.coin.marketCapUsd).toLocaleString('en-US')}` : '?'}, age ${rec.coin.ageSec != null ? `${Math.round(rec.coin.ageSec / 60)} min` : '?'}` : null,
        '',
        summaryText(summarize(records, { buySol })),
        mode === 'live' ? '' : 'No real money used.',
        `Token: ${st.mint}`,
      ].filter((x) => x != null).join('\n');
      Promise.resolve(notify({ title: `${tag}${name} BTSAB ${btsab ?? '—'}s ${pct(peak)} | 5CAT ${at(5)}`, body, priority: 3, tags: ['bar_chart'], click: `https://pump.fun/coin/${st.mint}` })).catch(() => {});
    }
    return rec;
  }

  return {
    records,
    active,
    summary: () => summarize(records, { buySol }),
    /** Begin a 15 s study of a position the bot just bought. Returns a promise of the record. */
    start({ mint, cost, raw, his = {} }) {
      if (active.has(mint) || active.size >= maxConcurrent || !(cost > 0) || !(Number(raw) > 0)) return null;
      const st = { mint, cost, raw: Number(raw), his, values: [], startedAt: Date.now(), hisSell: null };
      active.set(mint, st);
      return new Promise((resolve) => {
        let s = 0;
        const tick = async () => {
          const due = st.startedAt + s * stepMs;
          st.values[s] = await timed(quoteSell(mint, st.raw).then((v) => (Number.isFinite(v) ? v : null)).catch(() => null));
          s++;
          if (s > windowSec) return resolve(await finish(st)); // hard stop: never studies a coin longer than the window
          setTimeout(tick, Math.max(0, due + stepMs - Date.now()));
        };
        tick();
      });
    },
    leaderSell(mint, { time, sol: received, soldRaw }) {
      const st = active.get(mint);
      if (!st || st.hisSell) return;
      st.hisSell = { sol: Number(received) || 0, soldRaw: Number(soldRaw) || 0, atSec: Math.round(((time || Date.now() / 1000) - st.startedAt / 1000) * 10) / 10 };
    },
  };
}
