import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {check, findSecrets, gitCommands, addedLines} from './.claude/hooks/guard-secrets.mjs';

// Fake secrets are built at run time so this file itself never contains one.
const fakePat = 'github' + '_pat_' + 'A1b2C3'.repeat(8);
const fakeKeypair = '[' + Array.from({length: 64}, (_, i) => (i * 7) % 256).join(',') + ']';
const fakeHelius = 'https://mainnet.helius-rpc.com/?api' + '-key=' + '9a8b7c6d-1234-4abc-8def-0123456789ab';

test('the secret guard spots keys, keypairs and tokens, but not test values or public addresses', () => {
  const L = (text) => ({file: 'x.mjs', line: 1, text});
  assert.equal(findSecrets([L(`const t = '${fakePat}';`)])[0].what, 'a GitHub token');
  assert.equal(findSecrets([L(`WALLET = ${fakeKeypair}`)])[0].what, 'a Solana keypair (64-number array)');
  assert.equal(findSecrets([L(`RPC_URL=${fakeHelius}`)])[0].what, 'an API key in a URL');
  assert.equal(findSecrets([L('DASHBOARD_TOKEN=' + 'q7Rz'.repeat(8))])[0].what, 'a secret setting with a value');
  assert.equal(findSecrets([L('TWILIO_AUTH_TOKEN: "' + 'af39'.repeat(8) + '"')])[0].what, 'a secret setting with a value', 'hex token without a 0 is still a secret');
  assert.equal(findSecrets([L("DASHBOARD_TOKEN: 'dashboard-test-token-24-characters'")]).length, 0, 'test value');
  assert.equal(findSecrets([L("export const TOKEN = 'Token" + "kegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';")]).length, 0, 'the public token program address');
  assert.equal(findSecrets([L(`const t = '${fakePat}'; // guard:allow`)]).length, 0, 'opt-out comment');
  assert.equal(findSecrets([L('const t = "' + 'sw' + 'pat_' + 'Zx9Q'.repeat(9) + '";')])[0].what, 'a SignalWire token');
  assert.equal(findSecrets([L('x = ' + 'P' + 'T' + 'ab12'.repeat(12))])[0].what, 'a SignalWire token');
  // phone numbers only matter in the public repo, and 555 numbers are examples
  const phone = '+1' + '863' + '4' + '120' + '987';
  assert.equal(findSecrets([L(`OWNER_PHONE=${phone}`)]).length, 0);
  assert.equal(findSecrets([L(`OWNER_PHONE=${phone}`)], {isPublic: true})[0].what, 'a phone number');
  assert.equal(findSecrets([L('OWNER_PHONE=+15551234567')], {isPublic: true}).length, 0);
});

test('the secret guard follows cd and git -C, and reads diffs', () => {
  assert.deepEqual(gitCommands('cd /a/b && git add -A && git commit -m "x y" && git push origin HEAD:main', '/tmp').map((c) => [c.dir, c.sub]),
    [['/a/b', 'add'], ['/a/b', 'commit'], ['/a/b', 'push']]);
  assert.deepEqual(gitCommands('git -C ../r commit -m x; ls | grep git', '/w/x').map((c) => [c.dir, c.sub]), [['/w/r', 'commit']]);
  assert.deepEqual(gitCommands('git status && git log', '/w'), []);
  assert.deepEqual(addedLines('+++ b/f.mjs\n@@ -1,0 +5,2 @@\n+one\n+two\n-gone'), [{file: 'f.mjs', line: 5, text: 'one'}, {file: 'f.mjs', line: 6, text: 'two'}]);
});

test('the secret guard blocks a commit or push that would put a key into git, and lets clean ones through', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')), g = (...a) => execFileSync('git', ['-C', dir, ...a], {stdio: 'ignore'});
  try {
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n'); fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;\n');
    g('add', '-A'); g('commit', '-qm', 'one');
    const run = (command) => check({tool_name: 'Bash', tool_input: {command}, cwd: dir});
    assert.equal(run('ls -la'), null, 'not a git command');
    assert.equal(run('git add -A && git commit -m two'), null, 'nothing new');
    fs.writeFileSync(path.join(dir, '.env'), 'X=1\n');
    assert.equal(run('git add -A && git commit -m two'), null, 'an ignored .env is never added');
    assert.match(run('git add -f .env'), /a \.env file in .*\.env/);
    fs.writeFileSync(path.join(dir, 'b.mjs'), `const k = '${fakePat}';\n`); // a new, untracked file
    const msg = run(`cd ${dir} && git add -A && git commit -m two`);
    assert.match(msg, /SECRET GUARD blocked/); assert.match(msg, /a GitHub token in .*b\.mjs:1 \(starts "gith…"\)/);
    assert.ok(!msg.includes(fakePat), 'never prints the secret');
    // committed already, then pushed: commits not on any remote are checked too
    g('add', '-A'); g('commit', '-qm', 'oops'); fs.rmSync(path.join(dir, 'b.mjs')); g('add', '-A'); g('commit', '-qm', 'removed');
    assert.match(run('git push origin HEAD:main'), /a GitHub token in .*b\.mjs/, 'still in the history about to be pushed');
    assert.equal(run('git commit -m three'), null, 'a commit alone is clean now');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
