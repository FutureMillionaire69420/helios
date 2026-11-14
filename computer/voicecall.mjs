// ULTRON VOICE CALLS (SignalWire or Twilio). The bot rings the owner's phone and plays a recorded robot-voice
// message. Off until every setting for one provider is in the server environment (Render → Environment);
// nothing here can trade.
// SignalWire (cheaper; used when SIGNALWIRE_PROJECT_ID is set, or VOICE_PROVIDER=signalwire):
//   SIGNALWIRE_SPACE        yourspace          (or yourspace.signalwire.com: the address of your SignalWire Space)
//   SIGNALWIRE_PROJECT_ID   xxxxxxxx-xxxx-...  (Dashboard → API: the Project ID)
//   SIGNALWIRE_API_TOKEN    the project's API token, with the Voice scope (Dashboard → API → API Tokens)
//   SIGNALWIRE_FROM_NUMBER  +1...              (a number bought in SignalWire)
// Twilio:
//   TWILIO_ACCOUNT_SID   AC...             (Twilio Console home page)
//   TWILIO_API_KEY       SK...  + TWILIO_API_SECRET   (an API key), or TWILIO_AUTH_TOKEN instead of both
//   TWILIO_FROM_NUMBER   +1...             (a number bought in Twilio)
// Both:
//   OWNER_PHONE          +1...             (the phone to call)
// The audio file is served at /voice/<name>.mp3 (and, for SignalWire, a call script that plays it at
// /voice/<name>.xml); RENDER_EXTERNAL_URL (set by Render) or PUBLIC_URL gives the address.
// Voice: piper "en-us-ryan-high" (CC BY-NC-SA 4.0), pitched and processed.

const E164 = /^\+[1-9]\d{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const maskPhone = (p) => (p ? `•••${String(p).slice(-4)}` : null);

/** The SignalWire Space host from "name", "name.signalwire.com" or "https://name.signalwire.com/...". */
export function signalwireHost(space) {
  const h = String(space || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const host = h.includes('.') ? h : h ? `${h}.signalwire.com` : '';
  return /^[a-z0-9][a-z0-9-]*\.signalwire\.com$/.test(host) ? host : null;
}

export function voiceConfig(env = process.env) {
  const v = (k) => String(env[k] || '').trim();
  const provider = (v('VOICE_PROVIDER') || (v('SIGNALWIRE_PROJECT_ID') ? 'signalwire' : 'twilio')).toLowerCase();
  const baseUrl = (v('PUBLIC_URL') || v('RENDER_EXTERNAL_URL')).replace(/\/$/, ''), to = v('OWNER_PHONE'), missing = [];
  let cfg;
  if (provider === 'signalwire') {
    cfg = { provider, host: signalwireHost(v('SIGNALWIRE_SPACE')), accountSid: v('SIGNALWIRE_PROJECT_ID'), keySid: v('SIGNALWIRE_PROJECT_ID'), secret: v('SIGNALWIRE_API_TOKEN'), from: v('SIGNALWIRE_FROM_NUMBER'), to, baseUrl };
    if (!cfg.host) missing.push('SIGNALWIRE_SPACE (yourspace.signalwire.com)');
    if (!UUID.test(cfg.accountSid)) missing.push('SIGNALWIRE_PROJECT_ID (Dashboard → API)');
    if (!cfg.secret) missing.push('SIGNALWIRE_API_TOKEN');
    if (!E164.test(cfg.from)) missing.push('SIGNALWIRE_FROM_NUMBER (like +15551234567)');
  } else {
    cfg = { provider: 'twilio', accountSid: v('TWILIO_ACCOUNT_SID'), keySid: v('TWILIO_API_KEY'), secret: v('TWILIO_API_SECRET') || v('TWILIO_AUTH_TOKEN'), from: v('TWILIO_FROM_NUMBER'), to, baseUrl };
    if (!cfg.keySid) cfg.keySid = cfg.accountSid; // with an auth token the username is the account SID
    if (!/^AC[0-9a-f]{32}$/i.test(cfg.accountSid)) missing.push('TWILIO_ACCOUNT_SID (starts with AC)');
    if (!cfg.secret) missing.push('TWILIO_API_SECRET or TWILIO_AUTH_TOKEN');
    if (v('TWILIO_API_SECRET') && !/^SK[0-9a-f]{32}$/i.test(v('TWILIO_API_KEY'))) missing.push('TWILIO_API_KEY (starts with SK)');
    if (!E164.test(cfg.from)) missing.push('TWILIO_FROM_NUMBER (like +15551234567)');
  }
  if (!E164.test(cfg.to)) missing.push('OWNER_PHONE (like +15551234567)');
  if (!/^https:\/\//.test(cfg.baseUrl)) missing.push('PUBLIC_URL (Render sets RENDER_EXTERNAL_URL itself)');
  return { ...cfg, ready: missing.length === 0, missing };
}

/** Public status for the dashboard: never the secret or the full phone numbers. */
export const voiceStatus = (cfg) => ({ provider: cfg.provider, ready: cfg.ready, missing: cfg.missing, to: maskPhone(cfg.to), from: maskPhone(cfg.from) });

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
/** The call script: play the recorded message once. */
export const voiceXml = (baseUrl, file) => `<?xml version="1.0" encoding="UTF-8"?><Response><Play>${xml(`${baseUrl}/voice/${file}.mp3`)}</Play></Response>`;

export function createVoiceCaller({ cfg, fetchImpl = globalThis.fetch, now = () => Date.now(), minGapMs = 120_000, perDay = 10 }) {
  let last = 0, day = null, count = 0;
  const sw = cfg.provider === 'signalwire', name = sw ? 'SignalWire' : 'Twilio';
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
      // SignalWire (its Twilio-compatible API): the call fetches the script at Url; Twilio takes it inline
      const body = sw ? new URLSearchParams({ To: cfg.to, From: cfg.from, Url: `${cfg.baseUrl}/voice/${file}.xml`, Method: 'GET' })
        : new URLSearchParams({ To: cfg.to, From: cfg.from, Twiml: `<Response><Play>${xml(audio)}</Play></Response>` });
      const endpoint = sw ? `https://${cfg.host}/api/laml/2010-04-01/Accounts/${cfg.accountSid}/Calls.json` : `https://api.twilio.com/2010-04-01/Accounts/${cfg.accountSid}/Calls.json`;
      const r = await fetchImpl(endpoint, {
        method: 'POST', body, signal: AbortSignal.timeout(10_000),
        headers: { Authorization: 'Basic ' + Buffer.from(`${cfg.keySid}:${cfg.secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const hint = sw && (r.status === 401 || r.status === 403) ? ' (SignalWire needs the Project ID and a project API token with the Voice scope: Dashboard → API)' : '';
        throw new Error(`${name} said no (HTTP ${r.status}${j.code ? `, code ${j.code}` : ''}): ${String(j.message || 'unknown error').slice(0, 160)}${hint}`);
      }
      return { sid: j.sid || null, status: j.status || 'queued', to: maskPhone(cfg.to), provider: cfg.provider };
    },
  };
}
