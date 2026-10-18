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

test('max-pay floor makes the on-chain minimum stricter, never looser', () => {
  const ctx = {...P.buyContextFromLogs(fx.buy.logs, config.leader, b58encode), feeRecipient: global.feeRecipients[0], buybackRecipient: global.buybackFeeRecipients[0]};
  const base = P.buildBuyTransaction({user: kp.publicKey, ctx, lamports: 100_000_000, slippagePct: 20, blockhash: BH}, h);
  const strict = P.buildBuyTransaction({user: kp.publicKey, ctx, lamports: 100_000_000, slippagePct: 20, blockhash: BH, minTokensFloor: base.minTokensOut * 2n}, h);
  assert.equal(strict.minTokensOut, base.minTokensOut * 2n);
  const loose = P.buildBuyTransaction({user: kp.publicKey, ctx, lamports: 100_000_000, slippagePct: 20, blockhash: BH, minTokensFloor: 1n}, h);
  assert.equal(loose.minTokensOut, base.minTokensOut);
});

// ---------------- LOCAL SELL ----------------
const SPEC = JSON.parse(fs.readFileSync(new URL('./fixtures/pump-sdk-4.1.0.json', import.meta.url), 'utf8'));
const pda = (seeds, prog = P.PUMP) => findProgramAddress(seeds, prog)[0];
const CREATOR = b58encode(Buffer.alloc(32, 21)), BUYBACK = P.STATIC_BUYBACK_RECIPIENTS[0], FEE_REC = P.STATIC_FEE_RECIPIENTS[0];

test("sell math predicts Decu's real sell to the lamport (fees rounded up like pump.fun)", () => {
  const l = fx.sell.logs.find((x) => x.startsWith('Program data: '));
  const ev = P.decodeFullTradeEvent(l.slice(14).trim(), b58encode);
  assert.equal(ev.isBuy, false); assert.equal(ev.user, config.leader);
  // his sell's sol_amount is the curve's gross output; the curve before his sell had that much more SOL
  const pre = {vSol: ev.vSol + ev.solAmount, vTok: ev.vTok - ev.tokenAmount, feeBps: ev.feeBps, creatorFeeBps: ev.creatorFeeBps};
  assert.equal(P.solOut(pre, ev.tokenAmount), ev.solAmount - ev.fee - ev.creatorFee, 'what reached his wallet');
  assert.equal(P.solOut(pre, 0n), 0n);
});

test('local sell: exactly the accounts pump.fun\'s own SDK sends (IDL order + remaining accounts), right data', () => {
  const spec = SPEC.instructions.sell;
  assert.equal(spec.discriminator, '33e685a4017f83ad');
  assert.deepEqual(spec.args.map((a) => a.name + ':' + a.type), ['amount:u64', 'min_sol_output:u64']);
  const want = (cashback) => {
    const bc = pda([Buffer.from('bonding-curve'), b58decode(MINT)]);
    const byName = {global: pda([Buffer.from('global')]), fee_recipient: FEE_REC, mint: MINT, bonding_curve: bc, associated_bonding_curve: ata(bc, MINT, P.TOKEN_2022),
      associated_user: ata(kp.publicKey, MINT, P.TOKEN_2022), user: kp.publicKey, system_program: '11111111111111111111111111111111', creator_vault: pda([Buffer.from('creator-vault'), b58decode(CREATOR)]),
      token_program: P.TOKEN_2022, event_authority: pda([Buffer.from('__event_authority')]), program: P.PUMP, fee_config: pda([Buffer.from('fee_config'), b58decode(P.PUMP)], P.FEE_PROGRAM), fee_program: P.FEE_PROGRAM};
    return [...spec.accounts.map((a) => ({k: byName[a.name], w: a.writable, s: a.signer, name: a.name})),
      ...(cashback ? [{k: pda([Buffer.from('user_volume_accumulator'), b58decode(kp.publicKey)]), w: true, s: false, name: 'user_volume_accumulator'}] : []),
      {k: pda([Buffer.from('bonding-curve-v2'), b58decode(MINT)]), w: false, s: false, name: 'bonding_curve_v2'}, {k: BUYBACK, w: true, s: false, name: 'buyback_fee_recipient'}];
  };
  for (const cashback of [false, true]) {
    const got = P.sellAccounts({user: kp.publicKey, mint: MINT, tokenProgram: P.TOKEN_2022, creator: CREATOR, feeRecipient: FEE_REC, buybackRecipient: BUYBACK, cashback}, h);
    const exp = want(cashback);
    assert.equal(got.length, exp.length, `cashback ${cashback}: ${got.length} accounts`);
    exp.forEach((e, i) => { assert.equal(got[i].k, e.k, `#${i} ${e.name}`); assert.equal(!!got[i].w, e.w, `#${i} ${e.name} writable`); assert.equal(!!got[i].s, e.s, `#${i} ${e.name} signer`); });
  }
  for (const a of spec.accounts.filter((x) => x.address)) assert.ok([P.PUMP, P.FEE_PROGRAM, '11111111111111111111111111111111'].includes(a.address), a.name);
});

test('local sell transaction: compute budget, sell, close the empty token account (rent back), tip; one signer', () => {
  const kit = {mint: MINT, tokenProgram: P.TOKEN_2022, creator: CREATOR, feeRecipient: FEE_REC, buybackRecipient: BUYBACK, cashback: false};
  for (const closeAccount of [true, false]) {
    const {bytes} = P.buildSellTransaction({user: kp.publicKey, kit, raw: 123_456_789n, minSolOut: 55_000_000n, blockhash: BH, priorityLamports: 1_000_000, tipAccount: TIP_ACCOUNTS[0], tipLamports: 2_000_000, closeAccount}, h);
    assert.ok(bytes.length < 1232, `${bytes.length} bytes`);
    const tx = parseTransaction(bytes);
    assert.equal(tx.keys[0], kp.publicKey); assert.equal(tx.numRequiredSignatures, 1, 'only the wallet signs');
    // decode the legacy message: [program index, accounts, data] per instruction
    const m = tx.message; let o = 3; const sv = () => { let n = 0, sh = 0, b; do { b = m[o++]; n |= (b & 0x7f) << sh; sh += 7; } while (b & 0x80); return n; };
    const nk = sv(); o += nk * 32 + 32; const ni = sv(); const ixs = [];
    for (let i = 0; i < ni; i++) { const pid = m[o++]; const na = sv(); const acc = [...m.subarray(o, o + na)].map((x) => tx.keys[x]); o += na; const nd = sv(); ixs.push({program: tx.keys[pid], acc, data: Buffer.from(m.subarray(o, o + nd))}); o += nd; }
    assert.deepEqual(ixs.map((x) => x.program), [P.COMPUTE_BUDGET, P.COMPUTE_BUDGET, P.PUMP, ...(closeAccount ? [P.TOKEN_2022] : []), '11111111111111111111111111111111']);
    const sell = ixs[2];
    assert.equal(sell.data.subarray(0, 8).toString('hex'), '33e685a4017f83ad'); assert.equal(sell.data.length, 24);
    assert.equal(sell.data.readBigUInt64LE(8), 123_456_789n); assert.equal(sell.data.readBigUInt64LE(16), 55_000_000n);
    assert.equal(sell.acc.length, 16);
    if (closeAccount) {
      const close = ixs[3];
      assert.deepEqual([...close.data], [9], 'CloseAccount');
      assert.deepEqual(close.acc, [ata(kp.publicKey, MINT, P.TOKEN_2022), kp.publicKey, kp.publicKey], 'account, rent to the wallet, owner');
    }
    const tip = ixs.at(-1); assert.equal(tip.acc[1], TIP_ACCOUNTS[0]); assert.equal(tip.data.readBigUInt64LE(4), 2_000_000n);
    assert.equal(ixs[1].data.readBigUInt64LE(1), BigInt(Math.floor(1_000_000 * 1e6 / 100_000)), 'priority price = fee / compute limit');
  }
});

test("the bot's full safety check accepts a local sell that closes the account, and refuses a wrong amount", async (t) => {
  t.after(() => setFetch(null));
  const kit = {mint: MINT, tokenProgram: P.TOKEN_2022, creator: CREATOR, feeRecipient: FEE_REC, buybackRecipient: BUYBACK};
  const {bytes} = P.buildSellTransaction({user: kp.publicKey, kit, raw: 500_000_000_000n, minSolOut: 1n, blockhash: BH, priorityLamports: 1_000_000, tipAccount: TIP_ACCOUNTS[0], tipLamports: 2_000_000, closeAccount: true}, h);
  const signed = signTransaction(bytes, kp);
  const held = Buffer.alloc(165); held.writeBigUInt64LE(500_000_000_000n, 64);
  let calls = [], after = null;
  setFetch(async (url, init) => {
    const {method} = JSON.parse(init.body); calls.push(method);
    // before: wallet, its classic-token account (none), its Token-2022 account (holding); after: SOL back, account closed
    const r = method === 'getMultipleAccounts' ? {value: [{lamports: 1e9}, null, {data: [held.toString('base64'), 'base64']}]}
      : {value: {err: null, accounts: [{lamports: 1e9 + 0.09e9}, null, after]}};
    return {ok: true, status: 200, json: async () => ({result: r}), text: async () => ''};
  });
  // what the RPC really returns for the closed account (agave rpc.rs: the post-simulation account itself, not null):
  // Token-2022 / p-token: 0 lamports, no data, owned by the system program; the old token program: 0 lamports, zeroed data
  const closedNew = {lamports: 0, data: ['', 'base64'], owner: '11111111111111111111111111111111', executable: false, space: 0};
  const closedOld = {lamports: 0, data: [Buffer.alloc(165).toString('base64'), 'base64'], owner: P.TOKEN, executable: false, space: 165};
  for (const closed of [closedNew, closedOld, null]) {
    calls = []; after = closed;
    await validateTrade(signed.bytes, {side: 'sell', mint: MINT, raw: '500000000000'}, 1, 0.003);
    assert.deepEqual(calls, ['getMultipleAccounts', 'simulateTransaction'], 'full simulation still runs');
  }
  await assert.rejects(validateTrade(signed.bytes, {side: 'sell', mint: MINT, raw: '400000000000'}, 1, 0.003), /quantity mismatch/);
  after = {lamports: 2_039_280, data: [Buffer.alloc(10).toString('base64'), 'base64'], owner: P.TOKEN_2022, executable: false, space: 10};
  await assert.rejects(validateTrade(signed.bytes, {side: 'sell', mint: MINT, raw: '500000000000'}, 1, 0.003), /invalid token account/, 'a malformed account is still refused');
  const left = Buffer.alloc(165); left.writeBigUInt64LE(1n, 64);
  after = {lamports: 2_039_280, data: [left.toString('base64'), 'base64'], owner: P.TOKEN_2022, executable: false, space: 165};
  await assert.rejects(validateTrade(signed.bytes, {side: 'sell', mint: MINT, raw: '500000000000'}, 1, 0.003), /differs from intended trade/, 'tokens left behind are still refused');
});

test('local buy sends partial_fill (pump.fun IDL after 2026-10-11): 4 arguments, all-or-nothing', () => {
  assert.deepEqual(SPEC.instructions.buy_exact_sol_in.args.map((a) => a.name), ['spendable_sol_in', 'min_tokens_out', 'track_volume', 'partial_fill']);
  const ctx = {...P.buyContextFromLogs(fx.buy.logs, config.leader, b58encode), feeRecipient: FEE_REC, buybackRecipient: BUYBACK};
  const {bytes} = P.buildBuyTransaction({user: kp.publicKey, ctx, lamports: 100_000_000, slippagePct: 20, blockhash: BH}, h);
  const raw = Buffer.from(bytes), at = raw.indexOf(Buffer.from('38fc74089edfcd5f', 'hex'));
  assert.ok(at > 0); const data = raw.subarray(at, at + 26);
  assert.equal(data.readBigUInt64LE(8), 100_000_000n); assert.deepEqual([data[24], data[25]], [1, 0], 'track_volume true, partial_fill false');
  assert.equal(raw[at - 1], 26, 'instruction data is 26 bytes');
  const want = SPEC.instructions.buy_exact_sol_in.accounts.map((a) => a.name);
  assert.equal(want.length, 16); assert.equal(P.buyAccounts({user: kp.publicKey, mint: MINT, tokenProgram: P.TOKEN_2022, creator: CREATOR, feeRecipient: FEE_REC, buybackRecipient: BUYBACK}, h).length, 18, '16 IDL + bonding-curve-v2 + buyback');
});

test('bonding curve account: creator, mayhem / cashback flags and quote mint (IDL field order)', () => {
  assert.deepEqual(SPEC.BondingCurve.slice(0, 9).map((f) => f.split(':')[0]), ['virtual_token_reserves', 'virtual_quote_reserves', 'real_token_reserves', 'real_quote_reserves', 'token_total_supply', 'complete', 'creator', 'is_mayhem_mode', 'is_cashback_coin']);
  const b = Buffer.alloc(150); b.writeBigUInt64LE(600n, 8); b.writeBigUInt64LE(45n, 16); b.writeBigUInt64LE(10n ** 15n, 40); b[48] = 0; b58decode(CREATOR).forEach((x, i) => { b[49 + i] = x; }); b[81] = 1; b[82] = 1;
  let c = P.decodeBondingCurve(b, b58encode);
  assert.deepEqual([c.vTok, c.vSol, c.complete, c.creator, c.mayhem, c.cashback, c.quoteMint], [600n, 45n, false, CREATOR, true, true, null]);
  assert.equal(P.quotedInSol(c), true, 'all-zero quote mint = SOL');
  b58decode(P.WSOL).forEach((x, i) => { b[83 + i] = x; }); assert.equal(P.quotedInSol(P.decodeBondingCurve(b, b58encode)), true, 'WSOL = SOL');
  b.fill(5, 83, 115); c = P.decodeBondingCurve(b, b58encode); assert.equal(P.quotedInSol(c), false, 'another quote mint: PumpPortal sells it');
  assert.equal(P.tokenAccountAmount(Buffer.alloc(0)), 0n, 'closed account'); const ta = Buffer.alloc(165); ta.writeBigUInt64LE(777n, 64); assert.equal(P.tokenAccountAmount(ta.toString('base64')), 777n);
});

test('sell desk: armed at the buy, kept current by pushes, sells with no network, disarmed when sold', () => {
  const watched = []; let push = null, unwatched = 0;
  const watchAccount = (pk, cb) => { watched.push(pk); push = cb; const un = () => { unwatched++; }; un.ready = () => true; return un; };
  const desk = P.createSellDesk({helpers: h, watchAccount});
  const ctx = P.buyContextFromLogs(fx.buy.logs, config.leader, b58encode);
  desk.arm(MINT, {tokenProgram: ctx.tokenProgram, creator: ctx.creator, mayhem: false, feeBps: ctx.feeBps, creatorFeeBps: ctx.creatorFeeBps, user: kp.publicKey, curve: {vSol: ctx.vSol, vTok: ctx.vTok, complete: false}});
  assert.deepEqual(watched, [ata(kp.publicKey, MINT, P.TOKEN_2022)], 'its token balance is watched from the moment it is armed');
  assert.equal(desk.balance(MINT), null, 'no balance pushed yet: the bot asks the chain');
  const ta = Buffer.alloc(165); ta.writeBigUInt64LE(9_000_000n, 64); push(ta.toString('base64'), Date.now());
  assert.equal(desk.balance(MINT), 9_000_000n);
  assert.equal(desk.blocker(MINT), null, 'ready to sell');
  desk.update(MINT, {vSol: ctx.vSol * 2n, vTok: ctx.vTok, complete: false, creator: ctx.creator, mayhem: false, cashback: false, quoteMint: null});
  const t0 = performance.now();
  const b = desk.build({mint: MINT, raw: 9_000_000n, slippagePct: 35, blockhash: BH, priorityLamports: 1_000_000, tipAccount: TIP_ACCOUNTS[0], tipLamports: 2_000_000, closeAccount: true, global});
  const ms = performance.now() - t0;
  assert.ok(ms < 20, `built in ${ms.toFixed(2)} ms`);
  const exp = P.solOut({vSol: ctx.vSol * 2n, vTok: ctx.vTok, feeBps: ctx.feeBps, creatorFeeBps: ctx.creatorFeeBps}, 9_000_000n);
  assert.equal(b.expectedLamports, exp, 'priced from the newest pushed curve'); assert.equal(b.minSolOut, exp * 6500n / 10000n, '35% sell slippage');
  assert.equal(b.feeRecipient, global.feeRecipients[0]); assert.equal(b.buybackRecipient, global.buybackFeeRecipients[0]);
  desk.update(MINT, {vSol: 1n, vTok: 1n, complete: true}); assert.match(desk.blocker(MINT), /left the curve/);
  desk.update(MINT, {vSol: 1n, vTok: 1n, complete: false, quoteMint: b58encode(Buffer.alloc(32, 5))}); assert.match(desk.blocker(MINT), /not quoted in SOL/);
  desk.arm('MAYHEM', {tokenProgram: P.TOKEN, creator: CREATOR, mayhem: true, user: kp.publicKey, curve: {vSol: 10n, vTok: 10n, complete: false}});
  assert.throws(() => desk.build({mint: 'MAYHEM', raw: 1n, slippagePct: 35, blockhash: BH, priorityLamports: 1, global: null}), /mayhem/);
  desk.disarm(MINT); assert.equal(unwatched, 1); assert.equal(desk.kit(MINT), null);
});

test('sell desk: a balance pushed before a websocket reconnect, or before a failed sell, is not trusted', () => {
  let push = null, readyAt = 1000, ready = true;
  const watchAccount = (pk, cb) => { push = cb; const un = () => {}; un.ready = () => ready; un.readyAt = () => (ready ? readyAt : null); return un; };
  const desk = P.createSellDesk({helpers: h, watchAccount, now: () => 5000});
  desk.arm(MINT, {tokenProgram: P.TOKEN_2022, creator: CREATOR, user: kp.publicKey});
  const ta = Buffer.alloc(165); ta.writeBigUInt64LE(7_000_000n, 64);
  push(ta.toString('base64'), 2000);
  assert.equal(desk.balance(MINT), 7_000_000n, 'pushed after the subscription was acknowledged');
  ready = false; assert.equal(desk.balance(MINT), null, 'socket down: ask the chain');
  ready = true; readyAt = 3000;
  assert.equal(desk.balance(MINT), null, 're-subscribed after that push: a change may have been missed while down');
  push(ta.toString('base64'), 3500); assert.equal(desk.balance(MINT), 7_000_000n, 'a push on the new subscription is trusted again');
  desk.forgetBalance(MINT); assert.equal(desk.balance(MINT), null, 'after a failed sell the next one reads the chain');
  desk.update(MINT, {vSol: 50n, vTok: 50n, complete: false}, 4000);
  desk.arm(MINT, {curve: {vSol: 10n, vTok: 10n, complete: false}, curveAt: 3000});
  assert.equal(desk.kit(MINT).curve.vSol, 50n, 'a re-arm with an older price keeps the newer pushed one');
  desk.arm(MINT, {curve: {vSol: 60n, vTok: 60n, complete: false}, curveAt: 4500});
  assert.equal(desk.kit(MINT).curve.vSol, 60n, 'a newer one replaces it');
});

test("derived addresses match pump.fun's published ones (the fast on-curve check, both outcomes)", () => {
  // fee_config's bump is 253: the 255 and 254 candidates are on the curve and must be rejected
  assert.deepEqual(findProgramAddress([Buffer.from('fee_config'), b58decode(P.PUMP)], 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ'), ['8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt', 253]);
  assert.equal(findProgramAddress([Buffer.from('global')], P.PUMP)[0], '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  assert.equal(findProgramAddress([Buffer.from('__event_authority')], P.PUMP)[0], 'Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1');
  assert.equal(findProgramAddress([Buffer.from('global_volume_accumulator')], P.PUMP)[0], 'Hq2wp8uJ9jCPsYgNHex8RtqdvMPfVGoYwjvF1ATiwn2Y');
});
