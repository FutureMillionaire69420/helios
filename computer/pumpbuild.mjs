// LOCAL PUMP.FUN BUY BUILDER: builds the buy transaction inside the bot instead of asking
// PumpPortal's server, so a buy needs no web round trip at all.
//
// Everything comes from Decu's own trade event in the websocket logs (creator, fee recipient,
// reserves after his buy, token program) plus a blockhash the bot keeps fresh in the background.
// Instruction: pump.fun `buy_exact_sol_in` (spend exactly X SOL, receive at least N tokens), with
// accounts and discriminator taken from pump.fun's own IDL stored on-chain (read 2026-10-11).
// Bonding-curve coins only; graduated (PumpSwap) coins fall back to PumpPortal.

import crypto from 'node:crypto';

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const FEE_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const BUY_EXACT_SOL_IN = Buffer.from('38fc74089edfcd5f', 'hex');
const TRADE_EVENT = Buffer.from('bddb7fd34ee661ee', 'hex');
const FEE_CONFIG_SEED = Buffer.from('0156e0f693665acf44db1568bf175baa5189cb97f5d2ff3b655d2bb6fd6d18b0', 'hex');

/** Full pump.fun TradeEvent (IDL layout) from one "Program data:" log line, or null. */
export function decodeFullTradeEvent(b64, b58encode) {
  let b;
  try { b = Buffer.from(b64, 'base64'); } catch { return null; }
  if (b.length < 225 || !b.subarray(0, 8).equals(TRADE_EVENT)) return null;
  let o = 8;
  const pk = () => { const v = b58encode(b.subarray(o, o + 32)); o += 32; return v; };
  const u64 = () => { const v = b.readBigUInt64LE(o); o += 8; return v; };
  const bool = () => b[o++] === 1;
  const ev = { mint: pk(), solAmount: u64(), tokenAmount: u64(), isBuy: bool(), user: pk(), timestamp: Number(b.readBigInt64LE(o)) };
  o += 8;
  Object.assign(ev, { vSol: u64(), vTok: u64(), realSol: u64(), realTok: u64(), feeRecipient: pk(), feeBps: u64(), fee: u64(), creator: pk(), creatorFeeBps: u64(), creatorFee: u64() });
  try { // track_volume, unclaimed, claimed, sol volume, last update, ix_name (string), mayhem_mode
    o += 1 + 8 + 8 + 8 + 8; const len = b.readUInt32LE(o); o += 4; ev.ixName = b.subarray(o, o + len).toString(); o += len; ev.mayhem = bool();
  } catch { ev.mayhem = false; }
  return ev;
}

/**
 * pump.fun Global account (IDL layout): normal fee recipients, and the reserved ones mayhem-mode
 * coins must pay. Read once at startup; the bot picks one per buy.
 */
export async function readGlobal(rpc, { findProgramAddress, b58encode }) {
  const global = findProgramAddress([Buffer.from('global')], PUMP)[0];
  const r = await rpc('getAccountInfo', [global, { encoding: 'base64', commitment: 'confirmed' }], 5000);
  const d = Buffer.from(r?.value?.data?.[0] || '', 'base64');
  if (d.length < 740) throw new Error('pump.fun global account unreadable');
  const pk = (o) => b58encode(d.subarray(o, o + 32));
  const list = (o, n) => Array.from({ length: n }, (_, i) => pk(o + i * 32)).filter((k) => k !== SYSTEM);
  // ... reserved_fee_recipients[7] end at 740, is_cashback_enabled (1), buyback_fee_recipients[8] at 741.
  const buyback = d.length >= 1005 ? list(741, 8) : [];
  return { feeRecipients: [pk(41), ...list(162, 7)].filter((k) => k !== SYSTEM), reservedFeeRecipients: [pk(483), ...list(516, 7)].filter((k) => k !== SYSTEM), buybackFeeRecipients: buyback, feeBps: d.readBigUInt64LE(105), creatorFeeBps: d.readBigUInt64LE(154) };
}

/** Fee recipient for a buy: reserved list for mayhem-mode coins, normal list otherwise. */
export function pickFeeRecipient(global, mayhem) {
  const list = mayhem ? global.reservedFeeRecipients : global.feeRecipients;
  if (!list?.length) throw new Error('no pump.fun fee recipient available');
  return list[Math.floor(Math.random() * list.length)];
}

/** Buyback fee recipient: pump.fun now requires one as an extra (17th) account on every buy. */
export function pickBuybackRecipient(global) {
  const list = global.buybackFeeRecipients || [];
  return list.length ? list[Math.floor(Math.random() * list.length)] : null;
}

/** Token program the coin uses, from the program invocations in the transaction logs. */
export function tokenProgramFromLogs(logs) {
  return (logs || []).some((l) => l.startsWith(`Program ${TOKEN_2022} invoke`)) ? TOKEN_2022 : TOKEN;
}

/** Everything a local buy needs, from his buy's logs. Null when the logs lack a usable event. */
export function buyContextFromLogs(logs, leader, b58encode) {
  for (const l of logs || []) {
    if (!l.startsWith('Program data: ')) continue;
    const ev = decodeFullTradeEvent(l.slice(14).trim(), b58encode);
    if (ev && ev.isBuy && ev.user === leader) return { ...ev, tokenProgram: tokenProgramFromLogs(logs), at: Date.now() };
  }
  return null;
}

/** Tokens out for spending `lamports` on the curve state, after pump.fun's fees (rounded down). */
export function tokensOut({ vSol, vTok, feeBps = 95n, creatorFeeBps = 30n }, lamports) {
  const net = (BigInt(lamports) * 10000n) / (10000n + BigInt(feeBps) + BigInt(creatorFeeBps));
  return (BigInt(vTok) * net) / (BigInt(vSol) + net);
}

/** All 16 pump.fun accounts for buy_exact_sol_in, in IDL order. */
// Derived addresses never change: remember them (most are the same on every buy: global, event
// authority, fee config, your volume account; a coin's own are reused by its sell and by Decu's next buy).
const pdaMemo = new Map();
const memo = (key, f) => { let v = pdaMemo.get(key); if (v === undefined) { v = f(); pdaMemo.set(key, v); if (pdaMemo.size > 2000) pdaMemo.delete(pdaMemo.keys().next().value); } return v; };
export function buyAccounts({ user, mint, tokenProgram, creator, feeRecipient, buybackRecipient = null }, { findProgramAddress, ata: ata0 }) {
  const pda = (seeds, program = PUMP) => memo(program + ':' + seeds.map((x) => Buffer.from(x).toString('hex')).join(':'), () => findProgramAddress(seeds, program)[0]);
  const ata = (owner, m, prog) => memo(`ata:${owner}:${m}:${prog}`, () => ata0(owner, m, prog));
  const b = (s) => Buffer.from(s);
  const d = (k) => decode58(k);
  const bondingCurve = pda([b('bonding-curve'), d(mint)]);
  return [
    { k: pda([b('global')]), w: false },
    { k: feeRecipient, w: true },
    { k: mint, w: false },
    { k: bondingCurve, w: true },
    { k: ata(bondingCurve, mint, tokenProgram), w: true },
    { k: ata(user, mint, tokenProgram), w: true },
    { k: user, w: true, s: true },
    { k: SYSTEM, w: false },
    { k: tokenProgram, w: false },
    { k: pda([b('creator-vault'), d(creator)]), w: true },
    { k: pda([b('__event_authority')]), w: false },
    { k: PUMP, w: false },
    { k: pda([b('global_volume_accumulator')]), w: false },
    { k: pda([b('user_volume_accumulator'), d(user)]), w: true },
    { k: pda([b('fee_config'), FEE_CONFIG_SEED], FEE_PROGRAM), w: false },
    { k: FEE_PROGRAM, w: false },
    // Newer pump.fun accounts after the 16 in the IDL, matched against real successful
    // buy_exact_sol_in transactions (2026-10-11): the coin's bonding-curve-v2 PDA, then a buyback
    // fee recipient from the global account.
    { k: pda([b('bonding-curve-v2'), d(mint)]), w: false },
    ...(buybackRecipient ? [{ k: buybackRecipient, w: true }] : []),
  ];
}
let decode58 = null;

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
function shortVec(n) { const out = []; for (;;) { const byte = n & 0x7f; n >>= 7; if (!n) { out.push(byte); return Buffer.from(out); } out.push(byte | 0x80); } }

/** Compile instructions into an unsigned legacy transaction (one signature slot for the payer). */
export function compileLegacy(payer, instructions, blockhash, b58decode) {
  const meta = new Map([[payer, { s: true, w: true }]]);
  const touch = (k, s, w) => { const m = meta.get(k) || { s: false, w: false }; m.s ||= s; m.w ||= w; meta.set(k, m); };
  for (const ix of instructions) { for (const a of ix.accounts) touch(a.k, !!a.s, !!a.w); touch(ix.program, false, false); }
  const rank = ([, m]) => (m.s ? 0 : 2) + (m.w ? 0 : 1);
  const keys = [...meta].sort((a, b) => (a[0] === payer ? -1 : b[0] === payer ? 1 : rank(a) - rank(b))).map(([k]) => k);
  const signers = keys.filter((k) => meta.get(k).s);
  const roSigned = signers.filter((k) => !meta.get(k).w).length;
  const roUnsigned = keys.filter((k) => !meta.get(k).s && !meta.get(k).w).length;
  const index = new Map(keys.map((k, i) => [k, i]));
  const parts = [Buffer.from([signers.length, roSigned, roUnsigned]), shortVec(keys.length), ...keys.map((k) => Buffer.from(b58decode(k))), Buffer.from(b58decode(blockhash)), shortVec(instructions.length)];
  for (const ix of instructions) parts.push(Buffer.from([index.get(ix.program)]), shortVec(ix.accounts.length), Buffer.from(ix.accounts.map((a) => index.get(a.k))), shortVec(ix.data.length), ix.data);
  const message = Buffer.concat(parts);
  return Buffer.concat([shortVec(signers.length), Buffer.alloc(64 * signers.length), message]);
}

/**
 * Unsigned buy transaction: compute budget, create the token account if missing, buy_exact_sol_in,
 * optional tip. `ctx` comes from buyContextFromLogs (or the chain). minTokensOut = expected tokens
 * on his post-trade curve state reduced by slippagePct.
 */
export function buildBuyTransaction({ user, ctx, lamports, slippagePct, minTokensFloor = 0n, blockhash, cuLimit = 120_000, priorityLamports = 500_000, tipAccount = null, tipLamports = 0 }, h) {
  decode58 = h.b58decode;
  const expected = tokensOut(ctx, lamports);
  const slipOut = (expected * BigInt(Math.round((100 - slippagePct) * 100))) / 10000n;
  const minOut = slipOut > BigInt(minTokensFloor) ? slipOut : BigInt(minTokensFloor); // stricter of slippage and max-pay
  if (minOut <= 0n) throw new Error('local build: curve state gives no tokens');
  const accounts = buyAccounts({ user, mint: ctx.mint, tokenProgram: ctx.tokenProgram, creator: ctx.creator, feeRecipient: ctx.feeRecipient, buybackRecipient: ctx.buybackRecipient }, h);
  const microLamportsPerCu = BigInt(Math.floor((priorityLamports * 1e6) / cuLimit));
  const ixs = [
    { program: COMPUTE_BUDGET, accounts: [], data: Buffer.concat([Buffer.from([2]), u32(cuLimit)]) },
    { program: COMPUTE_BUDGET, accounts: [], data: Buffer.concat([Buffer.from([3]), u64(microLamportsPerCu)]) },
    { program: ATA_PROGRAM, accounts: [{ k: user, w: true, s: true }, { k: accounts[5].k, w: true }, { k: user }, { k: ctx.mint }, { k: SYSTEM }, { k: ctx.tokenProgram }], data: Buffer.from([1]) },
    { program: PUMP, accounts, data: Buffer.concat([BUY_EXACT_SOL_IN, u64(lamports), u64(minOut), Buffer.from([1])]) },
  ];
  if (tipAccount && tipLamports > 0) ixs.push({ program: SYSTEM, accounts: [{ k: user, w: true, s: true }, { k: tipAccount, w: true }], data: Buffer.concat([u32(2), u64(tipLamports)]) });
  return { bytes: compileLegacy(user, ixs, blockhash, h.b58decode), expectedTokens: expected, minTokensOut: minOut };
}

/** Keeps a recent blockhash ready so a buy never waits for one. */
export function startBlockhashCache(rpc, { intervalMs = 2000, log = () => {} } = {}) {
  const state = { blockhash: null, at: 0 };
  let stopped = false, timer;
  const tick = async () => {
    try { const r = await rpc('getLatestBlockhash', [{ commitment: 'confirmed' }], 4000); state.blockhash = r?.value?.blockhash || state.blockhash; state.at = Date.now(); }
    catch (e) { log('blockhash refresh failed: ' + e.message); }
    if (!stopped) { timer = setTimeout(tick, intervalMs); timer.unref?.(); }
  };
  tick();
  return { get: () => (state.blockhash && Date.now() - state.at < 30_000 ? state.blockhash : null), stop: () => { stopped = true; clearTimeout(timer); } };
}

export const _test = { crypto };
