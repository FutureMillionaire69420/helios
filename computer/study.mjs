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
import { DIMENSIONS, createBrain, curveShape, simulateRules, exitSim, holderVerdict, HOLDER_RULES } from './learn.mjs';

// CHARTS: a QuickChart.io image URL (rendered on demand, only % numbers are sent) attached to alerts.
const chartUrl = (cfg) => `https://quickchart.io/chart?w=600&h=320&bkg=white&c=${encodeURIComponent(JSON.stringify(cfg))}`;
export function tradeChart(rec, gatePct = 15, stopPct = 20) {
  const c = rec.curve || [], base = c.find((v) => v != null) ?? 0, r = (v) => (v == null ? null : Math.round(v * 1000) / 10);
  const flat = (v) => c.map(() => v);
  const ds = [{ label: 'Bot P&L %', data: c.map(r), borderColor: '#1f6feb', fill: false, pointRadius: 3 },
    { label: `+${gatePct}% gate`, data: flat(gatePct), borderColor: '#2da44e', borderDash: [6, 4], pointRadius: 0, fill: false },
    { label: `stop (-${stopPct}% from entry)`, data: flat(r((1 + base) * (1 - stopPct / 100) - 1)), borderColor: '#cf222e', borderDash: [6, 4], pointRadius: 0, fill: false }];
  if (rec.hisSoldAtSec != null) ds.push({ label: 'Decu sold', type: 'bar', data: c.map((_, s) => (s === Math.ceil(rec.hisSoldAtSec) ? r(Math.max(...c.filter((v) => v != null))) : null)), backgroundColor: '#bf8700' });
  return chartUrl({ type: 'line', data: { labels: c.map((_, s) => `${s}s`), datasets: ds }, options: { title: { display: true, text: `${rec.symbol ? '$' + rec.symbol : rec.mint.slice(0, 6)} FCAT ${pct(rec.fcat)} · paid ${pct(rec.entryGap)} vs Decu` } } });
}
export function historyChart(records, n = 30) {
  const rs = records.filter((r) => Number.isFinite(r.fcat) && r.taken !== false && !r.skipReason).slice(-n); let cum = 0; // bought trades only
  return chartUrl({ type: 'bar', data: { labels: rs.map((r) => r.symbol || r.mint.slice(0, 4)), datasets: [
    { label: 'FCAT %', data: rs.map((r) => Math.round(r.fcat * 1000) / 10), backgroundColor: rs.map((r) => (r.fcat > 0 ? '#2da44e' : '#cf222e')) },
    { label: 'Running total (SOL x100)', type: 'line', data: rs.map((r) => Math.round((cum += r.fcat * 0.1) * 1e4) / 100), borderColor: '#1f6feb', fill: false }] },
    options: { title: { display: true, text: `Last ${rs.length} trades: FCAT per trade and running total` } } });
}

/**
 * PER-COIN CHART (its own phone notification after the trade alert): this one trade, deconstructed.
 * The bot's profit % every second after its buy (blue), the 3CAT / 5CAT / 10CAT / BTSAB exits marked on the
 * line and named on the time axis, Decu's sell and the bot's own exit named on the axis too, the stop-loss
 * (red, dashed) and the +gain gate and break-even (gray, dashed) as labelled lines. PCAT, BAND and the win
 * rates are in the header. Colors pass color-blind checks on white; every mark is also named in text.
 */
export function coinChart(rec, records = [], { gatePct = 15, stopPct = 20 } = {}) {
  const c = rec.curve || [], r = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 10);
  const base = c.find((v) => v != null) ?? 0, stopLvl = (1 + base) * (1 - stopPct / 100) - 1;
  const st = coinStats(rec, records);
  const tags = c.map((_, s) => [s === 3 && '3CAT', s === 5 && '5CAT', s === 10 && '10CAT', s === rec.btsab && 'BEST', s === rec.fcatSec && 'EXIT', rec.hisSoldAtSec != null && s === Math.ceil(rec.hisSoldAtSec) && 'DECU SOLD'].filter(Boolean).join(' '));
  const labels = c.map((_, s) => (tags[s] ? `${s}s ${tags[s]}` : `${s}s`));
  const marks = c.map((v, s) => ([3, 5, 10, rec.btsab].includes(s) ? r(v) : null));
  const flat = (v) => c.map(() => r(v));
  const band = rec.bandSol, bs = (v) => (v == null || !band ? '—' : `${v * band >= 0 ? '+' : ''}${(v * band).toFixed(3)}`);
  const cfg = { type: 'line', data: { labels, datasets: [
    { label: 'Bot profit % each second', data: c.map(r), borderColor: '#2a78d6', backgroundColor: '#2a78d6', borderWidth: 2, pointRadius: 2, pointBackgroundColor: '#2a78d6', fill: false, lineTension: 0, datalabels: { display: false } },
    { label: '3CAT / 5CAT / 10CAT / best second', data: marks, showLine: false, fill: false, pointRadius: 7, backgroundColor: '#1baf7a', borderColor: '#1baf7a', pointBackgroundColor: '#1baf7a', pointBorderColor: '#ffffff', pointBorderWidth: 2, datalabels: { display: true, align: 'top', color: '#0b0b0b', font: { weight: 'bold' } } },
    { label: `Stop-loss: -${stopPct}% from entry (${pct(stopLvl)})`, data: flat(stopLvl), borderColor: '#e34948', backgroundColor: '#e34948', borderWidth: 2, borderDash: [8, 5], pointRadius: 0, fill: false, datalabels: { display: false } },
    { label: `+${gatePct}% gain gate`, data: flat(gatePct / 100), borderColor: '#52514e', backgroundColor: '#52514e', borderWidth: 1.5, borderDash: [3, 4], pointRadius: 0, fill: false, datalabels: { display: false } },
    { label: 'Break-even (0%)', data: flat(0), borderColor: '#898781', backgroundColor: '#898781', borderWidth: 1, pointRadius: 0, fill: false, datalabels: { display: false } },
  ] }, options: {
    title: { display: true, fontColor: '#0b0b0b', fontSize: 13, text: [
      `${rec.symbol ? '$' + rec.symbol : rec.mint.slice(0, 6)}: FCAT ${pct(rec.fcat)} (${rec.fcatExit || 'exit'}) · paid ${pct(rec.entryGap)} vs Decu · ${rec.delaySec ?? '?'} s${rec.latency?.blocksAfter != null ? ` / ${rec.latency.blocksAfter} blocks` : ''} after him`,
      `3CAT ${pct(c[3])} · 5CAT ${pct(c[5])} · 10CAT ${pct(c[10])} · BEST ${rec.btsab ?? '—'}s ${pct(rec.peak)} · worst ${pct(rec.worst)} at ${rec.worstAt ?? '—'}s · PCAT ${pct(rec.pcat)}`,
      band ? `BAND ${band.toFixed(3)} SOL: 3CAT ${bs(c[3])} · 5CAT ${bs(c[5])} · 10CAT ${bs(c[10])} · BEST ${bs(rec.peak)} · FCAT ${bs(rec.fcat)} SOL` : `BAND: — (no Decu size)`,
      `Win rate so far (${st.n} bought): FCAT ${st.win.fcat} · 3CAT ${st.win[3]} · 5CAT ${st.win[5]} · 10CAT ${st.win[10]}`,
    ] },
    legend: { position: 'bottom', labels: { fontColor: '#52514e', boxWidth: 18 } },
    plugins: { datalabels: { display: false } },
    scales: { xAxes: [{ gridLines: { display: false }, ticks: { fontColor: '#52514e', maxRotation: 60, autoSkip: false } }], yAxes: [{ gridLines: { color: '#e1e0d9', zeroLineColor: '#c3c2b7' }, ticks: { fontColor: '#52514e' }, scaleLabel: { display: true, labelString: 'profit % after fees', fontColor: '#52514e' } }] },
  } };
  return `https://quickchart.io/chart?w=760&h=480&bkg=white&c=${encodeURIComponent(JSON.stringify(cfg))}`;
}

/** Win rates of each exit over the bought trades so far, and setups like this one (same entry-premium band). */
export function coinStats(rec, records = []) {
  const bought = [...records.filter((x) => x !== rec && x.taken !== false && !x.skipReason), rec];
  const rate = (f) => { const v = bought.map(f).filter((x) => x != null && Number.isFinite(x)); return v.length ? `${Math.round((v.filter((x) => x > 0).length / v.length) * 100)}%` : '—'; };
  const avg = (f) => { const v = bought.map(f).filter((x) => x != null && Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const lo = rec.entryGap == null ? null : Math.floor(rec.entryGap * 20) / 20, like = lo == null ? [] : bought.filter((x) => Number.isFinite(x.entryGap) && Math.floor(x.entryGap * 20) / 20 === lo && Number.isFinite(x.fcat));
  return { n: bought.length, win: { fcat: rate((x) => x.fcat), 3: rate((x) => x.curve?.[3]), 5: rate((x) => x.curve?.[5]), 10: rate((x) => x.curve?.[10]) },
    avg: { fcat: avg((x) => x.fcat), 3: avg((x) => x.curve?.[3]), 5: avg((x) => x.curve?.[5]), 10: avg((x) => x.curve?.[10]), best: avg((x) => x.peak) },
    like: { band: lo == null ? null : [lo, lo + 0.05], n: like.length, win: like.length ? like.filter((x) => x.fcat > 0).length / like.length : null, avg: like.length ? like.reduce((a, x) => a + x.fcat, 0) / like.length : null } };
}

/** The chart read like a trader: what the price did, which exit won, the stop and gate, the win rates. */
export function coinChartText(rec, records = [], { gatePct = 15, stopPct = 20, buySol = 0.1 } = {}) {
  const c = rec.curve || [], base = c.find((v) => v != null) ?? 0, stopLvl = (1 + base) * (1 - stopPct / 100) - 1;
  const first = (f) => { const s = c.findIndex((v) => v != null && f(v)); return s < 0 ? null : s; };
  const stopAt = first((v) => v <= stopLvl), gateAt = first((v) => v >= gatePct / 100), last = [...c].reverse().find((v) => v != null);
  const st = coinStats(rec, records), sv = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v * buySol >= 0 ? '+' : ''}${(v * buySol).toFixed(4)} SOL`);
  const exits = [['3CAT', c[3]], ['5CAT', c[5]], ['10CAT', c[10]], ['FCAT (your rule)', rec.fcat], [`BEST (${rec.btsab ?? '?'}s)`, rec.peak]].filter(([, v]) => v != null && Number.isFinite(v)).sort((a, b) => b[1] - a[1]);
  const shape = rec.peak == null || last == null ? 'not enough price points to read the shape'
    : rec.peak <= 0 ? `never made money: best ${pct(rec.peak)}, it ${last < base ? 'kept falling' : 'went sideways'} (${pct(base)} at the buy, ${pct(last)} at the end)`
    : rec.btsab <= 5 && last < rec.peak - 0.1 ? `spiked fast to ${pct(rec.peak)} at ${rec.btsab}s, then gave back ${Math.round((rec.peak - last) * 100)} points by the end: an early exit beat holding`
    : rec.btsab >= 10 ? `climbed late: the best price came at ${rec.btsab}s (${pct(rec.peak)}), holding paid`
    : `peaked at ${pct(rec.peak)} at ${rec.btsab}s and ended at ${pct(last)}`;
  return [
    `READ: ${shape}.`,
    `EXITS, best to worst: ${exits.map(([k, v]) => `${k} ${pct(v)} (${sv(v)})`).join(' > ')}`,
    `PCAT ${pct(rec.pcat)}: bought at Decu's own price, sold at ${rec.pcatExit || 'the end'}.${Number.isFinite(rec.entryGap) ? ` You paid ${Math.abs(rec.entryGap * 100).toFixed(1)}% ${rec.entryGap >= 0 ? 'more' : 'less'} than him: most of the gap between PCAT and your FCAT.` : ''}`,
    `STOP-LOSS -${stopPct}% from entry = ${pct(stopLvl)} on this chart: ${stopAt == null ? 'never hit' : `hit at ${stopAt}s`}. GAIN GATE +${gatePct}%: ${gateAt == null ? 'never reached' : `reached at ${gateAt}s`}.`,
    rec.bandSol ? `BAND (${rec.bandSol.toFixed(3)} SOL, a share of Decu's size): ${[['3CAT', c[3]], ['5CAT', c[5]], ['10CAT', c[10]], ['FCAT', rec.fcat], ['BEST', rec.peak]].map(([k, v]) => `${k} ${v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${(v * rec.bandSol).toFixed(4)} SOL`}`).join(' · ')}` : null,
    `WIN RATE over ${st.n} bought trades: FCAT ${st.win.fcat} (avg ${pct(st.avg.fcat)}) · 3CAT ${st.win[3]} (avg ${pct(st.avg[3])}) · 5CAT ${st.win[5]} (avg ${pct(st.avg[5])}) · 10CAT ${st.win[10]} (avg ${pct(st.avg[10])})`,
    st.like.band ? `SETUPS LIKE THIS (paid ${Math.round(st.like.band[0] * 100)}–${Math.round(st.like.band[1] * 100)}% over Decu): ${st.like.n} trades, ${st.like.win == null ? '—' : Math.round(st.like.win * 100) + '%'} won, avg FCAT ${pct(st.like.avg)}` : null,
  ].filter(Boolean).join('\n');
}

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
export function summarize(records, { buySol = 0.1, filterPct = 60 } = {}) {
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
  const fT = f.filter((r) => r.taken !== false);
  out.fcat = { pnlSol: fT.reduce((a, r) => a + r.fcat * buySol, 0), bandPnlSol: fT.reduce((a, r) => a + (r.bandSol > 0 ? r.fcat * r.bandSol : 0), 0), wins: fT.filter((r) => r.fcat > 0).length, trades: fT.length };
  out.fcatAll = { pnlSol: f.reduce((a, r) => a + r.fcat * buySol, 0), trades: f.length, skipped: f.length - fT.length };
  const fF = f.filter((r) => r.entryGap == null || r.entryGap <= filterPct / 100);
  out.filtered = { pct: filterPct, pnlSol: fF.reduce((a, r) => a + r.fcat * buySol, 0), wins: fF.filter((r) => r.fcat > 0).length, trades: fF.length };
  out.bandSpentSol = rs.reduce((a, r) => a + (r.bandSol > 0 ? r.bandSol : 0), 0);
  out.pcat = { pnlSol: p.reduce((a, v) => a + v * buySol, 0), wins: p.filter((v) => v > 0).length, trades: p.length };
  return out;
}

/** One line: where the execution latency went (see runtime.mjs pipe). */
const usd = (x) => `$${Math.round(x).toLocaleString('en-US')}`;
/** "Holders (dev excluded) hold $3,900 in 412 wallets · dev 12% · mcap $10,500 → SAFE (enough up to $30k)" */
export function holderLine(hv) {
  if (!hv) return null;
  const dev = hv.devKnown === false ? ' · dev unknown' : hv.devPct != null ? ` · dev holds ${(hv.devPct * 100).toFixed(1)}%` : '';
  return `Holders (dev excluded) hold ${usd(hv.heldUsd)}${hv.holders != null ? ` in ${hv.holders} wallets` : ''}${dev} · mcap ${usd(hv.mcapUsd)} → ${hv.safe ? 'SAFE' : 'RISKY'}${hv.safe ? (hv.ceilingUsd ? ` (enough up to a ${usd(hv.ceilingUsd)} mcap)` : ' (enough for every market cap in your rule)') : ` (needs ${usd(hv.required)} at this mcap)`}`;
}
export function latencyLine(L) {
  if (!L) return null;
  const ms = (x) => (x == null ? '—' : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x} ms`);
  const parts = [L.detectBlocks != null ? `seen ${L.detectBlocks} block${L.detectBlocks === 1 ? '' : 's'} after his (exact; ≈${ms(L.detectMs)} by his whole-second clock)` : `seen ${ms(L.detectMs)} after his block (his clock is whole seconds: ±0.5 s)`, `decode ${ms(L.decodeMs)}`, `decide ${ms(L.decideMs)}`, `build ${ms(L.buildMs)}${L.route ? ` (${L.route})` : ''}`];
  if (L.sendMs != null) parts.push(`send ${ms(L.sendMs)}`);
  parts.push(L.simulatedMs != null ? `land ${ms(L.landMs)} (incl. ${ms(L.simulatedMs)} SIMULATED paper wait)` : `land ${ms(L.landMs)}`);
  return `Latency: ${parts.join(' · ')} · bot total ${ms(L.botMs)}${L.blocksAfter != null ? ` · ${L.blocksAfter} blocks after Decu${L.blocksEstimated ? ' (≈, paper)' : ''}` : ''}`;
}
const pctl = (xs, p) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
/** Research summary for the dashboard: latency, premium, accepted vs rejected, risk numbers. */
export function research(records, { buySol = 0.1, filterPct = 60, reportPcts = [] } = {}) {
  const rs = records.filter((r) => Number.isFinite(r.fcat));
  const taken = rs.filter((r) => r.taken !== false), skipped = rs.filter((r) => r.taken === false);
  const L = (k) => taken.map((r) => r.latency?.[k]).filter(Number.isFinite);
  let eq = 0, peakEq = 0, dd = 0;
  for (const r of taken) { eq += r.fcat * buySol; peakEq = Math.max(peakEq, eq); dd = Math.min(dd, eq - peakEq); }
  const gains = taken.filter((r) => r.fcat > 0).reduce((a, r) => a + r.fcat, 0), losses = -taken.filter((r) => r.fcat < 0).reduce((a, r) => a + r.fcat, 0);
  const reasons = {}; for (const r of skipped) { const k = String(r.skipReason || 'other').replace(/[0-9.]+%?/g, '#').slice(0, 60); reasons[k] = (reasons[k] || 0) + 1; }
  const fl = rs.filter((r) => r.entryGap == null || r.entryGap <= filterPct / 100);
  return {
    trades: rs.length, taken: taken.length, skipped: skipped.length, skipReasons: reasons,
    fcatSol: eq, winRate: taken.length ? taken.filter((r) => r.fcat > 0).length / taken.length : null,
    profitFactor: losses > 0 ? gains / losses : null, maxDrawdownSol: dd,
    medianEntryPremium: median(rs.map((r) => r.entryGap)), avgEntryPremium: rs.filter((r) => Number.isFinite(r.entryGap)).reduce((a, r, _, l) => a + r.entryGap / l.length, 0) || null,
    filter: { pct: filterPct, trades: fl.length, fcatSol: fl.reduce((a, r) => a + r.fcat * buySol, 0) },
    // Same trades, three premium limits side by side (only trades with a known premium count).
    filters: [...new Set([...reportPcts, filterPct])].sort((a, b) => a - b).map((p) => { const k = rs.filter((r) => Number.isFinite(r.entryGap) && r.entryGap <= p / 100 + 1e-9); return { pct: p, trading: p === filterPct, trades: k.length, wins: k.filter((r) => r.fcat > 0).length, fcatSol: k.reduce((a, r) => a + r.fcat * buySol, 0) }; }),
    holders: (() => { const g = (safe) => { const k = rs.filter((r) => r.holderVerdict?.heldUsd != null && r.holderVerdict.safe === safe); return { trades: k.length, wins: k.filter((r) => r.fcat > 0).length, fcatSol: k.reduce((a, r) => a + r.fcat * buySol, 0) }; }; return { safe: g(true), risky: g(false), unknown: rs.filter((r) => r.holderVerdict?.heldUsd == null).length }; })(),
    // Paper tests c and d vs your rules, on the SAME trades (a trade without data for a test is left out of both).
    exitTests: ['costStop', 'holders'].map((k) => { const both = rs.filter((r) => r.exitAlt?.[k] && r.ruleSim && Number.isFinite(r.exitAlt[k].pnl) && Number.isFinite(r.ruleSim.pnl)); const sum = (f) => both.reduce((a, r) => a + f(r) * buySol, 0);
      return { name: k === 'costStop' ? 'stop -20% on your money' : 'holder momentum', trades: both.length, pnlSol: sum((r) => r.exitAlt[k].pnl), yoursSol: sum((r) => r.ruleSim.pnl), incomplete: rs.filter((r) => r.exitAlt?.[k] == null).length }; }),
    latency: { medianSec: median(rs.map((r) => r.delaySec)), p95Sec: pctl(rs.map((r) => r.delaySec), 0.95), botMedianMs: median(L('botMs')), botP95Ms: pctl(L('botMs'), 0.95), detectMedianMs: median(L('detectMs')), buildMedianMs: median(L('buildMs')), landMedianMs: median(L('landMs')), blocksMedian: median(L('blocksAfter')), detectBlocksMedian: median(L('detectBlocks')), detectBlocksP95: pctl(L('detectBlocks'), 0.95), simulatedMs: median(L('simulatedMs')) },
    recent: records.slice(-15).reverse().map((r) => ({ time: r.time, coin: r.symbol || r.mint.slice(0, 6), taken: r.taken !== false, reason: r.skipReason, premium: r.entryGap, latencySec: r.delaySec, blocks: r.latency?.blocksAfter ?? null, fcat: r.fcat })),
  };
}

/** Every studied trade as CSV (one row per Decu buy, bought or skipped), for a spreadsheet. */
export function toCsv(records) {
  const cols = ['time_utc', 'coin', 'mint', 'bought', 'skip_reason', 'decu_sol', 'decu_usd', 'execution_latency_s', 'blocks_after_decu', 'entry_premium_pct', 'fcat_pct', 'fcat_exit', 'cat3_pct', 'cat5_pct', 'cat10_pct', 'btsab_s', 'peak_pct', 'worst_pct', 'pcat_pct', 'your_rules_pct', 'your_rules_exit', 'shape', 'predicted_pct', 'holders', 'mcap_usd', 'coin_age_min', 'detect_blocks', 'premium_basis', 'cost_premium_pct', 'buy_fee_sol', 'sell_fee_sol', 'holder_rule', 'holder_money_usd', 'holder_money_needed_usd', 'dev_pct', 'test_c_stop_on_money_pct', 'test_c_exit', 'test_d_holder_momentum_pct', 'test_d_exit', ...Array.from({ length: 16 }, (_, s) => `s${s}_pct`)];
  const p = (x) => (x == null || !Number.isFinite(x) ? '' : (x * 100).toFixed(2));
  const q = (v) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const ex = (x) => (x == null ? '' : x.open ? 'holding at 15 s' : `${x.how} at ${x.sec}s`);
  const rows = records.map((r) => [r.time, r.symbol || '', r.mint, r.taken === false ? 'no' : 'yes', r.skipReason || '', r.hisSol ?? '', r.hisUsd != null ? Math.round(r.hisUsd) : '', r.delaySec ?? '', r.latency?.blocksAfter ?? '', p(r.entryGap), p(r.fcat), r.fcatExit || '',
    p(r.curve?.[3]), p(r.curve?.[5]), p(r.curve?.[10]), r.btsab ?? '', p(r.peak), p(r.worst), p(r.pcat), p(r.ruleSim?.pnl), r.ruleSim ? (r.ruleSim.open ? 'holding at 15 s' : `${r.ruleSim.how} at ${r.ruleSim.sec}s`) : '', r.shape || '', p(r.prediction?.fcat), r.coin?.holders ?? '', r.coin?.marketCapUsd != null ? Math.round(r.coin.marketCapUsd) : '', r.coin?.ageSec != null ? Math.round(r.coin.ageSec / 60) : '',
    r.latency?.detectBlocks ?? '', r.premiumDef || 'cost', p(r.costPremium), r.buyFeeSol ?? '', r.sellFeeSol ?? '', r.holderVerdict?.heldUsd != null ? (r.holderVerdict.safe ? 'SAFE' : 'RISKY') : '', r.holderVerdict?.heldUsd != null ? Math.round(r.holderVerdict.heldUsd) : '', r.holderVerdict?.heldUsd != null ? r.holderVerdict.required : '', p(r.holderVerdict?.devPct),
    p(r.exitAlt?.costStop?.pnl), ex(r.exitAlt?.costStop), p(r.exitAlt?.holders?.pnl), ex(r.exitAlt?.holders),
    ...Array.from({ length: 16 }, (_, s) => p(r.curve?.[s]))].map(q).join(','));
  return [cols.join(','), ...rows].join('\n') + '\n';
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
  if (rec.delaySec != null || rec.entryGap != null) n.push(`Execution latency ${rec.delaySec ?? '?'} s, entry premium ${pct(rec.entryGap)} over Decu's price${rec.entryGap > 0.9 ? ' (very high: most of his move was gone)' : rec.entryGap != null && rec.entryGap < 0.4 ? ' (good entry)' : ''}.`);
  n.push(rec.hisSoldAtSec != null ? `Decu sold ${rec.hisSoldAtSec}s after the bot's buy (${Math.round((rec.hisSoldAtSec + Math.max(0, rec.delaySec ?? 0)) * 10) / 10}s after his own).` : 'Decu was still holding when the 15 s study ended.');
  if (rec.btsab != null) n.push(`Best moment: ${rec.btsab}s at ${pct(rec.peak)}; ${rec.peak >= gainGatePct / 100 ? `reached +${gainGatePct}% → sells 15 s after Decu's buy` : `never +${gainGatePct}% → the bot holds for his sell`}.`);
  const base = c.find((v) => v != null);
  if (base != null) { const hit = c.findIndex((v) => v != null && (1 + v) / (1 + base) - 1 <= -stopLossPct / 100); n.push(hit >= 0 ? `Organic -${stopLossPct}% stop would sell at ${hit}s.` : `Organic -${stopLossPct}% stop not hit in 15s.`); }
  if (rec.entryGap != null) n.push(`The ${maxPayPct}% entry-premium filter would have ${rec.entryGap > maxPayPct / 100 ? 'SKIPPED' : 'TAKEN'} this buy (FCAT ${pct(rec.fcat)}).`);
  const rs = rec.ruleSim, alt = (x) => (x == null ? null : x.open ? `still holding at 15 s (${pct(x.pnl)})` : `${x.how} at ${x.sec}s → ${pct(x.pnl)}`);
  const vs = (x) => (x && rs && Number.isFinite(x.pnl) && Number.isFinite(rs.pnl) ? ` (${x.pnl >= rs.pnl ? '+' : ''}${((x.pnl - rs.pnl) * 100).toFixed(1)} pts vs your rules)` : '');
  if (rec.exitAlt?.costStop) n.push(`Test c, stop -20% on your money: ${alt(rec.exitAlt.costStop)}${vs(rec.exitAlt.costStop)}.`);
  if (rec.exitAlt) n.push(rec.exitAlt.holders ? `Test d, holder momentum: ${alt(rec.exitAlt.holders)}${vs(rec.exitAlt.holders)}.` : 'Test d, holder momentum: no holder data for this coin (left out, not counted as zero).');
  const hv = rec.holderVerdict;
  if (hv?.heldUsd != null) n.push(hv.safe ? `Holder money (dev excluded) ${usd(hv.heldUsd)} supports this ${usd(hv.mcapUsd)} mcap${hv.ceilingUsd ? `; a ${usd(hv.ceilingUsd)} mcap needs more` : ''}: SAFE.` : `Holder money (dev excluded) ${usd(hv.heldUsd)} is behind this ${usd(hv.mcapUsd)} mcap (needs ${usd(hv.required)}): RISKY${hv.devPct > 0.2 ? `; the dev holds ${(hv.devPct * 100).toFixed(0)}% of the coin` : ''}.`);
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
    sm.filtered ? `With the ${sm.filtered.pct}% entry-premium filter: ${sol(sm.filtered.pnlSol)} SOL (${sm.filtered.wins}/${sm.filtered.trades} wins)${sm.fcatAll.skipped ? ` | incl. ${sm.fcatAll.skipped} skipped buys: ${sol(sm.fcatAll.pnlSol)} SOL` : ''}` : null,
    `Best fixed sell: ${b.sec}s after buy → ${sol(b.pnlSol)} SOL total (${b.wins}/${b.trades} wins)`,
    `Best take-profit: sell at ${pct(t.tp)} else at 15s → ${sol(t.pnlSol)} SOL (${t.wins}/${t.trades})`,
    `Best TP+stop: ${pct(ts.tp)} / ${pct(ts.sl)} → ${sol(ts.pnlSol)} SOL (${ts.wins}/${ts.trades})`,
    `3CAT ${sol(sm.cat['3CAT'].pnlSol)} | 5CAT ${sol(sm.cat['5CAT'].pnlSol)} | 10CAT ${sol(sm.cat['10CAT'].pnlSol)} SOL`,
    `BAND (10% of his size, ${sm.bandSpentSol.toFixed(2)} SOL spent): best second ${sol(b.bandPnlSol)} | best TP ${sol(t.bandPnlSol)} | 5CAT ${sol(sm.cat['5CAT'].bandPnlSol)} SOL`,
    `PCAT (his price) ${sol(sm.pcat.pnlSol)} SOL | median BTSAB ${sm.medianBtsab ?? '—'}s, peak ${pct(sm.medianPeak)}, entry premium ${pct(sm.medianEntryGap)}, execution latency ${sm.medianDelaySec ?? '—'} s`,
  ].filter((x) => x != null).join('\n');
}

/**
 * createStudy({file, quoteSell, notify, meta, ...}).start({...}) after each confirmed bot buy.
 * leaderSell(mint, {time, sol, soldRaw}) records his first sell during the window.
 * learnOpts go to the brain (learn.mjs): stopLossPct, gainGatePct, gateSec, maxPayPct, reportEvery.
 */
export function createStudy({ file, quoteSell, notify = null, meta = null, mode = 'paper', buySol = 0.1, feeSol = 0.0015, slip = 0.005, windowSec = 15, stepMs = 1000, quoteTimeoutMs = 2500, maxConcurrent = 5, label = 'Decu', bandPct = 0.1, notesOpts = {}, learnOpts = {}, skippedAlerts = true, coinCharts = true, reportPcts = [], holderRule = HOLDER_RULES, sampleHolders = null, holderEverySec = 5, onRecord = null, tailSec = 60, tailStepMs = 2000, poolFee = 0.0125, log = () => {} }) {
  const sellFee = () => (typeof feeSol === 'function' ? feeSol() : feeSol);
  const filterPct = notesOpts.maxPayPct ?? 60;
  const ruleOpts = { stopLossPct: notesOpts.stopLossPct ?? 20, gainGatePct: notesOpts.gainGatePct ?? 15, gateSec: learnOpts.gateSec ?? windowSec };
  const brain = createBrain({ buySol, ...ruleOpts, maxPayPct: learnOpts.maxPayPct ?? 0, reportEvery: learnOpts.reportEvery ?? 10, digestHours: learnOpts.digestHours ?? 24, holderRules: holderRule, filterPcts: reportPcts });
  const filterLabels = (gap) => [...new Set([...reportPcts, filterPct])].sort((a, b) => a - b).map((p) => `${p}%${p === filterPct ? ' (trading)' : ''} ${gap == null ? '—' : gap <= p / 100 + 1e-9 ? 'TAKE' : 'SKIP'}`).join(' · ');
  const alertSkipped = (gap) => skippedAlerts === true || skippedAlerts === 'true' || (skippedAlerts === 'report' && gap != null && reportPcts.length > 0 && gap <= Math.max(...reportPcts) / 100 + 1e-9);
  const records = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      // a TAIL line adds the price path after the 15 s study (for the buy-the-dip test) to its trade
      if (o.patch === 'tail') { const r = records.findLast((x) => x.mint === o.mint && x.time === o.time); if (r) { r.tail = o.tail; if (o.extra) Object.assign(r, o.extra); } continue; }
      records.push(o);
    }
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
    const curve = st.values.map((v) => (v == null ? null : (v * (1 - slip) - st.sellFee - st.cost) / st.cost));
    if (st.holderPending.length) await Promise.race([Promise.allSettled(st.holderPending), new Promise((r) => setTimeout(r, quoteTimeoutMs))]);
    const known = curve.map((v, s) => [v, s]).filter(([v]) => v != null);
    const [peak, btsab] = known.length ? known.reduce((a, b) => (b[0] > a[0] ? b : a)) : [null, null];
    const [worst, worstAt] = known.length ? known.reduce((a, b) => (b[0] < a[0] ? b : a)) : [null, null];
    const botPrice = st.cost / st.raw;
    // Entry premium and latency: vs the Decu buy the bot copied. PCAT: vs his FIRST buy (his real entry).
    const hisPrice = st.his.sol > 0 && st.his.raw > 0 ? st.his.sol / st.his.raw : null;
    const f = st.his.first, firstPrice = f?.sol > 0 && f.raw > 0 ? f.sol / f.raw : hisPrice;
    const delaySec = st.his.time ? Math.round((st.startedAt / 1000 - st.his.time) * 10) / 10 : null;
    let pcat = null, pcatExit = null, exitPrice = null;
    if (firstPrice) {
      const hs = st.hisSell;
      exitPrice = hs && hs.sol > 0 && hs.soldRaw > 1000 ? hs.sol / hs.soldRaw /* a placeholder amount ('1') is never a price */ : st.values.findLast((v) => v != null) / st.raw;
      if (Number.isFinite(exitPrice)) { pcat = exitPrice / firstPrice - 1 - (2 * st.sellFee) / buySol; pcatExit = hs ? `his sell at ${hs.atSec}s` : '15s mark'; }
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
      // Entry premium is PRICE vs PRICE (the bot's price into the curve vs Decu's, both without fees);
      // costPremium includes every fee. Older records (premiumDef missing) used the cost basis.
      entryGap: hisPrice ? (st.entryPrice > 0 ? st.entryPrice : botPrice) / hisPrice - 1 : null, premiumDef: st.entryPrice > 0 ? 'price' : 'cost',
      costPremium: hisPrice ? botPrice / hisPrice - 1 : null, buyFeeSol: st.fill?.buyFeeSol ?? null, sellFeeSol: st.sellFee, actualFill: !!st.fill?.actualFill,
      holderPath: st.holderPath.length ? st.holderPath.sort((a, b) => a.s - b.s) : null, cost: st.cost, curve, fcat, fcatSec, fcatExit, btsab, peak, worst, worstAt, pcat, pcatExit,
      hisSoldAtSec: st.hisSell?.atSec ?? null, bandSol: st.his.sol > 0 ? st.his.sol * bandPct : null,
      taken: !st.shadow, skipReason: st.shadow || null, latency: st.his.latency || null, hisTime: st.his.time ?? null,
      // prices for the $10 mirror (brain.mjs): his copied buy, the bot's entry, the exit (his sell or the 15 s mark)
      hisPrice, entryPrice: st.entryPrice > 0 ? st.entryPrice : botPrice, exitPrice: Number.isFinite(exitPrice) ? exitPrice : null,
      // the price per raw token each second (from the sell quote, pool fee added back): the buy-the-dip test
      px: st.values.map((v) => (Number.isFinite(v) && v > 0 ? Math.round((v / st.raw / (1 - poolFee)) * 1e18) / 1e18 : null)),
      // Decu's market cap when he bought, from his own trade's curve numbers (what a skip rule can know in time)
      hisMcapUsd: st.his.vSol > 0 && st.his.vTok > 0 && st.his.usd > 0 && st.his.sol > 0 ? Math.round((st.his.vSol / st.his.vTok) * 1e6 * (st.his.usd / st.his.sol)) : null,
      // trades by others that landed between his buy and yours (runtime: note(mint, {crowd}))
      crowd: st.extra?.crowd ?? null,
      copiedLaterBuy: !!(f && f.time && st.his.time && st.his.time - f.time > 1), hisFirstTime: f?.time ?? null,
      coin: m ? { holders: m.holders ?? null, marketCapUsd: m.marketCapUsd ?? null, ageSec: m.createdTime ? Math.round(st.startedAt / 1000 - m.createdTime) : null } : null,
    };
    enrich(rec, records);
    // your holder rule at the buy: the first sample (holder money = every wallet except the dev and the curve)
    const h0 = rec.holderPath?.find((x) => Number.isFinite(x.valueUsd) && Number.isFinite(x.mcapUsd));
    const v0 = h0 && holderVerdict(h0.valueUsd, h0.mcapUsd, holderRule);
    rec.holderVerdict = v0 ? { ...v0, holders: h0.holders ?? null, devPct: h0.devPct ?? null, devKnown: h0.devKnown ?? null } : null;
    // Paper tests of two other exits on this same trade: (c) the -20% stop counted on your money,
    // (d) your holder rule as a momentum exit. Both still keep his sell; the stop always sells.
    const xo = { ...ruleOpts, holderRules: holderRule };
    rec.exitAlt = { costStop: exitSim(rec, { costStop: 0.2 }, xo), holders: exitSim(rec, { holders: true }, xo) };
    rec.notes = tradeNotes(rec, [...records, rec], notesOpts);
    records.push(rec);
    if (records.length > 5000) records.shift();
    const learned = brain.observe(rec, records);
    rec.thinking = brain.thinkingNotes(rec, learned, records);
    rec.prediction = learned.prediction ? { fcat: learned.prediction.fcat, right: learned.prediction.win === rec.fcat > 0 } : null;
    try { fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o600 }); } catch (e) { log(`study journal unavailable: ${e.message}`); }
    if (onRecord) { try { onRecord(rec); } catch (e) { log(`brain: ${e.message}`); } }
    startTail(st, rec);
    if (notify) {
      const name = rec.symbol ? `$${rec.symbol}` : `${st.mint.slice(0, 6)}…`;
      const at = (s) => (curve[s] == null ? '—' : pct(curve[s]));
      const lessons = brain.lessons();
      const body = [
        rec.copiedLaterBuy ? `Copied a LATER buy of Decu's (his first buy of this coin was ${Math.round((rec.hisTime - rec.hisFirstTime) / 60)} min earlier). Latency and entry premium are vs the copied buy; PCAT is vs his first buy.` : null,
        st.shadow ? `NOT BOUGHT (${st.shadow}). Studied anyway with a ${buySol} SOL quote: what it would have done.` : null,
        `${label} bought ${st.his.sol?.toFixed(3) ?? '?'} SOL${st.his.usd ? ` ($${Math.round(st.his.usd)})` : ''} · execution latency ${rec.delaySec ?? '?'} s · entry premium ${pct(rec.entryGap)}${rec.premiumDef === 'price' ? ' (price vs price)' : ''}${rec.buyFeeSol != null ? ` · fees ${sol(-(rec.buyFeeSol + rec.sellFeeSol))} SOL (${((rec.buyFeeSol + rec.sellFeeSol) / buySol * 100).toFixed(1)}% of the trade, buy+sell)` : ''}`,
        `Filters: ${filterLabels(rec.entryGap)}`,
        rec.holderVerdict?.heldUsd != null ? holderLine(rec.holderVerdict) : null,
        latencyLine(rec.latency),
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
        summaryText(summarize(records, { buySol, filterPct })),
        lessons.length ? `Patterns (${lessons.length}): ${lessons.slice(0, 3).map((g) => `${g.status === 'confirmed' ? '✔' : '…'}${g.dev >= 0 ? '▲' : '▼'} ${g.label} ${pct(g.avg, 0)} (${g.n})`).join(' | ')}` : 'Patterns: none strong enough yet.',
        brain.journeyLine(records),
        mode === 'live' ? '' : 'No real money used.',
        `Token: ${st.mint}`,
      ].filter((x) => x != null).join('\n');
      const tradeAlert = !st.shadow || alertSkipped(rec.entryGap) ? Promise.resolve(notify({ title: `${tag}${st.shadow ? 'SKIPPED ' : ''}${name} FCAT ${pct(fcat)} | BTSAB ${btsab ?? '—'}s ${pct(peak)}`, body, priority: st.shadow ? 2 : 3, tags: ['bar_chart'], click: `https://pump.fun/coin/${st.mint}`, image: tradeChart(rec, ruleOpts.gainGatePct, ruleOpts.stopLossPct) })).catch(() => {}) : Promise.resolve();
      // THE PER-COIN CHART of a bought trade: its own notification, right after the trade alert
      if (!st.shadow && coinCharts) tradeAlert.then(() => send({ title: `${tag}${name} chart · FCAT ${pct(fcat)} · 3CAT ${at(3)} · 5CAT ${at(5)} · 10CAT ${at(10)} · PCAT ${pct(pcat)}`, body: coinChartText(rec, records, { gatePct: ruleOpts.gainGatePct, stopPct: ruleOpts.stopLossPct, buySol }), priority: 3, tags: ['chart_with_upwards_trend'], click: `https://pump.fun/coin/${st.mint}`, image: coinChart(rec, records, { gatePct: ruleOpts.gainGatePct, stopPct: ruleOpts.stopLossPct }), kind: 'trade-chart' }));
      // What the brain decided is worth its own alert: new / confirmed / faded patterns, streaks,
      // level-ups, the learning report every 10 trades and the daily digest.
      for (const e of learned.events) send({ title: `${tag}${e.title}`, body: e.body + (mode === 'live' ? '' : '\nNo real money used.'), priority: e.priority, tags: e.tags, image: ['report', 'level', 'digest', 'streak'].includes(e.kind) ? historyChart(records) : undefined });
    }
    return rec;
  }

  // THE TAIL: after the 15 s study, the price keeps being read every tailStepMs until tailSec after Decu's
  // buy (one quote each, ~23 more), and his first sell is caught, for the buy-the-dip test. The trade is
  // already in the journal; the tail is appended as its own line when done (merged back at load).
  const tails = new Map();
  function startTail(st, rec) {
    const delay = Math.max(0, rec.delaySec ?? 0), endAt = st.startedAt + (tailSec - delay) * 1000;
    // he already sold inside the 15 s: the dip test has its exit, nothing more to read
    if (!(tailSec > windowSec) || st.hisSell || Date.now() >= endAt || tails.size >= 8) return; // at most 8 at once (2 s apart: ≤ 4 reads a second)
    const tail = { px: [], hisSell: null };
    const t = { st, rec, tail, at: st.startedAt / 1000, extra: null };
    tails.set(st.mint, t);
    const step = async () => {
      if (Date.now() >= endAt || tail.hisSell) {
        tails.delete(st.mint); rec.tail = tail;
        try { fs.appendFileSync(file, JSON.stringify({ patch: 'tail', mint: rec.mint, time: rec.time, tail, ...(t.extra ? { extra: t.extra } : {}) }) + '\n', { mode: 0o600 }); } catch {}
        return;
      }
      const v = await Promise.race([quoteSell(st.mint, st.raw).then((x) => (Number.isFinite(x) ? x : null)).catch(() => null), new Promise((r) => setTimeout(() => r(null), quoteTimeoutMs).unref?.())]);
      if (v > 0) tail.px.push([Math.round((Date.now() - st.startedAt) / 100) / 10, v / st.raw / (1 - poolFee)]);
      setTimeout(step, tailStepMs).unref?.();
    };
    setTimeout(step, tailStepMs).unref?.();
  }

  return {
    records,
    active,
    tails,
    /** Facts learned while a study runs (the crowd count): kept on the trade's record. */
    note(mint, fields) { const st = active.get(mint); if (st) st.extra = { ...(st.extra || {}), ...fields }; else { const t = tails.get(mint); if (t) { Object.assign(t.rec, fields); t.extra = { ...(t.extra || {}), ...fields }; } } },
    brain,
    summary: () => summarize(records, { buySol, filterPct }),
    research: () => ({ ...research(records, { buySol, filterPct, reportPcts }), brain: brain.snapshot(records).journey }),
    learning: () => brain.snapshot(records),
    /** Begin a 15 s study of a position the bot just bought. Returns a promise of the record. */
    start({ mint, cost, raw, his = {}, shadow = null, entryPrice = null, fill = null }) {
      if (active.has(mint) || active.size >= maxConcurrent || !(cost > 0) || !(Number(raw) > 0)) return null;
      const st = { mint, cost, raw: Number(raw), his, values: [], startedAt: Date.now(), hisSell: null, shadow, entryPrice, fill, sellFee: sellFee(), holderPath: [], holderPending: [] };
      // Holder lookups cost data credits: every bought coin, and skipped ones only inside the widest
      // reported filter (the ones the filters and the holder rule are compared on).
      const hisPx = his?.sol > 0 && his?.raw > 0 ? his.sol / his.raw : null, gap0 = hisPx && entryPrice > 0 ? entryPrice / hisPx - 1 : null;
      const holdersHere = sampleHolders && (!shadow || (gap0 != null && gap0 <= Math.max(filterPct, ...reportPcts) / 100 + 1e-9));
      active.set(mint, st);
      return new Promise((resolve) => {
        let s = 0;
        const tick = async () => {
          const due = st.startedAt + s * stepMs;
          // holder money + market cap every holderEverySec (in parallel; never delays the price samples)
          if (holdersHere && s % holderEverySec === 0) { const at = s; st.holderPending.push(timed(sampleHolders(mint)).then((h) => { if (h) st.holderPath.push({ s: at, holders: h.holders ?? null, mcapUsd: h.mcapUsd ?? null, valueUsd: h.valueUsd ?? null, devPct: h.devPct ?? null, devKnown: h.devKnown ?? null }); }).catch(() => {})); }
          st.values[s] = await timed(quoteSell(mint, st.raw).then((v) => (Number.isFinite(v) ? v : null)).catch(() => null));
          s++;
          if (s > windowSec) return resolve(await finish(st)); // hard stop: never studies a coin longer than the window
          setTimeout(tick, Math.max(0, due + stepMs - Date.now()));
        };
        tick();
      });
    },
    leaderSell(mint, { time, sol: received, soldRaw }) {
      const t = tails.get(mint);
      if (t && !t.tail.hisSell && Number(soldRaw) > 1000 && Number(received) > 0) t.tail.hisSell = { atSec: Math.round(((time || Date.now() / 1000) - t.at) * 10) / 10, price: Number(received) / Number(soldRaw) };
      const st = active.get(mint);
      if (!st || st.hisSell) return;
      st.hisSell = { sol: Number(received) || 0, soldRaw: Number(soldRaw) || 0, atSec: Math.round(((time || Date.now() / 1000) - st.startedAt / 1000) * 10) / 10 };
    },
  };
}
