// TEST GUARD, loaded into every test file's process by `npm test` (node --import ./test-guard.mjs --test ...):
// 1. Each test file runs in its own empty temporary folder, deleted afterwards. A file a test writes by default
//    (paper journal, brain memory, notes, state) lands there, never in the project folder, and a .env in the
//    project folder can't change what the tests see.
// 2. A test file whose tests are done but which keeps running (an open server, socket or timer) fails after 5 s
//    and names what is still open, instead of hanging the whole run.
import {after} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

if (process.env.NODE_TEST_CONTEXT) { // set by the test runner in each test file's own process only
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decu-test-'));
  process.chdir(dir);
  process.on('exit', () => { try { process.chdir(os.tmpdir()); fs.rmSync(dir, {recursive: true, force: true}); } catch { /* best effort */ } });
  after(() => {
    setTimeout(() => {
      process.stderr.write(`test-guard: ${path.basename(process.argv[1] || 'test file')} finished its tests but is still running (open: ${process.getActiveResourcesInfo().join(', ') || 'unknown'}). Close servers, sockets and timers in t.after().\n`);
      process.exit(1);
    }, 5000).unref();
  });
}
