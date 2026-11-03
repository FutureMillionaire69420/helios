// ULTRON VOICE CALLS (Twilio). The bot rings the owner's phone and plays a recorded robot-voice message.
// Off until every setting below is in the server environment (Render → Environment); nothing here can trade.
//   TWILIO_ACCOUNT_SID   AC...             (Twilio Console home page)
//   TWILIO_API_KEY       SK...  + TWILIO_API_SECRET   (an API key), or TWILIO_AUTH_TOKEN instead of both
//   TWILIO_FROM_NUMBER   +1...             (a number bought in Twilio)
//   OWNER_PHONE          +1...             (the phone to call)
// The audio file is served at /voice/<name>.mp3 so Twilio can fetch it; RENDER_EXTERNAL_URL (set by Render)
// or PUBLIC_URL gives the address. Voice: piper "en-us-ryan-high" (CC BY-NC-SA 4.0), pitched and processed.

const E164 = /^\+[1-9]\d{7,14}$/;
export const maskPhone = (p) => (p ? `•••${String(p).slice(-4)}` : null);

export function voiceConfig(env = process.env) {
  const v = (k) => String(env[k] || '').trim();
  const cfg = {
    accountSid: v('TWILIO_ACCOUNT_SID'), keySid: v('TWILIO_API_KEY'), secret: v('TWILIO_API_SECRET') || v('TWILIO_AUTH_TOKEN'),
    from: v('TWILIO_FROM_NUMBER'), to: v('OWNER_PHONE'), baseUrl: (v('PUBLIC_URL') || v('RENDER_EXTERNAL_URL')).replace(/\/$/, ''),
  };
  if (!cfg.keySid) cfg.keySid = cfg.accountSid; // with an auth token the username is the account SID
  const missing = [];
  if (!/^AC[0-9a-f]{32}$/i.test(cfg.accountSid)) missing.push('TWILIO_ACCOUNT_SID (starts with AC)');
  if (!cfg.secret) missing.push('TWILIO_API_SECRET or TWILIO_AUTH_TOKEN');
  if (v('TWILIO_API_SECRET') && !/^SK[0-9a-f]{32}$/i.test(v('TWILIO_API_KEY'))) missing.push('TWILIO_API_KEY (starts with SK)');
  if (!E164.test(cfg.from)) missing.push('TWILIO_FROM_NUMBER (like +15551234567)');
  if (!E164.test(cfg.to)) missing.push('OWNER_PHONE (like +15551234567)');
  if (!/^https:\/\//.test(cfg.baseUrl)) missing.push('PUBLIC_URL (Render sets RENDER_EXTERNAL_URL itself)');
  return { ...cfg, ready: missing.length === 0, missing };
}

/** Public status for the dashboard: never the secret or the full phone numbers. */
export const voiceStatus = (cfg) => ({ ready: cfg.ready, missing: cfg.missing, to: maskPhone(cfg.to), from: maskPhone(cfg.from) });

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function createVoiceCaller({ cfg, fetchImpl = globalThis.fetch, now = () => Date.now(), minGapMs = 120_000, perDay = 10 }) {
  let last = 0, day = null, count = 0;
  return {
    async call(file = 'ultron-test') {
      if (!cfg.ready) throw new Error('Voice calls are not set up: ' + cfg.missing.join(', '));
      if (!/^[a-z0-9-]+$/.test(file)) throw new Error('bad audio name');
      const t = now(), d = new Date(t).toISOString().slice(0, 10);
      if (d !== day) { day = d; count = 0; }
      if (t - last < minGapMs) throw new Error(`Wait ${Math.ceil((minGapMs - (t - last)) / 1000)} s before the next call.`);
      if (count >= perDay) throw new Error(`Daily limit of ${perDay} calls reached.`);
      last = t; count++;
      const audio = `${cfg.baseUrl}/voice/${file}.mp3`;
      const body = new URLSearchParams({ To: cfg.to, From: cfg.from, Twiml: `<Response><Play>${xml(audio)}</Play></Response>` });
      const r = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`, {
        method: 'POST', body, signal: AbortSignal.timeout(10_000),
        headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.keySid}:${cfg.secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`Twilio said no (HTTP ${r.status}${j.code ? `, code ${j.code}` : ''}): ${String(j.message || 'unknown error').slice(0, 160)}`);
      return { sid: j.sid || null, status: j.status || 'queued', to: maskPhone(cfg.to) };
    },
  };
}
