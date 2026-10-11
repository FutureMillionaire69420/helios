import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as P from './pumpbuild.mjs';
import {config, setFetch, findProgramAddress, associatedTokenAddress as ata, b58decode, b58encode, parseTransaction, signTransaction, loadKeypair, validateTrade, TIP_ACCOUNTS} from './copybot.mjs';

const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/leader-ws-logs.json', import.meta.url), 'utf8'));
const h = {findProgramAddress, ata, b58decode, b58encode};
const MINT = 'siBF3bcDKAH9so6zFSRLVer6ua3sFJ8m279aF2cpump';
const global = {feeRecipients: ['62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV'], reservedFeeRecipients: ['GesfTA3X2arioaHp8bbKdjG9vJtskViWACZoYvxp4twS'], buybackFeeRecipients: ['EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL']};
const kp = loadKeypair(JSON.stringify([...Buffer.alloc(32, 9)]));
const BH = b58encode(Buffer.alloc(32, 7));

test("full trade event from his real buy: creator, fees, token program, mayhem", () => {
  const ctx = P.buyContextFromLogs(fx.buy.logs, config.leader, b58encode);
  assert.equal(ctx.mint, MINT); assert.equal(ctx.user, config.leader); assert.equal(ctx.isBuy, true);
  assert.equal(ctx.feeBps, 95n); assert.equal(ctx.creatorFeeBps, 30n); assert.equal(ctx.tokenProgram, P.TOKEN_2022);
  assert.match(ctx.creator, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/); assert.equal(ctx.mayhem, false); assert.equal(ctx.ixName, 'buy_exact_quote_in');
  assert.equal(P.buyContextFromLogs(fx.sell.logs, config.leader, b58encode), null, 'sells give no buy context');
});

test('price math predicts his real fill to 0.000001%', () => {
  const ctx = P.buyContextFromLogs(fx.buy.logs, config.leader, b58encode);
  const pre = {...ctx, vSol: ctx.vSol - ctx.solAmount, vTok: ctx.vTok + ctx.tokenAmount};
  const predicted = P.tokensOut(pre, 247_500_000n);
  assert.ok(Math.abs(Number(predicted - ctx.tokenAmount)) / Number(ctx.tokenAmount) < 1e-7, `${predicted} vs ${ctx.tokenAmount}`);
});

test('local buy transaction: right instruction, 18 pump.fun accounts, slippage floor, fits in a packet', () => {
  const ctx = {...P.buyContextFromLogs(fx.buy.logs, config.leader, b58encode), feeRecipient: global.feeRecipients[0], buybackRecipient: global.buybackFeeRecipients[0]};
  const t0 = performance.now();
  const {bytes, expectedTokens, minTokensOut} = P.buildBuyTransaction({user: kp.publicKey, ctx, lamports: 100_000_000, slippagePct: 20, blockhash: BH, tipAccount: TIP_ACCOUNTS[0], tipLamports: 1_000_000}, h);
  const ms = performance.now() - t0;
  assert.ok(ms < 50, `built in ${ms.toFixed(1)} ms`);
  assert.ok(bytes.length < 1232, `${bytes.length} bytes`);
  assert.equal(minTokensOut, expectedTokens * 8000n / 10000n);
  const tx = parseTransaction(bytes);
  assert.equal(tx.keys[0], kp.publicKey); assert.equal(tx.numRequiredSignatures, 1);
  for (const k of [P.PUMP, P.ATA_PROGRAM, P.COMPUTE_BUDGET, MINT, TIP_ACCOUNTS[0], global.buybackFeeRecipients[0], findProgramAddress([Buffer.from('bonding-curve-v2'), b58decode(MINT)], P.PUMP)[0]]) assert.ok(tx.keys.includes(k), k);
  const accounts = P.buyAccounts({user: kp.publicKey, mint: MINT, tokenProgram: P.TOKEN_2022, creator: ctx.creator, feeRecipient: ctx.feeRecipient, buybackRecipient: ctx.buybackRecipient}, h);
  assert.equal(accounts.length, 18);
  assert.equal(accounts[3].k, findProgramAddress([Buffer.from('bonding-curve'), b58decode(MINT)], P.PUMP)[0]);
  assert.equal(accounts[5].k, ata(kp.publicKey, MINT, P.TOKEN_2022));
});

test("the bot's full safety check accepts a local buy (network calls mocked)", async (t) => {
  t.after(() => setFetch(null));
  const ctx = {...P.buyContextFromLogs(fx.buy.logs, config.leader, b58encode), feeRecipient: global.feeRecipients[0], buybackRecipient: global.buybackFeeRecipients[0]};
  const {bytes} = P.buildBuyTransaction({user: kp.publicKey, ctx, lamports: Math.floor(config.buySol * 1e9), slippagePct: config.slippagePct, blockhash: BH, tipAccount: TIP_ACCOUNTS[0], tipLamports: 1_000_000}, h);
  const signed = signTransaction(bytes, kp);
  const tokenAcct = Buffer.alloc(165); tokenAcct.writeBigUInt64LE(500_000_000_000n, 64);
  const calls = [];
  setFetch(async (url, init) => {
    const {method} = JSON.parse(init.body); calls.push(method);
    const r = method === 'getMultipleAccounts' ? {value: [{lamports: 1e9}, null, null]}
      : {value: {err: null, accounts: [{lamports: 1e9 - 0.11e9}, null, {data: [tokenAcct.toString('base64'), 'base64']}]}};
    return {ok: true, status: 200, json: async () => ({result: r}), text: async () => ''};
  });
  await validateTrade(signed.bytes, {side: 'buy', mint: MINT, sol: config.buySol}, 1);
  assert.deepEqual(calls, ['getMultipleAccounts', 'simulateTransaction'], 'full simulation still runs');
  const over = P.buildBuyTransaction({user: kp.publicKey, ctx, lamports: Math.floor(config.buySol * 2e9), slippagePct: 20, blockhash: BH}, h);
  await assert.rejects(validateTrade(signTransaction(over.bytes, kp).bytes, {side: 'buy', mint: MINT, sol: config.buySol}, 1), /exceeds budget/);
});

test('fee recipients: reserved list for mayhem coins, buyback recipient required', () => {
  assert.equal(P.pickFeeRecipient(global, false), global.feeRecipients[0]);
  assert.equal(P.pickFeeRecipient(global, true), global.reservedFeeRecipients[0]);
  assert.equal(P.pickBuybackRecipient(global), global.buybackFeeRecipients[0]);
  assert.throws(() => P.pickFeeRecipient({feeRecipients: []}, false), /no pump.fun fee recipient/);
});
