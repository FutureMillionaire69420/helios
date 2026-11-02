import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseProfile, summarizeTrades, createPumpProfile} from './pumpprofile.mjs';

const A = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', SOL = 'So11111111111111111111111111111111111111112', COIN = 'CoinMint1111111111111111111111111111111pump', PF = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const row = (sig, t, buy, lamports) => ({ trans_id: sig, block_time: t, block_id: 1, sources: [PF], value: 10,
  routers: buy ? { token1: SOL, amount1: lamports, token1_decimals: 9, token2: COIN, amount2: 1e9, token2_decimals: 6 } : { token1: COIN, amount1: 1e9, token1_decimals: 6, token2: SOL, amount2: lamports, token2_decimals: 9 } });

test('pump.fun profile: reads a profile link or a bare address, nothing else', () => {
  assert.equal(parseProfile(A), A);
  assert.equal(parseProfile(`https://pump.fun/profile/${A}`), A);
  assert.equal(parseProfile(`pump.fun/profile/${A}?tab=balances`), A);
  assert.equal(parseProfile(`https://pump.fun/coin/${A}`), null);
  assert.equal(parseProfile('hello'), null);
  assert.equal(parseProfile(''), null);
});

test('pump.fun profile: totals per window and per coin', () => {
  const now = 1_000_000;
  const s = summarizeTrades([{ side: 'sell', mint: COIN, sol: 0.3, time: now - 60 }, { side: 'buy', mint: COIN, sol: 0.2, time: now - 120 }, { side: 'buy', mint: 'X', sol: 1, time: now - 3 * 86400 }], now);
  assert.equal(s.day.buys, 1); assert.equal(s.day.sells, 1); assert.ok(Math.abs(s.day.net - 0.1) < 1e-9);
  assert.equal(s.week.buys, 2); assert.ok(Math.abs(s.week.net + 0.9) < 1e-9);
  assert.equal(s.coins[0].mint, COIN); assert.ok(Math.abs(s.coins[0].net - 0.1) < 1e-9);
});

test('pump.fun profile: one Solscan read per minute, names cached, never a trading call', async () => {
  let reads = 0, metas = 0, t = 5_000_000;
  const p = createPumpProfile({ now: () => t, activities: async (a) => { assert.equal(a, A); reads++; return [row('s2', 4999, false, 3e8), row('s1', 4990, true, 2e8)]; }, tokenMeta: async () => { metas++; return { symbol: 'DOG' }; } });
  const r = await p.trades(A);
  assert.equal(r.trades.length, 2); assert.equal(r.trades[0].side, 'sell'); assert.equal(r.trades[0].name, '$DOG'); assert.ok(Math.abs(r.trades[1].sol - 0.2) < 1e-9);
  await p.trades(A); assert.equal(reads, 1, 'cached for a minute');
  await p.trades(A, { refresh: true }); assert.equal(reads, 1, 'refresh is limited to every 15 s');
  t += 16_000; await p.trades(A, { refresh: true }); assert.equal(reads, 2);
  assert.equal(metas, 1, 'coin names are cached');
  await assert.rejects(p.trades('nope'), /Not a Solana address/);
  assert.equal(createPumpProfile({ activities: null }), null, 'off without Solscan');
  const src = fs.readFileSync(new URL('./pumpprofile.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /\b(signTransaction|sendRaw|sendTransaction|quoteBuy|quoteSell|privateKey|keypair|curveSell)\b/i, 'read-only: no signing or trading code');
});
