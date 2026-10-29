// DECU COPIER DASHBOARD (v4): the Rolex goal, open coins with a Sell button, every studied trade with filters,
// the what-if tester, the profit calendar, the brain and the bot's controls. Talks only to this server
// (/api/...) with the dashboard token; the numbers come from dashcalc.mjs, the same code the server tests.
import { createWatch } from './watch.js';
import { watchWallets, isPhone, openInApp } from './wallet.js';
import { lineChart, barChart, numbersTable, renderAnalytics } from './charts.js';
import * as C from './dashcalc.mjs';

const $ = (id) => document.getElementById(id);
const h = (tag, cls, text, parent) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; if (parent) parent.append(n); return n; };
const fin = C.fin;
const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } }, del: (k) => { try { localStorage.removeItem(k); } catch { /* private mode */ } } };
const S = {
  token: '', status: null, research: null, goal: null, cal: { mode: null, y: null, m: null, sel: null }, goalEntries: null, analytics: null,
  trades: new Map(), tradesMeta: null, tab: 'home', filters: { ...C.FILTER_DEFAULTS }, shown: 40, wf: structuredClone(C.WHATIF_DEFAULTS), wfRange: 'all', evFilter: 'all',
  lastOk: 0, wallet: null, botBalance: null, at: {},
};
const TABS = ['home', 'trades', 'whatif', 'calendar', 'brain', 'bot'];

// ---------- server ----------
class AuthError extends Error {}
async function api(route, { method = 'GET', text = false } = {}) {
  const r = await fetch(route, { method, headers: S.token ? { Authorization: 'Bearer ' + S.token } : {}, cache: 'no-store' });
  if (r.status === 401) throw new AuthError('The dashboard token was not accepted.');
  if (!r.ok) throw new Error((await r.text().catch(() => '')) || `Request failed (${r.status})`);
  return method === 'GET' && !text ? r.json() : r.text();
}
async function download(route) {
  try {
    const r = await fetch(route, { headers: S.token ? { Authorization: 'Bearer ' + S.token } : {}, cache: 'no-store' });
    if (!r.ok) throw new Error(`Download failed (${r.status})`);
    save(await r.blob(), (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || route.split('/').pop());
  } catch (e) { toast(e.message); }
}
function save(blob, name) { const a = h('a', null, null, document.body); a.href = URL.createObjectURL(blob); a.download = name; a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
let toastTimer = null;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200); }
async function act(route, { ok = null, confirmText = null, confirm2 = null } = {}) {
  if (confirmText && !confirm(confirmText)) return false;
  if (confirm2 && !confirm(confirm2)) return false;
  try { await api(route, { method: 'POST' }); if (ok) toast(ok); poll.status(); return true; } catch (e) { toast(e.message); return false; }
}

// ---------- formatting ----------
const tz = () => S.status?.timezone || S.tradesMeta?.timezone || 'UTC';
const solUsd = () => S.status?.solUsd || S.goal?.solUsd || S.tradesMeta?.solUsd || null;
const buySol = () => S.tradesMeta?.buySol || S.status?.settings?.buySol || 0.1;
const usdOfSol = (sol) => (fin(sol) && solUsd() ? sol * solUsd() : null);
const when = (ms, opts = {}) => (fin(ms) ? new Date(ms).toLocaleString('en-US', { timeZone: tz(), month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...opts }) : '—');
const day = (ms, zone = null) => (fin(ms) ? new Date(ms).toLocaleDateString('en-US', { timeZone: zone || tz(), month: 'short', day: 'numeric' }) : '—');
const clock = (ms) => (fin(ms) ? new Date(ms).toLocaleTimeString('en-US', { timeZone: tz(), hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—');
const monthName = (y, m) => new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const signed = (x) => (fin(x) ? (x > 0 ? 'up' : x < 0 ? 'down' : '') : '');
const symbols = new Map(); // mint -> symbol, rebuilt when trades arrive
const coinOf = (mint) => (symbols.get(mint) ? `$${symbols.get(mint)}` : C.shortMint(mint));
const solscanToken = (m) => `https://solscan.io/token/${encodeURIComponent(m)}`;
const pumpFun = (m) => `https://pump.fun/coin/${encodeURIComponent(m)}`;
const usdSol = (sol, d = 4) => `${C.sol(sol, d)}${fin(usdOfSol(sol)) ? ` · ${C.money(usdOfSol(sol), { sign: true })}` : ''}`;
function tile(parent, label, value, sub = null, cls = '') { const t = h('article', 'tile', null, parent); h('label', null, label, t); h('strong', cls, value, t); if (sub) h('small', null, sub, t); return t; }
function kv(parent, rows) { parent.replaceChildren(); for (const [k, v] of rows) { if (v == null) continue; h('span', null, k, parent); h('b', null, v, parent); } }
function seg(container, options, current, onPick) {
  container.replaceChildren();
  for (const [v, label] of options) { const b = h('button', null, label, container); b.type = 'button'; b.dataset.v = v; b.setAttribute('aria-pressed', String(v === current)); b.onclick = () => onPick(v); }
}
const memo = {};
const changed = (key, sig) => { if (memo[key] === sig) return false; memo[key] = sig; return true; };
const pressed = (container, v) => { for (const b of container.querySelectorAll('button')) b.setAttribute('aria-pressed', String((b.dataset.v ?? b.dataset.style ?? b.dataset.theme) === v)); };

// ---------- sign in ----------
let loginWatch = null, homeWatch = null;
function showLogin(msg = '') {
  $('app').hidden = true; $('login').hidden = false; $('login-error').textContent = msg;
  $('token').focus();
}
async function signIn(token, remember) {
  S.token = token;
  try {
    S.status = await api('/api/status');
    if (remember) store.set('decu.token', token); else store.del('decu.token');
    showApp(); return true;
  } catch (e) { S.token = ''; showLogin(e instanceof AuthError ? 'That token was not accepted. Check DASHBOARD_TOKEN in your Render settings.' : `Can't reach the bot: ${e.message}`); return false; }
}
$('login-form').addEventListener('submit', (e) => { e.preventDefault(); const t = $('token').value.trim(); $('token').value = ''; if (t) signIn(t, $('remember').checked); });
$('signout').onclick = () => { store.del('decu.token'); S.token = ''; location.hash = ''; showLogin('Signed out.'); };

function showApp() {
  $('login').hidden = true; $('app').hidden = false;
  if (!homeWatch) homeWatch = createWatch($('watch'), { label: 'Rolex goal: the gold ring fills with live profit' });
  $('device-note').textContent = store.get('decu.token') ? 'This device remembers the token. Sign out to forget it.' : 'The token is forgotten when you close this page.';
  setTab(TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home', { push: false });
  poll.all();
}

// ---------- navigation ----------
function setTab(tab, { push = true } = {}) {
  S.tab = tab;
  for (const b of document.querySelectorAll('.tab')) { if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  for (const t of TABS) $('view-' + t).hidden = t !== tab;
  $('top-title').textContent = $('view-' + tab).dataset.title;
  if (push) history.replaceState(null, '', '#' + tab);
  window.scrollTo({ top: 0 });
  render();
  if (['trades', 'whatif', 'calendar'].includes(tab) && !S.tradesMeta) poll.trades();
  if (tab === 'calendar') poll.goalEntries();
  if (tab === 'bot') poll.analytics();
  if (tab === 'brain' || tab === 'bot') poll.research();
}
for (const b of document.querySelectorAll('.tab')) b.onclick = () => setTab(b.dataset.tab);
for (const b of document.querySelectorAll('[data-goto]')) b.onclick = () => setTab(b.dataset.goto);
for (const b of document.querySelectorAll('[data-download]')) b.onclick = () => download(b.dataset.download);
window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (TABS.includes(t) && t !== S.tab && !$('app').hidden) setTab(t, { push: false }); });

// ---------- polling (only while the page is visible) ----------
const every = (key, ms) => { const due = Date.now() - (S.at[key] || 0) >= ms; if (due) S.at[key] = Date.now(); return due; };
const visible = () => document.visibilityState === 'visible' && !$('app').hidden;
function failed(e) {
  if (e instanceof AuthError) { store.del('decu.token'); S.token = ''; showLogin('The dashboard token was not accepted anymore. Enter it again.'); return; }
  banner(`Can't reach the bot right now (${e.message}). Retrying…`, 'warn');
}
const poll = {
  async status() { try { S.status = await api('/api/status'); S.lastOk = Date.now(); renderHeader(); if (S.tab === 'home') renderHome(); if (S.tab === 'bot') renderBot(); } catch (e) { failed(e); renderHeader(); } },
  async goal() { try { S.goal = await api('/api/goal'); if (S.tab === 'home') renderHero(); } catch (e) { failed(e); } },
  async goalEntries() { try { const g = await api('/api/goal?entries=1'); S.goal = g; S.goalEntries = g; if (S.tab === 'calendar') renderCalendar(); } catch (e) { failed(e); } },
  async research() { try { S.research = await api('/api/research'); if (S.tab === 'brain') renderBrain(); if (S.tab === 'bot') renderBot(); if (S.tab === 'home') renderFeed(); } catch (e) { failed(e); } },
  async analytics() { try { S.analytics = await api('/api/analytics'); if (S.tab === 'bot') { renderAnalytics($('analytics'), S.analytics); $('analytics-updated').textContent = 'Updated ' + clock(Date.parse(S.analytics.generatedAt)); } } catch (e) { failed(e); } },
  async trades() {
    try {
      const newest = Math.max(0, ...[...S.trades.values()].map((x) => x.time));
      // the last 30 min again: a realized result arrives after the 15 s study, when the position closes
      const d = await api('/api/trades' + (newest ? `?after=${newest - 30 * 60e3}` : ''));
      S.tradesMeta = { mode: d.mode, timezone: d.timezone, buySol: d.buySol, solUsd: d.solUsd, total: d.total, at: d.generatedAt };
      for (const r of d.rows) { S.trades.set(r.id, r); if (r.sym) symbols.set(r.mint, r.sym); }
      if (S.tab === 'trades') renderTradeResults(); if (S.tab === 'whatif') renderWhatIf(); if (S.tab === 'home') renderFeed();
    } catch (e) { failed(e); }
  },
  all() { const now = Date.now(); S.at = { status: now, goal: now, research: now, trades: now, entries: now, analytics: now }; this.status(); this.goal(); this.research(); this.trades(); if (S.tab === 'calendar') this.goalEntries(); if (S.tab === 'bot') this.analytics(); },
};
setInterval(() => {
  if (!visible()) return;
  if (every('status', 2000)) poll.status();
  if (every('goal', 15000) && S.tab !== 'calendar') poll.goal();
  if (every('research', 10000)) poll.research();
  if (every('trades', 30000)) poll.trades();
  if (S.tab === 'calendar' && every('entries', 60000)) poll.goalEntries();
  if (S.tab === 'bot' && every('analytics', 60000)) poll.analytics();
}, 1000);
document.addEventListener('visibilitychange', () => { if (visible()) poll.all(); });

// ---------- header ----------
function banner(text, kind = '') { const b = $('banner'); if (!text) { b.hidden = true; return; } b.textContent = text; b.className = 'banner ' + kind; b.hidden = false; }
function renderHeader() {
  const s = S.status; if (!s) return;
  const mode = $('mode'); mode.className = 'pill ' + (s.power === 'off' ? 'off' : s.mode);
  mode.textContent = s.mode.toUpperCase() + (s.power === 'off' ? ' · OFF' : '');
  const fresh = Date.now() - S.lastOk < 6000;
  $('pulse').className = 'pulse ' + (fresh ? 'on' : 'stale'); $('pulse').title = fresh ? 'Live data' : 'Waiting for the bot';
  if (!fresh) return;
  if (s.power === 'off') banner('The bot is OFF: not watching Decu and not using data credits. Turn it on in Bot → Controls.', 'warn');
  else if (s.readiness && !s.readiness.ready && s.mode !== 'demo') banner(`Not ready to trade: ${s.readiness.blocking.join(', ')}${s.gate ? ` (${s.gate})` : ''}. Details in Bot → Connections.`, 'warn');
  else if (s.gate) banner(`New buys blocked: ${s.gate}`, 'warn');
  else if (s.mode === 'paper') banner('PAPER: real Decu signals, simulated trades. No SOL is spent; profit here is practice.');
  else if (s.mode === 'demo') banner('DEMO: generated trades, no blockchain connection.');
  else banner('');
}

function render() {
  renderHeader();
  ({ home: renderHome, trades: renderTrades, whatif: renderWhatIf, calendar: renderCalendar, brain: renderBrain, bot: renderBot })[S.tab]?.();
}

// ================= HOME =================
function renderHome() { renderHero(); renderTiles(); renderHeld(); renderQuick(); renderFeed(); renderHomeEvents(); }
function renderHero() {
  const g = S.goal; if (!g) return;
  const L = g.live, P = g.paper, goalUsd = g.goalUsd, liveMode = g.mode === 'live';
  $('goal-name').textContent = `The goal · ${g.name}`;
  $('goal-live').textContent = C.money(L.usd);
  $('goal-sub').textContent = L.n || liveMode ? `of ${C.money(goalUsd)} · ${C.pct(L.pct, 2, false)} of the way · live profit only` : `of ${C.money(goalUsd)} · counts real profit from your first LIVE trade`;
  const fillPct = Math.max(0, Math.min(1, L.pct)) * 100;
  $('goal-fill').style.width = fillPct + '%'; $('goal-fill').classList.toggle('min', L.pct > 0 && fillPct < 1);
  $('goal-meter').setAttribute('aria-valuenow', fillPct.toFixed(1));
  const ticks = $('goal-ticks'); ticks.replaceChildren();
  const marks = $('goal-marks'); marks.replaceChildren();
  for (const ms of g.milestones) { const f = ms / goalUsd; if (f < 1) { const t = h('span', null, null, ticks); t.style.left = f * 100 + '%'; } const lab = h('span', L.usd >= ms ? 'done' : '', C.compactMoney(ms), marks); lab.style.left = f * 100 + '%'; }
  $('goal-left').textContent = L.reached ? 'Reached!' : C.money(L.remaining, { cents: false });
  $('goal-left-sub').textContent = `${L.n} live trade${L.n === 1 ? '' : 's'}`;
  $('goal-pace').textContent = L.pace7 ? C.money(L.pace7.perDay, { sign: true }) : '—';
  $('goal-eta').textContent = L.reached ? 'Now ⌚' : L.eta7 ? new Date(L.eta7.date).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : liveMode ? 'not on pace' : 'when live';
  $('goal-eta-sub').textContent = L.reached ? 'time to buy it' : L.eta7 ? `in ${C.duration(L.eta7.days)}` : liveMode ? 'needs a profitable week' : 'starts at the first live trade';
  $('practice-usd').textContent = `${C.money(P.usd, { sign: true })} · ${C.pct(P.pct, 2, false)}`;
  $('practice-fill').style.width = Math.max(0, Math.min(1, P.pct)) * 100 + '%'; $('practice-fill').classList.toggle('min', P.pct > 0);
  const pe = P.eta30;
  $('practice-note').textContent = P.n ? `${P.n} paper trades closed · ${C.pct(P.winRate, 0, false)} made money · at the 30-day paper pace (${C.money(P.pace30?.perDay, { sign: true })}/day): ${pe?.reached ? 'reached' : pe ? C.duration(pe.days) : 'not on pace'}. Paper uses ${buySol()} SOL a trade. See Calendar → What it takes.` : 'No paper trades closed yet.';
  const o = g.open;
  $('goal-open').textContent = o?.n ? `${o.n} open coin${o.n > 1 ? 's' : ''}: ${fin(o.usd) ? C.money(o.usd, { sign: true }) : C.sol(o.sol)} right now, not counted until sold${o.live ? '' : ' (paper)'}.` : '';
  homeWatch?.set({ live: L.pct, practice: P.pct, liveText: C.money(L.usd, { cents: Math.abs(L.usd) < 1000 }), goalText: `${C.compactMoney(goalUsd)} GOAL` });
}
function renderTiles() {
  const s = S.status; if (!s) return;
  const t = $('home-tiles'); t.replaceChildren();
  const bal = s.balance;
  tile(t, s.mode === 'live' ? 'Wallet' : 'Paper wallet', fin(bal) ? `${bal.toFixed(3)} SOL` : '—', fin(bal) && solUsd() ? C.money(bal * solUsd()) : s.mode === 'live' ? 'reading the chain…' : null);
  tile(t, 'Today (closed)', C.sol(s.pnlToday || 0, 3), fin(usdOfSol(s.pnlToday)) ? C.money(usdOfSol(s.pnlToday), { sign: true }) : null, signed(s.pnlToday));
  const rows = [...S.trades.values()].filter((x) => x.bought && fin(x.fcat)), wins = rows.filter((x) => x.fcat > 0).length;
  tile(t, 'Win rate (FCAT)', rows.length ? C.pct(wins / rows.length, 0, false) : '—', rows.length ? `${wins} of ${rows.length} bought` : 'loading trades…');
  const held = s.held?.length || 0;
  tile(t, 'Open coins', `${held}${s.maxPositions ? ' / ' + s.maxPositions : ''}`, `spent today ${(s.spent || 0).toFixed(3)} SOL${s.capUsd ? ` of $${s.capUsd} cap` : ''}`);
}
const cards = new Map();
function renderHeld() {
  const s = S.status; if (!s) return;
  const box = $('held'), list = s.held || [];
  $('held-count').textContent = list.length ? `${list.length} held` : 'none';
  for (const [mint, c] of cards) if (!list.some((p) => p.mint === mint)) { c.el.remove(); cards.delete(mint); }
  box.querySelector('.empty')?.remove();
  if (!list.length) { h('div', 'empty', 'No coins held. The bot buys when Decu buys.', box); return; }
  const stop = s.settings?.rules?.stopLossPct ?? 20, gate = s.settings?.rules?.gainGatePct ?? 15, lo = -stop / 100, hi = Math.max((gate / 100) * 2, 0.3);
  for (const p of list) {
    let c = cards.get(p.mint);
    if (!c) {
      c = { el: h('article', 'coin', null, box) };
      const top = h('div', 'coin-top', null, c.el); c.name = h('b', null, '', top); c.held = h('span', 'fine', '', top);
      c.pnl = h('div', 'coin-pnl', '', c.el);
      const g = h('div', 'gauge', null, c.el); h('b', null, null, g); c.dot = h('i', null, null, g);
      const gl = h('div', 'gauge-labels', null, c.el); h('span', null, `stop −${stop}%`, gl); h('span', null, '0', gl); h('span', null, `+${Math.round(hi * 100)}%`, gl);
      const z = `${((0 - lo) / (hi - lo)) * 100}%`; g.style.setProperty('--z', z); gl.style.setProperty('--z', z);
      const nums = h('div', 'coin-nums', null, c.el); c.nums = ['Cost', 'Value now', 'Best'].map((k) => { const d = h('div', null, k, nums); return h('b', null, '—', d); });
      const row = h('div', 'btn-row', null, c.el), links = h('div', 'btn-row', null, row);
      for (const [label, url] of [['pump.fun', pumpFun(p.mint)], ['Solscan', solscanToken(p.mint)]]) { const a = h('a', 'btn ghost small', label, links); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
      c.sell = h('button', 'btn danger small', 'Sell now', row); c.sell.type = 'button';
      c.sell.onclick = async () => {
        const name = c.name.textContent, live = S.status?.mode === 'live';
        c.sell.disabled = true; c.pending = true;
        const ok = await act('/api/sell/' + encodeURIComponent(p.mint), { ok: `Selling all of ${name}${live ? '' : ' (paper)'}…`,
          confirmText: `Sell ALL of ${name} now?${live ? '\nLIVE: this is a real sale from your wallet.' : '\n(paper: no real money)'}`, confirm2: live ? 'Are you sure? A live sale cannot be undone.' : null });
        c.pending = false; if (!ok) c.sell.disabled = false;
      };
      cards.set(p.mint, c);
    }
    c.name.textContent = p.symbol ? `$${p.symbol}` : C.shortMint(p.mint);
    c.held.textContent = p.boughtAt ? `held ${C.ago(p.boughtAt).replace(' ago', '')}` : '';
    c.pnl.textContent = fin(p.pnl) ? C.pct(p.pnl) : 'pricing…'; c.pnl.className = 'coin-pnl ' + signed(p.pnl);
    c.dot.hidden = !fin(p.pnl); if (fin(p.pnl)) c.dot.style.left = Math.max(0, Math.min(1, (p.pnl - lo) / (hi - lo))) * 100 + '%';
    c.nums[0].textContent = `${p.costSol.toFixed(4)} SOL`; c.nums[1].textContent = fin(p.valueSol) ? `${p.valueSol.toFixed(4)} SOL` : '—'; c.nums[2].textContent = fin(p.peak) ? C.pct(p.peak) : '—';
    if (!c.pending) { c.sell.disabled = !!p.selling; c.sell.textContent = p.selling ? `Selling… (${p.rule === 'manual-sell' ? 'you pressed Sell' : p.rule || 'exit'})` : 'Sell now'; }
  }
}
function renderQuick() {
  const s = S.status; if (!s) return;
  const style = s.paused ? 'off' : s.autoCopy ? 'auto' : 'manual';
  for (const b of $('quick-style').querySelectorAll('button')) { b.setAttribute('aria-pressed', String(b.dataset.style === style)); b.onclick = () => act('/api/style/' + b.dataset.style, { ok: `Trading style: ${b.textContent}` }); }
  $('quick-state').textContent = style === 'off' ? 'no new buys' : style === 'auto' ? 'buys and sells with Decu' : 'buys with Decu; you sell';
  $('quick-emergency').onclick = () => act('/api/emergency', { ok: 'Emergency stop: no new buys.', confirmText: 'EMERGENCY STOP: no new buys until you turn a trading style back on. Continue?' });
}
function renderFeed() {
  const box = $('feed'); if (!box) return;
  const rows = [...S.trades.values()].sort((a, b) => b.time - a.time).slice(0, 8);
  if (!changed('feed', JSON.stringify([rows.map((r) => [r.id, r.fcat, r.real?.sol]), S.research?.recent?.[0]?.time, Math.floor(Date.now() / 30000)]))) return;
  box.replaceChildren();
  if (!rows.length) {
    const rec = S.research?.recent || [];
    if (!rec.length) { h('div', 'empty', 'Waiting for Decu to buy.', box); return; }
    for (const t of rec.slice(0, 8)) feedRow(box, { time: Date.parse(t.time), sym: t.coin.replace(/^\$/, ''), bought: t.taken, skip: t.reason, prem: t.premium, delay: t.latencySec, fcat: t.fcat, mint: '' }, false);
    return;
  }
  for (const r of rows) feedRow(box, r, true);
}
function feedRow(box, r, click) {
  const row = h('div', 'r' + (click ? ' click' : ''), null, box);
  h('span', 'when', C.ago(r.time), row);
  const w = h('div', 'what', null, row); const b = h('b', null, r.sym ? `$${r.sym} ` : `${C.shortMint(r.mint)} `, w); h('span', 'tag ' + (r.bought ? 'bought' : 'skipped'), r.bought ? 'BOUGHT' : 'SKIPPED', b);
  h('small', null, r.bought ? `paid ${C.pct(r.prem)} vs Decu · ${fin(r.delay) ? r.delay + ' s after him' : '—'}` : r.skip || 'skipped', w);
  h('span', 'val ' + signed(r.fcat), fin(r.fcat) ? C.pct(r.fcat) : 'studying…', row);
  if (click) row.onclick = () => openTrade(r);
}
const EVENT_TEXT = { detected: (e) => `Decu ${e.side} seen`, skip: (e) => `Skipped${e.side ? ' ' + e.side : ''}`, building: (e) => `Building ${e.side}`, submitted: (e) => `${e.side === 'buy' ? 'Buy' : 'Sell'} sent`, confirmed: (e) => `${e.side === 'buy' ? 'Bought' : e.closed ? 'Closed' : 'Sold part'}`, failed: (e) => `${e.side || 'Trade'} failed`, unresolved: () => 'Outcome unknown', 'exit-rule': (e) => `Exit: ${{ stoploss: 'stop-loss', 'gain-target': 'gain gate', 'hold-until-his-sell': 'holding for his sell', 'hold-limit': 'time limit', 'sell-all': 'sell everything', 'no-price': 'no price', 'manual-sell': 'you pressed Sell' }[e.rule] || e.rule}`, style: (e) => `Style: ${e.style}`, paused: () => 'Buys paused', resumed: () => 'Buys resumed', 'power-on': () => 'Bot ON', 'power-off': () => 'Bot OFF', 'emergency-stop': () => 'EMERGENCY STOP', started: (e) => `Started (${e.mode})`, error: () => 'Error', breaker: () => 'Circuit breaker', 'leader-sold': () => 'Decu sold a coin you hold', 'price-check-failing': () => 'Price checks failing', unsellable: () => "Can't sell" };
const BAD = new Set(['failed', 'error', 'unresolved', 'unsellable', 'breaker', 'price-check-failing']);
function eventRow(box, e) {
  const row = h('div', 'r' + (BAD.has(e.type) ? ' bad' : ''), null, box);
  h('span', 'when', clock(Date.parse(e.time)), row);
  const w = h('div', 'what', null, row); h('b', null, (EVENT_TEXT[e.type] || ((x) => x.type))(e), w);
  const detail = [e.mint ? coinOf(e.mint) : null, e.reason || e.message || null, fin(e.solDelta) ? C.sol(e.solDelta) : fin(e.sol) ? `${e.sol} SOL` : null, fin(e.pnl) ? C.pct(e.pnl) : null].filter(Boolean).join(' · ');
  if (detail) h('small', null, detail, w);
  const sig = e.signature || e.leaderSignature;
  if (sig && !String(sig).startsWith('paper-') && /^[1-9A-HJ-NP-Za-km-z]{60,}$/.test(sig)) { const a = h('a', 'val link', 'tx', row); a.href = 'https://solscan.io/tx/' + encodeURIComponent(sig); a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  else h('span', 'val', '', row);
}
function renderHomeEvents() {
  const box = $('home-events');
  const ev = [...(S.status?.events || [])].reverse().filter((e) => e.type !== 'detected').slice(0, 8);
  if (!changed('homeEvents', JSON.stringify(ev.map((e) => e.time + e.type)))) return;
  box.replaceChildren();
  if (!ev.length) { h('div', 'empty', 'Nothing yet.', box); return; }
  for (const e of ev) eventRow(box, e);
}

// ================= TRADES =================
let tradeUiBuilt = false;
function renderTrades() {
  if (!tradeUiBuilt) {
    tradeUiBuilt = true;
    seg($('tf-range'), C.DATE_PRESETS, S.filters.range, (v) => { S.filters.range = v; S.filters.day = null; pressed($('tf-range'), v); S.shown = 40; renderTradeResults(); });
    for (const b of $('tf-result').querySelectorAll('button')) b.onclick = () => { S.filters.result = b.dataset.v; pressed($('tf-result'), b.dataset.v); S.shown = 40; renderTradeResults(); };
    $('tf-status').onchange = (e) => { S.filters.status = e.target.value; S.shown = 40; renderTradeResults(); };
    let qt = null; $('tf-q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { S.filters.q = e.target.value; S.shown = 40; renderTradeResults(); }, 180); };
    $('tf-more').onclick = () => { const p = $('tf-panel'); p.hidden = !p.hidden; $('tf-more').setAttribute('aria-expanded', String(!p.hidden)); };
    for (const inp of $('tf-panel').querySelectorAll('[data-f]')) {
      inp.onchange = () => {
        const k = inp.dataset.f;
        if (inp.type === 'checkbox') S.filters[k] = inp.checked;
        else if (inp.tagName === 'SELECT') S.filters[k] = inp.value;
        else { const v = inp.value === '' ? null : Number(inp.value); S.filters[k] = v == null || !fin(v) ? null : 'pct' in inp.dataset ? v / 100 : v; }
        S.shown = 40; renderTradeResults();
      };
    }
    $('tf-reset').onclick = () => { S.filters = { ...C.FILTER_DEFAULTS }; syncFilterUi(); renderTradeResults(); };
    $('tf-showmore').onclick = () => { S.shown += 60; renderTradeResults(); };
    $('tf-csv').onclick = () => save(new Blob([C.rowsCsv(tradeRowsInView(), { buySol: buySol(), solUsd: solUsd(), tz: tz() })], { type: 'text/csv' }), `decu-trades-filtered-${new Date().toISOString().slice(0, 10)}.csv`);
    pressed($('tf-result'), S.filters.result);
  }
  renderTradeResults();
}
/** Put the filter controls in line with S.filters (after a reset, or a day picked in the calendar). */
function syncFilterUi() {
  if (!tradeUiBuilt) return;
  const f = S.filters;
  for (const inp of $('tf-panel').querySelectorAll('[data-f]')) { const v = f[inp.dataset.f]; if (inp.type === 'checkbox') inp.checked = !!v; else if (inp.tagName === 'SELECT') inp.value = v ?? 'any'; else inp.value = v == null ? '' : 'pct' in inp.dataset ? Math.round(v * 100) : v; }
  $('tf-q').value = f.q || ''; $('tf-status').value = f.status; pressed($('tf-range'), f.day ? '' : f.range); pressed($('tf-result'), f.result);
}
const tradeRowsInView = () => [...S.trades.values()].filter((x) => C.matches(x, S.filters, { tz: tz() })).sort((a, b) => b.time - a.time);
function renderTradeResults() {
  if (S.tab !== 'trades') return;
  const n = C.extraFilterCount(S.filters); $('tf-count').hidden = !n; $('tf-count').textContent = String(n);
  const dayChip = $('tf-day'); dayChip.hidden = !S.filters.day; if (S.filters.day) { dayChip.textContent = `${C.dayName(S.filters.day)} ✕`; dayChip.title = 'Show every day again'; dayChip.onclick = () => { S.filters.day = null; renderTradeResults(); }; }
  pressed($('tf-range'), S.filters.day ? '' : S.filters.range);
  const rows = tradeRowsInView(), t = C.totals(rows, { buySol: buySol(), solUsd: solUsd() });
  const tiles = $('trade-tiles'); tiles.replaceChildren();
  tile(tiles, 'Trades', String(t.rows), `${t.bought} bought · ${t.skipped} skipped`);
  tile(tiles, 'Win rate', t.n ? C.pct(t.winRate, 0, false) : '—', `${t.wins} won · ${t.losses} lost`);
  tile(tiles, 'FCAT profit', C.sol(t.sol, 3), C.money(t.usd, { sign: true }), signed(t.sol));
  tile(tiles, 'Realized (bot)', t.realN ? C.sol(t.real, 3) : '—', t.realN ? `${t.realN} closed by the bot` : 'no closed positions here', signed(t.real));
  tile(tiles, 'Average trade', t.n ? C.pct(t.avg) : '—', t.n ? `median paid ${C.pct(t.medianPrem)} · ${fin(t.medianDelay) ? t.medianDelay.toFixed(1) + ' s' : '—'} late` : null, signed(t.avg));
  tile(tiles, 'Best · worst', t.best ? C.pct(t.best.fcat) : '—', t.worst ? `worst ${C.pct(t.worst.fcat)} (${C.coinName(t.worst)})` : null);
  const run = C.runningTotal(rows, { buySol: buySol() });
  lineChart($('trade-chart'), { x: run.map((p) => when(p.time)), xShort: run.map((p) => day(p.time)), series: [{ name: 'Running FCAT profit', values: run.map((p) => p.sol), tone: run.at(-1)?.sol < 0 ? 'neg' : 'pos' }], fmt: (v) => C.sol(v, 3), tableCols: ['trade', 'running profit'] });
  $('trade-list-title').textContent = `${rows.length} trade${rows.length === 1 ? '' : 's'}${S.filters.day ? ' on ' + C.dayName(S.filters.day) : ''}`;
  const list = $('trade-list'); list.replaceChildren();
  const head = h('div', 'thead', null, list); for (const c of ['When', 'Coin', 'Status', 'Paid vs Decu', 'Late', 'Market cap', "Decu's buy", 'FCAT', 'Profit', 'Sold at']) h('span', null, c, head);
  if (!rows.length) h('div', 'empty', S.trades.size ? 'No trades match these filters.' : 'Loading trades…', list);
  for (const r of rows.slice(0, S.shown)) {
    const p = C.profitSol(r, r.fcat, buySol()), u = C.usdOf(p, r, solUsd());
    const row = h('div', 'trow', null, list); row.tabIndex = 0;
    row.onclick = () => openTrade(r); row.onkeydown = (e) => { if (e.key === 'Enter') openTrade(r); };
    h('span', 'm', when(r.time), row);
    const c1 = h('div', 'c1', null, row); const b = h('b', null, C.coinName(r) + ' ', c1); if (!r.first) h('span', 'tag', 'LATER BUY', b);
    h('small', null, `${when(r.time)} · paid ${C.pct(r.prem)} · ${fin(r.delay) ? r.delay + ' s late' : '—'} · ${fin(r.mcap) ? C.compactMoney(r.mcap) + ' mcap' : 'mcap ?'}${r.skip ? ' · ' + r.skip : ''}`, c1);
    const st = h('span', 'm', null, row); h('span', 'tag ' + (r.bought ? 'bought' : 'skipped'), r.bought ? 'BOUGHT' : 'SKIPPED', st);
    h('span', 'm n', C.pct(r.prem), row); h('span', 'm n', fin(r.delay) ? `${r.delay} s` : '—', row); h('span', 'm n', fin(r.mcap) ? C.compactMoney(r.mcap) : '—', row); h('span', 'm n', fin(r.hisUsd) ? C.money(r.hisUsd, { cents: false }) : '—', row);
    h('span', 'm n ' + signed(r.fcat), C.pct(r.fcat), row); h('span', 'm n', fin(u) ? C.money(u, { sign: true }) : C.sol(p), row);
    h('span', 'm', r.exit || '—', row);
    const c2 = h('div', 'c2', null, row); h('span', signed(r.fcat), C.pct(r.fcat), c2); h('small', null, fin(u) ? C.money(u, { sign: true }) : C.sol(p), c2);
  }
  $('tf-showmore').hidden = rows.length <= S.shown;
}

// ---------- one trade in full ----------
async function openTrade(r) {
  const d = $('trade-dialog');
  $('td-eyebrow').textContent = `${when(r.time, { year: 'numeric' })} · ${r.bought ? 'bought' : 'skipped'}`;
  $('td-title').textContent = `${C.coinName(r)}  ${C.pct(r.fcat)}`;
  const body = $('td-body'); body.replaceChildren();
  const tags = h('div', 'btn-row', null, body);
  h('span', 'tag ' + (r.bought ? 'bought' : 'skipped'), r.bought ? 'BOUGHT' : 'SKIPPED', tags);
  if (r.skip) h('span', 'tag', r.skip, tags);
  if (r.safe != null) h('span', 'tag ' + (r.safe ? 'good' : 'bad'), r.safe ? 'HOLDERS SAFE' : 'HOLDERS RISKY', tags);
  if (!r.first) h('span', 'tag', 'COPIED A LATER BUY', tags);
  const p = C.profitSol(r, r.fcat, buySol());
  const facts = h('div', 'facts', null, body);
  const fact = (k, v) => { const f = h('div', 'fact', null, facts); h('span', null, k, f); h('b', null, v, f); };
  fact('FCAT (sold when Decu sold)', `${C.pct(r.fcat)} · ${usdSol(p)}`);
  if (r.real) fact('Realized by the bot', `${usdSol(r.real.sol)}${r.real.rule ? ' · ' + C.ruleName(r.real.rule) : ''}`);
  fact('Paid above Decu', C.pct(r.prem)); fact('Late after Decu', fin(r.delay) ? `${r.delay} s${fin(r.blocks) ? ` · ${r.blocks} blocks` : ''}` : '—');
  fact('Buyers ahead of you', r.crowd ?? '—'); fact('Market cap at his buy', fin(r.mcap) ? C.money(r.mcap, { cents: false }) : '—');
  fact("Decu's buy", fin(r.hisUsd) ? `${C.money(r.hisUsd, { cents: false })}${fin(r.hisSol) ? ` · ${r.hisSol} SOL` : ''}` : '—');
  fact('Holders', r.holders ?? '—'); fact('Coin age', fin(r.ageMin) ? `${r.ageMin} min` : '—');
  fact('Sold', r.exit || '—'); fact('Best second', fin(r.peak) ? `${C.pct(r.peak)} at ${r.btsab ?? '?'} s` : '—'); fact('Worst', C.pct(r.worst));
  fact('PCAT (at his price)', C.pct(r.pcat)); fact('Brain predicted', C.pct(r.pred)); fact('Decu buys in 10 min before', r.busy ?? '—');
  if (Array.isArray(r.curve) && r.curve.some(fin)) {
    const card = h('div', null, null, body); h('h3', null, 'Result if sold at each second (fees in)', card);
    const box = h('div', 'chart-box', null, card);
    const marks = [];
    if (fin(r.hisSold)) marks.push({ i: Math.min(r.curve.length - 1, Math.ceil(r.hisSold)), label: 'Decu sold' });
    if (fin(r.exitSec) && !(fin(r.hisSold) && Math.ceil(r.hisSold) === r.exitSec)) marks.push({ i: r.exitSec, label: 'FCAT exit' });
    requestAnimationFrame(() => lineChart(box, { x: r.curve.map((_, s) => `${s} s`), series: [{ name: 'Result', values: r.curve.map((v) => (fin(v) ? v * 100 : null)), tone: (r.fcat ?? 0) < 0 ? 'neg' : 'pos' }], fmt: (v) => C.pct(v / 100), yFmt: (v) => `${v}%`, marks, area: false, tableCols: ['second', 'result'] }));
  }
  const links = h('div', 'btn-row', null, body);
  for (const [label, url] of [['pump.fun', pumpFun(r.mint)], ['Solscan', solscanToken(r.mint)]]) { const a = h('a', 'btn ghost small', label, links); a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  const mint = h('p', 'mono', r.mint, body); mint.title = 'Mint address';
  const more = h('div', null, null, body);
  d.showModal();
  try {
    const full = await api(`/api/trade?mint=${encodeURIComponent(r.mint)}&time=${r.time}`);
    for (const [title, list] of [['Notes', full.notes], ['What the brain thought', full.thinking]]) {
      if (!Array.isArray(list) || !list.length) continue;
      h('h3', null, title, more); const ul = h('ul', 'notes', null, more); for (const x of list) h('li', null, String(x), ul);
    }
  } catch { /* the list row has the numbers already */ }
}
$('td-close').onclick = () => $('trade-dialog').close();
$('trade-dialog').addEventListener('click', (e) => { if (e.target === $('trade-dialog')) $('trade-dialog').close(); });

// ================= WHAT-IF =================
const RULE_UI = {
  prem: { def: 20, pct: true, step: 1, unit: '%' }, mcapMax: { def: 10000, step: 1000, unit: '$' }, mcapMin: { def: 5000, step: 1000, unit: '$' }, hisUsdMin: { def: 100, step: 50, unit: '$' },
  delayMax: { def: 2, step: 0.5, unit: 's' }, crowdMax: { def: 2, step: 1, unit: '' }, busyMax: { def: 3, step: 1, unit: '' },
};
const EXIT_UI = [{ key: 'tp', label: 'Take profit at', unit: '% up', def: 30, toVal: (v) => v / 100, fromVal: (v) => Math.round(v * 100) }, { key: 'sl', label: 'Stop loss at', unit: '% down', def: 20, toVal: (v) => -Math.abs(v) / 100, fromVal: (v) => Math.round(-v * 100) }, { key: 'at', label: 'Sell after', unit: 'seconds', def: 5, toVal: (v) => v, fromVal: (v) => v }];
let wfBuilt = false;
function wfOpts() { return { ...S.wf, buySol: buySol(), solUsd: solUsd(), tz: tz() }; }
function wfRows() { const from = C.rangeFrom(S.wfRange, Date.now(), tz()); return [...S.trades.values()].filter((x) => from == null || x.time >= from); }
function ruleRow(box, { label, sub = null, on, onToggle, input = null, best = null }) {
  const r = h('div', 'rule' + (on ? '' : ' off'), null, box);
  const cb = h('input', null, null, r); cb.type = 'checkbox'; cb.checked = on; cb.setAttribute('aria-label', label); cb.onchange = () => onToggle(cb.checked);
  const l = h('div', 'rl', label, r); if (sub) h('small', null, sub, l);
  if (input) r.append(input); else h('span', null, '', r);
  if (best) { const b = h('div', 'best', null, r); best(b); }
  return r;
}
function numInput(value, { step = 1, min = null, onChange, label }) { const i = document.createElement('input'); i.type = 'number'; i.step = String(step); if (min != null) i.min = String(min); i.value = value ?? ''; i.setAttribute('aria-label', label); i.onchange = () => onChange(i.value === '' ? null : Number(i.value)); return i; }
function renderWhatIf() {
  if (!wfBuilt) {
    wfBuilt = true;
    seg($('wf-range'), C.DATE_PRESETS, S.wfRange, (v) => { S.wfRange = v; pressed($('wf-range'), v); renderWhatIf(); });
    $('wf-skipped').onchange = (e) => { S.wf.includeSkipped = e.target.checked; renderWhatIf(); };
    $('wf-clear').onclick = () => { S.wf = structuredClone(C.WHATIF_DEFAULTS); $('wf-skipped').checked = true; renderWhatIf(); };
  }
  pressed($('wf-range'), S.wfRange);
  const rows = wfRows(), rules = S.wf.rules, exit = S.wf.exit;
  // rules
  const rb = $('wf-rules'); rb.replaceChildren();
  for (const R of C.RULES) {
    const ui = RULE_UI[R.key], on = R.bool ? !!rules[R.key] : rules[R.key] != null;
    const shown = ui?.pct && rules[R.key] != null ? Math.round(rules[R.key] * 100) : rules[R.key];
    const input = R.bool ? null : numInput(shown ?? ui.def, { step: ui.step, min: 0, label: R.label, onChange: (v) => { rules[R.key] = v == null ? null : ui.pct ? v / 100 : v; renderWhatIf(); } });
    if (input && !on) input.disabled = true;
    ruleRow(rb, { label: R.label, sub: R.unit && !R.bool ? R.unit : null, on, input,
      onToggle: (v) => { rules[R.key] = R.bool ? v : v ? (ui.pct ? ui.def / 100 : ui.def) : null; renderWhatIf(); },
      best: R.bool ? null : (b) => bestUi(b, R.key, (v) => (v == null ? 'off' : ui.pct ? `${Math.round(v * 100)}%` : ui.unit === '$' ? C.money(v, { cents: false }) : `${v}${ui.unit ? ' ' + ui.unit : ''}`), (v) => { rules[R.key] = v; renderWhatIf(); }) });
  }
  // hours of the day (bot timezone)
  const hrOn = fin(rules.hourFrom) && fin(rules.hourTo);
  const hrs = h('div', 'btn-row'); const f = numInput(rules.hourFrom ?? 9, { min: 0, label: 'From hour', onChange: (v) => { rules.hourFrom = v; renderWhatIf(); } }), t = numInput(rules.hourTo ?? 23, { min: 0, label: 'To hour', onChange: (v) => { rules.hourTo = v; renderWhatIf(); } });
  f.max = t.max = '23'; f.disabled = t.disabled = !hrOn; hrs.append(f, t);
  const hr = ruleRow(rb, { label: 'Only between these hours', sub: `${tz()} time, 0-23`, on: hrOn, onToggle: (v) => { if (v) { rules.hourFrom = 9; rules.hourTo = 23; } else { rules.hourFrom = null; rules.hourTo = null; } renderWhatIf(); } });
  hr.querySelector('span:last-child')?.replaceWith(hrs);
  // exits
  const eb = $('wf-exit'); eb.replaceChildren();
  h('p', 'fine', 'Default: when Decu sells (or 15 s after his buy). These are tested on the first 15 seconds, the window the bot records every second.', eb);
  for (const X of EXIT_UI) {
    const on = exit[X.key] != null;
    const input = numInput(on ? X.fromVal(exit[X.key]) : X.def, { min: 0, label: X.label, onChange: (v) => { exit[X.key] = v == null ? null : X.toVal(v); renderWhatIf(); } });
    if (!on) input.disabled = true;
    ruleRow(eb, { label: X.label, sub: X.unit, on, input, onToggle: (v) => { exit[X.key] = v ? X.toVal(X.def) : null; renderWhatIf(); },
      best: (b) => bestUi(b, X.key, (v) => (v == null ? 'off (sell when Decu sells)' : X.key === 'at' ? `${v} s` : `${X.key === 'sl' ? '−' : '+'}${Math.round(Math.abs(v) * 100)}%`), (v) => { exit[X.key] = v; renderWhatIf(); }) });
  }
  // results
  const res = C.whatIf(rows, wfOpts()), A = res.actual, B = res.test, delta = B.sol - A.sol;
  const v = $('wf-verdict'); v.replaceChildren(); v.className = 'card verdict ' + res.verdict.kind;
  h('p', 'eyebrow', 'Your rules vs what the bot did', v);
  h('div', 'delta ' + signed(delta), `${C.sol(delta, 4)}${fin(usdOfSol(delta)) ? ` · ${C.money(usdOfSol(delta), { sign: true })}` : ''}`, v);
  const line = h('div', 'vline', null, v);
  const icon = { holds: ['✓', 'good'], luck: ['⚠', 'warn'], recent: ['⚠', 'warn'], few: ['…', 'warn'], worse: ['✕', 'crit'], same: ['○', ''] }[res.verdict.kind] || ['○', ''];
  h('span', 'ic ' + icon[1], icon[0], line); h('span', null, res.verdict.text, line);
  h('p', 'fine', `${res.trades} studied Decu buys in range · your rules buy ${B.n}${B.added ? ` (${B.added} the bot skipped)` : ''}; the bot bought ${A.n}.`, v);
  const bar = $('wf-bar'); bar.replaceChildren(); h('span', 'ic ' + icon[1], icon[0], bar); const bb = h('div', null, null, bar); h('b', signed(delta), C.sol(delta, 3), bb); bb.append(' vs the bot'); h('span', 'fine', `${B.n} trades · ${C.sol(B.sol, 3)}`, bar);
  const cmp = $('wf-compare'); cmp.replaceChildren();
  for (const [name, X, cls] of [['What the bot did', A, 'cmp'], ['With your rules', B, 'cmp test']]) {
    const c = h('article', cls, null, cmp); const t3 = h('h3', null, null, c); h('span', 'key ' + (cls === 'cmp' ? 'steel' : 'gold'), null, t3); t3.append(name);
    h('div', 'big ' + signed(X.sol), C.sol(X.sol, 3), c);
    const k = h('div', 'kv', null, c);
    kv(k, [['In $', C.money(X.usd, { sign: true })], ['Trades', String(X.n)], ['Win rate', C.pct(X.winRate, 0, false)], ['Avg trade', C.sol(X.avg, 4)], ['Worst drop', C.sol(X.dd, 3)]]);
  }
  lineChart($('wf-chart'), { x: res.series.map((p) => when(p.time)), xShort: res.series.map((p) => day(p.time)), series: [{ name: 'What the bot did', values: res.series.map((p) => p.actual), tone: 'muted' }, { name: 'Your rules', values: res.series.map((p) => p.test), tone: 'pos' }], fmt: (v) => C.sol(v, 3), tableCols: ['Decu buy', 'the bot', 'your rules'] });
  // what each rule removes
  const rm = $('wf-removed'); rm.replaceChildren();
  const entries = Object.entries(res.removed);
  if (!entries.length) h('p', 'fine', 'Switch a rule on to see which trades it takes out and what they made.', rm);
  else {
    const tb = h('table', 't', null, rm), hd = h('tr', null, null, tb); for (const c of ['Rule', 'Takes out', 'They made', '']) h('th', ['Takes out', 'They made'].includes(c) ? 'n' : null, c, hd);
    const labels = Object.fromEntries([...C.RULES.map((R) => [R.key, R.label]), ['hours', 'Hours of the day']]);
    for (const [k, g] of entries) { const tr = h('tr', null, null, tb); h('td', null, labels[k] || k, tr); h('td', 'n', `${g.n} (${g.bought} bought)`, tr); h('td', 'n', C.sol(g.sol, 3), tr); h('td', null, g.n === 0 ? '—' : g.sol < 0 ? '✓ cuts losers' : '✕ cuts winners', tr); }
  }
  const sp = $('wf-split'); sp.replaceChildren();
  const tb = h('table', 't', null, sp), hd = h('tr', null, null, tb); for (const c of ['', 'Trades', 'The bot', 'Your rules', 'Difference']) h('th', c && c !== '' ? 'n' : null, c, hd);
  for (const [name, part] of [[`Older ${Math.round(res.split * 100)}%`, res.older], [`Newer ${Math.round((1 - res.split) * 100)}%`, res.newer]]) { const tr = h('tr', null, null, tb); h('td', null, name, tr); h('td', 'n', String(part.n), tr); h('td', 'n', C.sol(part.a, 3), tr); h('td', 'n', C.sol(part.b, 3), tr); h('td', 'n', C.sol(part.b - part.a, 3), tr); }
  h('p', 'fine', 'A rule is believable when it beats the bot on the newer trades too: those were not used to pick it.', sp);
}
function bestUi(box, key, label, use) {
  const btn = h('button', 'link', 'Find the best value', box);
  btn.onclick = () => {
    const b = C.bestValue(wfRows(), key, wfOpts()); box.replaceChildren();
    if (!b) { h('span', null, 'Not enough trades.', box); return; }
    h('span', null, `Best on older trades: ${label(b.value)} → older ${C.sol(b.olderGain, 3)}, newer ${C.sol(b.newerGain, 3)} vs the bot ${b.holds ? '✓ holds up' : '⚠ newer trades disagree'}`, box);
    const u = h('button', 'link', 'Use it', box); u.onclick = () => use(b.value);
  };
}

// ================= CALENDAR =================
let calBuilt = false;
function renderCalendar() {
  const g = S.goalEntries || S.goal;
  if (!calBuilt) {
    calBuilt = true;
    for (const b of $('cal-mode').querySelectorAll('button')) b.onclick = () => { S.cal.mode = b.dataset.v; S.cal.sel = null; renderCalendar(); };
    $('cal-prev').onclick = () => { S.cal.m--; if (S.cal.m < 1) { S.cal.m = 12; S.cal.y--; } S.cal.sel = null; renderCalendar(); };
    $('cal-next').onclick = () => { S.cal.m++; if (S.cal.m > 12) { S.cal.m = 1; S.cal.y++; } S.cal.sel = null; renderCalendar(); };
  }
  if (!g) { $('cal-grid').replaceChildren(h('div', 'empty', 'Loading…')); return; }
  if (!S.cal.mode) S.cal.mode = g.live.n ? 'live' : 'paper';
  if (S.cal.y == null) { const p = C.zoneParts(Date.now(), tz()); S.cal.y = p.y; S.cal.m = p.mo; }
  pressed($('cal-mode'), S.cal.mode);
  const side = g[S.cal.mode], days = side.days || {};
  $('cal-basis').textContent = S.cal.mode === 'live' ? 'Real money: realized profit of positions the bot closed, by day' : 'Practice: paper positions the bot closed, by day (not counted toward the Rolex)';
  const { y, m } = S.cal, prefix = `${y}-${String(m).padStart(2, '0')}`;
  $('cal-month').textContent = monthName(y, m);
  const monthDays = Object.fromEntries(Object.entries(days).filter(([k]) => k.startsWith(prefix)));
  const ms = C.dayStats(monthDays);
  $('cal-month-total').textContent = ms.days ? `${C.money(ms.usd, { sign: true })} · ${ms.days} trading day${ms.days > 1 ? 's' : ''} · ${ms.trades} trades` : 'No closed trades this month';
  const max = Math.max(1e-9, ...Object.values(monthDays).map((d) => Math.abs(d.usd || 0)));
  const bin = (v) => (v === 0 ? 'z0' : `${v > 0 ? 'p' : 'n'}${Math.min(4, Math.max(1, Math.ceil((Math.abs(v) / max) * 4)))}`);
  const grid = $('cal-grid'); grid.replaceChildren();
  for (const d of ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']) h('div', 'dow', d, grid);
  const today = C.dayKey(Date.now(), tz());
  for (const week of C.monthGrid(y, m, days)) for (const c of week) {
    if (!c) { h('div', 'day pad', null, grid); continue; }
    const has = c.data?.n > 0, cell = h('button', 'day' + (has ? ' has ' + bin(c.data.usd || 0) : '') + (c.key === today ? ' today' : '') + (S.cal.sel === c.key ? ' sel' : ''), null, grid);
    cell.type = 'button'; h('small', null, String(c.d), cell);
    if (has) { h('b', null, C.cellMoney(c.data.usd), cell); cell.setAttribute('aria-label', `${c.key}: ${C.money(c.data.usd, { sign: true })}, ${c.data.n} trades`); cell.onclick = () => { S.cal.sel = c.key; renderCalendar(); }; }
    else { cell.disabled = true; cell.setAttribute('aria-label', `${c.key}: no closed trades`); }
  }
  const sc = $('cal-scale'); sc.replaceChildren(); h('span', null, 'Lost', sc); const sw = h('span', 'sw', null, sc); for (const k of ['n4', 'n3', 'n2', 'n1', 'z0', 'p1', 'p2', 'p3', 'p4']) h('span', k, null, sw); h('span', null, `Made · darkest = ${C.money(max, { cents: max < 100 })} or more this month`, sc);
  const tbl = $('cal-table'); tbl.replaceChildren(); numbersTable(tbl, ['day', 'profit', 'SOL', 'trades', 'won'], Object.entries(monthDays).sort().map(([k, d]) => [k, C.money(d.usd, { sign: true }), C.sol(d.sol, 4), d.n, d.wins]), { label: 'Every day' }).open = true;
  // the selected day
  const dayBox = $('cal-day'); dayBox.hidden = !S.cal.sel;
  if (S.cal.sel) {
    dayBox.replaceChildren(); const dd = days[S.cal.sel] || { usd: 0, n: 0, wins: 0, sol: 0 };
    const head = h('div', 'card-head', null, dayBox); h('h2', null, new Date(S.cal.sel + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }), head);
    const go = h('button', 'link', 'See these Decu buys in Trades', head); go.onclick = () => { S.filters = { ...C.FILTER_DEFAULTS, range: 'all', day: S.cal.sel }; S.shown = 40; syncFilterUi(); setTab('trades'); };
    h('p', 'muted', `${C.money(dd.usd, { sign: true })} (${C.sol(dd.sol)}) from ${dd.n} closed position${dd.n === 1 ? '' : 's'}, ${dd.wins || 0} made money.`, dayBox);
    const list = h('div', 'rows', null, dayBox);
    for (const e of (side.entries || []).filter((x) => C.dayKey(x.t, tz()) === S.cal.sel).reverse()) { const r = h('div', 'r', null, list); h('span', 'when', clock(e.t), r); const w = h('div', 'what', null, r); h('b', null, e.symbol ? `$${e.symbol}` : C.shortMint(e.mint), w); h('small', null, C.ruleName(e.rule), w); h('span', 'val ' + signed(e.usd), C.money(e.usd, { sign: true }), r); }
  }
  // stats over every day of this mode
  const all = C.dayStats(days), tiles = $('cal-tiles'); tiles.replaceChildren();
  tile(tiles, 'This month', C.money(ms.usd, { sign: true }), ms.days ? `${ms.green} green · ${ms.red} red days` : '—', signed(ms.usd));
  tile(tiles, 'Best day', all.best ? C.money(all.best.usd, { sign: true }) : '—', all.best ? C.dayName(all.best.day) : null, signed(all.best?.usd));
  tile(tiles, 'Worst day', all.worst ? C.money(all.worst.usd, { sign: true }) : '—', all.worst ? C.dayName(all.worst.day) : null, signed(all.worst?.usd));
  tile(tiles, 'Streak now', all.streak ? `${all.streak.n} ${all.streak.kind} day${all.streak.n > 1 ? 's' : ''}` : '—', `longest green ${all.longestGreen} · red ${all.longestRed}`);
  tile(tiles, 'Average trading day', C.money(all.avg, { sign: true }), `${all.days} days · ${all.trades} trades`, signed(all.avg));
  tile(tiles, 'Green days', all.days ? C.pct(all.green / all.days, 0, false) : '—', `${all.wins} of ${all.trades} trades made money`);
  // running profit by day, weekday, hour
  const keys = Object.keys(days).filter((k) => days[k].n > 0).sort(); let run = 0;
  $('cal-run-sub').textContent = `${S.cal.mode === 'live' ? 'real' : 'paper'} · ${keys.length} trading days`;
  lineChart($('cal-run'), { x: keys, xShort: keys.map((k) => day(Date.parse(k + 'T12:00:00Z'), 'UTC')), series: [{ name: 'Running profit', values: keys.map((k) => (run += days[k].usd || 0)), tone: run < 0 ? 'neg' : 'pos' }], fmt: (v) => C.money(v, { sign: true }), yFmt: (v) => C.compactMoney(v), tableCols: ['day', 'running profit'] });
  const wh = C.byWeekdayHour(side.entries || [], tz());
  barChart($('cal-wd'), { x: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], values: wh.weekday.map((d) => (d.n ? d.usd : null)), fmt: (v) => C.money(v, { sign: true }), yFmt: (v) => C.compactMoney(v), notes: wh.weekday.map((d) => `${d.n} trades, ${d.wins} won`), valueLabels: false });
  barChart($('cal-hr'), { x: wh.hour.map((d) => `${d.i}h`), values: wh.hour.map((d) => (d.n ? d.usd : null)), fmt: (v) => C.money(v, { sign: true }), yFmt: (v) => C.compactMoney(v), notes: wh.hour.map((d) => `${d.n} trades, ${d.wins} won`) });
  renderPath(g);
}
function renderPath(g) {
  const box = $('path-body'); box.replaceChildren();
  const side = g.live.n ? g.live : g.paper, which = g.live.n ? 'live' : 'paper', p = side.path;
  if (!p) { h('p', 'fine', 'Needs a few closed trades first.', box); return; }
  h('p', 'muted', `From your ${which === 'live' ? 'live' : 'paper (practice)'} trades so far: ${p.trades} closed, ${p.tradesPerDay.toFixed(1)} a day, each made ${C.pct(p.roi, 2)} of what it cost on average (fees in). Still to go: ${C.money(g.live.remaining, { cents: false })}.`, box);
  if (!(p.roi > 0)) { h('p', 'muted', 'Your average trade is not profitable yet, so no trade size gets you there: a bigger size only loses faster. Improve the edge first (the What-if tab shows which rules would have helped).', box); return; }
  const tb = h('table', 't', null, box), hd = h('tr', null, null, tb); for (const c of ['Trade size', 'Per trade', 'Per day', 'Rolex in']) h('th', c === 'Trade size' ? null : 'n', c, hd);
  for (const s of p.sizes) { const tr = h('tr', null, null, tb); h('td', null, `${s.size} SOL${fin(solUsd()) ? ` (${C.money(s.size * solUsd(), { cents: false })})` : ''}${Math.abs(s.size - buySol()) < 1e-9 ? ' · now' : ''}`, tr); h('td', 'n', C.money(p.roi * s.size * (solUsd() || 0), { sign: true }), tr); h('td', 'n', C.money(s.perDay, { sign: true }), tr); h('td', 'n', C.duration(s.days), tr); }
  const t2 = h('p', 'muted', null, box); t2.textContent = 'To get there by a date: ' + p.targets.map((t) => `${C.duration(t.days)} → about ${t.size < 0.001 ? t.size.toFixed(5) : t.size.toFixed(3)} SOL a trade`).join(' · ') + '.';
  h('p', 'fine', 'Assumes the average holds and a bigger buy fills like a small one. It does not always: a bigger buy moves the price more and pays more above Decu. Grow the size step by step and watch the premium.', box);
}

// ================= BRAIN =================
function renderBrain() {
  const r = S.research, T = r?.thinking;
  const rank = $('brain-rank'); rank.replaceChildren();
  if (!T) { h('p', 'fine', r ? 'The brain starts after the first studied trades.' : 'Loading…', rank); return; }
  const rb = h('div', 'rank-badge', null, rank); h('div', 'rank-ring', String(T.rank.index), rb);
  const rt = h('div', null, null, rb); h('p', 'eyebrow gold', 'Brain rank', rt); h('h2', null, T.rank.name, rt); h('p', 'fine', `${T.rank.index} of ${T.rank.of} · $1,000 paper bankroll now ${C.money(T.rank.bankrollUsd)}`, rt);
  if (T.rank.next) { h('p', 'fine', `To reach ${T.rank.next.name}:`, rank); const ck = h('div', 'checks', null, rank); for (const c of T.rank.next.checks) h('div', c.ok ? 'ok' : '', c.text, ck); } else h('p', 'fine', 'Top rank reached.', rank);
  const goal = $('brain-goal'); goal.replaceChildren();
  const gh = h('div', 'card-head', null, goal); h('h2', null, "The brain's own goal", gh); h('span', 'fine', 'paper', gh);
  if (T.goal) { h('p', 'hero-sub', `${C.money(T.goal.profitUsd, { sign: true })} of ${C.money(T.goal.usd, { cents: false })} profit on its $1,000 paper bankroll${T.goal.reached ? ' · REACHED' : ''}`, goal); const m = h('div', 'meter thin steel', null, goal); const f = h('div', 'meter-fill', null, m); f.style.width = Math.max(0, Math.min(1, T.goal.pct)) * 100 + '%'; }
  if (r.brain) h('p', 'fine', `Level ${r.brain.level} ${r.brain.name} · ${r.brain.trades} trades · go-live checklist ${r.brain.readiness.passed}/${r.brain.readiness.of}${r.brain.accuracy ? ` · predictions ${Math.round(r.brain.accuracy.rate * 100)}% right` : ''}`, goal);
  const rules = $('brain-rules'); rules.replaceChildren(); const rh = h('div', 'card-head', null, rules); h('h2', null, 'Rules the brain trades by', rh); h('span', 'fine', T.autoTune ? 'auto-tune ON (paper)' : 'auto-tune off', rh);
  kv(h('div', 'kv', null, rules), [['Pay at most above Decu', `${T.rules.maxPayPct}% (your setting ${T.defaults.maxPayPct}%)`], ['Stop loss', `−${T.rules.stopLossPct}% (setting −${T.defaults.stopLossPct}%)`], ['Gain gate', `+${T.rules.gainGatePct}% (setting +${T.defaults.gainGatePct}%)`], ['Brain skips', `${T.vetoes.skipped} (${T.vetoes.rightSkips} were right)`]]);
  const mir = $('brain-mirror'); mir.replaceChildren(); const mh = h('div', 'card-head', null, mir); h('h2', null, '$10 mirror', mh); h('span', 'fine', `${T.mirror.trades} trades`, mh);
  kv(h('div', 'kv', null, mir), [['Decu, perfectly copied', C.money(T.mirror.perfectUsd, { sign: true })], ['Yours (same exits)', C.money(T.mirror.yourUsd, { sign: true })], ['Lost to the delay', C.money(T.mirror.delayUsd, { sign: true })], ['Fees', C.money(-T.mirror.feesUsd, { sign: true })], ['After fees', C.money(T.mirror.afterFeesUsd, { sign: true })]]);
  const tests = $('brain-tests'); tests.replaceChildren();
  for (const t of T.tests || []) { const c = h('div', 'test', null, tests); const st = t.supported ? ['SUPPORTED', 'good'] : /not enough/.test(t.verdict) ? ['COLLECTING', ''] : ['NOT SUPPORTED', 'bad']; const b = h('b', null, t.name + ' ', c); h('span', 'tag ' + st[1], st[0], b); h('span', 'fine', t.verdict, c); if (t.best) h('span', 'fine', `Best on older trades: ${t.best.label} (${C.sol(t.best.train, 3)} older, ${C.sol(t.best.test, 3)} newer) · ${t.trades} trades`, c); }
  if (!T.tests?.length) h('p', 'fine', 'Tests run every 10 bought trades.', tests);
  const pat = $('brain-patterns'); pat.replaceChildren();
  for (const p of (T.patterns || []).slice(0, 10)) { const r2 = h('div', 'r', null, pat); h('span', 'tag ' + (p.status === 'confirmed' ? 'gold' : ''), p.status.toUpperCase(), r2); const w = h('div', 'what', null, r2); h('b', null, p.label, w); h('small', null, `${p.wins}/${p.trades} won`, w); h('span', 'val ' + signed(p.avgFcat), C.pct(p.avgFcat), r2); }
  if (!T.patterns?.length) h('div', 'empty', 'No patterns strong enough yet.', pat);
  const dec = $('brain-decisions'); dec.replaceChildren();
  for (const d of T.decisions.slice().reverse()) { const r2 = h('div', 'r', null, dec); h('span', 'when', C.ago(Date.parse(d.time)), r2); const w = h('div', 'what', null, r2); h('b', null, d.kind, w); h('small', null, d.text, w); h('span', 'val', '', r2); }
  if (!T.decisions.length) h('div', 'empty', 'No decisions yet.', dec);
  const mc = $('brain-mcap'); mc.replaceChildren();
  if ((T.marketCaps || []).length) { const tb = h('table', 't', null, mc), hd = h('tr', null, null, tb); for (const c of ['Market cap', 'Trades', 'Won', 'Avg FCAT']) h('th', c === 'Market cap' ? null : 'n', c, hd); for (const g2 of T.marketCaps) { const tr = h('tr', null, null, tb); h('td', null, g2.label, tr); h('td', 'n', g2.n, tr); h('td', 'n', g2.wins, tr); h('td', 'n', C.pct(g2.avgFcat), tr); } } else h('p', 'fine', 'Not enough trades with a market cap yet.', mc);
  const ln = $('brain-line'); ln.replaceChildren(); const Sp = T.speed;
  if (Sp?.groups?.length) { const tb = h('table', 't', null, ln), hd = h('tr', null, null, tb); for (const c of ['Others ahead', 'Trades', 'Paid', 'Avg FCAT']) h('th', c === 'Others ahead' ? null : 'n', c, hd); for (const g2 of Sp.groups) { const tr = h('tr', null, null, tb); h('td', null, g2.label, tr); h('td', 'n', g2.n, tr); h('td', 'n', C.pct(g2.avgPremium), tr); h('td', 'n', C.pct(g2.avgFcat), tr); } if (Sp.faster) h('p', 'fine', `${Sp.faster.ms} ms faster ≈ ${C.sol(Sp.faster.solPerMonth, 3)} a month`, ln); } else h('p', 'fine', 'Counting buyers ahead of you…', ln);
  const V = T.vault; $('brain-vault').textContent = V ? `${V.files} notes${V.sync ? (V.sync.ok === false ? ` · GitHub sync failing: ${V.sync.error}` : V.sync.at ? ` · synced to GitHub ${C.ago(V.sync.at)}` : ' · GitHub sync waiting for its first push') : ' · GitHub sync off (download the vault instead)'}${V.unsynced ? ` · ${V.unsynced} not synced yet` : ''}` : 'Second brain not started.';
  renderResearch();
}
function renderResearch() {
  const out = $('research'); out.replaceChildren(); const r = S.research;
  const row = (title, text, bad = false) => { const x = h('div', 'r plain' + (bad ? ' bad' : ''), null, out); const w = h('div', 'what', null, x); h('b', null, title, w); h('small', null, text, w); };
  if (!r?.trades) { h('div', 'empty', 'No studied trades yet.', out); return; }
  row('Results', `FCAT ${C.sol(r.fcatSol)} · win rate ${C.pct(r.winRate, 0, false)} · profit factor ${fin(r.profitFactor) ? r.profitFactor.toFixed(2) : '—'} · max drawdown ${C.sol(r.maxDrawdownSol)} · bought ${r.taken} / skipped ${r.skipped}`);
  if (r.filters?.length) row('Entry-premium limits on the same trades', r.filters.map((f) => `${f.pct}%${f.trading ? ' (trading)' : ''}: ${f.trades} trades, ${f.wins} won, ${C.sol(f.fcatSol, 3)}`).join(' · '));
  if (r.holders && (r.holders.safe.trades || r.holders.risky.trades)) row('Holder money rule at the buy', `SAFE ${r.holders.safe.trades} trades, ${r.holders.safe.wins} won, ${C.sol(r.holders.safe.fcatSol, 3)} · RISKY ${r.holders.risky.trades} trades, ${r.holders.risky.wins} won, ${C.sol(r.holders.risky.fcatSol, 3)}`);
  for (const x of r.exitTests || []) if (x.trades) row(`Paper test: ${x.name}`, `${C.sol(x.pnlSol, 3)} vs your rules ${C.sol(x.yoursSol, 3)} on the same ${x.trades} trades`);
  row('Entry premium', `median ${C.pct(r.medianEntryPremium)} · average ${C.pct(r.avgEntryPremium)} over Decu's price`);
  const L = r.latency || {};
  row('Execution latency', `median ${fin(L.medianSec) ? L.medianSec.toFixed(2) + ' s' : '—'} (p95 ${fin(L.p95Sec) ? L.p95Sec.toFixed(2) + ' s' : '—'}) from his block · bot part ${fin(L.botMedianMs) ? Math.round(L.botMedianMs) + ' ms' : '—'} · build ${fin(L.buildMedianMs) ? Math.round(L.buildMedianMs) + ' ms' : '—'} · land ${fin(L.landMedianMs) ? Math.round(L.landMedianMs) + ' ms' : '—'} · ${L.blocksMedian ?? '—'} blocks after Decu`);
  const rs = Object.entries(r.skipReasons || {}); if (rs.length) row('Why buys were skipped', rs.sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v}× ${k}`).join(' · '));
}

// ================= BOT =================
let walletsStarted = false;
function renderBot() {
  const s = S.status; if (!s) return;
  const off = s.power === 'off';
  $('power-state').textContent = off ? 'OFF: not watching Decu, no Helius or Solscan credits used.' : 'ON: watching Decu.';
  $('power-on').setAttribute('aria-pressed', String(!off)); $('power-off').setAttribute('aria-pressed', String(off));
  const style = s.paused ? 'off' : s.autoCopy ? 'auto' : 'manual';
  for (const b of $('style-seg').querySelectorAll('button')) { b.setAttribute('aria-pressed', String(b.dataset.style === style)); b.onclick = () => act('/api/style/' + b.dataset.style, { ok: 'Trading style changed.' }); }
  $('style-state').textContent = style === 'auto' ? 'Auto: buys when Decu buys, sells when he sells (plus the exit rules).' : style === 'manual' ? 'Buys when Decu buys; you sell (SOLD alert). The stop-loss still sells.' : 'Off: no new buys.';
  $('buy-state').textContent = s.paused ? 'Paused: no new buys.' : s.gate ? `Blocked: ${s.gate}` : 'Allowed.';
  $('resume').setAttribute('aria-pressed', String(!s.paused)); $('pause').setAttribute('aria-pressed', String(!!s.paused));
  $('alerts-state').textContent = s.alertsOff ? 'Off (a LIVE trade with an unknown outcome still alerts).' : 'On.';
  $('alerts-on').setAttribute('aria-pressed', String(!s.alertsOff)); $('alerts-off').setAttribute('aria-pressed', String(!!s.alertsOff));
  $('ctl-state').textContent = `${s.mode.toUpperCase()} · updated ${clock(Date.now())}`;
  // wallets
  const addr = s.wallet?.publicKey || s.wallet?.signerAddress;
  $('bot-addr').textContent = addr || 'No signer key configured';
  $('bot-copy').disabled = !addr; $('bot-solscan').hidden = !addr; if (addr) $('bot-solscan').href = 'https://solscan.io/account/' + encodeURIComponent(addr);
  $('bot-pumpfun').hidden = !addr; if (addr) $('bot-pumpfun').href = 'https://pump.fun/profile/' + encodeURIComponent(addr); // its coins, as pump.fun shows them
  const bal = s.mode === 'live' ? s.balance : S.botBalance;
  $('bot-wallet-note').textContent = !addr ? 'Add PHANTOM_PRIVATE_KEY in Render to trade live.' : `${s.mode === 'live' ? 'Trading LIVE from this wallet' : 'Ready for LIVE (paper now: no SOL is used)'} · balance on chain ${fin(bal) ? bal.toFixed(4) + ' SOL' + (solUsd() ? ` (${C.money(bal * solUsd())})` : '') : '…'}${fin(bal) && bal < 0.03 && s.mode !== 'live' ? ' · fund it before going live' : ''}`;
  if (addr && s.mode !== 'live' && every('botBalance', 60000)) api('/api/wallet/balance?address=' + encodeURIComponent(addr)).then((b) => { S.botBalance = b.sol; }).catch(() => {});
  if (!walletsStarted) { walletsStarted = true; watchWallets(renderWalletPick); }
  // settings, speed
  const st = s.settings || {}, R = st.rules || {}, D = st.ruleDefaults || {};
  kv($('settings'), [['Buy size', `${st.buySol} SOL${solUsd() ? ` (${C.money(st.buySol * solUsd())})` : ''}`], ['Max open coins', String(st.maxPositions || '∞')], ['Pay at most above Decu', `${R.maxPayPct}%${D.maxPayPct !== R.maxPayPct ? ` (setting ${D.maxPayPct}%, brain-tuned)` : ''}`], ['Stop loss', `−${R.stopLossPct}%`], ['Gain gate', `+${R.gainGatePct}% within ${st.gateSec} s of Decu's buy`], ['Time limit', `${Math.round((st.holdLimitSec || 0) / 60)} min`], ["Decu's buy at least", C.money(st.minLeaderUsd, { cents: false })], ['Daily spending cap', st.dailyCapUsd ? C.money(st.dailyCapUsd, { cents: false }) : 'none'], ['Daily loss limit', st.dailyLossLimit ? `${st.dailyLossLimit} SOL` : 'none'], ['Brain auto-tune', st.autoTune ? 'on (paper)' : 'off']]);
  const lv = S.research?.live, L = S.research?.latency || {};
  kv($('speed'), lv ? [['Fees per side now', `${Number(lv.fees.priorityFeeSol + lv.fees.tipSol).toFixed(4)} SOL (priority ${Number(lv.fees.priorityFeeSol).toFixed(4)} + tip ${Number(lv.fees.tipSol).toFixed(4)})`], ['Fee mode', lv.feeMode === 'max' ? 'live maximum' : 'fixed'], ['Push stream', lv.push ? 'ON' : 'off'], ['Price checks', lv.priceChecks ? `${lv.priceChecks.push} pushed / ${lv.priceChecks.poll} polled` : '—'], ['Late after Decu (median)', fin(L.medianSec) ? `${L.medianSec.toFixed(2)} s · ${L.blocksMedian ?? '—'} blocks` : '—'], ['Bot part (median)', fin(L.botMedianMs) ? `${Math.round(L.botMedianMs)} ms` : '—'], ['Sell desk', lv.sellDesk ? `${lv.sellDesk.holding} armed · ${lv.sellDesk.closes} accounts closed (rent back)` : '—']] : [['Loading', '…']]);
  // connections
  const k = s.connection || {}, conn = $('conn'); conn.replaceChildren(); $('conn-updated').textContent = 'Updated ' + clock(Date.now());
  const crow = (name, ok, text, warn = false) => { const r = h('div', 'r' + (ok === false && !warn ? ' bad' : ''), null, conn); h('span', 'tag ' + (ok === false ? (warn ? 'gold' : 'bad') : ok ? 'good' : ''), ok === false ? (warn ? 'WARN' : 'ISSUE') : ok ? 'OK' : '—', r); const w = h('div', 'what', null, r); h('b', null, name, w); h('small', null, text, w); h('span', 'val', '', r); };
  const RD = s.readiness;
  if (RD) { const top = h('div', 'r plain', null, conn); const w = h('div', 'what', null, top); h('b', null, RD.ready ? '✓ Ready to trade' : `✕ Not ready to trade: ${RD.blocking.join(', ')}`, w); h('small', null, `Checked ${clock(Date.parse(RD.at))}${RD.warnings.length ? ` · warnings: ${RD.warnings.join(', ')}` : ''} · outside monitors can watch /ready (200 = ready, 503 = not)`, w); for (const x of RD.checks) crow(x.name, x.ok, x.detail, x.warn); }
  const fs = k.firstSeen || {};
  crow('Helius websocket', k.websocket === 'subscribed', `${k.websocket || '—'} · last poll ${k.lastPoll ? clock(k.lastPoll) : '—'} · errors ${k.errors ?? 0} · first to see his trade: websocket ${fs.ws || 0}, poll ${fs.poll || 0}`);
  if (k.arb?.seen) crow("Decu's arbitrage swaps", true, `${k.arb.seen} seen, not trades to copy · downloaded 2 at a time so a burst can't flood Helius${k.arb.waiting ? ` · ${k.arb.waiting} waiting` : ''}`);
  const sc = k.solscan; crow('Solscan backup', sc ? sc.ok !== false : null, !sc ? 'off' : `${sc.ok === false ? sc.note || sc.error || 'error' : sc.ok ? `OK ${sc.latencyMs ?? '?'} ms` : sc.note || 'starting'}${s.solscanUsage ? ` · today ${s.solscanUsage.requests}${s.solscanUsage.budget ? ' / ' + s.solscanUsage.budget : ''} requests` : ''} · gaps caught ${k.gaps || 0}`);
  const pp = k.pumpportal; crow('PumpPortal feed', pp ? (pp.on ? pp.connected : null) : null, !pp ? '—' : !pp.on ? pp.note || 'off' : pp.connected ? `connected · first ${fs.pumpportal || 0}` : `connecting${pp.lastError ? ' (' + pp.lastError + ')' : ''}`);
  if (k.rpcHealth) crow('RPC health (last minute)', !(k.rpcHealth.refused || k.rpcHealth.timedOut), `refused ${k.rpcHealth.refused ?? 0} · timed out ${k.rpcHealth.timedOut ?? 0} · errors ${k.rpcHealth.errors ?? 0}`);
  crow('Other', null, `non-SOL trades skipped ${k.unsupported || 0} · other wallets filtered ${(k.otherWallets || 0) + (k.filteredWs || 0)}${k.lastError ? ' · last error: ' + k.lastError : ''}`);
  // pending
  const jobs = $('jobs'); jobs.replaceChildren();
  if (!s.jobs?.length) h('div', 'empty', 'No pending transactions.', jobs);
  for (const j of s.jobs || []) { const r = h('div', 'r' + (j.phase === 'unresolved' ? ' bad' : ''), null, jobs); h('span', 'tag', j.side.toUpperCase(), r); const w = h('div', 'what', null, r); h('b', null, `${coinOf(j.mint)} · ${j.phase}`, w); h('small', null, j.signature || '', w); h('span', 'val', fin(j.sol) ? `${j.sol} SOL` : '', r); }
  renderEvents();
  if (S.analytics && !$('analytics').childNodes.length) renderAnalytics($('analytics'), S.analytics);
  pressed($('theme-seg'), document.documentElement.dataset.theme);
}
function renderEvents() {
  const out = $('events'), want = S.evFilter;
  const ev = [...(S.status?.events || [])].reverse().filter((e) => want === 'all' || (want === 'errors' ? BAD.has(e.type) : ['confirmed', 'failed', 'exit-rule', 'submitted', 'skip'].includes(e.type)));
  if (!changed('events', want + JSON.stringify(ev.map((e) => e.time + e.type)))) return;
  out.replaceChildren();
  if (!ev.length) h('div', 'empty', 'No matching events.', out);
  for (const e of ev) eventRow(out, e);
}
function renderWalletPick(list) {
  const box = $('wallet-pick'); box.replaceChildren();
  if (S.wallet) return;
  for (const w of list) {
    const b = h('button', 'wbtn', null, box); b.type = 'button';
    if (w.icon) { const i = h('img', null, null, b); i.src = w.icon; i.alt = ''; } else h('span', 'wico ' + w.name.toLowerCase(), w.name[0], b);
    b.append(`Connect ${w.name}`); h('small', null, w.source === 'standard' ? 'detected' : 'browser extension', b);
    b.onclick = async () => { try { const address = await w.connect(); S.wallet = { name: w.name, address, w }; showWallet(); } catch (e) { toast(`${w.name}: ${e.message || 'connection refused'}`); } };
  }
  if (!list.length) {
    h('p', 'fine', isPhone() ? 'No wallet in this browser. Open the dashboard inside your wallet app:' : 'No Solana wallet found in this browser. Install the Solflare or Phantom extension, or open the dashboard inside the wallet app on your phone:', box);
    for (const [app, name] of [['solflare', 'Solflare'], ['phantom', 'Phantom']]) { const a = h('a', 'wbtn', null, box); h('span', 'wico ' + app, name[0], a); a.append(`Open in ${name}`); h('small', null, 'app browser', a); a.href = openInApp(app); a.rel = 'noopener'; }
  }
}
async function showWallet() {
  const W = S.wallet, s = S.status; $('wallet-pick').hidden = true; $('wallet-connected').hidden = false;
  $('my-addr').textContent = W.address;
  const bot = s?.wallet?.publicKey || s?.wallet?.signerAddress;
  const same = bot && W.address === bot;
  const note = $('my-note'); note.className = 'fine ' + (same ? 'match' : bot ? 'mismatch' : '');
  note.textContent = `${W.name} · ${same ? '✓ This is the wallet the bot trades from.' : bot ? `A different wallet from the bot's (${C.shortMint(bot)}). To fund the bot, send SOL from here to the bot's address.` : 'The bot has no signer key yet.'}`;
  try { const b = await api('/api/wallet/balance?address=' + encodeURIComponent(W.address)); note.textContent += ` · balance ${b.sol.toFixed(4)} SOL${solUsd() ? ` (${C.money(b.sol * solUsd())})` : ''}`; } catch { /* balance is optional */ }
}
$('my-disconnect').onclick = async () => { await S.wallet?.w?.disconnect(); S.wallet = null; $('wallet-pick').hidden = false; $('wallet-connected').hidden = true; watchWallets(renderWalletPick); };
const copy = async (text, what) => { try { await navigator.clipboard.writeText(text); toast(`${what} copied.`); } catch { toast(text); } };
$('bot-copy').onclick = () => copy($('bot-addr').textContent, "The bot's address");
$('my-copy').onclick = () => copy(S.wallet?.address || '', 'Your address');
$('power-on').onclick = () => act('/api/power/on', { ok: 'Bot ON: watching Decu.' });
$('power-off').onclick = async () => {
  if (!confirm('Turn the bot OFF? It stops watching Decu and stops using Helius and Solscan credits until you turn it back ON.')) return;
  const go = (q) => fetch('/api/power/off' + q, { method: 'POST', headers: { Authorization: 'Bearer ' + S.token }, cache: 'no-store' });
  try { let r = await go(''); if (r.status === 409) { const why = await r.text(); if (!confirm(why + '\n\nTurn OFF anyway?')) return; r = await go('?force=1'); } if (!r.ok) throw new Error('Request failed: ' + r.status); toast('Bot OFF.'); poll.status(); } catch (e) { toast(e.message); }
};
$('pause').onclick = () => act('/api/pause', { ok: 'New buys paused.' });
$('resume').onclick = () => act('/api/resume', { ok: 'New buys allowed.' });
$('alerts-on').onclick = () => act('/api/alerts/on', { ok: 'Phone alerts on.' });
$('alerts-off').onclick = () => act('/api/alerts/off', { ok: 'Phone alerts off.' });
$('emergency').onclick = () => act('/api/emergency', { ok: 'Emergency stop: no new buys.', confirmText: 'EMERGENCY STOP: no new buys until you turn a trading style back on. Continue?' });
$('sellall').onclick = () => act('/api/sell-all', { ok: 'Selling every coin…', confirmText: `Sell EVERY open coin now?${S.status?.mode === 'live' ? ' LIVE: real sells.' : ''}`, confirm2: 'Are you sure? This cannot be undone.' });
$('analytics-send').onclick = async () => { try { toast(await api('/api/analytics/send', { method: 'POST' })); } catch (e) { toast(e.message); } };
for (const b of $('ev-filter').querySelectorAll('button')) b.onclick = () => { S.evFilter = b.dataset.v; pressed($('ev-filter'), b.dataset.v); renderEvents(); };
pressed($('ev-filter'), 'all');
for (const b of $('theme-seg').querySelectorAll('button')) b.onclick = () => setTheme(b.dataset.theme);
function setTheme(t) { document.documentElement.dataset.theme = t; store.set('decu.theme', t); pressed($('theme-seg'), t); }

// ---------- start ----------
setTheme(store.get('decu.theme') || 'two-tone');
const saved = store.get('decu.token');
if (saved) signIn(saved, true); else showLogin();
