import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStudy, summarize, summaryText, memoryBank, memoryInsights, tradeNotes} from './study.mjs';
import {createBrain, curveShape, simulateRules, advise, readiness, exitSim} from './learn.mjs';
import {research, latencyLine, toCsv} from './study.mjs';

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-study-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return path.join(d, 'study.jsonl'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('one coin: priced every step for exactly 15 s, then never again; CAT/BTSAB/PCAT in the alert', async (t) => {
  const file = tmp(t); let calls = 0; const alerts = [];
  // Sell value (SOL) per second for a 0.1 SOL position: rises to 0.13 at 7 s, falls after.
  const path_ = [0.098, 0.101, 0.104, 0.108, 0.112, 0.115, 0.12, 0.13, 0.125, 0.118, 0.11, 0.1, 0.095, 0.09, 0.088, 0.085];
  const quoteSell = async () => path_[Math.min(calls++, 15)];
  const s = createStudy({file, quoteSell, notify: (a) => alerts.push(a), meta: async () => ({symbol: 'TEST', holders: 120, marketCapUsd: 9000, createdTime: Math.floor(Date.now() / 1000) - 300}), buySol: 0.1, feeSol: 0, slip: 0, stepMs: 5});
  const rec = await s.start({mint: 'Mint1111', cost: 0.1, raw: '1000000', his: {sol: 2, raw: 25_000_000, usd: 232, time: Date.now() / 1000 - 1.5}});
  s.leaderSell('Mint1111', {}); // after the window: ignored
  await sleep(50);
  assert.equal(calls, 16, 'seconds 0..15, then stops');
  assert.equal(rec.curve.length, 16);
  assert.equal(rec.btsab, 7); assert.ok(Math.abs(rec.peak - 0.3) < 1e-9);
  assert.ok(Math.abs(rec.curve[3] - 0.08) < 1e-9); assert.ok(Math.abs(rec.curve[5] - 0.15) < 1e-9); assert.ok(Math.abs(rec.curve[10] - 0.1) < 1e-9);
  // His price 2/25e6 = 8e-8 SOL/raw; bot price 1e-7 → entry gap +25%. PCAT exit = 15 s value 0.085/1e6.
  assert.ok(Math.abs(rec.entryGap - 0.25) < 1e-9); assert.ok(Math.abs(rec.pcat - (0.085e-6 / 8e-8 - 1)) < 1e-9);
  assert.equal(rec.coin.holders, 120);
  const a = alerts[0];
  assert.match(a.title, /\$TEST FCAT -12\.0% \| BTSAB 7s \+30\.0%/);
  // He bought 1.5 s before the bot: 15 s after HIS buy = 13.5 s → the bot's 14 s sample.
  assert.ok(Math.abs(rec.fcat + 0.12) < 1e-9); assert.equal(rec.fcatSec, 14); assert.match(rec.fcatExit, /15s after his buy \(14s after the bot's\)/);
  assert.ok(a.body.includes('FCAT -12.0% (-0.0120 SOL) · sold at 15s after his buy'), a.body);
  assert.ok(a.body.includes('Brain:') && a.body.includes('Journey: L1 Rookie · trade 1'), a.body);
  assert.ok(Math.abs(rec.bandSol - 0.2) < 1e-9);
  assert.ok(a.body.includes('BAND 0.200 SOL (10% of his buy): 3CAT +0.0160 | 5CAT +0.0300 | 10CAT +0.0200 | BTSAB +0.0600 SOL'), a.body);
  for (const w of ['3CAT +8.0%', '5CAT +15.0%', '10CAT +10.0%', 'PCAT', 'entry premium +25.0%', 'Every second:', 'Best fixed sell', 'Best take-profit']) assert.ok(a.body.includes(w), w);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, 'journaled');
});

test('his sell inside the window is the PCAT exit', async (t) => {
  const s = createStudy({file: tmp(t), quoteSell: async () => 0.1, buySol: 0.1, feeSol: 0, slip: 0, stepMs: 5});
  const p = s.start({mint: 'M', cost: 0.1, raw: '1000', his: {sol: 1, raw: 20000, time: Date.now() / 1000}});
  s.leaderSell('M', {time: Date.now() / 1000 + 4, sol: 1.5, soldRaw: 20000});
  const rec = await p;
  assert.ok(Math.abs(rec.pcat - 0.5) < 1e-9); assert.match(rec.pcatExit, /his sell at/);
  assert.equal(rec.fcatSec, 4, 'FCAT exits at his sell second'); assert.match(rec.fcatExit, /his sell at 4/);
});

test('slow or failing price API never stretches the 15 s window', async (t) => {
  const s = createStudy({file: tmp(t), quoteSell: () => new Promise(() => {}), stepMs: 5, quoteTimeoutMs: 5});
  const t0 = Date.now(); const rec = await s.start({mint: 'S', cost: 0.1, raw: '1'});
  assert.ok(Date.now() - t0 < 1000); assert.ok(rec.curve.every((v) => v === null)); assert.equal(rec.btsab, null);
  const e = createStudy({file: tmp(t), quoteSell: async () => { throw new Error('HTTP 429'); }, stepMs: 1});
  assert.ok((await e.start({mint: 'E', cost: 0.1, raw: '1'})).curve.every((v) => v === null));
});

test('limits: one study per coin, at most 5 at once, bad inputs ignored', async (t) => {
  const s = createStudy({file: tmp(t), quoteSell: async () => 0.1, stepMs: 20});
  const ps = ['a', 'b', 'c', 'd', 'e'].map((m) => s.start({mint: m, cost: 0.1, raw: '1'}));
  assert.equal(s.start({mint: 'a', cost: 0.1, raw: '1'}), null); assert.equal(s.start({mint: 'f', cost: 0.1, raw: '1'}), null);
  assert.equal(s.start({mint: 'g', cost: 0, raw: '1'}), null);
  await Promise.all(ps); assert.equal(s.active.size, 0);
});

test('the rule finder picks the best sell second, take-profit and TP+stop over all trades', () => {
  const up = [0, 0.05, 0.18, 0.25, 0.1, 0, -0.1, -0.2, -0.3, -0.3, -0.3, -0.3, -0.3, -0.3, -0.3, -0.3];
  const down = [0, -0.05, -0.2, -0.4, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5, -0.5];
  const sm = summarize([{curve: up, peak: 0.25, btsab: 3, bandSol: 0.2}, {curve: up, peak: 0.25, btsab: 3, bandSol: 0.4}, {curve: down, peak: 0, btsab: 0, bandSol: 0.1}], {buySol: 0.1});
  assert.ok(Math.abs(sm.bestSecond.bandPnlSol - (0.18 * 0.2 + 0.18 * 0.4 - 0.2 * 0.1)) < 1e-9, 'BAND sizes each trade by his buy');
  assert.ok(Math.abs(sm.bandSpentSol - 0.7) < 1e-9);
  assert.equal(sm.trades, 3);
  assert.equal(sm.bestSecond.sec, 2); assert.ok(Math.abs(sm.bestSecond.pnlSol - 0.016) < 1e-9);
  assert.equal(sm.bestTpSl.tp, 0.2); assert.equal(sm.bestTpSl.sl, -0.05);
  assert.ok(Math.abs(sm.bestTpSl.pnlSol - (0.025 + 0.025 - 0.005)) < 1e-9);
  assert.match(summaryText(sm), /Best TP\+stop: \+20\.0% \/ -5\.0%/);
  assert.equal(summarize([]).trades, 0);
});

test('memory survives restart: the journal is reloaded', async (t) => {
  const file = tmp(t);
  await createStudy({file, quoteSell: async () => 0.11, stepMs: 1, feeSol: 0, slip: 0}).start({mint: 'R', cost: 0.1, raw: '1'});
  const again = createStudy({file, quoteSell: async () => 0.1});
  assert.equal(again.summary().trades, 1); assert.ok(again.summary().bestSecond.pnlSol > 0);
});

test('each trade gets notes; the memory bank groups trades and finds the best and worst kinds', () => {
  const mk = (hisSol, gap, fcat, i) => ({time: new Date(Date.UTC(2026, 9, 11, 17, i)).toISOString(), hisSol, delaySec: 1.7, entryGap: gap, fcat, curve: [-0.09, -0.12, -0.3, 0.1], btsab: 3, peak: 0.1, hisSoldAtSec: null, coin: {ageSec: 200}});
  const rs = [...Array(6)].map((_, i) => mk(5, 0.3, 0.1, i)).concat([...Array(6)].map((_, i) => mk(2.9, 1.1, -0.2, 10 + i)));
  const bank = memoryBank(rs);
  const big = bank.find((g) => g.dimension === 'Decu buy size' && g.bucket === '4+ SOL'); assert.equal(big.trades, 6); assert.equal(big.wins, 6);
  const ins = memoryInsights(rs); assert.ok(ins.best[0].avgFcat > 0); assert.ok(ins.worst[0].avgFcat < 0);
  const notes = tradeNotes(rs[11], rs, {stopLossPct: 20, gainGatePct: 15, maxPayPct: 60});
  assert.ok(notes.some((n) => /Execution latency 1.7 s, entry premium \+110.0%/.test(n)), notes.join('|'));
  assert.ok(notes.some((n) => /Organic -20% stop would sell at 2s/.test(n)), notes.join('|'));
  assert.ok(notes.some((n) => /60% entry-premium filter would have SKIPPED/.test(n)));
  assert.ok(notes.some((n) => /Memory: Decu buys of 2.5-4 SOL → 0\/6 won/.test(n)));
});

// ===== the brain (learn.mjs) =====
const mkRec = (i, o = {}) => ({time: new Date(Date.UTC(2026, 9, 12, 0, i * 3)).toISOString(), mint: 'M' + i, hisSol: 1.5, delaySec: 1.8, entryGap: 0.6, curve: [-0.09, -0.08, -0.1, -0.12, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1], fcat: -0.1, coin: {ageSec: 300, marketCapUsd: 20000, holders: 80}, ctx: {recent10m: 1}, ...o});

test('shapes and the real exit rules replayed on a path (gate counts from Decu\'s buy)', () => {
  assert.equal(curveShape([0, 0.05, 0.2, 0.1, 0, -0.05, -0.1]), 'quick spike');
  assert.equal(curveShape([0, -0.05, -0.1, -0.2, -0.3]), 'instant dump');
  assert.equal(curveShape([0, 0.01, 0.02, 0.03, 0.05, 0.05, 0.06, 0.07, 0.08, 0.09, 0.2, 0.25]), 'late runner');
  const up = [-0.09, 0, 0.1, 0.2, 0.1, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05, 0.05];
  // Bot landed 2 s after him: the 15 s gate is the bot's 13 s sample; peak +20% ≥ +15% → sells there.
  assert.deepEqual(simulateRules({curve: up, delaySec: 2}, {gainGatePct: 15}), {pnl: 0.05, sec: 13, how: '+15% gate'});
  // His sell at 4.2 s comes first.
  assert.equal(simulateRules({curve: up, delaySec: 2, hisSoldAtSec: 4.2}).how, 'his sell');
  // Organic stop: -20% from the first price (-9%) → (1-0.28)/(1-0.09)-1 = -20.9%.
  const dn = [-0.09, -0.15, -0.28, -0.3];
  assert.deepEqual(simulateRules({curve: dn, delaySec: 2}), {pnl: -0.28, sec: 2, how: '-20% stop'});
  assert.equal(simulateRules({curve: [-0.09, -0.05, -0.1], delaySec: 2}).open, true, 'never +15% → holds for his sell');
});

test('the brain finds a real pattern, confirms it, predicts with it and alerts once', () => {
  const brain = createBrain({reportEvery: 10});
  const recs = [], events = [];
  // Overpaying (entry gap 100%+) loses; good entries (<40%) win. Mixed otherwise.
  for (let i = 0; i < 40; i++) {
    const kind = i % 3;
    const r = mkRec(i, kind === 0 ? {entryGap: 1.3, fcat: -0.25} : kind === 1 ? {entryGap: 0.2, fcat: 0.12} : {entryGap: 0.55, fcat: i % 2 ? 0.03 : -0.04});
    recs.push(r);
    events.push(...brain.observe(r, recs).events);
  }
  const lessons = brain.lessons();
  const over = lessons.find((l) => l.label === 'entry premium 100%+');
  assert.ok(over && over.status === 'confirmed' && over.dev < 0, JSON.stringify(lessons.map((l) => [l.label, l.status])));
  assert.ok(lessons.some((l) => l.label === 'entry premium <40%' && l.dev > 0));
  const pat = events.filter((e) => e.kind === 'pattern');
  assert.ok(pat.length >= 1 && pat.some((e) => /CONFIRMED/.test(e.title)), pat.map((e) => e.title).join('|'));
  assert.ok(pat.some((e) => /A high entry premium hurts/.test(e.body)));
  // Each lesson is announced once per status change, not on every trade.
  assert.ok(pat.length < 15, `${pat.length} pattern alerts`);
  // Predictions: the bot learned that 100%+ entries lose.
  const p = brain.predict(mkRec(99, {entryGap: 1.4}));
  assert.ok(p && !p.win && p.basis.some((b) => b.label === 'entry premium 100%+'));
  assert.ok(brain.accuracy().rate > 0.7, String(brain.accuracy().rate));
  // Reports every 10 trades and level-ups (10 → Learner, 25 → Analyst), never both for one trade.
  assert.deepEqual(events.filter((e) => e.kind === 'report' || e.kind === 'level').map((e) => e.kind), ['level', 'report', 'level', 'report', 'report']);
  const rep = events.find((e) => e.kind === 'report' && /40 trades/.test(e.title));
  assert.ok(/Predictions: \d+\/\d+ right/.test(rep.body) && /Go-live readiness \d\/4/.test(rep.body) && /Advisor/.test(rep.body), rep.body);
});

test('advisor recommends the max-pay guard that the data supports; readiness checklist', () => {
  const recs = [];
  for (let i = 0; i < 30; i++) recs.push(mkRec(i, i % 2 ? {entryGap: 1.2, fcat: -0.2, curve: [-0.09, -0.15, -0.3, -0.35]} : {entryGap: 0.3, fcat: 0.1, curve: [-0.09, 0, 0.1, 0.1], hisSoldAtSec: 3}));
  const a = advise(recs, {buySol: 0.1});
  assert.equal(a.maxPay.pct, 30); assert.equal(a.maxPay.skipped, 15); assert.ok(a.maxPay.gainSol > 0);
  const r = readiness(recs);
  assert.equal(r.of, 4); assert.equal(r.checks[0].ok, false, 'only 30 trades');
});

test('streak alerts say what the losing trades had in common; a restart replays silently', async (t) => {
  const brain = createBrain(), recs = []; let ev = [];
  for (let i = 0; i < 3; i++) { const r = mkRec(i, {fcat: -0.1, entryGap: 1.1}); recs.push(r); ev = ev.concat(brain.observe(r, recs).events); }
  const st = ev.find((e) => e.kind === 'streak');
  assert.match(st.title, /Losing streak: 3 in a row/); assert.match(st.body, /entry premium 100%\+/);
  // Journal replay: a new study built on the same file re-learns without sending anything.
  const file = tmp(t);
  fs.writeFileSync(file, Array.from({length: 25}, (_, i) => JSON.stringify(mkRec(i, i % 2 ? {fcat: 0.1, entryGap: 0.2} : {fcat: -0.2, entryGap: 1.2}))).join('\n') + '\n');
  const alerts = [];
  const s = createStudy({file, quoteSell: async () => 0.1, notify: (a) => alerts.push(a)});
  assert.equal(alerts.length, 0);
  assert.equal(s.learning().journey.name, 'Analyst'); assert.equal(s.learning().journey.trades, 25);
  assert.ok(s.records[3].shape && s.records[3].ruleSim, 'old records are enriched');
});

test('daily digest arrives once a day', () => {
  const brain = createBrain({reportEvery: 0}), recs = []; const ev = [];
  for (let i = 0; i < 6; i++) { const r = mkRec(0, {time: new Date(Date.UTC(2026, 9, 12) + i * 6 * 3600e3).toISOString()}); recs.push(r); ev.push(...brain.observe(r, recs).events); }
  assert.equal(ev.filter((e) => e.kind === 'digest').length, 1);
});

test('a skipped Decu buy is still studied (no trade) and kept out of the bot totals', async (t) => {
  const alerts = [];
  const s = createStudy({file: tmp(t), quoteSell: async () => 0.12, notify: (a) => alerts.push(a), stepMs: 1, feeSol: 0, slip: 0});
  const rec = await s.start({mint: 'Skip1', cost: 0.1, raw: '1000', his: {sol: 2, raw: 25000, time: Date.now() / 1000 - 2}, shadow: 'entry premium 90% above Decu'});
  assert.equal(rec.taken, false); assert.match(rec.skipReason, /entry premium/);
  assert.match(alerts[0].title, /SKIPPED/); assert.match(alerts[0].body, /NOT BOUGHT/);
  const sm = s.summary(); assert.equal(sm.fcat.trades, 0); assert.equal(sm.fcatAll.trades, 1); assert.equal(sm.fcatAll.skipped, 1);
  const R = s.research(); assert.equal(R.taken, 0); assert.equal(R.skipped, 1); assert.equal(Object.values(R.skipReasons)[0], 1);
});

test('exit strategies replay with a 1 s sell delay and only past information', () => {
  const c = [-0.09, 0, 0.1, 0.25, 0.3, 0.12, 0.05, 0, -0.05, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1, -0.1];
  const r = {curve: c, delaySec: 2};
  assert.equal(exitSim(r, {fixed: 3}).pnl, 0.3, 'decided at 3 s, filled at 4 s');
  assert.equal(exitSim(r, {trail: 0.1}).how, 'trailing stop'); assert.equal(exitSim(r, {trail: 0.1}).pnl, 0.05, 'peak 30% -> 12% at 5 s is -14%: fills at 6 s');
  assert.equal(exitSim(r, {}).how, 'gain gate');
  const h = exitSim(r, {half: true}); assert.ok(Math.abs(h.pnl - (0.5 * 0.3 + 0.5 * exitSim(r, {}).pnl)) < 1e-9, 'half at +15% (filled 1 s later), rest by your rules');
});

test('walk-forward advisor: chosen on older trades, judged on newer unseen ones; needs 50+ trades', () => {
  const mk = (i, gap, fcat, curve) => ({time: new Date(Date.UTC(2026, 9, 12, 0, i)).toISOString(), mint: 'W' + i, entryGap: gap, fcat, delaySec: 2, curve});
  const good = [-0.09, 0, 0.1, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2], bad = [-0.09, -0.15, -0.3, -0.35];
  const few = Array.from({length: 20}, (_, i) => (i % 2 ? mk(i, 1.2, -0.3, bad) : mk(i, 0.3, 0.2, good)));
  const a = advise(few, {buySol: 0.1});
  assert.equal(a.split.train, 14); assert.equal(a.split.test, 6);
  assert.ok(a.filterWF.trainGainSol > 0 && a.filterWF.testGainSol > 0); assert.match(a.filterWF.verdict, /not enough evidence/);
  const many = Array.from({length: 60}, (_, i) => (i % 2 ? mk(i, 1.2, -0.3, bad) : mk(i, 0.3, 0.2, good)));
  assert.match(advise(many, {buySol: 0.1}).filterWF.verdict, /SUPPORTED/);
  // a pattern that only worked early is rejected on the unseen part
  const flip = Array.from({length: 60}, (_, i) => (i < 42 ? (i % 2 ? mk(i, 1.2, -0.3, bad) : mk(i, 0.3, 0.2, good)) : (i % 2 ? mk(i, 1.2, 0.2, good) : mk(i, 0.3, -0.3, bad))));
  assert.match(advise(flip, {buySol: 0.1}).filterWF.verdict, /not supported/);
  assert.ok(Array.isArray(advise(many, {buySol: 0.1}).exits) && advise(many, {buySol: 0.1}).exits.length === 7);
});

test('research summary: latency percentiles, drawdown, profit factor; latency line marks simulated time', () => {
  const recs = [0.1, -0.2, 0.05].map((f, i) => ({time: new Date(Date.UTC(2026, 9, 12, 0, i)).toISOString(), mint: 'R' + i, fcat: f, entryGap: 0.5 + i * 0.3, delaySec: 1.5 + i, latency: {botMs: 1100 + i * 100, blocksAfter: 4 + i, simulatedMs: 1000}}));
  const R = research(recs, {buySol: 0.1, filterPct: 60});
  assert.ok(Math.abs(R.maxDrawdownSol + 0.02) < 1e-9); assert.ok(Math.abs(R.profitFactor - 0.75) < 1e-9);
  assert.equal(R.latency.blocksMedian, 5); assert.equal(R.latency.botMedianMs, 1200); assert.equal(R.filter.trades, 1, "premiums 50%, 80%, 110%: only one under 60%");
  assert.match(latencyLine({detectMs: 400, decodeMs: 2, decideMs: 1, buildMs: 150, landMs: 1100, simulatedMs: 1000, botMs: 1260, route: 'paper', blocksAfter: 5, blocksEstimated: true}), /SIMULATED paper wait.*5 blocks after Decu \(≈, paper\)/);
});

test('copied a later Decu buy: premium/latency vs that buy, PCAT vs his first buy', async (t) => {
  const s = createStudy({file: tmp(t), quoteSell: async () => 0.1, stepMs: 1, feeSol: 0, slip: 0});
  const now = Date.now() / 1000;
  const rec = await s.start({mint: 'Later', cost: 0.1, raw: '1000', his: {sol: 1, raw: 12500, time: now - 2, first: {sol: 1, raw: 20000, time: now - 600}}});
  assert.ok(Math.abs(rec.entryGap - 0.25) < 1e-9, 'vs the copied buy (8e-5 per token)');
  assert.ok(Math.abs(rec.pcat - 1) < 1e-9, 'vs his first buy (5e-5 per token)');
  assert.ok(rec.delaySec < 3 && rec.copiedLaterBuy);
});

test('CSV export: one row per studied Decu buy, bought or skipped', () => {
  const recs = [mkRec(1, {symbol: 'A,B', fcat: 0.1234, taken: false, skipReason: 'entry premium 80% above Decu\'s price', ruleSim: {pnl: -0.2, how: 'stop', sec: 4}}), mkRec(2)];
  const lines = toCsv(recs).trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^time_utc,coin,mint,bought,skip_reason/); assert.match(lines[0], /s15_pct$/);
  assert.match(lines[1], /"A,B",M1,no,entry premium 80% above Decu's price,1\.5,/); assert.match(lines[1], /,12\.34,/); assert.match(lines[1], /stop at 4s/);
  assert.match(lines[2], /,yes,,/);
});
