// LOCAL PUMP.FUN BUY + SELL BUILDER: builds the trades inside the bot instead of asking PumpPortal's
// server, so neither a buy nor a sell needs a web round trip before its safety simulation.
//
// Everything comes from Decu's own trade event in the websocket logs (creator, fee recipient,
// reserves after his buy, token program) plus a blockhash the bot keeps fresh in the background.
// Buy: pump.fun `buy_exact_sol_in` (spend exactly X SOL, receive at least N tokens). Sell: `sell`
// (sell exactly N tokens, receive at least X SOL). Accounts, arguments and the extra accounts after the
// IDL list follow pump.fun's own SDK (@pump-fun/pump-sdk 4.1.0, npm, 2026-10-13) and its IDL.
// Bonding-curve coins quoted in SOL only; graduated (PumpSwap) and token-quoted coins use PumpPortal.

import crypto from 'node:crypto';

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const FEE_PROGRAM = 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ';
export const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM = '11111111111111111111111111111111';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const BUY_EXACT_SOL_IN = Buffer.from('38fc74089edfcd5f', 'hex');
const SELL = Buffer.from('33e685a4017f83ad', 'hex');
export const WSOL = 'So11111111111111111111111111111111111111112';
// Used only when the pump.fun Global account can't be read (pump-sdk 4.1.0: CURRENT_FEE_RECIPIENTS and
// CURRENT_FEE_RECIPIENTS_FOR_BUYBACK, "same keys, same order as Global.buybackFeeRecipients on mainnet").
export const STATIC_FEE_RECIPIENTS = ['62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV', '7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ', '7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX', '9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz', 'AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY', 'CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM', 'FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz', 'G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP'];
export const STATIC_BUYBACK_RECIPIENTS = ['5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD', '9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7', 'GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL', '3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR', '5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6', 'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL', '5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD', 'A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW'];
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
  const list = global?.buybackFeeRecipients?.length ? global.buybackFeeRecipients : STATIC_BUYBACK_RECIPIENTS;
  return list[Math.floor(Math.random() * list.length)];
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

// Derived addresses never change: remember them (most are the same on every trade: global, event
// authority, fee config, your volume account; a coin's own are shared by its buy, its sell and Decu's next buy).
const pdaMemo = new Map();
const memo = (key, f) => { let v = pdaMemo.get(key); if (v === undefined) { v = f(); pdaMemo.set(key, v); if (pdaMemo.size > 4000) pdaMemo.delete(pdaMemo.keys().next().value); } return v; };
function addresses({ findProgramAddress, ata: ata0, b58decode }) {
  const dec = b58decode || decode58;
  return {
    pda: (seeds, program = PUMP) => memo(program + ':' + seeds.map((x) => Buffer.from(x).toString('hex')).join(':'), () => findProgramAddress(seeds, program)[0]),
    ata: (owner, m, prog) => memo(`ata:${owner}:${m}:${prog}`, () => ata0(owner, m, prog)),
    b: (x) => Buffer.from(x),
    d: (k) => dec(k),
  };
}
/** All 16 pump.fun accounts for buy_exact_sol_in, in IDL order, then the 2 extra accounts. */
export function buyAccounts({ user, mint, tokenProgram, creator, feeRecipient, buybackRecipient = null }, h) {
  const { pda, ata, b, d } = addresses(h);
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
    // buy_exact_sol_in transactions (2026-10-11) and pump-sdk 4.1.0: the coin's bonding-curve-v2 PDA,
    // then a buyback fee recipient from the global account.
    { k: pda([b('bonding-curve-v2'), d(mint)]), w: false },
    ...(buybackRecipient ? [{ k: buybackRecipient, w: true }] : []),
  ];
}

/**
 * pump.fun `sell`: the 14 IDL accounts in IDL order (creator_vault BEFORE token_program, unlike buy),
 * then the remaining accounts exactly as pump-sdk 4.1.0 adds them: a cashback coin first adds the user's
 * volume accumulator (writable); always the coin's bonding-curve-v2 (read-only) and a buyback fee
 * recipient (writable).
 */
export function sellAccounts({ user, mint, tokenProgram, creator, feeRecipient, buybackRecipient, cashback = false }, h) {
  const { pda, ata, b, d } = addresses(h);
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
    { k: pda([b('creator-vault'), d(creator)]), w: true },
    { k: tokenProgram, w: false },
    { k: pda([b('__event_authority')]), w: false },
    { k: PUMP, w: false },
    { k: pda([b('fee_config'), FEE_CONFIG_SEED], FEE_PROGRAM), w: false },
    { k: FEE_PROGRAM, w: false },
    ...(cashback ? [{ k: pda([b('user_volume_accumulator'), d(user)]), w: true }] : []),
    { k: pda([b('bonding-curve-v2'), d(mint)]), w: false },
    { k: buybackRecipient, w: true },
  ];
}

/** A coin's bonding curve account (IDL layout, pump-sdk 4.1.0): reserves, complete, creator, mayhem / cashback flags, quote mint. */
export function decodeBondingCurve(data, b58encode) {
  let b;
  try { b = Buffer.isBuffer(data) ? data : Buffer.from(data, 'base64'); } catch { return null; }
  if (b.length < 49) return null;
  const u = (o) => b.readBigUInt64LE(o);
  const out = { vTok: u(8), vSol: u(16), realTok: u(24), realSol: u(32), supply: u(40), complete: b[48] === 1 };
  if (b.length >= 81) out.creator = b58encode(b.subarray(49, 81));
  // an older, shorter curve account has no flag bytes: not mayhem, not cashback
  out.mayhem = b.length >= 82 && b[81] === 1; out.cashback = b.length >= 83 && b[82] === 1;
  // SOL coins store an all-zero quote mint (pump-sdk normalizeQuoteMint); anything else is token-quoted.
  if (b.length >= 115) { const q = b.subarray(83, 115); out.quoteMint = q.every((x) => x === 0) ? null : b58encode(q); }
  return out;
}
export const quotedInSol = (c) => !c?.quoteMint || c.quoteMint === WSOL;

/** Lamports out for selling `raw` tokens on this curve state, after the protocol and creator fees
 *  (each rounded up, as the program does). */
export function solOut({ vSol, vTok, feeBps = 95n, creatorFeeBps = 30n }, raw) {
  const r = BigInt(raw);
  if (r <= 0n || BigInt(vTok) <= 0n) return 0n;
  const gross = (BigInt(vSol) * r) / (BigInt(vTok) + r);
  const fee = (x, bps) => (x * BigInt(bps) + 9999n) / 10000n;
  const net = gross - fee(gross, feeBps) - fee(gross, creatorFeeBps);
  return net > 0n ? net : 0n;
}

/** Token amount from a token account's data (SPL Token and Token-2022 share the base layout); 0 when closed. */
export function tokenAccountAmount(data) {
  let b;
  try { b = Buffer.isBuffer(data) ? data : Buffer.from(data || '', 'base64'); } catch { return 0n; }
  return b.length >= 72 ? b.readBigUInt64LE(64) : 0n;
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
    // args: spendable_sol_in, min_tokens_out, track_volume (OptionBool = true), partial_fill (OptionBool =
    // false: all or nothing). partial_fill was added to the IDL after 2026-10-11; a program without it
    // ignores the extra byte.
    { program: PUMP, accounts, data: Buffer.concat([BUY_EXACT_SOL_IN, u64(lamports), u64(minOut), Buffer.from([1, 0])]) },
  ];
  if (tipAccount && tipLamports > 0) ixs.push({ program: SYSTEM, accounts: [{ k: user, w: true, s: true }, { k: tipAccount, w: true }], data: Buffer.concat([u32(2), u64(tipLamports)]) });
  return { bytes: compileLegacy(user, ixs, blockhash, h.b58decode), expectedTokens: expected, minTokensOut: minOut };
}

/**
 * Unsigned sell: compute budget, `sell(amount, min_sol_output)`, then (closeAccount) close the token
 * account so its rent (~0.002 SOL) comes back to the wallet, then the optional tip. Close only when the
 * sell empties the account: closing a non-empty account would fail the whole transaction.
 */
export function buildSellTransaction({ user, kit, raw, minSolOut, blockhash, cuLimit = 100_000, priorityLamports = 500_000, tipAccount = null, tipLamports = 0, closeAccount = false }, h) {
  if (!(BigInt(raw) > 0n)) throw new Error('local sell: nothing to sell');
  const accounts = sellAccounts({ user, mint: kit.mint, tokenProgram: kit.tokenProgram, creator: kit.creator, feeRecipient: kit.feeRecipient, buybackRecipient: kit.buybackRecipient, cashback: !!kit.cashback }, h);
  const microLamportsPerCu = BigInt(Math.floor((priorityLamports * 1e6) / cuLimit));
  const ixs = [
    { program: COMPUTE_BUDGET, accounts: [], data: Buffer.concat([Buffer.from([2]), u32(cuLimit)]) },
    { program: COMPUTE_BUDGET, accounts: [], data: Buffer.concat([Buffer.from([3]), u64(microLamportsPerCu)]) },
    { program: PUMP, accounts, data: Buffer.concat([SELL, u64(raw), u64(minSolOut)]) },
  ];
  // SPL / Token-2022 CloseAccount (9): [account, destination, owner]; the rent goes back to the wallet.
  if (closeAccount) ixs.push({ program: kit.tokenProgram, accounts: [{ k: accounts[5].k, w: true }, { k: user, w: true }, { k: user, s: true }], data: Buffer.from([9]) });
  if (tipAccount && tipLamports > 0) ixs.push({ program: SYSTEM, accounts: [{ k: user, w: true, s: true }, { k: tipAccount, w: true }], data: Buffer.concat([u32(2), u64(tipLamports)]) });
  return { bytes: compileLegacy(user, ixs, blockhash, h.b58decode), accounts };
}

/**
 * THE SELL DESK: one per bot, alive for the whole run (never rebuilt per trade).
 * A coin is ARMED the moment the bot buys it, from the same trade context the local buy used (token
 * program, creator, mayhem / cashback, fees), and every address its sell needs is worked out then.
 * While the coin is held, the pushed bonding-curve state keeps its price current and (live) the wallet's
 * token balance is pushed too, so a sell needs no network at all before the safety simulation.
 * A coin is disarmed only when it is fully sold.
 */
export function createSellDesk({ helpers, watchAccount = null, now = () => Date.now() } = {}) {
  const kits = new Map();
  const stats = { armed: 0, builds: 0, lastBuildMs: null, closes: 0, fallbacks: 0, lastError: null };
  const has = (v) => v !== undefined && v !== null;
  function arm(mint, info = {}) {
    const k = kits.get(mint) || { mint, armedAt: now() };
    if (!kits.has(mint)) stats.armed++;
    for (const key of ['tokenProgram', 'creator', 'mayhem', 'cashback', 'quoteMint', 'feeBps', 'creatorFeeBps', 'user', 'decimals']) if (has(info[key])) k[key] = info[key];
    // a re-arm (a second buy of a held coin) never replaces a newer pushed price with an older one
    const at = info.curveAt ?? now();
    if (info.curve && !(k.curve && (k.curveAt || 0) > at)) { k.curve = info.curve; k.curveAt = at; }
    kits.set(mint, k);
    // Work every address out now (sell accounts with a placeholder recipient), so the sell itself is pure assembly.
    if (k.user && k.tokenProgram && k.creator && helpers) {
      const acc = sellAccounts({ user: k.user, mint, tokenProgram: k.tokenProgram, creator: k.creator, feeRecipient: STATIC_FEE_RECIPIENTS[0], buybackRecipient: STATIC_BUYBACK_RECIPIENTS[0], cashback: !!k.cashback }, helpers);
      k.userAta = acc[5].k;
      if (watchAccount && !k.unwatchAta) {
        try { k.unwatchAta = watchAccount(k.userAta, (b64, at) => { k.tokenBalance = tokenAccountAmount(b64); k.tokenBalanceAt = at ?? now(); }); } catch { k.unwatchAta = null; }
      }
    }
    return k;
  }
  /** A newer curve state (pushed over the websocket, or read): price, creator and flags. */
  function update(mint, curve, at) {
    const k = kits.get(mint); if (!k || !curve) return;
    k.curve = curve; k.curveAt = at ?? now();
    for (const key of ['creator', 'mayhem', 'cashback']) if (has(curve[key])) k[key] = curve[key];
    if ('quoteMint' in curve) k.quoteMint = curve.quoteMint;
  }
  /** The wallet's pushed token balance, when its subscription is live and the value current. */
  function balance(mint, maxAgeMs = 600_000) {
    const k = kits.get(mint);
    if (!k || k.tokenBalance == null || !k.unwatchAta?.ready?.() || now() - (k.tokenBalanceAt || 0) > maxAgeMs) return null;
    // pushed before the subscription was last re-made (a websocket reconnect): a change may have been missed
    const since = k.unwatchAta.readyAt?.();
    if (since != null && (k.tokenBalanceAt || 0) < since) return null;
    return k.tokenBalance;
  }
  /** Drop the pushed balance (a sell failed): the next sell reads the chain. */
  function forgetBalance(mint) { const k = kits.get(mint); if (k) { k.tokenBalance = null; k.tokenBalanceAt = 0; } }
  /** Why this coin can't be sold locally right now (null = ready). */
  function blocker(mint, { curveMaxAgeMs = 3000, needFlags = true } = {}) {
    const k = kits.get(mint);
    if (!k) return 'not armed';
    if (!k.tokenProgram || !k.creator || !k.user) return 'kit incomplete';
    if (!k.curve) return 'no curve state';
    // his trade event doesn't say whether it is a cashback coin (its sell needs one more account): the
    // curve does, from the first push or one read
    if (needFlags && k.cashback == null) return 'curve flags unknown';
    if (k.curve.complete) return 'coin left the curve (PumpSwap)';
    if (!quotedInSol(k)) return 'coin is not quoted in SOL';
    if (now() - (k.curveAt || 0) > curveMaxAgeMs) return 'curve state too old';
    return null;
  }
  /**
   * Build (unsigned) the sell of `raw` tokens: min SOL out = the current curve's SOL out less slippagePct.
   * global: the pump.fun Global account (fee and buyback recipients); without it only non-mayhem coins.
   */
  function build({ mint, raw, slippagePct, blockhash, priorityLamports, tipAccount = null, tipLamports = 0, closeAccount = false, global = null, cuLimit, unknownFlagsOk = false }) {
    const t0 = performance.now();
    const k = kits.get(mint);
    const why = blocker(mint, { curveMaxAgeMs: Infinity, needFlags: !unknownFlagsOk });
    if (why) throw new Error('local sell: ' + why);
    if (k.mayhem && !global?.reservedFeeRecipients?.length) throw new Error('local sell: mayhem coin needs the reserved fee recipients (global not read)');
    const feeRecipient = global ? pickFeeRecipient(global, !!k.mayhem) : STATIC_FEE_RECIPIENTS[Math.floor(Math.random() * STATIC_FEE_RECIPIENTS.length)];
    const buybackRecipient = pickBuybackRecipient(global);
    const expected = solOut({ vSol: k.curve.vSol, vTok: k.curve.vTok, feeBps: k.feeBps ?? global?.feeBps ?? 95n, creatorFeeBps: k.creatorFeeBps ?? global?.creatorFeeBps ?? 30n }, raw);
    const minSolOut = (expected * BigInt(Math.round((100 - slippagePct) * 100))) / 10000n;
    const out = buildSellTransaction({ user: k.user, kit: { ...k, feeRecipient, buybackRecipient }, raw, minSolOut, blockhash, priorityLamports, tipAccount, tipLamports, closeAccount, ...(cuLimit ? { cuLimit } : {}) }, helpers);
    stats.builds++; stats.lastBuildMs = Math.round((performance.now() - t0) * 1000) / 1000;
    return { ...out, expectedLamports: expected, minSolOut, feeRecipient, buybackRecipient, curveAgeMs: now() - (k.curveAt || 0) };
  }
  function disarm(mint) { const k = kits.get(mint); if (!k) return; try { k.unwatchAta?.(); } catch {} kits.delete(mint); }
  return {
    arm, update, balance, forgetBalance, blocker, build, disarm, stats,
    kit: (mint) => kits.get(mint) || null,
    size: () => kits.size,
    stop: () => { for (const m of [...kits.keys()]) disarm(m); },
    snapshot: () => ({ ...stats, holding: kits.size }),
  };
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
