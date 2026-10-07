// Decu copier v2: protocol utilities. engine.mjs owns durable execution; runtime.mjs owns monitoring.
// Usage:  node copybot.mjs            run the bot
//         node copybot.mjs check      self-test (no trades)
//         node copybot.mjs backtest --date YYYY-MM-DD --wallet 100
//         node copybot.mjs export --days 7
//         node copybot.mjs diagnose   Helius vs Solscan health, parser cross-check, leader profile
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import nodeHttp from 'node:http';
import {pathToFileURL} from 'node:url';
import {startRuntime,normalize} from './runtime.mjs';
import {solscanClient,startSolscanWatcher,swapsFromActivities,leaderProfile,compareDetection} from './solscan.mjs';

// ===== solana.js =====
// Dependency-free Solana helpers: base58, program-derived addresses (PDA),
// associated token accounts, and small binary readers.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const MAP = new Map([...ALPHABET].map((c, i) => [c, BigInt(i)]));

function b58decode(str) {
  if (typeof str !== 'string' || !str) throw new Error('empty base58');
  let n = 0n;
  for (const ch of str) {
    const v = MAP.get(ch);
    if (v === undefined) throw new Error('invalid base58 char');
    n = n * 58n + v;
  }
  const bytes = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const ch of str) {
    if (ch === '1') bytes.push(0);
    else break;
  }
  return Uint8Array.from(bytes.reverse());
}

function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = ALPHABET[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b === 0) s = '1' + s;
    else break;
  }
  return s;
}

function isValidPubkey(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44) return false;
  try {
    return b58decode(s).length === 32;
  } catch {
    return false;
  }
}

// ---- ed25519 "is this 32-byte value a point on the curve?" (needed for PDA derivation)
const P = 2n ** 255n - 19n;
const D = (-121665n * modInv(121666n)) % P;
function mod(a) {
  const r = a % P;
  return r >= 0n ? r : r + P;
}
function modPow(b, e) {
  let r = 1n;
  b = mod(b);
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
function modInv(a) {
  return modPow(((a % P) + P) % P, P - 2n);
}
function isOnCurve(bytes) {
  const b = Uint8Array.from(bytes);
  b[31] &= 0x7f; // drop sign bit of x
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(b[i]);
  if (y >= P) return false;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  // x^2 = u / v ; a square root exists iff (u/v)^((p-1)/2) is 0 or 1
  const x2 = mod(u * modInv(v));
  if (x2 === 0n) return true;
  return modPow(x2, (P - 1n) / 2n) === 1n;
}

const PDA_MARKER = Buffer.from('ProgramDerivedAddress');

function createProgramAddress(seeds, programId) {
  const h = crypto.createHash('sha256');
  for (const s of seeds) h.update(Buffer.from(s));
  h.update(Buffer.from(b58decode(programId)));
  h.update(PDA_MARKER);
  const out = h.digest();
  if (isOnCurve(out)) return null;
  return b58encode(out);
}

function findProgramAddress(seeds, programId) {
  for (let bump = 255; bump >= 0; bump--) {
    const addr = createProgramAddress([...seeds, Uint8Array.of(bump)], programId);
    if (addr) return [addr, bump];
  }
  throw new Error('no viable bump');
}

const PROGRAMS = {
  PUMP: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  PUMP_AMM: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  TOKEN: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  TOKEN_2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  ATA: 'ATokenGPvbdGVxr1b2hvZbsiqW4xWH25efTNsLJA8knL',
  METAPLEX: 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bmuk5f8mm',
  SYSTEM: '11111111111111111111111111111111',
};

const WSOL = 'So11111111111111111111111111111111111111112';

function bondingCurvePda(mint) {
  return findProgramAddress([Buffer.from('bonding-curve'), b58decode(mint)], PROGRAMS.PUMP)[0];
}

function associatedTokenAddress(owner, mint, tokenProgram = PROGRAMS.TOKEN) {
  return findProgramAddress([b58decode(owner), b58decode(tokenProgram), b58decode(mint)], PROGRAMS.ATA)[0];
}

function metaplexMetadataPda(mint) {
  return findProgramAddress([Buffer.from('metadata'), b58decode(PROGRAMS.METAPLEX), b58decode(mint)], PROGRAMS.METAPLEX)[0];
}

// Well-known non-wallet owners (so they are not counted as "whales").
const KNOWN_OWNERS = {
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1': 'Raydium AMM v4 authority',
  GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL: 'Raydium CPMM authority',
  '1nc1nerator11111111111111111111111111111111': 'Burn (incinerator)',
  [PROGRAMS.PUMP_AMM]: 'PumpSwap program',
};

/** Little-endian reader over a Buffer. */
class Reader {
  constructor(buf, off = 0) {
    this.buf = buf;
    this.off = off;
  }
  u8() {
    return this.buf.readUInt8(this.off++);
  }
  bool() {
    return this.u8() !== 0;
  }
  u16() {
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }
  u32() {
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  u64() {
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }
  pubkey() {
    const v = b58encode(this.buf.subarray(this.off, this.off + 32));
    this.off += 32;
    return v;
  }
  string() {
    const len = this.u32();
    const s = this.buf.subarray(this.off, this.off + len).toString('utf8').replace(/\0+$/, '');
    this.off += len;
    return s;
  }
  remaining() {
    return this.buf.length - this.off;
  }
}


// ===== config.js =====
// All settings come from environment variables (or a local .env file).

function loadDotEnv(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    else val = val.replace(/\s+#.*$/, '').trim();
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv(path.resolve(process.cwd(), '.env'));

const env = (k, d = '') => (process.env[k] ?? d).toString().trim();
const num = (k, d) => {
  const v = env(k);
  const n = Number(v);
  return v !== '' && Number.isFinite(n) ? n : d;
};
const bool = (k, d) => {
  const v = env(k).toLowerCase();
  return v ? ['1', 'true', 'yes', 'on'].includes(v) : d;
};

const helius = env('HELIUS_API_KEY');
const rpcUrl = env('RPC_URL') || (helius ? `https://mainnet.helius-rpc.com/?api-key=${helius}` : 'https://api.mainnet-beta.solana.com');
const wsUrl = env('WS_URL') || (helius ? `wss://mainnet.helius-rpc.com/?api-key=${helius}` : rpcUrl.replace(/^http/, 'ws'));

const config = {
  // Whose buys to copy. Default: Decu (@notdecu), wallet he published himself on X.
  leader: env('LEADER_WALLET', '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9'),
  leaderLabel: env('LEADER_LABEL', 'Decu'),

  // Your dedicated burner wallet's private key (base58 export from Phantom/Solflare, or a [..64 numbers] JSON array).
  privateKey: env('PRIVATE_KEY'),

  // SAFETY: starts in dry-run (alerts only, no trades) until you set DRY_RUN=false.
  dryRun: bool('DRY_RUN', true),

  buySol: num('BUY_SOL', 0.1),
  minLeaderBuyUsd: num('MIN_LEADER_BUY_USD', 50), // also how small trades (his ~$3 test buys) are ignored
  pumpOnly: bool('PUMP_ONLY', true), // only copy pump.fun coins (bonding curve or PumpSwap); skip xStocks, other launchpads
  oneBuyPerMint: bool('ONE_BUY_PER_MINT', true),
  dailyCapSol: num('DAILY_CAP_SOL', 1),
  minSolReserve: num('MIN_SOL_RESERVE', 0.02), // never spend below this (fees, rent)
  slippagePct: num('SLIPPAGE_PCT', 20),
  priorityFeeSol: num('PRIORITY_FEE_SOL', 0.0005),
  maxSignalAgeSec: num('MAX_SIGNAL_AGE_SEC', 30), // ignore leader buys older than this
  executor: env('EXECUTOR', 'pumpportal'), // pumpportal | jupiter
  simulate: bool('SIMULATE_BEFORE_SEND', true), // dry-run each tx first; refuse if it would take more SOL than expected
  solPriceFallback: num('SOL_PRICE_FALLBACK', 150), // only used if every price source is down
  jupiterApiKey: env('JUPITER_API_KEY'),
  timezone: env('TIMEZONE', 'America/New_York'), // when the daily cap resets (midnight here)

  rpcUrl,
  wsUrl,
  rpcIsPublic: !env('RPC_URL') && !helius,
  pollIntervalMs: num('POLL_INTERVAL_MS', 5000), // backup polling in case the websocket drops
  // Fast landing: Helius Sender (sends to validators + Jito at once). Needs a tip in every buy.
  tipSol: num('TIP_SOL', 0.001), // 0 = no tip, normal send only. Helius minimum for Sender is 0.001 SOL
  senderUrl: env('SENDER_URL', 'https://sender.helius-rpc.com/fast'), // or a regional one, e.g. http://slc-sender.helius-rpc.com/fast
  prebuild: bool('PREBUILD', true), // start building the buy the instant his trade is seen, while the rules are checked
  sendRpcUrls: env('SEND_RPC_URLS').split(',').map((x) => x.trim()).filter(Boolean), // extra RPCs to broadcast buys through
  rebroadcast: bool('REBROADCAST', true), // re-send the same signed tx a few times while waiting (better landing)
  fastPath: bool('FAST_PATH', true), // act on pump.fun buys straight from live logs (fastest)
  heliusKey: helius,
  // Solscan Pro API (v2): independent second watcher, parser cross-check, token names, SOL price.
  solscanKey: env('SOLSCAN_API_KEY'),
  solscanPollMs: num('SOLSCAN_POLL_MS', 10000), // 0 = no Solscan watcher

  ntfyTopic: env('NTFY_TOPIC'),
  ntfyServer: env('NTFY_SERVER', 'https://ntfy.sh'),
  notifySkips: bool('NOTIFY_SKIPS', true), // also alert when a buy is skipped (cap hit, too small...)
  alertLeaderSells: bool('ALERT_LEADER_SELLS', true), // phone alert when he sells a coin the bot copied (bot still never sells)

  // PAPER TRADING: in DRY_RUN the bot pretend-trades at real on-chain prices (no transactions ever sent).
  paper: bool('PAPER', true),
  paperLandMs: num('PAPER_LAND_MS', 1000), // when a real buy would land after his trade is seen
  paperExitDelays: env('PAPER_EXIT_DELAYS', '0,5,10,30').split(',').map(Number).filter((x) => x >= 0), // seconds after his sell
  paperMainDelay: num('PAPER_MAIN_DELAY', 10), // the delay used in alerts (how fast you sell by hand)
  paperQuickSec: env('PAPER_QUICK_SELL_SEC', '4,5').split(',').map(Number).filter((x) => x > 0), // also value a sell this many s after YOUR buy
  paperMaxHoldMin: num('PAPER_MAX_HOLD_MIN', 30), // value positions he never sold after this long
  notifyPaper: bool('NOTIFY_PAPER', true),
  pumpFeePct: num('PUMP_FEE_PCT', 1.25), // pool fee per side used for paper prices
  paperFile: env('PAPER_FILE', path.resolve(process.cwd(), 'paper.json')),

  stateFile: env('STATE_FILE', path.resolve(process.cwd(), 'state.json')),
  logFile: env('LOG_FILE', path.resolve(process.cwd(), 'trades.log')),
};

function validateConfig(c = config) {
  const errors = [];
  if (!isValidPubkey(c.leader)) errors.push('LEADER_WALLET is not a valid Solana address');
  if (!c.dryRun && !c.privateKey) errors.push('PRIVATE_KEY is required when DRY_RUN=false');
  if (!(c.buySol > 0)) errors.push('BUY_SOL must be > 0');
  if (!(c.dailyCapSol >= c.buySol)) errors.push('DAILY_CAP_SOL must be >= BUY_SOL');
  if (!(c.slippagePct > 0 && c.slippagePct <= 50)) errors.push('SLIPPAGE_PCT must be between 0 and 50');
  if (!(c.tipSol >= 0 && c.tipSol <= 0.01)) errors.push('TIP_SOL must be between 0 and 0.01');
  if (c.tipSol > 0 && c.tipSol < 0.001) errors.push('TIP_SOL below 0.001 is rejected by Helius Sender (use 0 for no tip)');
  if (!['pumpportal', 'jupiter'].includes(c.executor)) errors.push('EXECUTOR must be pumpportal or jupiter');
  if (c.executor === 'jupiter' && !c.jupiterApiKey) errors.push('EXECUTOR=jupiter needs JUPITER_API_KEY');
  return errors;
}

const redact = (s) => String(s).replace(/(api[-_]?key=)[^&\s"]+/gi, '$1***');


// ===== rpc.js =====
// Solana JSON-RPC over HTTPS, plus a small fetch helper with timeouts.

let mock = null;
const setFetch = (fn) => (mock = fn); // tests

async function http(url, { method = 'GET', headers = {}, body, timeoutMs = 10000, raw = false } = {}) {
  const init = { method, headers: { accept: raw ? '*/*' : 'application/json', ...headers } };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    init.headers['content-type'] = 'application/json';
  }
  const f = mock || fetch;
  let res;
  try {
    res = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new Error(redact(`${new URL(url).host}: ${e.name === 'TimeoutError' ? 'timed out' : e.message}`));
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      /* ignore */
    }
    throw new Error(redact(`${new URL(url).host}: HTTP ${res.status} ${detail}`));
  }
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

let id = 1;
async function rpc(method, params, timeoutMs = 10000) {
  const r = await http(config.rpcUrl, { method: 'POST', body: { jsonrpc: '2.0', id: id++, method, params }, timeoutMs });
  if (r.error) throw new Error(`RPC ${method}: ${r.error.message || JSON.stringify(r.error)}`.slice(0, 240));
  return r.result;
}

const solscan = solscanClient({ apiKey: config.solscanKey, http: (...a) => http(...a) });

const getBalanceSol = async (pubkey) => (await rpc('getBalance', [pubkey, { commitment: 'confirmed' }])).value / 1e9;

// The leader's trades are version-1 transactions (checked on Helius 2026-10-07). Asking for
// version 0 makes the RPC reject every one of them, so the bot would never see a trade.
const MAX_TX_VERSION = num('MAX_TX_VERSION', 1);

async function getTransaction(sig, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const tx = await rpc('getTransaction', [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: MAX_TX_VERSION }]);
    if (tx) return tx;
    await new Promise((r) => setTimeout(r, 350));
  }
  return null;
}

/** Broadcast through the main RPC and every SEND_RPC_URLS endpoint at once; first success wins. */
async function sendRaw(bytes, extraUrls = []) {
  const params = [Buffer.from(bytes).toString('base64'), { encoding: 'base64', skipPreflight: true, maxRetries: 0 }];
  const urls = [...extraUrls.filter(Boolean), config.rpcUrl, ...config.sendRpcUrls]; // Sender first when tipping
  const attempts = urls.map(async (url) => {
    const r = await http(url, { method: 'POST', body: { jsonrpc: '2.0', id: id++, method: 'sendTransaction', params }, timeoutMs: 5000 });
    if (r.error) throw new Error(`sendTransaction: ${r.error.message}`);
    return r.result;
  });
  const first = await Promise.any(attempts).catch((e) => {
    throw new Error(e.errors?.[0]?.message || e.message);
  });
  // Re-broadcast a few times while waiting (helps landing under congestion; same signature, can't double-buy).
  if (config.rebroadcast) for (const delay of [400, 1000, 2000]) setTimeout(() => urls.forEach((url) => http(url, { method: 'POST', body: { jsonrpc: '2.0', id: id++, method: 'sendTransaction', params }, timeoutMs: 4000 }).catch(() => {})), delay);
  return first;
}

/** Poll until confirmed / failed / timeout. Returns {ok, err}. */
async function confirm(sig, timeoutMs = 45000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const r = await rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: false }]).catch(() => null);
    const st = r?.value?.[0];
    if (st?.err) return { ok: false, err: `failed on-chain: ${JSON.stringify(st.err)}`, landedFailed: true };
    if (st && ['confirmed', 'finalized'].includes(st.confirmationStatus)) return { ok: true };
    await new Promise((res) => setTimeout(res, 800));
  }
  return { ok: false, err: 'not confirmed in time (may still land, check Solscan)' };
}


// ===== wallet.js =====
// Keypair loading and transaction signing with Node's built-in ed25519 (no Solana SDK needed).

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function loadKeypair(secret) {
  const s = String(secret || '').trim();
  if (!s) throw new Error('empty private key');
  let bytes;
  if (s.startsWith('[')) bytes = Uint8Array.from(JSON.parse(s));
  else bytes = b58decode(s);
  if (bytes.length !== 64 && bytes.length !== 32) throw new Error(`private key must be 64 bytes (got ${bytes.length})`);
  const seed = Buffer.from(bytes.subarray(0, 32));
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const pubRaw = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
  const publicKey = b58encode(pubRaw);
  if (bytes.length === 64 && b58encode(bytes.subarray(32)) !== publicKey) throw new Error('private key is corrupted (public half does not match)');
  return {
    publicKey,
    sign: (msg) => crypto.sign(null, Buffer.from(msg), privateKey),
  };
}

// ---- minimal transaction wire format (legacy + v0) ----
function readShortVec(buf, off) {
  let len = 0;
  let size = 0;
  for (;;) {
    const b = buf[off + size];
    len |= (b & 0x7f) << (7 * size);
    size++;
    if ((b & 0x80) === 0) break;
  }
  return [len, size];
}

function parseTransaction(raw) {
  const buf = Buffer.from(raw);
  const [nSig, sz] = readShortVec(buf, 0);
  const sigStart = sz;
  const msgStart = sigStart + nSig * 64;
  const message = buf.subarray(msgStart);
  let o = 0;
  const versioned = (message[0] & 0x80) !== 0;
  // This parser (used for signing, tipping and the safety check) knows the legacy and v0 layouts.
  // Refuse anything newer rather than mis-read it.
  if (versioned && (message[0] & 0x7f) !== 0) throw new Error(`unsupported transaction version ${message[0] & 0x7f} from builder: refusing to sign`);
  if (versioned) o = 1;
  const numRequiredSignatures = message[o];
  o += 3; // header: required sigs, readonly signed, readonly unsigned
  const [nKeys, ksz] = readShortVec(message, o);
  o += ksz;
  const keys = [];
  for (let i = 0; i < nKeys; i++) keys.push(b58encode(message.subarray(o + i * 32, o + (i + 1) * 32)));
  return { buf, nSig, sigStart, message, keys, numRequiredSignatures, versioned };
}

/** Sign `raw` (unsigned or partially signed tx bytes) for `kp`; returns signed bytes + signature. */
function signTransaction(raw, kp) {
  const tx = parseTransaction(raw);
  const idx = tx.keys.indexOf(kp.publicKey);
  if (idx < 0 || idx >= tx.numRequiredSignatures) throw new Error('transaction does not require our signature: refusing to sign');
  if (idx !== 0) throw new Error('our wallet is not the fee payer: refusing to sign');
  const sig = kp.sign(tx.message);
  const out = Buffer.from(tx.buf);
  sig.copy(out, tx.sigStart + idx * 64);
  return { bytes: out, signature: b58encode(sig) };
}

function shortVec(n) {
  const out = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if (n === 0) {
      out.push(b);
      return Buffer.from(out);
    }
    out.push(b | 0x80);
  }
}

const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/**
 * Add "fee payer sends `lamports` to `to`" (a tip) as the LAST instruction of an unsigned
 * legacy or v0 transaction. Account indexes (including address-lookup ones) are shifted so
 * every existing instruction still points at the same accounts. Returns new unsigned bytes.
 */
function addTransferInstruction(raw, to, lamports) {
  const tx = parseTransaction(raw);
  const m = tx.message;
  let o = tx.versioned ? 1 : 0;
  const prefix = tx.versioned ? m.subarray(0, 1) : Buffer.alloc(0);
  const header = [m[o], m[o + 1], m[o + 2]];
  o += 3;
  const [nKeys, ksz] = readShortVec(m, o);
  o += ksz;
  const keys = [];
  for (let i = 0; i < nKeys; i++) keys.push(Buffer.from(m.subarray(o + i * 32, o + (i + 1) * 32)));
  o += nKeys * 32;
  const blockhash = m.subarray(o, o + 32);
  o += 32;
  const [nIx, isz] = readShortVec(m, o);
  o += isz;
  const ixs = [];
  for (let i = 0; i < nIx; i++) {
    const pid = m[o++];
    const [na, asz] = readShortVec(m, o);
    o += asz;
    const accts = [...m.subarray(o, o + na)];
    o += na;
    const [dl, dsz] = readShortVec(m, o);
    o += dsz;
    ixs.push({ pid, accts, data: Buffer.from(m.subarray(o, o + dl)) });
    o += dl;
  }
  const lookups = tx.versioned ? Buffer.from(m.subarray(o)) : Buffer.alloc(0); // address table lookups: unchanged

  const toBytes = Buffer.from(b58decode(to));
  if (keys.some((k) => k.equals(toBytes))) throw new Error('tip account already in transaction');
  // 1) tip account = new writable, unsigned key: goes at the end of the "unsigned writable" block.
  const tipIdx = nKeys - header[2];
  const shift = (i, at) => (i >= at ? i + 1 : i);
  keys.splice(tipIdx, 0, toBytes);
  for (const ix of ixs) {
    ix.pid = shift(ix.pid, tipIdx);
    ix.accts = ix.accts.map((a) => shift(a, tipIdx));
  }
  // 2) system program: reuse it if present, otherwise append as a readonly unsigned key.
  const sysBytes = Buffer.from(b58decode(SYSTEM_PROGRAM));
  let sysIdx = keys.findIndex((k) => k.equals(sysBytes));
  if (sysIdx < 0) {
    sysIdx = keys.length;
    keys.push(sysBytes);
    header[2] += 1;
    for (const ix of ixs) ix.accts = ix.accts.map((a) => shift(a, sysIdx)); // lookup-table indexes move up one
  }
  if (keys.length > 255) throw new Error('too many accounts to add a tip');
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0); // system transfer
  data.writeBigUInt64LE(BigInt(Math.round(lamports)), 4);
  ixs.push({ pid: sysIdx, accts: [0, tipIdx], data });

  const msg = Buffer.concat([
    prefix,
    Buffer.from(header),
    shortVec(keys.length),
    ...keys,
    blockhash,
    shortVec(ixs.length),
    ...ixs.map((ix) => Buffer.concat([Buffer.from([ix.pid]), shortVec(ix.accts.length), Buffer.from(ix.accts), shortVec(ix.data.length), ix.data])),
    lookups,
  ]);
  const out = Buffer.concat([shortVec(header[0]), Buffer.alloc(64 * header[0]), msg]);
  if (out.length > 1232) throw new Error(`transaction too large with tip (${out.length} bytes)`);
  return out;
}

/** Full account list of each instruction (static keys only; lookup accounts shown as null). For tests/diagnostics. */
function instructionAccounts(raw) {
  const tx = parseTransaction(raw);
  const m = tx.message;
  let o = (tx.versioned ? 1 : 0) + 3;
  const [nKeys, ksz] = readShortVec(m, o);
  o += ksz + nKeys * 32 + 32;
  const [nIx, isz] = readShortVec(m, o);
  o += isz;
  const out = [];
  for (let i = 0; i < nIx; i++) {
    const pid = m[o++];
    const [na, asz] = readShortVec(m, o);
    o += asz;
    const accts = [...m.subarray(o, o + na)].map((a) => (a < nKeys ? tx.keys[a] : `lookup#${a - nKeys}`));
    o += na;
    const [dl, dsz] = readShortVec(m, o);
    o += dsz + dl;
    out.push({ programId: tx.keys[pid], accounts: accts });
  }
  return out;
}

/** Compiled instructions of a (legacy or v0) transaction: [{programId, data}] (program ids are always static keys). */
function parseInstructions(raw) {
  const tx = parseTransaction(raw);
  const m = tx.message;
  let o = tx.versioned ? 1 : 0;
  o += 3;
  const [nKeys, ksz] = readShortVec(m, o);
  o += ksz + nKeys * 32 + 32; // keys + recent blockhash
  const [nIx, isz] = readShortVec(m, o);
  o += isz;
  const ixs = [];
  for (let i = 0; i < nIx; i++) {
    const pid = m[o++];
    const [na, asz] = readShortVec(m, o);
    o += asz + na;
    const [dl, dsz] = readShortVec(m, o);
    o += dsz;
    ixs.push({ programId: tx.keys[pid] ?? null, data: Buffer.from(m.subarray(o, o + dl)) });
    o += dl;
  }
  return ixs;
}


// ===== detect.js =====
// Turn a parsed Solana transaction into "did the leader BUY a token, and for how much?"
// Works for any venue (pump.fun curve, PumpSwap, Raydium, Jupiter routes, Axiom) because it
// only looks at the leader's own balance changes, not at program-specific instructions.

const STABLES = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
};

const PUMP_PROGRAMS = [PROGRAMS.PUMP, PROGRAMS.PUMP_AMM];

/** Did this transaction go through pump.fun (bonding curve) or PumpSwap? Checks instructions, inner instructions and logs. */
function touchesPump(tx) {
  const msg = tx?.transaction?.message || {};
  const progs = [...(msg.instructions || []), ...(tx?.meta?.innerInstructions || []).flatMap((x) => x.instructions || [])].map((ix) => ix.programId);
  if (progs.some((p) => PUMP_PROGRAMS.includes(p))) return true;
  return (tx?.meta?.logMessages || []).some((l) => PUMP_PROGRAMS.some((p) => l.includes(p)));
}

function detectBuy(tx, leader) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const keys = tx.transaction?.message?.accountKeys || [];
  const idx = keys.findIndex((k) => (typeof k === 'string' ? k : k.pubkey) === leader);
  if (idx < 0) return null;
  const isSigner = typeof keys[idx] === 'object' ? !!keys[idx].signer : idx < (tx.transaction?.message?.header?.numRequiredSignatures ?? 1);
  if (!isSigner) return null; // something was sent TO him; not his own trade

  const fee = (tx.meta.fee || 0) / 1e9;
  const solDelta = ((tx.meta.postBalances?.[idx] ?? 0) - (tx.meta.preBalances?.[idx] ?? 0)) / 1e9 + (idx === 0 ? fee : 0);

  const deltas = new Map(); // mint -> {delta, decimals}
  const add = (b, sign) => {
    if (b.owner !== leader) return;
    const cur = deltas.get(b.mint) || { delta: 0, decimals: b.uiTokenAmount?.decimals ?? 0 };
    cur.delta += sign * Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0);
    deltas.set(b.mint, cur);
  };
  for (const b of tx.meta.postTokenBalances || []) add(b, +1);
  for (const b of tx.meta.preTokenBalances || []) add(b, -1);

  const wsol = deltas.get(WSOL)?.delta || 0;
  let stableUsd = 0;
  for (const [m, v] of deltas) if (STABLES[m] && v.delta < 0) stableUsd += -v.delta;

  const spentSol = -(solDelta + wsol);
  let bought = [...deltas.entries()]
    .filter(([m, v]) => m !== WSOL && !STABLES[m] && v.delta > 0)
    .map(([mint, v]) => ({ mint, amount: v.delta, decimals: v.decimals, raw: v.delta * 10 ** v.decimals }));
  // Multi-hop routes can leave a few raw units of the intermediate coin in his wallet. Seen on
  // 2026-10-07: +1 raw unit next to +877e9 of the coin he bought, which made a real 0.25 SOL buy
  // look like a two-coin trade and get skipped. Ignore amounts a million times smaller than the main one.
  const maxRaw = Math.max(0, ...bought.map((b) => b.raw));
  bought = bought.filter((b) => b.raw >= maxRaw * 1e-6);
  const sold = [...deltas.entries()].some(([m, v]) => m !== WSOL && !STABLES[m] && v.delta < 0);

  if (!bought.length) return null;
  if (spentSol < 0.001 && stableUsd < 0.5) return null; // received tokens without paying: transfer/airdrop
  if (sold && spentSol < 0.001) return null; // token-to-token swap paid with another memecoin: skip

  return {
    signature: tx.transaction?.signatures?.[0] ?? null,
    slot: tx.slot,
    blockTime: tx.blockTime ?? null,
    spentSol: Math.max(0, spentSol),
    spentStableUsd: stableUsd,
    pump: touchesPump(tx),
    bought,
  };
}

/** The leader SELLING a token (signed by him, token balance down, SOL/stables received). Used only for alerts. */
function detectSell(tx, leader) {
  if (!tx || !tx.meta || tx.meta.err) return null;
  const keys = tx.transaction?.message?.accountKeys || [];
  const idx = keys.findIndex((k) => (typeof k === 'string' ? k : k.pubkey) === leader);
  if (idx < 0) return null;
  const isSigner = typeof keys[idx] === 'object' ? !!keys[idx].signer : idx < (tx.transaction?.message?.header?.numRequiredSignatures ?? 1);
  if (!isSigner) return null;
  const fee = (tx.meta.fee || 0) / 1e9;
  const solDelta = ((tx.meta.postBalances?.[idx] ?? 0) - (tx.meta.preBalances?.[idx] ?? 0)) / 1e9 + (idx === 0 ? fee : 0);
  const deltas = new Map();
  const add = (b, sign) => {
    if (b.owner !== leader) return;
    deltas.set(b.mint, (deltas.get(b.mint) || 0) + sign * Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0));
  };
  for (const b of tx.meta.postTokenBalances || []) add(b, +1);
  for (const b of tx.meta.preTokenBalances || []) add(b, -1);
  const received = solDelta + (deltas.get(WSOL) || 0);
  let stable = 0;
  for (const [m, v] of deltas) if (STABLES[m] && v > 0) stable += v;
  const sold = [...deltas.entries()].filter(([m, v]) => m !== WSOL && !STABLES[m] && v < 0).map(([mint, v]) => ({ mint, amount: -v }));
  if (!sold.length || (received < 0.0005 && stable < 0.5)) return null;
  return { kind: 'sell', receivedSol: Math.max(0, received), receivedStableUsd: stable, blockTime: tx.blockTime ?? null, sold };
}


// ===== fastpath.js =====
// FAST PATH: read the leader's pump.fun buy straight out of the transaction logs that the
// websocket pushes at "processed" commitment (~0.4 s after his tx), instead of waiting to
// download the full transaction at "confirmed". Saves roughly 0.5–1.5 s per copy.
//
// pump.fun emits an Anchor event in its logs for every bonding-curve trade:
//   "Program data: <base64>"  where the first 8 bytes = sha256("event:TradeEvent")[0..8]
// TradeEvent layout (pump IDL): mint pubkey, sol_amount u64, token_amount u64, is_buy bool,
// user pubkey, timestamp i64, virtual_sol_reserves u64, virtual_token_reserves u64, ...

const TRADE_EVENT_DISC = crypto.createHash('sha256').update('event:TradeEvent').digest().subarray(0, 8);
const MIN_LEN = 8 + 32 + 8 + 8 + 1 + 32 + 8;

function decodeTradeEvent(b64) {
  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }
  if (buf.length < MIN_LEN || !buf.subarray(0, 8).equals(TRADE_EVENT_DISC)) return null;
  let o = 8;
  const mint = b58encode(buf.subarray(o, o + 32));
  o += 32;
  const solAmount = Number(buf.readBigUInt64LE(o));
  o += 8;
  const tokenAmount = Number(buf.readBigUInt64LE(o));
  o += 8;
  const isBuy = buf[o] === 1;
  o += 1;
  const user = b58encode(buf.subarray(o, o + 32));
  o += 32;
  const timestamp = Number(buf.readBigInt64LE(o));
  o += 8;
  const vSol = buf.length >= o + 16 ? Number(buf.readBigUInt64LE(o)) : null;
  const vTok = buf.length >= o + 16 ? Number(buf.readBigUInt64LE(o + 8)) : null;
  return { mint, solAmount, tokenAmount, isBuy, user, timestamp, vSol, vTok };
}

/** Leader's pump.fun bonding-curve buys found in a log list (only if the pump program ran). */
function leaderPumpBuys(logs, leader) {
  if (!Array.isArray(logs) || !logs.some((l) => l.startsWith(`Program ${PROGRAMS.PUMP} invoke`))) return [];
  const out = [];
  for (const l of logs) {
    if (!l.startsWith('Program data: ')) continue;
    const ev = decodeTradeEvent(l.slice(14).trim());
    if (ev && ev.isBuy && ev.user === leader) out.push(ev);
  }
  return out;
}

/** Leader's pump.fun bonding-curve SELLS in a log list (for "Decu sold" alerts). */
function leaderPumpSells(logs, leader) {
  if (!Array.isArray(logs) || !logs.some((l) => l.startsWith(`Program ${PROGRAMS.PUMP} invoke`))) return [];
  const out = [];
  for (const l of logs) {
    if (!l.startsWith('Program data: ')) continue;
    const ev = decodeTradeEvent(l.slice(14).trim());
    if (ev && !ev.isBuy && ev.user === leader) out.push(ev);
  }
  return out;
}

/** Encode a TradeEvent (used by tests and the backtest simulator). */
function encodeTradeEvent({ mint, solAmount, tokenAmount, isBuy, user, timestamp, vSol = 0, vTok = 0 }, b58decode) {
  const buf = Buffer.alloc(MIN_LEN + 16);
  TRADE_EVENT_DISC.copy(buf, 0);
  let o = 8;
  Buffer.from(b58decode(mint)).copy(buf, o);
  o += 32;
  buf.writeBigUInt64LE(BigInt(Math.round(solAmount)), o);
  o += 8;
  buf.writeBigUInt64LE(BigInt(Math.round(tokenAmount)), o);
  o += 8;
  buf[o++] = isBuy ? 1 : 0;
  Buffer.from(b58decode(user)).copy(buf, o);
  o += 32;
  buf.writeBigInt64LE(BigInt(timestamp), o);
  o += 8;
  buf.writeBigUInt64LE(BigInt(Math.round(vSol)), o);
  buf.writeBigUInt64LE(BigInt(Math.round(vTok)), o + 8);
  return buf.toString('base64');
}


// ===== notify.js =====
// Phone notifications via ntfy (https://ntfy.sh): install the ntfy app, subscribe to your topic.

const ascii = (s) => String(s).replace(/[^\x20-\x7e]/g, '').slice(0, 200);

async function notify({ title, body, priority = 3, tags = [], click, actions = [] }) {
  const line = `[${new Date().toISOString()}] ${title} | ${body.replace(/\n/g, ' | ')}`;
  console.log(line);
  if (!config.ntfyTopic) return;
  const headers = { Title: ascii(title), Priority: String(priority) };
  if (tags.length) headers.Tags = tags.join(',');
  if (click) headers.Click = click;
  if (actions.length) headers.Actions = actions.map((a) => `view, ${ascii(a.label)}, ${a.url}`).join('; ');
  try {
    await http(`${config.ntfyServer.replace(/\/$/, '')}/${encodeURIComponent(config.ntfyTopic)}`, { method: 'POST', headers: { ...headers, 'content-type': 'text/plain; charset=utf-8' }, body: body, timeoutMs: 6000 });
  } catch (e) {
    console.error('ntfy failed:', e.message);
  }
}

const links = {
  pump: (mint) => `https://pump.fun/coin/${mint}`,
  dex: (mint) => `https://dexscreener.com/solana/${mint}`,
  tx: (sig) => `https://solscan.io/tx/${sig}`,
};


// ===== state.js =====
// Persistent state: which coins were already copied and how much SOL was spent today.
// Survives restarts so the daily cap and "first buy per coin" rule can't be bypassed by a crash.

function dayKey(ts = Date.now(), tz = config.timezone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
}

class State {
  constructor(file = config.stateFile) {
    this.file = file;
    this.data = { live: { copied: {}, daily: {} }, dry: { copied: {}, daily: {} }, capNotified: {} };
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      /* first run */
    }
  }
  bucket(dry) {
    return this.data[dry ? 'dry' : 'live'];
  }
  spentToday(dry) {
    return this.bucket(dry).daily[dayKey()] || 0;
  }
  wasCopied(mint, dry) {
    return !!this.bucket(dry).copied[mint];
  }
  record(mint, sol, info, dry) {
    const b = this.bucket(dry);
    b.copied[mint] = { at: Date.now(), ...info };
    const k = dayKey();
    b.daily[k] = (b.daily[k] || 0) + sol;
    this.save();
  }
  refund(sol, dry) {
    const b = this.bucket(dry);
    const k = dayKey();
    b.daily[k] = Math.max(0, (b.daily[k] || 0) - sol);
    this.save();
  }
  forget(mint, dry) {
    delete this.bucket(dry).copied[mint];
    this.save();
  }
  capNotifiedToday() {
    return this.data.capNotified[dayKey()] === true;
  }
  markCapNotified() {
    this.data.capNotified = { [dayKey()]: true };
    this.save();
  }
  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }
}


// ===== paper.js =====
// PAPER TRADING (DRY_RUN=true): pretend trades at real on-chain prices. Never sends a transaction.
//
// For every buy the bot would copy:
//   1. "Build" price  = pool state the moment his trade is seen (what a real buy's slippage limit is based on).
//   2. "Land" price   = pool state PAPER_LAND_MS later (when a real buy would land). If that costs more than
//                       SLIPPAGE_PCT above the build price, a real buy would have FAILED (Custom 6001): recorded
//                       as a failed copy, no position.
//   3. When he SELLS that coin, the position is valued at several delays after his sell
//      (PAPER_EXIT_DELAYS, default 0,5,10,30 s) so you can see what selling fast vs slow by hand would have made.
//      If he never sells, it is valued after PAPER_MAX_HOLD_MIN.
// Fees: PumpPortal 0.5% each way, pool fee PUMP_FEE_PCT each way, priority fee each way, tip on the buy.

const LAMPORTS = 1e9;
const PP_FEE = 0.005;
const paperSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeCurve(base64) {
  const buf = Buffer.from(base64, 'base64');
  if (buf.length < 49) return null;
  const r = new Reader(buf, 8);
  const vTok = r.u64();
  const vSol = r.u64();
  r.u64();
  r.u64();
  r.u64();
  return { vTok, vSol, complete: r.bool() };
}

const poolFee = () => config.pumpFeePct / 100;

/** Raw tokens received for `sol` SOL (after pool fee). */
function curveBuy(curve, sol) {
  const net = BigInt(Math.floor(sol * LAMPORTS * (1 - poolFee())));
  return net > 0n ? Number((curve.vTok * net) / (curve.vSol + net)) : 0;
}

/** SOL received for selling `raw` tokens (after pool fee). */
function curveSell(curve, raw) {
  const r = BigInt(Math.floor(raw));
  return r > 0n ? (Number((curve.vSol * r) / (curve.vTok + r)) / LAMPORTS) * (1 - poolFee()) : 0;
}

async function readCurve(mint) {
  const r = await rpc('getAccountInfo', [bondingCurvePda(mint), { encoding: 'base64', commitment: 'processed' }], 5000);
  return r?.value?.data?.[0] ? decodeCurve(r.value.data[0]) : null;
}

async function jupQuote(inputMint, outputMint, amount) {
  const base = config.jupiterApiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
  const qs = new URLSearchParams({ inputMint, outputMint, amount: String(Math.floor(amount)), slippageBps: '5000' });
  const q = await http(`${base}/swap/v1/quote?${qs}`, { headers: config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {}, timeoutMs: 5000 });
  const out = Number(q?.outAmount);
  return out > 0 ? out : null;
}

/** Raw tokens for spending `sol` right now (curve, or Jupiter once the coin has graduated). */
async function quoteBuy(mint, sol) {
  const c = await readCurve(mint).catch(() => null);
  if (c && !c.complete) return { raw: curveBuy(c, sol), venue: 'curve' };
  const raw = await jupQuote(WSOL, mint, sol * LAMPORTS).catch(() => null);
  return raw ? { raw, venue: 'pumpswap' } : null;
}

/** SOL for selling `raw` tokens right now. */
async function quoteSell(mint, raw) {
  const c = await readCurve(mint).catch(() => null);
  if (c && !c.complete) return curveSell(c, raw);
  const out = await jupQuote(mint, WSOL, raw).catch(() => null);
  return out ? out / LAMPORTS : null;
}

class Paper {
  constructor({ file = config.paperFile, log = console.log } = {}) {
    this.file = file;
    this.log = log;
    this.data = { open: {}, closed: [] };
    try {
      this.data = { open: {}, closed: [], ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      /* first run */
    }
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
    fs.renameSync(tmp, this.file);
  }

  /**
   * Paper-buy. `buildQuote` is a promise of quoteBuy() started when his trade was seen.
   * Returns the trade record (status 'open' or 'failed').
   */
  async open({ mint, leaderSig, leaderSol, leaderUsd, hisPrice, detectedAt, buildQuote }) {
    const buySol = config.buySol;
    const costSol = buySol + config.priorityFeeSol + config.tipSol; // SOL leaving the wallet
    const spend = buySol * (1 - PP_FEE);
    const build = await buildQuote;
    const wait = config.paperLandMs - (Date.now() - detectedAt);
    if (wait > 0) await paperSleep(wait);
    const land = await quoteBuy(mint, spend);
    const t = { mint, leaderSig, leaderSol, leaderUsd, hisPrice, detectedAt, landedAt: Date.now(), costSol, day: dayKey() };
    if (!land || !land.raw) {
      Object.assign(t, { status: 'failed', reason: 'no price (pool not found)' });
    } else {
      t.raw = land.raw;
      t.venue = land.venue;
      t.entryPrice = spend / land.raw; // SOL per raw token
      t.gapVsHisPct = hisPrice ? (t.entryPrice / hisPrice - 1) * 100 : null;
      // Real buys set max cost = build quote + slippage. If the pool moved more than that by landing, it fails.
      if (build?.raw && land.raw < build.raw / (1 + config.slippagePct / 100)) {
        Object.assign(t, { status: 'failed', reason: `slippage: price moved ${((build.raw / land.raw - 1) * 100).toFixed(0)}% between build and landing (limit ${config.slippagePct}%)`, failCostSol: config.priorityFeeSol });
      } else t.status = 'open';
    }
    if (t.status === 'open') {
      this.data.open[mint] = t;
      // Quick-flip test: value the position N seconds after our own buy, independent of his sell.
      t.quick = {};
      for (const s of config.paperQuickSec)
        setTimeout(async () => {
          const sol = await quoteSell(mint, t.raw).catch(() => null);
          t.quick[s] = sol === null ? null : sol * (1 - PP_FEE) - config.priorityFeeSol;
          this.save();
        }, Math.max(0, t.landedAt + s * 1000 - Date.now())).unref?.();
    }
    else this.data.closed.push({ ...t, closedAt: Date.now() });
    this.save();
    this.log(`paper ${t.status} ${mint.slice(0, 6)}…${t.gapVsHisPct != null ? ` entry ${t.gapVsHisPct >= 0 ? '+' : ''}${t.gapVsHisPct.toFixed(0)}% vs his price` : ''}${t.reason ? ` (${t.reason})` : ''}`);
    return t;
  }

  /** He sold: value the paper position at each exit delay, then close it. */
  async onLeaderSell(mint, soldAt = Date.now()) {
    const t = this.data.open[mint];
    if (!t || t.closing) return null;
    t.closing = true;
    t.hisSellAt = soldAt;
    return this.valueAndClose(t, soldAt, 'his sell');
  }

  async valueAndClose(t, from, why) {
    t.exits = {};
    for (const d of config.paperExitDelays) {
      const wait = from + d * 1000 - Date.now();
      if (wait > 0) await paperSleep(wait);
      const sol = await quoteSell(t.mint, t.raw).catch(() => null);
      t.exits[d] = sol === null ? null : sol * (1 - PP_FEE) - config.priorityFeeSol;
    }
    t.status = 'closed';
    t.closeReason = why;
    t.closedAt = Date.now();
    delete this.data.open[t.mint];
    delete t.closing;
    this.data.closed.push(t);
    if (this.data.closed.length > 2000) this.data.closed = this.data.closed.slice(-2000);
    this.save();
    const main = t.exits[config.paperMainDelay] ?? Object.values(t.exits).find((x) => x != null);
    const pnl = main == null ? null : main - t.costSol;
    const r = this.report();
    const row = r.byDelay.find((x) => x.delay === config.paperMainDelay) || r.byDelay[0];
    this.log(`paper closed ${t.mint.slice(0, 6)}… ${pnl == null ? 'no price' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`}`);
    if (config.notifyPaper)
      await notify({
        title: `[PAPER] ${pnl == null ? 'closed (no price)' : `${pnl >= 0 ? '+' : ''}${((pnl / t.costSol) * 100).toFixed(0)}%`} ${t.mint.slice(0, 6)}…`,
        body: `Sold ${config.paperMainDelay}s after ${why}: ${pnl == null ? 'no price' : `${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} SOL`}\nYour entry was ${t.gapVsHisPct == null ? '?' : `${t.gapVsHisPct >= 0 ? '+' : ''}${t.gapVsHisPct.toFixed(0)}%`} vs his price\nToday (paper): ${row ? `${row.pnlSol >= 0 ? '+' : ''}${row.pnlSol.toFixed(3)} SOL over ${row.trades} trades, ${row.wins} wins, ${r.failed} failed buys` : '-'}\nNo real money was used.`,
        priority: 2,
        tags: ['test_tube'],
        click: links.pump(t.mint),
      });
    return t;
  }

  /** Positions he never sold: close after PAPER_MAX_HOLD_MIN. Called periodically. */
  async sweep(now = Date.now()) {
    for (const t of Object.values(this.data.open))
      if (!t.closing && now - t.landedAt > config.paperMaxHoldMin * 60_000) {
        t.closing = true;
        await this.valueAndClose(t, now, `${config.paperMaxHoldMin} min max hold (he hadn't sold)`);
      }
  }

  /** Stats for one day (default today) or all days (day = null). */
  report(day = dayKey()) {
    const rows = this.data.closed.filter((t) => day === null || t.day === day);
    const filled = rows.filter((t) => t.status === 'closed');
    const failed = rows.filter((t) => t.status === 'failed');
    const failCost = failed.reduce((a, t) => a + (t.failCostSol || 0), 0);
    const byDelay = config.paperExitDelays.map((d) => {
      const p = filled.filter((t) => t.exits?.[d] != null).map((t) => t.exits[d] - t.costSol);
      const sorted = [...p].sort((a, b) => a - b);
      return { delay: d, trades: p.length, wins: p.filter((x) => x > 0).length, pnlSol: p.reduce((a, x) => a + x, 0) - failCost, medianSol: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null };
    });
    const byQuick = config.paperQuickSec.map((s) => {
      const p = rows.filter((t) => t.quick?.[s] != null).map((t) => t.quick[s] - t.costSol);
      return { sec: s, trades: p.length, wins: p.filter((x) => x > 0).length, pnlSol: p.reduce((a, x) => a + x, 0) - failCost };
    });
    const gaps = filled.map((t) => t.gapVsHisPct).filter((x) => x != null).sort((a, b) => a - b);
    return { day, filled: filled.length, failed: failed.length, open: Object.keys(this.data.open).length, medianGapPct: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null, byDelay, byQuick };
  }

  reportText(day = dayKey(), solUsd = null) {
    const r = this.report(day);
    const usd = (s) => (solUsd ? ` (~$${(s * solUsd).toFixed(0)})` : '');
    const L = [`PAPER TRADING ${day ?? 'all days'}: ${r.filled} filled, ${r.failed} failed buys (slippage/no pool), ${r.open} still open`];
    L.push(`Your entry vs his price: median ${r.medianGapPct == null ? '?' : `${r.medianGapPct >= 0 ? '+' : ''}${r.medianGapPct.toFixed(0)}%`}`);
    L.push('Sell delay after his sell | trades | wins | total profit');
    for (const x of r.byDelay) L.push(`  ${String(x.delay).padStart(3)}s | ${String(x.trades).padStart(4)} | ${String(x.wins).padStart(4)} | ${x.pnlSol >= 0 ? '+' : ''}${x.pnlSol.toFixed(4)} SOL${usd(x.pnlSol)}`);
    L.push('Quick flip: sell N s after YOUR buy | trades | wins | total profit');
    for (const x of r.byQuick) L.push(`  ${String(x.sec).padStart(3)}s | ${String(x.trades).padStart(4)} | ${String(x.wins).padStart(4)} | ${x.pnlSol >= 0 ? '+' : ''}${x.pnlSol.toFixed(4)} SOL${usd(x.pnlSol)}`);
    L.push(`Each trade: ${config.buySol} SOL, fees + ${config.tipSol} SOL tip included. No real money used.`);
    return L.join('\n');
  }
}


// ===== executor.js =====
// Builds the buy transaction (PumpPortal or Jupiter), checks it by simulation,
// signs it locally, and sends it. The private key never leaves this process.

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
const MEMO = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const DISC = {
  buy: '66063d1201daebea', // pump curve buy(amount, max_sol_cost) | PumpSwap buy(base_out, max_quote_in)
  buyExactSolIn: '38fc74089edfcd5f', // pump curve buy_exact_sol_in(spendable_sol_in, min_tokens_out)
  buyExactQuoteIn: 'c62e1552b4d9e870', // PumpSwap buy_exact_quote_in(spendable_quote_in, min_base_out)
};

function transactionBlockhash(bytes) {
  const tx=parseTransaction(bytes),m=tx.message;let o=(tx.versioned?1:0)+3;
  const [n,z]=readShortVec(m,o);o+=z+n*32;return b58encode(m.subarray(o,o+32));
}

async function validateTrade(bytes,job,balanceSol) {
  const tx=parseTransaction(bytes);
  if(tx.nSig!==1 || tx.numRequiredSignatures!==1) throw new Error('unexpected additional signer');
  const wallet=tx.keys[0],m=tx.message;let o=(tx.versioned?1:0)+3;
  const [n,z]=readShortVec(m,o);o+=z+n*32+32;
  const [ni,zi]=readShortVec(m,o);o+=zi;const instructions=[];
  for(let i=0;i<ni;i++) {const pid=m[o++];const [na,za]=readShortVec(m,o);o+=za;const accts=[...m.subarray(o,o+na)];o+=na;const [len,zl]=readShortVec(m,o);o+=zl;instructions.push({pid,accts,data:m.subarray(o,o+len)});o+=len;}
  const writable=[],readonly=[];
  if(tx.versioned) {
    const [count,sz]=readShortVec(m,o);o+=sz;
    for(let i=0;i<count;i++) {
      const address=b58encode(m.subarray(o,o+32));o+=32;
      const r=await rpc('getAccountInfo',[address,{encoding:'base64',commitment:'confirmed'}]);
      if(!r.value || r.value.owner!=='AddressLookupTab1e1111111111111111111111111') throw new Error('invalid lookup table');
      const data=Buffer.from(r.value.data[0],'base64');
      for(const output of [writable,readonly]) {const [c,s]=readShortVec(m,o);o+=s;for(const index of m.subarray(o,o+c)){const start=56+index*32;if(start+32>data.length)throw new Error('invalid lookup index');output.push(b58encode(data.subarray(start,start+32)));}o+=c;}
    }
  }
  const keys=[...tx.keys,...writable,...readonly];
  const atas=[associatedTokenAddress(wallet,job.mint,PROGRAMS.TOKEN),associatedTokenAddress(wallet,job.mint,PROGRAMS.TOKEN_2022)];
  const wrapped=associatedTokenAddress(wallet,WSOL,PROGRAMS.TOKEN);let tradeCount=0;
  for(const ix of instructions) {
    const program=keys[ix.pid],accounts=ix.accts.map(i=>keys[i]),data=ix.data;
    if(accounts.some(x=>!x))throw new Error('unresolved instruction account');
    if(program===COMPUTE_BUDGET || program===MEMO) continue;
    if(program===SYSTEM_PROGRAM) {
      if(data.length!==12 || data.readUInt32LE(0)!==2) throw new Error('unsupported system instruction');
      if(accounts[0]!==wallet || !(TIP_ACCOUNTS.includes(accounts[1]) || accounts[1]===wrapped)) throw new Error('unexpected SOL transfer recipient');
    } else if(program===PROGRAMS.ATA) {
      if(accounts[0]!==wallet || accounts[2]!==wallet || ![job.mint,WSOL].includes(accounts[3])) throw new Error('unexpected token account creation');
    } else if(program===PROGRAMS.TOKEN || program===PROGRAMS.TOKEN_2022) {
      if(data[0]===17 && accounts[0]===wrapped) continue;
      if(data[0]===9 && accounts[1]===wallet && accounts[2]===wallet && [wrapped,...atas].includes(accounts[0])) continue;
      throw new Error('token transfer, approval, or unsupported instruction refused');
    } else if(PUMP_PROGRAMS.includes(program)) {
      const disc=data.subarray(0,8).toString('hex');
      if(!accounts.includes(wallet) || !accounts.includes(job.mint) || data.length<24) throw new Error('wrong trade wallet/mint');
      if(job.side==='sell') {
        if(disc!=='33e685a4017f83ad' || data.readBigUInt64LE(8)!==BigInt(job.raw)) throw new Error('sell instruction quantity mismatch');
      } else {
        const allowed=[DISC.buy,DISC.buyExactSolIn,DISC.buyExactQuoteIn];
        if(!allowed.includes(disc)) throw new Error('unsupported buy instruction');
        const max=data.readBigUInt64LE(disc===DISC.buy?16:8);
        if(max>BigInt(Math.ceil(job.sol*(1+config.slippagePct/100)*1e9))) throw new Error('buy instruction exceeds budget');
      }
      tradeCount++;
    } else throw new Error('unapproved execution program '+program);
  }
  if(tradeCount!==1) throw new Error('expected exactly one pump trade instruction');
  const before=await rpc('getMultipleAccounts',[[wallet,...atas],{encoding:'base64',commitment:'confirmed'}]);
  const simulation=await rpc('simulateTransaction',[Buffer.from(bytes).toString('base64'),{encoding:'base64',sigVerify:true,commitment:'confirmed',accounts:{encoding:'base64',addresses:[wallet,...atas]}}]);
  const v=simulation.value;
  if(v.err || !v.accounts?.[0])throw new Error('simulation refused: '+JSON.stringify(v.err));
  const outflow=(before.value[0].lamports-v.accounts[0].lamports)/1e9;
  const limit=(job.side==='buy'?job.sol*(1+config.slippagePct/100):0)+config.tipSol+config.priorityFeeSol+0.005;
  if(outflow>limit || v.accounts[0].lamports/1e9<config.minSolReserve) throw new Error('simulation exceeds spend/reserve limit');
  const sum=rows=>rows.slice(1).reduce((total,a)=>{if(!a)return total;const b=Buffer.from(a.data[0],'base64');if(b.length<72)throw new Error('invalid token account');return total+b.readBigUInt64LE(64);},0n);
  const delta=sum(v.accounts)-sum(before.value);
  if(job.side==='buy' ? delta<=0n : delta!==-BigInt(job.raw))throw new Error('simulation token balance differs from intended trade');
}

/**
 * Instant (~0 ms) safety check: read every instruction and add up the most SOL it can move.
 * Returns {ok:true, maxSol} when the tx is fully understood and within limits, otherwise
 * {ok:false, reason} so the caller can fall back to a (slower) simulation.
 */
function staticGuard(bytes, limitSol) {
  let ixs;
  try {
    ixs = parseInstructions(bytes);
  } catch (e) {
    return { ok: false, reason: `unparseable tx: ${e.message}` };
  }
  let lamports = 0;
  let cuLimit = 200_000;
  let cuPrice = 0;
  for (const { programId, data } of ixs) {
    if (programId === COMPUTE_BUDGET) {
      if (data[0] === 2) cuLimit = data.readUInt32LE(1);
      else if (data[0] === 3) cuPrice = Number(data.readBigUInt64LE(1));
    } else if (programId === PROGRAMS.SYSTEM) {
      const kind = data.readUInt32LE(0);
      if (kind === 2) lamports += Number(data.readBigUInt64LE(4)); // transfer (fees, tips, WSOL wrap)
      else if (kind === 0) lamports += Number(data.readBigUInt64LE(4)); // createAccount (rent)
      else return { ok: false, reason: `system instruction ${kind}` };
    } else if (programId === PROGRAMS.ATA) {
      lamports += 2_100_000; // rent for a new token account
    } else if (programId === PROGRAMS.TOKEN || programId === PROGRAMS.TOKEN_2022 || programId === MEMO) {
      // token-account housekeeping (sync native, close): moves no SOL out of the wallet
    } else if (programId === PROGRAMS.PUMP || programId === PROGRAMS.PUMP_AMM) {
      const d = data.subarray(0, 8).toString('hex');
      if (d === DISC.buy) lamports += Number(data.readBigUInt64LE(16));
      else if (d === DISC.buyExactSolIn || d === DISC.buyExactQuoteIn) lamports += Number(data.readBigUInt64LE(8));
      else return { ok: false, reason: `unknown pump instruction ${d}` };
    } else {
      return { ok: false, reason: `unrecognised program ${programId}` };
    }
  }
  const priorityLamports = (cuLimit * cuPrice) / 1e6;
  const maxSol = (lamports + priorityLamports) / 1e9;
  return maxSol <= limitSol ? { ok: true, maxSol } : { ok: false, reason: `could move up to ${maxSol.toFixed(4)} SOL (limit ${limitSol.toFixed(4)})`, maxSol };
}

const guardLimit = (tipSol = 0) => config.buySol * (1 + config.slippagePct / 100) + config.priorityFeeSol + 0.012 + tipSol;

// Helius Sender tip accounts (from helius.dev/docs/sending-transactions/sender, checked 2026-10-07).
const TIP_ACCOUNTS = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
];

function senderUrl() {
  if (!config.senderUrl) return null;
  return config.heliusKey && !/api-key=/.test(config.senderUrl) ? `${config.senderUrl}${config.senderUrl.includes('?') ? '&' : '?'}api-key=${config.heliusKey}` : config.senderUrl;
}

async function buildPumpPortal(kp, mint) {
  const bytes = await http('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    raw: true,
    timeoutMs: 8000,
    body: {
      publicKey: kp.publicKey,
      action: 'buy',
      mint,
      amount: config.buySol,
      denominatedInSol: 'true',
      slippage: config.slippagePct,
      priorityFee: config.priorityFeeSol,
      pool: 'auto',
    },
  });
  if (!bytes?.length || bytes.length < 100) throw new Error(`PumpPortal returned no transaction (${bytes?.toString().slice(0, 120)})`);
  return { bytes, route: 'pumpportal' };
}

async function buildJupiter(kp, mint) {
  const qs = new URLSearchParams({
    inputMint: WSOL,
    outputMint: mint,
    amount: String(Math.round(config.buySol * 1e9)),
    taker: kp.publicKey,
    slippageBps: String(Math.round(config.slippagePct * 100)),
  });
  const o = await http(`https://api.jup.ag/swap/v2/order?${qs}`, { headers: { 'x-api-key': config.jupiterApiKey }, timeoutMs: 8000 });
  if (!o?.transaction) throw new Error(`Jupiter: ${o?.errorMessage || 'no route'}`);
  return { bytes: Buffer.from(o.transaction, 'base64'), route: 'jupiter', requestId: o.requestId };
}

/**
 * Simulate before sending and refuse if the transaction would take more SOL from the
 * wallet than the buy amount + slippage + fees. Protects against a bad/compromised builder.
 */
async function simulateGuard(signedBytes, pubkey, balanceSol, tipSol = 0) {
  // Never compare against an unknown balance (that would let any outflow through).
  if (typeof balanceSol !== 'number' || !Number.isFinite(balanceSol)) balanceSol = (await rpc('getBalance', [pubkey, { commitment: 'processed' }])).value / 1e9;
  const r = await rpc('simulateTransaction', [
    Buffer.from(signedBytes).toString('base64'),
    { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed', accounts: { encoding: 'base64', addresses: [pubkey] } },
  ]);
  const v = r?.value;
  if (!v) throw new Error('simulation returned nothing');
  if (v.err) throw new Error(`simulation failed: ${JSON.stringify(v.err).slice(0, 160)}`);
  const after = v.accounts?.[0]?.lamports;
  if (typeof after !== 'number') throw new Error('simulation did not return the wallet balance: refused');
  {
    const outflow = balanceSol - after / 1e9;
    const maxAllowed = guardLimit(tipSol);
    if (outflow > maxAllowed) throw new Error(`simulation shows ${outflow.toFixed(4)} SOL leaving the wallet (max ${maxAllowed.toFixed(4)}): refused`);
  }
  return true;
}

/**
 * Build + tip + sign + safety-check a buy, WITHOUT sending it. Safe to call speculatively the
 * moment his trade is seen: if the rules then say "skip", the prepared transaction is just dropped.
 * Returns {ok, built, signed, tipSol, buildMs} or {ok:false, error}.
 */
async function prepareBuy(kp, mint, balanceSol) {
  const t0 = Date.now();
  const builders = config.executor === 'jupiter' ? [buildJupiter, buildPumpPortal] : [buildPumpPortal, ...(config.jupiterApiKey ? [buildJupiter] : [])];
  let lastErr;
  for (const build of builders) {
    try {
      const built = await build(kp, mint);
      let bytes = built.bytes;
      let tipSol = 0;
      // Tip for Helius Sender (PumpPortal route only: Jupiter lands its own transactions).
      if (built.route === 'pumpportal' && config.tipSol > 0 && senderUrl()) {
        try {
          const to = TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];
          bytes = addTransferInstruction(bytes, to, Math.round(config.tipSol * 1e9));
          tipSol = config.tipSol;
        } catch (e) {
          built.tipError = e.message; // send without the tip through normal RPCs
        }
      }
      const signed = signTransaction(bytes, kp);
      const g = staticGuard(signed.bytes, guardLimit(tipSol));
      built.guard = g.ok ? 'static' : 'simulated';
      if (!g.ok) {
        if (!config.simulate) throw new Error(`refused: ${g.reason} (and SIMULATE_BEFORE_SEND=false)`);
        await simulateGuard(signed.bytes, kp.publicKey, balanceSol, tipSol);
      }
      return { ok: true, built, signed, tipSol, buildMs: Date.now() - t0 };
    } catch (e) {
      lastErr = e; // nothing was sent: safe to try the next route
    }
  }
  return { ok: false, error: lastErr?.message || 'no route available', buildMs: Date.now() - t0 };
}

/**
 * Send a buy. `prepared` (optional) is a promise from prepareBuy started earlier.
 * Returns {ok, signature, route, error, buildMs, sendMs, tipSol}. A transaction is sent at most once (no double buys).
 */
async function executeBuy(kp, mint, balanceSol, prepared = null) {
  // Use the speculative build if there was one (a refused/failed one stays refused: never re-try a guard refusal).
  const p = prepared ? await prepared.catch((e) => ({ ok: false, error: e.message })) : await prepareBuy(kp, mint, balanceSol);
  if (!p.ok) return { ok: false, error: p.error };
  const { built, signed, tipSol } = p;
  const meta = { route: built.route, guard: built.guard, buildMs: p.buildMs, tipSol, tipError: built.tipError };
  // ---- point of no return: transaction is sent exactly once ----
  try {
    let sig = signed.signature;
    if (built.route === 'jupiter') {
      const ex = await http('https://api.jup.ag/swap/v2/execute', {
        method: 'POST',
        headers: { 'x-api-key': config.jupiterApiKey },
        body: { signedTransaction: Buffer.from(signed.bytes).toString('base64'), requestId: built.requestId },
        timeoutMs: 60000,
      });
      sig = ex.signature || sig;
      return ex.status === 'Success' ? { ok: true, signature: sig, ...meta } : { ok: false, signature: sig, ...meta, error: ex.error || `code ${ex.code}`, notBought: true };
    }
    const sentAt = Date.now();
    await sendRaw(signed.bytes, tipSol > 0 ? [senderUrl()] : []);
    const sendMs = Date.now() - sentAt;
    const c = await confirm(sig);
    return { ok: c.ok, signature: sig, ...meta, sendMs, confirmMs: Date.now() - sentAt, error: c.err, notBought: !!c.landedFailed };
  } catch (e) {
    return { ok: false, signature: signed.signature, ...meta, error: `${e.message} (check Solscan: it may still have landed)` };
  }
}



// ===== copier.js =====
// Decision engine: for each leader transaction, decide copy / skip, then execute.

let solPrice = { usd: null, at: 0 };
async function getSolUsd() {
  if (solPrice.usd && Date.now() - solPrice.at < 60_000) return solPrice.usd;
  try {
    return await fetchSolUsdLive();
  } catch {
    return solPrice.usd || config.solPriceFallback;
  }
}

/** SOL/USD sources in priority order: Solscan and Helius (DAS getAsset price_info) first, then Jupiter, DexScreener. */
const SOL_PRICE_SOURCES = [
  ['Solscan', async () => (solscan.enabled ? solscan.tokenPrice(WSOL) : null)],
  ['Helius', async () => {
    if (config.rpcIsPublic) return null;
    const r = await rpc('getAsset', { id: WSOL }, 4000);
    return Number(r?.token_info?.price_info?.price_per_token);
  }],
  ['Jupiter', async () => {
    const base = config.jupiterApiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
    const r = await http(`${base}/price/v3?ids=${WSOL}`, { headers: config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {}, timeoutMs: 4000 });
    return Number(r?.[WSOL]?.usdPrice);
  }],
  ['DexScreener', async () => {
    const r = await http(`https://api.dexscreener.com/token-pairs/v1/solana/${WSOL}`, { timeoutMs: 4000 });
    const p = (Array.isArray(r) ? r : []).filter((x) => x.baseToken?.symbol === 'SOL' && /USDC|USDT/.test(x.quoteToken?.symbol)).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
    return Number(p?.priceUsd);
  }],
];

/** Live SOL/USD from the first source that answers. Throws if all are down. */
async function fetchSolUsdLive() {
  for (const [, t] of SOL_PRICE_SOURCES) {
    try {
      const v = await t();
      if (v > 0) {
        solPrice = { usd: v, at: Date.now() };
        return v;
      }
    } catch {
      /* next */
    }
  }
  throw new Error('Solscan, Helius, Jupiter and DexScreener price all unavailable');
}

class Copier {
  constructor({ state, keypair, paper = null, log = console.log }) {
    this.state = state;
    this.paper = paper; // Paper instance in DRY_RUN (pretend trades at real prices)
    this.kp = keypair;
    this.log = log;
    this.seen = new Set();
    this.queue = Promise.resolve();
  }

  journal(entry) {
    try {
      fs.appendFileSync(config.logFile, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
    } catch {
      /* ignore */
    }
  }

  /**
   * Entry point from the watcher. Detection runs immediately and in parallel; only the
   * decide-and-buy step is serialised (so the daily cap / once-per-coin rules can't race).
   */
  onSignature(sig, via, logs) {
    if (this.seen.has(sig)) return this.queue;
    this.seen.add(sig);
    if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2500));
    const t0 = Date.now();
    const detection = this.detect(sig, logs).catch((e) => {
      this.log(`error reading ${sig}: ${e.message}`);
      return null;
    });
    // SPEED: start building + signing our buy as soon as his buy is decoded, in parallel with the
    // rule checks. It is only ever SENT if decide() approves it; otherwise it is dropped.
    const prepared = detection.then((d) => this.maybePrebuild(d)).catch(() => null);
    this.queue = this.queue
      .then(async () => {
        const d = await detection;
        if (d?.kind === 'sell') await this.onLeaderSell(d, sig);
        else if (d) await this.decide(d, sig, via, t0, await prepared);
      })
      .catch((e) => this.log(`error handling ${sig}: ${e.message}`));
    return this.queue;
  }

  wantSells() {
    return config.alertLeaderSells || (config.dryRun && !!this.paper);
  }

  /** Quick pre-checks (no waiting on the queue); returns {mint, promise} or null. */
  maybePrebuild(d) {
    if (!d || d.kind === 'sell') return null;
    if (config.dryRun) {
      // Paper mode: record the pool price at the moment a real buy would be built (its slippage reference).
      const mint = d.bought?.[0]?.mint;
      return this.paper && mint ? { mint, promise: null, paperQuote: quoteBuy(mint, config.buySol * 0.995).catch(() => null) } : null;
    }
    if (!config.prebuild || !this.kp) return null;
    if (config.pumpOnly && !d.pump) return null;
    const mint = d.bought?.[0]?.mint;
    if (!mint || (config.oneBuyPerMint && this.state.wasCopied(mint, false))) return null;
    const usd = d.spentSol * (solPrice.usd || config.solPriceFallback) + d.spentStableUsd;
    if (usd < config.minLeaderBuyUsd * 0.8) return null; // clearly too small (cached price; decide() re-checks exactly)
    return { mint, promise: prepareBuy(this.kp, mint, this.bal?.sol ?? null) };
  }

  async detect(sig, logs) {
    // FAST PATH: pump.fun bonding-curve buy visible directly in the live logs.
    if (config.fastPath && logs) {
      const evs = leaderPumpBuys(logs, config.leader);
      if (evs.length) {
        return {
          fast: true,
          spentSol: evs.reduce((a, e) => a + e.solAmount, 0) / 1e9,
          spentStableUsd: 0,
          pump: true, // fast path only ever sees pump.fun bonding-curve trades
          blockTime: evs[0].timestamp || Math.floor(Date.now() / 1000),
          bought: evs.map((e) => ({ mint: e.mint, amount: e.tokenAmount / 1e6, raw: e.tokenAmount })),
        };
      }
      const sells = this.wantSells() ? leaderPumpSells(logs, config.leader) : [];
      if (sells.length) {
        return {
          kind: 'sell',
          fast: true,
          receivedSol: sells.reduce((a, e) => a + e.solAmount, 0) / 1e9,
          receivedStableUsd: 0,
          blockTime: sells[0].timestamp,
          sold: sells.map((e) => ({ mint: e.mint, amount: e.tokenAmount / 1e6 })),
        };
      }
    }
    // Normal path: load the full transaction (PumpSwap, Raydium, Jupiter, Axiom routes...).
    const tx = await getTransaction(sig);
    if (!tx) {
      this.log(`could not load tx ${sig}`);
      return null;
    }
    return detectBuy(tx, config.leader) || (this.wantSells() ? detectSell(tx, config.leader) : null);
  }

  /**
   * "Decu SOLD" alert: the bot never sells, but tells you the moment he sells a coin
   * the bot copied for you, so you can decide whether to sell too (e.g. in Axiom).
   */
  async onLeaderSell(s, sig) {
    const dry = config.dryRun;
    for (const x of s.sold) {
      if (!this.state.wasCopied(x.mint, dry)) continue; // only coins you actually hold via the bot
      if (dry && this.paper) this.paper.onLeaderSell(x.mint, (s.blockTime || Date.now() / 1000) * 1000).catch((e) => this.log(`paper sell error: ${e.message}`));
      if (!config.alertLeaderSells) continue;
      const key = `${x.mint}:${Math.floor(Date.now() / 60_000)}`; // at most one alert per coin per minute
      if (this.sellAlerted?.has(key)) continue;
      (this.sellAlerted ||= new Set()).add(key);
      const copied = this.state.bucket(dry).copied[x.mint];
      const heldMin = copied?.at ? Math.round((Date.now() - copied.at) / 60_000) : null;
      this.journal({ sig, mint: x.mint, action: 'leader-sold', receivedSol: +s.receivedSol.toFixed(4), dry });
      await notify({
        title: `${dry ? '[DRY RUN] ' : ''}${config.leaderLabel} SOLD a coin you copied`,
        body: `${config.leaderLabel} just sold ${x.amount.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens for ${s.receivedSol.toFixed(3)} SOL\nToken: ${x.mint}${heldMin !== null ? `\nYou copied it ${heldMin} min ago` : ''}\nThe bot does NOT sell. Sell in Axiom/Phantom if you want out.`,
        priority: 5,
        tags: ['rotating_light', 'chart_with_downwards_trend'],
        click: links.pump(x.mint),
        actions: [{ label: 'pump.fun', url: links.pump(x.mint) }, { label: 'Chart', url: links.dex(x.mint) }, { label: 'His tx', url: links.tx(sig) }],
      });
    }
  }

  /** Cached wallet balance (refreshed every 20 s and after each buy) to keep RPC calls off the hot path. */
  async balance() {
    if (!this.kp) return null;
    if (this.bal && Date.now() - this.bal.at < 20_000) return this.bal.sol;
    const sol = await getBalanceSol(this.kp.publicKey).catch(() => null);
    if (sol !== null) this.bal = { sol, at: Date.now() };
    return sol;
  }

  async decide(buy, sig, via, t0, prepared = null) {
    const solUsd = await getSolUsd();
    const leaderUsd = buy.spentSol * solUsd + buy.spentStableUsd;
    const ageSec = buy.blockTime ? Date.now() / 1000 - buy.blockTime : 0;
    const dry = config.dryRun;
    via = buy.fast ? `${via}+fast` : via;

    for (const b of buy.bought) {
      const base = { sig, via, mint: b.mint, leaderSol: +buy.spentSol.toFixed(4), leaderUsd: Math.round(leaderUsd), dry };
      const skip = async (reason, alert = false) => {
        this.log(`skip ${b.mint.slice(0, 6)}… ${config.leaderLabel} $${Math.round(leaderUsd)}: ${reason}`);
        this.journal({ ...base, action: 'skip', reason });
        if (alert && config.notifySkips)
          await notify({ title: `${config.leaderLabel} bought, NOT copied`, body: `${config.leaderLabel} spent ${buy.spentSol.toFixed(3)} SOL (~$${Math.round(leaderUsd)})\nToken: ${b.mint}\nReason: ${reason}`, priority: 3, tags: ['pause_button'], click: links.pump(b.mint), actions: [{ label: 'pump.fun', url: links.pump(b.mint) }, { label: 'His tx', url: links.tx(sig) }] });
        return { action: 'skip', reason };
      };

      if (config.pumpOnly && !buy.pump) { await skip('not a pump.fun trade (PUMP_ONLY=true)'); continue; }
      if (leaderUsd < config.minLeaderBuyUsd) { await skip(`his buy $${leaderUsd.toFixed(0)} < $${config.minLeaderBuyUsd} minimum`); continue; }
      if (ageSec > config.maxSignalAgeSec) { await skip(`signal is ${Math.round(ageSec)}s old (max ${config.maxSignalAgeSec}s)`); continue; }
      if (config.oneBuyPerMint && this.state.wasCopied(b.mint, dry)) { await skip('already copied this coin (first buy per coin only)'); continue; }
      const spent = this.state.spentToday(dry);
      if (spent + config.buySol > config.dailyCapSol + 1e-9) {
        const first = !this.state.capNotifiedToday();
        if (first) this.state.markCapNotified();
        await skip(`daily cap reached (${spent.toFixed(2)}/${config.dailyCapSol} SOL)`, first);
        continue;
      }

      let balance = null;
      if (this.kp) {
        balance = await this.balance();
        if (!dry && (balance === null || balance - config.buySol < config.minSolReserve)) {
          await skip(`burner wallet too low (${balance === null ? '?' : balance.toFixed(3)} SOL; needs ${config.buySol} + ${config.minSolReserve} reserve)`, true);
          continue;
        }
      }

      if (dry) {
        this.state.record(b.mint, config.buySol, { sig }, true);
        this.journal({ ...base, action: 'dry-buy', decisionMs: Date.now() - t0 });
        if (this.paper) {
          const hisPrice = b.raw ? buy.spentSol / b.raw : null;
          this.paper
            .open({ mint: b.mint, leaderSig: sig, leaderSol: buy.spentSol, leaderUsd, hisPrice, detectedAt: t0, buildQuote: prepared?.mint === b.mint && prepared.paperQuote ? prepared.paperQuote : quoteBuy(b.mint, config.buySol * 0.995).catch(() => null) })
            .catch((e) => this.log(`paper buy error: ${e.message}`));
        }
        await notify({
          title: `[DRY RUN] Would copy ${config.leaderLabel}`,
          body: `${config.leaderLabel} bought ~$${Math.round(leaderUsd)} (${buy.spentSol.toFixed(3)} SOL)\nWould buy ${config.buySol} SOL\nToken: ${b.mint}\nSeen ${((Date.now() - t0) / 1000).toFixed(1)}s after detection, ${Math.round(ageSec)}s after his tx`,
          priority: 4,
          tags: ['eyes'],
          click: links.pump(b.mint),
          actions: [{ label: 'pump.fun', url: links.pump(b.mint) }, { label: 'Chart', url: links.dex(b.mint) }, { label: 'His tx', url: links.tx(sig) }],
        });
        continue;
      }

      // LIVE: reserve the spend and the coin first, so a crash mid-trade can't double-buy.
      this.state.record(b.mint, config.buySol, { sig, pending: true }, false);
      const r = await executeBuy(this.kp, b.mint, balance, prepared?.mint === b.mint ? prepared.promise : null);
      this.bal = null; // force a fresh balance next time
      const latency = ((Date.now() - t0) / 1000).toFixed(1);
      const timing = { sinceHisTxSec: buy.blockTime ? +(Date.now() / 1000 - buy.blockTime).toFixed(1) : null, buildMs: r.buildMs, sendMs: r.sendMs, confirmMs: r.confirmMs, tipSol: r.tipSol, prebuilt: prepared?.mint === b.mint };
      this.journal({ ...base, action: r.ok ? 'buy' : 'buy-failed', mySig: r.signature, route: r.route, error: r.error, latencySec: +latency, ...timing, tipError: r.tipError });
      if (r.ok) {
        this.state.record(b.mint, 0, { sig, mySig: r.signature, pending: false }, false);
        await notify({
          title: `Copied ${config.leaderLabel}: bought ${config.buySol} SOL`,
          body: `${config.leaderLabel} bought ~$${Math.round(leaderUsd)}\nYou bought ${config.buySol} SOL via ${r.route}${r.tipSol ? ' + Sender tip' : ''} (${via}${timing.prebuilt ? ', prebuilt' : ''}), confirmed ${latency}s after his trade was seen (build ${r.buildMs ?? '?'}ms, send ${r.sendMs ?? '?'}ms)\nToken: ${b.mint}\nToday: ${this.state.spentToday(false).toFixed(2)}/${config.dailyCapSol} SOL`,
          priority: 5,
          tags: ['white_check_mark', 'moneybag'],
          click: links.pump(b.mint),
          actions: [{ label: 'My tx', url: links.tx(r.signature) }, { label: 'pump.fun', url: links.pump(b.mint) }, { label: 'Chart', url: links.dex(b.mint) }],
        });
      } else {
        // Release the reservation only when we are sure no tokens were bought
        // (never sent, or landed and failed e.g. slippage). Unknown outcome keeps it reserved.
        if (!r.signature || r.notBought) {
          this.state.refund(config.buySol, false);
          this.state.forget(b.mint, false);
        }
        await notify({
          title: `Copy buy FAILED`,
          body: `${config.leaderLabel} bought ~$${Math.round(leaderUsd)}\nToken: ${b.mint}\nError: ${r.error}${r.signature ? `\nTx: ${links.tx(r.signature)}` : ''}`,
          priority: 4,
          tags: ['x'],
          click: r.signature ? links.tx(r.signature) : links.pump(b.mint),
        });
      }
    }
  }
}


// ===== watcher.js =====
// Watches the leader wallet two ways at once:
//  1. WebSocket logsSubscribe (fast, ~real-time)
//  2. backup polling of getSignaturesForAddress (catches anything missed during reconnects)
// Both feed the same callback; the copier de-duplicates by signature.

function startWatcher(onSignature, { log = console.log, status = {} } = {}) {
  let ws;
  let stopped = false;
  let backoff = 1000;
  let lastMsg = Date.now();
  const seenPoll = new Set();
  let truncatedLogAt = 0;

  const connect = () => {
    if (stopped) return;
    try {
      ws = new WebSocket(config.wsUrl);
    } catch (e) {
      log(`websocket error: ${redact(e.message)}`);
      return setTimeout(connect, backoff);
    }
    ws.onopen = () => {
      backoff = 1000;
      lastMsg = Date.now();
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [config.leader] }, { commitment: 'confirmed' }] }));
      status.websocket='subscribing';
    };
    ws.onmessage = (ev) => {
      lastMsg = Date.now();
      let m;
      try {
        m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
      } catch {
        return;
      }
      if(m.id===1){ if(m.error){status.websocket='subscription failed';log('subscription failed: '+m.error.message);ws.close();} else {status.websocket='subscribed';log('wallet subscription acknowledged');} }
      const v = m?.params?.result?.value;
      if (m.method === 'logsNotification' && v?.signature && !v.err) onSignature(v.signature, 'ws', v.logs);
    };
    ws.onclose = () => {
      if (stopped) return;
      status.websocket='disconnected';
      log(`websocket closed, reconnecting in ${backoff / 1000}s`);
      setTimeout(connect, backoff);
      backoff = Math.min(backoff * 2, 30000);
    };
    ws.onerror = () => {}; // onclose handles reconnect
  };
  connect();

  // Some providers silently drop idle sockets: recycle after 5 quiet minutes.
  const idle = setInterval(() => {
    if (Date.now() - lastMsg > 5 * 60_000 && ws?.readyState === 1) {
      lastMsg = Date.now();
      ws.close();
    }
  }, 30_000);

  // Re-read a bounded recovery window on every poll. The runtime deduplicates successful
  // detections; failed lookups are retried. Startup replays recent exits as well as buys.
  const poll = async () => {
    if (stopped) return;
    try {
      const horizon=Math.max(config.maxSignalAgeSec,Number(env('MAX_SELL_SIGNAL_AGE_SEC','300')) || 300);
      const cutoff=Date.now()/1000-horizon;
      // His address is flooded: on 2026-10-07 Helius returned 1000 signatures spanning 4 seconds,
      // 85% of them failed transactions by others. Paging back the full horizon is impossible and
      // burns the rate limit, so this poll covers only the last few seconds. With SOLSCAN_API_KEY,
      // the Solscan watcher (his own swaps only) covers the whole horizon.
      const pages=num('HELIUS_POLL_PAGES',config.solscanKey?1:3);
      let before, all=[],done=false,oldest=null;
      for(let page=0;page<pages && !done;page++) {
        const rows=await rpc('getSignaturesForAddress',[config.leader,{limit:1000,commitment:'confirmed',...(before?{before}:{})}]);
        if(!rows?.length)break;
        for(const row of rows) {if(row.blockTime && row.blockTime<cutoff){done=true;break;}oldest=row.blockTime||oldest;all.push(row);}
        before=rows.at(-1).signature;
        if(rows.length<1000)done=true;
      }
      if(!done && oldest && !config.solscanKey && Date.now()-truncatedLogAt>600_000) {truncatedLogAt=Date.now();log(`Helius backup poll reaches back only ${Math.round(Date.now()/1000-oldest)} s (leader address is flooded); set SOLSCAN_API_KEY for full recovery`);}
      status.pollCoverageSec=oldest?Math.round(Date.now()/1000-oldest):null;
      status.lastPoll=new Date().toISOString();
      for(const row of all.reverse()) if(!row.err) onSignature(row.signature,'poll');
    } catch(e) { log('poll error: '+redact(e.message)); }
    if(!stopped)setTimeout(poll,config.pollIntervalMs);
  };
  poll();

  return () => {
    stopped = true;
    clearInterval(idle);
    ws?.close();
  };
}


// ===== backtest.js =====
// BACKTEST: replay the leader's real trades from one day through the bot's rules with an
// imaginary wallet. No transactions are sent. Data: Helius Enhanced Transactions API.
//
// For every buy the bot would have copied, the entry price is what other traders actually paid
// in the seconds AFTER his buy (0.5 s / 1.5 s / 3 s later), because that's when your copy would land.
// Two exits are reported:
//   HOLD   : the bot's real behaviour (it never sells): position valued at the current price.
//   MIRROR : if you had sold when he first sold that coin (+ the same delay).

const H = () => {
  if (!config.heliusKey) throw new Error('Backtest needs HELIUS_API_KEY (free tier is fine): https://dashboard.helius.dev');
  return config.heliusKey;
};
const txUrl = (addr, qs) => `https://api-mainnet.helius-rpc.com/v0/addresses/${addr}/transactions?api-key=${H()}&${new URLSearchParams(qs)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function heliusTxs(addr, qs) {
  for (let i = 0; ; i++) {
    try {
      const r = await http(txUrl(addr, { limit: '100', ...qs }), { timeoutMs: 20000 });
      return Array.isArray(r) ? r : [];
    } catch (e) {
      if (i >= 3 || !/429|5\d\d|timed out/.test(e.message)) throw e;
      await sleep(800 * 2 ** i);
    }
  }
}

// ---------------- time helpers ----------------
/** Unix seconds of local midnight for `ymd` (YYYY-MM-DD) in `tz`. */
function dayStartSec(ymd, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(guess)).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  const asLocal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((guess - (asLocal - guess)) / 1000);
}

// ---------------- reading enhanced transactions ----------------
/** Net SOL (ex network fee) and per-mint token changes for `wallet` in one enhanced tx. */
function walletChanges(tx, wallet) {
  let lamports = 0;
  const tokens = new Map();
  for (const a of tx.accountData || []) {
    if (a.account === wallet) lamports += a.nativeBalanceChange || 0;
    for (const t of a.tokenBalanceChanges || []) {
      if (t.userAccount !== wallet) continue;
      const amt = Number(t.rawTokenAmount?.tokenAmount || 0) / 10 ** (t.rawTokenAmount?.decimals || 0);
      tokens.set(t.mint, (tokens.get(t.mint) || 0) + amt);
    }
  }
  if (tx.feePayer === wallet) lamports += tx.fee || 0;
  const sol = lamports / 1e9 + (tokens.get(WSOL) || 0);
  let stable = 0;
  for (const [m, v] of tokens) if (STABLES[m]) stable += v;
  return { sol, stable, tokens };
}

/** Classify the leader's tx as buy/sell events: [{side, mint, sol, usdStable, tokens, time, sig}] */
/** Helius enhanced tx: did it go through pump.fun or PumpSwap? (source label, or any instruction/inner instruction) */
function heliusTouchesPump(tx) {
  if (/^PUMP/.test(tx.source || '')) return true;
  const ids = [PROGRAMS.PUMP, PROGRAMS.PUMP_AMM];
  return (tx.instructions || []).some((ix) => ids.includes(ix.programId) || (ix.innerInstructions || []).some((x) => ids.includes(x.programId)));
}

function leaderEvents(tx, leader) {
  if (tx.transactionError) return [];
  const pump = heliusTouchesPump(tx);
  const { sol, stable, tokens } = walletChanges(tx, leader);
  const out = [];
  for (const [mint, amt] of tokens) {
    if (mint === WSOL || STABLES[mint] || !amt) continue;
    if (amt > 0 && (sol < -0.001 || stable < -0.5)) out.push({ side: 'buy', mint, sol: Math.max(0, -sol), usdStable: Math.max(0, -stable), tokens: amt, time: tx.timestamp, sig: tx.signature, pump });
    else if (amt < 0 && (sol > 0.0005 || stable > 0.5)) out.push({ side: 'sell', mint, sol: Math.max(0, sol), usdStable: Math.max(0, stable), tokens: -amt, time: tx.timestamp, sig: tx.signature, pump });
  }
  return out;
}

/** Price (SOL per token) of every buy/sell of `mint` in a list of enhanced txs, by the trader (fee payer). */
function tradePrices(txs, mint) {
  const out = [];
  for (const tx of txs) {
    if (tx.transactionError) continue;
    const w = tx.feePayer;
    const { sol, tokens } = walletChanges(tx, w);
    const amt = tokens.get(mint) || 0;
    if (!amt || !sol) continue;
    // Prefer the SOL actually paid to / received from the pool (excludes the trader's tips & priority fees).
    const counter = (tx.tokenTransfers || []).find((t) => t.mint === mint && (amt > 0 ? t.toUserAccount === w : t.fromUserAccount === w));
    const pool = counter ? (amt > 0 ? counter.fromUserAccount : counter.toUserAccount) : null;
    let poolSol = 0;
    if (pool) {
      for (const n of tx.nativeTransfers || []) if ((amt > 0 && n.fromUserAccount === w && n.toUserAccount === pool) || (amt < 0 && n.fromUserAccount === pool && n.toUserAccount === w)) poolSol += n.amount / 1e9;
      for (const t of tx.tokenTransfers || []) if (t.mint === WSOL && ((amt > 0 && t.fromUserAccount === w && t.toUserAccount === pool) || (amt < 0 && t.fromUserAccount === pool && t.toUserAccount === w))) poolSol += Number(t.tokenAmount);
    }
    const solAmt = poolSol > 0 ? poolSol : Math.abs(sol);
    out.push({ side: amt > 0 ? 'buy' : 'sell', time: tx.timestamp, price: solAmt / Math.abs(amt), sig: tx.signature, trader: w });
  }
  return out.sort((a, b) => a.time - b.time);
}

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null;
};

/** Price you would have paid/received at time t: median of the first 3 same-side trades at or after t. */
function priceAt(prices, t, side, excludeTrader) {
  const after = prices.filter((p) => p.time >= t && p.side === side && p.trader !== excludeTrader).slice(0, 3);
  return after.length ? { price: median(after.map((p) => p.price)), time: after[0].time, n: after.length } : null;
}

/** Trades of `mint` from time `fromSec` onward (oldest first), enough to cover `spanSec`. */
async function mintTradesFrom(mint, fromSec, spanSec, maxPages = 3) {
  let all = [];
  let from = fromSec;
  for (let p = 0; p < maxPages; p++) {
    const page = await heliusTxs(mint, { 'sort-order': 'asc', 'gte-time': String(from) });
    const fresh = page.filter((t) => !all.some((x) => x.signature === t.signature));
    all = all.concat(fresh);
    const last = page[page.length - 1]?.timestamp;
    if (page.length < 100 || !last || last >= fromSec + spanSec || !fresh.length) break;
    from = last;
  }
  return all;
}

// ---------------- current prices ----------------
async function currentPricesSol(mints, solUsd) {
  const out = {};
  for (let i = 0; i < mints.length; i += 50) {
    const ids = mints.slice(i, i + 50);
    try {
      const base = config.jupiterApiKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag';
      const r = await http(`${base}/price/v3?ids=${ids.join(',')}`, { headers: config.jupiterApiKey ? { 'x-api-key': config.jupiterApiKey } : {} });
      for (const id of ids) if (r?.[id]?.usdPrice) out[id] = r[id].usdPrice / solUsd;
    } catch {
      /* fall through to DexScreener */
    }
  }
  const missing = mints.filter((m) => out[m] === undefined);
  for (let i = 0; i < missing.length; i += 30) {
    try {
      const r = await http(`https://api.dexscreener.com/tokens/v1/solana/${missing.slice(i, i + 30).join(',')}`);
      for (const p of Array.isArray(r) ? r : []) {
        const m = p.baseToken?.address;
        if (m && out[m] === undefined && p.priceNative && p.quoteToken?.symbol === 'SOL') out[m] = Number(p.priceNative);
        else if (m && out[m] === undefined && p.priceUsd) out[m] = Number(p.priceUsd) / solUsd;
      }
    } catch {
      /* unpriced = treated as worthless */
    }
  }
  return out;
}

// ---------------- the replay ----------------
async function runBacktest({ date, walletUsd = 100, delays = [0.5, 1.5, 3], solUsd, venueFeePct = 1.25, sellFeePct = 1.25, log = console.log }) {
  const tz = config.timezone;
  const start = dayStartSec(date, tz);
  const end = start + 86400;
  const leader = config.leader;

  // 1) all leader transactions that day (newest first, paged with `before`)
  log(`Loading ${config.leaderLabel}'s transactions for ${date} (${tz})…`);
  let txs = [];
  let before;
  for (let page = 0; page < 60; page++) {
    const batch = await heliusTxs(leader, before ? { before } : {});
    if (!batch.length) break;
    txs = txs.concat(batch.filter((t) => t.timestamp >= start && t.timestamp < end));
    before = batch[batch.length - 1].signature;
    if (batch[batch.length - 1].timestamp < start) break;
  }
  const events = txs.flatMap((t) => leaderEvents(t, leader)).sort((a, b) => a.time - b.time);
  const buys = events.filter((e) => e.side === 'buy');
  const sells = events.filter((e) => e.side === 'sell');
  log(`${txs.length} transactions, ${buys.length} buys, ${sells.length} sells across ${new Set(events.map((e) => e.mint)).size} coins.`);

  // 2) which buys the bot would copy (rules other than the wallet balance)
  const seenMint = new Set();
  const candidates = [];
  const skipped = { small: 0, repeat: 0, notPump: 0 };
  for (const b of buys) {
    const usd = b.sol * solUsd + b.usdStable;
    if (config.pumpOnly && !b.pump) {
      skipped.notPump++;
      continue;
    }
    if (usd < config.minLeaderBuyUsd) {
      skipped.small++;
      continue;
    }
    if (config.oneBuyPerMint && seenMint.has(b.mint)) {
      skipped.repeat++;
      continue;
    }
    seenMint.add(b.mint);
    const firstSell = sells.find((s) => s.mint === b.mint && s.time >= b.time);
    candidates.push({ ...b, usd, firstSell });
  }
  log(`${candidates.length} buys pass your rules (${config.pumpOnly ? 'pump.fun only, ' : ''}≥ $${config.minLeaderBuyUsd}, first buy per coin). Pricing each one…`);

  // 3) entry & exit prices from real trades after his
  const maxDelay = Math.max(...delays);
  let done = 0;
  const queue = [...candidates];
  const worker = async () => {
    while (queue.length) {
      const c = queue.shift();
      try {
        const entryTx = await mintTradesFrom(c.mint, c.time, maxDelay + 5);
        const entryPrices = tradePrices(entryTx, c.mint);
        c.entry = Object.fromEntries(delays.map((d) => [d, priceAt(entryPrices, c.time + d, 'buy', leader)]));
        // His price measured the same way as yours (SOL paid to the pool, excluding his tips/fees).
        const hisTx = txs.find((t) => t.signature === c.sig);
        c.hisPrice = (hisTx && tradePrices([hisTx], c.mint)[0]?.price) || (c.sol > 0 && c.tokens > 0 ? c.sol / c.tokens : null);
        if (c.firstSell) {
          const exitTx = await mintTradesFrom(c.mint, c.firstSell.time, maxDelay + 5);
          const exitPrices = tradePrices(exitTx, c.mint);
          c.exit = Object.fromEntries(delays.map((d) => [d, priceAt(exitPrices, c.firstSell.time + d, 'sell', leader)]));
        }
      } catch (e) {
        c.error = e.message;
      }
      if (++done % 10 === 0) log(`  priced ${done}/${candidates.length}`);
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  const nowPrice = await currentPricesSol([...new Set(candidates.map((c) => c.mint))], solUsd);

  // 4) simulate each delay scenario
  const perCopyCost = config.priorityFeeSol + 0.000005; // network + priority fee (ATA rent ~0.002 is refundable, excluded)
  const ppFee = 0.005; // PumpPortal 0.5%
  const scenarios = delays.map((d) => {
    const trades = candidates.map((c) => {
      const e = c.entry?.[d];
      if (!e) return { ...c, d, status: c.error ? 'no data' : 'no trades after his buy' };
      const tokens = (config.buySol * (1 - ppFee - venueFeePct / 100)) / e.price;
      const holdSol = (nowPrice[c.mint] || 0) * tokens * (1 - sellFeePct / 100 - ppFee);
      const x = c.exit?.[d];
      const mirrorSol = x ? x.price * tokens * (1 - sellFeePct / 100 - ppFee) : holdSol;
      return {
        ...c,
        d,
        status: 'ok',
        entryPrice: e.price,
        entryGapPct: c.hisPrice ? (e.price / c.hisPrice - 1) * 100 : null,
        tokens,
        cost: config.buySol + perCopyCost,
        holdSol,
        mirrorSol,
        mirrorExited: !!x,
        mirrorExitTime: x ? c.firstSell.time + d : null,
        priced: nowPrice[c.mint] !== undefined,
      };
    });

    // Wallet replay in time order. HOLD: cash only goes down. MIRROR: sale proceeds come back.
    const sim = (mode) => {
      let cash = walletUsd / solUsd;
      let spentToday = 0;
      const taken = [];
      const pending = []; // mirror exits waiting to pay out
      for (const t of trades.filter((x) => x.status === 'ok').sort((a, b) => a.time - b.time)) {
        if (mode === 'mirror') {
          for (let i = pending.length - 1; i >= 0; i--) if (pending[i].at <= t.time) cash += pending.splice(i, 1)[0].sol;
        }
        if (spentToday + config.buySol > config.dailyCapSol + 1e-9) continue;
        if (cash - t.cost < config.minSolReserve) continue;
        cash -= t.cost;
        spentToday += config.buySol;
        taken.push(t);
        if (mode === 'mirror' && t.mirrorExited) pending.push({ at: t.mirrorExitTime, sol: t.mirrorSol });
      }
      const value = (x) => (mode === 'mirror' ? (x.mirrorExited ? 0 : x.holdSol) : x.holdSol); // open positions
      const openValue = taken.reduce((s, x) => s + value(x), 0);
      const realized = mode === 'mirror' ? pending.reduce((s, p) => s + p.sol, 0) : 0; // exits after the last buy
      const endSol = cash + openValue + realized;
      return { copies: taken.length, startSol: walletUsd / solUsd, endSol, pnlSol: endSol - walletUsd / solUsd, taken };
    };

    const ok = trades.filter((t) => t.status === 'ok');
    const invested = ok.reduce((s, t) => s + t.cost, 0);
    return {
      delay: d,
      trades,
      hold: sim('hold'),
      mirror: sim('mirror'),
      unlimited: {
        copies: ok.length,
        invested,
        holdPnl: ok.reduce((s, t) => s + t.holdSol, 0) - invested,
        mirrorPnl: ok.reduce((s, t) => s + t.mirrorSol, 0) - invested,
        winnersHold: ok.filter((t) => t.holdSol > t.cost).length,
        winnersMirror: ok.filter((t) => t.mirrorSol > t.cost).length,
        avgEntryGapPct: median(ok.map((t) => t.entryGapPct).filter((x) => x !== null)),
      },
    };
  });

  // 5) Decu's own result on the same coins (today's buys/sells + what's left, valued now)
  const his = {};
  for (const e of events) {
    const h = (his[e.mint] ||= { in: 0, out: 0, tokens: 0 });
    if (e.side === 'buy') {
      h.out += e.sol;
      h.tokens += e.tokens;
    } else {
      h.in += e.sol;
      h.tokens -= e.tokens;
    }
  }
  const copiedMints = new Set(candidates.map((c) => c.mint));
  let hisPnl = 0;
  let hisInvested = 0;
  for (const [m, h] of Object.entries(his)) {
    if (!copiedMints.has(m)) continue;
    hisInvested += h.out;
    hisPnl += h.in - h.out + Math.max(0, h.tokens) * (nowPrice[m] || 0);
  }

  return { venueFeePct, sellFeePct, date, tz, start, end, solUsd, walletUsd, leader, txCount: txs.length, buys: buys.length, sells: sells.length, skipped, candidates: candidates.length, scenarios, his: { invested: hisInvested, pnl: hisPnl }, generatedAt: new Date().toISOString() };
}

// ---------------- reporting ----------------
const f = (n, d = 3) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(d));
const usd = (sol, px) => (Number.isFinite(sol) ? `${sol < 0 ? '-' : ''}$${Math.abs(sol * px).toFixed(2)}` : '—');
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');

function toMarkdown(r) {
  const L = [];
  L.push(`# Copy-trade backtest: ${config.leaderLabel}, ${r.date}`);
  L.push('');
  L.push(`Imaginary wallet: **$${r.walletUsd}** (${f(r.walletUsd / r.solUsd, 3)} SOL at $${r.solUsd.toFixed(2)}/SOL). Rules: ${config.buySol} SOL per copy, his buy ≥ $${config.minLeaderBuyUsd}, ${config.oneBuyPerMint ? 'first buy per coin' : 'every buy'}, ${config.dailyCapSol} SOL/day cap. No real trades were made.`);
  L.push('');
  L.push(`His day: ${r.txCount} transactions, ${r.buys} buy(s), ${r.sells} sell(s). Skipped: ${r.skipped.notPump ?? 0} non-pump.fun buys, ${r.skipped.small} buys under $${config.minLeaderBuyUsd}, ${r.skipped.repeat} repeat buys. **${r.candidates} buys qualify.**`);
  L.push('');
  L.push('## Your $100 wallet');
  L.push('');
  L.push('| You land after him | Copies made | HOLD (what the bot does): end value | HOLD P&L | MIRROR (sell when he sells): end value | MIRROR P&L |');
  L.push('|---|---|---|---|---|---|');
  for (const s of r.scenarios) {
    L.push(`| ${s.delay}s | ${s.hold.copies} | ${usd(s.hold.endSol, r.solUsd)} | **${usd(s.hold.pnlSol, r.solUsd)}** (${pct(s.hold.pnlSol, s.hold.startSol)}) | ${usd(s.mirror.endSol, r.solUsd)} | **${usd(s.mirror.pnlSol, r.solUsd)}** (${pct(s.mirror.pnlSol, s.mirror.startSol)}) |`);
  }
  L.push('');
  L.push('## Every qualifying copy (no wallet limit)');
  L.push('');
  L.push('| You land after him | Copies | Invested | HOLD P&L | Winners (hold) | MIRROR P&L | Winners (mirror) | Your price vs his (median; + = you paid more) |');
  L.push('|---|---|---|---|---|---|---|---|');
  for (const s of r.scenarios) {
    const u = s.unlimited;
    L.push(`| ${s.delay}s | ${u.copies} | ${usd(u.invested, r.solUsd)} | ${usd(u.holdPnl, r.solUsd)} (${pct(u.holdPnl, u.invested)}) | ${u.winnersHold}/${u.copies} | ${usd(u.mirrorPnl, r.solUsd)} (${pct(u.mirrorPnl, u.invested)}) | ${u.winnersMirror}/${u.copies} | ${u.avgEntryGapPct === null ? '—' : `${u.avgEntryGapPct >= 0 ? '+' : ''}${u.avgEntryGapPct.toFixed(1)}%`} |`);
  }
  L.push('');
  L.push(`**${config.leaderLabel} himself on the same coins today:** invested ${usd(r.his.invested, r.solUsd)}, P&L ${usd(r.his.pnl, r.solUsd)} (${pct(r.his.pnl, r.his.invested)}), counting today's buys and sells plus what he still holds, at current prices.`);
  L.push('');
  const s = r.scenarios.find((x) => x.delay === 1.5) || r.scenarios[0];
  L.push(`## Trade by trade (landing ${s.delay}s after him)`);
  L.push('');
  L.push('| Time | Coin | His buy | His price | Your price | Gap | Hold value now | He sold? | Mirror value |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const t of s.trades) {
    const time = new Date(t.time * 1000).toLocaleTimeString('en-US', { timeZone: r.tz, hour: '2-digit', minute: '2-digit' });
    if (t.status !== 'ok') {
      L.push(`| ${time} | \`${t.mint.slice(0, 6)}…\` | $${t.usd.toFixed(0)} | | | | ${t.status} | | |`);
      continue;
    }
    L.push(`| ${time} | \`${t.mint.slice(0, 6)}…\` | $${t.usd.toFixed(0)} | ${t.hisPrice ? t.hisPrice.toExponential(3) : '—'} | ${t.entryPrice.toExponential(3)} | ${t.entryGapPct === null ? '—' : `${t.entryGapPct >= 0 ? '+' : ''}${t.entryGapPct.toFixed(1)}%`} | ${usd(t.holdSol, r.solUsd)}${t.priced ? '' : ' (no price: dead?)'} | ${t.mirrorExited ? 'yes' : 'no'} | ${usd(t.mirrorSol, r.solUsd)} |`);
  }
  L.push('');
  L.push('### How this was calculated');
  L.push(`- Entry price = median price of the first 3 buys by *other* traders at least N seconds after his buy (that's when your copy lands). Fees applied: PumpPortal 0.5%, venue ${r.venueFeePct}%, ${config.priorityFeeSol} SOL priority fee per copy.`);
  L.push(`- HOLD values each position at the current price (Jupiter → DexScreener), minus ${r.sellFeePct}% + 0.5% sell fees. A coin with no price is counted as worth 0.`);
  L.push('- MIRROR sells 100% at his first sell of that coin (+ the same delay), at the price other sellers got. Sale proceeds return to the wallet and can fund later copies.');
  L.push('- Not modelled: price impact of your own 0.1 SOL, failed/late landings, and sell slippage on illiquid coins. Real results are usually somewhat worse than this.');
  L.push(`- SOL/USD uses today's current price for all conversions. Generated ${r.generatedAt}.`);
  return L.join('\n');
}

function toCsv(r) {
  const rows = [['delay_s', 'time_utc', 'mint', 'his_usd', 'his_sig', 'status', 'his_price_sol', 'entry_price_sol', 'entry_gap_pct', 'tokens', 'cost_sol', 'hold_value_sol', 'mirror_exited', 'mirror_value_sol']];
  for (const s of r.scenarios)
    for (const t of s.trades)
      rows.push([s.delay, new Date(t.time * 1000).toISOString(), t.mint, t.usd?.toFixed(2), t.sig, t.status, t.hisPrice ?? '', t.entryPrice ?? '', t.entryGapPct?.toFixed(2) ?? '', t.tokens ?? '', t.cost ?? '', t.holdSol ?? '', t.mirrorExited ?? '', t.mirrorSol ?? '']);
  return rows.map((r2) => r2.join(',')).join('\n');
}

// ---------------- export: the leader's trades over N days, for analysis ----------------
/** Loads every buy/sell the leader made in the last `days` days. Returns normalized rows (oldest first). */
async function exportLeaderTrades({ days = 7, solUsd, log = console.log, maxPages = 200 }) {
  const leader = config.leader;
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  let txs = [];
  let before;
  for (let page = 0; page < maxPages; page++) {
    const batch = await heliusTxs(leader, before ? { before } : {});
    if (!batch.length) break;
    txs = txs.concat(batch.filter((t) => t.timestamp >= since));
    before = batch[batch.length - 1].signature;
    if (batch[batch.length - 1].timestamp < since) break;
    if (page % 10 === 9) log(`  loaded ${txs.length} transactions…`);
  }
  const rows = [];
  for (const tx of txs) {
    for (const e of leaderEvents(tx, leader)) {
      const p = tradePrices([tx], e.mint)[0]?.price ?? (e.tokens ? e.sol / e.tokens : null);
      rows.push({
        time_utc: new Date(e.time * 1000).toISOString(),
        side: e.side,
        mint: e.mint,
        sol: +e.sol.toFixed(6),
        usd_est: +((e.sol * solUsd) + e.usdStable).toFixed(2),
        tokens: e.tokens,
        price_sol: p,
        venue: tx.source || '',
        pump: e.pump ? 'yes' : 'no',
        signature: e.sig,
      });
    }
  }
  return { rows: rows.sort((a, b) => a.time_utc.localeCompare(b.time_utc)), txCount: txs.length, days, solUsd };
}

function rowsToCsv(rows) {
  const cols = ['time_utc', 'side', 'mint', 'sol', 'usd_est', 'tokens', 'price_sol', 'venue', 'pump', 'signature'];
  return [cols.join(','), ...rows.map((r) => cols.map((c) => r[c] ?? '').join(','))].join('\n');
}


// ===== commands.js =====
// All command-line entry points live here so they can be bundled into one file.

// ===== diagnose.js =====
// DIAGNOSE: Helius and Solscan side by side. Read-only; nothing is signed or sent.
//  1. both providers answer, latency, and how far Solscan's index trails Helius
//  2. SOL price from every source, and how far they disagree
//  3. leader profile from Solscan's decoded swaps (what he trades, how long he holds)
//  4. Helius coverage: every swap Solscan saw must be in Helius' signature history
//  5. parser cross-check: the bot's own detection on Helius data vs Solscan's decoding

async function diagnose({ pages = 2, verify = 15, log = console.log } = {}) {
  const r = { at: new Date().toISOString(), leader: config.leader, providers: {}, prices: {}, warnings: [] };
  const warn = (m) => { r.warnings.push(m); log(`WARN ${m}`); };
  const ok = (name, detail) => log(`OK   ${name}: ${detail}`);
  const timed = async (fn) => { const t0 = Date.now(); return { v: await fn(), ms: Date.now() - t0 }; };

  try {
    const { v, ms } = await timed(() => rpc('getSlot', [{ commitment: 'confirmed' }]));
    r.providers.helius = { ok: true, slot: v, latencyMs: ms, publicRpc: config.rpcIsPublic };
    ok('Helius RPC', `slot ${v} in ${ms} ms`);
    if (config.rpcIsPublic) warn('using the public Solana RPC: set HELIUS_API_KEY');
  } catch (e) {
    r.providers.helius = { ok: false, error: redact(e.message) };
    warn(`Helius RPC failed: ${redact(e.message)}`);
  }
  if (!solscan.enabled) {
    r.providers.solscan = { ok: false, error: 'SOLSCAN_API_KEY not set' };
    warn('SOLSCAN_API_KEY not set: Solscan checks skipped (key: https://solscan.io/apis)');
  } else {
    try {
      const { v, ms } = await timed(() => solscan.lastBlock());
      const slot = v?.current_slot ?? v?.block_id ?? null;
      const lag = r.providers.helius?.slot && slot ? r.providers.helius.slot - slot : null;
      r.providers.solscan = { ok: true, slot, latencyMs: ms, lagSlots: lag };
      ok('Solscan API', `indexed slot ${slot} in ${ms} ms${lag !== null ? ` (${lag} slots, about ${(lag * 0.4).toFixed(1)} s behind Helius)` : ''}`);
      if (lag !== null && lag > 150) warn(`Solscan index is ${lag} slots behind: its watcher will report gaps late`);
    } catch (e) {
      r.providers.solscan = { ok: false, error: redact(e.message) };
      warn(`Solscan API failed: ${redact(e.message)}`);
    }
  }

  for (const [name, fn] of SOL_PRICE_SOURCES) {
    try { const v = await fn(); if (v > 0) r.prices[name] = v; } catch { /* reported below */ }
  }
  const px = Object.values(r.prices);
  const solUsd = px.length ? px.sort((a, b) => a - b)[px.length >> 1] : config.solPriceFallback;
  if (!px.length) warn('no live SOL price source answered');
  else {
    const spread = (Math.max(...px) - Math.min(...px)) / Math.min(...px);
    ok('SOL price', Object.entries(r.prices).map(([k, v]) => `${k} $${v.toFixed(2)}`).join(', ') + ` (spread ${(spread * 100).toFixed(2)}%)`);
    if (spread > 0.01) warn(`SOL price sources disagree by ${(spread * 100).toFixed(1)}%: USD filters may misfire`);
  }
  r.solUsd = solUsd;

  if (!solscan.enabled || !r.providers.solscan?.ok) return r;

  const activities = [];
  for (let page = 1; page <= pages; page++) {
    const rows = await solscan.defiActivities(config.leader, { page, pageSize: 100 });
    if (!Array.isArray(rows) || !rows.length) break;
    activities.push(...rows);
    if (rows.length < 100) break;
  }
  const swaps = swapsFromActivities(activities, { solUsd });
  const profile = leaderProfile(swaps, { minUsd: config.minLeaderBuyUsd });
  r.profile = { ...profile, roundsDetail: undefined, coins: profile.roundsDetail.map(({ mint, quote, buys, sells, buySol, sellSol, pnlSol, holdSec, windowSec, copyUsd, partial }) => ({ mint, quote, buys, sells, buySol, sellSol, pnlSol, holdSec, windowSec, copyUsd, partial })) };
  const hrs = profile.from ? ((profile.to - profile.from) / 3600).toFixed(1) : 0;
  ok('leader swaps (Solscan)', `${swaps.length} swaps in ${hrs} h, ${profile.rounds} coins, ${profile.wins}/${profile.closedRounds} closed coins in profit, ${profile.pnlSol >= 0 ? '+' : ''}${profile.pnlSol.toFixed(3)} SOL`);
  ok('pairs', Object.entries(profile.quotes).map(([q, n]) => `${q} ${n}`).join(', ') + (profile.pumpPaired ? ` (PUMP-paired: he pays SOL through a SOL→PUMP→coin route; check PumpPortal can build these before relying on them)` : ''));
  if (profile.copyableRounds) ok('copy window', `median ${profile.medianWindowSec?.toFixed(0)} s from his first buy >= $${config.minLeaderBuyUsd} to his first sell; ${profile.windowUnder10s}/${profile.copyableRounds} under 10 s, ${profile.windowUnder30s}/${profile.copyableRounds} under 30 s`);
  if (profile.pumpPaired && profile.pumpPaired / Math.max(1, profile.rounds) > 0.2) warn(`${profile.pumpPaired}/${profile.rounds} of his coins are PUMP-paired: run "check --mint <one of them>" to confirm PumpPortal can build that route`);

  if (r.providers.helius?.ok && swaps.length) {
    // His address is flooded (≈250 signatures/s), so a few pages of Helius history reach back only
    // minutes. Compare just the swaps inside the span Helius actually returned.
    const oldest = Math.min(...swaps.map((s) => s.time));
    const sigs = new Set();
    let before, reached = Infinity, complete = false;
    for (let page = 0; page < 5; page++) {
      const rows = await rpc('getSignaturesForAddress', [config.leader, { limit: 1000, ...(before ? { before } : {}) }]);
      if (!rows?.length) { complete = true; break; }
      for (const x of rows) sigs.add(x.signature);
      before = rows.at(-1).signature;
      reached = Math.min(reached, rows.at(-1).blockTime ?? reached);
      if (reached < oldest || rows.length < 1000) { complete = true; break; }
    }
    const inSpan = swaps.filter((s) => complete || s.time >= reached);
    const missing = inSpan.filter((s) => !sigs.has(s.sig));
    r.coverage = { solscanSwaps: swaps.length, comparedSwaps: inSpan.length, heliusSignatures: sigs.size, heliusReachedBackSec: Number.isFinite(reached) ? Math.round(Date.now() / 1000 - reached) : null, missingFromHelius: missing.map((s) => s.sig) };
    if (!inSpan.length) ok('Helius coverage', `5000 Helius signatures reach back only ${r.coverage.heliusReachedBackSec} s and none of his swaps fall in that span (his address is flooded); nothing to compare`);
    else if (missing.length) warn(`${missing.length}/${inSpan.length} swap(s) Solscan saw are missing from Helius history: ${missing.slice(0, 3).map((s) => s.sig.slice(0, 10)).join(', ')}`);
    else ok('Helius coverage', `all ${inSpan.length} Solscan swaps in the compared span are in Helius history`);

    const results = [];
    for (const s of swaps.slice(0, verify)) {
      const tx = await getTransaction(s.sig, 2).catch(() => null);
      if (!tx) { results.push({ sig: s.sig, ok: false, reason: 'Helius returned no transaction' }); continue; }
      results.push(compareDetection(s, normalize(tx, config.leader, detectBuy, detectSell)));
    }
    const bad = results.filter((x) => !x.ok);
    r.parserCheck = { checked: results.length, mismatches: bad };
    if (bad.length) { warn(`bot parser disagrees with Solscan on ${bad.length}/${results.length} swaps`); for (const b of bad.slice(0, 5)) log(`     ${b.sig.slice(0, 12)}…  ${b.reason}`); }
    else ok('parser cross-check', `bot detection matches Solscan on ${results.length}/${results.length} recent swaps`);
  }
  return r;
}

async function runDiagnoseCmd(argv = process.argv) {
  const r = await diagnose({ pages: Number(argVal(argv, 'pages', 2)), verify: Number(argVal(argv, 'verify', 15)) });
  const name = `diagnose-${dayKey()}.json`;
  fs.writeFileSync(name, JSON.stringify(r, null, 1));
  console.log(`\n${r.warnings.length ? `${r.warnings.length} warning(s).` : 'No warnings.'} Full report: ${name}`);
}

const argVal = (argv, name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : d;
};

/** Start the bot (or run the --check self-test). */
async function runBot({ check: checkOnly = false, demo = false } = {}) {
  const errors = validateConfig();
  if (errors.length && !demo) throw new Error(errors.join('; '));
  let kp = config.privateKey ? loadKeypair(config.privateKey) : null;
  if (checkOnly) {
    let failed = 0;
    const step = async (name, fn) => { try { console.log('OK '+name+': '+await fn()); } catch(e) { failed++; console.error('FAIL '+name+': '+redact(e.message)); } };
    await step('RPC', async()=>await rpc('getSlot',[]));
    await step('leader history',async()=>(await rpc('getSignaturesForAddress',[config.leader,{limit:3}])).length+' transactions');
    await step('SOL price (live)',async()=>'$'+(await fetchSolUsdLive()).toFixed(2));
    await step('WebSocket subscription',()=>new Promise((resolve,reject)=>{
      const ws=new WebSocket(config.wsUrl),t=setTimeout(()=>{ws.close();reject(new Error('subscription timeout'));},8000);
      ws.onopen=()=>ws.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'logsSubscribe',params:[{mentions:[config.leader]},{commitment:'confirmed'}]}));
      ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===1){clearTimeout(t);ws.close();m.error?reject(new Error(m.error.message)):resolve('acknowledged '+m.result);}};
      ws.onerror=()=>{clearTimeout(t);ws.onerror=null;ws.onmessage=null;try{ws.close();}catch{}reject(new Error('connection failed'));};
    }));
    if(kp) await step('wallet balance',async()=>await getBalanceSol(kp.publicKey));
    // ---- GO-LIVE PREFLIGHT (nothing is ever sent) ----
    const need=config.buySol*(1+config.slippagePct/100)+config.tipSol+config.priorityFeeSol+0.005+config.minSolReserve;
    if(kp) await step('enough SOL for one copy',async()=>{const b=await getBalanceSol(kp.publicKey);if(b<need)throw new Error(`${b.toFixed(4)} SOL < ${need.toFixed(4)} needed (buy + slippage + fees + reserve)`);return `${b.toFixed(4)} SOL >= ${need.toFixed(4)} (about ${Math.floor((b-config.minSolReserve)/(need-config.minSolReserve))} copies)`;});
    if(solscan.enabled) await step('Solscan API (second watcher)',async()=>{const t0=Date.now();const b=await solscan.lastBlock();const a=await solscan.defiActivities(config.leader,{pageSize:10});return `slot ${b?.current_slot ?? '?'}, ${Array.isArray(a)?a.length:0} recent leader swaps, ${Date.now()-t0} ms`;});
    else console.log('WARN Solscan: SOLSCAN_API_KEY not set. The bot runs on Helius alone (no second watcher, no gap alerts).');
    await step('fast RPC (Helius)',async()=>{if(config.rpcIsPublic)throw new Error('public RPC: set HELIUS_API_KEY');return 'private RPC configured';});
    await step('phone alerts',async()=>{if(!config.ntfyTopic)throw new Error('NTFY_TOPIC not set');await notify({title:'Copy bot check',body:'If you see this, alerts work.',tags:['bell']});return 'test alert sent: check your phone';});
    if(!config.dryRun){
      await step('dashboard token',async()=>{const t=env('DASHBOARD_TOKEN');if(t.length<24)throw new Error('DASHBOARD_TOKEN must be 24+ characters for LIVE');return 'set';});
      await step('live state file',async()=>{const f=env('ENGINE_STATE_FILE','engine-live.json');if(/paper|demo/i.test(f))throw new Error(`ENGINE_STATE_FILE (${f}) looks like a paper/demo file; use e.g. engine-live.json`);return f;});
    }
    if(kp){
      const mint=argVal(process.argv,'mint','9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump');
      await step(`real ${config.buySol} SOL buy: build + tip + sign + safety simulation (NOT sent) on ${mint.slice(0,6)}…`,async()=>{
        let bytes=await http('https://pumpportal.fun/api/trade-local',{method:'POST',raw:true,body:{publicKey:kp.publicKey,action:'buy',mint,amount:config.buySol,denominatedInSol:'true',slippage:config.slippagePct,priorityFee:config.priorityFeeSol,pool:'auto'}});
        if(config.tipSol>0) bytes=addTransferInstruction(bytes,TIP_ACCOUNTS[0],Math.round(config.tipSol*1e9));
        const signed=signTransaction(bytes,kp);
        await validateTrade(signed.bytes,{side:'buy',mint,sol:config.buySol},await getBalanceSol(kp.publicKey));
        return `passed every safety check (${signed.bytes.length} bytes). Transaction discarded, nothing sent.`;
      });
      if(config.tipSol>0) await step('Helius Sender reachable',async()=>{const t0=Date.now();const r=await fetch(senderUrl().replace(/\/fast(\?|$)/,'/ping$1'),{signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error(`HTTP ${r.status} (blocked or bad SENDER_URL)`);return `HTTP ${r.status} in ${Date.now()-t0} ms`;});
    } else console.log('SKIP wallet checks: no PRIVATE_KEY (fine for paper mode)');
    console.log(failed?`\n${failed} check(s) FAILED: fix these before going live.`:`\nAll checks passed.${config.dryRun?' (DRY_RUN=true: paper mode)':' READY FOR LIVE.'}`);
    process.exitCode=failed?1:0;return;
  }
  if (!config.dryRun && !demo && config.executor!=='pumpportal') throw new Error('v2 live execution supports EXECUTOR=pumpportal only; legacy Jupiter remains for quotes/backtests');
  const solscanWatch = solscan.enabled && config.solscanPollMs > 0 ? (onSignature, opts) => startSolscanWatcher({ client: solscan, leader: config.leader, intervalMs: config.solscanPollMs, horizonSec: Math.max(config.maxSignalAgeSec, num('MAX_SELL_SIGNAL_AGE_SEC', 300)), onSignature, ...opts }) : null;
  const tokenLabel = solscan.enabled ? async (mint) => { const m = await solscan.tokenMeta(mint); return m?.symbol ? `$${m.symbol}` : null; } : null;
  const r = await startRuntime({config,kp,notify,redact,rpc,http,getBalanceSol,getTransaction,getSolUsd,detectBuy,detectSell,startWatcher,startSolscanWatcher:solscanWatch,tokenLabel,quoteBuy,quoteSell,addTransferInstruction,signTransaction,TIP_ACCOUNTS,senderUrl,sendRaw,confirm,validateTrade,transactionBlockhash},{demo});
  for(const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>{r.stop();process.exit(0);});
}

/** Backtest one day of the leader's trades with an imaginary wallet. */
async function runBacktestCmd(argv = process.argv) {
  const date = argVal(argv, 'date', dayKey());
  const walletUsd = Number(argVal(argv, 'wallet', 100));
  const delays = argVal(argv, 'delays', '0.5,1.5,3').split(',').map(Number);
  const solUsd = await fetchSolUsdLive().catch(() => {
    console.error('Could not fetch SOL price (Jupiter/DexScreener).');
    process.exit(1);
  });
  try {
    const r = await runBacktest({ date, walletUsd, delays, solUsd });
    const md = toMarkdown(r);
    fs.writeFileSync(`backtest-${date}.md`, md);
    fs.writeFileSync(`backtest-${date}.csv`, toCsv(r));
    fs.writeFileSync(`backtest-${date}.json`, JSON.stringify(r, null, 1));
    console.log('\n' + md);
    console.log(`\nSaved backtest-${date}.md, .csv and .json`);
  } catch (e) {
    console.error(`Backtest failed: ${e.message}`);
    process.exit(1);
  }
}

/** Export the leader's trades for the last N days as CSV (for the analysis skill). */
async function runExportCmd(argv = process.argv) {
  const days = Number(argVal(argv, 'days', 7));
  const solUsd = await fetchSolUsdLive().catch(() => config.solPriceFallback);
  try {
    const r = await exportLeaderTrades({ days, solUsd });
    const name = `leader-trades-${days}d.csv`;
    fs.writeFileSync(name, rowsToCsv(r.rows));
    console.log(rowsToCsv(r.rows));
    console.log(`\n${r.rows.length} trades from ${r.txCount} transactions over ${days} day(s). Saved ${name}.`);
  } catch (e) {
    console.error(`Export failed: ${e.message}`);
    process.exit(1);
  }
}

/** Paper-trading results: node copybot.mjs report [--date YYYY-MM-DD | --all] */
async function runReportCmd(argv = process.argv) {
  const day = argv.includes('--all') ? null : argVal(argv, 'date', dayKey());
  const solUsd = await fetchSolUsdLive().catch(() => null);
  const p = new Paper();
  console.log(p.reportText(day, solUsd));
  const rows = p.data.closed.filter((t) => day === null || t.day === day);
  if (rows.length) {
    console.log('\ntime (UTC)           coin      entry vs his  result');
    for (const t of rows) {
      const main = t.exits?.[config.paperMainDelay];
      const res = t.status === 'failed' ? `FAILED: ${t.reason}` : main == null ? 'no price' : `${main - t.costSol >= 0 ? '+' : ''}${(main - t.costSol).toFixed(4)} SOL (sold ${config.paperMainDelay}s after him)`;
      console.log(`${new Date(t.landedAt).toISOString().slice(0, 19)}  ${t.mint.slice(0, 8)}  ${t.gapVsHisPct == null ? '   ?' : `${t.gapVsHisPct >= 0 ? '+' : ''}${t.gapVsHisPct.toFixed(0)}%`.padStart(6)}        ${res}`);
    }
  }
}

/** One entry point: node copybot.mjs [run|check|backtest|export|report] [--flags] */
async function main(argv = process.argv) {
  const cmd = argv[2] && !argv[2].startsWith('--') ? argv[2] : argv.includes('--check') ? 'check' : 'run';
  if (cmd === 'check') return runBot({ check: true });
  if (cmd === 'backtest') return runBacktestCmd(argv);
  if (cmd === 'export') return runExportCmd(argv);
  if (cmd === 'report') return runReportCmd(argv);
  if (cmd === 'diagnose') return runDiagnoseCmd(argv);
  if (cmd === 'run') return runBot();
  if (cmd === 'demo') return runBot({demo:true});
  console.error(`Unknown command "${cmd}". Use: run | check | diagnose | demo | backtest | export | report`);
  process.exit(1);
}


// ===== entry =====
export {config,setFetch,diagnose,solscan,PROGRAMS,associatedTokenAddress,detectBuy,detectSell,transactionBlockhash,validateTrade,parseTransaction,signTransaction,loadKeypair,addTransferInstruction,TIP_ACCOUNTS,b58encode,b58decode};
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main(process.argv);
