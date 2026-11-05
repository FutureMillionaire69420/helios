#!/usr/bin/env node
// SECRET GUARD: a Claude Code PreToolUse hook on Bash (see .claude/settings.json).
// Before a `git add`, `git commit` or `git push` runs, it checks everything that command could put into
// git: changed and new files, and commits not yet on GitHub. If it finds a key, token, private key,
// wallet keypair or a .env file, it blocks the command (exit 2) and says where; it never prints the secret.
// In the PUBLIC repo (helios) it also blocks real phone numbers. Keys belong in Render → Environment.
// A harmless example line can opt out with the comment  guard:allow  on that line.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export const PUBLIC_REMOTES = [/futuremillionaire69420\/helios/i];
export const PATTERNS = [
  ['a GitHub token', /\b(?:github_pat_[A-Za-z0-9_]{30,}|gh[pousr]_[A-Za-z0-9]{30,})\b/],
  ['a private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a Solana keypair (64-number array)', /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/],
  ['an API key in a URL', /api[-_]?key=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i],
  ['a Twilio API key', /\bSK[0-9a-f]{32}\b/],
  ['a secret setting with a value', /\b[A-Z0-9_]*(?:PRIVATE_KEY|SECRET|TOKEN|API_KEY|AUTH|PASSWORD|SEED|MNEMONIC)[A-Z0-9_]*\s*[=:]\s*['"]?([A-Za-z0-9_\-+/]{20,})/, (v) =>
    // not secrets: test/example values, and public Solana addresses such as the token program (base58, 32-44 chars)
    /test|example|dummy|fake|placeholder|your[-_]/i.test(v) || isAddress(v)],
];
/** A Solana address: base58 that decodes to exactly 32 bytes (a random 32-char token does not). */
export function isAddress(v) {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return false;
  let n = 0n; for (const ch of v) n = n * 58n + BigInt(A.indexOf(ch));
  let bytes = 0; while (n > 0n) { n >>= 8n; bytes++; }
  for (const ch of v) { if (ch !== '1') break; bytes++; } // leading 1s are zero bytes
  return bytes === 32;
}
export const PUBLIC_PATTERNS = [
  ['a phone number', /\+1(?!555)[2-9]\d{2}(?!555)[2-9]\d{6}\b/], // 555 numbers are fictional examples
  ['a phone number', /\(?\b(?!555)[2-9]\d{2}\)?[-. ](?!555)[2-9]\d{2}[-. ]\d{4}\b/],
];
const ENV_FILE = /(^|\/)\.env(\.(?!example$)[^/]+)?$/;

/** Secrets in some lines. lines = [{file, line, text}]. Returns [{what, file, line, hint}]. */
export function findSecrets(lines, { isPublic = false } = {}) {
  const pats = isPublic ? [...PATTERNS, ...PUBLIC_PATTERNS] : PATTERNS, out = [];
  for (const l of lines) {
    if (/guard:allow/.test(l.text)) continue;
    for (const [what, re, harmless] of pats) { const m = l.text.match(re); if (m && !(harmless && harmless(m[1] || m[0]))) { out.push({ what, file: l.file, line: l.line, hint: m[0].slice(0, 4) + '…' }); break; } }
  }
  return out;
}

/** Added lines of a unified diff (-U0) with file and line numbers. */
export function addedLines(diff) {
  const out = []; let file = null, n = 0;
  for (const t of String(diff).split('\n')) {
    if (t.startsWith('+++ ')) { file = t.slice(4).replace(/^b\//, ''); continue; }
    const h = t.match(/^@@ -\S+ \+(\d+)/); if (h) { n = Number(h[1]); continue; }
    if (t.startsWith('+') && file) out.push({ file, line: n++, text: t.slice(1) });
  }
  return out;
}

/** The git commands in a shell line, each with the folder it runs in (follows `cd X &&` and `git -C X`). */
export function gitCommands(command, cwd) {
  const out = []; let dir = cwd;
  for (const seg of String(command).split(/&&|\|\||;|\n|\|/)) {
    const s = seg.trim(), unq = (x) => x.replace(/^['"]|['"]$/g, '');
    const cd = s.match(/^cd\s+(\S+)/); if (cd) { dir = path.resolve(dir, unq(cd[1])); continue; }
    const g = s.match(/(?:^|\s)git\s+(?:-C\s+(\S+)\s+)?(add|commit|push)\b(.*)$/); if (!g) continue;
    out.push({ dir: g[1] ? path.resolve(dir, unq(g[1])) : dir, sub: g[2], args: g[3].trim().split(/\s+/).filter(Boolean) });
  }
  return out;
}

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });

/** Everything this command could put into git, as lines, plus .env files it would add. */
function candidates(dir, sub, chain) {
  const lines = [], envFiles = [];
  // tracked changes (staged or not) and new files git would add: a chain like `git add -A && git commit` adds them first
  lines.push(...addedLines(git(dir, ['diff', 'HEAD', '-U0', '--no-color', '--no-ext-diff'])));
  for (const f of git(dir, ['diff', 'HEAD', '--name-only']).split('\n').filter(Boolean)) if (ENV_FILE.test(f)) envFiles.push(f);
  for (const f of git(dir, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean)) {
    if (ENV_FILE.test(f)) { envFiles.push(f); continue; }
    let buf; try { const p = path.join(dir, f), st = fs.statSync(p); if (!st.isFile() || st.size > 2 << 20) continue; buf = fs.readFileSync(p); } catch { continue; }
    if (buf.includes(0)) continue; // binary
    buf.toString('utf8').split('\n').forEach((text, i) => lines.push({ file: f, line: i + 1, text }));
  }
  if (sub === 'push' || chain.some((c) => c.sub === 'push')) {
    let log = ''; try { log = git(dir, ['log', '-p', '-U0', '--no-color', '--format=', 'HEAD', '--not', '--remotes']); } catch { /* no remote yet */ }
    lines.push(...addedLines(log));
  }
  return { lines, envFiles };
}

export function check(input) {
  const cmd = input?.tool_input?.command || '';
  if (!/\bgit\b/.test(cmd)) return null;
  const chain = gitCommands(cmd, input.cwd || process.cwd());
  const problems = [];
  for (const c of chain) {
    if (c.sub === 'add') for (const a of c.args) if (!a.startsWith('-') && ENV_FILE.test(a.replace(/^['"]|['"]$/g, ''))) problems.push({ what: 'a .env file', file: a, line: 0, hint: '' });
  }
  const seen = new Set();
  for (const c of chain) {
    let top; try { top = git(c.dir, ['rev-parse', '--show-toplevel']).trim(); } catch { continue; }
    if (seen.has(top)) continue; seen.add(top);
    let remote = ''; try { remote = git(top, ['remote', 'get-url', 'origin']); } catch { /* none */ }
    const isPublic = PUBLIC_REMOTES.some((re) => re.test(remote));
    const { lines, envFiles } = candidates(top, c.sub, chain);
    for (const f of envFiles) problems.push({ what: 'a .env file', file: f, line: 0, hint: '' });
    for (const p of findSecrets(lines, { isPublic })) problems.push({ ...p, repo: path.basename(top) + (isPublic ? ' (PUBLIC)' : '') });
  }
  if (!problems.length) return null;
  const list = problems.slice(0, 8).map((p) => `- ${p.what} in ${p.repo ? p.repo + '/' : ''}${p.file}${p.line ? `:${p.line}` : ''}${p.hint ? ` (starts "${p.hint}")` : ''}`);
  return ['SECRET GUARD blocked this git command. Found:', ...list, problems.length > 8 ? `- …and ${problems.length - 8} more` : null,
    'Keys and tokens belong in Render → Environment, never in git. Remove them (or unstage the file).',
    'If a line is a harmless example, add the comment guard:allow on that line. Never print the secret itself.'].filter(Boolean).join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  let raw = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let msg = null;
    try { msg = check(JSON.parse(raw || '{}')); } catch (e) { process.stderr.write(`secret guard could not check (${e.message}); not blocking.\n`); process.exit(0); }
    if (msg) { process.stderr.write(msg + '\n'); process.exit(2); }
    process.exit(0);
  });
}
