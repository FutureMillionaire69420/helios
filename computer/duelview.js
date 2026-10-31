// DIP vs FCAT tab and the What-if additions (dip triggers, holders in depth). Renders /api/duel; every number is
// computed on the server (duel.mjs). Split down the middle: DIP on the left, FCAT on the right.
import * as C from './dashcalc.mjs';
import { lineChart } from './charts.js';

const fin = C.fin;
const h = (tag, cls, text, parent) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; if (parent) parent.append(n); return n; };
const tone = (x) => (fin(x) ? (x > 0 ? 'up' : x < 0 ? 'down' : '') : '');
const SIDES = [['dip', 'DIP', 'Buys the dip back to Decu’s price'], ['fcat', 'FCAT', 'Buys as soon as Decu buys']];
const usd = (sol, d) => (fin(sol) && d?.solUsd > 0 ? C.money(sol * d.solUsd, { sign: true }) : null);
const tiny = (v) => (v < 0 ? '−' : '+') + Math.abs(v).toFixed(Math.abs(v) >= 1 ? 1 : 2).replace(/^0/, ''); // +.13
const num = (v, d = 3) => (fin(v) ? C.sol(v, d).replace(' SOL', '') : '—');
const coin = (x) => (x?.sym ? `$${x.sym}` : C.shortMint(x?.mint));
const when = (ms, tz) => { try { return new Date(ms).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { return new Date(ms).toISOString().slice(5, 16); } };
const card = (parent, title, sub) => { const c = h('article', 'card', null, parent), hd = h('div', 'card-head', null, c); h('h2', null, title, hd); if (sub) h('span', 'fine', sub, hd); return c; };
const kvs = (parent, rows) => { const k = h('div', 'kv', null, parent); for (const [a, b] of rows) { if (b == null) continue; h('span', null, a, k); h('b', null, b, k); } return k; };
const decisionText = (d, names) => {
  if (!d) return ['—', ''];
  if (d.status === 'bought') return [`bought${fin(d.premium) ? ` ${C.pct(d.premium)} vs his price` : ''}`, 'good'];
  if (d.status === 'skipped') return [(d.fails || []).map((f) => names?.[f] || f).join(', ') || 'skipped', d.missing ? 'gold' : 'bad'];
  return [{ armed: 'waiting for the dip', waiting: 'waiting for the holder check', sending: 'buying…', checking: 'checking…' }[d.status] || d.status, ''];
};

// ---------------- the tab ----------------
export function renderDuel(root, d, ui) {
  root.replaceChildren();
  if (!d) { h('p', 'muted pad', 'Loading the duel…', root); return; }
  if (!d.on) { h('p', 'muted pad', d.note || 'The DIP vs FCAT duel is off.', root); return; }
  scoreboard(root, d);
  calendar(root, d, ui);
  headToHead(root, d);
  openNow(root, d);
  latest(root, d);
  brains(root, d, ui);
  holderRule(root, d);
  h('p', 'fine pad', `PAPER ONLY: both traders simulate fills from the coin's real curve ${d.landMs} ms after deciding (the paper landing time), with the pool fee, a 0.5% haircut and the network fee on each side. Each starts with its own paper balance; nothing here can trade.`, root);
}

function scoreboard(root, d) {
  const c = card(root, 'Who is winning', 'same Decu buys, side by side');
  const split = h('div', 'duel-split', null, c);
  for (const [id, name, what] of SIDES) {
    const t = d.traders[id], s = t.summary, side = h('div', 'side' + (d.leader === id && s.n ? ' lead' : ''), null, split);
    const top = h('div', 'duel-name', null, side); h('b', null, name, top); h('span', 'tag', `v${t.version}`, top); if (d.leader === id && s.n) h('span', 'tag gold', 'ahead', top);
    h('p', 'fine', what, side);
    h('div', 'big mono ' + tone(s.pnlSol), C.sol(s.pnlSol, 4), side);
    const u = usd(s.pnlSol, d); if (u) h('div', 'fine ' + tone(s.pnlSol), u, side);
    kvs(side, [['Trades', String(s.n)], ['Won', fin(s.winRate) ? `${Math.round(s.winRate * 100)}%` : '—'], ['Avg trade', C.pct(s.avgRet)], ['Worst drop', C.sol(s.maxDrawdownSol, 3)], ['Balance', fin(t.balance) ? `${t.balance.toFixed(3)} SOL` : '—'], ['Open', `${t.open.length}${t.open.length ? ` (${C.sol(t.openSol, 4)})` : ''}`], ['Evidence', t.evidence?.level === 'too few' ? `${t.evidence.n}/${t.evidence.minN} trades` : t.evidence?.level || '—']]);
  }
  const e = d.headToHead.evidence;
  h('p', 'vline pad', e.level === 'supported' ? `FCAT makes more on the same Decu buys, with enough evidence (${e.text}).` : e.level === 'against' ? `DIP makes more on the same Decu buys, with enough evidence (${e.text}).` : `Not decided yet: ${e.text}. (FCAT minus DIP, per Decu buy either traded.)`, c);
}

function calendar(root, d, ui) {
  const c = card(root, 'Profit calendar', 'left half DIP · right half FCAT');
  const now = d.now || Date.now(), today = C.dayKey(now, d.timezone);
  if (!ui.y) { const p = C.zoneParts(now, d.timezone); ui.y = p.y; ui.m = p.mo; }
  const hd = h('div', 'cal-head', null, c), prev = h('button', 'btn ghost icon', '‹', hd), mid = h('div', null, null, hd), next = h('button', 'btn ghost icon', '›', hd);
  prev.setAttribute('aria-label', 'Previous month'); next.setAttribute('aria-label', 'Next month');
  h('h2', null, new Date(Date.UTC(ui.y, ui.m - 1, 15)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }), mid);
  const prefix = `${ui.y}-${String(ui.m).padStart(2, '0')}`, tot = (side) => Object.entries(d.days[side] || {}).filter(([k]) => k.startsWith(prefix)).reduce((a, [, v]) => a + v.sol, 0);
  h('p', 'fine', `DIP ${C.sol(tot('dip'), 3)} · FCAT ${C.sol(tot('fcat'), 3)}`, mid);
  prev.onclick = () => { ui.m--; if (ui.m < 1) { ui.m = 12; ui.y--; } ui.rerender(); };
  next.onclick = () => { ui.m++; if (ui.m > 12) { ui.m = 1; ui.y++; } ui.rerender(); };
  const max = Math.max(1e-9, ...['dip', 'fcat'].flatMap((s) => Object.values(d.days[s] || {}).map((v) => Math.abs(v.sol))));
  const bin = (v) => (!v || !v.n ? '' : v.sol === 0 ? 'z0' : (v.sol > 0 ? 'p' : 'n') + Math.min(4, Math.max(1, Math.ceil((Math.abs(v.sol) / max) * 4))));
  const grid = h('div', 'cal duel-cal', null, c);
  for (const w of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) h('div', 'dow', w, grid);
  for (const week of C.monthGrid(ui.y, ui.m, {})) for (const cell of week) {
    if (!cell) { h('div', 'pad', null, grid); continue; }
    const a = d.days.dip?.[cell.key], b = d.days.fcat?.[cell.key], has = (a?.n || 0) + (b?.n || 0) > 0;
    const btn = h('button', 'day' + (has ? ' has' : '') + (cell.key === today ? ' today' : '') + (ui.sel === cell.key ? ' sel' : ''), null, grid);
    btn.disabled = !has; btn.setAttribute('aria-label', `${cell.key}: DIP ${a ? C.sol(a.sol, 4) : 'no trades'}, FCAT ${b ? C.sol(b.sol, 4) : 'no trades'}`);
    h('span', 'dnum', String(cell.d), btn);
    if (has) { const L = h('span', 'half ' + bin(a), null, btn), R = h('span', 'half ' + bin(b), null, btn); if (a?.n) h('small', null, tiny(a.sol), L); if (b?.n) h('small', null, tiny(b.sol), R); }
    btn.onclick = () => { ui.sel = ui.sel === cell.key ? null : cell.key; ui.rerender(); };
  }
  if (ui.sel) {
    const day = h('div', 'duel-split day-detail', null, c);
    for (const [id, name] of SIDES) {
      const side = h('div', 'side', null, day), list = d.trades.filter((t) => t.strategy === id && t.variant === id && t.day === ui.sel);
      h('b', null, `${name} on ${C.dayName(ui.sel)}`, side);
      if (!list.length) h('p', 'fine', 'No trades.', side);
      for (const t of list) { const r = h('div', 'mini', null, side); h('span', null, `${({ 'tp-early': 'early TP', 'tp-late': 'later TP', stop: 'stop', 'his-sell': 'his sell', 'his-sell-late': 'his sell' })[t.exit] || t.exit} · ${coin(t)}`, r); h('b', tone(t.pnlSol), `${C.pct(t.ret)}`, r); }
    }
  }
  // running profit, both lines
  const series = SIDES.map(([id, name]) => { const list = d.trades.filter((t) => t.variant === id).sort((a, b) => a.closedAt - b.closedAt); let run = 0; return { name, list: list.map((t) => ({ t: t.closedAt, v: (run += t.pnlSol) })) }; });
  const all = [...series[0].list, ...series[1].list].map((x) => x.t).sort((a, b) => a - b);
  if (all.length > 1) {
    const at = (s, t) => { let v = 0; for (const x of s.list) { if (x.t <= t) v = x.v; else break; } return v; };
    const box = h('div', 'chart-box', null, c);
    try { lineChart(box, { x: all.map((t) => when(t, d.timezone)), series: series.map((s, i) => ({ name: s.name, values: all.map((t) => at(s, t)), tone: i ? 'muted' : 'pos' })), fmt: (v) => C.sol(v, 3), height: 170 }); } catch { box.remove(); }
  }
}

function headToHead(root, d) {
  const x = d.headToHead, c = card(root, 'On the same Decu buys');
  const t = h('table', 't', null, c), hr = h('tr', null, null, t);
  for (const k of ['', 'Buys', 'DIP (SOL)', 'FCAT (SOL)']) h('th', k ? 'n' : null, k, hr);
  const row = (label, n, a, b) => { const r = h('tr', null, null, t); h('td', null, label, r); h('td', 'n', String(n), r); h('td', 'n ' + tone(a), num(a, 4), r); h('td', 'n ' + tone(b), num(b, 4), r); };
  row('Both traded', x.both.n, x.both.a, x.both.b); row('Only DIP traded', x.onlyA.n, x.onlyA.sol, null); row('Only FCAT traded', x.onlyB.n, null, x.onlyB.sol);
}

function openNow(root, d) {
  const n = d.traders.dip.open.length + d.traders.fcat.open.length;
  if (!n) return;
  const c = card(root, 'Holding now'), split = h('div', 'duel-split', null, c);
  for (const [id, name] of SIDES) {
    const side = h('div', 'side', null, split); h('b', null, name, side);
    for (const p of d.traders[id].open) { const r = h('div', 'mini', null, side); h('span', null, `${coin(p)}${p.provisional ? ' (checking buyers ahead)' : ''}${p.exiting ? ` · selling: ${p.exiting}` : ''}`, r); h('b', tone(p.pnl), C.pct(p.pnl), r); }
    if (!d.traders[id].open.length) h('p', 'fine', 'Nothing.', side);
  }
}

function latest(root, d) {
  const c = card(root, 'Latest Decu buys', 'what each trader decided'), list = h('div', 'rows', null, c);
  if (!d.candidates.length) { h('p', 'muted', 'No Decu buys since the duel started. It only runs while the bot is ON.', c); return; }
  for (const x of d.candidates.slice(0, 25)) {
    const r = h('div', 'r plain duel-cand', null, list), top = h('div', 'what', null, r);
    h('b', null, `${coin(x)} · ${when(x.hisTime * 1000, d.timezone)}`, top);
    const hz = x.holder0?.status === 'done' ? `${x.holder0.holders} holders hold ${C.money(x.holder0.heldUsd, { cents: false })}${x.holder0.verdict ? ` (${x.holder0.verdict.safe ? 'SAFE' : 'RISKY'}${x.holder0.verdict.safe !== x.holder0.verdict.relaxedPass ? ', relaxed: in' : ''})` : ''}` : x.holder0?.status === 'pending' ? 'holders…' : 'no holder data';
    const cr = x.crowd?.status === 'done' ? `${x.crowd.buysAhead} buyers ahead` : x.crowd?.status === 'skipped' ? '' : x.crowd?.status === 'pending' ? 'counting buyers ahead…' : 'buyers ahead unknown';
    h('small', null, [fin(x.hisUsd) ? `Decu ${C.money(x.hisUsd, { cents: false })}` : null, fin(x.hisMcapUsd) ? `mcap ${C.compactMoney(x.hisMcapUsd)}` : null, fin(x.secAtSeen) ? `seen ${x.secAtSeen}s` : null, fin(x.blocksAtSeen) ? `${x.blocksAtSeen} blocks` : null, hz, cr].filter(Boolean).join(' · '), top);
    const split = h('div', 'duel-split', null, r);
    for (const [id, name] of SIDES) { const [txt, cls] = decisionText(x.decisions?.[id], d.checkNames), s = h('div', 'side', null, split); h('span', 'fine', name + ': ', s); h('span', 'tag ' + cls, txt, s); }
  }
}

function brains(root, d, ui) {
  const c = card(root, 'What each brain is learning', 'paper only · never changes live settings');
  const split = h('div', 'duel-split brains', null, c);
  for (const [id, name] of SIDES) {
    const b = d.brains[id], side = h('div', 'side', null, split);
    if (!b) { h('p', 'fine', 'No report yet.', side); continue; }
    h('b', null, `${name} brain · v${b.version}${b.autoTune ? '' : ' · suggests only'}`, side);
    const sec = (title, lines, empty) => { h('h3', 'brain-h', title, side); if (!lines.length) h('p', 'fine', empty, side); for (const l of lines) h('p', 'brain-l', l, side); };
    sec('Testing now', b.testing.map((x) => `${paramLabel(x.diff)}: ${x.result?.n ?? 0} of ${x.need} new Decu buys, ${C.sol(x.result?.meanSol, 4)} per buy vs ${name}.`), 'Nothing yet: it needs 20 recorded buys that passed its filters first.');
    sec('Optimizing', b.optimizing.map((o) => `${o.name}: ${o.now ?? '—'} (allowed ${o.range[0]}–${o.range[1]})`), '—');
    sec('Believes is working', (b.beliefs.working || []).map((x) => `${x.text}: ${C.pct(x.avg)} over ${x.n}`), b.beliefs.note || 'Nothing stands out yet.');
    sec('Believes is hurting', (b.beliefs.hurting || []).map((x) => `${x.text}: ${C.pct(x.avg)} over ${x.n}`), b.beliefs.note || 'Nothing stands out yet.');
    sec('Rejects most', b.rejections.byReason.slice(0, 6).map((x) => `${x.text}: ${x.n}${x.cfN ? ` · alone ${x.only}, those did ${C.pct(x.cfAvg)} (${x.verdict})` : ''}`), 'No rejections yet.');
    sec('Newest experiment', b.newest ? [`${paramLabel(b.newest.diff)}: ${b.newest.status}, ${b.newest.result?.n ?? 0} shared buys, ${C.sol(b.newest.result?.totalSol, 4)} in total vs ${name}.`] : [], 'None yet.');
    sec('Evidence', [b.evidence.text], '—');
    sec('Validated on unseen buys', b.validation.slice(0, 5).map((x) => `${paramLabel(x.diff)}: ${x.status} after ${x.result?.n ?? 0} (${C.sol(x.result?.meanSol, 4)} per buy)`), 'No experiment has finished yet.');
    sec('Decisions', b.decisions.slice(0, 5).map((x) => `${String(x.at).slice(5, 16).replace('T', ' ')} ${x.text}`), 'None yet.');
  }
}
const PARAM = { tpEarlyPct: 'early take-profit %', tpEarlySec: 'early window s', tpLatePct: 'later take-profit %', maxBuysAhead: 'max buyers ahead', hisUsdMin: 'Decu buy at least $', mcapMax: 'mcap at most $', mcapMin: 'mcap at least $', dipPct: 'dip under his price %', dipWindowSec: 'dip window s', stopFromHisPct: 'stop under his price %', maxPayPct: 'pay at most %' };
const paramLabel = (diff) => Object.entries(diff || {}).map(([k, v]) => `${PARAM[k] || k} ${v}`).join(', ');

function holderRule(root, d) {
  const x = d.holderRule, c = card(root, 'Holder rule experiment', 'your baseline kept; relaxed is a separate label');
  h('p', 'fine', `Baseline: holders other than the dev hold ${x.rules.map(([m, hv]) => `$${hv} at $${m / 1000}k`).join(', ')} (under $${x.rules[0][0] / 1000}k always SAFE). Relaxed: the same × k, now k = ${x.k} (never under $${x.floorUsd} at $10k). Target: +${Math.round((x.target - 1) * 100)}% coins accepted.`, c);
  kvs(c, [['Coins checked', String(x.coins)], ['With holder data', String(x.withData)], ['Missing data (apart)', String(x.missing)], ['Baseline SAFE', String(x.baselineSafe)], ['Relaxed accepts', `${x.relaxedPass}${fin(x.increase) ? ` (${C.pct(x.increase)})` : ''}`], ['Added by relaxing', String(x.added)],
    ['Target reachable', x.calibration ? (x.calibration.targetMet ? 'yes' : `no: at most ${C.pct(x.calibration.maxIncrease)} within the floor`) : 'not measured yet']]);
  const o = x.outcomes, line = (v) => (v?.n ? `${C.pct(v.avg)} avg over ${v.n}` : 'no outcomes yet');
  kvs(c, [['SAFE coins did (FCAT, no filters)', line(o.baselineSafe)], ['Coins it added did', line(o.added)], ['Rejected coins did', line(o.rejected)], ['Missing-data coins did', line(o.missingData)]]);
}

// ---------------- What-if additions ----------------
export function renderDuelWhatIf(root, d, ui) {
  root.replaceChildren();
  if (!d?.on) return;
  const vs = d.variants.filter((v) => v.strategy === 'dip' && (v.role === 'main' || v.role === 'analytics'));
  const c = card(root, 'Dip triggers', 'same filters, exits and fills; from now on');
  const t = h('table', 't', null, c), hr = h('tr', null, null, t);
  for (const k of ['Trigger', 'Trades', 'Won', 'SOL', 'Avg']) h('th', k === 'Trigger' ? null : 'n', k, hr);
  for (const v of vs) { const r = h('tr', null, null, t), s = v.summary; h('td', null, v.id === 'dip' ? 'Back to his price (DIP)' : v.label.replace('DIP: ', ''), r); h('td', 'n', String(s.n), r); h('td', 'n', fin(s.winRate) ? `${Math.round(s.winRate * 100)}%` : '—', r); h('td', 'n ' + tone(s.pnlSol), num(s.pnlSol, 3), r); h('td', 'n ' + tone(s.avgRet), C.pct(s.avgRet), r); }
  holdersWhatIf(root, d, ui);
}

function holdersWhatIf(root, d, ui) {
  const rows = d.holders || [], c = card(root, 'Holders in depth', `${rows.length} Decu buys with a holder snapshot`);
  if (!rows.length) { h('p', 'muted', 'Taken on every Decu buy from now on (while the bot is ON): how many hold the coin and the money they hold.', c); return; }
  const med = (xs) => C.fin(xs[0]) ? [...xs].sort((a, b) => a - b)[xs.length >> 1] : null;
  kvs(c, [['Median holders', String(med(rows.map((r) => r.holders).filter(fin)) ?? '—')], ['Median money held', C.money(med(rows.map((r) => r.heldUsd).filter(fin)), { cents: false })], ['Median top-10 share', C.pct(med(rows.map((r) => r.top10Pct).filter(fin)), 0, false)]]);
  // what-if: require at least N holders and $X held
  ui.hold ||= { minHolders: null, minHeld: null };
  const form = h('div', 'rules', null, c);
  const input = (label, key) => { const r = h('label', 'rule', null, form); h('span', 'rl', label, r); const i = h('input', null, null, r); i.type = 'number'; i.min = '0'; i.value = ui.hold[key] ?? ''; i.onchange = () => { ui.hold[key] = i.value === '' ? null : Number(i.value); ui.rerender(); }; };
  input('At least this many holders', 'minHolders'); input('Holders hold at least ($)', 'minHeld');
  const pass = rows.filter((r) => (ui.hold.minHolders == null || r.holders >= ui.hold.minHolders) && (ui.hold.minHeld == null || r.heldUsd >= ui.hold.minHeld));
  const avgOf = (list, k) => { const v = list.map((r) => r[k]).filter(fin); return v.length ? { a: v.reduce((x, y) => x + y, 0) / v.length, n: v.length } : null; };
  const res = (list, k) => { const r = avgOf(list, k); return r ? `${C.pct(r.a)} avg over ${r.n}` : 'no outcomes yet'; };
  const cellRes = (list, k) => { const r = avgOf(list, k); return r ? C.pct(r.a) : '—'; };
  h('p', 'vline', `${pass.length} of ${rows.length} coins pass.`, c);
  h('p', 'fine', `FCAT's rules, no filters: ${res(pass, 'fcatAll')} (all coins: ${res(rows, 'fcatAll')}). DIP's rules, no filters: ${res(pass, 'dipAll')} (all coins: ${res(rows, 'dipAll')}).`, c);
  const bucket = (title, get, bs) => {
    const t = h('table', 't', null, c), cap = h('caption', 'fine', title, t), hr = h('tr', null, null, t); void cap;
    for (const k of ['Group', 'Coins', 'FCAT', 'DIP']) h('th', k === 'Group' ? null : 'n', k, hr);
    for (const [lo, hi, l] of bs) { const xs = rows.filter((r) => fin(get(r)) && get(r) >= lo && get(r) < hi), r = h('tr', null, null, t); h('td', null, l, r); h('td', 'n', String(xs.length), r); h('td', 'n', cellRes(xs, 'fcatAll'), r); h('td', 'n', cellRes(xs, 'dipAll'), r); }
  };
  bucket('By number of holders', (r) => r.holders, [[0, 20, 'under 20'], [20, 50, '20–49'], [50, 100, '50–99'], [100, 250, '100–249'], [250, Infinity, '250+']]);
  bucket('By money held', (r) => r.heldUsd, [[0, 500, 'under $500'], [500, 1000, '$500–1k'], [1000, 2500, '$1k–2.5k'], [2500, 5000, '$2.5k–5k'], [5000, Infinity, '$5k+']]);
  bucket('By top-10 share of supply', (r) => r.top10Pct, [[0, 0.15, 'under 15%'], [0.15, 0.25, '15–25%'], [0.25, 0.4, '25–40%'], [0.4, Infinity, '40%+']]);
  const det = h('details', 'nums', null, c); h('summary', null, 'Every coin', det);
  const t = h('table', 't', null, det), hr = h('tr', null, null, t);
  for (const k of ['Coin', 'Holders', 'Held', 'Dev', 'Top 10', 'Mcap', 'FCAT']) h('th', k === 'Coin' ? null : 'n', k, hr);
  for (const r of [...rows].reverse().slice(0, 150)) { const tr = h('tr', null, null, t); h('td', null, coin(r), tr); h('td', 'n', String(r.holders), tr); h('td', 'n', C.compactMoney(r.heldUsd), tr); h('td', 'n', C.pct(r.devPct, 0, false), tr); h('td', 'n', C.pct(r.top10Pct, 0, false), tr); h('td', 'n', C.compactMoney(r.mcap), tr); h('td', 'n ' + tone(r.fcatAll), C.pct(r.fcatAll), tr); }
}
