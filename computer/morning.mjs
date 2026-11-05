// MORNING PUSH: the bot's own daily briefing. One phone message a day at MORNING_PUSH_AT (default 07:43)
// in TIMEZONE (default America/New_York): health, paper results, the SOL price. Built only from what the
// bot already knows: no AI, no connectors, no extra data credits, and nothing in here can change anything.
// MORNING_PUSH=false turns it off. A restart later than 3 hours after the time skips that day.

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const pct = (x, d = 1) => (!fin(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const usd = (x) => (!fin(x) ? '—' : `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`);
const sol = (x) => (!fin(x) ? '—' : `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(4)}`);
const kilo = (n) => (!fin(n) ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)));
const ago = (ms) => (!fin(ms) || ms < 0 ? null : ms < 90_000 ? 'just now' : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min ago` : ms < 172_800_000 ? `${Math.round(ms / 3_600_000)} h ago` : `${Math.round(ms / 86_400_000)} days ago`);
const span = (ms) => { const h = Math.floor(ms / 3_600_000); return h >= 48 ? `${Math.floor(h / 24)} d ${h % 24} h` : h >= 1 ? `${h} h` : `${Math.max(1, Math.round(ms / 60_000))} min`; };

/** Local calendar day and minute of the day in a time zone. */
export function zoned(ms, timezone = 'America/New_York') {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  } catch { return zoned(ms, 'UTC'); }
  const p = Object.fromEntries(parts.filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

/** Is today's push due? Once per local day, from `at` until `windowMin` minutes later. */
export function morningDue({ now = Date.now(), timezone = 'America/New_York', at = '07:43', lastDay = null, windowMin = 180 } = {}) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(at).trim());
  const target = m && Number(m[1]) < 24 && Number(m[2]) < 60 ? Number(m[1]) * 60 + Number(m[2]) : 7 * 60 + 43;
  const z = zoned(now, timezone);
  return { due: z.day !== lastDay && z.min >= target && z.min < target + windowMin, day: z.day, target };
}

/**
 * The message. f = {mode, version, uptimeMs, ready:{ready,blocking,warnings}, feed, lastSignalAt, errors,
 * trades (bought, last 24 h), buySol, mirror (mirrorTotals of those), rankLine, solUsd, solUsdPrev,
 * helius ({credits, limit, pace}), ntfy ({total, max}), now}
 */
export function morningBrief(f = {}) {
  const now = f.now ?? Date.now(), live = f.mode === 'live';
  const tag = live ? '' : f.mode === 'paper' ? '[PAPER] ' : `[${String(f.mode || 'demo').toUpperCase()}] `;
  const rs = Array.isArray(f.trades) ? f.trades.filter((r) => fin(r.fcat)) : [];
  const wins = rs.filter((r) => r.fcat > 0).length, fcatSol = rs.reduce((a, r) => a + r.fcat * (f.buySol || 0), 0);
  const ready = f.ready?.ready !== false;
  const problems = [...(f.ready?.blocking || []), ...(f.ready?.warnings || [])];
  const h = f.helius, lastSig = f.lastSignalAt ? ago(now - Date.parse(f.lastSignalAt)) : null;
  const solMove = fin(f.solUsd) && fin(f.solUsdPrev) && f.solUsdPrev > 0 ? f.solUsd / f.solUsdPrev - 1 : null;
  const body = [
    'HEALTH',
    `• v${f.version || '?'} · up ${fin(f.uptimeMs) ? span(f.uptimeMs) : '?'} · ${ready ? 'ready ✔' : `NOT READY: ${(f.ready?.blocking || []).join(', ')}`}${ready && problems.length ? ` · check: ${problems.join(', ')}` : ''}`,
    `• Decu feed: ${f.feed || '?'}${lastSig ? ` · his last trade ${lastSig}` : ''}${fin(f.errors) && f.errors ? ` · ${f.errors} errors since start` : ''}`,
    h ? `• Helius credits: ${kilo(h.credits)} of ${kilo(h.limit)} this month${fin(h.pace) ? ` (pace ${kilo(h.pace)}${h.limit && h.pace > h.limit ? ': OVER the plan' : ''})` : ''}` : null,
    f.ntfy ? `• Phone alerts: ${f.ntfy.total} of ${f.ntfy.max} used today (UTC)` : null,
    '',
    `${live ? 'RESULTS' : 'PAPER RESULTS'} (last 24 h)`,
    rs.length ? `• ${rs.length} trade${rs.length === 1 ? '' : 's'}, ${wins} won · FCAT ${sol(fcatSol)} SOL at ${f.buySol} SOL a trade` : '• No bought trades in the last 24 h.',
    f.mirror?.trades ? `• $10 mirror: ${usd(f.mirror.yourUsd)} before fees, ${usd(f.mirror.afterFeesUsd ?? (f.mirror.yourUsd - (f.mirror.feesUsd || 0)))} after fees` : null,
    f.rankLine ? `• Brain: ${f.rankLine}` : null,
    '',
    'MARKET',
    fin(f.solUsd) ? `• SOL $${f.solUsd.toFixed(2)}${solMove != null ? ` (${pct(solMove)} since yesterday's push)` : ''}` : '• SOL price not available right now.',
    '',
    live ? 'Read-only summary: it changes nothing.' : 'No real money used. Read-only summary: it changes nothing.',
  ].filter((x) => x != null).join('\n');
  const title = `${tag}Good morning · ${rs.length} trade${rs.length === 1 ? '' : 's'} · FCAT ${sol(fcatSol)} SOL · ${ready ? 'healthy' : 'NOT READY'}`;
  return { title, body };
}
