// THE DUEL BRAINS (PAPER ONLY): one per trader (DIP, FCAT). Each one reads every shared observation (the Decu
// buys, their price paths, holder snapshots, buyers ahead), its trader's trades and skipped decisions, and its
// own settings. It never touches the main bot's rules, live settings or the protected limits (duelmath LIMITS).
//
// How a brain learns, out loud (every step is in its report, the dashboard and the Obsidian notes):
//  1. LOOK BACK: it replays recent Decu buys with one setting changed at a time (duelmath replay). This only
//     PROPOSES; a replay is in-sample and approximate.
//  2. TEST FORWARD: a promising change runs as a live paper variant ("challenger") on Decu buys it has never
//     seen, side by side with the trader, on the very same buys and prices.
//  3. DECIDE: after 30+ shared buys, a challenger whose 90% interval of "extra SOL per buy" is above zero is
//     adopted (a new version of the trader); below zero, dropped; still unclear after 80, dropped as "no
//     clear difference". After an adoption the old settings keep running for a while: if they win, it reverts.
import { DEFAULTS, LIMITS, allowedChange, replay, bootstrapMean, evidence, summarize, fin, CHECK_NAMES, isMissing, entryChecks } from './duelmath.mjs';

const GRID = {
  common: { tpEarlyPct: [12, 15, 21, 25], tpLatePct: [20, 30, 40], tpEarlySec: [10, 20], maxBuysAhead: [0, 1], hisUsdMin: [150, 300], mcapMax: [12000, 15000], mcapMin: [3000, 5000] },
  dip: { dipPct: [5, 10], dipWindowSec: [30, 45], stopFromHisPct: [15, 25] },
  fcat: { maxPayPct: [10, 15] },
};
const FILTER_KEYS = ['maxBuysAhead', 'hisUsdMin', 'mcapMax', 'mcapMin', 'maxPayPct'];
const pct = (x, d = 1) => (fin(x) ? `${x < 0 ? '−' : '+'}${Math.abs(x * 100).toFixed(d)}%` : '—');
const sol = (x, d = 3) => (fin(x) ? `${x < 0 ? '−' : '+'}${Math.abs(x).toFixed(d)} SOL` : '—');
const PARAM_NAMES = { tpEarlyPct: 'early take-profit %', tpEarlySec: 'early window (s)', tpLatePct: 'later take-profit %', maxBuysAhead: 'max buyers ahead', hisUsdMin: "Decu's buy at least ($)", mcapMax: 'market cap at most ($)', mcapMin: 'market cap at least ($)', dipPct: 'dip depth under his price %', dipWindowSec: 'dip window (s)', stopFromHisPct: 'stop under his price %', maxPayPct: 'pay at most %' };
export const paramText = (diff) => Object.entries(diff || {}).map(([k, v]) => `${PARAM_NAMES[k] || k} ${v}`).join(', ');

/** The Decu buys a trader's FILTERS let through (its buy trigger and exits decide the rest). */
const passedFilters = (rec, vid) => { const d = rec.decisions?.[vid]; if (!d) return false; if (d.status === 'bought') return true; return d.status === 'skipped' && (d.fails || []).every((f) => ['no-dip', 'pay', 'his-sold', 'holding', 'balance'].includes(f)); };
const replayInput = (rec, api) => ({ path: rec.path, P: rec.P, hisSellMs: rec.hisSell?.sec != null ? rec.hisSell.sec * 1000 : null, fee: api.fee(), sideFee: api.sideFee(), seenMs: Math.max(0, (rec.seenAt || rec.hisTime * 1000) - rec.hisTime * 1000), landMs: api.landMs });
const passesNew = (rec, p) => entryChecks({ ...rec, crowd: rec.crowd, holder0: rec.holder0 }, p, { filters: true }).fails.length === 0;

/** Look back: one-setting changes replayed on recent buys. -> [{diff, n, meanDiff}] best first. */
export function lookBack(strategy, p, recs, api, { minN = 20 } = {}) {
  const pop = recs.filter((r) => Array.isArray(r.path) && r.path.length > 2 && fin(r.P) && passedFilters(r, strategy)).slice(-300);
  if (pop.length < minN) return { n: pop.length, ideas: [] };
  const base = pop.map((r) => replay(p, replayInput(r, api)));
  const ideas = [];
  const grid = { ...GRID.common, ...(GRID[strategy] || {}) };
  for (const [key, values] of Object.entries(grid)) for (const value of values) {
    if (value === p[key] || !allowedChange(strategy, key, value)) continue;
    if (FILTER_KEYS.includes(key) && !stricter(key, value, p)) continue; // filters may only get stricter
    const trial = { ...p, [key]: value };
    const diffs = pop.map((r, i) => {
      const b = base[i], a = b?.taken && !b.open ? b.ret : 0;
      if (FILTER_KEYS.includes(key) && !passesNew(r, trial)) return 0 - a;
      const t = replay(trial, replayInput(r, api)); return (t?.taken && !t.open ? t.ret : 0) - a;
    });
    const m = diffs.reduce((x, y) => x + y, 0) / diffs.length;
    ideas.push({ diff: { [key]: value }, n: pop.length, meanDiff: m, changed: diffs.filter((x) => Math.abs(x) > 1e-9).length });
  }
  ideas.sort((a, b) => b.meanDiff - a.meanDiff);
  return { n: pop.length, ideas };
}
const stricter = (key, value, p) => (key === 'maxBuysAhead' || key === 'mcapMax' || key === 'maxPayPct' ? value < p[key] : value > p[key]);

export function createDuelBrain({ strategy, api, log = () => {}, minForward = 30, maxForward = 80, maxActive = 2 }) {
  const label = strategy.toUpperCase();
  let mem = { experiments: [], decisions: [], nextId: 1, lookBack: null };
  let cached = null, dirty = true, tradesSince = 0;
  const main = () => api.variants().find((v) => v.id === strategy);
  const now = () => api.now();
  const decision = (kind, text, extra = {}) => { mem.decisions.push({ at: new Date(now()).toISOString(), kind, text, ...extra }); if (mem.decisions.length > 300) mem.decisions.shift(); dirty = true; };

  /** Paired forward result: the challenger vs the trader on the SAME Decu buys seen after the challenger started. */
  const forward = (x) => {
    const recs = api.candidates().filter((r) => r.hisTime * 1000 >= x.startedAt);
    const mine = new Map(api.tradesOf(x.variant).map((t) => [t.candId, t])), theirs = new Map(api.tradesOf(strategy).map((t) => [t.candId, t]));
    const diffs = [], rets = [];
    for (const r of recs) { const a = theirs.get(r.id), b = mine.get(r.id); if (!a && !b) continue; diffs.push((b?.pnlSol || 0) - (a?.pnlSol || 0)); if (b) rets.push(b.ret); }
    const ci = bootstrapMean(diffs, { level: 0.9 });
    return { n: diffs.length, meanSol: ci?.mean ?? null, low: ci?.low ?? null, high: ci?.high ?? null, totalSol: diffs.reduce((a, d) => a + d, 0), trades: rets.length, avgRet: rets.length ? rets.reduce((a, r) => a + r, 0) / rets.length : null };
  };
  const judge = () => {
    for (const x of mem.experiments.filter((e) => e.status === 'testing')) {
      const f = forward(x); x.result = f;
      if (f.n >= minForward && f.low > 0) {
        if (x.kind === 'revert-check') { // the OLD settings are winning again: go back
          const v = api.autoTune ? api.adopt(strategy, x.diff, `revert: the previous settings beat v${main().version} on ${f.n} new Decu buys`) : null;
          x.status = v ? 'adopted' : 'validated'; decision(v ? 'revert' : 'suggest', v ? `Went back to ${paramText(x.diff)} (v${v}): it beat the newer settings by ${sol(f.meanSol, 4)} per Decu buy on ${f.n} buys it had not seen.` : `The previous settings (${paramText(x.diff)}) beat the current ones on ${f.n} unseen buys; auto-tune is off, so nothing changed.`, { experiment: x.id });
        } else {
          const prev = Object.fromEntries(Object.keys(x.diff).map((k) => [k, main().p[k]]));
          const v = api.autoTune ? api.adopt(strategy, x.diff, `validated on ${f.n} unseen Decu buys: ${sol(f.meanSol, 4)} per buy (90% interval ${sol(f.low, 4)} to ${sol(f.high, 4)})`) : null;
          x.status = v ? 'adopted' : 'validated';
          decision(v ? 'adopt' : 'suggest', v ? `Changed ${paramText(x.diff)} (now v${v}): on ${f.n} Decu buys it had never seen it made ${sol(f.meanSol, 4)} more per buy (90% interval ${sol(f.low, 4)} to ${sol(f.high, 4)}).` : `${paramText(x.diff)} won on ${f.n} unseen buys (${sol(f.meanSol, 4)} per buy); auto-tune is off, so it is only a suggestion.`, { experiment: x.id });
          if (v) startExperiment(prev, 'revert-check', `keeps the previous settings running to check v${v}`);
        }
        api.removeVariant(x.variant);
      } else if ((f.n >= minForward && f.high < 0) || f.n >= maxForward) {
        x.status = f.high < 0 ? 'rejected' : 'no difference';
        decision('drop', `${x.kind === 'revert-check' ? 'Kept the new settings' : `Dropped ${paramText(x.diff)}`}: ${f.high < 0 ? `it made ${sol(f.meanSol, 4)} per buy on ${f.n} unseen buys` : `no clear difference after ${f.n} unseen buys (${sol(f.meanSol, 4)} per buy)`}.`, { experiment: x.id });
        api.removeVariant(x.variant);
      }
    }
  };
  const startExperiment = (diff, kind = 'challenger', why = '') => {
    const m = main(); if (!m) return null;
    const id = `${strategy}-x${mem.nextId++}`;
    const p = { ...m.p, ...diff };
    api.addVariant({ id, label: `${label} test: ${paramText(diff)}`, strategy, role: 'challenger', p, diff, parent: strategy });
    const x = { id, variant: id, kind, diff, why, startedAt: now(), status: 'testing', result: null };
    mem.experiments.push(x); if (mem.experiments.length > 100) mem.experiments.shift();
    decision('test', `Started testing ${paramText(diff)} on Decu buys from now on${why ? ` (${why})` : ''}.`, { experiment: id });
    return x;
  };
  const propose = () => {
    const active = mem.experiments.filter((e) => e.status === 'testing');
    if (active.length >= maxActive) return;
    const m = main(); if (!m) return;
    const lb = lookBack(strategy, m.p, api.candidates(), api);
    mem.lookBack = { at: new Date(now()).toISOString(), n: lb.n, top: lb.ideas.slice(0, 5) };
    const recent = new Set(mem.experiments.slice(-12).map((e) => JSON.stringify(e.diff)));
    for (const idea of lb.ideas) {
      if (active.length >= maxActive) break;
      if (idea.meanDiff <= 0.005 || idea.changed < 5 || recent.has(JSON.stringify(idea.diff))) continue;
      if (active.some((e) => Object.keys(e.diff).some((k) => k in idea.diff))) continue;
      active.push(startExperiment(idea.diff, 'challenger', `looking back at ${idea.n} buys it was ${pct(idea.meanDiff)} per buy better`));
    }
  };

  // ---------- what it believes, what it rejects, what each filter cost ----------
  const beliefs = (trades, recs) => {
    const byId = new Map(recs.map((r) => [r.id, r]));
    const rows = trades.map((t) => ({ t, r: byId.get(t.candId) })).filter((x) => x.r);
    if (rows.length < 10) return { working: [], hurting: [], note: `${rows.length} closed trades: beliefs start at 10` };
    const avg = rows.reduce((a, x) => a + x.t.ret, 0) / rows.length;
    const dims = [
      ['Decu buy', (x) => x.r.hisUsd, [[75, 150, '$75–150'], [150, 400, '$150–400'], [400, Infinity, 'over $400']]],
      ['market cap at his buy', (x) => x.r.hisMcapUsd, [[0, 6000, 'under $6k'], [6000, 10000, '$6k–10k'], [10000, 22001, '$10k–22k']]],
      ['entry vs his price', (x) => x.t.premium, [[-Infinity, 0, 'at or under his price'], [0, 0.1, '0–10% above'], [0.1, Infinity, '10%+ above']]],
      ['holders when spotted', (x) => x.r.holder0?.holders, [[0, 30, 'under 30'], [30, 100, '30–100'], [100, Infinity, '100+']]],
      ['holder money vs the rule', (x) => x.r.holder0?.verdict?.ratio, [[0, 1, 'below your baseline (relaxed in)'], [1, 3, '1–3x the baseline'], [3, Infinity, '3x+ the baseline']]],
      ['top 10 holders own', (x) => x.r.holder0?.top10Pct, [[0, 0.2, 'under 20% of supply'], [0.2, 0.35, '20–35%'], [0.35, Infinity, '35%+']]],
      ['buyers ahead', (x) => x.r.crowd?.buysAhead, [[0, 0, 'none'], [1, 2, '1–2']]],
      ['how it ended', (x) => ({ 'tp-early': 0, 'tp-late': 1, stop: 2, 'his-sell': 3, 'his-sell-late': 3 })[x.t.exit], [[0, 0, 'early take-profit'], [1, 1, 'later take-profit'], [2, 2, 'stop'], [3, 3, 'Decu sold']]],
    ];
    const out = [];
    for (const [name, get, buckets] of dims) for (const [lo, hi, bl] of buckets) {
      const xs = rows.filter((x) => { const v = get(x); return fin(v) && v >= lo && v <= hi && !(hi !== lo && v === hi && hi !== Infinity); });
      if (xs.length < 5) continue;
      const a = xs.reduce((s, x) => s + x.t.ret, 0) / xs.length;
      out.push({ text: `${name}: ${bl}`, n: xs.length, avg: a, wins: xs.filter((x) => x.t.ret > 0).length, vsAll: a - avg });
    }
    return { avg, n: rows.length, working: out.filter((b) => b.avg > 0 && b.vsAll > 0.03).sort((a, b) => b.vsAll - a.vsAll).slice(0, 5), hurting: out.filter((b) => b.avg < 0 && b.vsAll < -0.03).sort((a, b) => a.vsAll - b.vsAll).slice(0, 5) };
  };
  const rejections = (recs) => {
    const unf = new Map(api.tradesOf(`${strategy}-all`).map((t) => [t.candId, t]));
    const by = {}, recent = [];
    let total = 0, missing = 0;
    for (const r of recs) {
      const d = r.decisions?.[strategy];
      if (!d || d.status !== 'skipped') continue;
      const fails = (d.fails || []).filter((f) => !['holding', 'balance'].includes(f));
      if (!fails.length) continue;
      total++; if (d.missing) missing++;
      const cf = unf.get(r.id);
      for (const f of fails) {
        const b = by[f] || (by[f] = { key: f, text: CHECK_NAMES[f] || f, missing: isMissing(f), n: 0, only: 0, cfN: 0, cfSol: 0, cfRet: 0 });
        b.n++;
        if (fails.length === 1) { b.only++; if (cf) { b.cfN++; b.cfSol += cf.pnlSol; b.cfRet += cf.ret; } }
      }
      if (recent.length < 25) recent.push({ id: r.id, sym: r.sym, mint: r.mint, time: r.hisTime, reasons: fails.map((f) => CHECK_NAMES[f] || f), cf: cf ? cf.ret : null });
    }
    const list = Object.values(by).map((b) => ({ ...b, cfAvg: b.cfN ? b.cfRet / b.cfN : null, verdict: !b.cfN ? 'no outcome yet' : b.cfSol < 0 ? `saved ${sol(-b.cfSol)}` : `missed ${sol(b.cfSol)}` })).sort((a, b) => b.n - a.n);
    return { total, missing, byReason: list, recent: recent.reverse().slice(0, 25).reverse() };
  };

  const build = () => {
    const m = main();
    if (!m) return null;
    const recs = api.candidates(), trades = api.tradesOf(strategy), s = summarize(trades);
    const testing = mem.experiments.filter((e) => e.status === 'testing').map((x) => ({ ...x, result: x.result || forward(x), need: minForward }));
    const newestX = [...mem.experiments].reverse().find((e) => e.result || e.status === 'testing');
    const newest = newestX ? { id: newestX.id, diff: newestX.diff, kind: newestX.kind, status: newestX.status, result: newestX.result || forward(newestX), since: newestX.startedAt } : null;
    const optimizing = Object.keys({ ...GRID.common, ...(GRID[strategy] || {}) }).filter((k) => LIMITS[k]).map((k) => ({ key: k, name: PARAM_NAMES[k] || k, now: m.p[k], range: LIMITS[k] }));
    const protectedList = ['trade size 0.1 SOL', 'paper only', 'sells when Decu sells', strategy === 'fcat' ? 'no stop-loss' : 'keeps a stop under his price', 'filters only get stricter than yours', 'holder rule never under $500 at $10k'];
    return {
      strategy, label, version: m.version, params: m.p, defaults: DEFAULTS[strategy], autoTune: api.autoTune, updated: new Date(now()).toISOString(),
      summary: s, evidence: evidence(trades.map((t) => t.ret)), optimizing, protected: protectedList,
      testing, newest, lookBack: mem.lookBack, beliefs: beliefs(trades, recs), rejections: rejections(recs.slice(-600)),
      validation: mem.experiments.filter((e) => e.status !== 'testing').slice(-15).reverse(), decisions: mem.decisions.slice(-20).reverse(),
      versions: m.version,
    };
  };

  return {
    onTrade() { dirty = true; if (++tradesSince >= 10) { tradesSince = 0; try { this.cycle(); } catch (e) { log('duel brain: ' + e.message); } } },
    onCandidate() { dirty = true; },
    rebuild() { dirty = true; },
    cycle() { judge(); propose(); cached = build(); dirty = false; },
    report() { if (dirty || !cached) { try { judge(); cached = build(); dirty = false; } catch (e) { log('duel brain report: ' + e.message); } } return cached; },
    save: () => mem, load: (m) => { if (m && Array.isArray(m.experiments)) mem = { ...mem, ...m }; },
    _test: { forward, judge, propose, mem: () => mem },
  };
}

// ---------- Obsidian notes (written by duel.mjs into the second-brain vault, machine/DIP vs FCAT/) ----------
const fm = (o) => ['---', ...Object.entries(o).map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : v ?? ''}`), '---', ''].join('\n');
const D = 'machine/DIP vs FCAT';
export const notePaths = { home: `${D}/DIP vs FCAT.md`, brain: (s) => `${D}/${s.toUpperCase()}/${s.toUpperCase()} brain.md`, day: (s, d) => `${D}/${s.toUpperCase()}/days/${s.toUpperCase()} ${d}.md`, holder: `${D}/Holder rule experiment.md`, dips: `${D}/Dip triggers.md`, holders: `${D}/Holders.md` };
const link = (p, text) => `[[${p.replace(/\.md$/, '')}|${text}]]`;

export function brainNote(r) {
  if (!r) return '';
  const s = r.summary;
  const L = [fm({ type: 'duel-brain', trader: r.label, version: r.version, trades: s.n, win_rate: fin(s.winRate) ? Math.round(s.winRate * 100) : null, pnl_sol: Math.round(s.pnlSol * 1e4) / 1e4, evidence: r.evidence.level, auto_tune: !!r.autoTune, updated: r.updated }),
    `# ${r.label} brain (v${r.version})`, '', `${link(notePaths.home, 'DIP vs FCAT')} · paper only`, '',
    `**Results:** ${s.n} trades, ${fin(s.winRate) ? Math.round(s.winRate * 100) + '% won' : '—'}, ${sol(s.pnlSol, 4)}, average ${pct(s.avgRet)} per trade, worst drop ${sol(s.maxDrawdownSol, 3)}.`,
    `**Evidence:** ${r.evidence.text}.`, '',
    '## What I am testing right now', ...(r.testing.length ? r.testing.map((x) => `- ${paramText(x.diff)} (${x.kind === 'revert-check' ? 'checking my last change' : 'challenger'}): ${x.result?.n ?? 0} of ${x.need} shared Decu buys so far, ${sol(x.result?.meanSol, 4)} per buy vs me${x.result?.n >= 2 ? ` (90% interval ${sol(x.result.low, 4)} to ${sol(x.result.high, 4)})` : ''}. Every buy it is judged on came after it started: unseen data.`) : ['- Nothing yet: I need 20+ recorded Decu buys that passed my filters before I look back for ideas.']), '',
    '## Settings I optimise (and their limits)', ...r.optimizing.map((o) => `- ${o.name}: now ${o.now ?? '—'} (allowed ${o.range[0]}–${o.range[1]})`), '', `Protected (never changed by me): ${r.protected.join('; ')}.`, '',
    '## What I believe is working', ...(r.beliefs.working?.length ? r.beliefs.working.map((b) => `- ${b.text}: ${pct(b.avg)} average over ${b.n} trades (${pct(b.vsAll)} vs my average)`) : [`- ${r.beliefs.note || 'nothing stands out yet'}`]), '',
    '## What I believe is hurting', ...(r.beliefs.hurting?.length ? r.beliefs.hurting.map((b) => `- ${b.text}: ${pct(b.avg)} average over ${b.n} trades (${pct(b.vsAll)} vs my average)`) : [`- ${r.beliefs.note || 'nothing stands out yet'}`]), '',
    '## Signals I rejected', `${r.rejections.total} Decu buys rejected (${r.rejections.missing} only for missing data).`, '',
    '| Filter | Rejected | Only reason | What those would have done | Verdict |', '|---|---|---|---|---|',
    ...r.rejections.byReason.map((b) => `| ${b.text} | ${b.n} | ${b.only} | ${b.cfN ? `${pct(b.cfAvg)} avg over ${b.cfN}` : '—'} | ${b.verdict} |`), '',
    ...(r.rejections.recent.length ? ['Latest rejections:', ...r.rejections.recent.slice(-10).reverse().map((x) => `- ${new Date(x.time * 1000).toISOString().slice(0, 16).replace('T', ' ')} ${x.sym ? '$' + x.sym : x.mint.slice(0, 6)}: ${x.reasons.join(', ')}${fin(x.cf) ? ` (unfiltered it did ${pct(x.cf)})` : ''}`)] : []), '',
    '## My newest experiment vs me', r.newest ? `- ${paramText(r.newest.diff)}: ${r.newest.status}, ${r.newest.result?.n ?? 0} shared buys, ${sol(r.newest.result?.totalSol, 4)} in total vs me (${sol(r.newest.result?.meanSol, 4)} per buy).` : '- none yet', '',
    '## Validated on unseen future data?', ...(r.validation.length ? r.validation.map((x) => `- ${paramText(x.diff)}: **${x.status}** after ${x.result?.n ?? 0} unseen buys (${sol(x.result?.meanSol, 4)} per buy, 90% interval ${sol(x.result?.low, 4)} to ${sol(x.result?.high, 4)})`) : ['- No experiment has finished yet.']), '',
    '## My decisions', ...(r.decisions.length ? r.decisions.map((d) => `- ${String(d.at).slice(0, 16).replace('T', ' ')} **${d.kind}**: ${d.text}`) : ['- none yet']), ''];
  return L.join('\n');
}
export function dayNote(strategy, day, trades) {
  const s = summarize(trades);
  return [fm({ type: 'duel-day', trader: strategy.toUpperCase(), day, trades: s.n, pnl_sol: Math.round(s.pnlSol * 1e4) / 1e4, won: s.wins }), `# ${strategy.toUpperCase()} on ${day}`, '', `${link(notePaths.brain(strategy), `${strategy.toUpperCase()} brain`)} · ${link(notePaths.home, 'DIP vs FCAT')}`, '',
    `${s.n} trades, ${s.wins} won, ${sol(s.pnlSol, 4)}.`, '', '| Time | Coin | Paid vs his | Exit | Held | Result |', '|---|---|---|---|---|---|',
    ...trades.map((t) => `| ${new Date(t.fillAt).toISOString().slice(11, 19)} | ${t.sym ? '$' + t.sym : t.mint.slice(0, 6)} | ${pct(t.premium)} | ${t.exit} | ${t.holdSec}s | ${sol(t.pnlSol, 4)} (${pct(t.ret)}) |`), ''].join('\n');
}
export function homeNote(a) {
  const A = a.traders.dip, B = a.traders.fcat, h = a.headToHead;
  return [fm({ type: 'duel-home', updated: new Date(a.now).toISOString(), dip_pnl_sol: Math.round(A.summary.pnlSol * 1e4) / 1e4, fcat_pnl_sol: Math.round(B.summary.pnlSol * 1e4) / 1e4, leader: a.leader }), '# DIP vs FCAT (paper)', '',
    `${link(notePaths.brain('dip'), 'DIP brain')} · ${link(notePaths.brain('fcat'), 'FCAT brain')} · ${link(notePaths.holder, 'Holder rule experiment')} · ${link(notePaths.dips, 'Dip triggers')} · ${link(notePaths.holders, 'Holders')}`, '',
    '| | DIP | FCAT |', '|---|---|---|',
    `| Trades | ${A.summary.n} | ${B.summary.n} |`, `| Won | ${fin(A.summary.winRate) ? Math.round(A.summary.winRate * 100) + '%' : '—'} | ${fin(B.summary.winRate) ? Math.round(B.summary.winRate * 100) + '%' : '—'} |`,
    `| Profit | ${sol(A.summary.pnlSol, 4)} | ${sol(B.summary.pnlSol, 4)} |`, `| Average trade | ${pct(A.summary.avgRet)} | ${pct(B.summary.avgRet)} |`, `| Worst drop | ${sol(A.summary.maxDrawdownSol)} | ${sol(B.summary.maxDrawdownSol)} |`,
    `| Paper balance | ${fin(A.balance) ? A.balance.toFixed(3) + ' SOL' : '—'} | ${fin(B.balance) ? B.balance.toFixed(3) + ' SOL' : '—'} |`, `| Version | v${A.version} | v${B.version} |`, '',
    `**Same Decu buys:** both traded ${h.both.n} (DIP ${sol(h.both.a, 4)}, FCAT ${sol(h.both.b, 4)}), only DIP ${h.onlyA.n} (${sol(h.onlyA.sol, 4)}), only FCAT ${h.onlyB.n} (${sol(h.onlyB.sol, 4)}).`,
    `**Which is better:** ${h.evidence.level === 'supported' ? 'FCAT, with enough evidence' : h.evidence.level === 'against' ? 'DIP, with enough evidence' : `not decided yet (${h.evidence.text}; FCAT minus DIP per Decu buy)`}.`, ''].join('\n');
}
export function holderNote(hr) {
  const o = hr.outcomes, line = (x) => (x.n ? `${pct(x.avg)} average over ${x.n} (${x.wins} won)` : 'no outcomes yet');
  return [fm({ type: 'duel-holder-rule', k: hr.k, increase: fin(hr.increase) ? Math.round(hr.increase * 1000) / 10 : null, coins: hr.coins, missing: hr.missing }), '# Holder rule experiment', '', link(notePaths.home, 'DIP vs FCAT'), '',
    `Your baseline (unchanged, still labelled SAFE/RISKY): holders other than the dev must hold ${hr.rules.map(([m, h]) => `$${h} at a $${m / 1000}k market cap`).join(', ')}. Under $${hr.rules[0][0] / 1000}k a coin is always SAFE.`,
    `Relaxed (a separate label): the same steps × k. Now **k = ${hr.k}** (floor ${hr.kMin}: never under $${hr.floorUsd} at a $10k market cap). Target: ${Math.round((hr.target - 1) * 100)}% more coins accepted than the baseline.`, '',
    `- Coins checked: ${hr.coins}; with holder data ${hr.withData}; missing data ${hr.missing} (counted apart, never as rejected)`,
    `- Baseline SAFE: ${hr.baselineSafe}; relaxed accepts: ${hr.relaxedPass} (${fin(hr.increase) ? pct(hr.increase) : '—'} vs baseline); added by relaxing: ${hr.added}`,
    hr.calibration ? `- Last calibration: ${hr.calibration.n} coins that passed every other check, baseline ${hr.calibration.baseline}, relaxed ${hr.calibration.accepted}, ${hr.calibration.targetMet ? 'target met' : `target NOT reachable within the floor: the most this floor allows is ${pct(hr.calibration.maxIncrease)}`}${hr.calibration.note ? ` (${hr.calibration.note})` : ''}` : '- No calibration yet.', '',
    '## What the coins did (FCAT rules, no filters)', `- Baseline SAFE: ${line(o.baselineSafe)}`, `- Added by the relaxed rule: ${line(o.added)}`, `- Rejected by both: ${line(o.rejected)}`, '',
    'To undo the experiment: set HOLDER_RELAX=off on Render (both traders then use your baseline). The baseline label is kept on every coin either way.', ''].join('\n');
}
export function dipsNote(vs) {
  return [fm({ type: 'duel-dip-triggers' }), '# Dip triggers', '', link(notePaths.home, 'DIP vs FCAT'), '', 'The DIP trader buys when the price comes back to Decu\'s price within 60 s. The two others are measured the same way for comparison (same filters, exits and fills).', '',
    '| Trigger | Trades | Won | Profit | Average |', '|---|---|---|---|---|', ...vs.map((v) => `| ${v.label} | ${v.summary.n} | ${fin(v.summary.winRate) ? Math.round(v.summary.winRate * 100) + '%' : '—'} | ${sol(v.summary.pnlSol, 4)} | ${pct(v.summary.avgRet)} |`), ''].join('\n');
}
export function holdersNote(rows) {
  const b = (name, get, buckets) => [`## By ${name}`, '| Group | Coins | FCAT unfiltered avg | DIP unfiltered avg |', '|---|---|---|---|', ...buckets.map(([lo, hi, l]) => { const xs = rows.filter((r) => fin(get(r)) && get(r) >= lo && get(r) < hi); const av = (k) => { const v = xs.map((r) => r[k]).filter(fin); return v.length ? `${pct(v.reduce((a, x) => a + x, 0) / v.length)} (${v.length})` : '—'; }; return `| ${l} | ${xs.length} | ${av('fcatAll')} | ${av('dipAll')} |`; }), ''];
  return [fm({ type: 'duel-holders', coins: rows.length }), '# Holders on every Decu buy', '', link(notePaths.home, 'DIP vs FCAT'), '', 'Taken when the bot spots his buy (and again 60 s later). Money held = every holder except the dev and the curve, at the current price.', '',
    ...b('number of holders', (r) => r.holders, [[0, 20, 'under 20'], [20, 50, '20–49'], [50, 100, '50–99'], [100, 250, '100–249'], [250, Infinity, '250+']]),
    ...b('money held', (r) => r.heldUsd, [[0, 500, 'under $500'], [500, 1000, '$500–1k'], [1000, 2500, '$1k–2.5k'], [2500, 5000, '$2.5k–5k'], [5000, Infinity, '$5k+']]),
    ...b('top 10 share of supply', (r) => r.top10Pct, [[0, 0.15, 'under 15%'], [0.15, 0.25, '15–25%'], [0.25, 0.4, '25–40%'], [0.4, Infinity, '40%+']]), ''].join('\n');
}
