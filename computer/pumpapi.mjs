// OFFICIAL PUMP.FUN DEVELOPER API (read-only, https://docs.pump.fun): profiles, follow graph, callouts, leaderboards and
// public wallet positions. It can NOT trade. The key (pf_live_...) is read only from the private server-side env var
// PUMP_API_KEY and only ever sent in this server's Authorization header (pump.fun revokes a key seen in a browser).
// Default limits: 2 requests a second, 50,000 a day; this client stays under both. Off when no key is set.
export function createPumpApi({ key = process.env.PUMP_API_KEY || '', base = 'https://api.pump.fun/v1', fetchImpl = globalThis.fetch, perSec = 2, perDay = 45_000, now = () => Date.now() } = {}) {
  if (!key) return null;
  let day = null, used = 0, last = 0, chain = Promise.resolve();
  const status = { calls: 0, failed: 0, lastError: null, remaining: null };
  const get = (route, params = {}) => (chain = chain.then(async () => {
    const d = new Date(now()).toISOString().slice(0, 10); if (d !== day) { day = d; used = 0; }
    if (used >= perDay) throw new Error('pump.fun API: daily budget used');
    const wait = last + 1000 / perSec - now(); if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = now(); used++; status.calls++;
    const url = new URL(base.replace(/\/$/, '') + '/' + String(route).replace(/^\//, ''));
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, String(v));
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    status.remaining = r.headers?.get?.('x-ratelimit-remaining') ?? status.remaining;
    if (!r.ok) { status.failed++; status.lastError = `HTTP ${r.status}`; throw new Error(`pump.fun API: HTTP ${r.status}`); }
    return r.json();
  }).catch((e) => { status.lastError = String(e.message).split(key).join('***'); throw e; }));
  return { get, status: () => ({ on: true, ...status, usedToday: used }) };
}
