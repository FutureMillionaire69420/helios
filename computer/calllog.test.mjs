import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCallLog} from './calllog.mjs';
import {createUltron, providerFields, maskPhones, echoable, costUsd} from './ultron.mjs';
import {voiceConfig, createVoiceCaller} from './voicecall.mjs';

const BASE = 'https://bot.example.com', KEY = 'ab12'.repeat(8);
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'calllog-')); t.after(() => fs.rmSync(d, {recursive: true, force: true})); return d; };
const reply = (body, headers = {}) => ({ok: true, status: 200, headers: new Map(Object.entries(headers)), json: async () => body});

test('call log: every step goes to the file, the server log and memory; secrets are scrubbed; it survives a restart', (t) => {
  const file = path.join(tmp(t), 'ultron-calls.jsonl'), printed = [];
  const log = createCallLog({file, print: (l) => printed.push(l), redact: (s) => s.split('sk-secret').join('[REDACTED]')});
  log.add({call: 'abc', step: 'heard', text: 'how are we doing', key: 'sk-secret'});
  log.add({call: null, step: 'big-win-skipped', why: 'phone alerts are off'});
  assert.match(printed[0], /^\[ultron\] \{"at":"[^"]+","call":"abc","step":"heard"/);
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2); assert.equal(lines[0].text, 'how are we doing'); assert.equal(lines[0].key, '[REDACTED]');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8') + printed.join('\n'), /sk-secret/);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600', 'only the bot can read it');
  // after a restart the dashboard still shows earlier calls
  const again = createCallLog({file, print: () => {}});
  assert.equal(again.recent().length, 2); assert.equal(again.recent({call: 'abc'}).length, 1); assert.equal(again.recent({call: 'other'})[0].step, 'big-win-skipped');
  const calls = again.calls(); assert.deepEqual(calls.map((c) => c.call).sort(), ['abc', 'other']);
  assert.equal(again.jsonl().trim().split('\n').length, 2);
});

test('call log: big files roll over to .1; a broken disk never breaks a call', (t) => {
  const dir = tmp(t), file = path.join(dir, 'log.jsonl');
  fs.writeFileSync(file, 'x'.repeat(2000) + '\n');
  createCallLog({file, maxBytes: 1000, print: () => {}});
  assert.ok(fs.existsSync(file + '.1'), 'rolled over at start');
  const broken = createCallLog({file: path.join(dir, 'no-such-dir', 'log.jsonl'), print: () => { throw new Error('no stdout'); }});
  assert.equal(broken.add({call: 'x', step: 'heard'}).step, 'heard');
  assert.equal(broken.recent().length, 1);
});

test('call log: one summary per call (reason, outcome, provider status, cost, problems)', () => {
  const log = createCallLog({print: () => {}});
  log.add({call: 'c1', step: 'session-open', reason: 'big win'});
  log.add({call: 'c1', sid: 'SID1', step: 'status', CallStatus: 'ringing'});
  log.add({call: 'c1', step: 'claude-error', status: 529});
  log.add({call: 'c1', step: 'heard', text: 'hi'});
  log.add({call: 'c1', step: 'call-summary', why: 'the owner said goodbye', turns: 3, costUsd: 0.0123});
  const [c] = log.calls();
  assert.equal(c.reason, 'big win'); assert.equal(c.sid, 'SID1'); assert.equal(c.providerStatus, 'ringing'); assert.equal(c.errors, 1);
  assert.equal(c.outcome, 'the owner said goodbye'); assert.equal(c.turns, 3); assert.equal(c.costUsd, 0.0123); assert.equal(c.heard, 1); assert.equal(c.steps, 5);
});

test('call log: what the phone provider sent is kept, with phone numbers masked and locations left out', () => {
  const f = providerFields({CallSid: 'CA1', CallStatus: 'in-progress', From: '+18635551234', To: '+18635550199', FromCity: 'TAMPA', ToZip: '33601', AccountSid: 'acct', AnsweredBy: 'machine_start', SipResponseCode: '200', SpeechResult: 'hello'});
  assert.deepEqual(f, {CallSid: 'CA1', CallStatus: 'in-progress', From: '•••1234', To: '•••0199', AnsweredBy: 'machine_start', SipResponseCode: '200'});
  // SignalWire also names who hung up, and any other field could hold a number: all masked
  const g = providerFields({HangupBy: '+18635550199', SomeNewField: '18635551234', SipResultCode: '603', CallDuration: '30', SipCallId: 'a1e68be3-2a90-4fea-b7f3-823e89b067b1'});
  assert.deepEqual(g, {HangupBy: '•••0199', SomeNewField: '•••1234', SipResultCode: '603', CallDuration: '30', SipCallId: 'a1e68be3-2a90-4fea-b7f3-823e89b067b1'});
  assert.equal(maskPhones('{"by":"+18635550199","pnl":"+15 percent","n":12345678901}'), '{"by":"•••0199","pnl":"+15 percent","n":12345678901}');
});

test('ultron log: a whole call, step by step (heard, request, response with tokens and cost, tool, answer, what was said, summary)', async () => {
  const steps = []; let n = 0;
  const fetchImpl = async (url, init) => { n++;
    if (n === 1) return reply({id: 'msg_1', model: 'claude-sonnet-5-5', stop_reason: 'tool_use', usage: {input_tokens: 1000, output_tokens: 50}, content: [{type: 'thinking', thinking: 'Check the overview first.'}, {type: 'tool_use', id: 'tu1', name: 'bot_overview', input: {}}]}, {'request-id': 'req_1'});
    return reply({id: 'msg_2', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: {input_tokens: 1200, output_tokens: 30, cache_read_input_tokens: 100}, content: [{type: 'text', text: 'You are **up** two SOL.'}]}, {'request-id': 'req_2'}); };
  const u = createUltron({random: () => 0, apiKey: 'k', fetchImpl, trace: (e) => steps.push(e), data: {overview: () => ({mode: 'paper', pnlTodaySol: 2})}});
  const id = u.open({reason: 'you asked'}); u.placed(id, 'CA1');
  await u.start({base: BASE, key: KEY, id, callSid: 'CA1', voice: 'Polly.Matthew', params: {CallSid: 'CA1', CallStatus: 'in-progress', To: '+18635551234'}});
  await u.turn({base: BASE, key: KEY, id, callSid: 'CA1', speech: 'thanks, goodbye', confidence: '0.91', voice: 'Polly.Matthew', params: {CallStatus: 'in-progress'}});
  u.stop();
  const names = steps.map((e) => e.step);
  assert.deepEqual(names, ['session-open', 'connected', 'claude-request', 'claude-response', 'tool', 'claude-request', 'claude-response', 'answer', 'respond', 'heard', 'respond', 'call-summary']);
  assert.ok(steps.every((e) => e.call === id.slice(0, 8)), 'every step carries the call id');
  const by = (s) => steps.filter((e) => e.step === s);
  assert.equal(by('connected')[0].To, '•••1234'); assert.equal(by('connected')[0].CallStatus, 'in-progress');
  const r1 = by('claude-response')[0];
  assert.equal(r1.requestId, 'req_1'); assert.equal(r1.model, 'claude-sonnet-5-5'); assert.equal(r1.stop, 'tool_use'); assert.equal(r1.thinking, 'Check the overview first.');
  assert.deepEqual(r1.tools, [{name: 'bot_overview', input: {}}]); assert.equal(r1.usage.input_tokens, 1000); assert.equal(r1.costUsd, 0.0025, '1000 in x $2 + 50 out x $10 per million');
  assert.match(by('tool')[0].result, /pnlTodaySol/);
  assert.equal(by('answer')[0].text, 'You are up two SOL.'); assert.equal(by('answer')[0].raw, 'You are **up** two SOL.');
  const said = by('respond')[0];
  assert.equal(said.action, 'speak-and-listen'); assert.equal(said.text, 'You are up two SOL.'); assert.equal(said.voice, 'Polly.Matthew');
  assert.doesNotMatch(said.xml, new RegExp(KEY)); assert.doesNotMatch(said.xml, new RegExp(id)); assert.match(said.xml, /k=\*\*\*/);
  assert.equal(by('heard')[0].text, 'thanks, goodbye'); assert.equal(by('heard')[0].confidence, 0.91);
  assert.equal(by('respond')[1].action, 'speak-and-hang-up');
  const sum = by('call-summary')[0];
  assert.equal(sum.why, 'the owner said goodbye'); assert.equal(sum.claudeRequests, 2); assert.equal(sum.toolCalls, 1);
  assert.deepEqual(sum.tokens, {input: 2200, output: 80, cacheRead: 100, cacheWrite: 0}); assert.equal(sum.costUsd, 0.0052, '0.0025 + 0.00271');
  // a request for a call that no longer exists is logged, and asks Claude nothing
  const steps2 = []; let asked = 0;
  const u2 = createUltron({random: () => 0, apiKey: 'k', fetchImpl: async () => { asked++; return reply({}); }, trace: (e) => steps2.push(e)});
  assert.match(await u2.turn({base: BASE, key: KEY, id: 'gone', callSid: 'Z', speech: 'hello', voice: 'man'}), /expired/);
  assert.equal(asked, 0); assert.equal(steps2[0].step, 'webhook-unknown-call'); assert.equal(steps2[0].route, 'turn'); assert.equal(steps2[1].action, 'speak-and-hang-up');
  u2.stop();
});

test('ultron log: failures and refusals are logged in full, and dropped from the conversation so the next question works', async () => {
  const steps = []; let n = 0, lastBody = null;
  const fetchImpl = async (url, init) => { n++; lastBody = JSON.parse(init.body);
    if (n === 1) return {ok: false, status: 529, headers: new Map([['request-id', 'req_x'], ['retry-after', '3']]), json: async () => ({error: {type: 'overloaded_error', message: 'Overloaded'}})};
    if (n === 2) return reply({stop_reason: 'refusal', stop_details: {type: 'refusal', category: 'cyber'}, content: []});
    return reply({stop_reason: 'end_turn', content: [{type: 'text', text: 'Fine.'}]}); };
  const u = createUltron({random: () => 0, apiKey: 'k', fetchImpl, trace: (e) => steps.push(e), data: {}});
  const id = u.open({});
  assert.match(await u.start({base: BASE, key: KEY, id, callSid: 'C', voice: 'man'}), /connection to my mind failed/);
  const err = steps.find((e) => e.step === 'claude-error');
  assert.deepEqual([err.status, err.type, err.error, err.requestId, err.retryAfter], [529, 'overloaded_error', 'Overloaded', 'req_x', '3']);
  assert.equal(u.sessions.get(id).messages.length, 0, 'the failed exchange is not kept');
  assert.match(await u.turn({base: BASE, key: KEY, id, callSid: 'C', speech: 'hack something', voice: 'man'}), /will not go there/);
  assert.equal(steps.find((e) => e.step === 'answer' && e.refusal).category, 'cyber');
  assert.equal(u.sessions.get(id).messages.length, 0, 'the refused exchange is not kept');
  await u.turn({base: BASE, key: KEY, id, callSid: 'C', speech: 'how are we doing', voice: 'man'});
  assert.equal(lastBody.messages.length, 1, 'the next question starts clean'); assert.equal(lastBody.messages[0].content, 'how are we doing');
  assert.deepEqual(lastBody.thinking, {type: 'adaptive', display: 'summarized'}, 'asks for a readable reasoning summary for the log');
  u.stop();
});

test('ultron log: the provider\'s call-progress reports, unanswered calls and idle calls end with a summary', () => {
  const steps = []; let clock = 1_000_000;
  const u = createUltron({random: () => 0, apiKey: 'k', now: () => clock, idleMs: 180_000, trace: (e) => steps.push(e), data: {}});
  const a = u.open({reason: 'big win'}), b = u.open({reason: 'you asked'});
  u.status({id: a, params: {CallSid: 'CA', CallStatus: 'ringing'}});
  u.status({id: a, params: {CallSid: 'CA', CallStatus: 'no-answer', CallDuration: '0', To: '+18635551234'}});
  const sa = steps.filter((e) => e.call === a.slice(0, 8));
  assert.deepEqual(sa.map((e) => e.step), ['session-open', 'status', 'status', 'call-summary']);
  assert.equal(sa[2].To, '•••1234'); assert.equal(sa.at(-1).why, 'phone call no-answer'); assert.equal(u.sessions.has(a), false);
  clock += 181_000; u.sweep();
  assert.match(steps.at(-1).why, /no activity/); assert.equal(steps.at(-1).call, b.slice(0, 8)); assert.equal(u.sessions.size, 0);
  u.status({id: null, test: 'test-a1b2c3', params: {CallSid: 'T1', CallStatus: 'completed'}});
  assert.equal(steps.at(-1).call, 'test-a1b2c3'); assert.equal(steps.at(-1).CallStatus, 'completed');
  u.status({id: null, test: '<evil>', params: {CallStatus: 'completed'}}); assert.equal(steps.at(-1).call, 'test');
  u.stop();
});

test('ultron log: inbound calls from other numbers are logged with the number masked', async () => {
  const steps = [];
  const u = createUltron({random: () => 0, apiKey: 'k', trace: (e) => steps.push(e), data: {}});
  await u.inbound({base: BASE, key: KEY, from: '+15550001111', owner: '+18635551234', callSid: 'X', voice: 'man', params: {From: '+15550001111', CallStatus: 'ringing'}});
  const r = steps.at(-1);
  assert.equal(r.step, 'respond'); assert.equal(r.action, 'reject'); assert.equal(r.why, 'the caller is not OWNER_PHONE'); assert.equal(r.from, '•••1111');
  assert.doesNotMatch(JSON.stringify(steps), /5550001111|8635551234/);
  u.stop();
});

test('fallback turns are echoed without the declined model\'s thinking and tool calls; cost estimates by model', () => {
  const c = [{type: 'thinking', thinking: 'a'}, {type: 'tool_use', id: 'x'}, {type: 'fallback', from: {model: 'm1'}, to: {model: 'm2'}}, {type: 'thinking', thinking: 'b'}, {type: 'text', text: 'hi'}];
  assert.deepEqual(echoable(c).map((b) => b.type), ['fallback', 'thinking', 'text']);
  const plain = [{type: 'thinking'}, {type: 'text'}]; assert.equal(echoable(plain), plain);
  assert.equal(costUsd('claude-opus-5-5', {input_tokens: 1e6, output_tokens: 1e6}), 24);
  assert.equal(costUsd('some-other-model', {input_tokens: 5}), null);
});

test('voice caller: calls ask the provider for progress reports, only to this server', async () => {
  const env = {SIGNALWIRE_SPACE: 'myspace', SIGNALWIRE_PROJECT_ID: '12345678-90ab-cdef-1234-567890abcdef', SIGNALWIRE_API_TOKEN: 't', SIGNALWIRE_FROM_NUMBER: '+15550002222', OWNER_PHONE: '+15559998888', RENDER_EXTERNAL_URL: BASE};
  const seen = [], ok = async (u, i) => { seen.push(new URLSearchParams(String(i.body))); return {ok: true, status: 201, json: async () => ({sid: 'S'})}; };
  await createVoiceCaller({cfg: voiceConfig(env), fetchImpl: ok}).call('ultron-test', {statusUrl: `${BASE}/voice/agent/status?k=${KEY}&t=test-a1b2c3`});
  assert.equal(seen[0].get('StatusCallback'), `${BASE}/voice/agent/status?k=${KEY}&t=test-a1b2c3`); assert.equal(seen[0].get('StatusCallbackMethod'), 'POST');
  assert.deepEqual(seen[0].getAll('StatusCallbackEvent'), ['initiated', 'ringing', 'answered', 'completed']);
  assert.equal(seen[0].get('Timeout'), '60', 'rings up to 60 s');
  assert.equal(seen[0].get('Url'), `${BASE}/voice/ultron-test.xml`, 'the recorded test call is unchanged');
  await createVoiceCaller({cfg: voiceConfig(env), fetchImpl: ok}).call('ultron-test', {statusUrl: 'https://elsewhere.example.com/x'});
  assert.equal(seen[1].get('StatusCallback'), null, 'never reports to another server');
  await createVoiceCaller({cfg: voiceConfig(env), fetchImpl: ok}).call('ultron-test');
  assert.equal(seen[2].get('StatusCallback'), null);
});

test('voice caller: if the provider ever refused the progress-report settings, the call still goes through without them', async () => {
  const env = {SIGNALWIRE_SPACE: 'myspace', SIGNALWIRE_PROJECT_ID: '12345678-90ab-cdef-1234-567890abcdef', SIGNALWIRE_API_TOKEN: 't', SIGNALWIRE_FROM_NUMBER: '+15550002222', OWNER_PHONE: '+15559998888', RENDER_EXTERNAL_URL: BASE};
  const seen = [];
  const fetchImpl = async (u, i) => { const b = new URLSearchParams(String(i.body)); seen.push(b);
    return b.get('StatusCallback') ? {ok: false, status: 400, json: async () => ({code: 21205, message: 'Invalid StatusCallback'})} : {ok: true, status: 201, json: async () => ({sid: 'S2', status: 'queued'})}; };
  const r = await createVoiceCaller({cfg: voiceConfig(env), fetchImpl}).call({url: `${BASE}/voice/agent/start?k=${KEY}&s=x`}, {statusUrl: `${BASE}/voice/agent/status?k=${KEY}&s=x`});
  assert.equal(r.sid, 'S2'); assert.equal(r.statusReports, false); assert.equal(seen.length, 2);
  assert.equal(seen[1].get('StatusCallback'), null); assert.equal(seen[1].get('Timeout'), null); assert.equal(seen[1].get('Url'), `${BASE}/voice/agent/start?k=${KEY}&s=x`);
  const ok = await createVoiceCaller({cfg: voiceConfig(env), fetchImpl: async () => ({ok: true, status: 201, json: async () => ({sid: 'S3'})})}).call('ultron-test', {statusUrl: `${BASE}/voice/agent/status?k=${KEY}`});
  assert.equal(ok.statusReports, true);
});

test('call log: lines written before a rule existed are scrubbed at the next start (file rewritten, nothing else lost)', (t) => {
  const dir = tmp(t), file = path.join(dir, 'ultron-calls.jsonl');
  fs.writeFileSync(file, [JSON.stringify({at: 'x', call: 'test-1', step: 'status', HangupBy: '+18635550199', key: 'sk-secret'}), JSON.stringify({at: 'y', call: 'c2', step: 'heard', text: 'hi'}), ''].join('\n'));
  fs.writeFileSync(file + '.1', JSON.stringify({at: 'w', call: 'old', step: 'status', HangupBy: '+18635550199'}) + '\n');
  const redact = (s) => maskPhones(s.split('sk-secret').join('[REDACTED]'));
  const log = createCallLog({file, print: () => {}, redact});
  const text = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(text + fs.readFileSync(file + '.1', 'utf8'), /8635550199|sk-secret/);
  assert.equal(text.trim().split('\n').length, 2, 'every line kept');
  assert.equal(log.recent()[0].HangupBy, '•••0199'); assert.equal(log.recent()[1].text, 'hi');
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
  const before = fs.statSync(file).mtimeMs; createCallLog({file, print: () => {}, redact}); assert.equal(fs.statSync(file).mtimeMs, before, 'a clean file is not rewritten');
});
