// CHARTS AND ANALYSIS FOR THE SECOND BRAIN: every new bought trade gets its own charts and a detailed write-up
// in its Obsidian note; every day and the whole history get comparison charts and the profit missed on delays.
//
// Charts are Chart.js 2.9 configs rendered to PNG by QuickChart (POST, so size is no problem) and saved INSIDE
// the vault (machine/charts/), so they show offline, in the zip and through the GitHub sync. A chart that can't
// be rendered falls back to its online QuickChart link (when the link is short enough), never to nothing silently.
// Only % / SOL / $ numbers leave the bot (no keys, no wallet). Colours: blue = made money / the measure,
// red = lost money, aqua = Decu, gray = fees and reference lines; every mark is also named in text.
//
// "Missed on the delay" = what Decu's own entry price would have made with the SAME exit, minus what yours made:
//   per trade: the $10 mirror's delay cost when recorded (newer trades), else PCAT − FCAT (his first-buy price vs
//   your result, both after the same fees) at the trade size. Values beyond ±1000% are data errors and left out.

import { exitSim, EXIT_STRATEGIES } from './learn.mjs';
import { pricePath, hisExit, mcapAtHisBuy } from './tests.mjs';

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const r1 = (x) => (fin(x) ? Math.round(x * 10) / 10 : null), r2 = (x) => (fin(x) ? Math.round(x * 100) / 100 : null), r4 = (x) => (fin(x) ? Math.round(x * 1e4) / 1e4 : null);
const pct = (x, d = 1) => (!fin(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const usd = (x) => (!fin(x) ? '—' : `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`);
const sol = (x) => (!fin(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(4)} SOL`);
const mean = (xs) => { const v = xs.filter(fin); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null; };
const coin = (r) => (r.symbol ? `$${r.symbol}` : r.mint.slice(0, 6));
const bought = (records) => records.filter((r) => r.taken !== false && !r.skipReason && fin(r.fcat));
const C = { blue: '#2a78d6', red: '#e34948', aqua: '#1baf7a', gray: '#898781', dark: '#52514e', grid: '#e1e0d9', ink: '#0b0b0b' };
const axes = (yLabel, xRot = 40) => ({ xAxes: [{ gridLines: { display: false }, ticks: { fontColor: C.dark, autoSkip: false, maxRotation: xRot } }], yAxes: [{ gridLines: { color: C.grid, zeroLineColor: C.dark }, ticks: { fontColor: C.dark, beginAtZero: true }, scaleLabel: { display: true, labelString: yLabel, fontColor: C.dark } }] });
const title = (lines) => ({ display: true, fontColor: C.ink, fontSize: 13, text: lines });
const signColor = (v) => (v >= 0 ? C.blue : C.red);
/** A chart to render: {name (file stem), width, height, config}. */
const spec = (name, config, width = 760, height = 440) => ({ name, width, height, config });

/** A GET QuickChart URL the bot already builds (price path, $10 mirror) as a chart spec. */
export function specFromUrl(name, url) {
  try { const u = new URL(url); return spec(name, JSON.parse(u.searchParams.get('c')), Number(u.searchParams.get('w')) || 760, Number(u.searchParams.get('h')) || 440); } catch { return null; }
}
/** The online link of a chart (the fallback when it can't be saved as a picture). */
export const chartUrl = (s) => `https://quickchart.io/chart?w=${s.width}&h=${s.height}&bkg=white&c=${encodeURIComponent(JSON.stringify(s.config))}`;

// ---------- per trade ----------
/** Missed on the delay for one trade, as a fraction of the trade (null when unknown). */
export function missedFrac(r, m = null) {
  if (m && fin(m.delayUsd) && m.size > 0) return -m.delayUsd / m.size;
  return fin(r.pcat) && fin(r.fcat) && Math.abs(r.pcat) < 10 ? r.pcat - r.fcat : null;
}

/** What each entry moment would have made with the SAME exit (at $10, before network fees): Decu's price, your
 *  entry, then every recorded price after it. The cost of each second of delay, read off one chart. */
export function entryMoments(r, { size = 10, poolFee = 0.0125 } = {}) {
  const ex = hisExit(r) || (fin(r.exitPrice) ? { at: null, price: r.exitPrice } : null);
  if (!ex || !(r.hisPrice > 0) || !(r.entryPrice > 0)) return [];
  const keep = (1 - poolFee) ** 2, at = (p) => (keep * (ex.price / p) - 1) * size, delay = Math.max(0, r.delaySec ?? 0);
  const out = [{ label: 'Decu\'s price (0 s)', t: 0, usd: at(r.hisPrice), kind: 'decu' }, { label: `your entry (${delay.toFixed(1)} s)`, t: delay, usd: at(r.entryPrice), kind: 'you' }];
  for (const [s, p] of pricePath(r)) { if (s < 1) continue; if (ex.at != null && s >= ex.at) break; out.push({ label: `+${Math.round(s + delay)} s`, t: s + delay, usd: at(p), kind: 'later' }); }
  return out.slice(0, 30);
}
export function entryDelayChart(r, moments) {
  if (moments.length < 2) return null;
  const decu = moments[0].usd, you = moments[1].usd;
  return spec('delay', { type: 'bar', data: { labels: moments.map((x) => x.label), datasets: [
    { label: '$ result of $10 bought at this moment (same exit)', data: moments.map((x) => r2(x.usd)), backgroundColor: moments.map((x) => (x.kind === 'decu' ? C.aqua : x.kind === 'you' ? signColor(x.usd) : x.usd >= 0 ? '#9cc3ef' : '#f1a3a2')) },
    { label: 'Decu\'s result (his price)', type: 'line', data: moments.map(() => r2(decu)), borderColor: C.aqua, borderDash: [6, 4], pointRadius: 0, fill: false },
  ] }, options: { title: title([`${coin(r)}: what the delay cost · Decu ${usd(decu)} vs your entry ${usd(you)} on $10 (${usd(you - decu)})`, 'each bar: $10 bought at that moment, same exit, before network fees', 'light bars: buying even later']), legend: { position: 'bottom' }, scales: axes('$ on a $10 trade', 60) } });
}

/** Every exit strategy on this trade's recorded path (sell lands 1 s after the decision), plus the best second. */
export function exitResults(r, { stopLossPct = 20, gainGatePct = 15, gateSec = 15 } = {}) {
  const xo = { stopLossPct, gainGatePct, gateSec };
  const c = r.curve || [];
  const out = EXIT_STRATEGIES.map((e) => {
    const x = exitSim(r, e.strat, xo); if (!x) return null;
    // a second with no recorded price: the exit happened at the next second that had one, and the table says so
    const gap = e.strat.fixed != null && c[e.strat.fixed] == null && x.sec != null && x.sec !== e.strat.fixed ? ` (no price at ${e.strat.fixed} s; first price at ${x.sec} s)` : '';
    return { name: e.name, pnl: x.pnl, how: x.open ? 'still holding at 15 s' : `${x.how} at ${x.sec}s${gap}` };
  }).filter(Boolean);
  if (fin(r.fcat)) out.push({ name: 'FCAT (sell at his sell / 15 s)', pnl: r.fcat, how: r.fcatExit || '' });
  if (fin(r.peak)) out.push({ name: `best second (${r.btsab ?? '?'} s, hindsight)`, pnl: r.peak, how: 'hindsight' });
  if (fin(r.pcat) && Math.abs(r.pcat) < 10) out.push({ name: 'PCAT (Decu\'s own price)', pnl: r.pcat, how: r.pcatExit || '' });
  return out.sort((a, b) => b.pnl - a.pnl);
}
export function exitsChart(r, exits) {
  if (!exits.length) return null;
  return spec('exits', { type: 'horizontalBar', data: { labels: exits.map((e) => e.name), datasets: [{ label: 'profit % after fees', data: exits.map((e) => r1(e.pnl * 100)), backgroundColor: exits.map((e) => (/PCAT/.test(e.name) ? C.aqua : /hindsight/.test(e.how) ? C.gray : signColor(e.pnl))) }] },
    options: { legend: { display: false }, title: title([`${coin(r)}: every exit on this trade, best to worst`, 'aqua = at Decu\'s price · gray = the best second (only known afterwards)']), scales: { xAxes: [{ gridLines: { color: C.grid, zeroLineColor: C.dark }, ticks: { fontColor: C.dark, beginAtZero: true }, scaleLabel: { display: true, labelString: 'profit % after fees', fontColor: C.dark } }], yAxes: [{ gridLines: { display: false }, ticks: { fontColor: C.dark } }] } } }, 760, 480);
}

/** This trade next to the last 30 bought trades and the winners among them. */
export function historyComparison(r, records) {
  const prev = bought(records).filter((x) => x !== r && Date.parse(x.time) < Date.parse(r.time)).slice(-30), wins = prev.filter((x) => x.fcat > 0);
  const metrics = [['FCAT', (x) => x.fcat], ['3CAT', (x) => x.curve?.[3]], ['5CAT', (x) => x.curve?.[5]], ['10CAT', (x) => x.curve?.[10]], ['best second', (x) => x.peak], ['PCAT (his price)', (x) => (Math.abs(x.pcat) < 10 ? x.pcat : null)], ['entry premium', (x) => x.entryGap], ['missed on delay', (x) => missedFrac(x)]];
  return { n: prev.length, wins: wins.length, rows: metrics.map(([label, f]) => ({ label, trade: f(r), last30: mean(prev.map(f)), winners: mean(wins.map(f)) })) };
}
export function historyChart(r, cmp) {
  if (!cmp.n) return null;
  const ds = (label, key, color) => ({ label, data: cmp.rows.map((x) => r1(fin(x[key]) ? x[key] * 100 : null)), backgroundColor: color });
  return spec('vs-history', { type: 'bar', data: { labels: cmp.rows.map((x) => x.label), datasets: [ds(`this trade (${coin(r)})`, 'trade', C.blue), ds(`average of the last ${cmp.n}`, 'last30', C.gray), ds(`average of those ${cmp.wins} winners`, 'winners', C.aqua)] },
    options: { title: title([`${coin(r)} vs your history (%)`, 'missed on delay = Decu\'s price result − yours (positive = profit the delay took)']), legend: { position: 'bottom' }, scales: axes('%') } });
}

/** Setups like this one: same entry-premium band, same market-cap group, same Decu size group. */
export function similarTrades(r, records) {
  const prev = bought(records).filter((x) => x !== r && Date.parse(x.time) < Date.parse(r.time));
  const band = (g) => (g == null ? null : Math.floor(g * 20) / 20), mc = (x) => { const v = mcapAtHisBuy(x); return v == null ? null : v < 10e3 ? '<$10k' : v < 20e3 ? '$10–20k' : v < 30e3 ? '$20–30k' : v < 100e3 ? '$30–100k' : '$100k+'; };
  const size = (x) => (x.hisSol == null ? null : x.hisSol < 1 ? '<1 SOL' : x.hisSol < 2.5 ? '1–2.5 SOL' : x.hisSol < 4 ? '2.5–4 SOL' : '4+ SOL');
  const group = (label, f) => { const v = f(r); if (v == null) return null; const xs = prev.filter((x) => f(x) === v); return { label: `${label} ${typeof v === 'number' ? `${Math.round(v * 100)}–${Math.round(v * 100) + 5}%` : v}`, n: xs.length, wins: xs.filter((x) => x.fcat > 0).length, avg: mean(xs.map((x) => x.fcat)), missed: mean(xs.map((x) => missedFrac(x))) }; };
  return [group('entry premium', (x) => band(x.entryGap)), group('market cap at his buy', mc), group('Decu bought', size)].filter(Boolean);
}

/** Where this trade ranks among all bought trades (0–100: share of trades it beat). */
export function percentile(r, records) {
  const xs = bought(records).map((x) => x.fcat);
  return xs.length ? Math.round((xs.filter((v) => v < r.fcat).length / xs.length) * 100) : null;
}

/** The full analysis of one trade as markdown (the note's middle part) + the charts to render for it. */
export function tradeAnalysis(r, records, { mirror = null, mirrorUrl = null, pathUrl = null, rules = {}, poolFee = 0.0125 } = {}) {
  const moments = entryMoments(r, { poolFee }), exits = exitResults(r, rules), cmp = historyComparison(r, records), similar = similarTrades(r, records);
  const miss = missedFrac(r, mirror), rank = percentile(r, records), best = exits.find((e) => e.how !== 'hindsight' && !/PCAT/.test(e.name));
  const pathSpec = pathUrl ? specFromUrl('price', pathUrl) : null, mirrorSpec = mirrorUrl ? specFromUrl('mirror', mirrorUrl) : null;
  const charts = [pathSpec, entryDelayChart(r, moments), mirrorSpec, exitsChart(r, exits), historyChart(r, cmp)].filter(Boolean);
  const c = r.curve || [], dd = c.filter(fin).length ? Math.min(...c.filter(fin)) : null;
  const md = [
    '## Verdict',
    `- **${r.fcat > 0 ? 'WON' : 'LOST'} ${pct(r.fcat)}** (FCAT)${mirror ? ` · ${usd(mirror.yourUsd)} on a $10 trade before fees, ${usd(mirror.afterFeesUsd)} after` : ''}${rank != null ? ` · better than ${rank}% of all bought trades` : ''}.`,
    miss != null ? `- **Missed on the delay: ${pct(miss)} of the trade${mirror ? ` = ${usd(-mirror.delayUsd)} on $10` : ''}.** Decu's own price made ${pct(fin(r.pcat) && Math.abs(r.pcat) < 10 ? r.pcat : null)} (PCAT) with ${mirror ? 'the same exit' : 'his exit'}.` : null,
    best ? `- Best exit you could have chosen by rule: **${best.name}** ${pct(best.pnl)} (${best.how}) vs your result ${pct(r.fcat)}${fin(r.peak) ? `; the best second (only known afterwards) was ${r.btsab ?? '?'} s at ${pct(r.peak)}` : ''}.` : null,
    '',
    '## The delay, step by step',
    `- Decu bought ${fin(r.hisSol) ? r.hisSol.toFixed(3) : '?'} SOL${fin(r.hisUsd) ? ` ($${Math.round(r.hisUsd)})` : ''}. The bot saw it ${r.latency?.detectBlocks != null ? `${r.latency.detectBlocks} block(s) after his` : '—'} and bought ${r.delaySec ?? '?'} s${r.latency?.blocksAfter != null ? ` / ${r.latency.blocksAfter} blocks` : ''} after him${r.latency?.simulatedMs ? ` (incl. ${r.latency.simulatedMs} ms simulated paper wait)` : ''}.`,
    r.latency ? `- Bot timing: seen → decoded ${r.latency.decodeMs ?? '—'} ms · decided ${r.latency.decideMs ?? '—'} ms · built ${r.latency.buildMs ?? '—'} ms · landed ${r.latency.landMs ?? '—'} ms · total ${r.latency.botMs ?? '—'} ms (${r.latency.source || r.latency.route || 'source —'}).` : null,
    r.crowd ? `- Place in line: **#${r.crowd.place}** — ${r.crowd.trades} trade(s) by others landed between his buy and yours${r.crowd.sol != null ? `, putting ${r.crowd.sol} SOL into the coin` : ''}${r.crowd.exact ? '' : ' (paper estimate)'}.` : null,
    `- You paid **${pct(r.entryGap)}** ${r.entryGap >= 0 ? 'more' : 'less'} than Decu per token (price vs price)${mirror ? `: on $10 that is ${usd(mirror.delayUsd)} before anything else happened` : ''}.`,
    moments.length > 2 ? `- Buying later would have made: ${moments.slice(2, 8).map((x) => `${x.label} ${usd(x.usd)}`).join(' · ')} (same exit, $10, before fees).` : null,
    mirror && fin(mirror.feesUsd) ? `- Network fees (priority + tip) cost ${usd(-mirror.feesUsd)} on this trade (${mirror.feeSol.toFixed(4)} SOL, the same at any size).` : null,
    '',
    exits.length ? '## Every exit on this trade' : null,
    exits.length ? '| exit | result | when |\n|---|---|---|' : null,
    ...exits.map((e) => `| ${e.name} | ${pct(e.pnl)} | ${e.how} |`),
    exits.length ? '' : null,
    cmp.n ? `## Compared with your last ${cmp.n} trades` : null,
    cmp.n ? '| measure | this trade | last ' + cmp.n + ' | the ' + cmp.wins + ' winners |\n|---|---|---|---|' : null,
    ...(cmp.n ? cmp.rows.map((x) => `| ${x.label} | ${pct(x.trade)} | ${pct(x.last30)} | ${pct(x.winners)} |`) : []),
    cmp.n ? '' : null,
    similar.length ? '## Setups like this one' : null,
    ...similar.map((g) => `- ${g.label}: ${g.n} earlier trades, ${g.n ? Math.round((g.wins / g.n) * 100) : 0}% won, average FCAT ${pct(g.avg)}, average missed on delay ${pct(g.missed)}`),
    similar.length ? '' : null,
    '## Risk while held',
    `- Worst moment ${pct(r.worst)} at ${r.worstAt ?? '—'} s${dd != null ? `; lowest second ${pct(dd)}` : ''}. Stop −${rules.stopLossPct ?? 20}% from entry: ${c.some((v, s) => fin(v) && fin(c.find(fin)) && (1 + v) / (1 + c.find(fin)) - 1 <= -(rules.stopLossPct ?? 20) / 100) ? 'hit' : 'not hit'} in the first 15 s.`,
    fin(mcapAtHisBuy(r)) ? `- Market cap when Decu bought: $${Math.round(mcapAtHisBuy(r)).toLocaleString('en-US')}${r.coin?.holders != null ? ` · ${r.coin.holders} holders` : ''}${r.coin?.ageSec != null ? ` · ${Math.round(r.coin.ageSec / 60)} min old` : ''}.` : null,
    r.holderVerdict ? `- Holder money rule at the buy: ${r.holderVerdict.safe ? 'SAFE' : 'RISKY'} ($${Math.round(r.holderVerdict.heldUsd ?? 0).toLocaleString('en-US')} held by non-dev holders).` : null,
    '',
    c.length ? '## Every second' : null,
    c.length ? '| second | profit after fees | price per token (SOL) |\n|---|---|---|' : null,
    ...c.map((v, s) => `| ${s}${s === r.btsab ? ' (best)' : ''}${s === r.fcatSec ? ' (exit)' : ''}${r.hisSoldAtSec != null && s === Math.ceil(r.hisSoldAtSec) ? ' (Decu sold)' : ''} | ${pct(v)} | ${fin(r.px?.[s]) ? r.px[s].toExponential(4) : '—'} |`),
  ].filter((x) => x != null).join('\n');
  return { md, charts, moments, exits, cmp, similar, miss };
}

// ---------- per day ----------
export function dayCharts(day, records, mirrorOf = () => null) {
  const rs = bought(records).filter((r) => String(r.time).slice(0, 10) === day);
  if (!rs.length) return [];
  const labels = rs.map((r) => `${String(r.time).slice(11, 16)} ${coin(r)}`);
  const out = [spec('day-compare', { type: 'bar', data: { labels, datasets: [
    { label: 'you (FCAT %)', data: rs.map((r) => r1(r.fcat * 100)), backgroundColor: rs.map((r) => signColor(r.fcat)) },
    { label: 'Decu\'s price (PCAT %)', data: rs.map((r) => r1(Math.abs(r.pcat) < 10 ? r.pcat * 100 : null)), backgroundColor: C.aqua },
    { label: 'missed on the delay (%)', data: rs.map((r) => r1(fin(missedFrac(r, mirrorOf(r))) ? missedFrac(r, mirrorOf(r)) * 100 : null)), backgroundColor: C.gray },
  ] }, options: { title: title([`${day}: every trade, you vs Decu's price`, 'gray = what the delay took from each trade']), legend: { position: 'bottom' }, scales: axes('%', 60) } }, 860, 460)];
  const ms = rs.map((r) => ({ r, m: mirrorOf(r) })).filter((x) => x.m);
  if (ms.length) {
    let a = 0, b = 0, f = 0;
    const cum = ms.map(({ m }) => { a += m.perfectUsd; b += m.yourUsd; f += m.yourUsd - (m.feesUsd || 0); return [r2(a), r2(b), r2(f)]; });
    out.push(spec('day-cumulative', { type: 'line', data: { labels: ms.map(({ r }) => `${String(r.time).slice(11, 16)} ${coin(r)}`), datasets: [
      { label: 'Decu\'s price, $10 a trade', data: cum.map((x) => x[0]), borderColor: C.aqua, fill: false, lineTension: 0 },
      { label: 'you, before fees', data: cum.map((x) => x[1]), borderColor: C.blue, fill: false, lineTension: 0 },
      { label: 'you, after fees', data: cum.map((x) => x[2]), borderColor: C.red, borderDash: [6, 4], fill: false, lineTension: 0 },
    ] }, options: { title: title([`${day}: running total at $10 a trade`, `the gap between aqua and blue = missed on the delay (${usd(a - b)} today)`]), legend: { position: 'bottom' }, scales: axes('$ running total', 60) } }, 860, 440));
  }
  return out;
}

// ---------- the whole history: profit missed on the delays ----------
const bucket = (list, f, defs) => defs.map(([label, test]) => { const xs = list.filter((x) => test(f(x))); return { label, n: xs.length, fcat: mean(xs.map((x) => x.fcat)), pcat: mean(xs.map((x) => (Math.abs(x.pcat) < 10 ? x.pcat : null))), missed: mean(xs.map((x) => missedFrac(x))), premium: mean(xs.map((x) => x.entryGap)) }; }).filter((b) => b.n);
export function delayAnalysis(records, { buySol = 0.1, solUsd = null, mirrorOf = () => null } = {}) {
  const rs = bought(records), withMiss = rs.map((r) => ({ r, miss: missedFrac(r, mirrorOf(r)) })).filter((x) => fin(x.miss));
  const missedSol = withMiss.reduce((a, x) => a + x.miss * buySol, 0), yoursSol = rs.reduce((a, r) => a + r.fcat * buySol, 0);
  const days = [...new Set(rs.map((r) => String(r.time).slice(0, 10)))].sort();
  const perDay = days.map((d) => { const xs = withMiss.filter((x) => String(x.r.time).slice(0, 10) === d); return { day: d, trades: xs.length, missedSol: xs.reduce((a, x) => a + x.miss * buySol, 0), yoursSol: rs.filter((r) => String(r.time).slice(0, 10) === d).reduce((a, r) => a + r.fcat * buySol, 0) }; });
  const blocks = bucket(rs, (r) => r.latency?.blocksAfter, [['0–1 blocks', (b) => b != null && b <= 1], ['2–3 blocks', (b) => b >= 2 && b <= 3], ['4–5 blocks', (b) => b >= 4 && b <= 5], ['6+ blocks', (b) => b >= 6]]);
  const latency = bucket(rs, (r) => r.delaySec, [['<1 s', (d) => d != null && d < 1], ['1–2 s', (d) => d >= 1 && d < 2], ['2–3 s', (d) => d >= 2 && d < 3], ['3 s+', (d) => d >= 3]]);
  const crowd = bucket(rs, (r) => r.crowd?.trades, [['0 ahead', (n) => n === 0], ['1–2 ahead', (n) => n >= 1 && n <= 2], ['3–4 ahead', (n) => n >= 3 && n <= 4], ['5+ ahead', (n) => n >= 5]]);
  const premium = bucket(rs, (r) => r.entryGap, [['below his', (g) => g != null && g < 0], ['0–5%', (g) => g >= 0 && g < 0.05], ['5–10%', (g) => g >= 0.05 && g < 0.1], ['10–15%', (g) => g >= 0.1 && g < 0.15], ['15–25%', (g) => g >= 0.15 && g < 0.25], ['25%+', (g) => g >= 0.25]]);
  return { trades: rs.length, withData: withMiss.length, missedSol, yoursSol, perfectSol: yoursSol + missedSol, missedUsd: solUsd ? missedSol * solUsd : null, perDay, blocks, latency, crowd, premium, list: withMiss };
}
export function analysisCharts(a) {
  const out = [];
  const last = a.list.slice(-200);
  if (last.length) {
    let y = 0, p = 0;
    const pts = last.map(({ r, miss }) => { y += r.fcat * 0.1; p += (r.fcat + miss) * 0.1; return [r4(y), r4(p)]; });
    out.push(spec('cumulative', { type: 'line', data: { labels: last.map(({ r }) => String(r.time).slice(5, 16).replace('T', ' ')), datasets: [
      { label: 'with Decu\'s entry price (no delay)', data: pts.map((x) => x[1]), borderColor: C.aqua, fill: false, pointRadius: 0, lineTension: 0 },
      { label: 'what you made (FCAT)', data: pts.map((x) => x[0]), borderColor: C.blue, fill: false, pointRadius: 0, lineTension: 0 },
    ] }, options: { title: title([`Running total over the last ${last.length} bought trades (0.1 SOL each)`, `the gap = profit missed on the delays: ${sol(pts.at(-1)[1] - pts.at(-1)[0])}`]), legend: { position: 'bottom' }, scales: { xAxes: [{ ticks: { fontColor: C.dark, maxTicksLimit: 12, maxRotation: 50 }, gridLines: { display: false } }], yAxes: [{ gridLines: { color: C.grid, zeroLineColor: C.dark }, ticks: { fontColor: C.dark }, scaleLabel: { display: true, labelString: 'SOL', fontColor: C.dark } }] } } }, 900, 460));
  }
  const days = a.perDay.slice(-30);
  if (days.length) out.push(spec('missed-per-day', { type: 'bar', data: { labels: days.map((d) => d.day.slice(5)), datasets: [
    { label: 'what you made (SOL)', data: days.map((d) => r4(d.yoursSol)), backgroundColor: days.map((d) => signColor(d.yoursSol)) },
    { label: 'missed on the delays (SOL)', data: days.map((d) => r4(d.missedSol)), backgroundColor: C.gray },
  ] }, options: { title: title(['Each day: what you made vs what the delays took', '0.1 SOL a trade']), legend: { position: 'bottom' }, scales: axes('SOL') } }, 860, 440));
  const groupChart = (name, label, groups) => groups.length && out.push(spec(name, { type: 'bar', data: { labels: groups.map((g) => `${g.label} (${g.n})`), datasets: [
    { label: 'your FCAT %', data: groups.map((g) => r1(g.fcat * 100)), backgroundColor: C.blue },
    { label: 'Decu\'s price PCAT %', data: groups.map((g) => r1(fin(g.pcat) ? g.pcat * 100 : null)), backgroundColor: C.aqua },
    { label: 'missed on the delay %', data: groups.map((g) => r1(fin(g.missed) ? g.missed * 100 : null)), backgroundColor: C.gray },
    { label: 'entry premium %', data: groups.map((g) => r1(fin(g.premium) ? g.premium * 100 : null)), backgroundColor: C.red },
  ] }, options: { title: title([`By ${label}: averages per trade`, '(number of trades in brackets)']), legend: { position: 'bottom' }, scales: axes('% per trade') } }, 820, 440));
  groupChart('by-blocks', 'blocks after Decu', a.blocks);
  groupChart('by-latency', 'execution latency', a.latency);
  groupChart('by-crowd', 'trades that landed ahead of you', a.crowd);
  groupChart('by-premium', 'entry premium paid', a.premium);
  const sc = a.list.filter(({ r }) => fin(r.entryGap) && Math.abs(r.entryGap) < 2).slice(-300);
  if (sc.length) out.push(spec('premium-vs-result', { type: 'scatter', data: { datasets: [
    { label: 'won', data: sc.filter(({ r }) => r.fcat > 0).map(({ r }) => ({ x: r1(r.entryGap * 100), y: r1(r.fcat * 100) })), backgroundColor: C.blue, pointRadius: 4 },
    { label: 'lost', data: sc.filter(({ r }) => r.fcat <= 0).map(({ r }) => ({ x: r1(r.entryGap * 100), y: r1(r.fcat * 100) })), backgroundColor: C.red, pointRadius: 4 },
  ] }, options: { title: title(['Entry premium paid vs your result, every trade', 'further right = paid more than Decu']), legend: { position: 'bottom' }, scales: { xAxes: [{ scaleLabel: { display: true, labelString: 'entry premium %', fontColor: C.dark }, gridLines: { color: C.grid } }], yAxes: [{ scaleLabel: { display: true, labelString: 'FCAT %', fontColor: C.dark }, gridLines: { color: C.grid, zeroLineColor: C.dark } }] } } }, 760, 480));
  return out;
}
export function analysisMarkdown(a, { charts = {}, updated = new Date().toISOString(), buySol = 0.1 } = {}) {
  const emb = (name) => charts[name] || '';
  const tbl = (groups) => ['| group | trades | your FCAT | Decu\'s price (PCAT) | missed on the delay | entry premium |', '|---|---|---|---|---|---|', ...groups.map((g) => `| ${g.label} | ${g.n} | ${pct(g.fcat)} | ${pct(g.pcat)} | ${pct(g.missed)} | ${pct(g.premium)} |`)].join('\n');
  return ['---', 'type: analysis', `updated: ${updated}`, `trades: ${a.trades}`, `missed_sol: ${r4(a.missedSol)}`, `yours_sol: ${r4(a.yoursSol)}`, a.missedUsd != null ? `missed_usd: ${r2(a.missedUsd)}` : null, '---', '',
    '# Delays and missed profit', '', '[[Home]]', '',
    `Across **${a.trades}** bought trades (${a.withData} with the data): you made **${sol(a.yoursSol)}**; with Decu's own entry price and the same exits it would have been **${sol(a.perfectSol)}**. **The delays cost ${sol(a.missedSol)}${a.missedUsd != null ? ` (≈ $${a.missedUsd.toFixed(2)})` : ''}** at ${buySol} SOL a trade.`, '',
    emb('cumulative'), '', '## Day by day', emb('missed-per-day'), '',
    '| day | trades | you | missed on the delays |', '|---|---|---|---|', ...a.perDay.slice(-30).reverse().map((d) => `| [[daily/${d.day}\\|${d.day}]] | ${d.trades} | ${sol(d.yoursSol)} | ${sol(d.missedSol)} |`), '',
    '## By blocks after Decu', emb('by-blocks'), '', tbl(a.blocks), '',
    '## By execution latency', emb('by-latency'), '', tbl(a.latency), '',
    a.crowd.length ? '## By place in line (trades that landed ahead of you)' : null, a.crowd.length ? emb('by-crowd') : null, a.crowd.length ? '\n' + tbl(a.crowd) + '\n' : null,
    '## By entry premium paid', emb('by-premium'), '', tbl(a.premium), '',
    '## Entry premium vs result, every trade', emb('premium-vs-result'), '',
    '_Missed on the delay = Decu\'s entry price result − yours with the same exit (the $10 mirror on newer trades, PCAT − FCAT on older ones). Values beyond ±1000% are data errors and left out._', ''].filter((x) => x != null).join('\n');
}

// ---------- rendering ----------
/** One chart as a PNG (QuickChart POST). null when it can't be rendered. */
export async function renderPng(s, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  try {
    const r = await fetchImpl('https://quickchart.io/chart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ version: '2', backgroundColor: 'white', width: s.width, height: s.height, format: 'png', chart: s.config }), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > 100 && b.subarray(1, 4).toString() === 'PNG' ? b : null;
  } catch { return null; }
}
