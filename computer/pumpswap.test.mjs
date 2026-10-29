import test from 'node:test';
import assert from 'node:assert/strict';
import {setFetch, setStream, quoteSell, quoteBuy, watchCurve, canonicalPoolPda, findProgramAddress, b58decode, b58encode, PROGRAMS} from './copybot.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WSOL = 'So11111111111111111111111111111111111111112';
// a graduated pump.fun coin: its curve says complete, its canonical PumpSwap pool holds the coin and SOL
const MINT = 'fbsPyxXB4Baj48CkdmVPx8MBxADQoF8nXCyguNxpump';
const curvePk = findProgramAddress([Buffer.from('bonding-curve'), b58decode(MINT)], PROGRAMS.PUMP)[0];
const pool = canonicalPoolPda(MINT), baseVault = findProgramAddress([Buffer.from('test-base-vault')], PROGRAMS.PUMP_AMM)[0], quoteVault = findProgramAddress([Buffer.from('test-quote-vault')], PROGRAMS.PUMP_AMM)[0];
const curveData = (complete) => { const b = Buffer.alloc(166); b.writeBigUInt64LE(1n, 8); b.writeBigUInt64LE(1n, 16); b[48] = complete ? 1 : 0; return b.toString('base64'); };
const poolData = () => { const b = Buffer.alloc(301); b.set(b58decode(MINT), 43); b.set(b58decode(WSOL), 75); b.set(b58decode(baseVault), 139); b.set(b58decode(quoteVault), 171); return b.toString('base64'); };
const vault = (amount) => { const b = Buffer.alloc(165); b.writeBigUInt64LE(BigInt(amount), 64); return b.toString('base64'); };
function chain({ base = 750_000_000_000_000n, quote = 7_500_000_000n } = {}) {
  const calls = [];
  setFetch(async (url, init) => {
    const { method, params } = JSON.parse(init.body); calls.push(method);
    const ok = (result) => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
    if (method === 'getAccountInfo' && params[0] === curvePk) return ok({ value: { owner: PROGRAMS.PUMP, data: [curveData(true), 'base64'] } });
    if (method === 'getAccountInfo' && params[0] === pool) return ok({ value: { owner: PROGRAMS.PUMP_AMM, data: [poolData(), 'base64'] } });
    if (method === 'getMultipleAccounts') return ok({ value: [{ data: [vault(base), 'base64'] }, { data: [vault(quote), 'base64'] }] });
    if (/jup\.ag/.test(url)) throw new Error('Jupiter must not be needed for a pump.fun pool');
    return ok({ value: null });
  });
  return calls;
}

test('a coin that moved to PumpSwap is priced from its pool on the chain, not Jupiter', async (t) => {
  t.after(() => setFetch(null));
  const calls = chain();
  const sol = await quoteSell(MINT, 1e11);
  const expected = (7_500_000_000 * 1e11) / (750_000_000_000_000 + 1e11) / 1e9 * (1 - 0.0125);
  assert.ok(Math.abs(sol - expected) < 1e-9, `${sol} vs ${expected}`);
  const buy = await quoteBuy(MINT, 0.1);
  assert.equal(buy.venue, 'pumpswap'); assert.ok(buy.raw > 0);
  // once known as graduated, its curve is not read again and the pool's address is remembered: one read per price
  calls.length = 0; await quoteSell(MINT, 1e11);
  assert.deepEqual(calls, ['getMultipleAccounts']);
});

test('pool prices over the websocket: pushed only when both vault balances come from the same block', async (t) => {
  t.after(() => { setFetch(null); setStream(null); });
  chain();
  const subs = new Map();
  setStream({ watchAccount: (pk, cb) => { subs.set(pk, cb); const un = () => subs.delete(pk); un.ready = () => true; un.readyAt = () => 1; return un; } });
  const got = [];
  const un = watchCurve(MINT, (c) => got.push(c));
  await sleep(30);
  assert.ok(subs.has(baseVault) && subs.has(quoteVault), 'both vaults watched once the curve is known to be complete');
  subs.get(baseVault)(vault(700_000_000_000_000n), Date.now(), 100);
  subs.get(quoteVault)(vault(8_000_000_000n), Date.now(), 100);
  await sleep(200);
  assert.equal(got.filter((c) => c.pumpswap).length, 1, 'one settled price for block 100');
  const p = got.find((c) => c.pumpswap);
  assert.equal(p.vSol, 8_000_000_000n); assert.equal(p.vTok, 700_000_000_000_000n); assert.equal(p.complete, false);
  // the base vault moved in block 101 but the SOL side has not arrived: no half-updated (false) price
  subs.get(baseVault)(vault(900_000_000_000_000n), Date.now(), 101);
  await sleep(200);
  assert.equal(got.filter((c) => c.pumpswap).length, 1, 'mismatched blocks are never pushed');
  assert.equal(un.ready(), true);
  un(); assert.equal(subs.size, 0, 'unsubscribes the curve and both vaults');
});

test('a coin that has just graduated: its new pool is found about a second later, not a minute later', async (t) => {
  t.after(() => setFetch(null));
  // the curve completes a few seconds before the migration creates the pool; Jupiter does not know the pool yet
  const M = b58encode(Buffer.alloc(32, 7)), cpk = findProgramAddress([Buffer.from('bonding-curve'), b58decode(M)], PROGRAMS.PUMP)[0], ppk = canonicalPoolPda(M);
  const data = () => { const b = Buffer.alloc(301); b.set(b58decode(M), 43); b.set(b58decode(WSOL), 75); b.set(b58decode(baseVault), 139); b.set(b58decode(quoteVault), 171); return b.toString('base64'); };
  let exists = false; const asked = [];
  setFetch(async (url, init) => {
    if (/jup\.ag/.test(url)) return { ok: false, status: 429, text: async () => 'rate limited' };
    const { method, params } = JSON.parse(init.body);
    const ok = (result) => ({ ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) });
    if (method === 'getAccountInfo' && params[0] === cpk) return ok({ value: { owner: PROGRAMS.PUMP, data: [curveData(true), 'base64'] } });
    if (method === 'getAccountInfo' && params[0] === ppk) { asked.push(Date.now()); return ok({ value: exists ? { owner: PROGRAMS.PUMP_AMM, data: [data(), 'base64'] } : null }); }
    if (method === 'getMultipleAccounts') return ok({ value: [{ data: [vault(750_000_000_000_000n), 'base64'] }, { data: [vault(7_500_000_000n), 'base64'] }] });
    return ok({ value: null });
  });
  assert.equal(await quoteSell(M, 1e11), null, 'no pool yet, and Jupiter has no price');
  exists = true;
  assert.equal(await quoteSell(M, 1e11), null, 'not asked again within the first second');
  await sleep(1100);
  assert.ok((await quoteSell(M, 1e11)) > 0, 'priced from the new pool a second later (it used to wait 60 s)');
  assert.equal(asked.length, 2);
});
