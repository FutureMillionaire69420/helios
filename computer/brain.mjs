// THE THINKING BRAIN: memory, ranks, decisions and the $10 mirror, on top of the learning brain (learn.mjs).
//
// learn.mjs finds the patterns (replayed from the study journal at every start). This file adds what has to
// be REMEMBERED across restarts and upgrades, in brain-memory.json next to the journal:
//   - RANKS Bronze → Grandmaster. A rank needs a minimum of bought trades AND proven skill (win rate,
//     predictions that beat guessing, profit factor) AND profit on a $1000 paper bankroll. Ranks can be
//     lost: failing the current rank for BRAIN_DEMOTE_AFTER (10) bought trades in a row drops one rank.
//   - DECISIONS (paper only): the brain tunes the entry-premium cap, the stop-loss and the gain gate inside
//     fixed limits, only on walk-forward evidence (chosen on older trades, proven on newer unseen ones),
//     one step at a time, and reverts a change that did worse on the trades after it. It can also skip a
//     paper buy it strongly expects to lose, once its predictions beat guessing. Every skip is still studied.
//   - LIVE: the same thinking, but it only SUGGESTS (a "Brain suggests" alert). It never changes a live setting.
//   - UPGRADES: each bot version is remembered with the trades made on it, so it can say whether an
//     upgrade made the bot better or worse.
//   - $10 MIRROR on every bought trade: $10 bought at your real entry and sold the moment Decu sold, next to
//     Decu's own perfect $10 (his price in, his price out). The gap is what the delay cost you.
//   - BACKUP: once a day (and on a rank change) the memory and the recent journal go to a GitHub branch
//     (GITHUB_BACKUP_TOKEN, a token for that one repo), and come back if the Render disk is ever empty.
// Nothing here signs or sends a transaction.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { advise, simulateRules } from './learn.mjs';
import { runTests, speedReport, findingsMarkdown, marketCapGroups } from './tests.mjs';
import { createVault, tradeNote, dailyNote, patternNote, homeNote, decisionsNote, tradeNoteName, patternNoteName, AGENTS_MD, zipFiles, safeName } from './vault.mjs';
import { tradeAnalysis, dayCharts, delayAnalysis, analysisCharts, analysisMarkdown, renderPng, chartUrl } from './notecharts.mjs';
import { coinChart } from './study.mjs';

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const pct = (x, d = 1) => (!fin(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const usd = (x) => (!fin(x) ? '—' : `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`);
const money = (x) => (!fin(x) ? '—' : `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const bought = (records) => records.filter((r) => r.taken !== false && !r.skipReason && fin(r.fcat));
const solUsdOf = (r, fallback) => (r.hisUsd > 0 && r.hisSol > 0 ? r.hisUsd / r.hisSol : fallback);

// ---------- the $10 mirror ----------
/**
 * $10 bought at the bot's real entry price and sold at Decu's sell price (or the 15 s mark when he held),
 * next to Decu's perfect $10 (his price in, the same exit). Pool fees (POOL_FEE, 1.25% a side) apply to both;
 * network fees (priority + tip, the same SOL at any trade size) are shown on their own.
 * FCAT, PCAT and your stop/gate rules are shown at $10 too, from the same price path, before network fees.
 */
export function mirror10(rec, { usd: size = 10, poolFee = 0.0125, rules = {}, solUsd = null } = {}) {
  const entry = rec.entryPrice ?? null, his = rec.hisPrice ?? null, exit = rec.exitPrice ?? null;
  const px = solUsdOf(rec, solUsd);
  if (!(entry > 0) || !(his > 0) || !(exit > 0)) return null;
  const keep = (1 - poolFee) ** 2;
  const yours = keep * (exit / entry) - 1, perfect = keep * (exit / his) - 1;
  const feeSol = (rec.buyFeeSol ?? rec.sellFeeSol ?? 0) + (rec.sellFeeSol ?? 0);
  const feesUsd = px ? feeSol * px : null;
  // the bot's own price path without network fees: what each exit is worth per $ put in
  const cost = rec.cost, buyFee = rec.buyFeeSol ?? rec.sellFeeSol ?? 0, sellFee = rec.sellFeeSol ?? 0;
  const gross = (v) => (fin(v) && cost > 0 && cost - buyFee > 0 ? (v * cost + sellFee + cost) / (cost - buyFee) - 1 : null);
  const sim = simulateRules(rec, rules);
  const at = (g) => (fin(g) ? g * size : null);
  const out = {
    size, solUsd: px, exitAt: rec.pcatExit || (rec.hisSoldAtSec != null ? `his sell at ${rec.hisSoldAtSec}s` : '15s mark'),
    perfectUsd: perfect * size, yourUsd: yours * size, delayUsd: (yours - perfect) * size, premium: entry / his - 1,
    feesUsd, feeSol, afterFeesUsd: feesUsd == null ? null : yours * size - feesUsd,
    fcatUsd: at(gross(rec.fcat)), rulesUsd: at(gross(sim?.pnl)), rulesHow: sim ? (sim.open ? 'holding at 15 s' : `${sim.how} at ${sim.sec}s`) : null,
    pcatUsd: fin(rec.pcat) ? at(rec.pcat + (2 * sellFee) / (cost || 1)) : null, // PCAT is vs his FIRST buy
  };
  return out;
}

/** One picture of the $10 trade: Decu's perfect copy → minus the delay → your mirror → minus fees → result,
 *  then the bot's other exits at $10. Blue = made money, red = lost, gray = fees. */
export function mirrorChart(rec, m) {
  const r2 = (x) => (fin(x) ? Math.round(x * 100) / 100 : null);
  const rows = [['Decu perfect $10', m.perfectUsd], ['Delay cost', m.delayUsd], ['Your $10 mirror', m.yourUsd], ['Network fees', m.feesUsd == null ? null : -m.feesUsd], ['Mirror after fees', m.afterFeesUsd], ['FCAT at $10', m.fcatUsd], ['PCAT at $10', m.pcatUsd], ['Stop/gate rules', m.rulesUsd]];
  const color = (label, v) => (label === 'Network fees' ? '#898781' : v >= 0 ? '#2a78d6' : '#e34948');
  const cfg = { type: 'bar', data: { labels: rows.map(([l]) => l), datasets: [{ label: '$ result of a $10 trade', data: rows.map(([, v]) => r2(v)), backgroundColor: rows.map(([l, v]) => color(l, v ?? 0)) }] },
    options: { legend: { display: false }, title: { display: true, fontColor: '#0b0b0b', fontSize: 13, text: [
      `${rec.symbol ? '$' + rec.symbol : rec.mint.slice(0, 6)}: $10 mirror ${usd(m.yourUsd)} vs Decu ${usd(m.perfectUsd)} · delay cost ${usd(m.delayUsd)} (paid ${pct(m.premium)} more)`,
      `sold at ${m.exitAt} · ${rec.delaySec ?? '?'} s${rec.latency?.blocksAfter != null ? ` / ${rec.latency.blocksAfter} blocks` : ''} after him · fees ${usd(m.feesUsd == null ? null : -m.feesUsd)} (${m.feeSol.toFixed(4)} SOL)`] },
      plugins: { datalabels: { display: true, anchor: 'end', align: 'end', color: '#0b0b0b', formatter: (v) => v } },
      scales: { xAxes: [{ gridLines: { display: false }, ticks: { fontColor: '#52514e', autoSkip: false, maxRotation: 40 } }], yAxes: [{ gridLines: { color: '#e1e0d9', zeroLineColor: '#52514e' }, ticks: { fontColor: '#52514e' }, scaleLabel: { display: true, labelString: '$ on a $10 trade', fontColor: '#52514e' } }] } } };
  return `https://quickchart.io/chart?w=760&h=440&bkg=white&c=${encodeURIComponent(JSON.stringify(cfg))}`;
}

/** Totals of the $10 mirror over many trades: how much the delay and the fees cost in all. */
export function mirrorTotals(records, opts = {}) {
  const ms = bought(records).map((r) => mirror10(r, opts)).filter(Boolean);
  const sum = (k) => ms.reduce((a, m) => a + (fin(m[k]) ? m[k] : 0), 0);
  return { trades: ms.length, perfectUsd: sum('perfectUsd'), yourUsd: sum('yourUsd'), delayUsd: sum('delayUsd'), feesUsd: sum('feesUsd'), afterFeesUsd: sum('afterFeesUsd'), wins: ms.filter((m) => m.yourUsd > 0).length, perfectWins: ms.filter((m) => m.perfectUsd > 0).length };
}

// ---------- ranks ----------
// trades = bought trades · win = FCAT win rate · bank = $1000 paper bankroll at least this · last = the last
// N bought trades must be positive in total · beat = predictions beat always-guessing by this many points
// (null = not needed) · pf = profit factor (money won / money lost) · days = green days among the last 7.
export const RANKS = [
  { name: 'Bronze', trades: 0 },
  { name: 'Silver', trades: 25, win: 0.4 },
  { name: 'Gold', trades: 50, win: 0.45, bank: 1000, last: 25 },
  { name: 'Platinum', trades: 100, win: 0.45, bank: 1010, last: 50, beat: 0 },
  { name: 'Diamond', trades: 200, win: 0.5, bank: 1025, last: 50, beat: 0.02, pf: 1.2 },
  { name: 'Master', trades: 350, win: 0.5, bank: 1050, last: 100, beat: 0.05, pf: 1.3 },
  { name: 'Grandmaster', trades: 500, win: 0.55, bank: 1100, last: 100, beat: 0.05, pf: 1.5, days: 5 },
];

/** Everything a rank is judged on. The bankroll is $1000 (BRAIN_BANKROLL_USD) plus each bought trade's
 *  FCAT at its real size, in dollars at that day's SOL price. */
export function rankFacts(records, { buySol = 0.1, bankrollUsd = 1000, solUsd = null, accuracy = null, now = Date.now() } = {}) {
  const bs = bought(records);
  const usdOf = (r) => r.fcat * (r.cost > 0 ? r.cost : buySol) * (solUsdOf(r, solUsd) || 0);
  const pnl = bs.map(usdOf), won = pnl.filter((x) => x > 0).reduce((a, x) => a + x, 0), lost = -pnl.filter((x) => x < 0).reduce((a, x) => a + x, 0);
  const lastSum = (n) => (bs.length >= n ? bs.slice(-n).reduce((a, r) => a + r.fcat, 0) : null);
  const days = new Map(); for (let i = 0; i < bs.length; i++) { const d = String(bs[i].time).slice(0, 10); days.set(d, (days.get(d) || 0) + pnl[i]); }
  const last7 = [...days.entries()].filter(([d]) => now - Date.parse(d) <= 7 * 864e5);
  return { trades: bs.length, win: bs.length ? bs.filter((r) => r.fcat > 0).length / bs.length : 0, bank: bankrollUsd + pnl.reduce((a, x) => a + x, 0), start: bankrollUsd,
    pf: lost > 0 ? won / lost : won > 0 ? Infinity : 0, lastSum, beat: accuracy && accuracy.total >= 20 ? accuracy.rate - accuracy.baseline : null, greenDays: last7.filter(([, v]) => v > 0).length, days: last7.length };
}
/** The checks one rank needs, each with a plain-words line. */
export function rankChecks(rank, f) {
  const out = [];
  if (rank.trades) out.push({ ok: f.trades >= rank.trades, text: `${rank.trades}+ bought trades (${f.trades})` });
  if (rank.win != null) out.push({ ok: f.win >= rank.win, text: `win rate ${Math.round(rank.win * 100)}%+ (${Math.round(f.win * 100)}%)` });
  if (rank.bank != null) out.push({ ok: f.bank > rank.bank, text: `$1000 paper bankroll above ${money(rank.bank)} (${money(f.bank)})` });
  if (rank.last) { const s = f.lastSum(rank.last); out.push({ ok: s != null && s > 0, text: `last ${rank.last} trades positive (${s == null ? 'not enough yet' : pct(s / rank.last) + ' avg'})` }); }
  if (rank.beat != null) out.push({ ok: f.beat != null && f.beat > rank.beat, text: `predictions beat guessing by ${Math.round(rank.beat * 100)}+ points (${f.beat == null ? 'needs 20 predictions' : `${f.beat >= 0 ? '+' : ''}${Math.round(f.beat * 100)}`})` });
  if (rank.pf != null) out.push({ ok: f.pf >= rank.pf, text: `profit factor ${rank.pf}+ (${fin(f.pf) ? f.pf.toFixed(2) : f.pf === Infinity ? 'no losses' : '—'})` });
  if (rank.days != null) out.push({ ok: f.greenDays >= rank.days, text: `${rank.days} green days of the last 7 (${f.greenDays} of ${f.days})` });
  return out;
}
/** The highest rank whose checks (and every lower rank's) all pass. */
export function earnedRank(f) { let i = 0; while (i + 1 < RANKS.length && rankChecks(RANKS[i + 1], f).every((c) => c.ok)) i++; return i; }

// ---------- stop / gate walk-forward ----------
const STOPS = [10, 15, 20, 25, 30], GATES = [10, 15, 20, 25, 30];
/** One step for the stop-loss and gain gate: chosen on the oldest 70% of trades, kept only when it also
 *  wins on the newest 30% (which the choice never saw). Neighbours of the current values only. */
export function tuneStopGate(records, { buySol = 0.1, stopLossPct = 20, gainGatePct = 15, gateSec = 15, minTrades = 50 } = {}) {
  const rs = records.filter((r) => fin(r.fcat) && Array.isArray(r.curve)).sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  if (rs.length < minTrades) return null;
  const cut = Math.floor(rs.length * 0.7), train = rs.slice(0, cut), test = rs.slice(cut);
  const total = (list, o) => list.reduce((a, r) => { const s = simulateRules(r, { gateSec, ...o }); return s ? a + s.pnl * buySol : a; }, 0);
  const near = (list, v) => { const i = list.indexOf(v); return i < 0 ? list : list.slice(Math.max(0, i - 1), i + 2); };
  const cur = { stopLossPct, gainGatePct }, tr0 = total(train, cur), te0 = total(test, cur);
  let best = null;
  for (const s of near(STOPS, stopLossPct)) for (const g of near(GATES, gainGatePct)) {
    if (s === stopLossPct && g === gainGatePct) continue;
    const gain = total(train, { stopLossPct: s, gainGatePct: g }) - tr0;
    if (gain > 0.005 && (!best || gain > best.trainGainSol)) best = { stopLossPct: s, gainGatePct: g, trainGainSol: gain };
  }
  if (!best) return null;
  best.testGainSol = total(test, best) - te0;
  return best.testGainSol > 0 ? best : null;
}

// ---------- GitHub backup ----------
/** Backup / restore over the GitHub contents API, on its own branch (never main, so Render does not redeploy). */
export function createBackup({ token, repo, branch = 'brain-backup', fetchImpl = globalThis.fetch, log = () => {} } = {}) {
  if (!token || !repo) return null;
  const api = `https://api.github.com/repos/${repo}`;
  const hide = (t) => String(t).split(token).join('***');
  const call = async (p, init = {}) => {
    const r = await fetchImpl(p.startsWith('http') ? p : `${api}${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'decu-copybot-brain', ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(20_000) });
    const body = r.status === 204 ? null : await r.json().catch(() => null);
    return { status: r.status, body };
  };
  const ensureBranch = async () => {
    const b = await call(`/git/ref/heads/${branch}`);
    if (b.status === 200) return;
    const repoInfo = await call('');
    const main = await call(`/git/ref/heads/${repoInfo.body?.default_branch || 'main'}`);
    if (main.status !== 200) throw new Error(`GitHub: cannot read the default branch (HTTP ${main.status})`);
    const made = await call('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: main.body.object.sha }) });
    if (made.status !== 201) throw new Error(`GitHub: cannot create the ${branch} branch (HTTP ${made.status})`);
  };
  const put = async (file, buf, message) => {
    const old = await call(`/contents/${file}?ref=${branch}`);
    const r = await call(`/contents/${file}`, { method: 'PUT', body: JSON.stringify({ message, branch, content: buf.toString('base64'), ...(old.status === 200 && old.body?.sha ? { sha: old.body.sha } : {}) }) });
    if (r.status !== 200 && r.status !== 201) throw new Error(`GitHub: saving ${file} failed (HTTP ${r.status})`);
  };
  const get = async (file) => {
    const r = await call(`/contents/${file}?ref=${branch}`);
    if (r.status !== 200) return null;
    if (r.body?.content) return Buffer.from(r.body.content, 'base64');
    if (r.body?.download_url) { const raw = await fetchImpl(r.body.download_url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) }); return raw.ok ? Buffer.from(await raw.arrayBuffer()) : null; }
    return null;
  };
  return {
    async save({ memory, journalLines }) {
      try {
        await ensureBranch();
        await put('brain/brain-memory.json', Buffer.from(JSON.stringify(memory, null, 1)), `brain backup: ${memory.rank?.name || ''} · ${memory.stats?.bought ?? 0} trades`);
        if (journalLines) await put('brain/study-journal.jsonl.gz', zlib.gzipSync(Buffer.from(journalLines.join('\n') + '\n')), 'brain backup: study journal');
        return 'saved';
      } catch (e) { log('brain backup: ' + hide(e.message)); return 'failed: ' + hide(e.message); }
    },
    async load() {
      try {
        const m = await get('brain/brain-memory.json'), j = await get('brain/study-journal.jsonl.gz');
        return { memory: m ? JSON.parse(m.toString('utf8')) : null, journal: j ? zlib.gunzipSync(j).toString('utf8') : null };
      } catch (e) { log('brain restore: ' + hide(e.message)); return { memory: null, journal: null }; }
    },
  };
}

/** Before the study opens its journal: an empty Render disk gets the brain's memory and journal back. */
export async function restoreIfEmpty({ backup, memoryFile, journalFile, log = () => {} }) {
  if (!backup) return 'no backup set up';
  const empty = (f) => { try { return fs.statSync(f).size === 0; } catch { return true; } };
  if (!empty(memoryFile) && !empty(journalFile)) return 'local memory present';
  const { memory, journal } = await backup.load();
  if (memory && empty(memoryFile)) fs.writeFileSync(memoryFile, JSON.stringify(memory), { mode: 0o600 });
  if (journal && empty(journalFile)) fs.writeFileSync(journalFile, journal, { mode: 0o600 });
  const msg = memory || journal ? `brain restored from the GitHub backup (${memory ? 'memory' : ''}${memory && journal ? ' + ' : ''}${journal ? `${journal.split('\n').filter(Boolean).length} journal trades` : ''})` : 'no GitHub backup yet';
  log(msg);
  return msg;
}

// ---------- the thinking brain ----------
/**
 * createThinkingBrain(opts) after the study is made (its journal already replayed into the learning brain).
 *  rules: the live rules object the runtime reads ({maxPayPct, stopLossPct, gainGatePct}); paper decisions
 *  change it in place. defaults: the rules from the settings (what a revert goes back to).
 */
export function createThinkingBrain({ file, study, mode = 'paper', buySol = 0.1, rules, defaults, notify = null, version = '0', solUsd = () => null,
  autoTune = mode === 'paper', veto = mode === 'paper', bankrollUsd = 1000, goalUsd = 1000, tuneEvery = 10, minEvidence = 50, demoteAfter = 10, revertAfter = 20,
  limits = { maxPayPct: [5, 25], stopLossPct: [10, 30], gainGatePct: [10, 30] }, gateSec = 15, backup = null, backupHours = 24, journalFile = null, brainPerDay = 60, vaultDir = null, gitSync = null, vaultSyncMin = 5, vaultBackfill = 300, noteCharts = true, chartFetch = globalThis.fetch, analysisEveryMin = 15, poolFee = 0.0125, log = () => {}, now = () => Date.now() }) {
  const tag = mode === 'live' ? '' : mode === 'paper' ? '[PAPER] ' : '[DEMO] ';
  let mem = null;
  try { mem = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  mem = { v: 1, created: new Date(now()).toISOString(), versions: [], rank: { index: 0, name: RANKS[0].name, since: null, failing: 0, history: [] }, tuning: { rules: null, history: [] }, decisions: [], vetoes: [], backupAt: 0, day: { date: null, sent: 0 }, ...(mem || {}) };
  const records = study.records, learn = study.brain;
  const remember = (kind, text, extra = {}) => { mem.decisions.push({ time: new Date(now()).toISOString(), kind, text, ...extra }); if (mem.decisions.length > 500) mem.decisions.splice(0, mem.decisions.length - 500); };
  const save = () => { try { fs.writeFileSync(file, JSON.stringify(mem), { mode: 0o600 }); } catch (e) { log('brain memory not saved: ' + e.message); } };
  const boughtN = () => bought(records).length;

  // UPGRADES: remember the version this run started on and how many trades came before it
  if (mem.versions.at(-1)?.version !== version) { mem.versions.push({ version, since: new Date(now()).toISOString(), fromBought: boughtN() }); remember('upgrade', `Started on v${version} with ${boughtN()} bought trades remembered.`); }
  // the paper rules the brain chose last time come back after a restart (BRAIN_AUTOTUNE=false = the settings)
  // a premium cap of 0 in the settings means the filter is off: the brain leaves it off
  const tunable = (k) => !(k === 'maxPayPct' && !(defaults.maxPayPct > 0));
  if (autoTune && mem.tuning.rules) for (const k of Object.keys(limits)) if (tunable(k) && fin(mem.tuning.rules[k])) rules[k] = clamp(k, mem.tuning.rules[k]);
  if (!autoTune && mode === 'paper' && mem.tuning.rules) remember('tuning', 'Auto-tune is off: using the settings, not the brain\'s choices.');
  function clamp(k, v) { const [lo, hi] = limits[k]; return Math.min(hi, Math.max(lo, v)); }
  save();

  const send = (a) => {
    if (!notify) return;
    const d = new Date(now()).toISOString().slice(0, 10);
    if (mem.day.date !== d) mem.day = { date: d, sent: 0 };
    if (a.kind === 'brain' && mem.day.sent >= brainPerDay) return;
    mem.day.sent++;
    Promise.resolve(notify({ ...a, tags: ['brain', ...(a.tags || [])] })).catch(() => {});
  };
  const facts = () => rankFacts(records, { buySol, bankrollUsd, solUsd: solUsd(), accuracy: learn.accuracy(), now: now() });
  const rankLine = (f = facts()) => { const i = mem.rank.index, next = RANKS[i + 1]; const left = next ? rankChecks(next, f).filter((c) => !c.ok) : []; return `${RANKS[i].name} (${i + 1}/${RANKS.length}) · bankroll ${money(f.bank)} (${usd(f.bank - f.start)})${next ? ` · next ${next.name}: ${left.length ? left.map((c) => c.text).join('; ') : 'all checks pass'}` : ' · top rank'}`; };

  // ----- the goal: $1000 of profit (BRAIN_GOAL_USD) on bought trades; alerts at 25 / 50 / 75 / 100% -----
  mem.goal = { usd: goalUsd, hit: [], ...(mem.goal || {}) }; mem.goal.usd = goalUsd;
  const goalLine = (f = facts()) => { const p = f.bank - f.start; return `GOAL ${money(goalUsd)} profit: ${usd(p)} so far (${Math.max(0, Math.round((p / goalUsd) * 100))}%)${p >= goalUsd ? ' · REACHED: you are in profit' : ` · ${money(goalUsd - p)} to go`}`; };
  function judgeGoal() {
    const f = facts(), p = f.bank - f.start;
    for (const step of [25, 50, 75, 100]) {
      if (p < (goalUsd * step) / 100 || mem.goal.hit.includes(step)) continue;
      mem.goal.hit.push(step); remember('goal', `${step}% of the ${money(goalUsd)} goal reached (${usd(p)}).`);
      send({ title: `${tag}Brain: ${step === 100 ? 'GOAL REACHED' : `${step}% of the goal`} · ${usd(p)} profit`, priority: step === 100 ? 5 : 4, tags: [step === 100 ? 'tada' : 'chart_with_upwards_trend'], body: [step === 100 ? `${money(goalUsd)} of profit made: the bot is in profit.` : `${step}% of the way to ${money(goalUsd)} profit.`, goalLine(f), `${f.trades} bought trades, ${Math.round(f.win * 100)}% won.`, mode === 'live' ? '' : 'Paper: no real money used.'].join('\n') });
      backupSoon();
    }
  }
  // ----- pattern recognition, from the memory bank: the strongest patterns this trade matches -----
  const patternLines = (rec) => {
    const all = learn.lessons(), out = [];
    for (const l of all.slice(0, 3)) out.push(`${l.status === 'confirmed' ? '✔' : '…'} ${l.dev >= 0 ? '▲' : '▼'} ${l.label}: ${l.wins}/${l.n} won, avg FCAT ${pct(l.avg)}`);
    return out.length ? out : ['No pattern strong enough yet (5+ trades to appear, 8+ to confirm).'];
  };
  // ----- ranks -----
  function judgeRank() {
    const f = facts(), earned = earnedRank(f), cur = mem.rank.index;
    if (earned > cur) {
      mem.rank = { ...mem.rank, index: earned, name: RANKS[earned].name, since: new Date(now()).toISOString(), failing: 0 };
      mem.rank.history.push({ time: mem.rank.since, rank: RANKS[earned].name, up: true, bought: f.trades });
      remember('rank', `Promoted to ${RANKS[earned].name} at ${f.trades} bought trades, bankroll ${money(f.bank)}.`);
      send({ title: `${tag}Brain: promoted to ${RANKS[earned].name}`, priority: 4, tags: ['trophy'], body: [`I reached ${RANKS[earned].name} (${earned + 1} of ${RANKS.length}).`, ...rankChecks(RANKS[earned], f).map((c) => `✔ ${c.text}`), '', rankLine(f), mode === 'live' ? '' : 'No real money used.'].join('\n') });
      backupSoon();
    } else if (earned < cur) {
      mem.rank.failing++;
      if (mem.rank.failing >= demoteAfter) {
        const to = cur - 1, failed = rankChecks(RANKS[cur], f).filter((c) => !c.ok);
        mem.rank = { ...mem.rank, index: to, name: RANKS[to].name, since: new Date(now()).toISOString(), failing: 0 };
        mem.rank.history.push({ time: mem.rank.since, rank: RANKS[to].name, up: false, bought: f.trades });
        remember('rank', `Dropped to ${RANKS[to].name}: ${failed.map((c) => c.text).join('; ')}.`);
        send({ title: `${tag}Brain: dropped to ${RANKS[to].name}`, priority: 4, tags: ['warning'], body: [`I failed ${RANKS[cur].name} for ${demoteAfter} trades in a row:`, ...failed.map((c) => `✘ ${c.text}`), '', rankLine(f)].join('\n') });
        backupSoon();
      }
    } else mem.rank.failing = 0;
  }

  // ----- decisions: tune the rules (paper) or suggest (live) -----
  const ruleText = (r) => `entry-premium cap ${r.maxPayPct}% · stop −${r.stopLossPct}% · gain gate +${r.gainGatePct}%`;
  function judgeLastChange() {
    const last = mem.tuning.history.findLast((h) => h.applied && !h.judged);
    if (!last) return;
    const since = records.slice(last.fromRecord).filter((r) => fin(r.fcat));
    if (bought(since).length < revertAfter) return;
    // the same trades under the old and the new rules: did the change help?
    const score = (r) => since.reduce((a, x) => { if (x.entryGap != null && x.entryGap > r.maxPayPct / 100) return a; const s = simulateRules(x, { gateSec, stopLossPct: r.stopLossPct, gainGatePct: r.gainGatePct }); return s ? a + s.pnl * buySol : a; }, 0);
    const before = score(last.from), after = score(last.to);
    last.judged = true; last.resultSol = after - before;
    if (after < before - 0.002) {
      Object.assign(rules, last.from); mem.tuning.rules = { ...last.from };
      remember('revert', `Reverted my change (${ruleText(last.to)}): it did ${(after - before).toFixed(4)} SOL worse on the ${since.length} trades since.`);
      send({ title: `${tag}Brain: I undid my last change`, priority: 3, tags: ['leftwards_arrow_with_hook'], body: [`My change to ${ruleText(last.to)} did worse on the ${since.length} trades after it (${(after - before).toFixed(4)} SOL vs keeping ${ruleText(last.from)}).`, `Back to: ${ruleText(rules)}.`, 'I remember this, so I will not make the same move on the same evidence again.'].join('\n') });
      mem.tuning.history.push({ time: new Date(now()).toISOString(), from: last.to, to: { ...last.from }, why: 'revert: did worse after the change', applied: true, judged: true, fromRecord: records.length });
    } else remember('kept', `Kept ${ruleText(last.to)}: ${(after - before) >= 0 ? '+' : ''}${(after - before).toFixed(4)} SOL vs before on ${since.length} trades.`);
  }
  const triedAndFailed = (to) => mem.tuning.history.some((h) => h.judged && h.resultSol != null && h.resultSol < -0.002 && JSON.stringify(h.to) === JSON.stringify(to) && records.length - h.fromRecord < 200);
  // ----- the paper-test pack (tests.mjs): side by side, never skips; suggests a test only when it is SUPPORTED -----
  let lastTests = null, lastSpeed = null;
  function runPack() {
    lastTests = runTests(records, { buySol, stopLossPct: rules.stopLossPct, gainGatePct: rules.gainGatePct, gateSec, minTrades: minEvidence, poolFee });
    lastSpeed = speedReport(records, { buySol });
    mem.tests = { at: new Date(now()).toISOString(), results: lastTests.map((t) => ({ id: t.id, verdict: t.verdict, supported: t.supported, best: t.best?.label ?? null, trades: t.trades })) };
    mem.testAlerts ||= {};
    for (const t of lastTests) {
      const key = `${t.best?.key}`;
      if (!t.supported || mem.testAlerts[t.id] === key) continue;
      mem.testAlerts[t.id] = key;
      remember('suggest', `Test "${t.name}": ${t.best.label} is SUPPORTED (${t.best.train >= 0 ? '+' : ''}${t.best.train.toFixed(4)} SOL on older trades, ${t.best.test >= 0 ? '+' : ''}${t.best.test.toFixed(4)} SOL on newer ones).`);
      send({ title: `${tag}Brain suggests: ${t.name.replace(/ \(.*\)$/, '')}`, priority: 4, tags: ['bulb'], body: [`${t.what}`, '', `Best version: ${t.best.label}.`, `On older trades: ${t.best.train >= 0 ? '+' : ''}${t.best.train.toFixed(4)} SOL vs what the bot does now. On ${t.test} newer trades it never saw: ${t.best.test >= 0 ? '+' : ''}${t.best.test.toFixed(4)} SOL.`, '', t.sideOnly ? 'This is a side test: it never skips a paper trade.' : 'Nothing was changed. Say the word and it can become a rule.', mode === 'live' ? '' : 'Paper: no real money used.'].join('\n') });
    }
    writeVault();
    return lastTests;
  }
  // OBSIDIAN-READY: the findings as a markdown note (front matter + tables) in the second brain's machine side
  function writeVault() {
    if (!vault || !lastTests) return;
    vaultChanged(vault.sync({ 'machine/findings.md': findingsMarkdown({ tests: lastTests, speed: lastSpeed, mode, updated: new Date(now()).toISOString(), solUsd: solUsd() }), 'AGENTS.md': AGENTS_MD }));
  }
  // THE SECOND BRAIN (vault.mjs): every bought trade, its day, the patterns, the decisions and Home as Obsidian notes
  const vault = vaultDir ? createVault(vaultDir, { log }) : null;
  const unsynced = new Set();
  const vaultChanged = (paths) => { for (const p of paths || []) unsynced.add(p); };
  const matchedOf = (r) => [...new Set((r.thinking || []).map((t) => /pattern [▲▼] "([^"]+)"/.exec(t)?.[1]).filter(Boolean))].map((label) => ({ label }));
  const mirrorOf = (r) => mirror10(r, { rules: { stopLossPct: rules.stopLossPct, gainGatePct: rules.gainGatePct, gateSec }, solUsd: solUsd() });
  // CHARTS IN THE NOTES (notecharts.mjs): saved as pictures in machine/charts/; a note embeds every chart file that
  // exists for it, so a rewrite (or a restart) never drops a chart that was already made.
  const CH = 'machine/charts', TRADE_CHARTS = ['price', 'delay', 'mirror', 'exits', 'vs-history'], DAY_CHARTS = ['day-compare', 'day-cumulative'];
  const ANALYSIS_CHARTS = ['cumulative', 'missed-per-day', 'by-blocks', 'by-latency', 'by-crowd', 'by-premium', 'premium-vs-result'];
  const chartFile = (stem, name) => `${CH}/${safeName(`${stem} ${name}`)}.png`;
  const embedsOf = (stem, names) => Object.fromEntries(names.filter((n) => vault.has(chartFile(stem, n))).map((n) => [n, `![[${chartFile(stem, n)}]]`]));
  const ruleOptsNow = () => ({ stopLossPct: rules.stopLossPct, gainGatePct: rules.gainGatePct, gateSec });
  const analysisOf = (r) => tradeAnalysis(r, records, { mirror: mirrorOf(r), mirrorUrl: (() => { const m = mirrorOf(r); return m ? mirrorChart(r, m) : null; })(), pathUrl: coinChart(r, records, { gatePct: rules.gainGatePct, stopPct: rules.stopLossPct }), rules: ruleOptsNow(), poolFee });
  async function renderInto(stem, specs) { // returns {name: embed}; a chart that can't be drawn keeps its old picture or links online
    const out = {};
    for (const sp of specs) {
      const file = chartFile(stem, sp.name), png = await renderPng(sp, { fetchImpl: chartFetch });
      if (png) { vaultChanged(vault.sync({ [file]: png })); out[sp.name] = `![[${file}]]`; }
      else if (vault.has(file)) out[sp.name] = `![[${file}]]`;
      else { const u = chartUrl(sp); if (u.length < 8000) out[sp.name] = `![${sp.name}](${u})`; }
    }
    return out;
  }
  let notesQueue = Promise.resolve(), analysisAt = 0;
  /** A new bought trade: its note right away, then its charts, its day's charts and (at most every analysisEveryMin) the history's. */
  function chartTrade(r) {
    if (!vault || !noteCharts) return;
    notesQueue = notesQueue.then(async () => {
      try {
        const a = analysisOf(r), stem = tradeNoteName(r), day = String(r.time).slice(0, 10);
        const tc = await renderInto(stem, a.charts);
        vaultChanged(vault.sync({ [`machine/trades/${stem}.md`]: tradeNote(r, { mirror: mirrorOf(r), matched: matchedOf(r), analysis: a.md, charts: { ...embedsOf(stem, TRADE_CHARTS), ...tc } }) }));
        await renderInto(`daily ${day}`, dayCharts(day, records, mirrorOf));
        if (now() - analysisAt >= analysisEveryMin * 60e3) { analysisAt = now(); await renderInto('analysis', analysisCharts(delayAnalysis(records, { buySol, solUsd: solUsd(), mirrorOf }))); }
        writeNotes([]); // the day, Home and the analysis note pick up the new pictures
      } catch (e) { log('second brain charts: ' + e.message); }
    });
  }
  function writeNotes(trades) {
    if (!vault) return;
    try {
      const st = status(), files = {}, days = new Set();
      for (const r of trades) { const stem = tradeNoteName(r); files[`machine/trades/${stem}.md`] = tradeNote(r, { mirror: mirrorOf(r), matched: matchedOf(r), analysis: analysisOf(r).md, charts: embedsOf(stem, TRADE_CHARTS) }); days.add(String(r.time).slice(0, 10)); }
      const lastDay = bought(records).at(-1)?.time; if (lastDay) days.add(String(lastDay).slice(0, 10));
      for (const d of days) files[`machine/daily/${d}.md`] = dailyNote(d, records, { mirrorOf, decisions: mem.decisions, rank: st.rank?.name ?? null, bankrollUsd: st.rank?.bankrollUsd ?? null, charts: embedsOf(`daily ${d}`, DAY_CHARTS) });
      files['machine/analysis/Delays and missed profit.md'] = analysisMarkdown(delayAnalysis(records, { buySol, solUsd: solUsd(), mirrorOf }), { charts: embedsOf('analysis', ANALYSIS_CHARTS), updated: new Date(now()).toISOString(), buySol });
      for (const l of learn.lessons()) files[`machine/patterns/${patternNoteName(l.label)}.md`] = patternNote({ label: l.label, status: l.status, trades: l.n, wins: l.wins, avgFcat: l.avg }, records);
      files['machine/decisions.md'] = decisionsNote(mem.decisions);
      files['Home.md'] = homeNote({ mode, status: st, records, updated: new Date(now()).toISOString() });
      files['AGENTS.md'] = AGENTS_MD;
      vaultChanged(vault.sync(files));
    } catch (e) { log('second brain: ' + e.message); }
  }
  /** The whole vault as one zip (dashboard download). */
  const vaultZip = () => (vault ? zipFiles(vault.list().map((name) => ({ name: `Decu Brain/${name}`, data: vault.read(name) }))) : null);
  // GITHUB SYNC (optional): the changed notes as one commit every vaultSyncMin minutes, to a private repository
  let syncing = false;
  async function pushVault() {
    if (!gitSync || !vault || syncing || !unsynced.size) return null;
    syncing = true;
    const paths = [...unsynced]; unsynced.clear();
    try {
      const files = paths.map((p) => { try { return { name: p, data: vault.read(p) }; } catch { return null; } }).filter(Boolean);
      const r = await gitSync.push(files, `brain: ${files.length} note${files.length === 1 ? '' : 's'} updated`);
      if (/^failed/.test(r)) for (const p of paths) unsynced.add(p); // tried again next time
      return r;
    } finally { syncing = false; }
  }
  const syncTimer = gitSync && vaultSyncMin > 0 ? setInterval(() => { pushVault().catch(() => {}); }, vaultSyncMin * 60e3) : null;
  syncTimer?.unref?.();
  function think() {
    if (boughtN() % tuneEvery !== 0) return;
    try { runPack(); } catch (e) { log('test pack: ' + e.message); }
    judgeLastChange();
    const studied = records.filter((r) => fin(r.fcat));
    if (studied.length < minEvidence) return;
    const recent = mem.tuning.history.findLast((h) => h.applied);
    if (recent && records.length - recent.fromRecord < tuneEvery) return;
    const to = { ...rules }, why = [];
    const a = advise(records, { buySol, stopLossPct: rules.stopLossPct, gainGatePct: rules.gainGatePct, gateSec, maxPayPct: rules.maxPayPct, minEvidence });
    const f = a.filterWF;
    if (tunable('maxPayPct') && f && /SUPPORTED/.test(f.verdict) && f.pct !== rules.maxPayPct) {
      const step = Math.max(-5, Math.min(5, f.pct - rules.maxPayPct)), v = clamp('maxPayPct', rules.maxPayPct + step);
      if (v !== rules.maxPayPct) { to.maxPayPct = v; why.push(`entry-premium cap ${rules.maxPayPct}% → ${v}%: on older trades the best cap was ${f.pct}% (${f.trainGainSol >= 0 ? '+' : ''}${f.trainGainSol.toFixed(4)} SOL), and it held on ${f.testOf} newer unseen trades (${f.testGainSol >= 0 ? '+' : ''}${f.testGainSol.toFixed(4)} SOL)`); }
    }
    const sg = tuneStopGate(records, { buySol, stopLossPct: rules.stopLossPct, gainGatePct: rules.gainGatePct, gateSec, minTrades: minEvidence });
    if (sg) {
      const s = clamp('stopLossPct', sg.stopLossPct), g = clamp('gainGatePct', sg.gainGatePct);
      if (s !== rules.stopLossPct || g !== rules.gainGatePct) { to.stopLossPct = s; to.gainGatePct = g; why.push(`stop −${rules.stopLossPct}% → −${s}%, gain gate +${rules.gainGatePct}% → +${g}%: better on older trades (${sg.trainGainSol >= 0 ? '+' : ''}${sg.trainGainSol.toFixed(4)} SOL) and on newer unseen ones (+${sg.testGainSol.toFixed(4)} SOL)`); }
    }
    if (!why.length || triedAndFailed(to)) return;
    if (autoTune) {
      const from = { ...rules }; Object.assign(rules, to); mem.tuning.rules = { ...to };
      mem.tuning.history.push({ time: new Date(now()).toISOString(), from, to: { ...to }, why: why.join('; '), applied: true, fromRecord: records.length });
      remember('tune', `Changed: ${why.join('; ')}.`);
      send({ title: `${tag}Brain: I changed my paper rules`, priority: 4, tags: ['gear'], body: ['What I changed and why:', ...why.map((w) => '• ' + w), '', `Now: ${ruleText(rules)}.`, `Your settings stay ${ruleText(defaults)}; I check my change after ${revertAfter} more trades and undo it if it did worse.`, 'Paper only: live settings never change on their own.'].join('\n') });
    } else {
      mem.tuning.history.push({ time: new Date(now()).toISOString(), from: { ...rules }, to: { ...to }, why: why.join('; '), applied: false, fromRecord: records.length });
      remember('suggest', `Suggested: ${why.join('; ')}.`);
      send({ title: `${tag}Brain suggests a change`, priority: 4, tags: ['bulb'], body: ['I would change:', ...why.map((w) => '• ' + w), '', `Now: ${ruleText(rules)}. Suggested: ${ruleText(to)}.`, mode === 'live' ? 'LIVE: I never change live settings. Change them on Render if you agree.' : 'Auto-tune is off (BRAIN_AUTOTUNE=false), so nothing was changed.'].join('\n') });
    }
  }

  // ----- the paper buy veto -----
  const vetoMin = 30;
  /** Before a paper buy lands: null = buy, or the reason the brain skips it. Only once its predictions beat
   *  guessing over the last 30, and only when it expects a clear loss. Live never calls this. */
  function gate(pre) {
    if (!veto) return null;
    const acc = learn.accuracy(vetoMin);
    if (!acc || acc.total < vetoMin || acc.rate < acc.baseline + 0.05) return null;
    const p = learn.predict(pre);
    if (!p || p.fcat > -0.05 || !p.basis.length) return null;
    const reason = `brain skip: I expect ${pct(p.fcat)} (${p.basis.map((b) => b.label).join(', ')}); my last ${acc.total} predictions were ${Math.round(acc.rate * 100)}% right: not bought`;
    mem.vetoes.push({ time: new Date(now()).toISOString(), mint: pre.mint, predicted: p.fcat, basis: p.basis.map((b) => b.label) }); if (mem.vetoes.length > 500) mem.vetoes.shift();
    remember('skip', reason, { mint: pre.mint });
    return reason;
  }
  const vetoScore = () => {
    const out = mem.vetoes.map((v) => records.find((r) => r.mint === v.mint && /brain skip/.test(r.skipReason || ''))).filter((r) => r && fin(r.fcat));
    return { skipped: out.length, rightSkips: out.filter((r) => r.fcat <= 0).length, savedSol: -out.reduce((a, r) => a + r.fcat * buySol, 0) };
  };

  // ----- after every studied trade -----
  function onTrade(rec) {
    if (rec.taken === false || rec.skipReason) { save(); return; } // skipped buys teach the patterns, not the rank
    judgeRank();
    judgeGoal();
    think();
    const m = mirror10(rec, { rules: { stopLossPct: rules.stopLossPct, gainGatePct: rules.gainGatePct, gateSec }, solUsd: solUsd() });
    const day = mirrorTotals(records.filter((r) => String(r.time).slice(0, 10) === String(rec.time).slice(0, 10)), { solUsd: solUsd() });
    const v = mem.versions.at(-1), sinceV = bought(records).slice(v?.fromBought ?? 0), prevV = mem.versions.at(-2);
    const verLine = sinceV.length ? `Since v${v.version}: ${sinceV.length} trades, ${sinceV.filter((r) => r.fcat > 0).length} won, avg FCAT ${pct(sinceV.reduce((a, r) => a + r.fcat, 0) / sinceV.length)}${prevV ? (() => { const pv = bought(records).slice(prevV.fromBought, v.fromBought); return pv.length ? ` vs ${pct(pv.reduce((a, r) => a + r.fcat, 0) / pv.length)} on v${prevV.version}` : ''; })() : ''}.` : null;
    const name = rec.symbol ? `$${rec.symbol}` : `${rec.mint.slice(0, 6)}…`;
    const body = [
      `BRAIN · ${rankLine()}`,
      goalLine(),
      '',
      'What I think:',
      ...(rec.thinking || []).slice(0, 4).map((x) => '• ' + x),
      'Patterns I remember:',
      ...patternLines(rec).map((x) => '• ' + x),
      m ? '' : null,
      m ? `$10 MIRROR (bought at your real entry, sold ${m.exitAt}):` : '$10 mirror: no Decu price for this trade.',
      m ? `• Decu perfect $10: ${usd(m.perfectUsd)} (his price in, same exit)` : null,
      m ? `• Your $10 mirror: ${usd(m.yourUsd)} → the delay cost ${usd(m.delayUsd)} (you paid ${pct(m.premium)} ${m.premium >= 0 ? 'more' : 'less'}, ${rec.delaySec ?? '?'} s${rec.latency?.blocksAfter != null ? ` / ${rec.latency.blocksAfter} blocks` : ''} after him)` : null,
      m && m.feesUsd != null ? `• Network fees: ${usd(-m.feesUsd)} (${m.feeSol.toFixed(4)} SOL priority + tip, the same at any size) → after fees ${usd(m.afterFeesUsd)}` : null,
      m ? `• Same trade at $10: FCAT ${usd(m.fcatUsd)} · PCAT ${usd(m.pcatUsd)} · your stop/gate rules ${usd(m.rulesUsd)}${m.rulesHow ? ` (${m.rulesHow})` : ''}` : null,
      rec.crowd ? `• Place in line: #${rec.crowd.place} after Decu (${rec.crowd.trades} trade${rec.crowd.trades === 1 ? '' : 's'} by others landed between his buy and yours${rec.crowd.sol != null ? `, ${rec.crowd.sol >= 0 ? '+' : ''}${rec.crowd.sol} SOL into the curve` : ''}${rec.crowd.exact ? '' : ', paper estimate'})` : null,
      day.trades ? `Today at $10: Decu ${usd(day.perfectUsd)} · you ${usd(day.yourUsd)} · delay cost ${usd(day.delayUsd)} · fees ${usd(-day.feesUsd)} over ${day.trades} trades` : null,
      '',
      `My rules now: ${ruleText(rules)}${JSON.stringify(rules) !== JSON.stringify(defaults) ? ` (your settings: ${ruleText(defaults)})` : ''}`,
      verLine,
      mode === 'live' ? '' : 'No real money used.',
    ].filter((x) => x != null).join('\n');
    send({ kind: 'brain', title: `${tag}Brain: ${name} $10 mirror ${m ? usd(m.yourUsd) : '—'} vs Decu ${m ? usd(m.perfectUsd) : '—'} · delay ${m ? usd(m.delayUsd) : '—'}`, body, priority: 3, click: `https://pump.fun/coin/${rec.mint}`, image: m ? mirrorChart(rec, m) : undefined });
    mem.stats = { bought: boughtN(), studied: records.length, updated: new Date(now()).toISOString() };
    save();
    writeNotes([rec]);
    chartTrade(rec);
    if (now() - (mem.backupAt || 0) >= backupHours * 3600e3) backupSoon();
  }

  let backingUp = null;
  function backupSoon() {
    if (!backup || backingUp) return backingUp;
    mem.backupAt = now(); save();
    let lines = null;
    try { lines = journalFile ? fs.readFileSync(journalFile, 'utf8').split('\n').filter(Boolean).slice(-3000) : null; } catch { lines = null; }
    backingUp = backup.save({ memory: { ...mem, day: undefined }, journalLines: lines }).then((r) => { remember('backup', `GitHub backup ${r}.`); save(); return r; }).finally(() => { backingUp = null; });
    return backingUp;
  }

  function status() {
    const f = facts(), i = mem.rank.index;
    const gp = f.bank - f.start;
    return { goal: { usd: goalUsd, profitUsd: gp, pct: gp / goalUsd, reached: gp >= goalUsd }, patterns: learn.lessons().slice(0, 10).map((l) => ({ label: l.label, status: l.status, trades: l.n, wins: l.wins, avgFcat: l.avg })), rank: { name: RANKS[i].name, index: i + 1, of: RANKS.length, since: mem.rank.since, history: mem.rank.history.slice(-20), next: RANKS[i + 1] ? { name: RANKS[i + 1].name, checks: rankChecks(RANKS[i + 1], f) } : null, bankrollUsd: f.bank },
      ranks: RANKS.map((r) => r.name), mode, autoTune, veto, rules: { ...rules }, defaults: { ...defaults }, tuning: mem.tuning.history.slice(-20), decisions: mem.decisions.slice(-30), vetoes: vetoScore(),
      tests: (lastTests || (records.length ? runPack() : [])).map((t) => ({ id: t.id, name: t.name, what: t.what, verdict: t.verdict, supported: t.supported, sideOnly: !!t.sideOnly, trades: t.trades, best: t.best ? { label: t.best.label, train: t.best.train, test: t.best.test } : null, groups: t.groups || null })),
      speed: lastSpeed || speedReport(records, { buySol }), marketCaps: marketCapGroups(records),
      mirror: mirrorTotals(records, { solUsd: solUsd() }), versions: mem.versions.slice(-10), backup: backup ? { lastAt: mem.backupAt || null } : null };
  }

  // the history as notes once at start (the newest vaultBackfill bought trades); a GitHub push soon after
  if (vault) {
    writeNotes(bought(records).slice(-vaultBackfill));
    // the history's charts once at start (the trades' own charts come with each new trade)
    if (noteCharts) notesQueue = notesQueue.then(async () => { analysisAt = now(); await renderInto('analysis', analysisCharts(delayAnalysis(records, { buySol, solUsd: solUsd(), mirrorOf }))); writeNotes([]); }).catch((e) => log('second brain charts: ' + e.message));
    if (gitSync) setTimeout(() => pushVault().catch(() => {}), 30_000).unref?.();
  }
  return { onTrade, gate, status, save, backup: backupSoon, rankLine, memory: () => mem, runPack, vaultZip, pushVault, notesIdle: () => notesQueue, vaultStatus: () => (vault ? { files: vault.list().length, unsynced: unsynced.size, sync: gitSync ? gitSync.status() || { pending: true } : null } : null), stop: () => { clearInterval(syncTimer); vault?.close(); }, findings: () => findingsMarkdown({ tests: lastTests || runPack(), speed: lastSpeed, mode, updated: new Date(now()).toISOString(), solUsd: solUsd() }) };
}
