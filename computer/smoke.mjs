import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import net from 'node:net';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'decu-smoke-'));
try {
 for(let run=1;run<=2;run++) {
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const token='smoke-token-only-no-wallet-secret';let output='';
  const child=spawn(process.execPath,['copybot.mjs','demo'],{cwd:path.dirname(new URL(import.meta.url).pathname),env:{...process.env,PRIVATE_KEY:'',PORT:String(port),DASHBOARD_HOST:'127.0.0.1',DASHBOARD_TOKEN:token,ENGINE_STATE_FILE:path.join(dir,'engine.json'),LOG_FILE:path.join(dir,'events.log')}});
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const exit=new Promise(r=>child.once('exit',code=>r(code)));
  try {
   const base='http://127.0.0.1:'+port;let up=false;
   for(let i=0;i<50;i++){try{if((await fetch(base+'/health')).ok){up=true;break;}}catch{}await sleep(100);}
   assert.ok(up,'server started');const headers={Authorization:'Bearer '+token};
   const initial=await (await fetch(base+'/api/status',{headers})).json();
   const previous=initial.events.filter(e=>e.type==='confirmed').length;
   await sleep(4700);let state=await (await fetch(base+'/api/status',{headers})).json();
   assert.equal(state.mode,'demo');assert.equal(state.jobs.length,0);assert.ok(state.events.some(e=>e.type==='confirmed'&&e.side==='buy'));assert.ok(state.events.some(e=>e.type==='confirmed'&&e.side==='sell'));
   assert.ok(Object.values(state.positions).every(p=>p.raw==='0'),'full demo exit left no tokens');
   assert.equal(state.events.filter(e=>e.type==='confirmed').length,previous+3,'this run generated a fresh buy and two fresh sells');
   assert.equal((await fetch(base+'/api/status')).status,401);
   await fetch(base+'/api/pause',{method:'POST',headers});state=await (await fetch(base+'/api/status',{headers})).json();assert.equal(state.paused,true);
   await fetch(base+'/api/resume',{method:'POST',headers});
   console.log(`PASS demo run ${run}: started, bought, sold 25%, exited remainder, token auth, pause/resume${run===2?', reused persisted state':''}`);
  } catch(error) {console.error(output);throw error;} finally {child.kill('SIGTERM');await exit;}
 }
} finally {fs.rmSync(dir,{recursive:true,force:true});}
