// PUMPPORTAL LIVE TRADE FEED: a second, independent way to see Decu's trades, next to the Helius websocket.
// wss://pumpportal.fun/api/data?api-key=KEY, then subscribeAccountTrade [his wallet]: every buy and sell he
// makes is pushed. Since May 2026 trade data needs a PumpPortal API key; PumpPortal bills 0.01 SOL per
// 10,000 trades streamed to the key's linked wallet (keep at least 0.02 SOL there). Only his trades are
// streamed, so that is a fraction of a cent a day.
// PumpPortal blacklists clients that open many connections: ONE socket, reconnecting slowly (2 s doubling
// to 60 s). The key is never logged.
// Nothing here signs or sends a transaction.

export const PUMPPORTAL_DATA_URL = 'wss://pumpportal.fun/api/data';

/** One PumpPortal trade message -> {sig, mint, trader, side, sol, raw, pool, vSol, vTok}, or null. */
export function tradeFromPumpPortal(m) {
  if (!m || typeof m.signature !== 'string' || typeof m.mint !== 'string' || !['buy', 'sell'].includes(m.txType)) return null;
  const sol = Number(m.solAmount), tokens = Number(m.tokenAmount);
  if (!(sol > 0) || !(tokens > 0)) return null;
  // amounts arrive in SOL and whole tokens (pump.fun coins have 6 decimals); reserves are after his trade
  const vSol = Number(m.vSolInBondingCurve), vTok = Number(m.vTokensInBondingCurve);
  return {
    sig: m.signature, mint: m.mint, trader: m.traderPublicKey || null, side: m.txType, sol, raw: Math.round(tokens * 1e6),
    pool: m.pool || null,
    vSol: vSol > 0 ? Math.round(vSol * 1e9) : null, vTok: vTok > 0 ? Math.round(vTok * 1e6) : null,
  };
}

export function createPumpPortalFeed({ apiKey, accounts, onTrade, WebSocketImpl = globalThis.WebSocket, url = PUMPPORTAL_DATA_URL, log = () => {}, minBackoffMs = 2000, maxBackoffMs = 60_000, now = () => Date.now() } = {}) {
  const state = { connected: false, subscribed: false, connects: 0, messages: 0, trades: 0, lastMsgAt: null, lastTradeAt: null, lastError: null };
  let ws = null, stopped = false, timer = null, backoff = minBackoffMs, openedAt = 0;
  // every text that leaves the feed (log lines, errors, even a server message echoing the key) is scrubbed
  const hide = (t) => (apiKey ? String(t).split(apiKey).join('***').split(encodeURIComponent(apiKey)).join('***') : String(t));
  const say = (t) => log(hide(t));
  const connect = () => {
    if (stopped) return;
    if (!apiKey) { state.lastError = 'PUMPPORTAL_API_KEY not set'; return; }
    if (!WebSocketImpl) { state.lastError = 'no WebSocket in this Node version'; return; }
    let sock;
    try { sock = ws = new WebSocketImpl(`${url}?api-key=${encodeURIComponent(apiKey)}`); } catch (e) { state.lastError = hide('connect: ' + String(e?.message || e).split('?')[0]); return retry(); }
    state.connects++;
    sock.onopen = () => {
      if (ws !== sock) return;
      state.connected = true; openedAt = now();
      try { sock.send(JSON.stringify({ method: 'subscribeAccountTrade', keys: accounts })); } catch { /* the close handler reconnects */ }
      say('PumpPortal: connected, watching ' + accounts.length + ' wallet' + (accounts.length === 1 ? '' : 's'));
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      const at = now();
      state.messages++; state.lastMsgAt = at;
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      const t = tradeFromPumpPortal(m);
      if (t) { state.trades++; state.lastTradeAt = at; try { onTrade(t, at); } catch { /* a callback error never breaks the feed */ } return; }
      // non-trade messages: the subscription answer, or an error (bad key, no balance on its wallet)
      const text = hide(String(m?.message || m?.error || m?.errors || '')).slice(0, 200);
      if (/subscrib/i.test(text) && !/error|fail|invalid|denied|insufficient/i.test(text)) state.subscribed = true;
      else if (text) { state.lastError = text; say('PumpPortal: ' + text); }
    };
    sock.onclose = (ev) => {
      if (ws !== sock) return;
      ws = null; state.connected = false; state.subscribed = false;
      if (stopped) return;
      if (now() - openedAt > 60_000) backoff = minBackoffMs; // it had been working: try again soon
      state.lastError = hide(`closed (code ${ev?.code ?? '?'}${ev?.reason ? ': ' + String(ev.reason).slice(0, 120) : ''})`);
      say(`PumpPortal: connection ${state.lastError}, reconnecting in ${Math.round(backoff / 1000)} s`);
      retry();
    };
    sock.onerror = () => {};
  };
  const retry = () => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(connect, backoff); timer.unref?.();
    backoff = Math.min(backoff * 2, maxBackoffMs);
  };
  connect();
  return {
    status: () => ({ ...state }),
    stop() { stopped = true; clearTimeout(timer); const w = ws; ws = null; state.connected = false; state.subscribed = false; try { w?.close(); } catch {} },
  };
}
