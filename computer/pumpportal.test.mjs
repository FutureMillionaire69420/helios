import test from 'node:test';
import assert from 'node:assert/strict';
import {createPumpPortalFeed, tradeFromPumpPortal, PUMPPORTAL_DATA_URL} from './pumpportal.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = 'test-key-' + 'x'.repeat(40);
const LEADER = '4vw54BmAogeRV3vPKWyFet5yf8DTLcREzdSzx4rw9Ud9';
const MINT = 'siBF3bcDKAH9so6zFSRLVer6ua3sFJ8m279aF2cpump';
// a trade message as PumpPortal streams it (amounts in SOL and whole tokens, reserves after the trade)
const msg = (over = {}) => ({signature: '5sig', mint: MINT, traderPublicKey: LEADER, txType: 'buy', tokenAmount: 2254826.796163, solAmount: 0.2444, newTokenBalance: 2254826.796163,
  bondingCurveKey: 'BCkey', vTokensInBondingCurve: 1047745173.203837, vSolInBondingCurve: 30.722, marketCapSol: 29.32, pool: 'pump', ...over});

class FakeWS {
  static all = [];
  constructor(url) { this.url = url; this.sent = []; FakeWS.all.push(this); setTimeout(() => this.onopen?.(), 0); }
  send(d) { this.sent.push(JSON.parse(d)); }
  close() { this.onclose?.({code: 1000}); }
  emit(m) { this.onmessage?.({data: JSON.stringify(m)}); }
}

test('PumpPortal trade message -> trade (raw token units, lamports, his side and pool)', () => {
  const t = tradeFromPumpPortal(msg());
  assert.deepEqual(t, {sig: '5sig', mint: MINT, trader: LEADER, side: 'buy', sol: 0.2444, raw: 2254826796163, pool: 'pump', vSol: 30722000000, vTok: 1047745173203837});
  assert.equal(tradeFromPumpPortal(msg({txType: 'sell'})).side, 'sell');
  for (const bad of [null, {}, msg({signature: undefined}), msg({txType: 'create'}), msg({solAmount: 0}), msg({tokenAmount: 'x'}), {message: 'Successfully subscribed to keys.'}]) assert.equal(tradeFromPumpPortal(bad), null);
});

test('PumpPortal feed: one socket with the key, subscribes to his wallet, pushes his trades; the key is never logged', async (t) => {
  FakeWS.all = [];
  const trades = [], logs = [];
  const feed = createPumpPortalFeed({apiKey: KEY, accounts: [LEADER], onTrade: (x) => trades.push(x), WebSocketImpl: FakeWS, log: (m) => logs.push(m), minBackoffMs: 10, maxBackoffMs: 40});
  t.after(() => feed.stop());
  await sleep(5);
  const ws = FakeWS.all[0];
  assert.equal(FakeWS.all.length, 1, 'one connection');
  assert.equal(ws.url, `${PUMPPORTAL_DATA_URL}?api-key=${KEY}`);
  assert.deepEqual(ws.sent, [{method: 'subscribeAccountTrade', keys: [LEADER]}]);
  ws.emit({message: 'Successfully subscribed to keys.'});
  assert.equal(feed.status().subscribed, true);
  ws.emit(msg());
  assert.equal(trades.length, 1); assert.equal(trades[0].raw, 2254826796163);
  ws.emit({errors: 'Insufficient balance on the linked wallet'});
  assert.match(feed.status().lastError, /Insufficient balance/);
  ws.emit({error: `invalid api-key ${KEY}`}); // a server message echoing the key
  assert.equal(feed.status().lastError, 'invalid api-key ***', 'scrubbed before it is stored or logged');
  assert.equal(feed.status().trades, 1); assert.equal(feed.status().connected, true);
  // dropped: reconnects slowly (backoff doubles), re-subscribes
  ws.close(); assert.equal(feed.status().connected, false);
  await sleep(25);
  assert.equal(FakeWS.all.length, 2, 'reconnected once after the backoff');
  await sleep(5);
  assert.deepEqual(FakeWS.all[1].sent, [{method: 'subscribeAccountTrade', keys: [LEADER]}]);
  FakeWS.all[1].close(); await sleep(12);
  assert.equal(FakeWS.all.length, 2, 'the next try waits longer (20 ms)');
  await sleep(30);
  assert.equal(FakeWS.all.length, 3);
  feed.stop(); await sleep(60);
  assert.equal(FakeWS.all.length, 3, 'stopped: no reconnect');
  assert.ok(logs.length > 0);
  for (const l of logs) assert.ok(!l.includes(KEY), 'the key never appears in a log line: ' + l);
});

test('PumpPortal feed: no key, no connection', async () => {
  FakeWS.all = [];
  const feed = createPumpPortalFeed({apiKey: '', accounts: [LEADER], onTrade: () => {}, WebSocketImpl: FakeWS});
  await sleep(5);
  assert.equal(FakeWS.all.length, 0); assert.match(feed.status().lastError, /PUMPPORTAL_API_KEY/);
  feed.stop();
});
