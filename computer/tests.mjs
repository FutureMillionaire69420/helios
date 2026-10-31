// THE PAPER-TEST PACK: other ways to trade Decu's coins, replayed on the bot's own recorded trades, side by
// side with what the bot really does. Nothing here ever skips or changes a trade: every test is scored on the
// same recorded trades, and the brain only SUGGESTS one (a "Brain suggests" alert) when it wins on newer
// trades the choice never saw (walk-forward: chosen on the oldest 70%, proven on the newest 30%).
//
//   buy-the-dip       wait for the price to fall 5 / 10 / 15% below Decu's price before buying, give up after
//                     30 or 60 s (or at his sell); vs buying now. Both sell when Decu sells.
//   break-even stop   once a trade is up +10% / +20%, the stop moves to break-even on your money; vs your rules.
//   first buy only    copy only his first buy of a coin, never his later buys of it.
//   market cap cap    skip coins whose market cap at his buy is above $X.
//   quick-flip guard  after Decu sells within 10 s of buying, skip his next buys for a while (scored only).
//   crowd / speed     how many other trades landed between Decu's buy and yours (your place in line), what each
//                     one cost you, and what a faster feed (e.g. Helius LaserStream) would be worth.
// Everything is plain data, so the second brain (Obsidian notes) can be written from it as is.

import { exitSim } from './learn.mjs';

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const pct = (x, d = 1) => (!fin(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const sol = (x) => (!fin(x) ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(4)} SOL`);
const byTime = (rs) => [...rs].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
const isBought = (r) => r.taken !== false && !r.skipReason;
const mean = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);

/** Decu's market cap (USD) when he bought: from his trade's own curve numbers, else the coin's at the study. */
export const mcapAtHisBuy = (r) => (fin(r.hisMcapUsd) ? r.hisMcapUsd : fin(r.coin?.marketCapUsd) ? r.coin.marketCapUsd : null);

// ---------- the price path (for the dip) ----------
/** Every recorded price after the bot started watching: [seconds after the bot's start, price per raw token]. */
export function pricePath(rec) {
  const out = [];
  (rec.px || []).forEach((p, s) => { if (fin(p) && p > 0) out.push([s, p]); });
  for (const [s, p] of rec.tail?.px || []) if (fin(p) && p > 0) out.push([s, p]);
  return out.sort((a, b) => a[0] - b[0]);
}
/** When and at what price Decu sold (first sell), seconds after the bot's start; null if he held past the path. */
export function hisExit(rec) {
  if (rec.hisSoldAtSec != null && fin(rec.exitPrice)) return { at: rec.hisSoldAtSec, price: rec.exitPrice, his: true };
  const t = rec.tail?.hisSell;
  if (t && fin(t.price) && t.price > 0) return { at: t.atSec, price: t.price, his: true };
  return null;
}

/**
 * Buy the dip on one recorded trade: the first price at or below Decu's price × (1 − dip), within giveUpSec of
 * HIS buy and before he sold. Sold at his sell (or the last recorded price, marked). Returns SOL for a buySol
 * trade after network fees (fees only when it traded), next to buying now with the same exit.
 */
export function dipSim(rec, { dipPct = 10, giveUpSec = 60, buySol = 0.1, poolFee = 0.0125 } = {}) {
  const path = pricePath(rec), his = rec.hisPrice, now = rec.entryPrice;
  if (!(his > 0) || !(now > 0) || path.length < 3) return null;
  const delay = Math.max(0, rec.delaySec ?? 0), ex = hisExit(rec), last = path.at(-1);
  const exit = ex || { at: last[0], price: last[1], his: false };
  const keep = (1 - poolFee) ** 2, fees = (rec.buyFeeSol ?? rec.sellFeeSol ?? 0) + (rec.sellFeeSol ?? 0);
  const res = (entry) => (keep * (exit.price / entry) - 1) * buySol - fees;
  const trigger = his * (1 - dipPct / 100);
  const hit = path.find(([s, p]) => s + delay <= giveUpSec && s < exit.at && p <= trigger);
  return { nowSol: res(now), dipSol: hit ? res(hit[1]) : 0, bought: !!hit, at: hit ? hit[0] : null, dipEntry: hit ? hit[1] : null, open: !exit.his };
}

// ---------- walk-forward ----------
/** variants: [{key, label, gain(list) -> {sol, n}}]. Chosen on the oldest 70%, kept only if it also gains on
 *  the newest 30%. SUPPORTED needs minTrades trades with data and a gain on both parts. */
export function walkForward(list, variants, { minTrades = 50, minTrainGain = 0.005 } = {}) {
  const rs = byTime(list), cut = Math.floor(rs.length * 0.7), train = rs.slice(0, cut), test = rs.slice(cut);
  const all = variants.map((v) => ({ key: v.key, label: v.label, ...v.gain(rs), train: v.gain(train).sol, test: v.gain(test).sol }));
  const best = [...all].sort((a, b) => b.train - a.train)[0] || null;
  const verdict = rs.length < minTrades ? `not enough trades yet (${rs.length}/${minTrades})`
    : !best || best.train <= minTrainGain ? 'no version beats what the bot does now on older trades'
      : best.test > 0 ? 'SUPPORTED on newer unseen trades' : 'did not hold on newer unseen trades';
  return { trades: rs.length, train: train.length, test: test.length, variants: all, best, verdict, supported: /SUPPORTED/.test(verdict) };
}

// ---------- the tests ----------
const DIP_VARIANTS = [5, 10, 15].flatMap((d) => [30, 60].map((g) => ({ dipPct: d, giveUpSec: g })));
const MCAP_CAPS = [10e3, 20e3, 30e3, 50e3, 100e3];
const FLIP = [{ withinSec: 10, pauseMin: 60 }, { withinSec: 10, pauseMin: 30 }, { withinSec: 5, pauseMin: 60 }];

/** Quick-flip guard on the trades in order: which ones it would have skipped. */
export function flipSkips(records, { withinSec = 10, pauseMin = 60 } = {}) {
  const skip = new Set(); let until = 0;
  for (const r of byTime(records)) {
    const t = Date.parse(r.time);
    if (t < until) skip.add(r);
    const flipAt = r.hisSoldAtSec != null ? r.hisSoldAtSec + Math.max(0, r.delaySec ?? 0) : null;
    if (flipAt != null && flipAt <= withinSec) until = Math.max(until, t + pauseMin * 60e3);
  }
  return skip;
}

export function runTests(records, { buySol = 0.1, stopLossPct = 20, gainGatePct = 15, gateSec = 15, minTrades = 50, poolFee = 0.0125 } = {}) {
  const studied = records.filter((r) => fin(r.fcat));
  const skipGain = (list, skips) => ({ sol: -list.filter(skips).reduce((a, r) => a + r.fcat * buySol, 0), n: list.length, skipped: list.filter(skips).length });
  const out = [];

  // 1. buy the dip (trades with a recorded price path and Decu's price)
  const dipList = studied.filter((r) => dipSim(r) != null);
  const dip = walkForward(dipList, DIP_VARIANTS.map((v) => ({ key: `${v.dipPct}/${v.giveUpSec}`, label: `${v.dipPct}% dip, give up after ${v.giveUpSec} s`,
    gain: (list) => { let g = 0, n = 0, b = 0; for (const r of list) { const s = dipSim(r, { ...v, buySol, poolFee }); if (!s) continue; g += s.dipSol - s.nowSol; n++; if (s.bought) b++; } return { sol: g, n, bought: b }; } })), { minTrades });
  out.push({ id: 'buy-the-dip', name: 'Buy the dip', what: 'Wait for the price to fall below Decu\'s price before buying (vs buying now; both sell when he sells).', ...dip });

  // 2. break-even stop (trades with a price curve), vs your rules on the same trades
  const xo = { stopLossPct, gainGatePct, gateSec };
  const beList = studied.filter((r) => Array.isArray(r.curve) && exitSim(r, {}, xo));
  const be = walkForward(beList, [0.1, 0.2].map((a) => ({ key: `be${a * 100}`, label: `break-even after +${a * 100}%`,
    gain: (list) => { let g = 0, n = 0; for (const r of list) { const e = exitSim(r, { breakeven: a }, xo), b = exitSim(r, {}, xo); if (!e || !b) continue; g += (e.pnl - b.pnl) * buySol; n++; } return { sol: g, n }; } })), { minTrades });
  out.push({ id: 'break-even', name: 'Break-even stop', what: 'Once a trade is up +10% / +20%, the stop moves to break-even on your money (vs your stop and gate).', ...be });

  // 3. first buy only
  const fb = walkForward(studied, [{ key: 'first', label: 'copy only his first buy of a coin', gain: (list) => skipGain(list, (r) => r.copiedLaterBuy === true) }], { minTrades });
  out.push({ id: 'first-buy', name: 'First buy only', what: 'Never copy Decu\'s later buys of a coin he already bought.', ...fb,
    groups: [['first buys', studied.filter((r) => !r.copiedLaterBuy)], ['later buys', studied.filter((r) => r.copiedLaterBuy)]].map(([label, xs]) => ({ label, n: xs.length, wins: xs.filter((r) => r.fcat > 0).length, avgFcat: mean(xs.map((r) => r.fcat)) })) });

  // 4. market cap ceiling (trades with a market cap)
  const mcList = studied.filter((r) => mcapAtHisBuy(r) != null);
  const mc = walkForward(mcList, MCAP_CAPS.map((cap) => ({ key: `mc${cap}`, label: `skip above $${cap / 1e3}k`, gain: (list) => skipGain(list, (r) => mcapAtHisBuy(r) > cap) })), { minTrades });
  out.push({ id: 'mcap-cap', name: 'Market cap ceiling', what: 'Skip coins whose market cap at Decu\'s buy is above a ceiling.', ...mc, groups: marketCapGroups(studied) });

  // 5. quick-flip guard: scored only, never skips a paper trade
  const fl = walkForward(studied, FLIP.map((f) => ({ key: `flip${f.withinSec}/${f.pauseMin}`, label: `sold within ${f.withinSec} s → skip his buys for ${f.pauseMin} min`,
    gain: (list) => { const s = flipSkips(list, f); return skipGain(list, (r) => s.has(r)); } })), { minTrades });
  out.push({ id: 'quick-flip', name: 'Quick-flip guard (side test only)', what: 'After Decu sells within seconds, pause copying him. Scored on paper; it never skips a trade.', sideOnly: true, ...fl });
  return out;
}

/** Bought and studied trades by Decu's market cap at his buy. */
export const MCAP_GROUPS = [['under $10k', 0, 10e3], ['$10k–20k', 10e3, 20e3], ['$20k–30k', 20e3, 30e3], ['$30k–100k', 30e3, 100e3], ['$100k+', 100e3, Infinity]];
export function marketCapGroups(records) {
  return MCAP_GROUPS.map(([label, lo, hi]) => {
    const xs = records.filter((r) => fin(r.fcat) && mcapAtHisBuy(r) != null && mcapAtHisBuy(r) >= lo && mcapAtHisBuy(r) < hi);
    const bought = xs.filter(isBought);
    return { label, n: xs.length, bought: bought.length, wins: xs.filter((r) => r.fcat > 0).length, avgFcat: mean(xs.map((r) => r.fcat)), boughtAvgFcat: mean(bought.map((r) => r.fcat)) };
  }).filter((g) => g.n);
}

// ---------- crowd and speed ----------
export const CROWD_BUCKETS = [['0', 0, 0], ['1–2', 1, 2], ['3–4', 3, 4], ['5+', 5, Infinity]];
/** Your place in line after Decu, what each trade ahead of you cost, and what a faster feed would be worth. */
export function speedReport(records, { buySol = 0.1, fasterMs = 100, tradesPerDay = null } = {}) {
  const rs = records.filter((r) => fin(r.crowd?.trades) && fin(r.entryGap));
  const groups = CROWD_BUCKETS.map(([label, lo, hi]) => { const xs = rs.filter((r) => r.crowd.trades >= lo && r.crowd.trades <= hi); return { label, n: xs.length, avgPremium: mean(xs.map((r) => r.entryGap)), avgFcat: mean(xs.filter((r) => fin(r.fcat)).map((r) => r.fcat)), wins: xs.filter((r) => r.fcat > 0).length }; }).filter((g) => g.n);
  if (rs.length < 3) return { trades: rs.length, groups, note: 'needs 3+ trades with a crowd count' };
  // least squares: entry premium against the number of trades that landed ahead of you
  const xs = rs.map((r) => r.crowd.trades), ys = rs.map((r) => r.entryGap), mx = mean(xs), my = mean(ys);
  const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), slope = sxx > 0 ? xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / sxx : null;
  // how fast other trades pile in after Decu: trades ahead of you / seconds between his buy and yours
  const rates = rs.filter((r) => r.crowd.seconds > 0).map((r) => r.crowd.trades / r.crowd.seconds);
  const perSec = rates.length ? mean(rates) : null;
  const saved = slope != null && perSec != null ? slope * perSec * (fasterMs / 1000) : null; // premium saved per trade
  const bought = records.filter((r) => isBought(r) && fin(r.fcat));
  const days = bought.length ? Math.max(1, (Date.parse(bought.at(-1).time) - Date.parse(bought[0].time)) / 864e5) : 1;
  const perDay = tradesPerDay ?? bought.length / days;
  return { trades: rs.length, groups, avgPlace: mean(xs) + 1, premiumPerTradeAhead: slope, tradesPerSecAfterDecu: perSec,
    faster: saved == null ? null : { ms: fasterMs, premiumSaved: saved, solPerTrade: saved * buySol, solPerMonth: saved * buySol * perDay * 30, tradesPerDay: perDay } };
}

// ---------- Obsidian-ready findings ----------
const verdictWord = (t) => (t.supported ? 'SUPPORTED' : /not enough/.test(t.verdict) ? 'collecting' : 'not supported');
/** One markdown note with front matter: every test, the market cap groups and the speed report. */
export function findingsMarkdown({ tests, speed, mode = 'paper', updated = new Date().toISOString(), solUsd = null }) {
  const fm = ['---', 'type: findings', `mode: ${mode}`, `updated: ${updated}`, ...tests.map((t) => `${t.id}: ${verdictWord(t)}`), '---'];
  const lines = [...fm, '', '# What the brain has found', '', 'Paper tests replayed on the bot\'s own recorded trades, side by side with what it really does. A test is SUPPORTED only when the version chosen on older trades also wins on newer ones it never saw. Nothing here changes a trade on its own.', ''];
  for (const t of tests) {
    lines.push(`## ${t.name} · ${verdictWord(t)}`, '', t.what, '', `- Trades with data: ${t.trades} (chosen on ${t.train}, checked on ${t.test})`, `- Verdict: ${t.verdict}`);
    if (t.best) lines.push(`- Best on older trades: **${t.best.label}**: ${sol(t.best.train)} on older trades, ${sol(t.best.test)} on newer ones (vs what the bot does now)`);
    lines.push('', '| version | all trades | older | newer |', '|---|---|---|---|', ...t.variants.map((v) => `| ${v.label} | ${sol(v.sol)}${v.bought != null ? ` (${v.bought} bought)` : ''}${v.skipped != null ? ` (${v.skipped} skipped)` : ''} | ${sol(v.train)} | ${sol(v.test)} |`), '');
    if (t.groups) lines.push('| group | trades | won | avg FCAT |', '|---|---|---|---|', ...t.groups.map((g) => `| ${g.label} | ${g.n} | ${g.wins} | ${pct(g.avgFcat)} |`), '');
  }
  lines.push('## Crowd and speed', '');
  if (speed.groups?.length) lines.push('| trades ahead of you | trades | avg entry premium | avg FCAT | won |', '|---|---|---|---|---|', ...speed.groups.map((g) => `| ${g.label} | ${g.n} | ${pct(g.avgPremium)} | ${pct(g.avgFcat)} | ${g.wins} |`), '');
  if (speed.note) lines.push(speed.note, '');
  if (speed.premiumPerTradeAhead != null) lines.push(`- Each trade that lands ahead of you adds about ${pct(speed.premiumPerTradeAhead, 2)} to your entry premium (average place in line: ${speed.avgPlace.toFixed(1)}).`);
  if (speed.tradesPerSecAfterDecu != null) lines.push(`- Other trades land at about ${speed.tradesPerSecAfterDecu.toFixed(2)} per second after Decu's buy.`);
  if (speed.faster) lines.push(`- Being ${speed.faster.ms} ms faster (e.g. Helius LaserStream) would save about ${pct(speed.faster.premiumSaved, 2)} per trade = ${sol(speed.faster.solPerTrade)} a trade, ${sol(speed.faster.solPerMonth)} a month at ${speed.faster.tradesPerDay.toFixed(1)} trades a day${solUsd ? ` (≈ $${(speed.faster.solPerMonth * solUsd).toFixed(2)} a month vs $499 for LaserStream)` : ''}.`);
  return lines.join('\n') + '\n';
}
