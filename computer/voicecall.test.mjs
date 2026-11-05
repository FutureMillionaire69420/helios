import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceConfig, voiceStatus, createVoiceCaller} from './voicecall.mjs';

const AC = 'AC' + 'a'.repeat(32), SK = 'SK' + 'b'.repeat(32);
const env = { TWILIO_ACCOUNT_SID: AC, TWILIO_API_KEY: SK, TWILIO_API_SECRET: 'shh-secret', TWILIO_FROM_NUMBER: '+15550001111', OWNER_PHONE: '+15559998888', RENDER_EXTERNAL_URL: 'https://bot.example.com/' };

test('voice calls: off until every setting is there; status never shows the secret or full numbers', () => {
  const off = voiceConfig({});
  assert.equal(off.ready, false); assert.ok(off.missing.length >= 4);
  const on = voiceConfig(env);
  assert.equal(on.ready, true, on.missing.join());
  const st = JSON.stringify(voiceStatus(on));
  assert.doesNotMatch(st, /shh-secret|5559998888|5550001111/); assert.match(st, /8888/);
  assert.equal(voiceConfig({ ...env, TWILIO_API_KEY: 'nope' }).ready, false);
  assert.equal(voiceConfig({ ...env, OWNER_PHONE: '863-555-1234' }).ready, false, 'needs +country format');
  assert.equal(voiceConfig({ ...env, TWILIO_API_KEY: '', TWILIO_API_SECRET: '', TWILIO_AUTH_TOKEN: 'tok' }).ready, true, 'auth token also works');
});

test('voice calls: one Twilio request to the owner with the hosted audio, rate-limited', async () => {
  const seen = []; let t = 1_000_000;
  const caller = createVoiceCaller({ cfg: voiceConfig(env), now: () => t, fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 201, json: async () => ({ sid: 'CA1', status: 'queued' }) }; } });
  const r = await caller.call();
  assert.equal(r.sid, 'CA1'); assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `https://api.twilio.com/2010-04-01/Accounts/${AC}/Calls.json`);
  const body = new URLSearchParams(String(seen[0].init.body));
  assert.equal(body.get('To'), '+15559998888'); assert.equal(body.get('From'), '+15550001111');
  assert.equal(body.get('Twiml'), '<Response><Play>https://bot.example.com/voice/ultron-test.mp3</Play></Response>');
  assert.equal(seen[0].init.headers.Authorization, 'Basic ' + Buffer.from(`${SK}:shh-secret`).toString('base64'));
  await assert.rejects(caller.call(), /Wait/);
  t += 121_000; await caller.call(); assert.equal(seen.length, 2);
  await assert.rejects(caller.call('../etc'), /bad audio/);
  const off = createVoiceCaller({ cfg: voiceConfig({}) });
  await assert.rejects(off.call(), /not set up/);
});

test('voice calls: a Twilio refusal is reported plainly', async () => {
  const caller = createVoiceCaller({ cfg: voiceConfig(env), fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ code: 20003, message: 'Authenticate' }) }) });
  await assert.rejects(caller.call(), /HTTP 401, code 20003/);
});
