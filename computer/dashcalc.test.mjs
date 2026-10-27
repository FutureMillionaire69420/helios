import test from 'node:test';
import assert from 'node:assert/strict';
import { tradeRows, profitSol, usdOf, dayKey, startOfDay, rangeFrom, matches, FILTER_DEFAULTS, extraFilterCount, totals, runningTotal, exitWith, whatIf, bestValue, monthGrid, dayStats, byWeekdayHour, pace, eta, pathToGoal, money, pct, sol, compactMoney, cellMoney, dayName, ruleName, duration, rowsCsv } from './dashcalc.mjs';

const T0 = Date.parse('2026-10-20T15:00:00Z');
// a studied Decu buy as the study journal saves it
const rec = (i, o = {}) => ({ time: new Date(T0 + i * 3600e3).toISOString(), mint: `Mint${i}pump`, symbol: `C${i}`, taken: true, skipReason: null, fcat: 0.1, cost: 0.1, hisUsd: 200, hisSol: 1, entryGap: 0.1, delaySec: 2, latency: { blocksAfter: 3 }, hisMcapUsd: 8000, crowd: { trades: 1 }, coin: { holders: 50, ageSec: 600 }, holderVerdict: { heldUsd: 900, safe: true }, copiedLaterBuy: false, fcatExit: 'his sell at 6s', fcatSec: 6, peak: 0.3, worst: -0.05, btsab: 4, pcat: 0.2, curve: [0, 0.05, 0.1, 0.2, 0.3, 0.25, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1], ctx: { recent10m: 1 }, ...o });
const rows = (list, opts) => tradeRows(list, opts);

test('trade rows: the fields the dashboard needs, realized result joined by coin and time', () => {
  const closed = [{ mint: 'Mint0pump', boughtAt: T0 + 2000, closedAt: T0 + 9000, pnlSol: 0.012, pnlPct: 0.12, rule: 'his sell / other' }, { mint: 'Mint1pump', boughtAt: T0 + 3600e3 + 20 * 60e3, pnlSol: 5 }];
  const [a, b, c] = rows([rec(0), rec(1), rec(2, { taken: false, skipReason: 'entry premium 40% above Decu', copiedLaterBuy: true, crowd: null })], { closed });
  assert.equal(a.time, T0); assert.equal(a.sym, 'C0'); assert.equal(a.bought, true); assert.equal(a.solUsd, 200); assert.equal(a.crowd, 1); assert.equal(a.mcap, 8000); assert.equal(a.safe, true); assert.equal(a.ageMin, 10); assert.equal(a.first, true);
  assert.deepEqual(a.real, { sol: 0.012, pct: 0.12, rule: 'his sell / other', closedAt: T0 + 9000 });
  assert.equal(b.real, null, 'a close 20 min away is a different position');
  assert.equal(c.bought, false); assert.equal(c.skip, 'entry premium 40% above Decu'); assert.equal(c.real, null); assert.equal(c.first, false); assert.equal(c.crowd, null);
  assert.equal(rows([{ mint: 'x' }, { time: 'nope', mint: 'y' }]).length, 0, 'rows without a time are dropped');
});

test('profit: FCAT x what the trade cost, in $ at that trade\'s SOL price', () => {
  const [x] = rows([rec(0, { fcat: 0.25, cost: 0.2 })]);
  assert.equal(profitSol(x), 0.05); assert.equal(usdOf(0.05, x), 10);
  assert.equal(usdOf(0.05, { solUsd: null }, 150), 7.5, 'no price on the trade: the price now');
  assert.equal(usdOf(0.05, {}, null), null);
  assert.equal(profitSol({ fcat: 0.1 }, 0.1, 0.5), 0.05, 'no cost saved: the configured size');
});

test('time: days and "today" in the bot timezone, not UTC', () => {
  const late = Date.parse('2026-10-28T02:30:00Z'); // 22:30 on the 27th in New York
  assert.equal(dayKey(late, 'America/New_York'), '2026-10-27');
  assert.equal(dayKey(late, 'UTC'), '2026-10-28');
  assert.equal(startOfDay(late, 'America/New_York'), Date.parse('2026-10-27T04:00:00Z'));
  assert.equal(rangeFrom('7d', late, 'UTC'), late - 7 * 86400e3); assert.equal(rangeFrom('all', late, 'UTC'), null);
});

test('filters: date, status, result, search, ranges (a missing number is left out), holder rule, exit', () => {
  const list = rows([rec(0), rec(1, { fcat: -0.2, symbol: 'DOGE', fcatExit: '15s limit' }), rec(2, { taken: false, skipReason: 'max open positions', hisMcapUsd: null, coin: null }), rec(30, { holderVerdict: { heldUsd: 10, safe: false } })]);
  const f = (o) => list.filter((x) => matches(x, { ...FILTER_DEFAULTS, ...o }, { tz: 'UTC', now: T0 + 31 * 3600e3 })).map((x) => x.sym);
  assert.deepEqual(f({ range: 'all' }), ['C0', 'DOGE', 'C2', 'C30']);
  assert.deepEqual(f({ range: 'today' }), ['C30'], 'today = since midnight in the timezone');
  assert.deepEqual(f({ range: 'all', day: '2026-10-20' }), ['C0', 'DOGE', 'C2']);
  assert.deepEqual(f({ range: 'all', status: 'skipped' }), ['C2']);
  assert.deepEqual(f({ range: 'all', result: 'lost' }), ['DOGE']);
  assert.deepEqual(f({ range: 'all', q: '$dog' }), ['DOGE']);
  assert.deepEqual(f({ range: 'all', q: 'mint3' }), ['C30'], 'search also matches the start of the mint');
  assert.deepEqual(f({ range: 'all', mcapMax: 9000 }), ['C0', 'DOGE', 'C30'], 'unknown market cap is left out once a range is set');
  assert.deepEqual(f({ range: 'all', holder: 'risky' }), ['C30']);
  assert.deepEqual(f({ range: 'all', exit: 'limit' }), ['DOGE']);
  assert.equal(extraFilterCount({ ...FILTER_DEFAULTS, mcapMax: 1, holder: 'safe', firstOnly: true }), 3);
});

test('totals: wins, SOL and $, best and worst, realized where the bot closed it', () => {
  const list = rows([rec(0, { fcat: 0.2 }), rec(1, { fcat: -0.1 }), rec(2, { fcat: null }), rec(3, { taken: false, skipReason: 'x', fcat: 0.5 })], { closed: [{ mint: 'Mint0pump', boughtAt: T0, pnlSol: 0.015 }] });
  const t = totals(list);
  assert.equal(t.n, 3); assert.equal(t.wins, 2); assert.equal(t.losses, 1); assert.ok(Math.abs(t.sol - 0.06) < 1e-12); assert.ok(Math.abs(t.usd - 12) < 1e-9);
  assert.equal(t.best.sym, 'C3'); assert.equal(t.worst.sym, 'C1'); assert.equal(t.real, 0.015); assert.equal(t.realN, 1); assert.equal(t.bought, 3); assert.equal(t.skipped, 1);
  assert.deepEqual(runningTotal(list).map((p) => Math.round(p.sol * 1000) / 1000), [0.02, 0.01, 0.06]);
});

test('exit what-ifs read the per-second path and never sell after his sell', () => {
  const [x] = rows([rec(0)]); // path 0, 5, 10, 20, 30, 25, 10 ... his sell at 6 s, FCAT +10%
  assert.equal(exitWith(x, {}), 0.1);
  assert.equal(exitWith(x, { tp: 0.2 }), 0.2, 'take profit at the first second it is reached');
  assert.equal(exitWith(x, { at: 4 }), 0.3);
  assert.equal(exitWith(x, { tp: 0.5 }), 0.1, 'never reached: his sell (FCAT)');
  assert.equal(exitWith(x, { at: 12 }), 0.1, 'after his sell: FCAT');
  const [y] = rows([rec(0, { curve: [0, -0.1, -0.25, -0.4, 0.2], fcatSec: 4, fcat: 0.2 })]);
  assert.equal(exitWith(y, { sl: -0.2 }), -0.25, 'stop at the first second at or below it');
});

test('what-if: same trades side by side, skipped buys can come back, each rule says what it removes', () => {
  const list = rows(Array.from({ length: 40 }, (_, i) => rec(i, { entryGap: i % 4 === 0 ? 0.5 : 0.1, fcat: i % 4 === 0 ? -0.3 : 0.1, taken: i % 10 !== 9, skipReason: i % 10 === 9 ? 'max open positions' : null })));
  const none = whatIf(list, { includeSkipped: false });
  assert.equal(none.verdict.kind, 'same'); assert.equal(none.test.sol, none.actual.sol);
  const r = whatIf(list, { rules: { prem: 0.2 }, includeSkipped: true });
  assert.equal(r.actual.n, 36);
  assert.equal(r.test.n, 30, '10 overpriced buys removed, 4 skipped ones added back');
  assert.equal(r.test.added, 4);
  assert.equal(r.removed.prem.n, 10); assert.ok(Math.abs(r.removed.prem.sol - -0.3) < 1e-9, 'the overpriced buys lost 0.3 SOL');
  assert.ok(r.test.sol > r.actual.sol); assert.equal(r.verdict.kind, 'holds');
  assert.equal(r.series.length, 40); assert.ok(r.actual.dd < 0); assert.equal(r.test.dd, 0, 'nothing but wins left: no drawdown');
  const few = whatIf(list.slice(0, 12), { rules: { prem: 0.2 } });
  assert.equal(few.verdict.kind, 'few');
  // a rule that helped only on the older trades
  const luck = rows(Array.from({ length: 40 }, (_, i) => rec(i, { hisMcapUsd: i % 2 ? 50000 : 5000, fcat: i % 2 ? (i < 28 ? -0.2 : 0.4) : 0.05 })));
  assert.equal(whatIf(luck, { rules: { mcapMax: 10000 } }).verdict.kind, 'luck');
  // hours rule in the timezone
  const h = whatIf(list, { rules: { hourFrom: 0, hourTo: 1 }, tz: 'UTC' });
  assert.ok(h.removed.hours.n > 0 && h.test.n < 40);
});

test('best value: picked on the older trades, with the newer result beside it', () => {
  const list = rows(Array.from({ length: 50 }, (_, i) => rec(i, { entryGap: (i % 5) * 0.1, fcat: i % 5 >= 3 ? -0.2 : 0.1 })));
  const b = bestValue(list, 'prem', { includeSkipped: true });
  assert.ok(b.value >= 0.2 && b.value < 0.3, `cuts the losers above 20%: ${b.value}`);
  assert.ok(b.olderGain > 0 && b.newerGain > 0); assert.equal(b.holds, true);
});

test('calendar: Sunday-first month grid, best/worst day and streaks over trading days', () => {
  const g = monthGrid(2026, 10, { '2026-10-27': { usd: 5, n: 1 } });
  assert.equal(g.length, 5); assert.equal(g[0].slice(0, 4).every((c) => c === null), true, 'Oct 1 2026 is a Thursday');
  assert.equal(g[0][4].d, 1); assert.deepEqual(g[4][2].data, { usd: 5, n: 1 });
  const s = dayStats({ '2026-10-01': { usd: 10, n: 2, wins: 2 }, '2026-10-02': { usd: 4, n: 1 }, '2026-10-05': { usd: -3, n: 1 }, '2026-10-06': { usd: 6, n: 1 }, '2026-10-07': { usd: 1, n: 1 }, '2026-10-08': { usd: 0, n: 0 } });
  assert.equal(s.days, 5); assert.equal(s.green, 4); assert.equal(s.red, 1); assert.equal(s.best.day, '2026-10-01'); assert.equal(s.worst.day, '2026-10-05');
  assert.deepEqual(s.streak, { kind: 'green', n: 2 }); assert.equal(s.longestGreen, 2); assert.equal(s.usd, 18);
  const w = byWeekdayHour([{ t: Date.parse('2026-10-27T13:00:00Z'), usd: 2, sol: 0.01 }], 'America/New_York');
  assert.equal(w.weekday[2].n, 1, 'a Tuesday'); assert.equal(w.hour[9].usd, 2, '9 am in New York');
});

test('Rolex pace, arrival date and what it takes', () => {
  const now = Date.parse('2026-10-27T20:00:00Z');
  const days = { '2026-10-25': { usd: 100, n: 3 }, '2026-10-26': { usd: -40, n: 2 }, '2026-10-27': { usd: 80, n: 2 } };
  const p = pace(days, { now, tz: 'UTC', windowDays: 7 });
  assert.equal(p.days, 3, 'since the first trading day when that is inside the window'); assert.equal(p.perDay, 140 / 3);
  const e = eta(1400, p.perDay, now); assert.ok(Math.abs(e.days - 30) < 1e-9);
  assert.equal(eta(100, -5), null); assert.equal(eta(0, 5).reached, true);
  const t = pathToGoal([{ sol: 0.01, cost: 0.1, t: now - 2 * 86400e3 }, { sol: 0.01, cost: 0.1, t: now - 86400e3 }], { remainingUsd: 20000, solUsd: 100, now });
  assert.ok(Math.abs(t.roi - 0.1) < 1e-12); assert.equal(t.tradesPerDay, 1);
  assert.ok(Math.abs(t.sizes.find((s) => s.size === 1).perDay - 10) < 1e-9, '10% of 1 SOL a day at $100');
  assert.ok(Math.abs(t.targets.find((x) => x.days === 365).size - 20000 / 3650) < 1e-9);
  assert.equal(pathToGoal([{ sol: -0.01, cost: 0.1, t: now }], { remainingUsd: 100, solUsd: 100, now }).sizes[0].days, null, 'losing on average: never');
});

test('formatting and the CSV of the rows in view', () => {
  assert.equal(money(1234.5), '$1,234.50'); assert.equal(money(20000), '$20,000'); assert.equal(money(12.5, { sign: true }), '+$12.50'); assert.equal(money(-3), '−$3.00');
  assert.equal(compactMoney(20000), '$20K'); assert.equal(compactMoney(1000), '$1K'); assert.equal(compactMoney(-2500), '−$2.5K');
  assert.deepEqual([8.62, 12.4, -0.76, -7.48, 1234].map(cellMoney), ['+$8.6', '+$12', '−76¢', '−$7.5', '+$1.2K'], 'calendar cells stay short on a phone');
  assert.equal(dayName('2026-10-15'), 'Thu, Oct 15'); assert.equal(ruleName('gain-target'), 'sold at the gain gate'); assert.equal(ruleName('something-new'), 'something-new'); assert.equal(pct(0.1234), '+12.3%'); assert.equal(sol(-0.01), '−0.0100 SOL'); assert.equal(duration(400), '1.1 years');
  const csv = rowsCsv(rows([rec(0, { symbol: 'A,B' })]), { tz: 'UTC' });
  const [head, line] = csv.trim().split('\n');
  assert.match(head, /^day,time,coin,mint,bought/); assert.match(line, /^2026-10-20,15:00:00,"A,B",Mint0pump,yes,,10\.00,0\.010000,2\.00,/);
});
