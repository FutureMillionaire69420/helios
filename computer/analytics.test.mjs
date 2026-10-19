import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildAnalytics, digestMessages, quickChartUrl, boughtRecords} from './analytics.mjs';
import {startRuntime} from './runtime.mjs';
import {config, detectBuy, detectSell} from './copybot.mjs';

const rec = (i, over = {}) => ({time: new Date(Date.UTC(2026, 9, 10 + (i % 5), 12, i)).toISOString(), mint: `Mint${i}`.padEnd(32, 'x'), symbol: `C${i}`, taken: true,
  fcat: ((i * 37) % 11 - 5) / 20, entryGap: (i % 7) / 20 - 0.02, delaySec: 1 + (i % 4) * 0.5, latency: {blocksAfter: i % 6}, curve: Array.from({length: 16}, (_, s) => Math.sin(i + s) / 5),
  btsab: i % 16, peak: 0.2, pcat: 0.3, fcatExit: i % 2 ? 'his sell at 4s' : '15s limit', buyFeeSol: 0.0015, sellFeeSol: 0.0015, holderVerdict: {safe: i % 3 !== 0}, ...over});

test('analytics: bought trades only, every chart built, no network needed', () => {
  const records = [...Array.from({length: 40}, (_, i) => rec(i)), rec(99, {taken: false, skipReason: 'entry premium 40%', fcat: 5})];
  assert.equal(boughtRecords(records).length, 40, 'the skipped (not bought) study is left out');
  const a = buildAnalytics({records, buySol: 0.1, timezone: 'UTC'});
  assert.equal(a.bought, 40); assert.match(a.basis, /estimated/);
  const ids = a.charts.map((c) => c.id);
  for (const id of ['cum', 'per-trade', 'daily', 'drawdown', 'premium', 'premium-win', 'blocks', 'blocks-result', 'rules', 'path', 'btsab', 'holders', 'edge', 'fees']) assert.ok(ids.includes(id), id);
  const cum = a.charts.find((c) => c.id === 'cum');
  const expected = records.filter((r) => r.taken).reduce((s, r) => s + r.fcat * 0.1, 0);
  assert.ok(Math.abs(cum.values.at(-1) - expected) < 1e-3, 'running total matches the bought trades (the skipped +500% is not in it)');
  assert.ok(a.tiles.find((t) => t.id === 'trades').value === 40);
});

test('analytics: realized results from the closed-trade ledger take over once there are any', () => {
  const closed = [{mint: 'A', symbol: 'AAA', boughtAt: 1000, closedAt: 9000, costSol: 0.1, pnlSol: 0.02, pnlPct: 0.2, rule: 'gain-target'}, {mint: 'B', boughtAt: 1000, closedAt: 31000, costSol: 0.1, pnlSol: -0.01, pnlPct: -0.1, rule: 'stoploss'}];
  const a = buildAnalytics({records: [rec(1)], closed, timezone: 'UTC'});
  assert.match(a.basis, /realized/);
  assert.equal(a.tiles.find((t) => t.id === 'pnl').value, 0.01);
  assert.deepEqual(a.charts.find((c) => c.id === 'rules').x.sort(), ['gain-target', 'stoploss']);
  const hold = a.charts.find((c) => c.id === 'hold'); assert.deepEqual(hold.points.map((p) => p.x), [8, 30]);
});

test('analytics digest: one phone image per key chart, short QuickChart links', () => {
  const a = buildAnalytics({records: Array.from({length: 300}, (_, i) => rec(i)), timezone: 'UTC'});
  const m = digestMessages(a, {max: 6, tag: '[PAPER] '});
  assert.equal(m.length, 6); assert.match(m[0].title, /^\[PAPER\] Analytics 1: Running profit/); assert.match(m[0].body, /Bought trades only/);
  for (const x of m) { assert.match(x.image, /^https:\/\/quickchart\.io\/chart\?/); assert.ok(x.image.length < 4500, `${x.title}: ${x.image.length} chars`); }
  const cfg = JSON.parse(decodeURIComponent(new URL(quickChartUrl(a.charts[0])).searchParams.get('c')));
  assert.ok(cfg.data.labels.length <= 60, 'at most 60 points per image');
});

test('runtime: /api/analytics, the dashboard send button, and the daily chart cap', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-analytics-')), studyFile = path.join(dir, 'study.jsonl');
  fs.writeFileSync(studyFile, Array.from({length: 12}, (_, i) => JSON.stringify(rec(i))).join('\n') + '\n' + JSON.stringify(rec(50, {taken: false, skipReason: 'max open'})) + '\n');
  const saved = {...process.env};
  Object.assign(process.env, {ENGINE_STATE_FILE: path.join(dir, 'engine.json'), STUDY_FILE: studyFile, PORT: '0', DASHBOARD_TOKEN: 'analytics-test-token-24-chars-x', STALE_DATA_SEC: '0', ANALYTICS_CHECK_MS: '3600000'});
  const sent = []; let left = 3;
  const k = {config: {...config, dryRun: true, logFile: path.join(dir, 'log')}, redact: (x) => x, detectBuy, detectSell, getSolUsd: async () => 100, quoteSell: async () => 0.1, quoteBuy: async () => ({raw: 1}),
    getTransaction: async () => null, startWatcher: () => () => {},
    notify: async (m) => { if (m.kind === 'chart' && left-- <= 0) return 'capped'; sent.push(m); return 'sent'; }, ntfyUsage: () => ({total: sent.length, max: 250, chartsLeft: Math.max(0, left)})};
  const r = await startRuntime(k);
  t.after(() => { r.stop(); fs.rmSync(dir, {recursive: true, force: true}); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  const base = `http://127.0.0.1:${r.server.address().port}`, auth = {Authorization: 'Bearer ' + process.env.DASHBOARD_TOKEN};
  const a = await (await fetch(base + '/api/analytics', {headers: auth})).json();
  assert.equal(a.bought, 12, 'the skipped study is not counted'); assert.ok(a.charts.length >= 10);
  const msg = await (await fetch(base + '/api/analytics/send', {method: 'POST', headers: auth})).text();
  assert.equal(sent.filter((m) => m.kind === 'chart').length, 3, 'stopped at the daily chart cap');
  assert.match(msg, /Sent 3 charts.*cap is reached/);
  assert.ok(sent.filter((m) => m.kind === 'chart').every((m) => m.image && /quickchart/.test(m.image)), 'each chart message carries its image');
  assert.ok((await fetch(base + '/charts.js')).ok, 'the chart renderer is served');
});
