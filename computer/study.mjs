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
//   FCAT                 THE BOT'S RULE: buy as fast as possible, sell when Decu first sells, or 15 s
//                        after DECU'S buy if he hasn't sold. Uses the bot's real entry price (headline)
//   entry gap            how much more the bot paid per token than Decu did
//   BAND                 the same trade sized at BAND_PCT (10%) of what Decu spent instead of a fixed
//                        0.1 SOL. Uses the same % moves; a bigger buy moves the price more, so real
//                        BAND results would be somewhat worse than shown.
// Read-only: a study never signs or sends anything.

import fs from 'node:fs';
import { DIMENSIONS, createBrain, curveShape, simulateRules } from './learn.mjs';

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
  const f = rs.filter((r) => Number.isFinite(r.fcat));
  out.fcat = { pnlSol: f.reduce((a, r) => a + r.fcat * buySol, 0), bandPnlSol: f.reduce((a, r) => a + (r.bandSol > 0 ? r.fcat * r.bandSol : 0), 0), wins: f.filter((r) => r.fcat > 0).length, trades: f.length };
  out.bandSpentSol = rs.reduce((a, r) => a + (r.bandSol > 0 ? r.bandSol : 0), 0);
  out.pcat = { pnlSol: p.reduce((a, v) => a + v * buySol, 0), wins: p.filter((v) => v > 0).length, trades: p.length };
  return out;
}

/** Short text of the summary for alerts and the status command. */
// ===== MEMORY BANK =====
// Every studied trade is grouped by what was known about it (Decu's buy size, how late the bot was,
// how much more it paid than Decu, coin age / market cap / holders, how busy Decu was, hour of day).
// learn.mjs builds the patterns, predictions and journey on top of this. For each group: trades, wins, average
// FCAT. Over days this shows which kinds of Decu trades the bot wins and which it should skip.
const BUCKETS = Object.fromEntries(Object.entries(DIMENSIONS).map(([k, d]) => [k, d.f]));
export function memoryBank(records) {
  const rs = records.filter((r) => Number.isFinite(r.fcat));
  const out = [];
  for (const [dimension, f] of Object.entries(BUCKETS)) {
    const groups = new Map();
    for (const r of rs) { const b = f(r); if (b == null) continue; const g = groups.get(b) || { dimension, bucket: b, trades: 0, wins: 0, sum: 0 }; g.trades++; g.wins += r.fcat > 0 ? 1 : 0; g.sum += r.fcat; groups.set(b, g); }
    for (const g of groups.values()) out.push({ ...g, avgFcat: g.sum / g.trades });
  }
  return out;
}
/** Groups with enough trades to mean something, best and worst first. */
export function memoryInsights(records, minTrades = 5) {
  const bank = memoryBank(records).filter((g) => g.trades >= minTrades).sort((a, b) => b.avgFcat - a.avgFcat);
  return { best: bank.slice(0, 2), worst: bank.slice(-2).reverse(), all: bank };
}

/** The bot's own notes on one finished trade: what happened, what each rule would have done. */
export function tradeNotes(rec, records, { stopLossPct = 20, gainGatePct = 15, maxPayPct = 60 } = {}) {
  const n = [];
  const c = rec.curve || [];
  if (rec.delaySec != null || rec.entryGap != null) n.push(`Late by ${rec.delaySec ?? '?'}s and paid ${pct(rec.entryGap)} more per token than Decu${rec.entryGap > 0.9 ? ' (very high: most of his move was gone)' : rec.entryGap != null && rec.entryGap < 0.4 ? ' (good entry)' : ''}.`);
  n.push(rec.hisSoldAtSec != null ? `Decu sold ${rec.hisSoldAtSec}s after the bot's buy (${Math.round((rec.hisSoldAtSec + Math.max(0, rec.delaySec ?? 0)) * 10) / 10}s after his own).` : 'Decu was still holding when the 15 s study ended.');
  if (rec.btsab != null) n.push(`Best moment: ${rec.btsab}s at ${pct(rec.peak)}; ${rec.peak >= gainGatePct / 100 ? `reached +${gainGatePct}% → sells 15 s after Decu's buy` : `never +${gainGatePct}% → the bot holds for his sell`}.`);
  const base = c.find((v) => v != null);
  if (base != null) { const hit = c.findIndex((v) => v != null && (1 + v) / (1 + base) - 1 <= -stopLossPct / 100); n.push(hit >= 0 ? `Organic -${stopLossPct}% stop would sell at ${hit}s.` : `Organic -${stopLossPct}% stop not hit in 15s.`); }
  if (rec.entryGap != null) n.push(`A max-pay guard of +${maxPayPct}% above Decu would have ${rec.entryGap > maxPayPct / 100 ? 'SKIPPED' : 'allowed'} this buy (FCAT ${pct(rec.fcat)}).`);
  const size = BUCKETS['Decu buy size'](rec);
  if (size) { const g = memoryBank(records).find((x) => x.dimension === 'Decu buy size' && x.bucket === size); if (g && g.trades >= 3) n.push(`Memory: Decu buys of ${size} → ${g.wins}/${g.trades} won, avg FCAT ${pct(g.avgFcat)}.`); }
  return n;
}

export function summaryText(sm) {
  if (!sm.trades) return 'No studied trades yet.';
  const b = sm.bestSecond, t = sm.bestTakeProfit, ts = sm.bestTpSl;
  return [
    `Study so far: ${sm.trades} trades of ${sm.buySol} SOL`,
    `FCAT (bot rule: sell at his sell or 15s): ${sol(sm.fcat.pnlSol)} SOL (${sm.fcat.wins}/${sm.fcat.trades} wins) | BAND ${sol(sm.fcat.bandPnlSol)} SOL`,
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
 * learnOpts go to the brain (learn.mjs): stopLossPct, gainGatePct, gateSec, maxPayPct, reportEvery.
 */
export function createStudy({ file, quoteSell, notify = null, meta = null, mode = 'paper', buySol = 0.1, feeSol = 0.0015, slip = 0.005, windowSec = 15, stepMs = 1000, quoteTimeoutMs = 2500, maxConcurrent = 5, label = 'Decu', bandPct = 0.1, notesOpts = {}, learnOpts = {}, log = () => {} }) {
  const ruleOpts = { stopLossPct: notesOpts.stopLossPct ?? 20, gainGatePct: notesOpts.gainGatePct ?? 15, gateSec: learnOpts.gateSec ?? windowSec };
  const brain = createBrain({ buySol, ...ruleOpts, maxPayPct: learnOpts.maxPayPct ?? 0, reportEvery: learnOpts.reportEvery ?? 10, digestHours: learnOpts.digestHours ?? 24 });
  const records = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) if (line.trim()) records.push(JSON.parse(line));
  } catch { /* first run */ }
  // How many Decu trades the bot studied in the 10 minutes before this one (how busy he was).
  const recentCount = (time, list) => { const t = Date.parse(time); return list.filter((r) => { const u = Date.parse(r.time); return u < t && t - u <= 600e3; }).length; };
  const enrich = (rec, prior) => {
    rec.shape ??= curveShape(rec.curve);
    rec.ruleSim ??= simulateRules(rec, ruleOpts);
    if (rec.ctx?.recent10m == null) rec.ctx = { ...(rec.ctx || {}), recent10m: recentCount(rec.time, prior.slice(-50)) };
    return rec;
  };
  // Replay the journal through the brain (silently) so it remembers everything after a restart.
  for (let i = 0; i < records.length; i++) { enrich(records[i], records.slice(0, i)); brain.observe(records[i], records.slice(0, i + 1), { silent: true }); }
  const active = new Map();
  const tag = mode === 'live' ? '' : mode === 'paper' ? '[PAPER] ' : '[DEMO] ';
  const timed = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), quoteTimeoutMs))]);
  const send = (a) => { if (notify) Promise.resolve(notify(a)).catch(() => {}); };

  async function finish(st) {
    active.delete(st.mint);
    const curve = st.values.map((v) => (v == null ? null : (v * (1 - slip) - feeSol - st.cost) / st.cost));
    const known = curve.map((v, s) => [v, s]).filter(([v]) => v != null);
    const [peak, btsab] = known.length ? known.reduce((a, b) => (b[0] > a[0] ? b : a)) : [null, null];
    const [worst, worstAt] = known.length ? known.reduce((a, b) => (b[0] < a[0] ? b : a)) : [null, null];
    const botPrice = st.cost / st.raw;
    const hisPrice = st.his.sol > 0 && st.his.raw > 0 ? st.his.sol / st.his.raw : null;
    const delaySec = st.his.time ? Math.round((st.startedAt / 1000 - st.his.time) * 10) / 10 : null;
    let pcat = null, pcatExit = null;
    if (hisPrice) {
      const hs = st.hisSell;
      const exitPrice = hs && hs.sol > 0 && hs.soldRaw > 0 ? hs.sol / hs.soldRaw : st.values.findLast((v) => v != null) / st.raw;
      if (Number.isFinite(exitPrice)) { pcat = exitPrice / hisPrice - 1 - (2 * feeSol) / buySol; pcatExit = hs ? `his sell at ${hs.atSec}s` : '15s mark'; }
    }
    // FCAT: exit at the first full second after his first sell, else 15 s after DECU'S buy (the bot
    // lands ~2 s after him, so that is ~13 s after the bot's buy). Both inside the study window.
    const lastKnown = (from) => { for (let s = Math.min(from, curve.length - 1); s >= 0; s--) if (curve[s] != null) return curve[s]; return null; };
    const limit = Math.max(0, Math.min(windowSec, Math.ceil(windowSec - Math.max(0, delaySec ?? 0) - 1e-9)));
    const hs = st.hisSell, hisIn = hs && hs.atSec <= limit;
    const fcatSec = hisIn ? Math.max(0, Math.ceil(hs.atSec - 1e-9)) : limit;
    const fcat = lastKnown(fcatSec), fcatExit = hisIn ? `his sell at ${hs.atSec}s` : limit === windowSec ? `${windowSec}s limit` : `${windowSec}s after his buy (${limit}s after the bot's)`;
    const m = await (meta ? timed(meta(st.mint).catch(() => null)) : null);
    const rec = {
      time: new Date(st.startedAt).toISOString(), mint: st.mint, symbol: m?.symbol || null, mode,
      hisSol: st.his.sol, hisUsd: st.his.usd, delaySec,
      entryGap: hisPrice ? botPrice / hisPrice - 1 : null, cost: st.cost, curve, fcat, fcatSec, fcatExit, btsab, peak, worst, worstAt, pcat, pcatExit,
      hisSoldAtSec: st.hisSell?.atSec ?? null, bandSol: st.his.sol > 0 ? st.his.sol * bandPct : null,
      coin: m ? { holders: m.holders ?? null, marketCapUsd: m.marketCapUsd ?? null, ageSec: m.createdTime ? Math.round(st.startedAt / 1000 - m.createdTime) : null } : null,
    };
    enrich(rec, records);
    rec.notes = tradeNotes(rec, [...records, rec], notesOpts);
    records.push(rec);
    if (records.length > 5000) records.shift();
    const learned = brain.observe(rec, records);
    rec.thinking = brain.thinkingNotes(rec, learned, records);
    rec.prediction = learned.prediction ? { fcat: learned.prediction.fcat, right: learned.prediction.win === rec.fcat > 0 } : null;
    try { fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 }); } catch (e) { log(`study journal unavailable: ${e.message}`); }
    if (notify) {
      const name = rec.symbol ? `$${rec.symbol}` : `${st.mint.slice(0, 6)}…`;
      const at = (s) => (curve[s] == null ? '—' : pct(curve[s]));
      const lessons = brain.lessons();
      const body = [
        `${label} bought ${st.his.sol?.toFixed(3) ?? '?'} SOL${st.his.usd ? ` ($${Math.round(st.his.usd)})` : ''} · bot landed ${rec.delaySec ?? '?'}s later, entry ${pct(rec.entryGap)} vs his price`,
        `FCAT ${pct(fcat)} (${sol(fcat == null ? null : fcat * buySol)} SOL) · sold at ${fcatExit}${rec.bandSol ? ` · BAND ${sol(fcat == null ? null : fcat * rec.bandSol)} SOL` : ''}`,
        `3CAT ${at(3)} | 5CAT ${at(5)} | 10CAT ${at(10)}`,
        `BTSAB ${btsab ?? '—'}s → ${pct(peak)} (${sol(peak == null ? null : peak * buySol)} SOL) · worst ${pct(worst)} at ${worstAt ?? '—'}s`,
        `PCAT ${pct(pcat)} (bought at his price, sold at ${pcatExit ?? '—'})`,
        rec.bandSol ? `BAND ${rec.bandSol.toFixed(3)} SOL (${Math.round(bandPct * 100)}% of his buy): 3CAT ${sol(curve[3] == null ? null : curve[3] * rec.bandSol)} | 5CAT ${sol(curve[5] == null ? null : curve[5] * rec.bandSol)} | 10CAT ${sol(curve[10] == null ? null : curve[10] * rec.bandSol)} | BTSAB ${sol(peak == null ? null : peak * rec.bandSol)} SOL` : null,
        `Every second: ${curve.map((v, s) => `${s}:${v == null ? '—' : (v * 100).toFixed(0)}`).join(' ')}`,
        rec.coin ? `Coin: ${rec.coin.holders ?? '?'} holders, mcap ${rec.coin.marketCapUsd ? `$${Math.round(rec.coin.marketCapUsd).toLocaleString('en-US')}` : '?'}, age ${rec.coin.ageSec != null ? `${Math.round(rec.coin.ageSec / 60)} min` : '?'}` : null,
        '',
        'Notes:', ...rec.notes.map((x) => '• ' + x),
        'Brain:', ...rec.thinking.map((x) => '• ' + x),
        '',
        summaryText(summarize(records, { buySol })),
        lessons.length ? `Patterns (${lessons.length}): ${lessons.slice(0, 3).map((g) => `${g.status === 'confirmed' ? '✔' : '…'}${g.dev >= 0 ? '▲' : '▼'} ${g.label} ${pct(g.avg, 0)} (${g.n})`).join(' | ')}` : 'Patterns: none strong enough yet.',
        brain.journeyLine(records),
        mode === 'live' ? '' : 'No real money used.',
        `Token: ${st.mint}`,
      ].filter((x) => x != null).join('\n');
      send({ title: `${tag}${name} FCAT ${pct(fcat)} | BTSAB ${btsab ?? '—'}s ${pct(peak)}`, body, priority: 3, tags: ['bar_chart'], click: `https://pump.fun/coin/${st.mint}` });
      // What the brain decided is worth its own alert: new / confirmed / faded patterns, streaks,
      // level-ups, the learning report every 10 trades and the daily digest.
      for (const e of learned.events) send({ title: `${tag}${e.title}`, body: e.body + (mode === 'live' ? '' : '\nNo real money used.'), priority: e.priority, tags: e.tags });
    }
    return rec;
  }

  return {
    records,
    active,
    brain,
    summary: () => summarize(records, { buySol }),
    learning: () => brain.snapshot(records),
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
