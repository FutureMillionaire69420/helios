import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceConfig, voiceStatus, createVoiceCaller, voiceXml} from './voicecall.mjs';

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

const PROJ = '12345678-90ab-cdef-1234-567890abcdef';
const swEnv = { SIGNALWIRE_SPACE: 'https://myspace.signalwire.com/', SIGNALWIRE_PROJECT_ID: PROJ, SIGNALWIRE_API_TOKEN: 'sw-secret', SIGNALWIRE_FROM_NUMBER: '+15550002222', OWNER_PHONE: '+15559998888', RENDER_EXTERNAL_URL: 'https://bot.example.com' };

test('SignalWire: chosen when its Project ID is set; needs the space, project, token and its own number', () => {
  const on = voiceConfig(swEnv);
  assert.equal(on.provider, 'signalwire'); assert.equal(on.ready, true, on.missing.join()); assert.equal(on.host, 'myspace.signalwire.com');
  assert.equal(voiceConfig({ ...swEnv, SIGNALWIRE_SPACE: 'myspace' }).host, 'myspace.signalwire.com');
  assert.equal(voiceConfig({ ...swEnv, SIGNALWIRE_SPACE: 'evil.example.com' }).ready, false, 'only a signalwire.com host');
  assert.equal(voiceConfig({ ...swEnv, SIGNALWIRE_PROJECT_ID: 'nope' }).ready, false);
  assert.match(voiceConfig({ ...swEnv, SIGNALWIRE_API_TOKEN: '' }).missing.join(), /SIGNALWIRE_API_TOKEN/);
  assert.equal(voiceConfig({ ...env, ...swEnv }).provider, 'signalwire', 'SignalWire wins when both are set');
  assert.equal(voiceConfig({ ...env, ...swEnv, VOICE_PROVIDER: 'twilio' }).provider, 'twilio');
  assert.equal(voiceConfig(env).provider, 'twilio', 'Twilio as before');
  const st = JSON.stringify(voiceStatus(on));
  assert.doesNotMatch(st, /sw-secret|5559998888|5550002222/); assert.match(st, /signalwire/);
});

test('SignalWire: one request to the Space with the Project ID and token; the call plays the hosted script', async () => {
  const seen = [];
  const caller = createVoiceCaller({ cfg: voiceConfig(swEnv), fetchImpl: async (url, init) => { seen.push({ url, init }); return { ok: true, status: 201, json: async () => ({ sid: 'CA9', status: 'queued' }) }; } });
  const r = await caller.call();
  assert.equal(r.sid, 'CA9'); assert.equal(r.provider, 'signalwire');
  assert.equal(seen[0].url, `https://myspace.signalwire.com/api/laml/2010-04-01/Accounts/${PROJ}/Calls.json`);
  const body = new URLSearchParams(String(seen[0].init.body));
  assert.equal(body.get('To'), '+15559998888'); assert.equal(body.get('From'), '+15550002222');
  assert.equal(body.get('Url'), 'https://bot.example.com/voice/ultron-test.xml'); assert.equal(body.get('Method'), 'GET');
  assert.equal(seen[0].init.headers.Authorization, 'Basic ' + Buffer.from(`${PROJ}:sw-secret`).toString('base64'));
  assert.equal(voiceXml('https://bot.example.com', 'ultron-test'), '<?xml version="1.0" encoding="UTF-8"?><Response><Play>https://bot.example.com/voice/ultron-test.mp3</Play></Response>');
  const no = createVoiceCaller({ cfg: voiceConfig(swEnv), fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) }) });
  await assert.rejects(no.call(), /SignalWire said no \(HTTP 401\).*Voice scope/);
});

test('SignalWire: a second token (SIGNALWIRE_API_KEY_2) is tried once when the first is refused; placeholders are ignored', async () => {
  const auths = [];
  const cfg = voiceConfig({ ...swEnv, SIGNALWIRE_API_KEY_2: 'sw-second' });
  const caller = createVoiceCaller({ cfg, fetchImpl: async (url, init) => { auths.push(init.headers.Authorization); return auths.length === 1 ? { ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) } : { ok: true, status: 201, json: async () => ({ sid: 'CA2', status: 'queued' }) }; } });
  assert.equal((await caller.call()).sid, 'CA2');
  assert.deepEqual(auths, ['Basic ' + Buffer.from(`${PROJ}:sw-secret`).toString('base64'), 'Basic ' + Buffer.from(`${PROJ}:sw-second`).toString('base64')]);
  assert.equal(voiceConfig({ ...swEnv, SIGNALWIRE_API_TOKEN: 'REPLACE-with-token', SIGNALWIRE_API_KEY_2: 'sw-second' }).secret, 'sw-second', 'a placeholder first token: key 2 is used');
  assert.equal(voiceConfig({ ...swEnv, SIGNALWIRE_API_KEY_2: 'REPLACE-me' }).secret2, '', 'a placeholder key 2 is never sent');
  assert.equal(voiceConfig({ ...swEnv, SIGNALWIRE_API_TOKEN: 'REPLACE-x' }).ready, false);
});
