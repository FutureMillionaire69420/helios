import test from 'node:test';
import assert from 'node:assert/strict';
import { dipSim, walkForward, runTests, flipSkips, streakSkips, hourOf, marketCapGroups, speedReport, findingsMarkdown, mcapAtHisBuy, pricePath, hisExit } from './tests.mjs';
import { exitSim } from './learn.mjs';

const t0 = Date.parse('2026-10-01T00:00:00Z');
// a studied trade: his price 1e-7, the bot paid +10%, the price path px (per second), he sold at `sold` s
const rec = (i, o = {}) => ({ time: new Date(t0 + i * 600e3).toISOString(), mint: `m${i}`, fcat: 0.05, taken: true, delaySec: 1, hisPrice: 1e-7, entryPrice: 1.1e-7,
  buyFeeSol: 0.003, sellFeeSol: 0.003, px: [1.1e-7, 1.0e-7, 0.88e-7, 0.95e-7, 1.2e-7, 1.3e-7], hisSoldAtSec: 5, exitPrice: 1.3e-7, curve: [0, -0.05, 0.1, 0.2, 0.05, -0.02], ...o });

test('buy the dip: buys only when the price falls below Decu\'s price in time, sells at his sell', () => {
  const s = dipSim(rec(1), { dipPct: 10, giveUpSec: 60, buySol: 0.1, poolFee: 0 });
  assert.equal(s.bought, true); assert.equal(s.at, 2, 'the first price at or below 0.9e-7');
  assert.ok(Math.abs(s.dipSol - ((1.3 / 0.88 - 1) * 0.1 - 0.006)) < 1e-9);
  assert.ok(Math.abs(s.nowSol - ((1.3 / 1.1 - 1) * 0.1 - 0.006)) < 1e-9);
  assert.ok(s.dipSol > s.nowSol, 'a better entry with the same exit');
  const deep = dipSim(rec(1), { dipPct: 15, buySol: 0.1, poolFee: 0 });
  assert.equal(deep.bought, false); assert.equal(deep.dipSol, 0, 'no dip, no trade, no fees');
  assert.equal(dipSim(rec(1), { dipPct: 10, giveUpSec: 2, poolFee: 0 }).bought, false, 'gave up before the dip (2 s after his buy = 1 s after the bot\'s start)');
  assert.equal(dipSim(rec(1, { hisSoldAtSec: 1 }), { dipPct: 10, poolFee: 0 }).bought, false, 'never buys after he sold');
  // the tail: prices after the 15 s study and his late sell
  const late = rec(2, { hisSoldAtSec: null, exitPrice: null, px: [1.1e-7, 1.05e-7, 1.0e-7], tail: { px: [[20, 0.85e-7], [24, 1.2e-7]], hisSell: { atSec: 30, price: 1.4e-7 } } });
  assert.deepEqual(pricePath(late).map((p) => p[0]), [0, 1, 2, 20, 24]);
  assert.deepEqual(hisExit(late), { at: 30, price: 1.4e-7, his: true });
  assert.equal(dipSim(late, { dipPct: 10, giveUpSec: 30, poolFee: 0 }).at, 20);
  assert.equal(dipSim({ ...rec(3), hisPrice: null }), null);
});

test('break-even stop: once up +10%, a fall to break-even sells instead of riding to the loss', () => {
  const r = rec(1, { curve: [0, 0.12, 0.05, -0.01, -0.15, -0.3], hisSoldAtSec: null });
  const be = exitSim(r, { breakeven: 0.1 }, { stopLossPct: 20, gainGatePct: 15, gateSec: 15, lagSec: 0 });
  assert.equal(be.how, 'break-even stop'); assert.equal(be.pnl, -0.01);
  const base = exitSim(r, {}, { stopLossPct: 20, gainGatePct: 15, gateSec: 15, lagSec: 0 });
  assert.equal(base.how, 'stop');
  assert.equal(exitSim(rec(2, { curve: [0, 0.05, -0.02, 0.3], hisSoldAtSec: null }), { breakeven: 0.1 }, { lagSec: 0 }).how === 'break-even stop', false, 'never armed below +10%');
});

test('walk-forward: SUPPORTED needs enough trades and a gain on older AND newer trades', () => {
  const list = Array.from({ length: 60 }, (_, i) => rec(i, { fcat: i % 3 === 0 ? -0.2 : 0.05, copiedLaterBuy: i % 3 === 0 }));
  const wf = walkForward(list, [{ key: 'x', label: 'skip later buys', gain: (l) => ({ sol: -l.filter((r) => r.copiedLaterBuy).reduce((a, r) => a + r.fcat * 0.1, 0), n: l.length }) }]);
  assert.equal(wf.supported, true); assert.equal(wf.train, 42); assert.equal(wf.test, 18);
  assert.match(walkForward(list.slice(0, 20), [{ key: 'x', label: 'x', gain: () => ({ sol: 1, n: 1 }) }]).verdict, /not enough trades yet \(20\/50\)/);
  assert.match(walkForward(list, [{ key: 'x', label: 'x', gain: (l) => ({ sol: -l.length, n: 1 }) }]).verdict, /no version beats/);
});

test('the pack: first buy only, market cap ceiling and the quick-flip guard (scored only)', () => {
  const list = Array.from({ length: 60 }, (_, i) => rec(i, { fcat: i % 4 === 0 ? -0.3 : 0.05, hisMcapUsd: i % 4 === 0 ? 150e3 : 8e3, copiedLaterBuy: false, hisSoldAtSec: i % 10 === 0 ? 2 : 6 }));
  const tests = runTests(list, { buySol: 0.1 });
  assert.deepEqual(tests.map((t) => t.id), ['buy-the-dip', 'break-even', 'first-buy', 'mcap-cap', 'quick-flip', 'loss-streak', 'decu-size', 'hour']);
  const mc = tests.find((t) => t.id === 'mcap-cap');
  assert.equal(mc.supported, true); assert.match(mc.best.label, /skip above \$/);
  assert.deepEqual(mc.groups.map((g) => g.label), ['under $10k', '$100k+']);
  assert.equal(tests.find((t) => t.id === 'quick-flip').sideOnly, true);
  // flip guard: a 2 s flip (sold 1 s after the bot's start + 1 s delay) pauses the next buys for 60 min
  const sk = flipSkips([rec(0, { hisSoldAtSec: 2 }), rec(1, { hisSoldAtSec: null }), rec(2, { hisSoldAtSec: 30 }), rec(7, { hisSoldAtSec: null })], { withinSec: 10, pauseMin: 60 });
  assert.deepEqual([...sk].map((r) => r.mint), ['m1', 'm2'], '10 and 20 min later are skipped; 70 min later is not');
  assert.equal(mcapAtHisBuy({ coin: { marketCapUsd: 5e3 } }), 5e3, 'older trades: the coin\'s market cap');
});

test('market cap groups and the speed report (place in line, what a faster feed is worth)', () => {
  const g = marketCapGroups([rec(1, { hisMcapUsd: 5e3, fcat: 0.2 }), rec(2, { hisMcapUsd: 15e3, fcat: -0.1 }), rec(3, { hisMcapUsd: 200e3, fcat: 0.1, taken: false, skipReason: 'x' })]);
  assert.deepEqual(g.map((x) => [x.label, x.n, x.bought]), [['under $10k', 1, 1], ['$10k–20k', 1, 1], ['$100k+', 1, 0]]);
  const rs = Array.from({ length: 10 }, (_, i) => rec(i, { crowd: { trades: i, seconds: 2 }, entryGap: 0.02 * i }));
  const sp = speedReport(rs, { buySol: 0.1, fasterMs: 100, tradesPerDay: 10 });
  assert.ok(Math.abs(sp.premiumPerTradeAhead - 0.02) < 1e-9, 'each trade ahead adds 2% premium');
  assert.ok(Math.abs(sp.faster.premiumSaved - 0.02 * sp.tradesPerSecAfterDecu * 0.1) < 1e-12);
  assert.deepEqual(sp.groups.map((x) => x.label), ['0', '1–2', '3–4', '5+']);
  const md = findingsMarkdown({ tests: runTests(rs), speed: sp, mode: 'paper', updated: '2026-10-24T00:00:00Z', solUsd: 200 });
  assert.match(md, /^---\ntype: findings\nmode: paper/); assert.match(md, /## Buy the dip/); assert.match(md, /\| trades ahead of you \|/); assert.match(md, /vs \$499 for LaserStream/);
});

test('study: the price tail and the crowd count are saved with the trade and come back after a restart', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { createStudy } = await import('./study.mjs');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tail-')), 'study.jsonl');
  let q = 0; const quoteSell = async () => 0.1 * (1 - 0.01 * q++);
  const s = createStudy({ file, quoteSell, buySol: 0.1, feeSol: 0, slip: 0, stepMs: 5, windowSec: 2, tailSec: 3, tailStepMs: 20, coinCharts: false });
  const p = s.start({ mint: 'M1', cost: 0.1, raw: '1000000', entryPrice: 1e-7, his: { sol: 1, raw: 10_000_000, usd: 200, time: Date.now() / 1000, vSol: 32e9, vTok: 1e15 } });
  s.note('M1', { crowd: { trades: 4, place: 5, seconds: 1.5 } });
  const r = await p;
  assert.equal(r.crowd.trades, 4); assert.ok(r.px.length >= 2 && r.px[0] > 0);
  assert.equal(r.hisMcapUsd, Math.round((32e9 / 1e15) * 1e6 * 200), 'his market cap from his own trade');
  assert.ok(s.tails.has('M1'), 'still reading the price after the study');
  s.leaderSell('M1', { time: Date.now() / 1000, sol: 0.5, soldRaw: 5_000_000 });
  await new Promise((res) => setTimeout(res, 80));
  assert.ok(!s.tails.has('M1'), 'his sell ends the tail');
  const again = createStudy({ file, quoteSell, buySol: 0.1 });
  const back = again.records.find((x) => x.mint === 'M1');
  assert.equal(back.crowd.place, 5); assert.ok(Math.abs(back.tail.hisSell.price - 1e-7) < 1e-15);
  assert.equal(again.records.length, 1, 'the tail line merges into its trade, not a new record');
});

test('the speed report ignores a few absurd fills: medians per place in line, premiums beyond ±300% left out', () => {
  // 40 normal trades: +2% premium per trade ahead; 3 broken fills at +1,700% to +5,000% with 5+ ahead
  const ok = Array.from({ length: 40 }, (_, i) => rec(i, { crowd: { trades: i % 8, seconds: 2 }, entryGap: 0.02 * (i % 8), fcat: 0.01 }));
  const bad = [17, 30, 50].map((g, j) => rec(40 + j, { crowd: { trades: 6, seconds: 2 }, entryGap: g, fcat: -0.5 }));
  const sp = speedReport([...ok, ...bad], { buySol: 0.1, fasterMs: 100, tradesPerDay: 10 });
  assert.equal(sp.leftOut, 3); assert.equal(sp.trades, 40);
  assert.ok(Math.abs(sp.premiumPerTradeAhead - 0.02) < 1e-9, `slope ${sp.premiumPerTradeAhead}`);
  assert.ok(sp.groups.find((g) => g.label === '5+').medianPremium < 0.2, 'no +1,700% group');
  // a wild fill that is NOT beyond the cutoff still cannot move the medians
  const one = speedReport([...ok, rec(99, { crowd: { trades: 6, seconds: 2 }, entryGap: 2.9 })], { buySol: 0.1, tradesPerDay: 10 });
  assert.ok(Math.abs(one.premiumPerTradeAhead - 0.02) < 0.005, `slope ${one.premiumPerTradeAhead}`);
  const md = findingsMarkdown({ tests: [], speed: sp, mode: 'paper', updated: '2026-11-08T00:00:00Z', solUsd: 200 });
  assert.match(md, /\| trades ahead of you \| trades \| median entry premium \|/);
  assert.match(md, /3 trades left out: an entry premium beyond ±300% is bad price data/);
  assert.match(md, /A rough estimate/);
});

test('SUPPORTED shows the real totals: "loses less, still −X SOL" when the better version still loses', () => {
  // 60 losing trades; skipping the later buys (the worst ones) is better, but the total is still a loss
  const rs = Array.from({ length: 60 }, (_, i) => rec(i, { fcat: i % 3 === 0 ? -0.3 : -0.05, copiedLaterBuy: i % 3 === 0 }));
  const fb = runTests(rs, { minTrades: 50 }).find((t) => t.id === 'first-buy');
  assert.equal(fb.supported, true);
  assert.ok(Math.abs(fb.nowSol - (20 * -0.03 + 40 * -0.005)) < 1e-9, `now ${fb.nowSol}`);
  assert.ok(Math.abs(fb.withSol - 40 * -0.005) < 1e-9, `with ${fb.withSol}`);
  const md = findingsMarkdown({ tests: [fb], speed: { groups: [] }, updated: '2026-11-08T00:00:00Z' });
  assert.match(md, /## First buy only · SUPPORTED: loses less, still -0\.2000 SOL in total/);
  assert.match(md, /In SOL on these 60 trades: the bot now -0\.8000 SOL → with \*\*copy only his first buy of a coin\*\* -0\.2000 SOL \(still a loss\)/);
  assert.match(md, /first-buy: SUPPORTED\n/, 'the front matter stays one word for Obsidian queries');
});

test('dip with the first uptick: after the dip, buys at the first price above the one before it', () => {
  // px: 1.1, 1.0, 0.88 (the dip), 0.95 (the uptick), 1.2, 1.3; he sold at 5 s
  const up = dipSim(rec(1), { dipPct: 10, giveUpSec: 60, buySol: 0.1, poolFee: 0, uptick: true });
  assert.equal(up.bought, true); assert.equal(up.at, 3); assert.equal(up.dipEntry, 0.95e-7);
  assert.ok(Math.abs(up.dipSol - ((1.3 / 0.95 - 1) * 0.1 - 0.006)) < 1e-9);
  const falling = rec(2, { px: [1.1e-7, 0.85e-7, 0.8e-7, 0.7e-7, 0.6e-7, 0.5e-7], exitPrice: 0.5e-7 });
  assert.equal(dipSim(falling, { dipPct: 10, poolFee: 0 }).bought, true, 'the plain dip catches the falling knife');
  assert.equal(dipSim(falling, { dipPct: 10, poolFee: 0, uptick: true }).bought, false, 'the uptick version never buys a coin that only falls');
  assert.equal(dipSim(rec(1), { dipPct: 10, giveUpSec: 3, poolFee: 0, uptick: true }).bought, false, 'the uptick (3 s + 1 s delay) came after the deadline');
  const tests = runTests(Array.from({ length: 10 }, (_, i) => rec(i)));
  assert.ok(tests[0].variants.some((v) => v.key === '10/60/up' && /then the first uptick/.test(v.label)));
});

test('loss-streak pause: after N losses in a row, skips his buys for a while; skipped trades never count', () => {
  const rs = [-0.1, -0.2, -0.05, 0.3, 0.2, -0.1, 0.1].map((f, i) => rec(i, { fcat: f })); // 10 min apart
  const s3 = streakSkips(rs, { losses: 3, pauseMin: 25 });
  assert.deepEqual([...s3].map((r) => r.mint), ['m3', 'm4'], 'paused 25 min after the 3rd loss in a row (the next two trades)');
  assert.equal(streakSkips(rs, { losses: 5, pauseMin: 60 }).size, 0, 'never 5 in a row');
  const tie = [-0.1, 0, -0.1, -0.1].map((f, i) => rec(i, { fcat: f }));
  assert.deepEqual([...streakSkips(tie, { losses: 2, pauseMin: 5 })], [], 'a 5-min pause is over before the next trade 10 min later');
  assert.equal(streakSkips(tie, { losses: 2, pauseMin: 15 }).size, 1, 'flat (0) counts as a loss; after a pause the count starts again');
  const list = Array.from({ length: 60 }, (_, i) => rec(i, { fcat: i % 12 < 5 ? -0.2 : i % 12 === 5 ? -0.3 : 0.05 }));
  const t = runTests(list, { buySol: 0.1 }).find((x) => x.id === 'loss-streak');
  assert.equal(t.sideOnly, true); assert.equal(t.variants.length, 3); assert.ok(t.best.sol > 0, 'skipping the losing runs would have helped here');
});

test("Decu's buy size and hour of day: skip groups, with a table of each group", () => {
  const list = Array.from({ length: 60 }, (_, i) => rec(i, { hisSol: i % 5 === 0 ? 5 : 1.2, fcat: i % 5 === 0 ? -0.25 : 0.04 }));
  const tests = runTests(list, { buySol: 0.1 });
  const sz = tests.find((t) => t.id === 'decu-size');
  assert.equal(sz.supported, true); assert.match(sz.best.label, /skip his buys of (2\.5|3|4) SOL or more/);
  assert.deepEqual(sz.groups.map((g) => [g.label, g.n]), [['1–2.5 SOL', 48], ['4 SOL or more', 12]]);
  const hr = tests.find((t) => t.id === 'hour');
  assert.equal(hr.variants.length, 6); assert.deepEqual(hr.groups.map((g) => g.label), ['00–04 UTC', '04–08 UTC', '08–12 UTC']);
  assert.equal(hourOf(rec(0)), 0); assert.equal(hourOf(rec(25)), 4);
  assert.equal(runTests([rec(1, { hisSol: null })]).find((t) => t.id === 'decu-size').trades, 0, 'no SOL size: left out');
  const md = findingsMarkdown({ tests, speed: { groups: [] }, updated: '2026-11-14T00:00:00Z' });
  assert.match(md, /## Loss-streak pause \(side test only\)/); assert.match(md, /## Decu's buy size/); assert.match(md, /\| 4 SOL or more \| 12 \|/);
});
