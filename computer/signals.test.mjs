import test from 'node:test';
import assert from 'node:assert/strict';
import { linkKind, dexPaidFrom, createLaunchCounter, hourBlock } from './signals.mjs';
import { signalsNote } from './duelbrain.mjs';

test('link kind: X community, single tweet, X account, other link, none, unknown', () => {
  assert.equal(linkKind({ twitter: 'https://x.com/i/communities/1890000000000000000' }), 'community');
  assert.equal(linkKind({ metadata: { twitter: 'https://twitter.com/someone/status/1890000000000000001' } }), 'tweet');
  assert.equal(linkKind({ metadata: { twitter: 'https://x.com/someone' } }), 'profile');
  assert.equal(linkKind({ metadata: { website: 'https://example.com' } }), 'other');
  assert.equal(linkKind({ metadata: { twitter: '', website: ' ' } }), 'none');
  assert.equal(linkKind({ symbol: 'ABC' }), 'none');
  assert.equal(linkKind(null), null);
  assert.equal(linkKind({ website: 'https://notx.com/i/communities/1' }), 'other', 'a look-alike domain is not X');
});

test('DexScreener orders -> paid or not (array or {orders}), unreadable -> null', () => {
  assert.deepEqual(dexPaidFrom([{ type: 'tokenProfile', status: 'approved', paymentTimestamp: 1700000000000 }]), { paid: true, at: 1700000000000 });
  assert.deepEqual(dexPaidFrom({ orders: [{ type: 'tokenProfile', status: 'processing' }] }), { paid: true, at: null });
  assert.deepEqual(dexPaidFrom([{ type: 'tokenProfile', status: 'rejected', paymentTimestamp: 1 }, { type: 'tokenAd', status: 'approved', paymentTimestamp: 2 }]), { paid: false, at: null });
  assert.deepEqual(dexPaidFrom([]), { paid: false, at: null });
  assert.equal(dexPaidFrom({ error: 'x' }), null);
  assert.equal(dexPaidFrom(null), null);
});

test('launch counter: null until it has seen a full window, then the launches inside it', () => {
  let t = 0;
  const lc = createLaunchCounter({ windowMs: 1000, now: () => t });
  assert.equal(lc.count(), null);
  lc.add(0); t = 400; lc.add(); t = 900; lc.add();
  assert.equal(lc.count(), null, 'not a full window yet');
  t = 1000; assert.equal(lc.count(), 3);
  t = 1500; assert.equal(lc.count(), 1, 'the ones older than the window drop off');
});

test('hour block of his buy (UTC, 4-hour blocks)', () => {
  assert.equal(hourBlock(Date.UTC(2026, 10, 14, 0, 30) / 1000), '00–04 UTC');
  assert.equal(hourBlock(Date.UTC(2026, 10, 14, 13, 5) / 1000), '12–16 UTC');
  assert.equal(hourBlock(Date.UTC(2026, 10, 14, 23, 59) / 1000), '20–24 UTC');
  assert.equal(hourBlock(null), null);
});

test('the Signals note splits copy-everything results by each signal (measured only)', () => {
  const rows = [
    { hour: '12–16 UTC', hisSol: 0.5, top1x: 0.05, leaderPct: 0.03, link: 'community', dexPaid: true, launches10m: 150, fcatAll: 0.2, dipAll: 0.1 },
    { hour: '12–16 UTC', hisSol: 3, top1x: 0.01, leaderPct: 0.1, link: 'tweet', dexPaid: false, launches10m: 350, fcatAll: -0.1, dipAll: null },
    { hour: '00–04 UTC', hisSol: 5, top1x: null, leaderPct: null, link: null, dexPaid: null, launches10m: null, fcatAll: null, dipAll: -0.05 },
  ];
  const n = signalsNote(rows);
  assert.match(n, /type: "duel-signals"/);
  assert.match(n, /\| 4% or more \| 1 \| \+20\.0% \(1\) \| \+10\.0% \(1\) \|/);
  assert.match(n, /\| under 2% \| 1 \| −10\.0% \(1\) \| — \|/);
  assert.match(n, /\| no holder data \| 1 \|/);
  assert.match(n, /\| 2\.5–4 SOL \| 1 \|/);
  assert.match(n, /\| X community \| 1 \|[\s\S]*\| a single tweet \| 1 \|/);
  assert.match(n, /\| paid \| 1 \|[\s\S]*\| not paid \| 1 \|[\s\S]*\| unknown \| 1 \|/);
  assert.match(n, /\| 00–04 UTC \| 1 \|[\s\S]*\| 12–16 UTC \| 2 \|/);
  assert.match(n, /\| 100–200 \| 1 \|[\s\S]*\| 300 or more \| 1 \|/);
  assert.match(signalsNote(rows.map((r) => ({ ...r, launches10m: null }))), /Not recorded: the launch counter is off/);
  assert.match(signalsNote([]), /Hour of his buy[\s\S]*\| no data \| 0 \|/);
});
