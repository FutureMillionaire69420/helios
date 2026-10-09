import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createStudy, summarize, summaryText} from './study.mjs';

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
  assert.match(a.title, /\$TEST BTSAB 7s \+30\.0% \| 5CAT \+15\.0%/);
  for (const w of ['3CAT +8.0%', '5CAT +15.0%', '10CAT +10.0%', 'PCAT', 'entry +25.0% vs his price', 'Every second:', 'Best fixed sell', 'Best take-profit']) assert.ok(a.body.includes(w), w);
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1, 'journaled');
});

test('his sell inside the window is the PCAT exit', async (t) => {
  const s = createStudy({file: tmp(t), quoteSell: async () => 0.1, buySol: 0.1, feeSol: 0, slip: 0, stepMs: 5});
  const p = s.start({mint: 'M', cost: 0.1, raw: '1000', his: {sol: 1, raw: 20000, time: Date.now() / 1000}});
  s.leaderSell('M', {time: Date.now() / 1000 + 4, sol: 1.5, soldRaw: 20000});
  const rec = await p;
  assert.ok(Math.abs(rec.pcat - 0.5) < 1e-9); assert.match(rec.pcatExit, /his sell at/);
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
  const sm = summarize([{curve: up, peak: 0.25, btsab: 3}, {curve: up, peak: 0.25, btsab: 3}, {curve: down, peak: 0, btsab: 0}], {buySol: 0.1});
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
