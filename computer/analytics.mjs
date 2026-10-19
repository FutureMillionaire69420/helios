// TRADE ANALYTICS: every chart of the bot's own trades, built from data it already keeps (the trade study
// journal and the closed-trade ledger). No network call and no Helius / Solscan credit is ever used.
// Only coins the bot BOUGHT count: skipped buys (studied "what if" trades) and missed-trade reports are left out.
// The same chart specs feed the dashboard (drawn in the browser) and the phone (QuickChart images in ntfy).

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const round = (x, d = 4) => (fin(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const mean = (xs) => { const v = xs.filter(fin); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
const quantile = (xs, q) => { const s = xs.filter(fin).sort((a, b) => a - b); if (!s.length) return null; const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo); };
const dayOf = (iso, tz) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)); } catch { return String(iso).slice(0, 10); } };
const name = (r) => (r.symbol ? '$' + r.symbol : String(r.mint || '?').slice(0, 6));

export const PREMIUM_BUCKETS = [[-Infinity, 0, 'below his'], [0, 0.05, '0–5%'], [0.05, 0.1, '5–10%'], [0.1, 0.15, '10–15%'], [0.15, 0.25, '15–25%'], [0.25, Infinity, '25%+']];

/** Bought study records only (the "what if" studies of skipped buys are not trades). */
export const boughtRecords = (records = []) => records.filter((r) => r && r.taken !== false && !r.skipReason);

/**
 * Everything charted. records: trade study journal; closed: closed-trade ledger [{mint, symbol, boughtAt,
 * closedAt, costSol, pnlSol, pnlPct, rule}]. Realized results come from the ledger; until it has trades,
 * the money charts use each study's FCAT (the bot's rule) x the buy size, and say so.
 */
export function buildAnalytics({ records = [], closed = [], buySol = 0.1, timezone = 'America/New_York', now = Date.now() } = {}) {
  const recs = boughtRecords(records);
  const realized = closed.filter((t) => t && fin(t.pnlSol));
  const useRealized = realized.length > 0;
  const trades = useRealized
    ? realized.map((t) => ({ at: t.closedAt, label: t.symbol ? '$' + t.symbol : String(t.mint).slice(0, 6), sol: t.pnlSol, pct: fin(t.pnlPct) ? t.pnlPct : null, rule: t.rule || 'other', holdSec: fin(t.boughtAt) && fin(t.closedAt) ? (t.closedAt - t.boughtAt) / 1000 : null }))
    : recs.filter((r) => fin(r.fcat)).map((r) => ({ at: Date.parse(r.time), label: name(r), sol: r.fcat * buySol, pct: r.fcat, rule: r.fcatExit && /his sell/.test(r.fcatExit) ? 'his sell' : 'time limit', holdSec: fin(r.fcatSec) ? r.fcatSec : null }));
  trades.sort((a, b) => a.at - b.at);
  const basis = useRealized ? 'realized (closed positions)' : `estimated: FCAT x ${buySol} SOL per study (no closed trades recorded yet)`;

  // running total, drawdown
  let cum = 0, peak = 0, maxDd = 0;
  const cumPts = [], ddPts = [];
  for (const t of trades) { cum += t.sol; peak = Math.max(peak, cum); maxDd = Math.min(maxDd, cum - peak); cumPts.push(round(cum)); ddPts.push(round(cum - peak)); }
  const labelsIdx = trades.map((t, i) => `#${i + 1} ${t.label}`);
  const wins = trades.filter((t) => t.sol > 0).length;

  // per day
  const byDay = new Map();
  for (const t of trades) { const d = dayOf(t.at, timezone); const v = byDay.get(d) || { sol: 0, n: 0, wins: 0 }; v.sol += t.sol; v.n++; if (t.sol > 0) v.wins++; byDay.set(d, v); }
  const days = [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-14);

  // entry premium (price vs price) buckets: average FCAT and win rate
  const prem = PREMIUM_BUCKETS.map(([lo, hi, label]) => { const xs = recs.filter((r) => fin(r.entryGap) && fin(r.fcat) && r.entryGap >= lo && r.entryGap < hi); return { label, n: xs.length, avg: mean(xs.map((r) => r.fcat)), win: xs.length ? xs.filter((r) => r.fcat > 0).length / xs.length : null }; }).filter((b) => b.n);

  // speed: blocks after Decu
  const blk = (r) => (fin(r.latency?.blocksAfter) ? r.latency.blocksAfter : fin(r.latency?.detectBlocks) ? r.latency.detectBlocks : null);
  const blockBins = ['0', '1', '2', '3', '4', '5+'].map((label, i) => { const xs = recs.filter((r) => { const b = blk(r); return b != null && (i < 5 ? b === i : b >= 5); }); return { label, n: xs.length, avg: mean(xs.map((r) => r.fcat)) }; });
  const delays = recs.map((r) => r.delaySec).filter(fin);

  // exits
  const ruleMap = new Map();
  for (const t of trades) { const v = ruleMap.get(t.rule) || { sol: 0, n: 0, wins: 0 }; v.sol += t.sol; v.n++; if (t.sol > 0) v.wins++; ruleMap.set(t.rule, v); }
  const rules = [...ruleMap.entries()].sort((a, b) => b[1].n - a[1].n);

  // the price path after the buy: average and middle half, second by second
  const L = Math.max(0, ...recs.map((r) => (Array.isArray(r.curve) ? r.curve.length : 0)));
  const path = Array.from({ length: L }, (_, s) => { const v = recs.map((r) => r.curve?.[s]).filter(fin); return { s, avg: mean(v), lo: quantile(v, 0.25), hi: quantile(v, 0.75), n: v.length }; }).filter((p) => p.n);
  const btsab = Array.from({ length: Math.max(1, L) }, (_, s) => recs.filter((r) => r.btsab === s).length);

  // holder money rule, fees, what was left on the table
  const hv = (ok) => recs.filter((r) => r.holderVerdict && r.holderVerdict.safe === ok && fin(r.fcat));
  const holders = [['passes', hv(true)], ['fails', hv(false)]].filter(([, xs]) => xs.length).map(([label, xs]) => ({ label, n: xs.length, avg: mean(xs.map((r) => r.fcat)) }));
  const feeRecs = recs.filter((r) => fin(r.buyFeeSol) || fin(r.sellFeeSol));
  const fees = feeRecs.slice(-50).map((r) => ({ label: name(r), sol: (r.buyFeeSol || 0) + (r.sellFeeSol || 0) }));
  const feeTotal = feeRecs.reduce((a, r) => a + (r.buyFeeSol || 0) + (r.sellFeeSol || 0), 0);
  const edge = [['his price (PCAT)', mean(recs.map((r) => r.pcat))], ['your rule (FCAT)', mean(recs.map((r) => r.fcat))], ['best second (BTSAB)', mean(recs.map((r) => r.peak))]].filter(([, v]) => fin(v));

  const recentTrades = trades.slice(-50);
  const charts = [
    { id: 'cum', title: 'Running profit', subtitle: `SOL after every trade · ${basis}`, kind: 'line', unit: 'SOL', x: labelsIdx, values: cumPts, digest: 1 },
    { id: 'per-trade', title: 'Profit per trade', subtitle: `SOL, last ${recentTrades.length} trades · blue made money, red lost`, kind: 'columns', unit: 'SOL', diverging: true, x: recentTrades.map((t) => t.label), values: recentTrades.map((t) => round(t.sol)), digest: 2 },
    { id: 'daily', title: 'Profit per day', subtitle: `SOL, last ${days.length} days (${timezone})`, kind: 'columns', unit: 'SOL', diverging: true, x: days.map(([d]) => d.slice(5)), values: days.map(([, v]) => round(v.sol)), notes: days.map(([, v]) => `${v.n} trades, ${v.wins} won`), digest: 3 },
    { id: 'drawdown', title: 'Drawdown', subtitle: 'SOL below the best running total so far', kind: 'line', unit: 'SOL', x: labelsIdx, values: ddPts, tone: 'negative' },
    { id: 'premium', title: 'Result by entry premium', subtitle: 'average FCAT % by how much more you paid than Decu (price vs price)', kind: 'columns', unit: '%', diverging: true, x: prem.map((b) => b.label), values: prem.map((b) => round(b.avg * 100, 1)), notes: prem.map((b) => `${b.n} trades, ${Math.round(b.win * 100)}% won`), digest: 4 },
    { id: 'premium-win', title: 'Win rate by entry premium', subtitle: '% of trades that made money', kind: 'columns', unit: '%', x: prem.map((b) => b.label), values: prem.map((b) => round(b.win * 100, 0)), notes: prem.map((b) => `${b.n} trades`) },
    { id: 'blocks', title: 'Speed: blocks after Decu', subtitle: 'how many trades landed 0, 1, 2… blocks after his buy', kind: 'columns', unit: 'trades', x: blockBins.map((b) => b.label), values: blockBins.map((b) => b.n) },
    { id: 'blocks-result', title: 'Result by speed', subtitle: 'average FCAT % by blocks after Decu', kind: 'columns', unit: '%', diverging: true, x: blockBins.filter((b) => b.n).map((b) => b.label), values: blockBins.filter((b) => b.n).map((b) => round(b.avg * 100, 1)), notes: blockBins.filter((b) => b.n).map((b) => `${b.n} trades`) },
    { id: 'rules', title: 'Profit by exit', subtitle: `SOL per exit reason · ${useRealized ? 'realized' : 'estimated from FCAT'}`, kind: 'columns', unit: 'SOL', diverging: true, x: rules.map(([r]) => r), values: rules.map(([, v]) => round(v.sol)), notes: rules.map(([, v]) => `${v.n} trades, ${v.wins} won`), digest: 5 },
    { id: 'hold', title: 'Hold time vs result', subtitle: 'seconds held (across) vs profit % (up)', kind: 'scatter', unit: '%', xUnit: 's', points: trades.filter((t) => fin(t.holdSec) && fin(t.pct)).slice(-200).map((t) => ({ x: round(t.holdSec, 1), y: round(t.pct * 100, 1), label: t.label })) },
    { id: 'path', title: 'Price path after the buy', subtitle: 'average profit % at each second after buying; the band is the middle half of trades', kind: 'line', unit: '%', x: path.map((p) => `${p.s}s`), values: path.map((p) => round(p.avg * 100, 1)), band: { lo: path.map((p) => round(p.lo * 100, 1)), hi: path.map((p) => round(p.hi * 100, 1)) }, digest: 6 },
    { id: 'btsab', title: 'Best second to sell', subtitle: 'how often each second after the buy was the best exit', kind: 'columns', unit: 'trades', x: btsab.map((_, s) => `${s}s`), values: btsab },
    { id: 'holders', title: 'Holder money rule', subtitle: 'average FCAT % when the coin passed or failed your holder rule', kind: 'columns', unit: '%', diverging: true, x: holders.map((h) => h.label), values: holders.map((h) => round(h.avg * 100, 1)), notes: holders.map((h) => `${h.n} trades`) },
    { id: 'edge', title: 'Where the profit goes', subtitle: 'average %: buying at his price, your rule, and the perfect exit', kind: 'columns', unit: '%', diverging: true, x: edge.map(([l]) => l), values: edge.map(([, v]) => round(v * 100, 1)) },
    { id: 'fees', title: 'Fees per trade', subtitle: `SOL paid in fees (buy + sell), last ${fees.length} trades`, kind: 'columns', unit: 'SOL', x: fees.map((f) => f.label), values: fees.map((f) => round(f.sol, 5)) },
  ].filter((c) => (c.kind === 'scatter' ? c.points.length : c.values.some(fin)));

  const tiles = [
    { id: 'pnl', label: useRealized ? 'Realized profit' : 'Estimated profit', value: round(cum), unit: 'SOL', signed: true },
    { id: 'trades', label: 'Trades', value: trades.length },
    { id: 'win', label: 'Win rate', value: trades.length ? round((wins / trades.length) * 100, 0) : null, unit: '%' },
    { id: 'avg', label: 'Average per trade', value: trades.length ? round(cum / trades.length) : null, unit: 'SOL', signed: true },
    { id: 'best', label: 'Best trade', value: trades.length ? round(Math.max(...trades.map((t) => t.sol))) : null, unit: 'SOL', signed: true },
    { id: 'worst', label: 'Worst trade', value: trades.length ? round(Math.min(...trades.map((t) => t.sol))) : null, unit: 'SOL', signed: true },
    { id: 'dd', label: 'Max drawdown', value: round(maxDd), unit: 'SOL', signed: true },
    { id: 'fees', label: 'Fees paid', value: round(feeTotal), unit: 'SOL' },
    { id: 'premium', label: 'Median entry premium', value: round((quantile(recs.map((r) => r.entryGap), 0.5) ?? NaN) * 100, 1), unit: '%' },
    { id: 'delay', label: 'Median delay after Decu', value: round(quantile(delays, 0.5), 2), unit: 's' },
  ];
  return { generatedAt: new Date(now).toISOString(), basis, bought: recs.length, closed: realized.length, tiles, charts };
}

// ---- phone images (QuickChart, Chart.js 2): light theme, colors validated for a white background
const LIGHT = { blue: '#2a78d6', red: '#e34948', grid: '#e1e0d9', ink: '#52514e', wash: 'rgba(42,120,214,0.12)' };
const thin = (arr, max) => { if (arr.length <= max) return arr.map((_, i) => i); const step = (arr.length - 1) / (max - 1); return Array.from({ length: max }, (_, k) => Math.round(k * step)); };

/** A QuickChart image URL for one chart (at most maxPoints points, so the URL stays short). */
export function quickChartUrl(ch, { width = 640, height = 340, maxPoints = 60 } = {}) {
  const axes = { xAxes: [{ gridLines: { display: false }, ticks: { fontColor: LIGHT.ink, maxRotation: 60, autoSkip: true, maxTicksLimit: 12 } }], yAxes: [{ gridLines: { color: LIGHT.grid, zeroLineColor: '#c3c2b7' }, ticks: { fontColor: LIGHT.ink, maxTicksLimit: 6 }, scaleLabel: { display: true, labelString: ch.unit, fontColor: LIGHT.ink } }] };
  const title = { display: true, text: [ch.title, ch.subtitle].filter(Boolean), fontColor: '#0b0b0b' };
  let cfg;
  if (ch.kind === 'scatter') {
    const pts = ch.points.slice(-maxPoints);
    axes.xAxes[0].scaleLabel = { display: true, labelString: ch.xUnit || '', fontColor: LIGHT.ink }; axes.xAxes[0].gridLines = { color: LIGHT.grid };
    cfg = { type: 'scatter', data: { datasets: [{ data: pts.map((p) => ({ x: p.x, y: p.y })), backgroundColor: pts.map((p) => (p.y >= 0 ? LIGHT.blue : LIGHT.red)), pointRadius: 4 }] }, options: { title, legend: { display: false }, scales: axes } };
  } else {
    const idx = thin(ch.values, maxPoints), x = idx.map((i) => ch.x[i]), v = idx.map((i) => ch.values[i]);
    const color = ch.tone === 'negative' ? LIGHT.red : LIGHT.blue;
    if (ch.kind === 'line') {
      const ds = [{ label: ch.title, data: v, borderColor: color, borderWidth: 2, pointRadius: 0, fill: false, lineTension: 0 }];
      if (ch.band) ds.unshift({ label: 'middle half', data: idx.map((i) => ch.band.hi[i]), borderWidth: 0, pointRadius: 0, fill: false }, { label: 'middle half ', data: idx.map((i) => ch.band.lo[i]), borderWidth: 0, pointRadius: 0, backgroundColor: LIGHT.wash, fill: '-1' });
      cfg = { type: 'line', data: { labels: x, datasets: ds }, options: { title, legend: { display: false }, scales: axes } };
    } else {
      cfg = { type: 'bar', data: { labels: x, datasets: [{ label: ch.title, data: v, backgroundColor: v.map((y) => (ch.diverging && y < 0 ? LIGHT.red : color)), maxBarThickness: 24 }] }, options: { title, legend: { display: false }, scales: axes } };
    }
  }
  return `https://quickchart.io/chart?w=${width}&h=${height}&bkg=white&c=${encodeURIComponent(JSON.stringify(cfg))}`;
}

/** The phone digest: the charts marked digest, in order, as ntfy messages (title, body, image). */
export function digestMessages(a, { max = 6, tag = '' } = {}) {
  const t = Object.fromEntries(a.tiles.map((x) => [x.id, x]));
  const fmt = (x) => (x?.value == null ? '—' : `${x.signed && x.value > 0 ? '+' : ''}${x.value}${x.unit === '%' ? '%' : x.unit ? ' ' + x.unit : ''}`);
  const head = `${fmt(t.pnl)} over ${t.trades.value} trades · win rate ${fmt(t.win)} · avg ${fmt(t.avg)} · max drawdown ${fmt(t.dd)} · fees ${fmt(t.fees)} · median premium ${fmt(t.premium)} · median delay ${fmt(t.delay)}\nBought trades only (skipped buys left out) · ${a.basis}`;
  return a.charts.filter((c) => c.digest).sort((x, y) => x.digest - y.digest).slice(0, max)
    .map((c, i) => ({ title: `${tag}Analytics ${i + 1}: ${c.title}`, body: i === 0 ? head : c.subtitle, image: quickChartUrl(c) }));
}
