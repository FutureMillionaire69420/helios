import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { tradeNote, dailyNote, homeNote, patternNote, createVault, zipFiles, createGitSync, safeName, tradeNoteName, delayWords } from './vault.mjs';
import { createThinkingBrain } from './brain.mjs';
import { createBrain } from './learn.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'vault-'));
const rec = (i, o = {}) => ({ time: new Date(Date.parse('2026-10-25T21:05:00Z') + i * 600e3).toISOString(), mint: `Mint${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump`, symbol: `PRES${i}`, mode: 'paper', fcat: 0.18, fcatExit: '15s mark', entryGap: 0.032, delaySec: 2.2,
  latency: { blocksAfter: 5 }, hisSol: 10, hisUsd: 1000, cost: 0.103, buyFeeSol: 0.003, sellFeeSol: 0.003, hisPrice: 1e-7, entryPrice: 1.032e-7, exitPrice: 1.25e-7, pcat: 0.25, taken: true, curve: [0, 0.1, 0.2],
  thinking: ['Prediction before the result: +4.3% → actual +18.1%: RIGHT.', 'Matched confirmed pattern ▲ "market cap $30-100k" (+1.3% avg) → it held again.'], prediction: { fcat: 0.043, right: true }, crowd: { trades: 0, place: 1, exact: false }, shape: 'late runner', ...o });

test('a trade note: front matter with the numbers, the thinking, what happened, linked patterns and day', () => {
  const r = rec(1), md = tradeNote(r, { mirror: { perfectUsd: 2.83, yourUsd: 2.43, delayUsd: -0.4, feesUsd: 0.61, afterFeesUsd: 1.82, fcatUsd: 2.46, pcatUsd: 3.14, rulesUsd: 2.46 }, matched: [{ label: 'market cap $30-100k' }] });
  assert.match(md, /^---\ntype: "trade"\ncoin: "\$PRES1"/);
  assert.match(md, /fcat: 0\.18\nwon: true/); assert.match(md, /place_in_line: 1/); assert.match(md, /prediction_right: true/);
  assert.match(md, /## What I thought before the result\n- Prediction before the result/);
  assert.match(md, /\[\[patterns\/market cap \$30-100k\|market cap \$30-100k\]\]/);
  assert.match(md, /Back to \[\[daily\/2026-10-25\|2026-10-25\]\]/);
  assert.match(md, /Decu perfect \$10: \+\$2\.83/);
  assert.equal(safeName('a/b:c*?"<>|#^[x]'), 'abcx'); assert.equal(tradeNoteName(r), '2026-10-25 2115 $PRES1');
});

test('daily, pattern and home notes link everything together', () => {
  const rs = [rec(1), rec(2, { fcat: -0.1 }), rec(3, { taken: false, skipReason: 'premium' })];
  const d = dailyNote('2026-10-25', rs, { decisions: [{ time: '2026-10-25T22:00:00Z', kind: 'tune', text: 'stop 20 → 25' }], rank: 'Bronze', bankrollUsd: 987 });
  assert.match(d, /trades: 2\nwon: 1/); assert.match(d, /\[\[trades\/2026-10-25 2115 \$PRES1\|\$PRES1\]\]/); assert.match(d, /\*\*tune\*\*: stop 20 → 25/);
  const p = patternNote({ label: 'market cap $30-100k', status: 'confirmed', trades: 20, wins: 12, avgFcat: 0.013 }, rs);
  assert.match(p, /status: "confirmed"/); assert.match(p, /\$PRES1/);
  const h = homeNote({ status: { rank: { name: 'Bronze', index: 1, of: 7, bankrollUsd: 987 }, goal: { usd: 1000, profitUsd: -13 }, patterns: [{ label: 'market cap $30-100k', status: 'confirmed', wins: 12, trades: 20 }] }, records: rs });
  assert.match(h, /\[\[daily\/2026-10-25\|2026-10-25\]\]/); assert.match(h, /\[\[machine\/findings/); assert.match(h, /Rank:\*\* Bronze/);
});

test('the vault writes only what changed and never writes your human/ folder', () => {
  const dir = tmp(), v = createVault(dir);
  assert.deepEqual(v.sync({ 'Home.md': 'a', 'machine/x.md': 'b', 'human/mine.md': 'NO' }).sort(), ['Home.md', 'human/README.md', 'machine/x.md']);
  assert.equal(fs.existsSync(path.join(dir, 'human/mine.md')), false, 'the bot never writes human/');
  fs.writeFileSync(path.join(dir, 'human/README.md'), 'my own words');
  assert.deepEqual(v.sync({ 'Home.md': 'a', 'machine/x.md': 'b2' }), ['machine/x.md'], 'unchanged files are not rewritten');
  assert.equal(fs.readFileSync(path.join(dir, 'human/README.md'), 'utf8'), 'my own words', 'your edits stay');
  assert.deepEqual(v.list(), ['Home.md', 'human/README.md', 'machine/x.md']);
});

test('the zip opens: every entry inflates back to its file', () => {
  const z = zipFiles([{ name: 'Decu Brain/Home.md', data: Buffer.from('# Home ✓') }, { name: 'Decu Brain/machine/x.md', data: Buffer.from('x'.repeat(5000)) }]);
  assert.equal(z.readUInt32LE(0), 0x04034b50);
  const nameLen = z.readUInt16LE(26), size = z.readUInt32LE(18), name = z.subarray(30, 30 + nameLen).toString();
  assert.equal(name, 'Decu Brain/Home.md');
  assert.equal(zlib.inflateRawSync(z.subarray(30 + nameLen, 30 + nameLen + size)).toString(), '# Home ✓');
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50); assert.equal(z.readUInt16LE(z.length - 12), 2, 'two entries');
});

test('GitHub sync: an empty private repo is started, then ONE commit per sync; the token never leaks', async () => {
  const TOKEN = 'test-token-' + 'v'.repeat(30), calls = []; let hasMain = false, n = 0;
  const fake = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', auth: init.headers?.Authorization });
    const j = (status, body) => ({ status, json: async () => body });
    if (/\/git\/ref\/heads\/main$/.test(url)) return hasMain ? j(200, { object: { sha: 'c0' } }) : j(409, { message: 'Git Repository is empty.' });
    if (/\/contents\/README\.md$/.test(url)) { hasMain = true; return j(201, {}); }
    if (/\/git\/commits\/c0$/.test(url)) return j(200, { tree: { sha: 't0' } });
    if (/\/git\/blobs$/.test(url)) return j(201, { sha: `b${++n}` });
    if (/\/git\/trees$/.test(url)) { assert.equal(JSON.parse(init.body).base_tree, 't0'); return j(201, { sha: 't1' }); }
    if (/\/git\/commits$/.test(url)) return j(201, { sha: 'c1' });
    if (/\/git\/refs\/heads\/main$/.test(url)) { assert.equal(JSON.parse(init.body).sha, 'c1'); return j(200, {}); }
    return j(500, { message: `boom ${TOKEN}` });
  };
  const g = createGitSync({ token: TOKEN, repo: 'me/decu-brain', fetchImpl: fake });
  assert.equal(g.repo, 'me/decu-brain'); assert.equal(g.branch, 'main');
  assert.equal(await g.push([{ name: 'Home.md', data: Buffer.from('a') }, { name: 'machine/daily/2026-10-25.md', data: Buffer.from('b') }]), 'pushed 2 files');
  assert.equal(calls.filter((c) => /\/git\/blobs$/.test(c.url)).length, 0, 'notes are text: sent inside the tree, no upload call each');
  assert.ok(calls.every((c) => c.auth === `Bearer ${TOKEN}` && !c.url.includes(TOKEN)));
  assert.equal(calls.filter((c) => /\/git\/commits$/.test(c.url)).length, 1, 'one commit');
  await g.push([{ name: 'Home.md', data: Buffer.from('c') }, { name: 'machine/charts/x.png', data: Buffer.from([137, 80, 78, 71]) }]);
  assert.equal(calls.filter((c) => /\/git\/blobs$/.test(c.url)).length, 1, 'a picture is uploaded on its own');
  const bad = createGitSync({ token: TOKEN, repo: 'me/x', fetchImpl: async () => ({ status: 500, json: async () => ({}) }) });
  const r = await bad.push([{ name: 'a.md', data: Buffer.from('a') }]);
  assert.match(r, /^failed/); assert.ok(!r.includes(TOKEN)); assert.equal(bad.status().ok, false);
  assert.equal(createGitSync({ token: '', repo: 'me/x' }), null, 'no token, no sync');
});

test('the brain writes its thinking as notes after every bought trade, and the whole vault downloads as a zip', async () => {
  const dir = tmp(), records = [], learn = createBrain({ buySol: 0.1 });
  const rules = { maxPayPct: 15, stopLossPct: 20, gainGatePct: 15 };
  const pushed = [];
  const gitSync = { push: async (files) => { pushed.push(...files.map((f) => f.name)); return `pushed ${files.length} files`; }, status: () => null };
  const b = createThinkingBrain({ file: path.join(dir, 'mem.json'), study: { records, brain: learn }, mode: 'paper', rules, defaults: { ...rules }, solUsd: () => 100, vaultDir: path.join(dir, 'vault'), gitSync, vaultSyncMin: 0 });
  const r = rec(1); records.push(r); learn.observe(r, records, { silent: true }); b.onTrade(r);
  const v = path.join(dir, 'vault');
  assert.ok(fs.existsSync(path.join(v, 'machine/trades/2026-10-25 2115 $PRES1.md')), 'the trade note');
  assert.ok(fs.existsSync(path.join(v, 'machine/daily/2026-10-25.md')) && fs.existsSync(path.join(v, 'Home.md')) && fs.existsSync(path.join(v, 'machine/decisions.md')));
  assert.match(fs.readFileSync(path.join(v, 'machine/trades/2026-10-25 2115 $PRES1.md'), 'utf8'), /What I thought before the result/);
  assert.equal(await b.pushVault() !== null, true);
  assert.ok(pushed.includes('Home.md') && pushed.some((p) => p.startsWith('machine/trades/')), 'the changed notes go to GitHub');
  assert.equal(await b.pushVault(), null, 'nothing new: nothing pushed');
  const z = b.vaultZip(); assert.equal(z.readUInt32LE(0), 0x04034b50);
  assert.ok(z.includes(Buffer.from('Decu Brain/Home.md')));
  assert.ok(b.vaultStatus().files >= 5);
  b.stop();
});

test('first GitHub sync: the whole vault goes up once per repository, pictures 30 per push; after that only changes', async () => {
  const dir = tmp(), v = path.join(dir, 'vault'), rules = { maxPayPct: 15, stopLossPct: 20, gainGatePct: 15 };
  // a vault written before GitHub was set up: notes and 40 chart pictures already on disk
  fs.mkdirSync(path.join(v, 'machine/charts'), { recursive: true }); fs.mkdirSync(path.join(v, 'machine/trades'), { recursive: true });
  for (let i = 0; i < 40; i++) fs.writeFileSync(path.join(v, `machine/charts/c${i}.png`), Buffer.from([137, 80, 78, 71, i]));
  fs.writeFileSync(path.join(v, 'machine/trades/old trade.md'), '# an old trade');
  const pushes = [];
  const gitSync = (repo) => ({ repo, branch: 'main', maxBlobs: 30, status: () => null, push: async (files) => { pushes.push(files.map((f) => f.name)); return `pushed ${files.length} files`; } });
  const brain = (repo) => createThinkingBrain({ file: path.join(dir, 'mem.json'), study: { records: [], brain: createBrain({ buySol: 0.1 }) }, mode: 'paper', rules, defaults: { ...rules }, solUsd: () => 100, vaultDir: v, gitSync: gitSync(repo), vaultSyncMin: 0 });
  let b = brain('me/decu-brain');
  await b.pushVault();
  assert.ok(pushes[0].includes('machine/trades/old trade.md'), 'notes written before the sync existed go up too');
  assert.equal(pushes[0].filter((p) => p.endsWith('.png')).length, 30, 'at most 30 pictures in one push');
  await b.pushVault();
  assert.equal(pushes[1].filter((p) => p.endsWith('.png')).length, 10, 'the rest in the next push');
  assert.equal(await b.pushVault(), null, 'all up: nothing left');
  b.stop();
  b = brain('me/decu-brain'); // a restart: already uploaded to this repository
  const before = pushes.length; await b.pushVault();
  const again = pushes.slice(before).flat();
  assert.ok(!again.includes('machine/trades/old trade.md') && !again.some((p) => p.endsWith('.png')), 'not uploaded again: only notes that changed (Home carries its update time)');
  b.stop();
  b = brain('me/another-repo'); // a new repository gets everything once
  await b.pushVault();
  assert.ok(pushes.at(-1).includes('machine/trades/old trade.md'));
  b.stop();
});

test("the bot's own guides (changes, going live, Obsidian setup) are written into the vault and synced", async () => {
  const dir = tmp(), rules = { maxPayPct: 15, stopLossPct: 20, gainGatePct: 15 }, pushed = [];
  fs.writeFileSync(path.join(dir, 'CHANGES.md'), '## v9: something new');
  const b = createThinkingBrain({ file: path.join(dir, 'mem.json'), study: { records: [], brain: createBrain({ buySol: 0.1 }) }, mode: 'paper', rules, defaults: { ...rules }, solUsd: () => 100, vaultDir: path.join(dir, 'vault'), vaultSyncMin: 0,
    docs: [{ path: 'Bot/Changes.md', file: path.join(dir, 'CHANGES.md') }, { path: 'Bot/Missing.md', file: path.join(dir, 'nope.md') }],
    gitSync: { repo: 'me/b', branch: 'main', status: () => null, push: async (files) => { pushed.push(...files.map((f) => f.name)); return 'pushed'; } } });
  assert.equal(fs.readFileSync(path.join(dir, 'vault/Bot/Changes.md'), 'utf8'), '## v9: something new');
  assert.ok(!fs.existsSync(path.join(dir, 'vault/Bot/Missing.md')), 'a guide that is not shipped is skipped');
  await b.pushVault(); assert.ok(pushed.includes('Bot/Changes.md'));
  b.stop();
});

test('GitHub sync: when another writer moved the branch meanwhile (422), the commit is rebuilt on the newest one', async () => {
  let head = 'c0', patches = 0, blobs = 0;
  const fake = async (url, init = {}) => {
    const j = (status, body) => ({ status, json: async () => body });
    if (/\/git\/ref\/heads\/main$/.test(url)) return j(200, { object: { sha: head } });
    if (/\/git\/commits\/c\d$/.test(url)) return j(200, { tree: { sha: 't-' + url.slice(-2) } });
    if (/\/git\/blobs$/.test(url)) { blobs++; return j(201, { sha: 'b1' }); }
    if (/\/git\/trees$/.test(url)) return j(201, { sha: 'tree-on-' + JSON.parse(init.body).base_tree });
    if (/\/git\/commits$/.test(url)) return j(201, { sha: 'new-on-' + JSON.parse(init.body).parents[0] });
    if (/\/git\/refs\/heads\/main$/.test(url)) {
      patches++;
      if (patches === 1) { head = 'c7'; return j(422, { message: 'Update is not a fast forward' }); } // the duel pushed first
      assert.equal(JSON.parse(init.body).sha, 'new-on-c7', 'rebuilt on the newest commit'); return j(200, {});
    }
    return j(500, {});
  };
  const g = createGitSync({ token: 'test-token-' + 'x'.repeat(30), repo: 'me/b', fetchImpl: fake });
  assert.equal(await g.push([{ name: 'Home.md', data: Buffer.from('a') }, { name: 'c.png', data: Buffer.from([1]) }]), 'pushed 2 files');
  assert.equal(patches, 2); assert.equal(blobs, 1, 'the picture is not uploaded twice');
});

test('the delay in words: a cost says "cost you", a gain says "helped", and the front matter number is the cost', () => {
  assert.equal(delayWords(-0.4), 'the delay cost you $0.40');
  assert.equal(delayWords(1.95), 'the delay helped +$1.95');
  assert.equal(delayWords(0.001), 'the delay cost nothing');
  const mirror = (d) => ({ perfectUsd: 2, yourUsd: 2 + d, delayUsd: d, feesUsd: 0.5, afterFeesUsd: 1.5 + d, fcatUsd: 2, pcatUsd: 2, rulesUsd: 2 });
  const lost = tradeNote(rec(1), { mirror: mirror(-0.4) }), helped = tradeNote(rec(2), { mirror: mirror(1.95) });
  assert.match(lost, /delay_cost_usd: 0\.4\n/); assert.match(lost, /the delay cost you \$0\.40/);
  assert.match(helped, /delay_cost_usd: -1\.95\n/); assert.match(helped, /the delay helped \+\$1\.95/); assert.doesNotMatch(helped, /delay cost \+/);
  const day = dailyNote('2026-10-25', [rec(1), rec(2)], { mirrorOf: (r) => mirror(r === undefined ? 0 : r.symbol === 'PRES1' ? -0.4 : 1.95) });
  assert.match(day, /the delay helped \+\$1\.55/); assert.match(day, /delay_cost_usd: -1\.55/);
});
