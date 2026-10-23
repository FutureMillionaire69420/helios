import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { mirror10, mirrorTotals, mirrorChart, RANKS, rankFacts, rankChecks, earnedRank, tuneStopGate, createThinkingBrain, createBackup, restoreIfEmpty } from './brain.mjs';
import { createBrain } from './learn.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'brain-'));
const day0 = Date.parse('2026-10-01T00:00:00Z');
// a bought trade: 0.1 SOL, SOL at $200, his price 1e-7, the bot paid `gap` more, exit `exitX` times his price
const rec = (i, { fcat = 0.05, gap = 0.05, exitX = 1.2, taken = true, curve = null, time = null } = {}) => ({
  time: time || new Date(day0 + i * 3600e3).toISOString(), mint: `mint${i}`, symbol: `T${i}`, hisSol: 2, hisUsd: 400, cost: 0.1, buyFeeSol: 0.003, sellFeeSol: 0.003, delaySec: 1,
  hisPrice: 1e-7, entryPrice: 1e-7 * (1 + gap), exitPrice: 1e-7 * exitX, entryGap: gap, fcat, pcat: 0.15, hisSoldAtSec: 4, pcatExit: 'his sell at 4s',
  curve: curve || Array.from({ length: 16 }, (_, s) => (s < 5 ? fcat * s / 4 : fcat)), taken, skipReason: taken ? null : 'entry premium 40%' });

test('$10 mirror: your entry vs Decu\'s perfect entry, the delay cost and the network fees', () => {
  const m = mirror10(rec(1, { gap: 0.1, exitX: 1.2 }), { poolFee: 0.0125 });
  const keep = 0.9875 ** 2;
  assert.ok(Math.abs(m.perfectUsd - (keep * 1.2 - 1) * 10) < 1e-9);
  assert.ok(Math.abs(m.yourUsd - (keep * 1.2 / 1.1 - 1) * 10) < 1e-9);
  assert.ok(Math.abs(m.delayUsd - (m.yourUsd - m.perfectUsd)) < 1e-9);
  assert.ok(m.delayUsd < 0, 'paying more than Decu costs money');
  assert.ok(Math.abs(m.feesUsd - 0.006 * 200) < 1e-9, 'fees are SOL at his SOL price, the same at any size');
  assert.ok(Math.abs(m.afterFeesUsd - (m.yourUsd - m.feesUsd)) < 1e-9);
  assert.equal(m.exitAt, 'his sell at 4s');
  assert.ok(Number.isFinite(m.fcatUsd) && Number.isFinite(m.rulesUsd) && Number.isFinite(m.pcatUsd));
  assert.equal(mirror10({ ...rec(2), hisPrice: null }), null, 'no Decu price, no mirror');
  const url = mirrorChart(rec(1), m); assert.match(url, /^https:\/\/quickchart\.io\/chart\?/);
  assert.match(decodeURIComponent(url), /Delay cost/);
  const t = mirrorTotals([rec(1), rec(2), rec(3, { taken: false })]);
  assert.equal(t.trades, 2, 'bought trades only');
});

test('ranks need trades AND skill AND profit on the $1000 bankroll', () => {
  assert.deepEqual(RANKS.map((r) => r.name), ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Grandmaster']);
  const winners = Array.from({ length: 60 }, (_, i) => rec(i, { fcat: i % 2 ? 0.1 : -0.02 }));
  const f = rankFacts(winners, { now: day0 + 60 * 3600e3 });
  assert.equal(f.trades, 60); assert.equal(f.win, 0.5);
  assert.ok(f.bank > 1000, 'profitable bankroll');
  assert.equal(RANKS[earnedRank(f)].name, 'Gold', 'Platinum also needs 100 trades and predictions');
  const losers = Array.from({ length: 60 }, (_, i) => rec(i, { fcat: i % 2 ? 0.02 : -0.05 }));
  const g = rankFacts(losers, { now: day0 + 60 * 3600e3 });
  assert.ok(g.bank < 1000);
  assert.equal(RANKS[earnedRank(g)].name, 'Silver', 'enough trades and win rate, but not profitable: no Gold');
  assert.ok(rankChecks(RANKS[2], g).some((c) => !c.ok && /bankroll/.test(c.text)));
});

test('stop / gate tuning moves one notch only when it also wins on newer unseen trades', () => {
  // every trade dips to -12% then runs to +40%: a -10% stop sells too early, -15% holds
  const curve = [0, -0.12, 0.1, 0.2, 0.3, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4];
  const rs = Array.from({ length: 60 }, (_, i) => ({ ...rec(i, { curve, fcat: 0.4 }), hisSoldAtSec: null }));
  assert.equal(tuneStopGate(rs, { stopLossPct: 15, gainGatePct: 15 }), null, 'already the best nearby');
  const t = tuneStopGate(rs, { stopLossPct: 10, gainGatePct: 15 });
  assert.ok(t && t.stopLossPct === 15 && t.testGainSol > 0);
  assert.equal(tuneStopGate(rs.slice(0, 20), { stopLossPct: 10 }), null, 'not enough evidence');
});

function setup({ mode = 'paper', n = 0, opts = {} } = {}) {
  const dir = tmp(), records = [], notes = [];
  const study = { records, brain: createBrain({ buySol: 0.1 }) };
  for (let i = 0; i < n; i++) { records.push(rec(i)); study.brain.observe(records[i], records, { silent: true }); }
  const rules = { maxPayPct: 15, stopLossPct: 20, gainGatePct: 15 };
  const b = createThinkingBrain({ file: path.join(dir, 'mem.json'), study, mode, rules, defaults: { ...rules }, version: '3.6.0', notify: (a) => notes.push(a), solUsd: () => 200, now: () => day0 + 1e9, ...opts });
  return { b, records, notes, rules, dir, study };
}

test('every bought trade gets a Brain note with the rank, its thinking and the $10 mirror; memory is saved', () => {
  const { b, records, notes, dir } = setup();
  const r = { ...rec(1), thinking: ['Prediction before the result: +3%'] };
  records.push(r); b.onTrade(r);
  const n = notes.find((x) => x.kind === 'brain');
  assert.ok(n, 'a brain note');
  assert.ok(n.tags.includes('brain'));
  assert.match(n.title, /^\[PAPER\] Brain: \$T1 \$10 mirror/);
  assert.match(n.body, /BRAIN · Bronze \(1\/7\)/);
  assert.match(n.body, /Decu perfect \$10/); assert.match(n.body, /delay cost/); assert.match(n.body, /Network fees/);
  assert.match(n.body, /FCAT .* PCAT .* stop\/gate rules/);
  assert.match(n.image, /quickchart/);
  const mem = JSON.parse(fs.readFileSync(path.join(dir, 'mem.json'), 'utf8'));
  assert.equal(mem.versions[0].version, '3.6.0'); assert.equal(mem.stats.bought, 1);
  // skipped buys are studied but never move the rank or send a brain note
  const s = rec(2, { taken: false }); records.push(s); b.onTrade(s);
  assert.equal(notes.filter((x) => x.kind === 'brain').length, 1);
});

test('a promotion is announced; failing the rank 10 trades in a row drops one rank', () => {
  const { b, records, notes } = setup();
  for (let i = 0; i < 25; i++) { const r = rec(i, { fcat: 0.05 }); records.push(r); b.onTrade(r); }
  assert.equal(b.status().rank.name, 'Silver');
  assert.ok(notes.some((x) => /promoted to Silver/.test(x.title)));
  // a run of losses pushes the win rate under 40%
  for (let i = 25; i < 80; i++) { const r = rec(i, { fcat: -0.05 }); records.push(r); b.onTrade(r); }
  assert.equal(b.status().rank.name, 'Bronze');
  assert.ok(notes.some((x) => /dropped to Bronze/.test(x.title)));
});

test('paper: the brain changes its own rules on walk-forward evidence and remembers them after a restart; live only suggests', () => {
  const curve = [0, -0.12, 0.1, 0.2, 0.3, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4];
  for (const mode of ['paper', 'live']) {
    const { b, records, notes, rules, dir, study } = setup({ mode, opts: { minEvidence: 50 } });
    rules.stopLossPct = 10; // the settings: a stop that sells these trades too early
    for (let i = 0; i < 60; i++) { const r = { ...rec(i, { curve, fcat: 0.4 }), hisSoldAtSec: null }; records.push(r); study.brain.observe(r, records, { silent: true }); b.onTrade(r); }
    if (mode === 'paper') {
      assert.equal(rules.stopLossPct, 15, 'paper: changed');
      assert.ok(notes.some((x) => /I changed my paper rules/.test(x.title)));
      const again = { maxPayPct: 15, stopLossPct: 10, gainGatePct: 15 };
      createThinkingBrain({ file: path.join(dir, 'mem.json'), study, mode, rules: again, defaults: { ...again }, version: '3.6.0' });
      assert.equal(again.stopLossPct, 15, 'remembered after a restart');
      const off = { maxPayPct: 15, stopLossPct: 10, gainGatePct: 15 };
      createThinkingBrain({ file: path.join(dir, 'mem.json'), study, mode, rules: off, defaults: { ...off }, version: '3.6.0', autoTune: false });
      assert.equal(off.stopLossPct, 10, 'BRAIN_AUTOTUNE=false: the settings');
    } else {
      assert.equal(rules.stopLossPct, 10, 'live: never changed');
      assert.ok(notes.some((x) => /Brain suggests a change/.test(x.title) && /never change live settings/.test(x.body)));
    }
  }
});

test('the paper veto waits until predictions beat guessing, and never runs live', () => {
  const { b } = setup();
  assert.equal(b.gate({ mint: 'x', hisSol: 5, entryGap: 0.5, delaySec: 3 }), null, 'no prediction record yet');
  const live = setup({ mode: 'live' });
  assert.equal(live.b.gate({ mint: 'x' }), null);
  // a learning brain that predicts well: losing trades always come with a 4+ SOL Decu buy
  const records = [], learn = createBrain({ buySol: 0.1 });
  for (let i = 0; i < 80; i++) { const big = i % 2 === 0; const r = { ...rec(i, { fcat: big ? -0.2 : 0.1 }), hisSol: big ? 5 : 0.5 }; records.push(r); learn.observe(r, records, { silent: true }); }
  const rules = { maxPayPct: 15, stopLossPct: 20, gainGatePct: 15 };
  const smart = createThinkingBrain({ file: path.join(tmp(), 'm.json'), study: { records, brain: learn }, mode: 'paper', rules, defaults: { ...rules } });
  const why = smart.gate({ mint: 'big', time: new Date().toISOString(), hisSol: 5 });
  assert.match(why, /^brain skip: I expect −?-?\d/); assert.match(why, /not bought$/);
  assert.equal(smart.gate({ mint: 'small', time: new Date().toISOString(), hisSol: 0.5 }), null, 'a trade it expects to win is bought');
  assert.equal(smart.status().vetoes.skipped, 0);
});

test('GitHub backup: own branch, the token never leaks, restore fills an empty disk', async () => {
  const TOKEN = 'test-token-' + 'z'.repeat(36), store = {}, calls = [], logs = [];
  const fake = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization });
    const j = (status, body) => ({ status, ok: status < 300, json: async () => body });
    if (/\/git\/ref\/heads\/brain-backup-paper$/.test(url)) return store.branch ? j(200, {}) : j(404, {});
    if (/\/git\/ref\/heads\/main$/.test(url)) return j(200, { object: { sha: 'abc' } });
    if (/\/git\/refs$/.test(url)) { store.branch = true; return j(201, {}); }
    if (/\/contents\//.test(url)) {
      const f = url.split('/contents/')[1].split('?')[0];
      if (init.method === 'PUT') { const b = JSON.parse(init.body); assert.equal(b.branch, 'brain-backup-paper'); store[f] = b.content; return j(201, {}); }
      return store[f] ? j(200, { content: store[f], sha: 's' }) : j(404, {});
    }
    if (/\/repos\/o\/r$/.test(url)) return j(200, { default_branch: 'main' });
    return j(500, { message: `boom ${TOKEN}` });
  };
  const bk = createBackup({ token: TOKEN, repo: 'o/r', branch: 'brain-backup-paper', fetchImpl: fake, log: (m) => logs.push(m) });
  assert.equal(await bk.save({ memory: { rank: { name: 'Gold' }, stats: { bought: 3 } }, journalLines: ['{"a":1}', '{"a":2}'] }), 'saved');
  assert.ok(calls.every((c) => c.auth === `Bearer ${TOKEN}`));
  assert.ok(!calls.some((c) => c.url.includes(TOKEN)), 'the token is a header, never in a URL');
  assert.ok(!calls.some((c) => /heads\/main/.test(c.url) && c.method === 'PUT'), 'never writes main');
  const dir = tmp(), mf = path.join(dir, 'mem.json'), jf = path.join(dir, 'study.jsonl');
  assert.match(await restoreIfEmpty({ backup: bk, memoryFile: mf, journalFile: jf }), /restored/);
  assert.equal(JSON.parse(fs.readFileSync(mf, 'utf8')).rank.name, 'Gold');
  assert.equal(fs.readFileSync(jf, 'utf8'), '{"a":1}\n{"a":2}\n');
  assert.equal(await restoreIfEmpty({ backup: bk, memoryFile: mf, journalFile: jf }), 'local memory present', 'never overwrites a disk that has memory');
  assert.ok(zlib.gunzipSync(Buffer.from(store['brain/study-journal.jsonl.gz'], 'base64')).toString().startsWith('{"a":1}'));
  // a failure message that echoes the token is scrubbed
  const bad = createBackup({ token: TOKEN, repo: 'o/x', fetchImpl: async () => ({ status: 500, ok: false, json: async () => ({}) }), log: (m) => logs.push(m) });
  const r = await bad.save({ memory: {}, journalLines: null });
  assert.match(r, /^failed/); assert.ok(!r.includes(TOKEN) && !logs.some((l) => l.includes(TOKEN)));
  assert.equal(createBackup({ token: '', repo: 'o/r' }), null, 'no token, no backup');
});

test('end to end: a studied trade carries the mirror prices and the brain note follows it', async () => {
  const { createStudy } = await import('./study.mjs');
  const dir = tmp(), notes = [];
  let i = 0; const quoteSell = async () => 0.1 * (1 + 0.02 * i++);
  let thinking = null;
  const s = createStudy({ file: path.join(dir, 'study.jsonl'), quoteSell, notify: (a) => notes.push(a), buySol: 0.1, feeSol: 0.003, slip: 0, stepMs: 5, coinCharts: false, onRecord: (r) => thinking?.onTrade(r) });
  const rules = { maxPayPct: 15, stopLossPct: 20, gainGatePct: 15 };
  thinking = createThinkingBrain({ file: path.join(dir, 'mem.json'), study: s, mode: 'paper', rules, defaults: { ...rules }, version: '3.6.0', notify: (a) => notes.push(a), solUsd: () => 200 });
  const r = await s.start({ mint: 'Mint1111', cost: 0.103, raw: '1000000', entryPrice: 0.1 * 0.9875 / 1e6, his: { sol: 2, raw: 22_000_000, usd: 400, time: Date.now() / 1000 - 1 } });
  assert.ok(r.hisPrice > 0 && r.entryPrice > 0 && r.exitPrice > 0, 'prices recorded');
  const n = notes.find((x) => x.kind === 'brain');
  assert.ok(n, 'brain note sent'); assert.match(n.body, /\$10 MIRROR/);
});
