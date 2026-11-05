import test from 'node:test';
import assert from 'node:assert/strict';
import {morningDue, morningBrief, zoned} from './morning.mjs';

test('the morning push is due once a day at 07:43 New York time, winter and summer', () => {
  const tz = 'America/New_York', t = (iso) => Date.parse(iso);
  assert.equal(morningDue({now: t('2026-11-05T12:42:00Z'), timezone: tz}).due, false, '07:42 EST');
  const d = morningDue({now: t('2026-11-05T12:43:00Z'), timezone: tz});
  assert.deepEqual([d.due, d.day], [true, '2026-11-05'], '07:43 EST');
  assert.equal(morningDue({now: t('2026-11-05T13:10:00Z'), timezone: tz, lastDay: '2026-11-05'}).due, false, 'already sent today');
  assert.equal(morningDue({now: t('2026-11-05T15:44:00Z'), timezone: tz}).due, false, 'more than 3 h late: skip the day');
  assert.equal(morningDue({now: t('2026-07-01T11:43:00Z'), timezone: tz}).due, true, '07:43 EDT in summer');
  assert.equal(morningDue({now: t('2026-11-06T12:50:00Z'), timezone: tz, lastDay: '2026-11-05'}).due, true, 'next day');
  assert.equal(morningDue({now: t('2026-11-05T09:00:00Z'), timezone: 'UTC', at: '9:00'}).due, true, 'MORNING_PUSH_AT=9:00');
  assert.equal(morningDue({now: t('2026-11-05T12:43:00Z'), timezone: tz, at: 'nonsense'}).target, 7 * 60 + 43, 'bad setting falls back to 07:43');
  assert.equal(zoned(t('2026-11-05T12:43:00Z'), 'Not/AZone').day, '2026-11-05', 'an unknown zone falls back to UTC');
});

test('the morning message: health, paper results and the SOL price, read-only', () => {
  const now = Date.parse('2026-11-05T12:43:00Z');
  const m = morningBrief({mode: 'paper', version: '4.9.0', uptimeMs: 50 * 3600e3, ready: {ready: true, blocking: [], warnings: []}, feed: 'subscribed',
    lastSignalAt: '2026-11-05T09:43:00Z', errors: 0, trades: [{fcat: 0.2}, {fcat: -0.1}, {fcat: -0.05}], buySol: 0.1,
    mirror: {trades: 3, yourUsd: 0.5, feesUsd: 2.1, afterFeesUsd: -1.6}, rankLine: 'Bronze (1/7) · bankroll $934.31 (−$65.69)',
    solUsd: 158, solUsdPrev: 160, helius: {credits: 412_000, limit: 1_000_000, pace: 1_200_000}, ntfy: {total: 40, max: 250}, now});
  assert.equal(m.title, '[PAPER] Good morning · 3 trades · FCAT +0.0050 SOL · healthy');
  for (const want of ['v4.9.0 · up 2 d 2 h · ready ✔', 'his last trade 3 h ago', 'Helius credits: 412k of 1.00M this month (pace 1.20M: OVER the plan)',
    '3 trades, 1 won · FCAT +0.0050 SOL at 0.1 SOL a trade', '$10 mirror: +$0.50 before fees, −$1.60 after fees', 'Brain: Bronze (1/7)',
    "SOL $158.00 (-1.2% since yesterday's push)", 'No real money used.']) assert.ok(m.body.includes(want), `missing "${want}" in:\n${m.body}`);
  const bad = morningBrief({mode: 'paper', ready: {ready: false, blocking: ['Bot power'], warnings: []}, trades: [], now});
  assert.match(bad.title, /0 trades .* NOT READY$/);
  assert.match(bad.body, /NOT READY: Bot power/);
  assert.match(bad.body, /No bought trades in the last 24 h/);
  assert.match(bad.body, /SOL price not available/);
  assert.ok(Buffer.byteLength(m.body) < 3900, 'fits in one ntfy message');
  assert.equal(morningBrief({mode: 'live', trades: [], now}).title.startsWith('Good morning'), true, 'no tag when live');
});
