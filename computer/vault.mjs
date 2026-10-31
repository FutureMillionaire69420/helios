// THE SECOND BRAIN: the bot's thinking written as an Obsidian vault (plain markdown files with front matter and
// [[links]]), next to the study journal on the Render disk.
//
//   Home.md                        rank, goal, rules, today, links to everything
//   AGENTS.md                      the map of the vault: what each folder is, who may write where
//   machine/trades/<day> <time> <coin>.md   one note per bought trade: what the brain predicted and why, what
//                                  happened, the $10 mirror, place in line, the patterns it matched (linked)
//   machine/daily/<day>.md         the day's numbers as front matter (a row per day for Obsidian queries) + its trades
//   machine/patterns/<pattern>.md  every pattern the brain trusts, with its record and the trades that matched it
//   machine/decisions.md           every decision: tuning, reverts, suggestions, rank changes, goal milestones
//   machine/findings.md            the paper-test pack (written by the brain)
//   human/                         YOURS: the bot never writes there (only a README the first time)
//
// The machine side is rewritten from the bot's own records, so it can never drift from them. Only files whose
// content changed are written (and synced). Two ways to get it on the phone: a zip from the dashboard, or a
// private GitHub repository (GITHUB_VAULT_TOKEN + GITHUB_VAULT_REPO) that Obsidian's Git plugin pulls.
// Nothing here trades.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const pct = (x, d = 1) => (!fin(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`);
const usd = (x) => (!fin(x) ? '—' : `${x < 0 ? '−' : '+'}$${Math.abs(x).toFixed(2)}`);
const y = (v) => (v == null || (typeof v === 'number' && !Number.isFinite(v)) ? '' : typeof v === 'boolean' ? String(v) : typeof v === 'number' ? String(Math.round(v * 1e6) / 1e6) : JSON.stringify(String(v)));
const frontMatter = (o) => ['---', ...Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.map(y).join(', ')}]` : y(v)}`), '---', ''].join('\n');
/** A file name Obsidian (and iPhone Files) accept. */
export const safeName = (s) => String(s).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';
const coin = (r) => (r.symbol ? `$${r.symbol}` : r.mint.slice(0, 6));
const bought = (records) => records.filter((r) => r.taken !== false && !r.skipReason && fin(r.fcat));
export const tradeNoteName = (r) => safeName(`${String(r.time).slice(0, 10)} ${String(r.time).slice(11, 16).replace(':', '')} ${coin(r)}`);
export const patternNoteName = (label) => safeName(label.replace(/\+/g, 'and'));

/** One bought trade as a note. ctx: { mirror, patterns (matched lessons), rank, rules } (all optional). */
export function tradeNote(r, ctx = {}) {
  const m = ctx.mirror, day = String(r.time).slice(0, 10), p = r.prediction;
  const matched = (ctx.matched || []).map((s) => s.label);
  return frontMatter({
    type: 'trade', coin: coin(r), mint: r.mint, time: r.time, day, mode: r.mode,
    fcat: r.fcat, won: r.fcat > 0, exit: r.fcatExit, entry_premium: r.entryGap, delay_s: r.delaySec, blocks_after: r.latency?.blocksAfter ?? null,
    place_in_line: r.crowd?.place ?? null, decu_sol: r.hisSol, shape: r.shape, predicted: p?.fcat ?? null, prediction_right: p ? p.right : null,
    mirror_usd: m?.yourUsd ?? null, decu_perfect_usd: m?.perfectUsd ?? null, delay_cost_usd: m?.delayUsd ?? null, fees_usd: m?.feesUsd ?? null,
    market_cap_usd: r.hisMcapUsd ?? r.coin?.marketCapUsd ?? null, patterns: matched,
  }) + [
    `# ${coin(r)} · FCAT ${pct(r.fcat)}`, '',
    `Back to [[daily/${day}|${day}]] · [[Home]]`, '',
    '## What I thought before the result',
    ...(r.thinking?.length ? r.thinking.map((x) => `- ${x}`) : ['- (no thoughts recorded)']),
    '',
    ...(ctx.analysis ? [ctx.charts?.price || '', ctx.charts?.delay || '', ctx.charts?.mirror || '', '', ctx.analysis, '', ctx.charts?.exits || '', ctx.charts?.['vs-history'] || '', ''] : []),
    '## What happened',
    `- Decu bought ${fin(r.hisSol) ? r.hisSol.toFixed(3) : '?'} SOL; I bought ${r.delaySec ?? '?'} s${r.latency?.blocksAfter != null ? ` / ${r.latency.blocksAfter} blocks` : ''} later${fin(r.entryGap) ? ` and paid ${Math.abs(r.entryGap * 100).toFixed(1)}% ${r.entryGap >= 0 ? 'more' : 'less'} than him` : ''}.`,
    r.crowd ? `- Place in line: #${r.crowd.place} (${r.crowd.trades} trades by others landed between his buy and mine${r.crowd.exact ? '' : ', paper estimate'}).` : null,
    `- FCAT ${pct(r.fcat)}, sold at ${r.fcatExit || '—'}. Best moment ${r.btsab ?? '—'} s at ${pct(r.peak)}; worst ${pct(r.worst)}. PCAT (his price) ${pct(r.pcat)}.`,
    r.shape ? `- Shape: ${r.shape}.` : null,
    p ? `- My prediction was ${pct(p.fcat)}: ${p.right ? 'RIGHT' : 'WRONG'}.` : null,
    '',
    m ? '## The $10 mirror' : null,
    m ? `- Decu perfect $10: ${usd(m.perfectUsd)} · mine: ${usd(m.yourUsd)} · the delay cost ${usd(m.delayUsd)} · fees ${usd(m.feesUsd == null ? null : -m.feesUsd)} → after fees ${usd(m.afterFeesUsd)}` : null,
    m ? `- Same trade at $10: FCAT ${usd(m.fcatUsd)} · PCAT ${usd(m.pcatUsd)} · stop/gate rules ${usd(m.rulesUsd)}${m.rulesHow ? ` (${m.rulesHow})` : ''}` : null,
    m ? '' : null,
    matched.length ? '## Patterns it matched' : null,
    ...matched.map((l) => `- [[patterns/${patternNoteName(l)}|${l}]]`),
    matched.length ? '' : null,
    ...(r.notes?.length ? ['## Notes', ...r.notes.map((x) => `- ${x}`), ''] : []),
    `Coin: [pump.fun](https://pump.fun/coin/${r.mint}) · \`${r.mint}\``, '',
  ].filter((x) => x != null).join('\n');
}

/** The day as one note: its numbers as front matter (one row per day for Obsidian queries) and its trades. */
export function dailyNote(day, records, { mirrorOf = () => null, decisions = [], rank = null, bankrollUsd = null, charts = null } = {}) {
  const rs = bought(records).filter((r) => String(r.time).slice(0, 10) === day);
  const ms = rs.map(mirrorOf).filter(Boolean), sum = (k) => ms.reduce((a, m) => a + (fin(m[k]) ? m[k] : 0), 0);
  const dec = decisions.filter((d) => String(d.time).slice(0, 10) === day);
  return frontMatter({
    type: 'daily', day, trades: rs.length, won: rs.filter((r) => r.fcat > 0).length, fcat_sol_at_0_1: rs.reduce((a, r) => a + r.fcat * 0.1, 0),
    mirror_usd: ms.length ? sum('yourUsd') : null, decu_perfect_usd: ms.length ? sum('perfectUsd') : null, delay_cost_usd: ms.length ? sum('delayUsd') : null, fees_usd: ms.length ? sum('feesUsd') : null,
    rank, bankroll_usd: bankrollUsd, studied: records.filter((r) => String(r.time).slice(0, 10) === day).length,
  }) + [
    `# ${day}`, '', `[[Home]] · [[machine/analysis/Delays and missed profit|Delays and missed profit]]`, '',
    ...(charts?.['day-compare'] ? [charts['day-compare'], ''] : []), ...(charts?.['day-cumulative'] ? [charts['day-cumulative'], ''] : []),
    `## Trades (${rs.length} bought, ${rs.filter((r) => r.fcat > 0).length} won)`,
    ...(rs.length ? rs.map((r) => `- ${String(r.time).slice(11, 16)} [[trades/${tradeNoteName(r)}|${coin(r)}]] FCAT ${pct(r.fcat)} · paid ${pct(r.entryGap)} over Decu${r.prediction ? ` · predicted ${pct(r.prediction.fcat)} (${r.prediction.right ? 'right' : 'wrong'})` : ''}`) : ['- none']),
    '',
    ms.length ? `## At $10 a trade\n- Decu ${usd(sum('perfectUsd'))} · me ${usd(sum('yourUsd'))} · the delay cost ${usd(sum('delayUsd'))} · fees ${usd(-sum('feesUsd'))}\n` : null,
    dec.length ? '## What I decided' : null,
    ...dec.map((d) => `- ${String(d.time).slice(11, 16)} **${d.kind}**: ${d.text}`),
    '',
  ].filter((x) => x != null).join('\n');
}

export function patternNote(lesson, records) {
  const hits = bought(records).filter((r) => (r.thinking || []).some((t) => t.includes(`"${lesson.label}"`))).slice(-30);
  return frontMatter({ type: 'pattern', pattern: lesson.label, status: lesson.status, trades: lesson.trades ?? lesson.n, wins: lesson.wins, avg_fcat: lesson.avgFcat ?? lesson.avg }) + [
    `# ${lesson.label}`, '', `[[Home]] · status: **${lesson.status}**`, '',
    `- ${lesson.wins}/${lesson.trades ?? lesson.n} won, average FCAT ${pct(lesson.avgFcat ?? lesson.avg)}.`,
    `- ${lesson.status === 'confirmed' ? 'Confirmed: it has held on enough trades to trust.' : 'Emerging: it stands out, but needs more trades to be confirmed.'}`, '',
    hits.length ? '## Recent trades that matched it' : null,
    ...hits.reverse().map((r) => `- [[trades/${tradeNoteName(r)}|${coin(r)} ${String(r.time).slice(0, 16).replace('T', ' ')}]] FCAT ${pct(r.fcat)}`), '',
  ].filter((x) => x != null).join('\n');
}

export function homeNote({ mode = 'paper', status = null, records = [], updated = new Date().toISOString() }) {
  const s = status || {}, rs = bought(records), days = [...new Set(rs.map((r) => String(r.time).slice(0, 10)))].slice(-14).reverse();
  return frontMatter({ type: 'home', mode, updated, rank: s.rank?.name ?? null, bankroll_usd: s.rank?.bankrollUsd ?? null, goal_usd: s.goal?.usd ?? null, profit_usd: s.goal?.profitUsd ?? null, bought: rs.length, studied: records.length }) + [
    `# Decu bot second brain (${mode})`, '',
    s.rank ? `**Rank:** ${s.rank.name} (${s.rank.index}/${s.rank.of}) · $1000 paper bankroll now $${fin(s.rank.bankrollUsd) ? s.rank.bankrollUsd.toFixed(2) : '—'}` : null,
    s.goal ? `**Goal:** $${s.goal.usd} profit · ${usd(s.goal.profitUsd)} so far${s.goal.reached ? ' · REACHED' : ''}` : null,
    s.rules ? `**My rules now:** premium cap ${s.rules.maxPayPct}% · stop −${s.rules.stopLossPct}% · gain gate +${s.rules.gainGatePct}%${s.defaults && JSON.stringify(s.rules) !== JSON.stringify(s.defaults) ? ` (your settings ${s.defaults.maxPayPct}% / −${s.defaults.stopLossPct}% / +${s.defaults.gainGatePct}%)` : ''}` : null,
    s.rank?.next ? `**Next rank (${s.rank.next.name}):** ${s.rank.next.checks.map((c) => `${c.ok ? '✔' : '✘'} ${c.text}`).join(' · ')}` : null,
    '',
    '## Days', ...days.map((d) => `- [[daily/${d}|${d}]]`), '',
    '## What I trust', ...((s.patterns || []).length ? s.patterns.map((p) => `- [[patterns/${patternNoteName(p.label)}|${p.label}]] (${p.status}, ${p.wins}/${p.trades} won)`) : ['- nothing strong enough yet']), '',
    '## More', '- [[machine/analysis/Delays and missed profit|Delays and missed profit (charts)]]', '- [[machine/findings|Paper tests and findings]]', '- [[machine/decisions|Every decision I made]]', '- [[AGENTS|How this vault works]]', '',
  ].filter((x) => x != null).join('\n');
}

export function decisionsNote(decisions = []) {
  return frontMatter({ type: 'decisions', count: decisions.length }) + ['# Every decision I made', '', '[[Home]]', '',
    ...[...decisions].reverse().map((d) => `- ${String(d.time).slice(0, 16).replace('T', ' ')} **${d.kind}**: ${d.text}`), ''].join('\n');
}

export const AGENTS_MD = ['# How this vault works', '',
  '- `machine/` is written by the Decu bot from its own trade records. It is rewritten all the time: do not edit it (your changes would be replaced).',
  '- `human/` is yours. The bot never writes there.',
  '- [[Home]] is the start page. Every trade, day and pattern is a note, linked to the others; the front matter (the block at the top of each note) holds the numbers, so Obsidian can sort and query them.',
  '- Paper mode: no real money is used.', ''].join('\n');
const HUMAN_README = ['# Your notes', '', 'This folder is yours: the bot never writes here. Write anything: ideas, rules you want tested, what you noticed about Decu.', ''].join('\n');

/**
 * The vault on disk. sync(files) writes only the files whose content changed and returns their relative paths.
 * Trade notes are rewritten only when the trade changes (e.g. its price tail arrived).
 */
export function createVault(dir, { log = () => {} } = {}) {
  const hashes = new Map(), sha = (t) => crypto.createHash('sha1').update(t).digest('hex');
  let closed = false;
  const write = (rel, text) => { // text: a string (note) or a Buffer (chart picture)
    const h = sha(text);
    if (hashes.get(rel) === h) return false;
    const abs = path.join(dir, rel);
    try { const old = fs.readFileSync(abs); if (Buffer.isBuffer(text) ? old.equals(text) : old.toString('utf8') === text) { hashes.set(rel, h); return false; } } catch {}
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, { mode: 0o600 });
    hashes.set(rel, h);
    return true;
  };
  return {
    dir,
    /** files: {relPath: text or Buffer}. Never writes under human/ except its README once. */
    sync(files) {
      const changed = [];
      if (closed) return changed;
      try {
        fs.mkdirSync(path.join(dir, 'human'), { recursive: true });
        if (!fs.existsSync(path.join(dir, 'human', 'README.md'))) { fs.writeFileSync(path.join(dir, 'human', 'README.md'), HUMAN_README, { mode: 0o600 }); changed.push('human/README.md'); }
        for (const [rel, text] of Object.entries(files)) if (!rel.startsWith('human/') && write(rel, text)) changed.push(rel);
      } catch (e) { log('second brain not written: ' + e.message); }
      return changed;
    },
    /** Every file of the vault (relative paths), for the zip and the GitHub sync. */
    list() {
      const out = [];
      const walk = (rel) => { for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) { const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(r); else if (/\.(md|png)$/.test(e.name)) out.push(r); } };
      try { walk(''); } catch {}
      return out.sort();
    },
    read: (rel) => fs.readFileSync(path.join(dir, rel)),
    has: (rel) => fs.existsSync(path.join(dir, rel)),
    /** The bot is stopping: notes and charts still being made are not written any more. */
    close() { closed = true; },
  };
}

// ---------- the zip (no library: stored + deflated entries, CRC-32 from zlib) ----------
export function zipFiles(entries) {
  const locals = [], centrals = []; let offset = 0;
  const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  const now = new Date();
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8'), raw = Buffer.isBuffer(data) ? data : Buffer.from(data), deflated = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw) >>> 0;
    const head = Buffer.alloc(30); head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(8, 8);
    head.writeUInt16LE(dosTime(now), 10); head.writeUInt16LE(dosDate(now), 12); head.writeUInt32LE(crc, 14); head.writeUInt32LE(deflated.length, 18); head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    locals.push(head, nameBuf, deflated);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(dosTime(now), 12); c.writeUInt16LE(dosDate(now), 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(deflated.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    centrals.push(c, nameBuf);
    offset += 30 + nameBuf.length + deflated.length;
  }
  const central = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}

// ---------- GitHub sync (a private repository just for the brain) ----------
/** Pushes the changed files as ONE commit (Git data API). An empty repository gets its first commit first. */
export function createGitSync({ token, repo, branch = 'main', fetchImpl = globalThis.fetch, log = () => {}, maxBlobs = 30 } = {}) {
  if (!token || !repo) return null;
  const api = `https://api.github.com/repos/${repo}`, hide = (t) => String(t).split(token).join('***');
  const call = async (p, init = {}) => {
    const r = await fetchImpl(`${api}${p}`, { ...init, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'decu-copybot-vault', ...(init.body ? { 'Content-Type': 'application/json' } : {}) }, signal: AbortSignal.timeout(20_000) });
    return { status: r.status, body: r.status === 204 ? null : await r.json().catch(() => null) };
  };
  let last = null;
  return {
    repo, branch, maxBlobs, // maxBlobs: pictures uploaded per push (GitHub limits uploads to ~80 a minute and ~500 an hour)
    status: () => last,
    async push(files, message = 'brain update') {
      try {
        if (!files.length) return 'nothing to push';
        let ref = await call(`/git/ref/heads/${branch}`);
        if (ref.status === 404 || ref.status === 409) { // an empty repository: create its first file, then the branch exists
          const first = await call('/contents/README.md', { method: 'PUT', body: JSON.stringify({ message: 'start the Decu brain vault', branch, content: Buffer.from('# Decu bot second brain\n\nWritten by the Decu bot. Open this folder in Obsidian.\n').toString('base64') }) });
          if (first.status !== 201 && first.status !== 200) throw new Error(`GitHub: cannot start the repository (HTTP ${first.status})`);
          ref = await call(`/git/ref/heads/${branch}`);
        }
        if (ref.status !== 200) throw new Error(`GitHub: cannot read the ${branch} branch (HTTP ${ref.status})`);
        const parent = ref.body.object.sha, base = await call(`/git/commits/${parent}`);
        const tree = [];
        for (const f of files) {
          // a note is text: it goes inside the one tree request (no upload call per note); a picture needs its own upload
          if (/\.(md|txt|json)$/i.test(f.name)) { tree.push({ path: f.name, mode: '100644', type: 'blob', content: Buffer.from(f.data).toString('utf8') }); continue; }
          const blob = await call('/git/blobs', { method: 'POST', body: JSON.stringify({ content: f.data.toString('base64'), encoding: 'base64' }) });
          if (blob.status !== 201) throw new Error(`GitHub: saving ${f.name} failed (HTTP ${blob.status})`);
          tree.push({ path: f.name, mode: '100644', type: 'blob', sha: blob.body.sha });
        }
        const t = await call('/git/trees', { method: 'POST', body: JSON.stringify({ base_tree: base.body.tree.sha, tree }) });
        const c = await call('/git/commits', { method: 'POST', body: JSON.stringify({ message, tree: t.body.sha, parents: [parent] }) });
        const u = await call(`/git/refs/heads/${branch}`, { method: 'PATCH', body: JSON.stringify({ sha: c.body.sha }) });
        if (u.status !== 200) throw new Error(`GitHub: updating ${branch} failed (HTTP ${u.status})`);
        last = { at: new Date().toISOString(), files: files.length, ok: true };
        return `pushed ${files.length} file${files.length === 1 ? '' : 's'}`;
      } catch (e) { last = { at: new Date().toISOString(), ok: false, error: hide(e.message) }; log('second brain sync: ' + hide(e.message)); return 'failed: ' + hide(e.message); }
    },
  };
}
