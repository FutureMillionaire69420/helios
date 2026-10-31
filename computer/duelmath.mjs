// DIP vs FCAT DUEL: the pure numbers (no network, no files, no clock unless one is passed in). Shared by the
// server (duel.mjs, duelbrain.mjs) and the dashboard. Tested in duelmath.test.mjs.
//
// Two PAPER traders watch every Decu buy side by side:
//  - FCAT buys as soon as Decu buys (if the filters pass).
//  - DIP waits up to 60 s after his buy for the price to come back to HIS price or lower, then buys.
// Both sell the moment profit reaches +18% in the first 15 s after their own buy, +24.5% any time after
// that, and the moment Decu sells. DIP also has a stop: the price 20% under Decu's buy price. FCAT has no stop.
// Nothing here ever trades: it only simulates fills from the coin's real curve states.

export const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const big = (x) => (typeof x === 'bigint' ? x : BigInt(Math.floor(Number(x) || 0)));

// ===== PRICES FROM A CURVE (or PumpSwap pool) STATE {vSol lamports, vTok raw} =====
// The same constant-product math as copybot.mjs curveBuy / curveSell: the pool fee comes off the SOL side.
/** Raw tokens received for spending `sol` SOL. */
export function buyRaw(state, sol, fee) {
  const net = BigInt(Math.floor(sol * 1e9 * (1 - fee)));
  const vSol = big(state?.vSol), vTok = big(state?.vTok);
  return net > 0n && vSol > 0n && vTok > 0n ? Number((vTok * net) / (vSol + net)) : 0;
}
/** SOL received for selling `raw` tokens, after the pool fee. */
export function sellSol(state, raw, fee) {
  const r = BigInt(Math.floor(Number(raw) || 0)), vSol = big(state?.vSol), vTok = big(state?.vTok);
  return r > 0n && vSol > 0n && vTok > 0n ? (Number((vSol * r) / (vTok + r)) / 1e9) * (1 - fee) : 0;
}
/** "PRICE vs PRICE" (the engine's netPrice): SOL that reached the curve per raw token, fees excluded. Decu's own
 *  trade event price (sol_amount / token_amount) is on this basis, so the two compare directly. */
export const netPrice = (solIn, raw, fee) => (raw > 0 && solIn > 0 ? (solIn * (1 - fee)) / raw : null);
/** Our price for a buy of `spend` SOL right now (same basis as Decu's price). */
export const buyPriceNow = (state, spend, fee) => netPrice(spend, buyRaw(state, spend, fee), fee);
/** Our sell price per raw token right now, before the pool fee (comparable with Decu's price). */
export function sellPriceNow(state, raw, fee) { const v = sellSol(state, raw, fee); return raw > 0 && v > 0 ? v / (1 - fee) / raw : null; }
/** Market cap in USD: price per token x 1 billion tokens (6 decimals). */
export const mcapUsd = (state, solUsd) => (fin(solUsd) && solUsd > 0 && Number(state?.vTok) > 0 ? (Number(state.vSol) / Number(state.vTok)) * 1e6 * solUsd : null);

// ===== THE TWO TRADERS' SETTINGS =====
// Your numbers. Each trader's brain starts here; in paper it may change the ones it is allowed to (LIMITS),
// and only after the change won on trades it had never seen (duelbrain.mjs).
const COMMON = {
  sizeSol: 0.1, maxPayPct: 20, mcapMin: 1000, mcapMax: 22000, hisUsdMin: 75,
  maxSec: 5, maxBlocks: 5, maxBuysAhead: 2, holder: 'relaxed',
  tpEarlyPct: 18, tpEarlySec: 15, tpLatePct: 24.5, sellOnHisSell: true,
};
export const DEFAULTS = {
  dip: { ...COMMON, kind: 'dip', dipTrigger: 'his-price', dipPct: 0, offHighPct: 10, dipWindowSec: 60, stopFromHisPct: 20 },
  // FCAT pays up to +50%: by the time any copy lands (~1 s) the price is a median 32% above Decu's (2026-10-30/31,
  // 50 buys), so at +20% FCAT never bought. Its brain moves this either way once a forward test proves it.
  fcat: { ...COMMON, kind: 'fcat', stopFromHisPct: null, maxPayPct: 50 },
};
/** Bumped when a default changes in a way saved paper state must pick up (duel.mjs migrates on load). */
export const SETTINGS_REV = 2;
/** What a brain may change, and within which bounds (paper only). Filters may move EITHER way inside these
 *  bounds, but only after the change won on Decu buys it had never seen. Still PROTECTED: the trade size, paper
 *  mode, selling at his sell, FCAT having no stop, DIP keeping one, the holder rule's $500 floor. */
export const LIMITS = {
  tpEarlyPct: [8, 50], tpEarlySec: [5, 30], tpLatePct: [12, 100],
  maxPayPct: [0, 80], mcapMin: [500, 50000], mcapMax: [1000, 100000], hisUsdMin: [20, 5000],
  maxBuysAhead: [0, 6], maxSec: [1, 10], maxBlocks: [1, 10],
  dipPct: [0, 25], dipWindowSec: [15, 60], offHighPct: [5, 30],
  stopFromHisPct: [10, 30], // DIP only (FCAT's stop is protected: none)
};
export function allowedChange(kind, key, value) {
  const lim = LIMITS[key];
  if (!lim || !fin(value)) return false;
  if (key === 'stopFromHisPct' && kind !== 'dip') return false;
  if (['dipPct', 'dipWindowSec', 'offHighPct'].includes(key) && kind !== 'dip') return false;
  return value >= lim[0] && value <= lim[1];
}

// ===== ENTRY CHECKS =====
// The checks known when Decu's buy is spotted. Holder and crowd arrive a moment later (pending until then);
// "pay at most" is checked at the simulated fill. Missing data never passes (fail-closed), and is reported
// apart from a real rejection ("missing data" vs "rejected").
export const CHECK_NAMES = {
  hisUsd: "Decu's buy too small", mcap: 'market cap outside the range', timing: 'spotted too late',
  crowd: 'too many buyers ahead', holder: 'holder money too low', pay: 'price too far above his',
  'data:mcap': 'no market cap (missing data)', 'data:timing': 'no timing (missing data)', 'data:crowd': 'no crowd count (missing data)', 'data:holder': 'no holder data (missing data)', 'data:price': 'no price (missing data)',
  holding: 'already holding this coin', balance: 'paper balance too low', 'his-sold': 'Decu sold first', 'no-dip': 'never dipped to the trigger', restart: 'bot restarted mid-trade',
};
/** -> {fails:[keys], pending:[keys]}. cand: the shared candidate (duel.mjs). p: the trader's settings. */
export function entryChecks(cand, p, { filters = true } = {}) {
  const fails = [], pending = [];
  if (!filters) return { fails, pending };
  if (!fin(cand.hisUsd) || cand.hisUsd < p.hisUsdMin) fails.push('hisUsd');
  if (!fin(cand.hisMcapUsd)) fails.push('data:mcap');
  else if (cand.hisMcapUsd < p.mcapMin || cand.hisMcapUsd > p.mcapMax) fails.push('mcap');
  const secOk = fin(cand.secAtSeen) ? cand.secAtSeen <= p.maxSec : null, blkOk = fin(cand.blocksAtSeen) ? cand.blocksAtSeen <= p.maxBlocks : null;
  if (secOk == null && blkOk == null) fails.push('data:timing'); else if (!secOk && !blkOk) fails.push('timing');
  if (p.maxBuysAhead != null) {
    const cr = cand.crowd;
    if (cr?.status === 'skipped') { /* not counted: every trader had already rejected this buy */ }
    else if (!cr || cr.status === 'pending') pending.push('crowd');
    else if (cr.status !== 'done' || !fin(cr.buysAhead)) fails.push('data:crowd');
    else if (cr.buysAhead > p.maxBuysAhead) fails.push('crowd');
  }
  if (p.holder && p.holder !== 'off') {
    const h = cand.holder0;
    if (!h || h.status === 'pending') pending.push('holder');
    else if (h.status !== 'done' || !h.verdict) fails.push('data:holder');
    else if (!(p.holder === 'baseline' ? h.verdict.safe : h.verdict.relaxedPass)) fails.push('holder');
  }
  return { fails, pending };
}
export const isMissing = (key) => String(key).startsWith('data:');

// ===== DIP TRIGGERS =====
/** Is the dip there? buyPx: our buy price now; P: Decu's price; high: our highest buy price since his buy. */
export function dipTriggered(p, { buyPx, P, high }) {
  if (!fin(buyPx) || !fin(P) || P <= 0) return false;
  if (p.dipTrigger === 'off-high') return fin(high) && high > 0 && buyPx <= high * (1 - p.offHighPct / 100) && buyPx <= P * (1 + p.maxPayPct / 100);
  return buyPx <= P * (1 - (p.dipPct || 0) / 100); // 'his-price': back to his price (or dipPct under it)
}

// ===== EXITS =====
/** Profit fraction if sold now: the sell value, the 0.5% haircut and the network fee, against the cost
 *  (the same basis as the engine's price watch). */
export const markPnl = (sellValueSol, cost, sellFeeSol) => (fin(sellValueSol) && cost > 0 ? (sellValueSol * 0.995 - sellFeeSol - cost) / cost : null);
/** -> {rule, pnl} or null. now/fillAt in ms; sellPx and P on the same price basis. */
export function exitCheck(p, pos, { now, pnl, sellPx }) {
  if (!fin(pnl)) return null;
  const age = (now - pos.fillAt) / 1000;
  if (age <= p.tpEarlySec && pnl >= p.tpEarlyPct / 100) return { rule: 'tp-early', pnl };
  if (age > p.tpEarlySec && pnl >= p.tpLatePct / 100) return { rule: 'tp-late', pnl };
  if (fin(p.stopFromHisPct) && fin(sellPx) && fin(pos.P) && sellPx <= pos.P * (1 - p.stopFromHisPct / 100)) return { rule: 'stop', pnl };
  return null;
}
export const EXIT_NAMES = { 'tp-early': `take-profit in the first seconds`, 'tp-late': 'take-profit later', stop: "stop (20% under Decu's price)", 'his-sell': 'Decu sold', 'his-sell-late': 'Decu sold (found late)' };

// ===== THE HOLDER MONEY RULE: YOUR BASELINE AND A RELAXED EXPERIMENT =====
// BASELINE (unchanged, learn.mjs holderVerdict): holders other than the dev and the curve must hold at least
// $1000 at a $10k market cap, $2500 at $20k, $4000 at $30k (HOLDER_RULES): SAFE, else RISKY. Under $10k: always SAFE.
// RELAXED (a separate label, never written as SAFE): the same steps times k (0 < k <= 1). k is the LEAST loosening
// that accepts +70% more coins than the baseline on recent coins that passed every other check, never below
// your floor ($500 at a $10k market cap, so k >= 0.5). Coins with no holder data are counted apart, never as rejected.
export function baselineRequired(mcapUsd, rules) { let r = 0; for (const [m, h] of rules || []) if (mcapUsd >= m) r = Math.max(r, h); return r; }
export function kFloor(rules, floorUsd = 500, atMcap = 10000) { const b = baselineRequired(atMcap, rules); return b > 0 ? Math.min(1, Math.max(0, floorUsd / b)) : 1; }
export function holderCheck(heldUsd, mcap, rules, k) {
  if (!fin(heldUsd) || !fin(mcap)) return null;
  const required = baselineRequired(mcap, rules), relaxedRequired = required * k;
  return { heldUsd, mcapUsd: mcap, required, safe: heldUsd >= required, k, relaxedRequired, relaxedPass: heldUsd >= relaxedRequired, ratio: required > 0 ? heldUsd / required : null };
}
/** samples [{heldUsd, mcapUsd}] (coins that passed every other check and HAVE holder data). -> the k to use. */
export function calibrateK(samples, rules, { target = 1.7, kMin = 0.5 } = {}) {
  const rows = samples.filter((x) => fin(x.heldUsd) && fin(x.mcapUsd));
  const always = rows.filter((x) => baselineRequired(x.mcapUsd, rules) === 0).length;
  const crit = rows.map((x) => { const r = baselineRequired(x.mcapUsd, rules); return r > 0 ? x.heldUsd / r : null; }).filter((x) => x != null).sort((a, b) => b - a);
  const accepted = (k) => always + crit.filter((c) => c >= k - 1e-12).length;
  const baseline = accepted(1), goal = Math.max(1, Math.ceil(target * baseline));
  let k = kMin;
  // the largest k (least loosening) that still reaches the goal: only the critical ratios can change the count
  for (const c of [1, ...crit.filter((c) => c < 1 && c >= kMin)]) if (accepted(c) >= goal) { k = c; break; }
  const acc = accepted(k);
  return { k: Math.round(k * 1e4) / 1e4, n: rows.length, always, baseline, accepted: acc, goal, increase: baseline > 0 ? acc / baseline - 1 : null, targetMet: acc >= goal, kMin, maxIncrease: baseline > 0 ? accepted(kMin) / baseline - 1 : null };
}

// ===== STATS =====
const sum = (xs) => xs.reduce((a, x) => a + x, 0);
export const median = (xs) => { const s = xs.filter(fin).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };
/** A small seeded random generator (the same numbers every run, so a test and a rerun agree). */
export function rng(seed = 42) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
/** Bootstrap interval of the mean: [low, high] at `level` (e.g. 0.9). */
export function bootstrapMean(xs, { level = 0.9, n = 1000, seed = 7 } = {}) {
  const v = xs.filter(fin);
  if (v.length < 2) return null;
  const r = rng(seed), means = [];
  for (let i = 0; i < n; i++) { let t = 0; for (let j = 0; j < v.length; j++) t += v[Math.floor(r() * v.length)]; means.push(t / v.length); }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(((1 - level) / 2) * n)], hi = means[Math.min(n - 1, Math.floor((1 - (1 - level) / 2) * n))];
  return { mean: sum(v) / v.length, low: lo, high: hi, n: v.length };
}
/** One trader's results from its closed trades [{pnlSol, ret, closedAt, holdSec, exit}]. */
export function summarize(trades) {
  const t = trades.filter((x) => fin(x.pnlSol)).sort((a, b) => a.closedAt - b.closedAt);
  const wins = t.filter((x) => x.pnlSol > 0), losses = t.filter((x) => x.pnlSol <= 0);
  let eq = 0, peak = 0, dd = 0;
  for (const x of t) { eq += x.pnlSol; peak = Math.max(peak, eq); dd = Math.min(dd, eq - peak); }
  const byExit = {};
  for (const x of t) byExit[x.exit] = (byExit[x.exit] || 0) + 1;
  const gw = sum(wins.map((x) => x.pnlSol)), gl = -sum(losses.map((x) => x.pnlSol));
  return {
    n: t.length, wins: wins.length, winRate: t.length ? wins.length / t.length : null, pnlSol: sum(t.map((x) => x.pnlSol)),
    avgRet: t.length ? sum(t.map((x) => x.ret)) / t.length : null, medianRet: median(t.map((x) => x.ret)),
    best: t.length ? Math.max(...t.map((x) => x.ret)) : null, worst: t.length ? Math.min(...t.map((x) => x.ret)) : null,
    profitFactor: gl > 0 ? gw / gl : wins.length ? Infinity : null, maxDrawdownSol: dd, avgHoldSec: t.length ? sum(t.map((x) => x.holdSec || 0)) / t.length : null, byExit,
  };
}
/** Evidence words for a sample: enough trades and an interval that does not cross zero. */
export function evidence(xs, { minN = 30, level = 0.9 } = {}) {
  const b = bootstrapMean(xs, { level });
  const n = xs.filter(fin).length;
  if (n < minN || !b) return { level: 'too few', n, minN, ci: b, text: `${n} of ${minN} trades needed` };
  if (b.low > 0) return { level: 'supported', n, minN, ci: b, text: `better than zero (${Math.round(level * 100)}% interval ${pctTxt(b.low)} to ${pctTxt(b.high)})` };
  if (b.high < 0) return { level: 'against', n, minN, ci: b, text: `worse than zero (${Math.round(level * 100)}% interval ${pctTxt(b.low)} to ${pctTxt(b.high)})` };
  return { level: 'unclear', n, minN, ci: b, text: `not clear yet (interval ${pctTxt(b.low)} to ${pctTxt(b.high)} crosses zero)` };
}
const pctTxt = (x) => (fin(x) ? `${x < 0 ? '−' : '+'}${Math.abs(x * 100).toFixed(1)}%` : '—');

/** Head to head on the SAME Decu buys. byCand: {candId: {a: trade|null, b: trade|null}}. */
export function headToHead(byCand) {
  const out = { both: { n: 0, a: 0, b: 0 }, onlyA: { n: 0, sol: 0 }, onlyB: { n: 0, sol: 0 }, diffs: [] };
  for (const { a, b } of Object.values(byCand)) {
    if (a && b) { out.both.n++; out.both.a += a.pnlSol; out.both.b += b.pnlSol; }
    else if (a) { out.onlyA.n++; out.onlyA.sol += a.pnlSol; }
    else if (b) { out.onlyB.n++; out.onlyB.sol += b.pnlSol; }
    if (a || b) out.diffs.push((b?.pnlSol || 0) - (a?.pnlSol || 0)); // > 0: b made more on this Decu buy
  }
  return out;
}

// ===== REPLAY (the brain's quick look back before it starts a real forward test) =====
/** What settings p would have done on one recorded Decu buy. path: [[msSinceHisBuy, vSol, vTok], ...] (sampled),
 *  P: his price, hisSellMs: ms since his buy when he sold (or null). Approximate: the path is sampled. */
export function replay(p, { path, P, hisSellMs = null, fee, sizeSol = p.sizeSol, sideFee = 0.002, seenMs = 0, landMs = 1000 }) {
  if (!Array.isArray(path) || !path.length || !fin(P)) return null;
  const at = (ms) => { let s = null; for (const x of path) { if (x[0] <= ms) s = x; else break; } return s; };
  const st = (x) => ({ vSol: x[1], vTok: x[2] });
  const spend = sizeSol * 0.995;
  let sendMs = null, high = 0;
  if (p.kind === 'fcat') sendMs = seenMs;
  else for (const x of path) {
    if (x[0] < seenMs) continue;
    if (x[0] > p.dipWindowSec * 1000 || (hisSellMs != null && x[0] >= hisSellMs)) break;
    const px = buyPriceNow(st(x), spend, fee); if (!fin(px)) continue;
    high = Math.max(high, px);
    if (dipTriggered(p, { buyPx: px, P, high })) { sendMs = x[0]; break; }
  }
  if (sendMs == null) return { taken: false, why: 'no-dip' };
  const fillMs = sendMs + landMs, f = at(fillMs) || path[0];
  const raw = buyRaw(st(f), spend, fee), entry = netPrice(spend, raw, fee);
  if (!(raw > 0) || entry / P - 1 > p.maxPayPct / 100) return { taken: false, why: 'pay' };
  const cost = sizeSol + sideFee, pos = { fillAt: fillMs, P };
  let exitMs = null, rule = null;
  for (const x of path) {
    if (x[0] <= fillMs) continue;
    if (hisSellMs != null && x[0] >= hisSellMs) break;
    const v = sellSol(st(x), raw, fee), e = exitCheck(p, pos, { now: x[0], pnl: markPnl(v, cost, sideFee), sellPx: sellPriceNow(st(x), raw, fee) });
    if (e) { exitMs = x[0]; rule = e.rule; break; }
  }
  if (exitMs == null && hisSellMs != null) { exitMs = Math.max(hisSellMs, fillMs); rule = 'his-sell'; }
  if (exitMs == null) { const last = path[path.length - 1]; const v = sellSol(st(last), raw, fee); return { taken: true, open: true, ret: (v * 0.995 - sideFee - cost) / cost, entry, rule: 'open' }; }
  const s = at(exitMs + landMs) || path[path.length - 1];
  const proceeds = sellSol(st(s), raw, fee) * 0.995 - sideFee;
  return { taken: true, open: false, ret: (proceeds - cost) / cost, pnlSol: proceeds - cost, entry, rule, holdMs: exitMs + landMs - fillMs };
}
