// THE CALL LOG: every step of every Ultron call (and test call), in order, as detailed as possible.
// Each step is one JSON line, written to three places:
//   1. the server log (Render → Logs), prefixed [ultron];
//   2. a file next to the engine state (Render: /var/data/ultron-calls.jsonl), kept across restarts and deploys;
//   3. memory, for the dashboard (Talk to Ultron → Call log) and GET /api/ultron/log.
// Keys and tokens are scrubbed and phone numbers masked before anything is written. At start, lines already in the
// file are scrubbed again with today's rules (so a rule added later also cleans what was written before).
// A log write that fails never breaks a call.

import fs from 'node:fs';

export function createCallLog({file = null, keep = 3000, maxBytes = 5_000_000, print = (line) => console.log(line), redact = (s) => s, now = () => Date.now()} = {}) {
  const ring = []; let writes = 0;
  const rotate = () => { try { if (file && fs.statSync(file).size > maxBytes) fs.renameSync(file, file + '.1'); } catch { /* no file yet */ } };
  /** Scrub a file already on disk with the current rules; rewritten (atomically) only if something changed. */
  const rescrub = (f) => {
    let text; try { text = fs.readFileSync(f, 'utf8'); } catch { return null; }
    let changed = false;
    const lines = text.split('\n').map((l) => { if (!l) return l; let r; try { r = redact(l); } catch { r = l; } if (r !== l) changed = true; return r; });
    if (changed) { try { fs.writeFileSync(f + '.tmp', lines.join('\n'), {mode: 0o600}); fs.renameSync(f + '.tmp', f); } catch { /* keep the old file */ } }
    return lines;
  };
  if (file) {
    rotate(); rescrub(file + '.1');
    for (const line of (rescrub(file) || []).slice(-keep - 1)) { if (!line) continue; try { ring.push(JSON.parse(line)); } catch { /* a torn last line */ } }
  }

  /** Add one step. Returns the entry as written (scrubbed). */
  function add(e = {}) {
    let line;
    try { line = redact(JSON.stringify({at: new Date(now()).toISOString(), ...e})); } catch { return null; }
    let entry; try { entry = JSON.parse(line); } catch { return null; }
    ring.push(entry); if (ring.length > keep) ring.splice(0, ring.length - keep);
    if (file) { try { if (++writes % 200 === 0) rotate(); fs.appendFileSync(file, line + '\n', {mode: 0o600}); } catch { /* disk trouble: keep the call going */ } }
    try { print('[ultron] ' + (line.length > 6000 ? line.slice(0, 6000) + '…(cut; the full step is in the log file)' : line)); } catch { /* no stdout */ }
    return entry;
  }

  /** The newest steps (oldest first), optionally of one call. */
  function recent({limit = 300, call = null} = {}) {
    const rows = call ? ring.filter((e) => (e.call ?? 'other') === call) : ring; // 'other' = steps outside a call (big wins skipped, refused requests)
    return rows.slice(-Math.max(1, Math.min(limit, keep)));
  }

  /** One line per call, newest first: when, why, how it went, what it cost. */
  function calls(limit = 20) {
    const by = new Map();
    for (const e of ring) {
      const key = e.call ?? 'other';
      const c = by.get(key) || {call: key, sid: null, firstAt: e.at, lastAt: e.at, steps: 0, reason: null, outcome: null, providerStatus: null, turns: null, costUsd: null, errors: 0, heard: 0};
      c.lastAt = e.at; c.steps++; c.sid ||= e.sid || null;
      if (key === 'other') c.reason = 'other events';
      else if (e.reason && !c.reason) c.reason = e.reason;
      if (e.step === 'status' && e.CallStatus) c.providerStatus = e.CallStatus;
      if (e.step === 'heard' && e.text) c.heard++;
      if (/error|failed|rejected|warning|unknown/.test(e.step)) c.errors++;
      if (e.step === 'call-summary') { c.outcome = e.why; c.turns = e.turns; c.costUsd = e.costUsd; }
      by.set(key, c);
    }
    return [...by.values()].sort((a, b) => (a.lastAt < b.lastAt ? 1 : -1)).slice(0, limit);
  }

  /** The whole log as JSON lines (the file, or memory when there is no file). */
  function jsonl() {
    if (file) { try { return fs.readFileSync(file, 'utf8'); } catch { /* fall through */ } }
    return ring.map((e) => JSON.stringify(e)).join('\n') + (ring.length ? '\n' : '');
  }

  return {add, recent, calls, jsonl, file};
}
