import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {Engine} from './engine.mjs';
import {PUMP_TOKEN,QUOTES} from './solscan.mjs';

const val = (key, fallback) => process.env[key]?.trim() || fallback;
const number = (key, fallback) => Number(val(key,String(fallback)));
export function runtimeConfig(c, demo=false) {
  const out = {mode:demo?'demo':c.dryRun?'paper':'live', timezone:c.timezone,
    sizing:val('SIZING_MODE','fixed'), multiplier:number('COPY_MULTIPLIER',1),
    buySol:c.buySol, maxBuy:number('MAX_BUY_SOL',c.buySol), minBuy:number('MIN_BUY_SOL',0.005),
    reserve:c.minSolReserve, feeBudget:c.tipSol+c.priorityFeeSol+0.005,
    slippage:c.slippagePct, dailyCap:c.dailyCapSol, minLeaderUsd:c.minLeaderBuyUsd,
    maxAge:c.maxSignalAgeSec, maxSellAge:number('MAX_SELL_SIGNAL_AGE_SEC',300), pumpOnly:c.pumpOnly,
    oneBuy:c.oneBuyPerMint, autoSell:val('AUTO_SELL',demo?'true':'false')==='true',paperBalance:number('PAPER_BALANCE_SOL',1.65)};
  for (const k of ['multiplier','buySol','maxBuy','minBuy','reserve','feeBudget','slippage','dailyCap','minLeaderUsd','maxAge','maxSellAge','paperBalance'])
    if (!Number.isFinite(out[k]) || out[k]<0) throw new Error('invalid setting '+k);
  if (!['fixed','proportional'].includes(out.sizing) || out.minBuy<=0 || out.minBuy>out.maxBuy || out.maxBuy>out.dailyCap || out.multiplier>1) throw new Error('invalid sizing bounds (multiplier must be 0–1)');
  return out;
}

export function normalize(tx, leader, detectBuy, detectSell) {
  if (!tx?.meta || tx.meta.err) return [];
  const keys = tx.transaction.message.accountKeys;
  const index = keys.findIndex(k=>(typeof k==='string'?k:k.pubkey)===leader);
  if (index<0) return [];
  const pre = new Map(), post = new Map(), decimals = new Map();
  for (const [rows,map] of [[tx.meta.preTokenBalances,pre],[tx.meta.postTokenBalances,post]]) {
    for (const b of rows || []) if(b.owner===leader) {
      map.set(b.mint,(map.get(b.mint)||0n)+BigInt(b.uiTokenAmount.amount)); decimals.set(b.mint,b.uiTokenAmount.decimals);
    }
  }
  const common = {sig:tx.transaction.signatures[0],time:tx.blockTime || Date.now()/1000,leaderBalanceSol:tx.meta.preBalances[index]/1e9};
  const buy = detectBuy(tx,leader), sell = detectSell(tx,leader), result=[];
  // A transaction may both buy and sell. Preserve both sides instead of buy || sell.
  if (sell) for(const x of sell.sold) result.push({...common,side:'sell',mint:x.mint,soldRaw:((pre.get(x.mint)||0n)-(post.get(x.mint)||0n)).toString(),beforeRaw:(pre.get(x.mint)||0n).toString(),decimals:decimals.get(x.mint)});
  if (buy) {
    // Multi-mint trade allocation cannot be inferred from aggregate SOL spend.
    if (buy.bought.length===1 && buy.spentStableUsd===0) result.push({...common,side:'buy',mint:buy.bought[0].mint,sol:buy.spentSol,pump:buy.pump,decimals:decimals.get(buy.bought[0].mint)});
  }
  return result;
}

/**
 * Why a leader transaction produced no copy signal, when it is still a trade worth knowing about:
 * he paid with PUMP tokens he already held (the bot buys with SOL only), or a memecoin↔memecoin
 * swap. Returns {kind, mint} or null.
 */
export function classifyUnsupported(tx, leader) {
  if (!tx?.meta || tx.meta.err) return null;
  const keys = tx.transaction?.message?.accountKeys || [];
  const k = keys.find(x => (typeof x === 'string' ? x : x.pubkey) === leader);
  if (!k || (typeof k === 'object' && !k.signer)) return null;
  const delta = new Map();
  for (const [rows, sign] of [[tx.meta.preTokenBalances, -1n], [tx.meta.postTokenBalances, 1n]])
    for (const b of rows || []) if (b.owner === leader) delta.set(b.mint, (delta.get(b.mint) || 0n) + sign * BigInt(b.uiTokenAmount.amount));
  const coins = [...delta].filter(([m, d]) => !QUOTES.has(m) && d !== 0n);
  const pump = delta.get(PUMP_TOKEN) || 0n;
  if (pump < 0n && coins.length === 1 && coins[0][1] > 0n) return {kind: 'paid-with-pump', mint: coins[0][0]};
  if (pump > 0n && coins.length === 1 && coins[0][1] < 0n) return {kind: 'sold-for-pump', mint: coins[0][0]};
  if (coins.length === 2 && coins.some(([, d]) => d > 0n) && coins.some(([, d]) => d < 0n)) return {kind: 'token-swap', mint: coins.find(([, d]) => d > 0n)[0]};
  return null;
}

/** Phone alert (ntfy) for an engine event, or null. Paper/demo alerts are labelled so they can't be mistaken for real trades. */
export function alertFor(e, mode, leaderLabel='Decu') {
  const tag = mode==='live' ? '' : mode==='paper' ? '[PAPER] ' : '[DEMO] ';
  const short = m => (m||'').slice(0,6)+'…';
  const pump = m => 'https://pump.fun/coin/'+m, tx = s => 'https://solscan.io/tx/'+s;
  if (e.type==='leader-sold') return {title:`${tag}${leaderLabel} SOLD a coin you hold`, body:`He is selling ${short(e.mint)}. The bot will NOT sell (AUTO_SELL=false).\nSell by hand in Axiom/Phantom if you want out.\nToken: ${e.mint}`, priority:5, tags:['rotating_light'], click:pump(e.mint)};
  if (e.type==='confirmed' && e.side==='buy') return {title:`${tag}Copied ${leaderLabel}: bought ${short(e.mint)}`, body:`Spent ${(-e.solDelta).toFixed(4)} SOL incl. fees\nToken: ${e.mint}`, priority:mode==='live'?5:3, tags:['white_check_mark'], click:mode==='live'?tx(e.signature):pump(e.mint)};
  if (e.type==='confirmed' && e.side==='sell') return {title:`${tag}Sold ${short(e.mint)}`, body:`Received ${Number(e.solDelta).toFixed(4)} SOL after fees\nToken: ${e.mint}`, priority:4, tags:['moneybag'], click:mode==='live'?tx(e.signature):pump(e.mint)};
  if (e.type==='failed') return {title:`${tag}Trade FAILED (${e.side})`, body:`${e.message||'unknown error'}\nToken: ${e.mint}\nNo tokens changed hands.`, priority:4, tags:['x'], click:pump(e.mint)};
  if (e.type==='unresolved') return {title:`${tag}Trade outcome UNKNOWN`, body:`${e.message||''}\nThe bot keeps checking and will not double-trade.\nTx: ${e.signature||'?'}`, priority:5, tags:['warning'], click:e.signature?tx(e.signature):undefined};
  if (e.type==='unsupported' && e.kind==='paid-with-pump') return {title:`${tag}${leaderLabel} bought with PUMP tokens (not copied)`, body:`He paid with PUMP tokens he held, not SOL. This bot buys with SOL only, so it skipped this one.\nToken: ${e.mint}`, priority:2, tags:['eyes'], click:pump(e.mint)};
  if (e.type==='provider-gap') return {title:`${tag}Helius missed a ${leaderLabel} trade`, body:`Solscan caught it and the bot processed it late.\nTx: ${e.leaderSignature}`, priority:3, tags:['satellite'], click:tx(e.leaderSignature)};
  if (e.type==='paused' || e.type==='resumed') return {title:`${tag}Bot ${e.type==='paused'?'PAUSED (no new buys)':'RESUMED'}`, body:'Changed from the dashboard.', priority:3, tags:['pause_button']};
  if (e.type==='started') return {title:`${tag}Copy bot started (${mode.toUpperCase()})`, body:e.note||'', priority:2, tags:['robot']};
  return null;
}

/** Paper results per exit timing. stats = engine.d.paperStats: {mint:{cost, exits:{'buy+4s':sol,...}}}. */
export function paperSummary(stats={}) {
  const by={};
  for (const t of Object.values(stats)) for (const [k,v] of Object.entries(t.exits||{})) {
    if (v==null) continue; const r=(by[k] ||= {exit:k,trades:0,wins:0,pnlSol:0}); const p=v-t.cost; r.trades++; r.pnlSol+=p; if(p>0) r.wins++;
  }
  return Object.values(by).sort((a,b)=>a.exit.localeCompare(b.exit));
}

export async function startRuntime(k, {demo=false}={}) {
  const c = runtimeConfig(k.config,demo), status={websocket:'starting',lastPoll:null,lastSignal:null,errors:0,firstSeen:{ws:0,poll:0,solscan:0},gaps:0,unsupported:0};
  c.wallet=c.mode==='live'?k.kp.publicKey:null;
  const token = val('DASHBOARD_TOKEN','');
  if (!demo && !k.config.dryRun && token.length<24) throw new Error('LIVE requires DASHBOARD_TOKEN of at least 24 characters');
  const secrets = [token,k.config.privateKey,k.config.heliusKey,k.config.solscanKey,k.config.jupiterApiKey].filter(Boolean);
  const clean = v => { let s=JSON.stringify(v); for(const secret of secrets) s=s.split(secret).join('[REDACTED]'); return JSON.parse(k.redact(s)); };
  const log = e => {
    e=clean(e); console.log(JSON.stringify(e)); fs.appendFileSync(k.config.logFile,JSON.stringify(e)+'\n',{mode:0o600});
    const a = !demo && k.notify ? alertFor(e,c.mode,k.config.leaderLabel) : null;
    if (a) {
      // Name the coin from Solscan when available; never delay an alert by more than 1.5 s for it.
      const label = e.mint && k.tokenLabel ? Promise.race([k.tokenLabel(e.mint).catch(()=>null), new Promise(r=>setTimeout(()=>r(null),1500))]) : Promise.resolve(null);
      label.then(l=>{ if(l){ a.title=a.title.replace(e.mint.slice(0,6)+'…',l); a.body=l+'\n'+a.body; } return k.notify(a); }).catch(()=>{});
    }
    if (c.mode==='paper') paperExits(e);
  };
  // PAPER ONLY: value each paper position at several sell timings (never sends anything).
  const QUICK=String(val('PAPER_QUICK_SELL_SEC','4,5')).split(',').map(Number).filter(x=>x>0);
  const AFTER=String(val('PAPER_AFTER_HIS_SELL_SEC','0,10')).split(',').map(Number).filter(x=>x>=0);
  const fee=k.config.tipSol+k.config.priorityFeeSol;
  const valueAt=(mint,label,delayMs)=>setTimeout(async()=>{
    try{
      const st=engine.d.paperStats?.[mint]; if(!st) return;
      const sol=await k.quoteSell(mint,Number(st.raw));
      st.exits[label]= sol==null||!Number.isFinite(sol) ? null : sol*0.995-fee; engine.save();
      if (label===`buy+${QUICK.at(-1)}s` && k.notify && k.config.notifyPaper!==false) {
        const v=st.exits[label], s=paperSummary(engine.d.paperStats).find(x=>x.exit===label);
        Promise.resolve(k.notify({title:`[PAPER] ${v==null?'no price':`${v-st.cost>=0?'+':''}${((v/st.cost-1)*100).toFixed(0)}%`} selling ${QUICK.at(-1)}s after buy`,body:`${mint}\nRunning total (${label}): ${s?`${s.pnlSol>=0?'+':''}${s.pnlSol.toFixed(4)} SOL over ${s.trades} trades, ${s.wins} wins`:'-'}\nNo real money used.`,priority:2,tags:['test_tube']})).catch(()=>{});
      }
    }catch{}
  },Math.max(0,delayMs)).unref?.();
  const paperExits=e=>{
    if(e.type==='confirmed'&&e.side==='buy'){
      (engine.d.paperStats ||= {})[e.mint]={cost:-e.solDelta,raw:e.rawDelta,at:Date.now(),exits:{}};
      for(const s of QUICK) valueAt(e.mint,`buy+${s}s`,s*1000);
    }
    if(e.type==='leader-sold'&&engine.d.paperStats?.[e.mint]) for(const s of AFTER) valueAt(e.mint,`his-sell+${s}s`,s*1000);
  };
  let engine;
  const receipt = async job => {
    const tx = await k.getTransaction(job.signature,2);
    if (!tx) return {status:'unresolved',error:'confirmed receipt not available yet'};
    if(tx.meta.err) return {status:'failed',error:JSON.stringify(tx.meta.err)};
    const idx=tx.transaction.message.accountKeys.findIndex(x=>(typeof x==='string'?x:x.pubkey)===k.kp.publicKey);
    if(idx<0) return {status:'unresolved',error:'wallet absent from receipt'};
    const sum = rows => (rows||[]).filter(x=>x.owner===k.kp.publicKey && x.mint===job.mint).reduce((a,x)=>a+BigInt(x.uiTokenAmount.amount),0n);
    const rawDelta=sum(tx.meta.postTokenBalances)-sum(tx.meta.preTokenBalances);
    if ((job.side==='buy' && rawDelta<=0n) || (job.side==='sell' && (rawDelta>=0n || -rawDelta>BigInt(job.raw)))) return {status:'unresolved',error:'receipt token delta does not match intended trade'};
    return {status:'confirmed',rawDelta:rawDelta.toString(),solDelta:(tx.meta.postBalances[idx]-tx.meta.preBalances[idx])/1e9};
  };
  const paperFill = async job => {
    await new Promise(r=>setTimeout(r,demo?20:k.config.paperLandMs));
    const fee=k.config.tipSol+k.config.priorityFeeSol+0.000005;
    if(job.side==='buy') {
      const q=demo?{raw:Math.floor(job.sol*1e9)}:await k.quoteBuy(job.mint,job.sol*0.995);
      if(!q?.raw) return {status:'failed',error:'no paper buy quote'};
      if(job.quoteRaw && q.raw<job.quoteRaw/(1+k.config.slippagePct/100)) return {status:'failed',error:'paper landing price exceeded slippage limit'};
      return {status:'confirmed',rawDelta:BigInt(Math.floor(q.raw)).toString(),solDelta:-job.sol-fee};
    }
    const sol=demo?Number(job.raw)/1e9:await k.quoteSell(job.mint,Number(job.raw));
    if(sol===null || !Number.isFinite(sol)) return {status:'failed',error:'no paper sell quote'};
    return {status:'confirmed',rawDelta:(-BigInt(job.raw)).toString(),solDelta:sol*0.995-fee};
  };
  const adapter = {
    balance:()=>k.getBalanceSol(k.kp.publicKey),
    tokens: async mint => {
      const r=await k.rpc('getTokenAccountsByOwner',[k.kp.publicKey,{mint},{encoding:'jsonParsed',commitment:'confirmed'}]);
      return r.value.reduce((a,x)=>a+BigInt(x.account.data.parsed.info.tokenAmount.amount),0n).toString();
    },
    build: async job => {
      if(c.mode!=='live') {
        let quoteRaw;
        if(job.side==='buy' && !demo) {const q=await k.quoteBuy(job.mint,job.sol*0.995);if(!q?.raw)throw new Error('no paper build quote');quoteRaw=q.raw;}
        return {signature:'paper-'+crypto.randomUUID(),quoteRaw};
      }
      const balance=await k.getBalanceSol(k.kp.publicKey);
      if(job.side==='buy' && balance-job.reserveSol<c.reserve) throw new Error('fresh balance insufficient for fees/reserve');
      if(job.side==='sell' && balance<c.reserve+k.config.tipSol+k.config.priorityFeeSol) throw new Error('insufficient SOL for sell fees');
      const decimals=job.decimals;
      if (job.side==='sell' && (!Number.isInteger(decimals) || decimals<0 || decimals>18)) throw new Error('unknown token decimals');
      // Exact token quantity in decimal text; never sell tokens outside the bot position.
      const raw=job.side==='sell'?job.raw.padStart(decimals+1,'0'):'';
      const amount=job.side==='buy'?job.sol:decimals?raw.slice(0,-decimals)+'.'+raw.slice(-decimals):raw;
      let bytes=await k.http('https://pumpportal.fun/api/trade-local',{method:'POST',raw:true,body:{publicKey:k.kp.publicKey,action:job.side,mint:job.mint,amount,denominatedInSol:job.side==='buy'?'true':'false',slippage:k.config.slippagePct,priorityFee:k.config.priorityFeeSol,pool:'auto'}});
      if(k.config.tipSol>0) bytes=k.addTransferInstruction(bytes,k.TIP_ACCOUNTS[Math.floor(Math.random()*k.TIP_ACCOUNTS.length)],Math.round(k.config.tipSol*1e9));
      const signed=k.signTransaction(bytes,k.kp);
      await k.validateTrade(signed.bytes,job,balance);
      return {signature:signed.signature,bytes:signed.bytes.toString('base64'),blockhash:k.transactionBlockhash(bytes)};
    },
    send: async job => {
      if(c.mode!=='live') return paperFill(job);
      await k.sendRaw(Buffer.from(job.bytes,'base64'),k.config.tipSol>0?[k.senderUrl()]:[]);
      const r=await k.confirm(job.signature);
      if(r.landedFailed) return {status:'failed',error:r.err};
      return r.ok?receipt(job):{status:'unresolved',error:r.err};
    },
    reconcile: async job => {
      if(c.mode!=='live') return {status:'failed',error:'paper trade interrupted; no real transaction sent'};
      const st=(await k.rpc('getSignatureStatuses',[[job.signature],{searchTransactionHistory:true}])).value[0];
      if(st?.err) return {status:'failed',error:JSON.stringify(st.err)};
      if(st && ['confirmed','finalized'].includes(st.confirmationStatus)) return receipt(job);
      if(st) return {status:'unresolved',error:'transaction processed; awaiting confirmation'};
      const valid=await k.rpc('isBlockhashValid',[job.blockhash,{commitment:'finalized'}]);
      if(!valid.value) {
        const tx=await k.getTransaction(job.signature,1);
        if(tx) return receipt(job);
        return {status:'failed',error:'blockhash expired; no transaction in queried chain history'};
      }
      await k.sendRaw(Buffer.from(job.bytes,'base64'),k.config.tipSol>0?[k.senderUrl()]:[]);
      return {status:'unresolved',error:'identical signed transaction rebroadcast'};
    }
  };
  engine=new Engine({file:val('ENGINE_STATE_FILE',path.resolve(`engine-${c.mode}.json`)),config:c,adapter,log});
  if(c.mode==='live') {
    const legacy=val('STATE_FILE',path.resolve('state.json'));
    if(fs.existsSync(legacy)) {
      const old=JSON.parse(fs.readFileSync(legacy,'utf8'));
      if(Object.keys(old.live?.copied||{}).length && !Object.keys(engine.d.positions).length) throw new Error('legacy live positions found: reconcile holdings manually before migrating; do not delete state blindly');
    }
  }
  await engine.recover();
  const inFlight=new Set(), completed=new Set(), delivered=new Set();
  const onSignature=async(sig,source='poll')=>{
    // Which provider saw each leader transaction first. Solscan arriving first means both Helius
    // paths (websocket and polling) missed it: count it and alert, then process it normally.
    if(!delivered.has(sig)) {
      delivered.add(sig); if(delivered.size>20000) delivered.delete(delivered.values().next().value);
      status.firstSeen[source]=(status.firstSeen[source]||0)+1;
      if(source==='solscan') {status.gaps++;engine.event('provider-gap',{leaderSignature:sig,message:'Solscan delivered a leader transaction before Helius'});}
    }
    if(completed.has(sig)||inFlight.has(sig)) return;
    inFlight.add(sig);
    try {
      const tx=await k.getTransaction(sig);
      if(!tx) throw new Error('transaction not available yet; will retry');
      const signals=normalize(tx,k.config.leader,k.detectBuy,k.detectSell);
      if(!signals.length) {
        const u=classifyUnsupported(tx,k.config.leader);
        if(u) {status.unsupported++;engine.event('unsupported',{leaderSignature:sig,mint:u.mint,kind:u.kind,reason:u.kind==='token-swap'?'token-to-token swap':'paid or received PUMP tokens instead of SOL; bot trades with SOL only'});}
        else engine.event('ignored',{leaderSignature:sig,reason:'no supported SOL trade detected'});
      }
      for(const s of signals) {
        if(s.side==='buy') s.usd=s.sol*await k.getSolUsd();
        await engine.ingest(s);
      }
      completed.add(sig); status.lastSignal=new Date().toISOString();
      if(completed.size>10000) completed.delete(completed.values().next().value);
    } catch(e) {status.errors++;engine.event('error',{leaderSignature:sig,message:e.message});}
    finally {inFlight.delete(sig);}
  };
  const stopWatcher=demo?()=>{}:k.startWatcher(onSignature,{log:message=>engine.event('connection',{message}),status});
  const stopSolscan=demo||!k.startSolscanWatcher?()=>{}:k.startSolscanWatcher(onSignature,{log:message=>engine.event('connection',{message}),status});
  if(!demo) status.solscan ||= k.startSolscanWatcher ? {ok:null,note:'starting'} : {ok:false,note:'SOLSCAN_API_KEY not set: Helius only'};
  const timer=setInterval(()=>engine.recover().catch(e=>engine.event('error',{message:e.message})),5000);
  const balanceTimer=c.mode==='live'?setInterval(()=>adapter.balance().then(b=>{status.balance=b;}).catch(e=>engine.event('error',{message:e.message})),10000):null;
  let demonstration;
  if(demo) {
    status.websocket='synthetic demo (no chain connection)';
    let n=engine.d.demoCounter || 0;
    demonstration=setInterval(async()=>{
      engine.d.demoCounter=++n;engine.save();const mint='DEMO-'+Math.ceil(n/3),base={mint,pump:true,time:Date.now()/1000,decimals:6};
      if(n%3===1) await engine.ingest({...base,sig:'demo-'+n,side:'buy',sol:2,leaderBalanceSol:100,usd:300});
      else await engine.ingest({...base,sig:'demo-'+n,side:'sell',soldRaw:n%3===2?'250000':'750000',beforeRaw:n%3===2?'1000000':'750000'});
    },1500);
  }
  const port=number('PORT',3000),host=val('DASHBOARD_HOST','127.0.0.1');
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'");
    const url=new URL(req.url,'http://localhost');
    const authorized=()=> {const supplied=(req.headers.authorization||'').replace(/^Bearer /,'');return token && Buffer.byteLength(supplied)===Buffer.byteLength(token) && crypto.timingSafeEqual(Buffer.from(supplied),Buffer.from(token));};
    if(url.pathname==='/health') {res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({running:true,mode:c.mode}));}
    if(url.pathname.startsWith('/api/')) {
      if(token && !authorized()) {res.writeHead(401);return res.end('Unauthorized');}
      if(!token && c.mode==='live') {res.writeHead(403);return res.end('Token required');}
      if(url.pathname==='/api/status' && req.method==='GET') {res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(clean({...engine.snapshot(),paper:c.mode==='paper'?paperSummary(engine.d.paperStats):undefined,balance:c.mode==='live'?(status.balance??null):engine.d.paperBalance,connection:status})));}
      if(req.method==='POST' && ['/api/pause','/api/resume'].includes(url.pathname)) {
        engine.pause(url.pathname==='/api/pause');res.writeHead(200);return res.end('OK');
      }
      res.writeHead(404);return res.end('Not found');
    }
    const files={'/':'dashboard.html','/dashboard.js':'dashboard.js','/dashboard.css':'dashboard.css','/manifest.webmanifest':'manifest.webmanifest','/icon.svg':'icon.svg'};
    if(!files[url.pathname]) {res.writeHead(404);return res.end('Not found');}
    const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
    res.writeHead(200,{'Content-Type':types[path.extname(files[url.pathname])]});res.end(fs.readFileSync(new URL(files[url.pathname],import.meta.url)));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  engine.event('started',{mode:c.mode,dashboard:`http://${host}:${port}`,note:demo?'SYNTHETIC DEMO; no chain or wallet connection':'confirmed leader signals; paper estimates are not guaranteed fills'});
  return {engine,server,stop:()=>{stopWatcher();stopSolscan();clearInterval(timer);clearInterval(balanceTimer);clearInterval(demonstration);server.close();}};
}
