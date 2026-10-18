// THE BOT'S BRAIN: learns from every studied trade and decides what is worth telling you.
//
// Everything here is derived from the study journal (study-*.jsonl), replayed in order at startup,
// so the brain survives restarts without a second file and can never drift from the journal.
//
// What it does after each trade:
//   - PATTERNS: groups trades by what was known at the buy (Decu's size, how late the bot was, how
//     much more it paid than Decu, coin age / market cap / holders, how busy Decu was) and by pairs
//     of those. A group whose average FCAT differs from the overall average by more than chance
//     (z-score) becomes a lesson: emerging → confirmed, or faded when more trades show it was noise.
//   - PREDICTION: before a trade's result is known, it predicts win/lose from the lessons so far,
//     then scores itself. Accuracy over time shows whether it really understands Decu's trades.
//   - SHAPES: classifies each 15 s price path (instant dump, quick spike, late runner, ...).
//   - YOUR RULES: replays the bot's real exit rules (organic stop, +gate at 15 s after Decu's buy,
//     his sell) on each recorded path, and sweeps other settings to see what would have done better.
//   - JOURNEY: levels (Rookie → Master), a go-live readiness checklist, streak alerts, a learning
//     report every REPORT_EVERY trades and a daily digest.
// Read-only advice: the brain never changes a setting or trades on its own.

const pct = (x, d = 1) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const sol = (x) => (x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(4)}`);
const median = (xs) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
const firstKnown = (c) => (c || []).find((v) => v != null) ?? null;

// ---------- what is known about a trade ----------
// pre: known at the moment of the buy (used for patterns, pairs and predictions).
// early: known 1 s after the buy. post: only known afterwards (describes, never predicts).
export const DIMENSIONS = {
  'Decu buy size': { kind: 'pre', f: (r) => r.hisSol == null ? null : r.hisSol < 1 ? '<1 SOL' : r.hisSol < 2.5 ? '1-2.5 SOL' : r.hisSol < 4 ? '2.5-4 SOL' : '4+ SOL' },
  'execution latency': { kind: 'pre', f: (r) => r.delaySec == null ? null : r.delaySec < 1 ? '<1s' : r.delaySec < 2 ? '1-2s' : r.delaySec < 3 ? '2-3s' : '3s+' },
  'blocks after Decu': { kind: 'pre', f: (r) => { const b = r.latency?.blocksAfter; return b == null ? null : b <= 1 ? '0-1' : b <= 3 ? '2-3' : b <= 5 ? '4-5' : '6+'; } },
  'entry premium': { kind: 'pre', f: (r) => r.entryGap == null ? null : r.entryGap < 0.4 ? '<40%' : r.entryGap < 0.7 ? '40-70%' : r.entryGap < 1 ? '70-100%' : '100%+' },
  'coin age': { kind: 'pre', f: (r) => r.coin?.ageSec == null ? null : r.coin.ageSec < 120 ? '<2 min' : r.coin.ageSec < 600 ? '2-10 min' : '10 min+' },
  'market cap': { kind: 'pre', f: (r) => r.coin?.marketCapUsd == null ? null : r.coin.marketCapUsd < 10e3 ? '<$10k' : r.coin.marketCapUsd < 30e3 ? '$10-30k' : r.coin.marketCapUsd < 100e3 ? '$30-100k' : '$100k+' },
  'holders': { kind: 'pre', f: (r) => r.coin?.holders == null ? null : r.coin.holders < 50 ? '<50' : r.coin.holders < 200 ? '50-200' : '200+' },
  'Decu activity': { kind: 'pre', f: (r) => r.ctx?.recent10m == null ? null : r.ctx.recent10m === 0 ? 'first in 10 min' : r.ctx.recent10m < 4 ? '2-4 in 10 min' : '5+ in 10 min (hot)' },
  'hour (UTC)': { kind: 'pre', pairs: false, f: (r) => (r.time ? `${String(new Date(r.time).getUTCHours()).padStart(2, '0')}h` : null) },
  'holder rule': { kind: 'early', f: (r) => (r.holderVerdict ? (r.holderVerdict.safe ? 'SAFE' : 'RISKY') : null) },
  'first second': { kind: 'early', f: (r) => { const c = r.curve || []; if (c[0] == null || c[1] == null) return null; const d = c[1] - c[0]; return d < -0.03 ? 'falling' : d > 0.03 ? 'rising' : 'flat'; } },
  'Decu sold': { kind: 'post', f: (r) => !Array.isArray(r.curve) ? null : r.hisSoldAtSec == null ? 'held past 15s' : r.hisSoldAtSec + Math.max(0, r.delaySec ?? 0) < 5 ? 'within 5s of his buy' : 'within 15s of his buy' },
  'shape': { kind: 'post', f: (r) => r.shape || null },
};
const PAIR_DIMS = Object.entries(DIMENSIONS).filter(([, d]) => d.kind === 'pre' && d.pairs !== false).map(([k]) => k);
const PAIRS = PAIR_DIMS.flatMap((a, i) => PAIR_DIMS.slice(i + 1).map((b) => [a, b]));

/** The 15 s price path in one word. curve[s] = profit fraction s seconds after the buy. */
export function curveShape(curve) {
  const known = (curve || []).map((v, s) => [v, s]).filter(([v]) => v != null);
  if (known.length < 3) return null;
  const base = known[0][0], last = known.at(-1)[0];
  const [peak, peakAt] = known.reduce((a, b) => (b[0] > a[0] ? b : a));
  const rise = peak - base;
  if (rise <= 0.02) return last < base - 0.1 ? 'instant dump' : 'flat / bleeding';
  if (rise >= 0.1 && peakAt <= 4 && last < base + rise / 2) return 'quick spike';
  if (rise >= 0.1 && peakAt >= 10) return 'late runner';
  if (last >= base + 0.05) return 'steady climb';
  return 'chop';
}

/**
 * The bot's real exit rules replayed on one recorded path (inside the 15 s study window):
 *  his sell → out; organic stop (from the price right after entry) → out; at gateSec after DECU'S
 *  buy: peak ≥ gain gate → out, else hold for his sell (marked at the window end, `open: true`).
 */
export function simulateRules(rec, { stopLossPct = 20, gainGatePct = 15, gateSec = 15 } = {}) {
  const c = rec.curve || [];
  const base = firstKnown(c);
  if (base == null) return null;
  const stop = stopLossPct / 100, gate = gainGatePct / 100;
  const gateAt = Math.max(0, Math.ceil(gateSec - Math.max(0, rec.delaySec ?? 0) - 1e-9));
  const hisSell = rec.hisSoldAtSec != null ? Math.max(0, Math.ceil(rec.hisSoldAtSec - 1e-9)) : null;
  let peak = -Infinity, decided = false, last = null, lastAt = null;
  for (let s = 0; s < c.length; s++) {
    const v = c[s];
    if (v == null) continue;
    last = v; lastAt = s; peak = Math.max(peak, v);
    if (hisSell != null && s >= hisSell) return { pnl: v, sec: s, how: 'his sell' };
    if (stop > 0 && (1 + v) / (1 + base) - 1 <= -stop) return { pnl: v, sec: s, how: `-${stopLossPct}% stop` };
    if (!decided && s >= gateAt) { decided = true; if (peak >= gate) return { pnl: v, sec: s, how: `+${gainGatePct}% gate` }; }
  }
  return { pnl: last, sec: lastAt, how: 'still holding for his sell', open: true };
}

// ---------- go-live journey ----------
export const LEVELS = [
  { min: 0, name: 'Rookie', goal: 'collect 10 studied trades' },
  { min: 10, name: 'Learner', goal: 'first patterns show up' },
  { min: 25, name: 'Analyst', goal: 'patterns confirm or fade' },
  { min: 50, name: 'Strategist', goal: 'the go-live test (50+ trades)' },
  { min: 100, name: 'Veteran', goal: 'sharpen the filters' },
  { min: 250, name: 'Master', goal: 'keep the edge' },
];
const levelOf = (n) => { let i = 0; while (i + 1 < LEVELS.length && n >= LEVELS[i + 1].min) i++; return i; };

/** Go-live checklist from the journal. */
export function readiness(records, opts = {}) {
  const rs = records.filter((r) => Number.isFinite(r.fcat));
  const fc = rs.reduce((a, r) => a + r.fcat, 0);
  const sims = rs.map((r) => r.ruleSim || simulateRules(r, opts)).filter(Boolean);
  const rulesTotal = sims.reduce((a, s) => a + s.pnl, 0);
  const last20 = rs.slice(-20).reduce((a, r) => a + r.fcat, 0);
  const checks = [
    { ok: rs.length >= 50, text: `50+ studied trades (${rs.length})` },
    { ok: rs.length > 0 && fc > 0, text: `FCAT positive overall (${pct(rs.length ? fc / rs.length : null)} avg)` },
    { ok: sims.length > 0 && rulesTotal > 0, text: `your exit rules positive (${pct(sims.length ? rulesTotal / sims.length : null)} avg)` },
    { ok: rs.length >= 20 && last20 > 0, text: `last 20 trades positive (${pct(rs.length >= 20 ? last20 / 20 : null)} avg)` },
  ];
  return { passed: checks.filter((c) => c.ok).length, of: checks.length, checks, ready: checks.every((c) => c.ok) };
}

// ---------- your holder rule ----------
// A market cap needs enough holders to hold up: at/above $10k mcap at least 1000 holders, $20k 2500,
// $30k 4000 (HOLDER_RULES). Fewer = RISKY for that market cap ("it can't go above it"), else SAFE.
export const HOLDER_RULES = [[10000, 1000], [20000, 2500], [30000, 4000]];
export function holderVerdict(holders, mcapUsd, rules = HOLDER_RULES) {
  if (!Number.isFinite(holders) || !Number.isFinite(mcapUsd) || !rules?.length) return null;
  const required = rules.filter(([m]) => mcapUsd >= m).reduce((a, [, h]) => Math.max(a, h), 0);
  const next = rules.find(([, h]) => holders < h); // the first market cap this many holders can't support
  return { holders, mcapUsd, required, ceilingUsd: next ? next[0] : null, safe: holders >= required };
}
/** Market cap at second s, from the nearest earlier holder sample and the price path (mcap moves with price). */
function holderStateAt(rec, s) {
  const path = (rec.holderPath || []).filter((x) => x.s <= s && Number.isFinite(x.holders) && Number.isFinite(x.mcapUsd));
  if (!path.length) return null;
  const h = path.at(-1), c = rec.curve || [];
  const at = (k) => { for (let i = Math.min(k, c.length - 1); i >= 0; i--) if (c[i] != null) return c[i]; return null; };
  const vs = at(s), vh = at(h.s);
  const mcap = vs != null && vh != null ? h.mcapUsd * (1 + vs) / (1 + vh) : h.mcapUsd;
  return { holders: h.holders, mcapUsd: mcap };
}

/**
 * One exit strategy replayed on a recorded path, using only what was known at each second.
 * A sell decided at second s fills at the price of second s + lagSec (a sell takes time to land).
 * strat: {} = your rules · {fixed:N} sell at N s · {trail:X} trailing stop X below the peak ·
 * {half:true} sell half at +gain gate, the rest by your rules. All keep his sell and the organic stop.
 * {costStop:0.2} your rules, but the stop is -20% on your MONEY (vs cost, fees included) instead of organic.
 * {holders:true} your rules PLUS your holder rule: sell the moment the market cap outgrows its holders.
 *   Needs holder samples (newer trades); returns null without them (counted as incomplete, never as 0).
 */
export function exitSim(rec, strat = {}, { stopLossPct = 20, gainGatePct = 15, gateSec = 15, lagSec = 1, holderRules = HOLDER_RULES } = {}) {
  const c = rec.curve || [];
  const base = firstKnown(c);
  if (base == null) return null;
  if (strat.holders && !(rec.holderPath || []).some((x) => Number.isFinite(x.holders) && Number.isFinite(x.mcapUsd))) return null;
  const fillAt = (s) => { for (let k = Math.min(c.length - 1, s + lagSec); k >= 0; k--) if (c[k] != null) return c[k]; return null; };
  const stop = stopLossPct / 100, gate = gainGatePct / 100;
  const gateAt = Math.max(0, Math.ceil(gateSec - Math.max(0, rec.delaySec ?? 0) - 1e-9));
  const hisSell = rec.hisSoldAtSec != null ? Math.max(0, Math.ceil(rec.hisSoldAtSec - 1e-9)) : null;
  let peak = -Infinity, decided = false, half = null, last = null, at = null;
  const fin = (x, how, open = false) => ({ pnl: half != null ? 0.5 * half + 0.5 * x : x, how, open, sec: open ? null : at });
  for (let s = 0; s < c.length; s++) {
    const v = c[s];
    if (v == null) continue;
    last = v; peak = Math.max(peak, v); at = s;
    if (hisSell != null && s >= hisSell) return fin(fillAt(s), 'his sell');
    if (strat.fixed != null && s >= strat.fixed) return fin(fillAt(s), `${strat.fixed} s`);
    if (strat.trail != null && s > 0 && (1 + v) / (1 + peak) - 1 <= -strat.trail) return fin(fillAt(s), 'trailing stop');
    if (strat.costStop != null) { if (v <= -strat.costStop) return fin(fillAt(s), 'stop on your money'); }
    else if (stop > 0 && (1 + v) / (1 + base) - 1 <= -stop) return fin(fillAt(s), 'stop');
    if (strat.holders) { const st = holderStateAt(rec, s), hv = st && holderVerdict(st.holders, st.mcapUsd, holderRules); if (hv && !hv.safe) return fin(fillAt(s), 'holders behind mcap'); }
    if (strat.half && half == null && v >= gate) half = fillAt(s);
    if (strat.fixed == null && strat.trail == null && !decided && s >= gateAt) { decided = true; if (peak >= gate) return fin(fillAt(s), 'gain gate'); }
  }
  return fin(last, 'holding at 15 s', true);
}
export const EXIT_STRATEGIES = [
  { name: 'your rules', strat: {} }, { name: 'sell at 3 s', strat: { fixed: 3 } }, { name: 'sell at 5 s', strat: { fixed: 5 } },
  { name: 'sell at 10 s', strat: { fixed: 10 } }, { name: 'trailing 10%', strat: { trail: 0.1 } }, { name: 'trailing 20%', strat: { trail: 0.2 } },
  { name: 'half at +gate', strat: { half: true } },
  { name: 'stop -20% on your money', strat: { costStop: 0.2 } }, { name: 'holder momentum', strat: { holders: true } },
];

/**
 * What other settings would have done on the same recorded paths (advice only, never applied).
 * WALK-FORWARD: settings are chosen on the oldest 70% of trades and judged on the newest 30%, which
 * the choice never saw. A change is "supported" only with 50+ trades and a gain on BOTH parts.
 */
export function advise(records, { buySol = 0.1, stopLossPct = 20, gainGatePct = 15, gateSec = 15, maxPayPct = 0, minEvidence = 50, holderRules = HOLDER_RULES } = {}) {
  const rs = records.filter((r) => Number.isFinite(r.fcat) && Array.isArray(r.curve)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  const n = rs.length, out = { trades: n };
  if (n < 10) return out;
  const ruleOpts = { stopLossPct, gainGatePct, gateSec, holderRules };
  // A trade with no result is left out (and counted as incomplete), never counted as zero.
  const total = (list, o) => list.reduce((a, r) => { const s = simulateRules(r, { ...ruleOpts, ...o }); return s ? a + s.pnl * buySol : a; }, 0);
  const current = total(rs, {});
  out.current = { stopLossPct, gainGatePct, pnlSol: current };
  const cut = Math.max(1, Math.floor(n * 0.7)), train = rs.slice(0, cut), test = rs.slice(cut);
  out.split = { train: train.length, test: test.length };
  const verdict = (trainGain, testGain) => (n < minEvidence ? `not enough evidence yet (${n}/${minEvidence} trades)` : trainGain > 0.005 && testGain > 0 ? 'SUPPORTED on unseen trades' : 'not supported (did not hold on unseen trades)');
  // Entry-premium filter: skip buys priced more than X above Decu's price.
  const keep = (list, x) => list.filter((r) => r.entryGap == null || x == null || r.entryGap <= x);
  const grid = [...Array.from({ length: 20 }, (_, i) => (i + 1) * 0.05), 1.25, 1.5];
  const sweep = grid.map((x) => { const kept = keep(rs, x); return { pct: Math.round(x * 100), kept: kept.length, pnlSol: total(kept, {}), fcatSol: kept.reduce((a, r) => a + r.fcat * buySol, 0) }; });
  out.maxPaySweep = sweep;
  const viable = sweep.filter((s) => s.kept >= Math.max(5, Math.ceil(n * 0.3))).sort((a, b) => b.pnlSol - a.pnlSol);
  const best = viable[0];
  out.maxPay = best && best.pnlSol > current + 0.005 ? { ...best, gainSol: best.pnlSol - current, skipped: n - best.kept } : null;
  out.maxPayCurrent = maxPayPct || 0;
  const trainPick = grid.map((x) => ({ x, kept: keep(train, x).length, pnl: total(keep(train, x), {}) })).filter((t) => t.kept >= Math.max(3, Math.ceil(train.length * 0.3))).sort((a, b) => b.pnl - a.pnl)[0];
  if (trainPick) {
    const tr0 = total(train, {}), te0 = total(test, {}), te = total(keep(test, trainPick.x), {});
    out.filterWF = { pct: Math.round(trainPick.x * 100), trainGainSol: trainPick.pnl - tr0, testGainSol: te - te0, testKept: keep(test, trainPick.x).length, testOf: test.length, verdict: verdict(trainPick.pnl - tr0, te - te0) };
    if (maxPayPct > 0) { const x = maxPayPct / 100; out.filterCurrent = { pct: maxPayPct, trainGainSol: total(keep(train, x), {}) - tr0, testGainSol: total(keep(test, x), {}) - te0 }; }
  }
  // Exit strategies (a sell lands 1 s after the decision), walk-forward.
  // Each exit is compared with YOUR rules on exactly the same trades (a strategy without data for a
  // trade skips it for both), so strategies that need holder samples are judged fairly.
  const ex = (list, st) => { let sol = 0, mine = 0, n = 0, miss = 0; for (const r of list) { const e = exitSim(r, st, ruleOpts), b = exitSim(r, {}, ruleOpts); if (!e || !b) { miss++; continue; } sol += e.pnl * buySol; mine += b.pnl * buySol; n++; } return { sol, gain: sol - mine, n, miss }; };
  out.exits = EXIT_STRATEGIES.map((e) => { const a = ex(rs, e.strat), tr = ex(train, e.strat), te = ex(test, e.strat); return { name: e.name, pnlSol: a.sol, vsYoursSol: a.gain, trades: a.n, incomplete: a.miss, trainSol: tr.sol, trainGain: tr.gain, testSol: te.sol, testGain: te.gain, testTrades: te.n }; });
  const base = out.exits[0], bestTrain = [...out.exits.slice(1)].filter((e) => e.trades >= 5).sort((a, b) => b.trainGain - a.trainGain)[0];
  out.exitWF = !bestTrain || bestTrain.trainGain <= 0 ? { name: base.name, verdict: 'your rules are the best on older trades' } : { name: bestTrain.name, trainGainSol: bestTrain.trainGain, testGainSol: bestTrain.testGain, verdict: bestTrain.testTrades ? verdict(bestTrain.trainGain, bestTrain.testGain) : 'not enough newer trades with data yet' };
  // Gate / stop grid (inside the 15 s window; holds past it are marked at the window end).
  const g2 = [];
  for (const g of [5, 10, 15, 20, 30, 50]) for (const sl of [10, 15, 20, 30, 50]) g2.push({ gainGatePct: g, stopLossPct: sl, pnlSol: total(rs, { gainGatePct: g, stopLossPct: sl }) });
  g2.sort((a, b) => b.pnlSol - a.pnlSol);
  out.bestRules = g2[0].pnlSol > current + 0.005 ? { ...g2[0], gainSol: g2[0].pnlSol - current } : null;
  return out;
}

// ---------- the brain ----------
/**
 * createBrain(opts).observe(rec, records) after each trade (records already includes rec).
 * Returns {prediction, matched, events}. events are notifications to send (empty while replaying).
 */
export function createBrain({ buySol = 0.1, stopLossPct = 20, gainGatePct = 15, gateSec = 15, maxPayPct = 0, reportEvery = 10, minTrades = 10, digestHours = 24, holderRules = HOLDER_RULES, filterPcts = [] } = {}) {
  const ruleOpts = { stopLossPct, gainGatePct, gateSec, holderRules };
  const groups = new Map(); // key -> {key, label, dims, buckets, n, wins, sum}
  const lessons = new Map(); // key -> {status, dir, since, changedAt}
  const predictions = [];
  const all = { n: 0, sum: 0, sumsq: 0, wins: 0 };
  let streak = { dir: 0, recs: [] }, lastDigestAt = null, digestFrom = 0;

  const bucketsOf = (r) => Object.fromEntries(Object.entries(DIMENSIONS).map(([k, d]) => [k, d.f(r)]));
  const keysOf = (b) => {
    const ks = [];
    // 'post' facts (shape, when he sold) only restate the result: described in reports, never lessons.
    for (const [k, v] of Object.entries(b)) if (v != null && DIMENSIONS[k].kind !== 'post') ks.push({ key: `${k}=${v}`, dims: [k], buckets: [v], label: `${k} ${v}` });
    for (const [a, c] of PAIRS) if (b[a] != null && b[c] != null) ks.push({ key: `${a}=${b[a]}&${c}=${b[c]}`, dims: [a, c], buckets: [b[a], b[c]], label: `${a} ${b[a]} + ${c} ${b[c]}` });
    return ks;
  };
  const mean = () => (all.n ? all.sum / all.n : 0);
  const sd = () => (all.n > 1 ? Math.sqrt(Math.max(1e-6, (all.sumsq - all.sum ** 2 / all.n) / (all.n - 1))) : 0.2);
  const statOf = (g) => {
    const avg = g.sum / g.n, m = mean(), dev = avg - m, z = dev / (sd() / Math.sqrt(g.n));
    return { ...g, avg, dev, z, winRate: g.wins / g.n };
  };
  // Lesson strength with hysteresis. Pairs need more evidence (many pairs = more chance of a fluke).
  const judge = (st, prev) => {
    const pair = st.dims.length > 1, az = Math.abs(st.z), big = Math.abs(st.dev) >= 0.03;
    if (all.n < minTrades) return null;
    if (big && st.n >= (pair ? 10 : 8) && az >= (pair ? 2.5 : 2)) return 'confirmed';
    if (big && st.n >= (pair ? 6 : 5) && az >= (pair ? 2 : 1.5)) return prev === 'confirmed' ? 'confirmed' : 'emerging';
    if ((prev === 'confirmed' || prev === 'emerging') && az >= 0.75 && Math.sign(st.dev) === lessons.get(st.key)?.dir) return prev;
    if (prev === 'confirmed' || prev === 'emerging') return 'faded';
    return prev === 'faded' ? 'faded' : null;
  };
  // Pairs only count as their own lesson when they say more than each half alone.
  const addsInfo = (st) => {
    if (st.dims.length < 2) return true;
    const singles = st.dims.map((d, i) => groups.get(`${d}=${st.buckets[i]}`)).filter(Boolean).map(statOf);
    return singles.every((s) => Math.abs(st.dev) > Math.abs(s.dev) + 0.03);
  };

  function predict(r) {
    if (all.n < minTrades) return null;
    const m = mean(), b = bucketsOf(r), basis = [];
    for (const [k, d] of Object.entries(DIMENSIONS)) {
      if (d.kind !== 'pre' || b[k] == null) continue;
      const g = groups.get(`${k}=${b[k]}`);
      if (!g || g.n < 3) continue;
      // Shrunk toward the average (few trades = little trust) and weighted by how clear the signal is.
      const st = statOf(g), w = (g.n / (g.n + 8)) * Math.min(1, Math.abs(st.z) / 2);
      basis.push({ label: `${k} ${b[k]}`, dev: st.dev * w, n: g.n, avg: st.avg });
    }
    const pred = m + basis.reduce((a, x) => a + x.dev, 0);
    const used = basis.filter((x) => Math.abs(x.dev) >= 0.005).sort((a, c) => Math.abs(c.dev) - Math.abs(a.dev));
    return { fcat: pred, win: pred > 0, basis: used.slice(0, 3), baseline: m };
  }

  function accuracy(lastN = null) {
    const ps = lastN ? predictions.slice(-lastN) : predictions;
    if (!ps.length) return null;
    const hits = ps.filter((p) => p.hit).length;
    // Baseline: always guessing the most common result. The brain is only useful if it beats this.
    const winsShare = ps.filter((p) => p.actualWin).length / ps.length;
    return { hits, total: ps.length, rate: hits / ps.length, baseline: Math.max(winsShare, 1 - winsShare) };
  }

  const describe = (st) => `${st.dev >= 0 ? '▲' : '▼'} ${st.label}: ${st.wins}/${st.n} won, avg FCAT ${pct(st.avg)} vs ${pct(mean())} overall`;
  const active = () => [...lessons.entries()].filter(([, l]) => l.status === 'confirmed' || l.status === 'emerging')
    .map(([key, l]) => ({ ...statOf(groups.get(key)), status: l.status, since: l.since }))
    .sort((a, c) => (c.status === 'confirmed') - (a.status === 'confirmed') || Math.abs(c.z) - Math.abs(a.z));

  function journey(records) {
    const n = all.n, li = levelOf(n), L = LEVELS[li], next = LEVELS[li + 1];
    const rd = readiness(records, ruleOpts), acc = accuracy();
    return { level: li + 1, name: L.name, goal: L.goal, trades: n, next: next ? { at: next.min, name: next.name, left: next.min - n } : null, readiness: rd, accuracy: acc };
  }
  const journeyLine = (records) => {
    const j = journey(records);
    return `Journey: L${j.level} ${j.name} · trade ${j.trades}${j.next ? ` · ${j.next.left} to L${j.level + 1} ${j.next.name}` : ''} · go-live ${j.readiness.passed}/${j.readiness.of}${j.accuracy ? ` · predictions ${Math.round(j.accuracy.rate * 100)}% right` : ''}`;
  };

  // Results per entry-premium filter (FCAT, all studied Decu buys incl. skipped ones) and per holder verdict.
  const pcts = [...new Set([...filterPcts, maxPayPct].filter((x) => x > 0))].sort((a, b) => a - b);
  function filterLines(list) {
    const rs = list.filter((r) => Number.isFinite(r.fcat));
    const out = pcts.map((p) => { const k = rs.filter((r) => Number.isFinite(r.entryGap) && r.entryGap <= p / 100 + 1e-9); return `${p}%${p === maxPayPct ? ' (trading)' : ''}: ${k.length} trades ${sol(k.reduce((a, r) => a + r.fcat * buySol, 0))} SOL, ${k.filter((r) => r.fcat > 0).length} won`; });
    const hv = rs.filter((r) => r.holderVerdict), safe = hv.filter((r) => r.holderVerdict.safe), risky = hv.filter((r) => !r.holderVerdict.safe);
    return [out.length ? `Filters: ${out.join(' · ')}` : null,
      hv.length ? `Holder rule at buy: SAFE ${safe.length} trades ${sol(safe.reduce((a, r) => a + r.fcat * buySol, 0))} SOL · RISKY ${risky.length} trades ${sol(risky.reduce((a, r) => a + r.fcat * buySol, 0))} SOL` : null].filter(Boolean);
  }

  function adviceLines(records) {
    const a = advise(records, { buySol, maxPayPct, ...ruleOpts });
    if (!a.current) return [`Advisor: needs 10 trades (has ${a.trades}).`];
    const lines = [...filterLines(records), `Your rules on ${a.trades} trades: ${sol(a.current.pnlSol)} SOL (−${stopLossPct}% organic stop, +${gainGatePct}% gate at ${gateSec}s after Decu's buy). Walk-forward: chosen on the oldest ${a.split.train}, tested on the newest ${a.split.test}.`];
    const f = a.filterWF;
    if (f) lines.push(`Entry-premium filter: best on older trades = skip above +${f.pct}% (${sol(f.trainGainSol)} SOL vs no filter); on newer unseen trades ${sol(f.testGainSol)} SOL (${f.testKept}/${f.testOf} kept) → ${f.verdict}.${a.filterCurrent ? ` Your ${a.filterCurrent.pct}%: older ${sol(a.filterCurrent.trainGainSol)}, newer ${sol(a.filterCurrent.testGainSol)} SOL.` : ''}`);
    lines.push(`Exits vs your rules on the same trades (sell lands 1 s after the decision): ${a.exits.slice(1).map((e) => `${e.name} ${sol(e.vsYoursSol)}${e.trades < a.trades ? ` (${e.trades} trades with data)` : ''}`).join(' · ')} SOL. Yours: ${sol(a.exits[0].pnlSol)} SOL.`);
    const x = a.exitWF;
    lines.push(x.trainGainSol == null ? `Best exit on older trades: ${x.name} (${x.verdict}).` : `Best exit on older trades: ${x.name} (${sol(x.trainGainSol)} SOL vs yours); on newer unseen trades ${sol(x.testGainSol)} SOL → ${x.verdict}.`);
    if (a.bestRules) lines.push(`Gate/stop grid: +${a.bestRules.gainGatePct}% / −${a.bestRules.stopLossPct}% would have made ${sol(a.bestRules.pnlSol)} SOL on all trades (hindsight, not walk-forward).`);
    return lines;
  }

  function streakCommon(recs) {
    const bs = recs.map(bucketsOf), out = [];
    for (const k of Object.keys(DIMENSIONS)) { if (DIMENSIONS[k].kind === 'post' && k !== 'shape') continue; const v = bs[0][k]; if (v != null && bs.every((b) => b[k] === v)) out.push(`${k} ${v}`); }
    return out;
  }

  function observe(rec, records, { silent = false } = {}) {
    const events = [];
    if (!Number.isFinite(rec.fcat)) return { prediction: null, matched: [], events };
    // 1. Score the prediction made before this result was known.
    const prediction = predict(rec);
    if (prediction) predictions.push({ pred: prediction.fcat, actual: rec.fcat, hit: prediction.win === rec.fcat > 0, actualWin: rec.fcat > 0 });
    // 2. Which active lessons this trade matched, and whether it agreed with them.
    const ks = keysOf(bucketsOf(rec));
    const matched = ks.filter((k) => ['confirmed', 'emerging'].includes(lessons.get(k.key)?.status))
      .map((k) => { const st = statOf(groups.get(k.key)); return { ...st, status: lessons.get(k.key).status, agreed: (st.dev >= 0) === (rec.fcat - mean() >= 0) }; })
      .sort((a, c) => Math.abs(c.z) - Math.abs(a.z));
    // 3. Learn.
    all.n++; all.sum += rec.fcat; all.sumsq += rec.fcat ** 2; all.wins += rec.fcat > 0 ? 1 : 0;
    for (const k of ks) { const g = groups.get(k.key) || { ...k, n: 0, wins: 0, sum: 0 }; g.n++; g.wins += rec.fcat > 0 ? 1 : 0; g.sum += rec.fcat; groups.set(k.key, g); }
    // 4. Re-judge every group (the overall average moved, so all of them can change).
    const changes = [];
    for (const g of groups.values()) {
      if (g.n < 5 && !lessons.has(g.key)) continue;
      const st = statOf(g), prev = lessons.get(g.key)?.status ?? null;
      const now = addsInfo(st) || prev ? judge(st, prev) : null;
      if (now === prev && (now === null || Math.sign(st.dev) === lessons.get(g.key)?.dir)) continue;
      if (now === null) { lessons.delete(g.key); continue; }
      const flipped = prev && now !== 'faded' && lessons.get(g.key)?.dir !== Math.sign(st.dev);
      lessons.set(g.key, { status: now, dir: now === 'faded' ? lessons.get(g.key)?.dir : Math.sign(st.dev), since: lessons.get(g.key)?.since ?? all.n, changedAt: all.n });
      if (now === 'faded' && prev !== 'faded') changes.push({ kind: 'faded', st, prev });
      else if (now !== 'faded' && (now !== prev || flipped)) changes.push({ kind: flipped ? 'flipped' : now === 'confirmed' ? (prev === 'emerging' ? 'confirmed' : 'new-confirmed') : 'new', st });
    }
    // 5. Streaks.
    const dir = rec.fcat > 0 ? 1 : -1;
    streak = streak.dir === dir ? { dir, recs: [...streak.recs, rec] } : { dir, recs: [rec] };
    const L = streak.recs.length, prevLevel = levelOf(all.n - 1), level = levelOf(all.n);
    if (lastDigestAt == null) lastDigestAt = Date.parse(rec.time) || 0;
    const due = Date.parse(rec.time) - lastDigestAt >= digestHours * 3600e3;
    const digestRecs = due ? records.slice(digestFrom) : null;
    if (due) { lastDigestAt = Date.parse(rec.time); digestFrom = records.length; }
    if (silent) return { prediction, matched, events };

    // ----- notifications the brain decides to send -----
    if (changes.length) {
      const order = { 'new-confirmed': 0, confirmed: 1, flipped: 2, new: 3, faded: 4 };
      changes.sort((a, c) => order[a.kind] - order[c.kind] || Math.abs(c.st.z) - Math.abs(a.st.z));
      const word = { 'new-confirmed': 'CONFIRMED', confirmed: 'CONFIRMED', flipped: 'FLIPPED', new: 'emerging', faded: 'faded (was noise)' };
      const top = changes[0];
      const lines = changes.slice(0, 5).map((c) => `${word[c.kind]}: ${describe(c.st)} (z ${c.st.z.toFixed(1)})`);
      const think = [];
      for (const c of changes.slice(0, 3)) {
        if (c.kind === 'faded') { think.push(`"${c.st.label}" no longer stands out after ${c.st.n} trades: treat it as luck.`); continue; }
        if (c.st.dims.includes('entry premium') && c.st.dev < 0) think.push(`A high entry premium hurts: "${c.st.label}" loses. The entry-premium filter skips these.`);
        else if ((c.st.dims.includes('execution latency') || c.st.dims.includes('blocks after Decu')) && c.st.dev < 0) think.push(`Execution latency hurts: "${c.st.label}" loses. Faster detection/landing fixes this, not settings.`);
        else if (c.st.dims.includes('first second') && c.st.dev < 0) think.push(`An early warning: when the price is ${c.st.buckets[0]} 1 s after the buy, the trade usually loses. A candidate early-exit rule.`);
        else if (c.st.dev > 0) think.push(`An edge: "${c.st.label}" wins more than the rest. These are the Decu trades worth copying.`);
        else think.push(`A weak spot: "${c.st.label}" loses more than the rest. A candidate for skipping.`);
      }
      events.push({ kind: 'pattern', title: `${top.kind === 'faded' ? 'Pattern faded' : top.kind.includes('confirmed') ? 'Pattern CONFIRMED' : top.kind === 'flipped' ? 'Pattern flipped' : 'New pattern spotted'}: ${top.st.label}`, priority: top.kind.includes('confirmed') ? 4 : 3, tags: ['brain'], body: [...lines, '', 'What it means:', ...think.map((x) => '• ' + x), '', `Learned from ${all.n} trades. Patterns need 5+ trades to appear and 8+ (pairs 10+) to be confirmed.`, journeyLine(records)].join('\n') });
    }
    if (L === 3 || (L >= 5 && L % 5 === 0)) {
      const common = streakCommon(streak.recs), sum = streak.recs.reduce((a, r) => a + r.fcat, 0);
      events.push({ kind: 'streak', title: `${dir > 0 ? 'Win' : 'Losing'} streak: ${L} in a row (${sol(sum * buySol)} SOL)`, priority: dir > 0 ? 3 : 4, tags: [dir > 0 ? 'fire' : 'warning'], body: [
        `The last ${L} trades all ${dir > 0 ? 'won' : 'lost'}: ${streak.recs.map((r) => `${r.symbol ? '$' + r.symbol : r.mint.slice(0, 6)} ${pct(r.fcat, 0)}`).join(', ')}`,
        common.length ? `What they had in common: ${common.join('; ')}.` : 'Nothing in common that the bot measures: likely the market, not the setup.',
        `Median in this streak: entry premium ${pct(median(streak.recs.map((r) => r.entryGap)), 0)}, execution latency ${median(streak.recs.map((r) => r.delaySec)) ?? '?'} s.`,
        journeyLine(records)].join('\n') });
    }
    const levelUp = level > prevLevel, report = reportEvery > 0 && all.n % reportEvery === 0;
    if (levelUp || report) {
      const j = journey(records), rs = records.filter((r) => Number.isFinite(r.fcat));
      const lastK = rs.slice(-reportEvery), prevK = rs.slice(-2 * reportEvery, -reportEvery);
      const avg = (xs) => (xs.length ? xs.reduce((a, r) => a + r.fcat, 0) / xs.length : null);
      const trend = prevK.length ? (avg(lastK) > avg(prevK) + 0.02 ? 'improving' : avg(lastK) < avg(prevK) - 0.02 ? 'getting worse' : 'steady') : null;
      const acc = accuracy(), accRecent = accuracy(20), act = active();
      const shapes = {}; for (const r of rs) if (r.shape) (shapes[r.shape] ||= []).push(r.fcat);
      events.push({ kind: levelUp ? 'level' : 'report', title: levelUp ? `Level up: L${level + 1} ${LEVELS[level].name} (${all.n} trades studied)` : `Learning report: ${all.n} trades studied`, priority: levelUp ? 4 : 3, tags: [levelUp ? 'trophy' : 'books'], body: [
        levelUp ? `The bot reached L${level + 1} ${LEVELS[level].name}. Next goal: ${LEVELS[level].goal}.` : null,
        `FCAT last ${lastK.length}: ${pct(avg(lastK))} avg${prevK.length ? ` vs ${pct(avg(prevK))} the ${prevK.length} before (${trend})` : ''} · all ${all.n}: ${pct(mean())} avg, ${all.wins}/${all.n} won`,
        acc ? `Predictions: ${acc.hits}/${acc.total} right (${Math.round(acc.rate * 100)}%), last 20: ${Math.round(accRecent.rate * 100)}%. Always guessing the usual result scores ${Math.round(acc.baseline * 100)}%: the brain ${acc.rate > acc.baseline + 0.03 ? 'is beating it (it understands something real)' : 'is not beating it yet (needs more trades)'}.` : `Predictions start at ${minTrades} trades.`,
        act.length ? 'Patterns it trusts:' : 'No patterns strong enough yet.',
        ...act.slice(0, 5).map((s) => `${s.status === 'confirmed' ? '✔' : '…'} ${describe(s)}`),
        Object.keys(shapes).length ? `Price shapes: ${Object.entries(shapes).sort((a, c) => c[1].length - a[1].length).map(([k, v]) => `${k} ${v.length}× (${pct(v.reduce((a, x) => a + x, 0) / v.length, 0)})`).join(', ')}` : null,
        '', 'Advisor (nothing is changed automatically):', ...adviceLines(records).map((x) => '• ' + x),
        '', `Go-live readiness ${j.readiness.passed}/${j.readiness.of}:`, ...j.readiness.checks.map((c) => `${c.ok ? '✔' : '✘'} ${c.text}`),
        journeyLine(records)].filter((x) => x != null).join('\n') });
    }
    if (due && digestRecs?.length) {
      const day = digestRecs.filter((r) => Number.isFinite(r.fcat)), f = day.reduce((a, r) => a + r.fcat * buySol, 0);
      const rules = day.reduce((a, r) => { const x = (r.ruleSim || simulateRules(r, ruleOpts))?.pnl; return Number.isFinite(x) ? a + x * buySol : a; }, 0);
      const best = [...day].sort((a, c) => c.fcat - a.fcat)[0], worst = [...day].sort((a, c) => a.fcat - c.fcat)[0];
      const newLessons = [...lessons.entries()].filter(([, l]) => l.since > all.n - day.length && l.status !== 'faded').length;
      events.push({ kind: 'digest', title: `Daily digest: ${day.length} trades, FCAT ${sol(f)} SOL`, priority: 3, tags: ['calendar'], body: [
        `Last ${digestHours} h: ${day.length} trades, ${day.filter((r) => r.fcat > 0).length} won. FCAT ${sol(f)} SOL · your exit rules ${sol(rules)} SOL (at ${buySol} SOL a trade).`,
        best ? `Best: ${best.symbol ? '$' + best.symbol : best.mint.slice(0, 6)} ${pct(best.fcat, 0)} · worst: ${worst.symbol ? '$' + worst.symbol : worst.mint.slice(0, 6)} ${pct(worst.fcat, 0)}` : null,
        `Median: execution latency ${median(day.map((r) => r.delaySec)) ?? '?'} s, entry premium ${pct(median(day.map((r) => r.entryGap)), 0)}.`,
        ...filterLines(day), `New patterns today: ${newLessons}.`, journeyLine(records)].filter((x) => x != null).join('\n') });
    }
    return { prediction, matched, events };
  }

  /** Brain notes for one trade's alert (critical thinking about this trade vs everything learned). */
  function thinkingNotes(rec, out, records) {
    const n = [];
    const p = out?.prediction;
    if (p) {
      const acc = accuracy();
      n.push(`Prediction before the result: ${pct(p.fcat)}${p.basis.length ? ` (from ${p.basis.map((b) => b.label).join(', ')})` : ' (overall average)'} → actual ${pct(rec.fcat)}: ${p.win === rec.fcat > 0 ? 'RIGHT' : 'WRONG'}. Score ${acc.hits}/${acc.total} (${Math.round(acc.rate * 100)}%).`);
    } else n.push(`Predictions start after ${minTrades} trades (${all.n} so far).`);
    for (const m of (out?.matched || []).slice(0, 2)) n.push(`Matched ${m.status} pattern ${m.dev >= 0 ? '▲' : '▼'} "${m.label}" (${pct(m.avg)} avg) → ${m.agreed ? 'it held again' : 'this trade went against it'}.`);
    if (rec.shape) { const same = records.filter((r) => r.shape === rec.shape && Number.isFinite(r.fcat)); n.push(`Shape: ${rec.shape}. ${same.length} of ${all.n} trades look like this (avg FCAT ${pct(same.reduce((a, r) => a + r.fcat, 0) / (same.length || 1))}).`); }
    if (rec.ruleSim) n.push(`Your real exit rules: ${rec.ruleSim.open ? `still holding at ${rec.ruleSim.sec}s for his sell (marked ${pct(rec.ruleSim.pnl)})` : `${rec.ruleSim.how} at ${rec.ruleSim.sec}s → ${pct(rec.ruleSim.pnl)}`}.`);
    if (rec.ctx?.recent10m != null) n.push(rec.ctx.recent10m === 0 ? "Decu's first trade in 10 min." : `Decu's trade #${rec.ctx.recent10m + 1} in 10 min.`);
    const lag = median(records.slice(0, -1).map((r) => r.delaySec));
    if (rec.delaySec != null && lag != null && Math.abs(rec.delaySec - lag) >= 0.5) n.push(`Execution latency ${Math.abs(rec.delaySec - lag).toFixed(1)} s ${rec.delaySec > lag ? 'slower' : 'faster'} than usual (median ${lag} s).`);
    return n;
  }

  return {
    observe, predict, accuracy, journey, journeyLine, adviceLines, thinkingNotes,
    lessons: () => active(),
    snapshot: (records) => ({ journey: journey(records), lessons: active().map((s) => ({ label: s.label, status: s.status, trades: s.n, wins: s.wins, avgFcat: s.avg, z: s.z })), accuracy: accuracy(), accuracyLast20: accuracy(20), advice: advise(records, { buySol, maxPayPct, ...ruleOpts }) }),
    stats: () => ({ ...all, mean: mean(), sd: sd() }),
  };
}
