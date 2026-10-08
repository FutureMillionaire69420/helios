import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Engine,sizeBuy,fractionRaw} from './engine.mjs';
import {normalize,runtimeConfig,startRuntime} from './runtime.mjs';
import {detectBuy,detectSell,config,setFetch,validateTrade,PROGRAMS,associatedTokenAddress,b58encode,b58decode,loadKeypair,signTransaction,parseTransaction,addTransferInstruction,TIP_ACCOUNTS} from './copybot.mjs';
const cfg={mode:'paper',timezone:'UTC',sizing:'proportional',multiplier:1,buySol:0.1,maxBuy:0.05,minBuy:0.005,reserve:0.02,feeBudget:0.0065,slippage:20,dailyCap:1,minLeaderUsd:50,maxAge:30,maxSellAge:300,pumpOnly:true,oneBuy:true,autoSell:true,autoCopy:true,paperBalance:0.5};
const buy=(mint='coin',sig='buy')=>({mint,sig,side:'buy',time:Date.now()/1000,pump:true,usd:300,sol:2,leaderBalanceSol:100,decimals:6});
const sell=(sold='250',before='1000',sig='sell')=>({...buy(),side:'sell',sig,soldRaw:sold,beforeRaw:before});
function fixture(t, overrides={}, conf={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'decu-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const adapter={balance:async()=>0.5,tokens:async()=>1000n,build:async j=>({signature:'sig-'+j.sig,bytes:'test',blockhash:'test'}),send:async j=>({status:'confirmed',rawDelta:j.side==='buy'?'1000':(-BigInt(j.raw)).toString(),solDelta:j.side==='buy'?-j.sol:0.002}),reconcile:async()=>({status:'unresolved'}),...overrides};
  return new Engine({file:path.join(dir,'state.json'),config:{...cfg,...conf},adapter});
}
test('proportional sizing uses spendable balance and leader pre-balance',()=>{assert.equal(sizeBuy(cfg,buy(),0.5,0,0),0.00947);assert.throws(()=>sizeBuy(cfg,{...buy(),leaderBalanceSol:0},0.5,0,0),/pre-trade/);});
test('sizing caps trade, daily budget, fees, and pending reserves',()=>{assert.equal(sizeBuy({...cfg,minBuy:0.00001},{...buy(),sol:100},0.5,0,0),0.05);assert.equal(sizeBuy(cfg,buy(),0.5,0,0.995),0.005);assert.throws(()=>sizeBuy(cfg,buy(),0.5,0.47,0),/budget/);});
test('integer partial sells preserve precision above Number safe range',()=>{const held=9007199254740993000n;assert.equal(fractionRaw(held,25n,100n),held/4n);assert.equal(fractionRaw(held,200n,100n),held);});
test('duplicate signature buys exactly once',async t=>{let sends=0;const e=fixture(t,{send:async()=>{sends++;return {status:'confirmed',rawDelta:'1000',solDelta:-0.01};}});await Promise.all([e.ingest(buy()),e.ingest(buy())]);await e.idle();assert.equal(sends,1);assert.equal(e.d.positions.coin.raw,'1000');});
test('25% sell followed by full remaining exit',async t=>{const e=fixture(t);await e.ingest(buy());await e.idle();await e.ingest(sell());await e.idle();assert.equal(e.d.positions.coin.raw,'750');await e.ingest(sell('750','750','exit'));await e.idle();assert.equal(e.d.positions.coin.raw,'0');});
test('sell arriving during pending buy executes after the fill',async t=>{let release;const gate=new Promise(r=>release=r);const e=fixture(t,{send:async j=>{if(j.side==='buy'){await gate;return {status:'confirmed',rawDelta:'1000',solDelta:-0.01};}return {status:'confirmed',rawDelta:'-250',solDelta:0.002};}});await e.ingest(buy());await e.serial;await new Promise(r=>setImmediate(r));await e.ingest(sell());release();await e.idle();assert.equal(e.d.positions.coin.raw,'750');});
test('pending buy does not block another mint',async t=>{let release;const gate=new Promise(r=>release=r);const e=fixture(t,{send:async j=>{if(j.mint==='slow')await gate;return {status:'confirmed',rawDelta:'1000',solDelta:-j.sol};}});await e.ingest(buy('slow','a'));await new Promise(r=>setImmediate(r));await e.ingest(buy('fast','b'));await new Promise(r=>setTimeout(r,20));assert.equal(e.d.positions.fast.raw,'1000');release();await e.idle();});
test('failed pre-send build releases budget and allows later buy',async t=>{const e=fixture(t,{build:async()=>{throw new Error('builder unavailable');}});await e.ingest(buy());await e.idle();assert.equal(e.reserved(),0);assert.equal(e.d.daily[e.day()],0);assert.equal(e.d.positions.coin,undefined);});
test('uncertain send remains reserved and survives restart',async t=>{const e=fixture(t,{send:async()=>{throw new Error('network timeout');}});await e.ingest(buy());await e.idle();assert.equal(e.d.jobs.coin.phase,'unresolved');assert.ok(e.reserved()>0);const restored=new Engine({file:e.file,config:cfg,adapter:{...e.a,reconcile:async()=>({status:'confirmed',rawDelta:'1000',solDelta:-0.01})}});await restored.recover();await restored.idle();assert.equal(restored.d.positions.coin.raw,'1000');assert.equal(restored.reserved(),0);await restored.recover();assert.equal(restored.d.positions.coin.raw,'1000');});
test('recovery releases an intent that crashed before signing',async t=>{const e=fixture(t);e.d.jobs.coin={...buy(),mint:'coin',side:'buy',phase:'building',day:e.day(),sol:0.01,reserveSol:0.016};e.d.daily[e.day()]=0.01;e.save();await e.recover();assert.equal(e.reserved(),0);assert.equal(e.d.daily[e.day()],0);});
test('pause stops buys but permits exits',async t=>{const e=fixture(t);await e.ingest(buy());await e.idle();e.pause(true);await e.ingest(buy('other','other'));await e.ingest(sell());await e.idle();assert.equal(e.d.positions.other,undefined);assert.equal(e.d.positions.coin.raw,'750');});
test('stale signals and unknown sell balance skip safely',async t=>{const e=fixture(t);await e.ingest({...buy(),time:Date.now()/1000-100});await e.idle();assert.equal(e.d.positions.coin,undefined);await e.ingest(buy('coin','fresh'));await e.idle();await e.ingest(sell('5','0'));await e.idle();assert.equal(e.d.positions.coin.raw,'1000');});
test('corrupt state fails closed instead of silently starting over',t=>{const e=fixture(t);fs.writeFileSync(e.file,'broken');assert.throws(()=>new Engine({file:e.file,config:cfg,adapter:e.a}));});
test('same daily allowance stays consumed after a sale',async t=>{const e=fixture(t);await e.ingest(buy());await e.idle();const spent=e.d.daily[e.day()];await e.ingest(sell('1000','1000'));await e.idle();assert.equal(e.d.daily[e.day()],spent);});
test('parsed receipt normalization uses exact pre/post token amounts',()=>{const wallet='11111111111111111111111111111111';const row=(amount)=>({owner:wallet,mint:'coin',uiTokenAmount:{amount,decimals:6,uiAmountString:String(Number(amount)/1e6)}});const tx={blockTime:123,transaction:{signatures:['leader'],message:{accountKeys:[{pubkey:wallet,signer:true}]}},meta:{err:null,fee:5000,preBalances:[100e9],postBalances:[101e9],preTokenBalances:[row('9007199254740993000')],postTokenBalances:[row('6755399441055744750')]}};const s=normalize(tx,wallet,detectBuy,detectSell);assert.equal(s[0].beforeRaw,'9007199254740993000');assert.equal(s[0].soldRaw,'2251799813685248250');});
test('invalid config and mismatched state mode refuse startup',t=>{assert.throws(()=>runtimeConfig({...config,dailyCapSol:0.001}),/bounds/);const e=fixture(t);e.save();assert.throws(()=>new Engine({file:e.file,config:{...cfg,mode:'live'},adapter:e.a}),/mode mismatch/);});
test('base58, local signing, and tip insertion preserve message structure',()=>{const kp=loadKeypair(JSON.stringify([...Buffer.alloc(32,7)]));const pub=Buffer.from(b58decode(kp.publicKey));const sys=Buffer.from(b58decode('11111111111111111111111111111111'));const message=Buffer.concat([Buffer.from([1,0,1,2]),pub,sys,Buffer.alloc(32,9),Buffer.from([0])]);const unsigned=Buffer.concat([Buffer.from([1]),Buffer.alloc(64),message]);const tipped=addTransferInstruction(unsigned,TIP_ACCOUNTS[0],1000000);const signed=signTransaction(tipped,kp);assert.equal(parseTransaction(signed.bytes).keys[0],kp.publicKey);assert.ok(signed.bytes.length<1232);assert.deepEqual(Buffer.from(b58decode(b58encode(pub))),pub);});
test('dashboard authenticates API and exposes no signed transaction bytes',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'decu-http-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const saved={...process.env};process.env.ENGINE_STATE_FILE=path.join(dir,'engine.json');process.env.PORT='0';process.env.DASHBOARD_TOKEN='test-token-that-is-at-least-24-characters';
  const r=await startRuntime({config:{...config,logFile:path.join(dir,'log')},redact:x=>x},{demo:true});t.after(()=>{r.stop();for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
  const base='http://127.0.0.1:'+r.server.address().port;
  assert.equal((await fetch(base+'/api/status')).status,401);
  const headers={Authorization:'Bearer '+process.env.DASHBOARD_TOKEN};const data=await (await fetch(base+'/api/status',{headers})).json();assert.equal(data.mode,'demo');assert.equal(JSON.stringify(data).includes('bytes'),false);assert.equal(data.wallet.phantomBrowserVerification,true);
  const wallet=await (await fetch(base+'/api/wallet',{headers})).json();assert.equal(wallet.phantomBrowserVerification,true);assert.equal(wallet.autonomous,false);
  assert.equal((await fetch(base+'/api/autocopy/on',{method:'POST',headers})).status,200);assert.equal(r.engine.d.autoCopy,true);
  const toggled=await (await fetch(base+'/api/status',{headers})).json();assert.equal(toggled.autoCopy,true);
  assert.equal((await fetch(base+'/api/autocopy/off',{method:'POST',headers})).status,200);assert.equal(r.engine.d.autoCopy,false);
  assert.equal((await fetch(base+'/api/pause',{method:'POST',headers})).status,200);assert.equal(r.engine.d.paused,true);assert.equal((await fetch(base+'/')).status,200);
});

function guardFixture() {
 const kp=loadKeypair(JSON.stringify([...Buffer.alloc(32,17)])),mint=b58encode(Buffer.alloc(32,19));
 const ata=associatedTokenAddress(kp.publicKey,mint,PROGRAMS.TOKEN),ata22=associatedTokenAddress(kp.publicKey,mint,PROGRAMS.TOKEN_2022);
 const keys=[kp.publicKey,mint,ata,ata22,PROGRAMS.PUMP,PROGRAMS.TOKEN];
 const build=(raw=250n,approve=false)=>{
  const data=Buffer.alloc(24);Buffer.from('33e685a4017f83ad','hex').copy(data);data.writeBigUInt64LE(raw,8);
  const trade=Buffer.concat([Buffer.from([4,3,0,1,2,24]),data]);
  const approval=Buffer.from([5,3,2,1,0,1,4]);
  const m=Buffer.concat([Buffer.from([1,0,2,6]),...keys.map(k=>Buffer.from(b58decode(k))),Buffer.alloc(32,9),Buffer.from([approve?2:1]),trade,...(approve?[approval]:[])]);
  return signTransaction(Buffer.concat([Buffer.from([1]),Buffer.alloc(64),m]),kp).bytes;
 };
 const token=raw=>{const b=Buffer.alloc(165);b.writeBigUInt64LE(raw,64);return {lamports:2000000,data:[b.toString('base64'),'base64'],owner:PROGRAMS.TOKEN};};
 const mock=after=>async(_url,init)=>{const req=JSON.parse(init.body);let result;
  if(req.method==='getMultipleAccounts')result={value:[{lamports:1e9},token(1000n),null]};
  else if(req.method==='simulateTransaction')result={value:{err:null,accounts:[{lamports:1.01e9},token(after),null]}};
  else throw new Error('unexpected RPC '+req.method);
  return {ok:true,json:async()=>({result})};
 };
 return {kp,mint,build,mock,job:{mint,side:'sell',raw:'250'}};
}
test('live guard validates exact sell quantity and simulated token delta',async()=>{const f=guardFixture();setFetch(f.mock(750n));try{await validateTrade(f.build(),f.job,1);}finally{setFetch(null);}});
test('live guard refuses mismatched sell amount before simulation',async()=>{const f=guardFixture();await assert.rejects(validateTrade(f.build(251n),f.job,1),/quantity mismatch/);});
test('live guard refuses token approval instructions',async()=>{const f=guardFixture();await assert.rejects(validateTrade(f.build(250n,true),f.job,1),/approval/);});
test('live guard refuses simulation that drains extra tokens',async()=>{const f=guardFixture();setFetch(f.mock(0n));try{await assert.rejects(validateTrade(f.build(),f.job,1),/token balance/);}finally{setFetch(null);}});

// ---- added: manual-sell mode, phone alerts, safe defaults ----
test('Decu auto-copy toggle mirrors buys and proportional sells, and persists across restart',async t=>{
  const e=fixture(t,{send:async j=>({status:'confirmed',rawDelta:j.side==='buy'?'1000':(-BigInt(j.raw)).toString(),solDelta:j.side==='buy'?-0.1:0.02})},{autoCopy:false,autoSell:false});
  await e.ingest(buy('off','off-buy')); await e.idle(); assert.equal(e.d.positions.off,undefined);
  e.autoCopy(true); await e.ingest(buy('coin','on-buy')); await e.idle(); assert.equal(e.d.positions.coin.raw,'1000');
  await e.ingest(sell('250','1000','on-sell')); await e.idle(); assert.equal(e.d.positions.coin.raw,'750');
  const restored=new Engine({file:e.file,config:{...cfg,autoCopy:false,autoSell:false},adapter:e.a});
  assert.equal(restored.d.autoCopy,true);
  restored.autoCopy(false); await restored.ingest(sell('750','750','off-sell')); await restored.idle(); assert.equal(restored.d.positions.coin.raw,'750');
});
test('auto-copy OFF never buys or sells, and reports a leader-sold alert for a held position',async t=>{
  let sells=0;const e=fixture(t,{send:async j=>{if(j.side==='sell')sells++;return {status:'confirmed',rawDelta:j.side==='buy'?'1000':(-BigInt(j.raw)).toString(),solDelta:j.side==='buy'?-0.1:0.1};}},{autoSell:false,autoCopy:true});
  await e.ingest(buy());await e.idle();assert.equal(e.d.positions.coin.raw,'1000');
  e.autoCopy(false); await e.ingest(sell('1000','1000'));await e.idle();
  assert.equal(sells,0);assert.equal(e.d.positions.coin.raw,'1000');
  assert.ok(e.d.events.some(x=>x.type==='leader-sold'&&x.mint==='coin'));
  await e.ingest({...buy('never-bought','x'),side:'sell',soldRaw:'1000',beforeRaw:'1000'});await e.idle();
  assert.ok(!e.d.events.some(x=>x.type==='leader-sold'&&x.mint==='never-bought'));
});
test('phone alerts: SOLD warning, buys, failures, unknown outcomes; paper is labelled',async()=>{
  const {alertFor}=await import('./runtime.mjs');
  const a=alertFor({type:'leader-sold',mint:'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'},'live');assert.match(a.title,/SOLD a coin you hold/);assert.equal(a.priority,5);assert.match(a.body,/will NOT sell/);
  assert.match(alertFor({type:'confirmed',side:'buy',mint:'m',solDelta:-0.1015,signature:'s'},'paper').title,/^\[PAPER\] Copied/);
  assert.match(alertFor({type:'confirmed',side:'buy',mint:'m',solDelta:-0.1015,signature:'s'},'live').title,/^Copied/);
  assert.match(alertFor({type:'failed',side:'buy',mint:'m',message:'slippage'},'live').body,/No tokens changed hands/);
  assert.equal(alertFor({type:'unresolved',signature:'s'},'live').priority,5);
  assert.equal(alertFor({type:'detected'},'live'),null);assert.equal(alertFor({type:'skip'},'live'),null);
});
test('defaults follow the user rules: fixed 0.1 SOL, auto-sell off, ~$200 paper wallet',()=>{
  const saved={...process.env};for(const k of ['SIZING_MODE','AUTO_SELL','MAX_BUY_SOL','PAPER_BALANCE_SOL'])delete process.env[k];
  try{
    const r=runtimeConfig({...config,buySol:0.1,dailyCapSol:1});
    assert.equal(r.sizing,'fixed');assert.equal(r.autoSell,false);assert.equal(r.maxBuy,0.1);assert.equal(r.paperBalance,1.65);
    assert.equal(sizeBuy(r,buy(),1.65,0,0),0.1); // a real 0.1 SOL copy, not a 0.005 SOL fee-eaten one
    assert.equal(runtimeConfig({...config,buySol:0.1,dailyCapSol:1},true).autoSell,true); // synthetic demo still shows sells
  } finally {Object.assign(process.env,saved);}
});
test('paper mode closes nothing for real but values every position at quick and after-his-sell timings',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'decu-paper-'));
  const saved={...process.env};
  Object.assign(process.env,{ENGINE_STATE_FILE:path.join(dir,'engine.json'),PORT:'0',DASHBOARD_TOKEN:'',PAPER_QUICK_SELL_SEC:'0.05',PAPER_AFTER_HIS_SELL_SEC:'0',AUTO_SELL:'false',AUTO_COPY:'false',SIZING_MODE:'fixed'});
  const alerts=[];let sent=0;
  const k={config:{...config,dryRun:true,buySol:0.1,dailyCapSol:1,logFile:path.join(dir,'log'),tipSol:0.001,priorityFeeSol:0.0005,paperLandMs:0,slippagePct:20},
    notify:async a=>{alerts.push(a);},redact:x=>x,startWatcher:()=>()=>{},
    quoteBuy:async()=>({raw:1_000_000}),quoteSell:async()=>0.13,
    sendRaw:async()=>{sent++;},getSolUsd:async()=>120};
  const r=await startRuntime(k);
  t.after(()=>{r.stop();fs.rmSync(dir,{recursive:true,force:true});for(const key of Object.keys(process.env))if(!(key in saved))delete process.env[key];Object.assign(process.env,saved);});
  r.engine.autoCopy(true);await r.engine.ingest(buy('P1','b1'));await r.engine.idle();
  assert.equal(r.engine.d.positions.P1.raw,'1000000');
  await new Promise(res=>setTimeout(res,150));
  const st=r.engine.d.paperStats.P1;assert.ok(st.exits['buy+0.05s']>0.12);
  r.engine.autoCopy(false);
  await r.engine.ingest({...sell('1000000','1000000','s1'),mint:'P1'});await r.engine.idle();
  await new Promise(res=>setTimeout(res,100));
  assert.ok(r.engine.d.paperStats.P1.exits['his-sell+0s']>0.12);
  assert.equal(r.engine.d.positions.P1.raw,'1000000'); // AUTO_SELL=false: nothing sold
  const {paperSummary}=await import('./runtime.mjs');const s=paperSummary(r.engine.d.paperStats);
  assert.equal(s.length,2);assert.ok(s.every(x=>x.trades===1&&x.wins===1));
  assert.ok(alerts.some(a=>/\[PAPER\] Copied/.test(a.title)));assert.ok(alerts.some(a=>/SOLD a coin you hold/.test(a.title)));
  assert.equal(sent,0); // paper never sends
});
