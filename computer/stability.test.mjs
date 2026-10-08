import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {Engine} from './engine.mjs';
import {startRuntime} from './runtime.mjs';
import {config, setFetch, rpc, relevantLogs, detectBuy, detectSell} from './copybot.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-stab-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };
const freePort = async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const LEADER = config.leader;

function launch(args, env, cwd = here) {
  const p = spawn(process.execPath, [path.join(here, 'copybot.mjs'), ...args], {cwd, env: {...process.env, NTFY_TOPIC: '', PRIVATE_KEY: '', ...env}});
  let out = '';
  p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { out += b; });
  const exited = new Promise((r) => p.once('exit', (code) => r(code)));
  return {p, exited, out: () => out};
}
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); } throw new Error('timed out'); };

test('supervisor restarts a crashed bot and stops cleanly on SIGTERM', async (t) => {
  const dir = tmp(t), port = await freePort();
  const s = launch(['start', 'demo'], {PORT: String(port), DASHBOARD_TOKEN: 'supervisor-test-token-24chars', ENGINE_STATE_FILE: path.join(dir, 'e.json'), LOG_FILE: path.join(dir, 'l.log'), SUPERVISOR_BACKOFF_MS: '100'});
  t.after(() => s.p.kill('SIGKILL'));
  const pids = () => [...s.out().matchAll(/bot started \(pid (\d+)\)/g)].map((m) => Number(m[1]));
  const health = async () => { try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; } };
  await waitFor(() => pids().length === 1 && health());
  const first = pids()[0];
  process.kill(first, 'SIGKILL'); // simulate a crash
  await waitFor(() => pids().length === 2 && health());
  const second = pids()[1];
  assert.notEqual(second, first);
  assert.match(s.out(), /stopped unexpectedly \(SIGKILL\)\. Restarting/);
  s.p.kill('SIGTERM');
  assert.equal(await s.exited, 0);
  await waitFor(() => !alive(second), 3000);
});

test('supervisor gives up after 5 instant failures instead of looping forever', async (t) => {
  const dir = tmp(t);
  const s = launch(['start'], {LEADER_WALLET: 'not-a-wallet', SUPERVISOR_BACKOFF_MS: '10', ENGINE_STATE_FILE: path.join(dir, 'e.json'), LOG_FILE: path.join(dir, 'l.log')});
  t.after(() => s.p.kill('SIGKILL'));
  assert.equal(await s.exited, 1);
  assert.equal([...s.out().matchAll(/bot started/g)].length, 5);
  assert.match(s.out(), /LEADER_WALLET is not a valid Solana address/);
  assert.match(s.out(), /stopped 5 times right after starting/);
});

test('setup wizard: creates .env, keeps keys on rerun, switches live and back to paper', async (t) => {
  const dir = tmp(t);
  const run = async (args, input) => { const s = launch(['setup', '--no-check', ...args], {}, dir); s.p.stdin.end(input); assert.equal(await s.exited, 0, s.out()); return s.out(); };
  const env = () => fs.readFileSync(path.join(dir, '.env'), 'utf8');
  const get = (k) => env().match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1];

  await run([], 'https://mainnet.helius-rpc.com/?api-key=abc-123-def\nsolscan-key-xyz\n');
  assert.equal(get('HELIUS_API_KEY'), 'abc-123-def', 'key pulled out of a pasted URL');
  assert.equal(get('SOLSCAN_API_KEY'), 'solscan-key-xyz');
  assert.match(get('DASHBOARD_TOKEN'), /^[0-9a-f]{48}$/);
  assert.match(get('NTFY_TOPIC'), /^decu-[0-9a-f]{20}$/);
  assert.equal(get('DRY_RUN'), 'true');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, '.env')).mode & 0o777, 0o600);
  const token = get('DASHBOARD_TOKEN');

  await run([], '\n\n');
  assert.equal(get('HELIUS_API_KEY'), 'abc-123-def'); assert.equal(get('DASHBOARD_TOKEN'), token, 'rerun keeps existing values');

  assert.match(await run(['--live'], 'no\n'), /Cancelled/);
  assert.equal(get('DRY_RUN'), 'true');
  assert.match(await run(['--live'], 'LIVE\nnot-a-key\n'), /not a valid Solana private key/);
  assert.equal(get('PRIVATE_KEY'), '');

  const key = JSON.stringify([...Buffer.alloc(32, 7)]);
  const out = await run(['--live'], `LIVE\n${key}\nyes\n`);
  assert.match(out, /Wallet address: \w{32,44}/);
  assert.equal(get('PRIVATE_KEY'), key); assert.equal(get('DRY_RUN'), 'false'); assert.equal(get('DAILY_CAP_SOL'), '0.2');
  assert.equal(out.includes(key), false, 'wallet key is never printed');

  await run(['--paper'], '');
  assert.equal(get('DRY_RUN'), 'true');
});

test('RPC reads retry rate limits and server errors, then give up', async (t) => {
  t.after(() => setFetch(null));
  let calls = 0;
  const reply = (status, body) => ({ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body)});
  setFetch(async () => (++calls <= 2 ? reply(429, {}) : reply(200, {result: 42})));
  assert.equal(await rpc('getSlot', []), 42); assert.equal(calls, 3);
  calls = 0; setFetch(async () => { calls++; return reply(503, {}); });
  await assert.rejects(rpc('getSlot', []), /HTTP 503/); assert.equal(calls, 4);
  calls = 0; setFetch(async () => { calls++; return reply(400, {}); });
  await assert.rejects(rpc('getSlot', []), /HTTP 400/); assert.equal(calls, 1, 'client errors are not retried');
});

test('state file forgets duplicate keys older than 2 days', (t) => {
  const dir = tmp(t), file = path.join(dir, 's.json');
  const cfg = {mode: 'paper', timezone: 'UTC', paperBalance: 1};
  const e = new Engine({file, config: cfg, adapter: {}});
  e.d.seen = {old: Date.now() - 3 * 86400e3, fresh: Date.now()}; e.save();
  const reloaded = new Engine({file, config: cfg, adapter: {}});
  assert.deepEqual(Object.keys(reloaded.d.seen), ['fresh']);
});

test("other wallets' transactions are counted, not logged; repeated errors are throttled", async (t) => {
  const dir = tmp(t), saved = {...process.env};
  Object.assign(process.env, {ENGINE_STATE_FILE: path.join(dir, 'engine.json'), PORT: '0', DASHBOARD_TOKEN: 'stability-test-token-24-chars'});
  let ws, fail = false;
  const spam = {blockTime: 1, slot: 1, transaction: {signatures: ['x'], message: {accountKeys: [{pubkey: 'Spammer1111111111111111111111111111111111111', signer: true}, {pubkey: LEADER, signer: false}]}},
    meta: {err: null, fee: 5000, preBalances: [1e9, 1e9], postBalances: [1e9 - 5000, 1e9], preTokenBalances: [], postTokenBalances: []}};
  const k = {config: {...config, dryRun: true, logFile: path.join(dir, 'log')}, redact: (x) => x, detectBuy, detectSell, getSolUsd: async () => 100,
    getTransaction: async () => { if (fail) throw new Error('HTTP 429 Too Many Requests'); return spam; },
    startWatcher: (cb) => { ws = cb; return () => {}; }};
  const r = await startRuntime(k);
  t.after(() => { r.stop(); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  for (let i = 0; i < 20; i++) await ws('spam' + i, 'ws');
  fail = true;
  for (let i = 0; i < 5; i++) await ws('limited' + i, 'ws');
  const s = await (await fetch(`http://127.0.0.1:${r.server.address().port}/api/status`, {headers: {Authorization: 'Bearer ' + process.env.DASHBOARD_TOKEN}})).json();
  assert.equal(s.connection.otherWallets, 20);
  assert.equal(s.events.filter((e) => e.type === 'ignored').length, 0);
  assert.equal(s.connection.errors, 5);
  assert.equal(s.events.filter((e) => e.type === 'error').length, 1, 'one error event per 30 s');
  assert.match(s.connection.lastError, /429/);
  assert.ok(fs.readFileSync(k.config.logFile, 'utf8').split('\n').length < 10, 'journal not flooded');
});

test('websocket filter drops the measured spam and keeps every pump.fun trade', () => {
  // Real log shape of the flood (2026-10-08): one unrelated program, no pump.fun.
  assert.equal(relevantLogs(['Program DhpyNWkdxFh3DRPsBrwRwrK3TYC5t7Q4arnSvf3t84HY invoke [1]', 'Program DhpyNWkdxFh3DRPsBrwRwrK3TYC5t7Q4arnSvf3t84HY success']), false);
  // His trades: router at depth 1, pump.fun bonding curve or PumpSwap underneath.
  assert.equal(relevantLogs(['Program FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9 invoke [1]', 'Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [2]']), true);
  assert.equal(relevantLogs(['Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [2]']), true);
  assert.equal(relevantLogs(['Program X invoke [1]', 'Log truncated']), true, 'truncated logs are fetched');
  assert.equal(relevantLogs(undefined), true, 'no logs: fetch');
});

test('values saved in .env win over empty inherited ones (setup then check)', async (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, '.env'), 'HELIUS_API_KEY=saved-key\nNTFY_TOPIC=saved-topic\n');
  const p = spawn(process.execPath, ['--input-type=module', '-e', `const {config}=await import(${JSON.stringify(new URL('./copybot.mjs', import.meta.url).href)}); console.log(config.heliusKey+'|'+config.ntfyTopic); process.exit(0)`], {cwd: dir, env: {...process.env, HELIUS_API_KEY: '', NTFY_TOPIC: ''}});
  t.after(() => p.kill('SIGKILL'));
  let out = ''; p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { out += b; });
  await new Promise((r) => p.once('exit', r));
  assert.equal(out.trim(), 'saved-key|saved-topic');
});
