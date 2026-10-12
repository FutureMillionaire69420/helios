// BENCHMARK (no network): how long the bot's own parts of a copy take on this machine, using
// Decu's real recorded buy logs. Run: node bench.mjs. Network stages (seeing his block, sending,
// landing) are measured live by the bot itself and shown in each alert's "Latency:" line.
import fs from 'node:fs';
import * as P from './pumpbuild.mjs';
import {config, findProgramAddress, associatedTokenAddress as ata, b58decode, b58encode, loadKeypair, signTransaction, leaderPumpBuys} from './copybot.mjs';
const fx = JSON.parse(fs.readFileSync(new URL('./fixtures/leader-ws-logs.json', import.meta.url), 'utf8'));
const h = {findProgramAddress, ata, b58decode, b58encode};
const kp = loadKeypair(JSON.stringify([...Buffer.alloc(32, 9)]));
const BH = b58encode(Buffer.alloc(32, 7));
const g = {feeRecipient: '62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV', buybackRecipient: 'EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJdx'};
const time = (name, n, f) => { for (let i = 0; i < 20; i++) f(); const xs = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); xs.push(performance.now() - t); } xs.sort((a, b) => a - b); console.log(`${name.padEnd(42)} median ${xs[n >> 1].toFixed(3)} ms   p95 ${xs[Math.floor(n * 0.95)].toFixed(3)} ms`); };
console.log(`Node ${process.version} on ${process.platform}; ${fx.buy.logs.length} log lines in Decu's real buy\n`);
time('decode his buy from websocket logs', 2000, () => leaderPumpBuys(fx.buy.logs, config.leader));
time('read full trade context (local builder)', 2000, () => P.buyContextFromLogs(fx.buy.logs, config.leader, b58encode));
const ctx = {...P.buyContextFromLogs(fx.buy.logs, config.leader, b58encode), ...g};
time('build buy transaction (18 accounts)', 500, () => P.buildBuyTransaction({user: kp.publicKey, ctx, lamports: 100_000_000, slippagePct: 20, blockhash: BH, tipAccount: ctx.feeRecipient, tipLamports: 1_000_000}, h));
const {bytes} = P.buildBuyTransaction({user: kp.publicKey, ctx, lamports: 100_000_000, slippagePct: 20, blockhash: BH}, h);
time('sign it (ed25519)', 500, () => signTransaction(bytes, kp));
console.log('\nNot measured here (network round trips): the safety simulation, Sender submit, landing. The bot times those live.');
