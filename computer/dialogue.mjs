// ULTRON'S DIALOGUE LIBRARY: thousands of lines in his own voice, one JSON file per category in dialogue/, read only
// when a category is first needed (selective loading). New packs (dialogue/packs/*.json, same format) add lines or
// whole categories without touching the code.
//
// A category file:  {"id": "humor", "title": "Humor and comedy", "triggers": ["\\bjoke\\b", ...], "priority": 50,
//                    "followUp": 0.3, "entries": ["a line", {"t": "a line", "mood": "warm", "w": 2}, ...]}
//   triggers  regular expressions (lower-case text) that send an owner's remark to this category
//   priority  higher wins when several categories match
//   followUp  the chance Ultron adds a follow-up question (from the "questions" category)
//   entries   a line, or {t, mood: stern|warm|upbeat|calm|any, w: weight}
//
// Picking a line: weighted random among the category's lines that fit the mood, never one used in the last
// COOLDOWN picks of this call (or the last GLOBAL_COOLDOWN picks across calls), so he does not repeat himself.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dialogue');
const COOLDOWN = 60, GLOBAL_COOLDOWN = 400;

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const entryOf = (e) => (typeof e === 'string' ? {t: e, mood: 'any', w: 1} : {t: String(e.t || ''), mood: e.mood || 'any', w: Number(e.w) > 0 ? Number(e.w) : 1});

/** The library: an index of every category (id, title, triggers) read once; the lines only when needed. */
export function createDialogue({dir = DIR, random = Math.random} = {}) {
  const files = [];
  const scan = (d) => { try { for (const f of fs.readdirSync(d).sort()) { const p = path.join(d, f); if (f.endsWith('.json') && f !== 'guests.json') files.push(p); else if (f === 'packs' && fs.statSync(p).isDirectory()) scan(p); } } catch { /* no library: Ultron keeps his built-in lines */ } };
  scan(dir);
  const index = new Map(); // id -> {title, triggers: [RegExp], priority, followUp, files: [path]}
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    if (!j?.id) continue;
    const cur = index.get(j.id) || {id: j.id, title: j.title || j.id, triggers: [], priority: 0, followUp: 0, files: []};
    for (const t of j.triggers || []) { try { cur.triggers.push(new RegExp(t, 'i')); } catch { /* the validator reports it */ } }
    cur.priority = Math.max(cur.priority, Number(j.priority) || 0); cur.followUp = Math.max(cur.followUp, Number(j.followUp) || 0);
    cur.files.push(f); index.set(j.id, cur);
  }
  const loaded = new Map(), recent = [];
  const lines = (id) => {
    if (!loaded.has(id)) {
      const all = [];
      for (const f of index.get(id)?.files || []) { try { all.push(...(JSON.parse(fs.readFileSync(f, 'utf8')).entries || []).map(entryOf).filter((e) => e.t.trim())); } catch { /* skip a broken pack */ } }
      loaded.set(id, all);
    }
    return loaded.get(id);
  };
  return {
    categories: () => [...index.values()].map(({id, title, priority}) => ({id, title, priority})),
    has: (id) => index.has(id),
    /** The category an owner's remark belongs to, or null. */
    match(text, {minPriority = -Infinity} = {}) {
      const x = String(text || '').toLowerCase();
      let best = null;
      for (const c of index.values()) if (c.priority >= minPriority && c.triggers.some((r) => r.test(x)) && (!best || c.priority > best.priority)) best = c;
      return best?.id || null;
    },
    /** A line from a category. session: an object kept for the call (remembers what was said); mood: the reply's mood. */
    line(id, {session = null, mood = 'any', followUp = true} = {}) {
      const all = lines(id); if (!all.length) return null;
      const used = new Set([...(session?.saidLines || []), ...recent]);
      let pool = all.filter((e) => !used.has(e.t));
      if (!pool.length) pool = all.filter((e) => !(session?.saidLines || []).slice(-5).includes(e.t)); // all used: anything not said just now
      if (!pool.length) pool = all;
      const fit = pool.filter((e) => e.mood === mood);
      const choose = fit.length && mood !== 'any' && random() < 0.8 ? fit : pool.filter((e) => e.mood === 'any' || e.mood === mood).length ? pool.filter((e) => e.mood === 'any' || e.mood === mood) : pool;
      const total = choose.reduce((a, e) => a + e.w, 0); let r = random() * total, pick = choose[0];
      for (const e of choose) { r -= e.w; if (r <= 0) { pick = e; break; } }
      if (session) { session.saidLines = [...(session.saidLines || []), pick.t].slice(-COOLDOWN); }
      recent.push(pick.t); if (recent.length > GLOBAL_COOLDOWN) recent.shift();
      let text = pick.t;
      const c = index.get(id);
      if (followUp && c.followUp && id !== 'questions' && !/\?\s*$/.test(text) && random() < c.followUp && index.has('questions')) {
        const q = this.line('questions', {session, mood, followUp: false}); if (q) text = `${text} ${q}`;
      }
      return text;
    },
    loadedCount: () => loaded.size,
  };
}

/** Guests the owner introduces ("I'm with <name>"): dialogue/guests.json, [{id, words: [regex], line}]. Read once. */
const guestCache = new Map(); // private: guests.json is not mirrored to the public repo
export function guestFor(text, dir = DIR) {
  if (!guestCache.has(dir)) { let g = []; try { g = JSON.parse(fs.readFileSync(path.join(dir, 'guests.json'), 'utf8')).map((x) => ({...x, re: (x.words || []).map((w) => new RegExp(w, 'i'))})); } catch { /* no guests */ } guestCache.set(dir, g); }
  const x = String(text || '');
  return guestCache.get(dir).find((g) => g.line && g.re.some((r) => r.test(x))) || null;
}

/** The validator: every check the library must pass (used by the tests and `node dialogue.mjs`). */
export function validate(dir = DIR, {min = 4000, required = []} = {}) {
  const problems = [], byCat = {}, seen = new Map(), files = [];
  const scan = (d) => { for (const f of fs.readdirSync(d).sort()) { const p = path.join(d, f); if (f.endsWith('.json') && f !== 'guests.json') files.push(p); else if (f === 'packs' && fs.statSync(p).isDirectory()) scan(p); } };
  scan(dir);
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { problems.push(`${path.basename(f)}: not valid JSON (${e.message})`); continue; }
    if (!j.id || !Array.isArray(j.entries)) { problems.push(`${path.basename(f)}: needs "id" and an "entries" list`); continue; }
    for (const t of j.triggers || []) { try { new RegExp(t, 'i'); } catch { problems.push(`${j.id}: bad trigger ${t}`); } }
    const starts = new Map();
    for (const raw of j.entries) {
      const e = entryOf(raw), n = norm(e.t);
      if (!n) { problems.push(`${j.id}: an empty line`); continue; }
      if (e.t.length > (Number(j.maxLength) || 420)) problems.push(`${j.id}: too long to speak (${e.t.slice(0, 40)}...)`);
      if (/[<>{}\[\]*_#`|\\]/.test(e.t)) problems.push(`${j.id}: symbols the voice would read aloud: ${e.t.slice(0, 50)}`);
      if (!['any', 'stern', 'warm', 'upbeat', 'calm'].includes(e.mood)) problems.push(`${j.id}: unknown mood ${e.mood}`);
      if (seen.has(n)) problems.push(`duplicate: "${e.t}" (${seen.get(n)} and ${j.id})`); else seen.set(n, j.id);
      const s3 = n.split(' ').slice(0, 3).join(' '); starts.set(s3, (starts.get(s3) || 0) + 1);
      byCat[j.id] = (byCat[j.id] || 0) + 1;
    }
    const cap = Math.max(6, Math.ceil(j.entries.length * (Number(j.repeatCap) || 0.06))); // riddle and question formats may set repeatCap
    for (const [s3, k] of starts) if (k > cap && s3.split(' ').length === 3) problems.push(`${j.id}: ${k} lines start with "${s3}" (too repetitive)`);
  }
  // near-duplicates inside a category: the same words in a different order, or one word swapped
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
    const sets = (j.entries || []).map((e) => new Set(norm(entryOf(e).t).split(' ').filter((w) => w.length > 2)));
    for (let a = 0; a < sets.length; a++) for (let b = a + 1; b < sets.length; b++) {
      const A = sets[a], B = sets[b]; if (A.size < 4 || B.size < 4) continue;
      let inter = 0; for (const w of A) if (B.has(w)) inter++;
      if (inter / (A.size + B.size - inter) >= 0.8) problems.push(`${j.id}: near-duplicate lines: "${entryOf(j.entries[a]).t}" / "${entryOf(j.entries[b]).t}"`);
    }
  }
  for (const id of required) if (!byCat[id]) problems.push(`missing category ${id}`);
  const total = seen.size;
  if (total < min) problems.push(`only ${total} unique lines (need ${min})`);
  return {total, byCat, problems, files: files.length};
}

// node dialogue.mjs  -> the validation report
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const r = validate();
  for (const [k, v] of Object.entries(r.byCat).sort()) console.log(`${String(v).padStart(5)}  ${k}`);
  console.log(`${String(r.total).padStart(5)}  unique lines in ${r.files} files`);
  console.log(r.problems.length ? `${r.problems.length} problems:\n  ` + r.problems.slice(0, 50).join('\n  ') : 'valid');
  process.exitCode = r.problems.length ? 1 : 0;
}
