import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { entryMoments, exitResults, missedFrac, tradeAnalysis, dayCharts, delayAnalysis, analysisCharts, analysisMarkdown, renderPng, specFromUrl, chartUrl } from './notecharts.mjs';
import { createThinkingBrain } from './brain.mjs';
import { createBrain } from './learn.mjs';
import { coinChart } from './study.mjs';

const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(200, 7)]);
const T0 = Date.parse('2026-10-26T14:00:00Z');
const rec = (i, o = {}) => ({ time: new Date(T0 + i * 600e3).toISOString(), mint: `Mint${i}yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyypump`, symbol: `C${i}`, mode: 'paper', fcat: 0.12, fcatSec: 13, fcatExit: '15s mark', btsab: 10, peak: 0.2, worst: -0.03, worstAt: 0,
  pcat: 0.25, entryGap: 0.06, delaySec: 2, latency: { blocksAfter: 5, detectBlocks: 0, botMs: 1200 }, hisSol: 5, hisUsd: 500, cost: 0.103, buyFeeSol: 0.003, sellFeeSol: 0.003,
  hisPrice: 1e-7, entryPrice: 1.06e-7, exitPrice: 1.3e-7, hisSoldAtSec: null, curve: [-0.02, 0.01, 0.05, 0.08, 0.1, 0.12, 0.15, 0.18, 0.19, 0.2, 0.2, 0.17, 0.15, 0.13, 0.12, 0.12],
  px: [1.07e-7, 1.08e-7, 1.1e-7, 1.12e-7, 1.15e-7, 1.18e-7, 1.2e-7, 1.22e-7, 1.24e-7, 1.25e-7, 1.25e-7, 1.24e-7, 1.22e-7, 1.21e-7, 1.2e-7, 1.2e-7], taken: true, crowd: { trades: 2, place: 3, exact: false }, ...o });

test('what the delay cost: Decu\'s price, your entry, then every later second, all with the same exit', () => {
  const m = entryMoments(rec(1), { poolFee: 0 });
  assert.equal(m[0].kind, 'decu'); assert.ok(Math.abs(m[0].usd - (1.3 / 1.0 - 1) * 10) < 1e-9);
  assert.equal(m[1].kind, 'you'); assert.ok(Math.abs(m[1].usd - (1.3 / 1.06 - 1) * 10) < 1e-9);
  assert.ok(m[1].usd < m[0].usd, 'your entry made less than his');
  assert.equal(m[2].label, '+3 s', '1 s after the bot\'s start = 3 s after his buy');
  assert.ok(m.slice(2).every((x) => x.kind === 'later'));
  assert.deepEqual(entryMoments({ ...rec(1), hisPrice: null }), []);
});

test('missed on the delay: the $10 mirror when recorded, else PCAT − FCAT; data errors left out', () => {
  assert.equal(missedFrac(rec(1), { delayUsd: -1.5, size: 10 }), 0.15);
  assert.ok(Math.abs(missedFrac(rec(1)) - 0.13) < 1e-12);
  assert.equal(missedFrac(rec(1, { pcat: 157706623615 })), null, 'the broken PCAT values are not counted');
});

test('every exit on the trade, best first, and the full analysis with charts', () => {
  const ex = exitResults(rec(1));
  assert.ok(ex.length >= 10); assert.ok(ex.every((e, i) => i === 0 || ex[i - 1].pnl >= e.pnl), 'sorted best first');
  assert.ok(ex.some((e) => /PCAT/.test(e.name)) && ex.some((e) => /best second/.test(e.name)));
  const records = Array.from({ length: 12 }, (_, i) => rec(i, { fcat: i % 3 ? 0.1 : -0.05 }));
  const a = tradeAnalysis(records[11], records, { mirror: { yourUsd: 1.2, perfectUsd: 2.5, delayUsd: -1.3, afterFeesUsd: 0.6, feesUsd: 0.6, feeSol: 0.006, size: 10 }, pathUrl: coinChart(records[11], records), mirrorUrl: null });
  assert.deepEqual(a.charts.map((c) => c.name), ['price', 'delay', 'exits', 'vs-history']);
  for (const h of ['## Verdict', 'Missed on the delay: +13.0%', '## The delay, step by step', 'Place in line: **#3**', '## Every exit on this trade', '## Compared with your last 11 trades', '## Setups like this one', '## Every second']) assert.ok(a.md.includes(h), h);
  assert.equal(specFromUrl('x', chartUrl({ name: 'x', width: 300, height: 200, config: { type: 'bar' } })).config.type, 'bar', 'a GET chart link converts back to a chart');
});

test('day and history charts: you vs Decu\'s price, and the profit the delays took', () => {
  const records = Array.from({ length: 20 }, (_, i) => rec(i, { fcat: i % 2 ? 0.1 : -0.04, entryGap: (i % 5) / 20, latency: { blocksAfter: i % 7 }, delaySec: 1 + (i % 3) }));
  const mirrorOf = (r) => ({ perfectUsd: 2, yourUsd: 1, delayUsd: -1, feesUsd: 0.5, size: 10 });
  const d = dayCharts('2026-10-26', records, mirrorOf);
  assert.deepEqual(d.map((c) => c.name), ['day-compare', 'day-cumulative']);
  const a = delayAnalysis(records, { buySol: 0.1, solUsd: 100, mirrorOf });
  assert.equal(a.trades, 20); assert.ok(Math.abs(a.missedSol - 20 * 0.1 * 0.1) < 1e-9, 'each trade missed 10% of 0.1 SOL');
  assert.ok(Math.abs(a.missedUsd - a.missedSol * 100) < 1e-9);
  assert.ok(a.blocks.length && a.latency.length && a.premium.length && a.crowd.length);
  const charts = analysisCharts(a);
  assert.deepEqual(charts.map((c) => c.name), ['cumulative', 'missed-per-day', 'by-blocks', 'by-latency', 'by-crowd', 'by-premium', 'premium-vs-result']);
  const md = analysisMarkdown(a, { charts: { cumulative: '![[c.png]]' } });
  assert.match(md, /The delays cost \+0\.2000 SOL \(≈ \$20\.00\)/); assert.match(md, /!\[\[c\.png\]\]/); assert.match(md, /## By blocks after Decu/);
});

test('rendering: a PNG from QuickChart, null on any failure (the note links the chart online instead)', async () => {
  let body = null;
  const ok = await renderPng({ name: 'x', width: 300, height: 200, config: { type: 'bar' } }, { fetchImpl: async (u, init) => { body = JSON.parse(init.body); return { ok: true, arrayBuffer: async () => PNG }; } });
  assert.ok(ok.equals(PNG)); assert.equal(body.format, 'png'); assert.equal(body.chart.type, 'bar');
  assert.equal(await renderPng({ name: 'x', width: 1, height: 1, config: {} }, { fetchImpl: async () => ({ ok: false }) }), null);
  assert.equal(await renderPng({ name: 'x', width: 1, height: 1, config: {} }, { fetchImpl: async () => { throw new Error('offline'); } }), null);
  assert.equal(await renderPng({ name: 'x', width: 1, height: 1, config: {} }, { fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('<html>error</html>') }) }), null, 'only a real PNG is saved');
});

test('every new trade gets its charts saved in the vault and embedded in its note; its day and the analysis too', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-')), records = [], learn = createBrain({ buySol: 0.1 });
  const rules = { maxPayPct: 15, stopLossPct: 20, gainGatePct: 15 }; let renders = 0;
  const b = createThinkingBrain({ file: path.join(dir, 'mem.json'), study: { records, brain: learn }, mode: 'paper', rules, defaults: { ...rules }, solUsd: () => 100, vaultDir: path.join(dir, 'v'), vaultSyncMin: 0,
    chartFetch: async () => { renders++; return { ok: true, arrayBuffer: async () => PNG }; } });
  for (let i = 0; i < 3; i++) { const r = rec(i); records.push(r); learn.observe(r, records, { silent: true }); b.onTrade(r); }
  await b.notesIdle();
  const v = path.join(dir, 'v'), note = fs.readFileSync(path.join(v, 'machine/trades/2026-10-26 1420 $C2.md'), 'utf8');
  for (const n of ['price', 'delay', 'mirror', 'exits', 'vs-history']) { assert.ok(fs.existsSync(path.join(v, `machine/charts/2026-10-26 1420 $C2 ${n}.png`)), n); assert.ok(note.includes(`![[machine/charts/2026-10-26 1420 $C2 ${n}.png]]`), `${n} embedded`); }
  assert.match(note, /## Verdict/); assert.match(note, /## Every exit on this trade/);
  const day = fs.readFileSync(path.join(v, 'machine/daily/2026-10-26.md'), 'utf8');
  assert.ok(day.includes('![[machine/charts/daily 2026-10-26 day-compare.png]]'));
  const an = fs.readFileSync(path.join(v, 'machine/analysis/Delays and missed profit.md'), 'utf8');
  assert.match(an, /# Delays and missed profit/); assert.ok(an.includes('![[machine/charts/analysis cumulative.png]]'));
  assert.ok(renders >= 15);
  const z = b.vaultZip(); assert.ok(z.includes(Buffer.from('Decu Brain/machine/charts/')), 'the pictures are in the zip');
  b.stop();
});
