import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGoal } from './goal.mjs';

const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-goal-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return path.join(d, 'rolex-goal.json'); };
const NOW = Date.parse('2026-10-27T20:00:00Z');
const closed = (i, sol, o = {}) => ({ mint: `M${i}`, symbol: `C${i}`, boughtAt: NOW - (10 - i) * 86400e3 - 60e3, closedAt: NOW - (10 - i) * 86400e3, costSol: 0.1, pnlSol: sol, rule: 'his sell / other', ...o });

test('Rolex ledger: only LIVE profit fills the meter; paper is the practice meter', (t) => {
  const g = createGoal({ file: tmp(t), goalUsd: 20000, timezone: 'UTC' });
  assert.equal(g.add('live', closed(1, 0.5), 100), true);
  assert.equal(g.add('live', closed(1, 0.5), 100), false, 'the same close is counted once');
  g.add('live', closed(2, -0.1), 100); g.add('paper', closed(3, 2), 100);
  assert.equal(g.add('demo', closed(4, 9), 100), false, 'demo trades never count');
  const s = g.summary({ solUsd: 100, now: NOW });
  assert.equal(s.live.usd, 40); assert.equal(s.live.n, 2); assert.equal(s.live.wins, 1); assert.equal(s.live.remaining, 19960); assert.equal(s.live.pct, 40 / 20000);
  assert.equal(s.paper.usd, 200); assert.deepEqual(s.milestones, [1000, 5000, 10000, 15000, 20000]);
  assert.deepEqual(s.live.days[new Date(NOW - 9 * 86400e3).toISOString().slice(0, 10)], { usd: 50, sol: 0.5, n: 1, wins: 1 });
  assert.equal(s.live.best.symbol, 'C1'); assert.equal(s.live.entries, undefined, 'entries only when asked');
  assert.equal(g.summary({ solUsd: 100, now: NOW, entries: true }).live.entries.length, 2);
});

test('Rolex ledger: kept on the disk, seeded from the engine, valued at the price when it closed', (t) => {
  const file = tmp(t);
  const g = createGoal({ file, timezone: 'UTC' });
  assert.equal(g.seed('paper', [closed(1, 0.1), closed(2, 0.2), { mint: 'bad' }], null), 2);
  assert.equal(g.seed('paper', [closed(1, 0.1)], null), 0, 'a second seed adds nothing');
  g.add('live', closed(5, 1), 150);
  const again = createGoal({ file, timezone: 'UTC' }).summary({ solUsd: 200, now: NOW });
  assert.equal(again.live.usd, 150, 'live profit valued at $150 when it closed, not today\'s $200');
  assert.equal(again.paper.usd, 60, 'seeded without a price: valued at today\'s price');
  assert.equal(again.paper.unknownPrice, 2);
});

test('Rolex ledger: old entries fold into a carried total, pace and arrival date', (t) => {
  const g = createGoal({ file: tmp(t), maxEntries: 3, timezone: 'UTC', goalUsd: 1000 });
  for (let i = 1; i <= 5; i++) g.add('live', closed(i, 0.2), 100);
  assert.equal(g.entries().length, 3);
  const s = g.summary({ solUsd: 100, now: NOW });
  assert.equal(s.live.n, 5); assert.equal(s.live.usd, 100, 'nothing lost when entries fold');
  assert.ok(s.live.pace30.perDay > 0); assert.equal(s.live.eta30.reached, false); assert.ok(s.live.eta30.date > NOW);
  assert.ok(s.live.path.roi > 0 && s.live.path.sizes.length === 6);
});
