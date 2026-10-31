// DASHBOARD NUMBERS, shared by the browser (dashboard.js imports this file) and the server (runtime.mjs builds
// the trade rows with it). Pure functions: no dependencies, no network, no clock unless one is passed in.
// Tested in dashcalc.test.mjs.
//
// Two kinds of profit, never mixed in one number:
//  - FCAT estimate (every studied Decu buy, bought or skipped): what selling when Decu sold would have made,
//    fees included. The trade list, the filters and the what-if tester use it, so a skipped buy can be compared.
//  - realized (closed positions): what the bot actually banked with its own exit rules. The Rolex meter and the
//    profit calendar use it (paper realized in paper, real money in live).

export const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const rnd = (x, d) => (fin(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
const median = (xs) => { const s = xs.filter(fin).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

// ===== TRADE ROWS (server side: /api/trades) =====
/** One compact row per studied Decu buy. closed: the closed-trade ledger, joined to bought rows for the realized result. */
export function tradeRows(records, { closed = [], buySol = 0.1 } = {}) {
  const byMint = new Map();
  for (const t of closed) if (t?.mint && fin(t.pnlSol)) { if (!byMint.has(t.mint)) byMint.set(t.mint, []); byMint.get(t.mint).push(t); }
  const out = [];
  for (const r of records) {
    const time = Date.parse(r?.time);
    if (!r?.mint || !fin(time)) continue;
    const bought = r.taken !== false && !r.skipReason;
    let real = null;
    if (bought && byMint.has(r.mint)) {
      let best = null;
      for (const t of byMint.get(r.mint)) { const d = Math.abs((t.boughtAt ?? t.closedAt) - time); if (d <= 600e3 && (!best || d < best.d)) best = { d, t }; }
      if (best) real = { sol: rnd(best.t.pnlSol, 6), pct: rnd(best.t.pnlPct, 4), rule: best.t.rule || null, closedAt: best.t.closedAt ?? null };
    }
    out.push({
      id: `${time}|${r.mint}`, time, mint: r.mint, sym: r.symbol || null, bought, skip: r.skipReason || null,
      fcat: rnd(r.fcat, 5), cost: rnd(r.cost > 0 ? r.cost : buySol, 6), solUsd: r.hisUsd > 0 && r.hisSol > 0 ? rnd(r.hisUsd / r.hisSol, 2) : null,
      prem: rnd(r.entryGap, 4), delay: rnd(r.delaySec, 2), blocks: r.latency?.blocksAfter ?? null,
      mcap: fin(r.hisMcapUsd) ? Math.round(r.hisMcapUsd) : fin(r.coin?.marketCapUsd) ? Math.round(r.coin.marketCapUsd) : null,
      hisUsd: fin(r.hisUsd) ? Math.round(r.hisUsd) : null, hisSol: rnd(r.hisSol, 4), crowd: fin(r.crowd?.trades) ? r.crowd.trades : null,
      holders: r.coin?.holders ?? r.holderVerdict?.holders ?? null, safe: r.holderVerdict?.heldUsd != null ? !!r.holderVerdict.safe : null,
      ageMin: fin(r.coin?.ageSec) ? Math.round(r.coin.ageSec / 60) : null, first: !r.copiedLaterBuy,
      exit: r.fcatExit || null, exitSec: fin(r.fcatSec) ? r.fcatSec : null, hisSold: fin(r.hisSoldAtSec) ? r.hisSoldAtSec : null,
      peak: rnd(r.peak, 4), worst: rnd(r.worst, 4), btsab: r.btsab ?? null, pcat: rnd(r.pcat, 4),
      curve: Array.isArray(r.curve) ? r.curve.map((v) => rnd(v, 4)) : null, shape: r.shape || null,
      pred: rnd(r.prediction?.fcat, 4), busy: fin(r.ctx?.recent10m) ? r.ctx.recent10m : null, real,
    });
  }
  return out;
}

// ===== PROFIT OF A ROW =====
export const sizeOf = (x, buySol = 0.1) => (fin(x?.cost) && x.cost > 0 ? x.cost : buySol);
/** FCAT estimate in SOL: the result fraction x what the trade cost (FCAT already has the fees in it). */
export const profitSol = (x, f = x?.fcat, buySol = 0.1) => (fin(f) ? f * sizeOf(x, buySol) : null);
/** SOL -> $ at the SOL price of that trade (from Decu's own trade), else the price now. */
export const usdOf = (sol, x, solUsd = null) => { const p = x?.solUsd > 0 ? x.solUsd : solUsd > 0 ? solUsd : null; return fin(sol) && p ? sol * p : null; };

// ===== TIME (in the bot's timezone) =====
const fmts = new Map();
const zoneFmt = (tz) => { let f = fmts.get(tz); if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23' }); fmts.set(tz, f); } return f; };
export function zoneParts(ms, tz) { const o = {}; for (const p of zoneFmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value; return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(o.weekday) }; }
/** 'YYYY-MM-DD' of a moment in the timezone. */
export const dayKey = (ms, tz) => { const p = zoneParts(ms, tz); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
export const startOfDay = (ms, tz) => { const p = zoneParts(ms, tz); return ms - ((p.h * 60 + p.mi) * 60 + p.s) * 1000 - (ms % 1000); };
export const DATE_PRESETS = [['today', 'Today'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All']];
export function rangeFrom(preset, now, tz) {
  if (preset === 'today') return startOfDay(now, tz);
  if (preset === '7d') return now - 7 * 86400e3;
  if (preset === '30d') return now - 30 * 86400e3;
  return null; // 'all'
}

// ===== TRADE HISTORY FILTERS =====
export const FILTER_DEFAULTS = { range: '30d', day: null, result: 'all', status: 'all', q: '', mcapMin: null, mcapMax: null, premMin: null, premMax: null, delayMax: null, hisUsdMin: null, crowdMax: null, holder: 'any', firstOnly: false, exit: 'any' };
const inRange = (v, lo, hi) => (lo == null && hi == null) || (fin(v) && (lo == null || v >= lo) && (hi == null || v <= hi));
/** Does the row pass the filter? A row without a number is left out once a range on that number is set. */
export function matches(x, f, { tz = 'UTC', now = Date.now() } = {}) {
  if (f.day) { if (dayKey(x.time, tz) !== f.day) return false; }
  else { const from = rangeFrom(f.range, now, tz); if (from != null && x.time < from) return false; }
  if (f.status === 'bought' && !x.bought) return false;
  if (f.status === 'skipped' && x.bought) return false;
  if (f.result === 'won' && !(x.fcat > 0)) return false;
  if (f.result === 'lost' && !(fin(x.fcat) && x.fcat <= 0)) return false;
  const q = String(f.q || '').trim().toLowerCase().replace(/^\$/, '');
  if (q && !((x.sym || '').toLowerCase().includes(q) || x.mint.toLowerCase().startsWith(q))) return false;
  if (!inRange(x.mcap, f.mcapMin, f.mcapMax) || !inRange(x.prem, f.premMin, f.premMax)) return false;
  if (f.delayMax != null && !(fin(x.delay) && x.delay <= f.delayMax)) return false;
  if (f.hisUsdMin != null && !(fin(x.hisUsd) && x.hisUsd >= f.hisUsdMin)) return false;
  if (f.crowdMax != null && !(fin(x.crowd) && x.crowd <= f.crowdMax)) return false;
  if (f.holder === 'safe' && x.safe !== true) return false;
  if (f.holder === 'risky' && x.safe !== false) return false;
  if (f.firstOnly && !x.first) return false;
  if (f.exit === 'his' && !/his sell/.test(x.exit || '')) return false;
  if (f.exit === 'limit' && (!x.exit || /his sell/.test(x.exit))) return false;
  return true;
}
/** How many filters differ from the defaults (the badge on "More filters"). Date, result and status have their own controls. */
export const extraFilterCount = (f) => ['mcapMin', 'mcapMax', 'premMin', 'premMax', 'delayMax', 'hisUsdMin', 'crowdMax'].filter((k) => f[k] != null).length + (f.holder !== 'any') + !!f.firstOnly + (f.exit !== 'any');

/** Totals of a set of rows (FCAT estimate) plus the realized result where the bot closed the position. */
export function totals(rows, { buySol = 0.1, solUsd = null } = {}) {
  const t = { rows: rows.length, n: 0, wins: 0, sol: 0, usd: 0, avg: null, best: null, worst: null, real: 0, realN: 0, realWins: 0, bought: 0, skipped: 0 };
  let sumF = 0; const prem = [], delay = [];
  for (const x of rows) {
    if (x.bought) t.bought++; else t.skipped++;
    if (x.real && fin(x.real.sol)) { t.real += x.real.sol; t.realN++; if (x.real.sol > 0) t.realWins++; }
    if (!fin(x.fcat)) continue;
    t.n++; if (x.fcat > 0) t.wins++; sumF += x.fcat;
    const s = profitSol(x, x.fcat, buySol); t.sol += s; t.usd += usdOf(s, x, solUsd) ?? 0;
    if (!t.best || x.fcat > t.best.fcat) t.best = x;
    if (!t.worst || x.fcat < t.worst.fcat) t.worst = x;
    prem.push(x.prem); delay.push(x.delay);
  }
  t.losses = t.n - t.wins; t.winRate = t.n ? t.wins / t.n : null; t.avg = t.n ? sumF / t.n : null;
  t.medianPrem = median(prem); t.medianDelay = median(delay);
  return t;
}
/** Running total (SOL) in time order, for the line chart under the trade list. */
export function runningTotal(rows, { buySol = 0.1 } = {}) {
  let s = 0; return [...rows].filter((x) => fin(x.fcat)).sort((a, b) => a.time - b.time).map((x) => ({ time: x.time, sol: (s += profitSol(x, x.fcat, buySol)) }));
}

// ===== WHAT-IF TESTER =====
// The rules a test can switch on. Each says when a row FAILS it. A row without the number fails (fail-closed,
// as the bot itself does with a premium it cannot measure).
const hourIn = (h, from, to) => (from <= to ? h >= from && h < to : h >= from || h < to);
export const RULES = [
  { key: 'prem', label: 'Pay at most', unit: "% above Decu's price", fails: (x, v) => !(fin(x.prem) && x.prem <= v + 1e-9) },
  { key: 'mcapMax', label: 'Market cap at most', unit: 'in $, at his buy', fails: (x, v) => !(fin(x.mcap) && x.mcap <= v) },
  { key: 'mcapMin', label: 'Market cap at least', unit: 'in $, at his buy', fails: (x, v) => !(fin(x.mcap) && x.mcap >= v) },
  { key: 'hisUsdMin', label: "Decu's buy at least", unit: 'in $', fails: (x, v) => !(fin(x.hisUsd) && x.hisUsd >= v) },
  { key: 'delayMax', label: 'Bought within', unit: 'seconds of Decu', fails: (x, v) => !(fin(x.delay) && x.delay <= v + 1e-9) },
  { key: 'crowdMax', label: 'Buyers ahead of you at most', unit: 'other buys between his and yours', fails: (x, v) => !(fin(x.crowd) && x.crowd <= v) },
  { key: 'busyMax', label: 'Decu buys in the 10 min before at most', unit: 'skips him when he is on a spree', fails: (x, v) => !(fin(x.busy) && x.busy <= v) },
  { key: 'safeOnly', label: 'Holder money rule says SAFE', unit: '', bool: true, fails: (x) => x.safe !== true },
  { key: 'firstOnly', label: "Only Decu's first buy of a coin", unit: '', bool: true, fails: (x) => !x.first },
];
const ruleOn = (R, rules) => (R.bool ? !!rules[R.key] : rules[R.key] != null);
export const WHATIF_DEFAULTS = { includeSkipped: true, rules: { prem: null, mcapMax: null, mcapMin: null, hisUsdMin: null, delayMax: null, crowdMax: null, busyMax: null, safeOnly: false, firstOnly: false, hourFrom: null, hourTo: null }, exit: { tp: null, sl: null, at: null } };
/** The trade's result with a different exit, from its per-second path (0-15 s). Nothing triggered: its FCAT (his sell / 15 s). */
export function exitWith(x, exit = {}) {
  const { tp = null, sl = null, at = null } = exit;
  if ((tp == null && sl == null && at == null) || !Array.isArray(x.curve)) return x.fcat;
  const end = fin(x.exitSec) ? Math.min(x.exitSec, x.curve.length - 1) : x.curve.length - 1;
  for (let s = 0; s <= end; s++) {
    const v = x.curve[s]; if (!fin(v)) continue;
    if (sl != null && v <= sl) return v;
    if (tp != null && v >= tp) return v;
    if (at != null && s >= at) return v;
  }
  return x.fcat;
}
/**
 * What the bot did (bought trades) vs what your rules would have done, on the same studied Decu buys in time
 * order. includeSkipped: buys the bot skipped (premium, max coins, paused...) can come back in when they pass
 * your rules. Older 70% / newer 30% by time shows whether a rule holds up or only fits the past.
 */
export function whatIf(rows, { rules = {}, exit = {}, includeSkipped = true, buySol = 0.1, solUsd = null, split = 0.7, tz = 'UTC' } = {}) {
  const all = rows.filter((x) => fin(x.fcat)).sort((a, b) => a.time - b.time);
  const active = RULES.filter((R) => ruleOn(R, rules));
  const hours = fin(rules.hourFrom) && fin(rules.hourTo) && rules.hourFrom !== rules.hourTo;
  const exitChanged = exit.tp != null || exit.sl != null || exit.at != null;
  const sideA = { n: 0, wins: 0, sol: 0, usd: 0 }, sideB = { n: 0, wins: 0, sol: 0, usd: 0, added: 0 };
  const removed = Object.fromEntries([...active.map((R) => [R.key, { n: 0, bought: 0, sol: 0 }]), ...(hours ? [['hours', { n: 0, bought: 0, sol: 0 }]] : [])]);
  const cut = Math.floor(all.length * split), older = { n: 0, a: 0, b: 0 }, newer = { n: 0, a: 0, b: 0 };
  let a = 0, b = 0, aPeak = 0, bPeak = 0, aDD = 0, bDD = 0; const series = [];
  all.forEach((x, i) => {
    const part = i < cut ? older : newer; part.n++;
    const base = profitSol(x, x.fcat, buySol);
    if (x.bought) { sideA.n++; if (x.fcat > 0) sideA.wins++; sideA.sol += base; sideA.usd += usdOf(base, x, solUsd) ?? 0; a += base; part.a += base; }
    const inUniverse = includeSkipped || x.bought;
    let fails = 0;
    for (const R of active) if (R.fails(x, rules[R.key])) { fails++; if (inUniverse) { const g = removed[R.key]; g.n++; g.sol += base; if (x.bought) g.bought++; } }
    if (hours && !hourIn(zoneParts(x.time, tz).h, rules.hourFrom, rules.hourTo)) { fails++; if (inUniverse) { const g = removed.hours; g.n++; g.sol += base; if (x.bought) g.bought++; } }
    if (!fails && inUniverse) {
      const f = exitWith(x, exit);
      if (fin(f)) { const s = profitSol(x, f, buySol); sideB.n++; if (f > 0) sideB.wins++; sideB.sol += s; sideB.usd += usdOf(s, x, solUsd) ?? 0; if (!x.bought) sideB.added++; b += s; part.b += s; }
    }
    aPeak = Math.max(aPeak, a); aDD = Math.min(aDD, a - aPeak); bPeak = Math.max(bPeak, b); bDD = Math.min(bDD, b - bPeak);
    series.push({ time: x.time, actual: a, test: b });
  });
  const same = !active.length && !hours && !exitChanged && !includeSkipped;
  const gO = older.b - older.a, gN = newer.b - newer.a, eps = 1e-9;
  const verdict = same ? { kind: 'same', text: 'No rule switched on: this is exactly what the bot did.' }
    : older.n < 20 || newer.n < 10 ? { kind: 'few', text: `Not enough trades to tell yet (${all.length}; needs 30 or more).` }
    : gO > eps && gN > eps ? { kind: 'holds', text: 'Better on the older trades AND on the newer ones: this holds up.' }
    : gO > eps ? { kind: 'luck', text: 'Better on the older trades only. The newer trades did not confirm it, so it may be luck.' }
    : gN > eps ? { kind: 'recent', text: 'Worse on the older trades, better on the newest ones. Give it more time before trusting it.' }
    : { kind: 'worse', text: 'Worse than what the bot did, on both the older and the newer trades.' };
  const done = (s, dd) => ({ ...s, winRate: s.n ? s.wins / s.n : null, avg: s.n ? s.sol / s.n : null, dd });
  return { trades: all.length, actual: done(sideA, aDD), test: done(sideB, bDD), removed, older, newer, verdict, series, split };
}
/** Values worth trying per rule (null = rule off). */
export const CANDIDATES = {
  prem: [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.75, 1, null], mcapMax: [5e3, 7.5e3, 1e4, 1.5e4, 2e4, 3e4, 5e4, 1e5, null],
  mcapMin: [null, 3e3, 5e3, 7.5e3, 1e4, 1.5e4, 2e4], hisUsdMin: [null, 50, 100, 200, 300, 500, 1000], delayMax: [1, 1.5, 2, 2.5, 3, 4, 5, null],
  crowdMax: [0, 1, 2, 3, 5, 8, null], busyMax: [0, 1, 2, 3, 5, null], tp: [0.1, 0.15, 0.2, 0.3, 0.5, 0.75, 1, null], sl: [-0.1, -0.15, -0.2, -0.3, -0.4, null], at: [2, 3, 5, 8, 10, 12, null],
};
/** The best value of one rule, picked on the OLDER trades only (other rules as they are), with its result on the newer ones. */
export function bestValue(rows, key, opts = {}) {
  const exitKey = ['tp', 'sl', 'at'].includes(key);
  let best = null;
  for (const v of CANDIDATES[key] || []) {
    const o = exitKey ? { ...opts, exit: { ...(opts.exit || {}), [key]: v } } : { ...opts, rules: { ...(opts.rules || {}), [key]: v } };
    const res = whatIf(rows, o);
    if (!best || res.older.b > best.res.older.b + 1e-12) best = { value: v, res };
  }
  if (!best) return null;
  const { res } = best;
  return { key, value: best.value, olderSol: res.older.b, newerSol: res.newer.b, olderGain: res.older.b - res.older.a, newerGain: res.newer.b - res.newer.a, holds: res.newer.n >= 10 && res.newer.b - res.newer.a > 0 && res.older.b - res.older.a > 0, newerN: res.newer.n };
}

// ===== PROFIT CALENDAR =====
/** Sunday-first weeks of a month; each day carries its totals from days ({'YYYY-MM-DD': {usd, sol, n, wins}}). */
export function monthGrid(year, month, days = {}) {
  const startDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(), n = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells = Array.from({ length: startDow }, () => null);
  for (let d = 1; d <= n; d++) { const key = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`; cells.push({ key, d, data: days[key] || null }); }
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}
const dayValue = (v) => (fin(v?.usd) ? v.usd : fin(v?.sol) ? v.sol : 0);
/** Best / worst day, green and red days, streaks (over days that had trades). */
export function dayStats(days = {}, { from = null, to = null } = {}) {
  const list = Object.entries(days).filter(([k, v]) => v?.n > 0 && (!from || k >= from) && (!to || k <= to)).sort(([x], [y]) => x.localeCompare(y)).map(([day, v]) => ({ day, ...v, value: dayValue(v) }));
  const s = { days: list.length, green: 0, red: 0, flat: 0, usd: 0, sol: 0, trades: 0, wins: 0, best: null, worst: null, avg: null, streak: null, longestGreen: 0, longestRed: 0 };
  let run = 0, kind = null;
  for (const x of list) {
    const k = x.value > 0 ? 'green' : x.value < 0 ? 'red' : 'flat';
    s[k]++; s.usd += x.usd || 0; s.sol += x.sol || 0; s.trades += x.n; s.wins += x.wins || 0;
    if (!s.best || x.value > s.best.value) s.best = x;
    if (!s.worst || x.value < s.worst.value) s.worst = x;
    run = k === kind ? run + 1 : 1; kind = k;
    if (k === 'green') s.longestGreen = Math.max(s.longestGreen, run);
    if (k === 'red') s.longestRed = Math.max(s.longestRed, run);
  }
  if (list.length) { s.avg = s.usd / list.length; s.streak = { kind, n: run }; }
  return s;
}
/** Totals per weekday (0 = Sunday) and per hour of the day, from realized entries [{t, usd, sol}]. */
export function byWeekdayHour(entries = [], tz = 'UTC') {
  const wd = Array.from({ length: 7 }, (_, i) => ({ i, n: 0, usd: 0, sol: 0, wins: 0 })), hr = Array.from({ length: 24 }, (_, i) => ({ i, n: 0, usd: 0, sol: 0, wins: 0 }));
  for (const e of entries) {
    if (!fin(e?.t)) continue;
    const p = zoneParts(e.t, tz);
    for (const g of [wd[p.wd], hr[p.h]]) { if (!g) continue; g.n++; g.usd += e.usd || 0; g.sol += e.sol || 0; if ((e.sol || 0) > 0) g.wins++; }
  }
  return { weekday: wd, hour: hr };
}

// ===== THE ROLEX: pace and what it takes =====
/** Average $ per calendar day over the last windowDays (or since the first trading day, when later). */
export function pace(days = {}, { now = Date.now(), tz = 'UTC', windowDays = 7 } = {}) {
  const keys = Object.keys(days).filter((k) => days[k]?.n > 0).sort();
  if (!keys.length) return null;
  const today = dayKey(now, tz), start = dayKey(now - (windowDays - 1) * 86400e3, tz), from = keys[0] > start ? keys[0] : start;
  const span = Math.max(1, Math.round((Date.parse(today) - Date.parse(from)) / 86400e3) + 1);
  let usd = 0; for (const k of keys) if (k >= from && k <= today) usd += dayValue(days[k]);
  return { perDay: usd / span, days: span, from, usd };
}
/** When the goal is reached at a pace. null = not on pace (no profit per day). */
export function eta(remainingUsd, perDay, now = Date.now()) {
  if (!(remainingUsd > 0)) return { reached: true, days: 0, date: now };
  if (!(perDay > 0)) return null;
  const days = remainingUsd / perDay;
  return { reached: false, days, date: now + days * 86400e3 };
}
/**
 * WHAT IT TAKES: from realized trades [{sol, cost, t}], the return per SOL traded and trades per day; then the
 * days to the goal at several trade sizes, and the trade size each target date needs. Assumes the average holds
 * and a bigger buy fills like a small one (it does not always: bigger buys move the price more).
 */
export function pathToGoal(entries = [], { remainingUsd, solUsd, now = Date.now(), sizes = [0.01, 0.05, 0.1, 0.25, 0.5, 1], targets = [90, 180, 365] } = {}) {
  const list = entries.filter((e) => fin(e?.sol) && e.cost > 0 && fin(e.t));
  if (!list.length || !(solUsd > 0)) return null;
  const cost = list.reduce((a, e) => a + e.cost, 0), pnl = list.reduce((a, e) => a + e.sol, 0), first = Math.min(...list.map((e) => e.t));
  const activeDays = Math.max(1, (now - first) / 86400e3), perDay = list.length / activeDays, roi = pnl / cost;
  const usdPerDay = (size) => roi * size * perDay * solUsd;
  return {
    trades: list.length, roi, tradesPerDay: perDay, avgSize: cost / list.length, activeDays,
    sizes: sizes.map((size) => ({ size, perDay: usdPerDay(size), days: roi > 0 && remainingUsd > 0 ? remainingUsd / usdPerDay(size) : null })),
    targets: targets.map((days) => ({ days, size: roi > 0 && remainingUsd > 0 ? remainingUsd / (days * roi * perDay * solUsd) : null })),
  };
}

// ===== FORMATTING (one style everywhere) =====
export const money = (x, { sign = false, cents = null } = {}) => {
  if (!fin(x)) return '—';
  const a = Math.abs(x), c = cents ?? a < 10000, s = a.toLocaleString('en-US', { minimumFractionDigits: c ? 2 : 0, maximumFractionDigits: c ? 2 : 0 });
  return `${x < 0 ? '−' : sign && x > 0 ? '+' : ''}$${s}`;
};
export const compactMoney = (x) => (!fin(x) ? '—' : Math.abs(x) >= 1e6 ? `${x < 0 ? '−' : ''}$${(Math.abs(x) / 1e6).toFixed(1)}M` : Math.abs(x) >= 1e3 ? `${x < 0 ? '−' : ''}$${(Math.abs(x) / 1e3).toFixed(Math.abs(x) >= 1e4 || Math.abs(x) % 1000 === 0 ? 0 : 1)}K` : money(x, { cents: false }));
/** A day's amount short enough for a calendar cell on a phone: +$8.6, +$12, −76¢, +$1.2K. */
export const cellMoney = (x) => { if (!fin(x)) return '—'; const a = Math.abs(x), s = x < 0 ? '−' : '+'; return a >= 1000 ? s + compactMoney(a) : a >= 10 ? `${s}$${Math.round(a)}` : a >= 1 ? `${s}$${a.toFixed(1)}` : `${s}${Math.round(a * 100)}¢`; };
/** 'YYYY-MM-DD' as "Thu, Oct 15". */
export const dayName = (key) => (key ? new Date(key + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—');
/** How the bot closed a position, in words. */
export const ruleName = (r) => ({ 'his sell / other': 'sold at his sell', 'gain-target': 'sold at the gain gate', stoploss: 'stop-loss', 'hold-until-his-sell': 'held for his sell', 'hold-limit': 'time limit', 'sell-all': 'sell everything', 'no-price': 'no price (safety sell)', 'manual-sell': 'you pressed Sell', 'retry-sell': 'sell retried' }[r] || r || '');
export const pct = (x, d = 1, sign = true) => (!fin(x) ? '—' : `${x < 0 ? '−' : sign && x > 0 ? '+' : ''}${Math.abs(x * 100).toFixed(d)}%`);
export const sol = (x, d = 4, sign = true) => (!fin(x) ? '—' : `${x < 0 ? '−' : sign && x > 0 ? '+' : ''}${Math.abs(x).toFixed(d)} SOL`);
export const shortMint = (m) => (m && m.length > 12 ? `${m.slice(0, 4)}…${m.slice(-4)}` : m || '—');
export const coinName = (x) => (x?.sym ? `$${x.sym}` : shortMint(x?.mint));
export function ago(ms, now = Date.now()) {
  if (!fin(ms)) return '—';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}
export const duration = (days) => (!fin(days) ? '—' : days < 1 ? `${Math.max(1, Math.round(days * 24))} h` : days < 60 ? `${Math.round(days)} days` : days < 365 ? `${Math.round(days / 30.4)} months` : `${(days / 365).toFixed(1)} years`);

/** The rows in view as CSV (the trade list's download). */
export function rowsCsv(rows, { buySol = 0.1, solUsd = null, tz = 'UTC' } = {}) {
  const head = ['day', 'time', 'coin', 'mint', 'bought', 'skip_reason', 'fcat_pct', 'fcat_sol', 'fcat_usd', 'realized_sol', 'entry_premium_pct', 'delay_s', 'blocks_after', 'mcap_usd', 'decu_buy_usd', 'crowd_ahead', 'holders', 'holder_rule', 'first_buy', 'exit', 'peak_pct', 'worst_pct', 'pcat_pct'];
  const q = (v) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const p = (v) => (fin(v) ? (v * 100).toFixed(2) : '');
  const lines = rows.map((x) => { const s = profitSol(x, x.fcat, buySol), u = usdOf(s, x, solUsd), z = zoneParts(x.time, tz);
    return [dayKey(x.time, tz), `${String(z.h).padStart(2, '0')}:${String(z.mi).padStart(2, '0')}:${String(z.s).padStart(2, '0')}`, x.sym || '', x.mint, x.bought ? 'yes' : 'no', x.skip || '', p(x.fcat), fin(s) ? s.toFixed(6) : '', fin(u) ? u.toFixed(2) : '', x.real?.sol ?? '', p(x.prem), x.delay ?? '', x.blocks ?? '', x.mcap ?? '', x.hisUsd ?? '', x.crowd ?? '', x.holders ?? '', x.safe == null ? '' : x.safe ? 'SAFE' : 'RISKY', x.first ? 'yes' : 'no', x.exit || '', p(x.peak), p(x.worst), p(x.pcat)].map(q).join(','); });
  return [head.join(','), ...lines].join('\n') + '\n';
}
