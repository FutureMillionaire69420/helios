// ONE extra Helius websocket for everything that should be pushed instead of polled:
//   - slotSubscribe:      the current block, so detection delay is measured in blocks (exact)
//   - signatureSubscribe: "your transaction is confirmed" the moment it happens (no 0.8 s polling)
//   - accountSubscribe:   every change of a held coin's bonding curve (price) as it happens
// Reconnects by itself and re-subscribes everything. Callers always keep a polling fallback, so a
// dead socket only makes things slower, never wrong.

export function createStream({ url, WebSocketImpl = globalThis.WebSocket, log = () => {}, pingMs = 30_000, freshMs = 3000, staleMs = 10_000 } = {}) {
  let ws = null, stopped = false, backoff = 500, nextId = 1, open = false, lastMsgAt = 0;
  // A new block arrives every ~0.4 s, so silence means the socket stalled: pushed data is trusted only
  // while messages are flowing (freshMs), and a socket silent for staleMs is closed and reconnected.
  const fresh = () => open && Date.now() - lastMsgAt < freshMs;
  let slot = null, slotAt = 0;
  const pending = new Map();     // request id -> {key, unsubMethod}
  const subs = new Map();        // local key -> {method, params, unsubMethod, onNotify, subId}
  const bySubId = new Map();     // server subscription id -> local key
  let keySeq = 0;

  const send = (method, params) => {
    const id = nextId++;
    try { ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); } catch { return null; }
    return id;
  };
  const subscribe = (key) => {
    const s = subs.get(key);
    if (!s || !open) return;
    const id = send(s.method, s.params);
    if (id != null) pending.set(id, { key, unsubMethod: s.unsubMethod });
  };

  // The socket went away (closed, failed or stalled): forget server ids, reconnect with backoff.
  const dropped = () => {
    open = false;
    for (const s of subs.values()) { s.ready = false; if (s.subId != null) bySubId.delete(s.subId); s.subId = null; }
    pending.clear();
    if (stopped) return;
    setTimeout(connect, backoff).unref?.();
    backoff = Math.min(backoff * 2, 15_000);
  };
  const connect = () => {
    if (stopped || !url || !WebSocketImpl) return;
    let sock;
    try { sock = ws = new WebSocketImpl(url); } catch (e) { log(`stream: ${e.message}`); setTimeout(connect, backoff).unref?.(); return; }
    // every handler ignores a socket that was already replaced (a late close of a stalled one)
    sock.onopen = () => {
      if (ws !== sock) return;
      open = true; backoff = 500; lastMsgAt = Date.now();
      for (const key of subs.keys()) subscribe(key);
    };
    sock.onmessage = (ev) => {
      if (ws !== sock) return;
      lastMsgAt = Date.now();
      let m;
      try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
      if (m.id != null && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        const s = subs.get(p.key);
        if (typeof m.result === 'number') {
          if (s) { s.subId = m.result; bySubId.set(m.result, p.key); s.ready = true; }
          else send(p.unsubMethod, [m.result]); // cancelled before the server answered: close it there too
        }
        return;
      }
      const subId = m.params?.subscription;
      if (subId == null) return;
      const key = bySubId.get(subId), s = key != null && subs.get(key);
      if (!s) return;
      if (m.method === 'slotNotification') { slot = m.params.result?.slot ?? slot; slotAt = Date.now(); }
      try { s.onNotify(m.params.result, Date.now()); } catch { /* a callback error never breaks the stream */ }
    };
    sock.onclose = () => { if (ws !== sock) return; ws = null; dropped(); };
    sock.onerror = () => {};
  };

  const add = (method, params, unsubMethod, onNotify) => {
    const key = ++keySeq;
    subs.set(key, { method, params, unsubMethod, onNotify, subId: null, ready: false });
    subscribe(key);
    const un = () => {
      const s = subs.get(key); if (!s) return;
      subs.delete(key);
      if (s.subId != null) { bySubId.delete(s.subId); if (open) send(s.unsubMethod, [s.subId]); }
    };
    un.ready = () => fresh() && !!subs.get(key)?.ready; // pushes for THIS subscription are flowing
    return un;
  };

  connect();
  add('slotSubscribe', [], 'slotUnsubscribe', () => {});
  const ping = setInterval(() => { if (open) send('getHealth', []); }, pingMs); ping.unref?.();
  const watchdog = setInterval(() => {
    if (!open || Date.now() - lastMsgAt <= staleMs) return;
    log(`stream: no data for ${Math.round(staleMs / 1000)} s, reconnecting`);
    const w = ws; ws = null; try { w?.close(); } catch {}
    dropped();
  }, 1000); watchdog.unref?.();

  return {
    connected: () => fresh(),
    /** Latest block number seen, and how old that is (ms). */
    slot: () => (open && slot != null && Date.now() - slotAt < 5000 ? slot : null),
    /** Resolves {err} once the signature is confirmed (or failed), or null after timeoutMs. */
    waitSignature(sig, { commitment = 'confirmed', timeoutMs = 45_000 } = {}) {
      return new Promise((resolve) => {
        let done = false, un = null;
        const finish = (v) => { if (done) return; done = true; clearTimeout(t); un?.(); resolve(v); };
        const t = setTimeout(() => finish(null), timeoutMs); t.unref?.();
        un = add('signatureSubscribe', [sig, { commitment }], 'signatureUnsubscribe', (r) => finish({ err: r?.value?.err ?? null }));
      });
    },
    /** onData(base64Data, receivedAt) on every change of the account. Returns an unsubscribe function. */
    watchAccount(pubkey, onData, { commitment = 'processed' } = {}) {
      const un = add('accountSubscribe', [pubkey, { encoding: 'base64', commitment }], 'accountUnsubscribe', (r, at) => { const d = r?.value?.data; if (Array.isArray(d)) onData(d[0], at); });
      return un;
    },
    /** True once the server acknowledged every current subscription (pushes are flowing). */
    ready: () => fresh() && [...subs.values()].every((s) => s.ready),
    stop() { stopped = true; clearInterval(ping); clearInterval(watchdog); try { ws?.close(); } catch {} },
  };
}
