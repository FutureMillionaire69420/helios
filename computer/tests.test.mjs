import test from 'node:test';
import assert from 'node:assert/strict';
import { dipSim, walkForward, runTests, flipSkips, marketCapGroups, speedReport, findingsMarkdown, mcapAtHisBuy, pricePath, hisExit } from './tests.mjs';
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
  assert.deepEqual(tests.map((t) => t.id), ['buy-the-dip', 'break-even', 'first-buy', 'mcap-cap', 'quick-flip']);
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
