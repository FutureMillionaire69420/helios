import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {Engine} from './engine.mjs';
import {PUMP_TOKEN,QUOTES} from './solscan.mjs';
import {createStudy,summaryText} from './study.mjs';
import {buyContextFromLogs,buildBuyTransaction,readGlobal,pickFeeRecipient,pickBuybackRecipient,startBlockhashCache} from './pumpbuild.mjs';

const val = (key, fallback) => process.env[key]?.trim() || fallback;
const number = (key, fallback) => Number(val(key,String(fallback)));
export function runtimeConfig(c, demo=false) {
  const out = {mode:demo?'demo':c.dryRun?'paper':'live', timezone:c.timezone,
    sizing:val('SIZING_MODE','fixed'), multiplier:number('COPY_MULTIPLIER',1),
    buySol:c.buySol, maxBuy:number('MAX_BUY_SOL',c.buySol), minBuy:number('MIN_BUY_SOL',0.005),
    reserve:c.minSolReserve, feeBudget:c.tipSol+c.priorityFeeSol+0.005,
    slippage:c.slippagePct, dailyCap:c.dailyCapSol, minLeaderUsd:c.minLeaderBuyUsd,
    maxAge:c.maxSignalAgeSec, maxSellAge:number('MAX_SELL_SIGNAL_AGE_SEC',300), pumpOnly:c.pumpOnly,
    oneBuy:c.oneBuyPerMint, autoSell:val('AUTO_SELL',demo?'true':'false')==='true', autoCopy:val('AUTO_COPY','true') === 'true', paperBalance:number('PAPER_BALANCE_SOL',1.65)};
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
  if (sell) for(const x of sell.sold) result.push({...common,side:'sell',mint:x.mint,sol:sell.sold.length===1?sell.receivedSol:null,soldRaw:((pre.get(x.mint)||0n)-(post.get(x.mint)||0n)).toString(),beforeRaw:(pre.get(x.mint)||0n).toString(),decimals:decimals.get(x.mint)});
  if (buy) {
    // Multi-mint trade allocation cannot be inferred from aggregate SOL spend.
    if (buy.bought.length===1 && buy.spentStableUsd===0) result.push({...common,side:'buy',mint:buy.bought[0].mint,sol:buy.spentSol,raw:((post.get(buy.bought[0].mint)||0n)-(pre.get(buy.bought[0].mint)||0n)).toString(),pump:buy.pump,decimals:decimals.get(buy.bought[0].mint)});
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
  if (e.type==='leader-sold') return {title:`${tag}${leaderLabel} SOLD a coin you hold`, body:`He is selling ${short(e.mint)}. The bot will NOT sell (manual-sell style).\nSell by hand in Phantom if you want out.\nToken: ${e.mint}`, priority:5, tags:['rotating_light'], click:pump(e.mint)};
  if (e.type==='confirmed' && e.side==='buy') return {title:`${tag}Copied ${leaderLabel}: bought ${short(e.mint)}`, body:`Spent ${(-e.solDelta).toFixed(4)} SOL incl. fees\nToken: ${e.mint}`, priority:mode==='live'?5:3, tags:['white_check_mark'], click:mode==='live'?tx(e.signature):pump(e.mint)};
  if (e.type==='confirmed' && e.side==='sell') return {title:`${tag}Sold ${short(e.mint)}`, body:`Received ${Number(e.solDelta).toFixed(4)} SOL after fees\nToken: ${e.mint}`, priority:4, tags:['moneybag'], click:mode==='live'?tx(e.signature):pump(e.mint)};
  if (e.type==='failed') return {title:`${tag}Trade FAILED (${e.side})`, body:`${e.message||'unknown error'}\nToken: ${e.mint}\nNo tokens changed hands.`, priority:4, tags:['x'], click:pump(e.mint)};
  if (e.type==='unresolved') return {title:`${tag}Trade outcome UNKNOWN`, body:`${e.message||''}\nThe bot keeps checking and will not double-trade.\nTx: ${e.signature||'?'}`, priority:5, tags:['warning'], click:e.signature?tx(e.signature):undefined};
  if (e.type==='unsupported' && e.kind==='paid-with-pump') return {title:`${tag}${leaderLabel} bought with PUMP tokens (not copied)`, body:`He paid with PUMP tokens he held, not SOL. This bot buys with SOL only, so it skipped this one.\nToken: ${e.mint}`, priority:2, tags:['eyes'], click:pump(e.mint)};
  if (e.type==='exit-rule') {
    const p=e.pnl==null?'':` (${e.pnl>=0?'+':''}${(e.pnl*100).toFixed(1)}% incl. fees)`;
    const t={stoploss:[`Stop-loss: selling ${short(e.mint)}${p}`,`The coin fell ${e.move!=null?(e.move*100).toFixed(0)+'%':'20%+'} from the bot's entry price: selling everything now.`,4,'stop_sign'],'gain-target':[`+15% reached: selling ${short(e.mint)}${p}`,`It reached +15% within 15 s of ${leaderLabel}'s buy: selling now.`,3,'moneybag'],'hold-until-his-sell':[`Holding ${short(e.mint)} until ${leaderLabel} sells${p}`,`Never reached +15% within 15 s of ${leaderLabel}'s buy, so the bot waits for his sell (stop-loss still on).`,2,'hourglass'],'hold-limit':[`Time limit: selling ${short(e.mint)}${p}`,'Held 10 minutes without his sell: selling everything.',3,'alarm_clock']}[e.rule];
    if (t) return {title:`${tag}${t[0]}`, body:`${t[1]}\nToken: ${e.mint}`, priority:t[2], tags:[t[3]], click:pump(e.mint)};
  }
  if (e.type==='provider-gap' && false) return {title:`${tag}Helius missed a ${leaderLabel} trade`, body:`Solscan caught it and the bot processed it late.\nTx: ${e.leaderSignature}`, priority:3, tags:['satellite'], click:tx(e.leaderSignature)};
  if (e.type==='alerts-on') return {title:`${tag}Alerts ON`, body:'Phone alerts resumed.', priority:2, tags:['bell']};
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
  const c = runtimeConfig(k.config,demo), status={websocket:'starting',lastPoll:null,lastSignal:null,errors:0,firstSeen:{ws:0,poll:0,solscan:0},gaps:0,unsupported:0,otherWallets:0};
  c.wallet=c.mode==='live'?k.kp.publicKey:null;
  // Keep the journal from filling the disk: over 50 MB it moves to trades.log.1 at startup.
  try { if (fs.statSync(k.config.logFile).size > 50e6) fs.renameSync(k.config.logFile, k.config.logFile+'.1'); } catch {}
  const token = val('DASHBOARD_TOKEN','');
  if (!demo && !k.config.dryRun && token.length<24) throw new Error('LIVE requires DASHBOARD_TOKEN of at least 24 characters');
  const secrets = [token,k.config.privateKey,k.config.heliusKey,k.config.solscanKey,k.config.jupiterApiKey].filter(Boolean);
  const clean = v => { let s=JSON.stringify(v); for(const secret of secrets) s=s.split(secret).join('[REDACTED]'); return JSON.parse(k.redact(s)); };
  const log = e => {
    e=clean(e); console.log(JSON.stringify(e)); fs.appendFileSync(k.config.logFile,JSON.stringify(e)+'\n',{mode:0o600});
    // Alerts off mutes everything except a LIVE trade whose outcome is unknown (real money at risk).
    const muted = engine?.d.alertsOff && !(c.mode==='live' && e.type==='unresolved');
    const a = !demo && k.notify && !muted ? alertFor(e,c.mode,k.config.leaderLabel) : null;
    if (a) {
      // Name the coin from Solscan when available; never delay an alert by more than 1.5 s for it.
      const label = e.mint && k.tokenLabel ? Promise.race([k.tokenLabel(e.mint).catch(()=>null), new Promise(r=>setTimeout(()=>r(null),1500))]) : Promise.resolve(null);
      label.then(l=>{ if(l){ a.title=a.title.replace(e.mint.slice(0,6)+'…',l); a.body=l+'\n'+a.body; } return k.notify(a); }).catch(()=>{});
    }
    if (c.mode==='paper') paperExits(e);
    // Every bot buy (paper or live) gets a 15 s study: re-priced each second, then one detailed alert.
    if (e.type==='confirmed' && e.side==='buy') scheduleMaxHold?.(e.mint);
    if (study && e.type==='confirmed' && e.side==='buy') study.start({mint:e.mint,cost:-e.solDelta,raw:e.rawDelta,his:leaderBuys.get(e.mint)||{}});
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
      if (!study && label===`buy+${QUICK.at(-1)}s` && k.notify && k.config.notifyPaper!==false && !engine.d.alertsOff) {
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
  let engine, scheduleMaxHold=null;
  const maxHoldMs=number('MAX_HOLD_SEC',15)*1000;
  // Decu's FIRST buy of each coin (for PCAT and the entry gap). Bounded.
  const leaderBuys=new Map();
  const study = demo || val('STUDY','true')==='false' || !k.quoteSell ? null : createStudy({
    file:val('STUDY_FILE',path.resolve(`study-${c.mode}.jsonl`)), quoteSell:k.quoteSell, mode:c.mode, buySol:c.buySol,
    feeSol:k.config.tipSol+k.config.priorityFeeSol, windowSec:number('STUDY_WINDOW_SEC',15), bandPct:number('BAND_PCT',10)/100, notesOpts:{stopLossPct:number('STOP_LOSS_PCT',20),gainGatePct:number('GAIN_GATE_PCT',15),maxPayPct:number('MAX_PAY_ABOVE_DECU_PCT',0)||60}, learnOpts:{gateSec:number('MAX_HOLD_SEC',15),maxPayPct:number('MAX_PAY_ABOVE_DECU_PCT',0),reportEvery:number('LEARN_REPORT_EVERY',10),digestHours:number('LEARN_DIGEST_HOURS',24)}, label:k.config.leaderLabel,
    meta:k.tokenMeta||null, notify:k.notify?(a=>engine?.d.alertsOff?null:k.notify(a)):null, log:m=>engine?.event('connection',{message:m})});
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
      const ref=leaderBuys.get(job.mint), maxPay=number('MAX_PAY_ABOVE_DECU_PCT',0)/100;
      if(maxPay>0 && ref?.sol>0 && ref.raw>0) { const gap=(job.sol/q.raw)/(ref.sol/ref.raw)-1; if(gap>maxPay) return {status:'failed',error:`price already ${Math.round(gap*100)}% above Decu's (MAX_PAY_ABOVE_DECU_PCT ${Math.round(maxPay*100)}%): not bought`}; }
      if(job.quoteRaw && q.raw<job.quoteRaw/(1+k.config.slippagePct/100)) return {status:'failed',error:'paper landing price exceeded slippage limit'};
      return {status:'confirmed',rawDelta:BigInt(Math.floor(q.raw)).toString(),solDelta:-job.sol-fee};
    }
    const sol=demo?Number(job.raw)/1e9:await k.quoteSell(job.mint,Number(job.raw));
    if(sol===null || !Number.isFinite(sol)) return {status:'failed',error:'no paper sell quote'};
    return {status:'confirmed',rawDelta:(-BigInt(job.raw)).toString(),solDelta:sol*0.995-fee};
  };
  let cachedBalance=null;
  const buyCtx=new Map();
  const local = c.mode==='live' && val('LOCAL_BUILD','true')!=='false' && k.findProgramAddress ? {
    helpers:{findProgramAddress:k.findProgramAddress,ata:k.ata,b58decode:k.b58decode,b58encode:k.b58encode},
    blockhash:startBlockhashCache(k.rpc,{log:m=>status.lastError=m}), global:null,
  } : null;
  const refreshGlobal=()=>local && readGlobal(k.rpc,local.helpers).then(g=>{local.global=g;}).catch(e=>{status.lastError='pump.fun global: '+e.message;});
  refreshGlobal();
  const globalTimer=local?setInterval(refreshGlobal,600_000):null; globalTimer?.unref?.();
  const adapter = {
    // Wallet balance is refreshed every 10 s in the background; sizing uses it if under 15 s old.
    // The full simulation before every send still checks the real balance.
    balance:async()=>(cachedBalance && Date.now()-cachedBalance.at<15_000 ? cachedBalance.sol : (cachedBalance={sol:await k.getBalanceSol(k.kp.publicKey),at:Date.now()}).sol),
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
      const balance=job.side==='buy' ? await adapter.balance() : await k.getBalanceSol(k.kp.publicKey);
      if(job.side==='buy' && balance-job.reserveSol<c.reserve) throw new Error('fresh balance insufficient for fees/reserve');
      // FASTEST: build the buy locally from his trade event (no PumpPortal round trip, no waiting
      // for a blockhash). Same safety check and full simulation as every other trade.
      if(job.side==='buy' && local) {
        const ctx=buyCtx.get(job.mint), blockhash=local.blockhash.get();
        if(ctx && blockhash && local.global) {
          try {
            const t0=Date.now();
            const tip=k.config.tipSol>0 ? k.TIP_ACCOUNTS[Math.floor(Math.random()*k.TIP_ACCOUNTS.length)] : null;
            const ref=leaderBuys.get(job.mint), maxPay=number('MAX_PAY_ABOVE_DECU_PCT',0)/100;
            // the chain enforces the max-pay guard: the buy fails (fee only) if the price ran past it
            const minTokensFloor=maxPay>0 && ref?.sol>0 && ref.raw>0 ? BigInt(Math.floor(job.sol/((ref.sol/ref.raw)*(1+maxPay)))) : 0n;
            const {bytes}=buildBuyTransaction({user:k.kp.publicKey,minTokensFloor,ctx:{...ctx,feeRecipient:pickFeeRecipient(local.global,ctx.mayhem),buybackRecipient:pickBuybackRecipient(local.global)},lamports:Math.floor(job.sol*1e9),slippagePct:k.config.slippagePct,blockhash,priorityLamports:Math.round(k.config.priorityFeeSol*1e9),tipAccount:tip,tipLamports:Math.round(k.config.tipSol*1e9)},local.helpers);
            const signed=k.signTransaction(bytes,k.kp);
            await k.validateTrade(signed.bytes,job,balance);
            status.localBuilds=(status.localBuilds||0)+1; status.lastLocalBuildMs=Date.now()-t0;
            return {signature:signed.signature,bytes:signed.bytes.toString('base64'),blockhash,built:'local'};
          } catch(e) { engine.event('connection',{message:'local build failed, using PumpPortal: '+e.message}); }
        }
      }
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
  // EXIT RULES: every held coin is priced once a second (Helius curve read) until it is sold.
  //  1. STOP_LOSS_PCT (20): down this much at any moment -> sell everything. Both styles
  //     (STOP_LOSS_MANUAL=false keeps manual-sell style hands-off).
  //  2. Auto-sell style, at MAX_HOLD_SEC (15) after DECU'S buy: if the trade reached
  //     +GAIN_GATE_PCT (15) at any point by then -> sell everything; if it never did -> keep
  //     holding until Decu sells (the stop-loss still applies).
  //  3. Auto-sell style, HOLD_LIMIT_SEC (600): sell whatever happens, in case his sell is missed.
  //  His sell always exits at once in auto-sell style (SELL_ALL_ON_LEADER_SELL).
  // STOP_LOSS_FROM=entry (default): the stop measures the coin's own move from the price right after
  // the bot's buy ("organic"), ignoring the fees and price impact already paid. =cost: from cost.
  const stopLoss=number('STOP_LOSS_PCT',20)/100, gainGate=number('GAIN_GATE_PCT',15)/100, stopFromEntry=val('STOP_LOSS_FROM','entry')!=='cost';
  const holdLimitMs=number('HOLD_LIMIT_SEC',600)*1000, stopLossManual=val('STOP_LOSS_MANUAL','true')==='true';
  const exitFee=k.config.tipSol+k.config.priorityFeeSol, monitors=new Map();
  const exitNow=(mint,p,rule,pnl,move)=>{
    monitors.delete(mint);
    engine.event('exit-rule',{mint,rule,pnl,move});
    return engine.ingest({sig:`${rule}-${mint}-${p.boughtAt||0}`,side:'sell',mint,soldRaw:'1',beforeRaw:'1',time:Date.now()/1000,decimals:mintDecimals.get(mint)??6,force:true})
      .catch(err=>engine.event('error',{mint,message:`${rule} sell: ${err.message}`}));
  };
  scheduleMaxHold=(mint)=>{
    if(monitors.has(mint) || !k.quoteSell) return;
    const m={peak:-Infinity,decided:false}; monitors.set(mint,m);
    const tick=async()=>{
      if(monitors.get(mint)!==m) return;
      const p=engine.d.positions[mint];
      if(!p || BigInt(p.raw)<=0n) { monitors.delete(mint); return; }
      const auto=engine.d.autoCopy, age=Date.now()-(p.boughtAt||Date.now());
      // The 15 s gate counts from DECU'S buy (his on-chain time), not the bot's; bot time if unknown.
      const his=leaderBuys.get(mint), bought=p.boughtAt||Date.now(), hisMs=his?.time>0 && bought-his.time*1000<=60e3 ? his.time*1000 : bought, sinceHis=Date.now()-hisMs; // >60 s apart: not his matching buy
      let pnl=null;
      try {
        const v=await Promise.race([k.quoteSell(mint,Number(p.raw)),new Promise(r=>setTimeout(()=>r(null),2500).unref?.())]);
        if(Number.isFinite(v) && p.costSol>0) pnl=(v*0.995-exitFee-p.costSol)/p.costSol;
      } catch {}
      if(pnl!=null) { m.peak=Math.max(m.peak,pnl); m.last=pnl; m.base??=pnl; }
      const move=pnl==null?null:stopFromEntry?(1+pnl)/(1+m.base)-1:pnl;
      if(move!=null && stopLoss>0 && move<=-stopLoss && (auto||stopLossManual)) return exitNow(mint,p,'stoploss',pnl,move);
      if(auto && maxHoldMs>0 && sinceHis>=maxHoldMs && !m.decided) {
        m.decided=true;
        if(m.peak>=gainGate) return exitNow(mint,p,'gain-target',pnl);
        engine.event('exit-rule',{mint,rule:'hold-until-his-sell',pnl,peak:Number.isFinite(m.peak)?m.peak:null});
      }
      if(auto && holdLimitMs>0 && age>=holdLimitMs) return exitNow(mint,p,'hold-limit',pnl);
      setTimeout(tick,number('MONITOR_MS',1000)).unref?.();
    };
    tick();
  };
  // after a restart, keep watching coins still held (peak unknown: treated as never reached +15%)
  for(const [mint,p] of Object.entries(engine.d.positions)) if(BigInt(p.raw||'0')>0n) scheduleMaxHold(mint);
  const inFlight=new Set(), completed=new Set(), delivered=new Set(), fastDone=new Set(), gapSigs=new Set();
  const runtimeStart=Date.now();
  // GAP REPORT: a Decu trade Solscan saw before Helius. Says what it was, where, how late, and what
  // the bot did; alerts are grouped (one phone message per GAP_ALERT_SEC) so a burst is one alert.
  let gapBuffer=[], gapTimer=null;
  const reportGap=(sig,tx,signals)=>{
    status.gaps++;
    const s0=signals[0], logs=tx.meta?.logMessages||[], venue=k.venueOf?k.venueOf(logs):'?';
    const lateSec=tx.blockTime?Math.round(Date.now()/1000-tx.blockTime):null;
    const action=!s0?'no copyable SOL trade':s0.side==='sell'?(engine.d.positions[s0.mint]?'sell of a coin the bot holds: exit rules applied now':'sell of a coin the bot does not hold'):(!s0.pump&&c.pumpOnly?`buy on ${venue}: skipped (bot copies pump.fun coins only, PUMP_ONLY)`:lateSec!=null&&lateSec>c.maxAge?`buy ${lateSec}s old: too late to copy (limit ${c.maxAge}s)`:'pump.fun buy: processed by the copy rules now');
    const g={leaderSignature:sig,side:s0?.side||'other',mint:s0?.mint||null,sol:s0?.sol??null,venue,lateSec,action};
    engine.event('provider-gap',g); gapBuffer.push(g);
    if(!gapTimer) { gapTimer=setTimeout(()=>{
      gapTimer=null; const list=gapBuffer; gapBuffer=[];
      if(demo || !k.notify || engine.d.alertsOff || !list.length) return;
      const line=x=>`${x.side.toUpperCase()} ${x.mint?x.mint.slice(0,6)+'…':''}${x.sol!=null?` ${x.sol.toFixed(3)} SOL`:''} on ${x.venue}, ${x.lateSec??'?'}s late: ${x.action}`;
      const tag=c.mode==='live'?'':c.mode==='paper'?'[PAPER] ':'[DEMO] ';
      Promise.resolve(k.notify({title:`${tag}Solscan caught ${list.length} Decu trade${list.length>1?'s':''} Helius missed`,body:list.slice(0,8).map(line).join('\n')+(list.length>8?`\n…and ${list.length-8} more`:'')+'\nThe Solscan backup worked; nothing was lost.',priority:list.some(x=>/processed by the copy rules|exit rules/.test(x.action))?4:2,tags:['satellite'],click:`https://solscan.io/tx/${list[0].leaderSignature}`})).catch(()=>{});
    },number('GAP_ALERT_SEC',20)*1000); gapTimer.unref?.(); }
  };
  // Exit rule for the auto-sell style: sell everything at his FIRST sell (SELL_ALL_ON_LEADER_SELL),
  // plus the gain gate MAX_HOLD_SEC (15) after his buy (see EXIT RULES above). 0 = no gate.
  const sellAll=val('SELL_ALL_ON_LEADER_SELL','true')==='true', maxHoldSec=number('MAX_HOLD_SEC',15);
  const mintDecimals=new Map();
  const remember=(map,key,v)=>{map.set(key,v);if(map.size>2000)map.delete(map.keys().next().value);};
  // His reference buy for PCAT / entry gap / max-pay guard: the first one big enough to be copied.
  const recordLeaderBuy=s=>{ const old=leaderBuys.get(s.mint); if(!old || (old.usd<c.minLeaderUsd && s.usd>=c.minLeaderUsd)) remember(leaderBuys,s.mint,{sol:s.sol,raw:Number(s.raw)||0,usd:s.usd,time:s.time}); };
  let lastErrorEventAt=0, hiddenErrors=0;
  const onSignature=async(sig,source='poll',logs)=>{
    // Which provider saw each leader transaction first. Solscan arriving first means both Helius
    // paths (websocket and polling) missed it: count it and alert, then process it normally.
    if(!delivered.has(sig)) {
      delivered.add(sig); if(delivered.size>20000) delivered.delete(delivered.values().next().value);
      status.firstSeen[source]=(status.firstSeen[source]||0)+1;
      // A restart replays Solscan's last few minutes before Helius has caught up: not a gap.
      if(source==='solscan' && Date.now()-runtimeStart>number('GAP_GRACE_SEC',90)*1000) gapSigs.add(sig);
    }
    // FAST PATH: his pump.fun trade decoded straight from the websocket logs (processed commitment),
    // before the transaction is confirmed or downloaded. The full path below still runs and is deduplicated.
    if(source==='ws' && k.config.fastPath!==false && k.leaderPumpBuys && Array.isArray(logs) && !fastDone.has(sig)) {
      fastDone.add(sig); if(fastDone.size>5000) fastDone.delete(fastDone.values().next().value);
      try {
        if(local) { const ctx=buyContextFromLogs(logs,k.config.leader,k.b58encode); if(ctx) remember(buyCtx,ctx.mint,ctx); }
        for(const ev of k.leaderPumpBuys(logs,k.config.leader)) {
          const s={sig,time:ev.timestamp||Date.now()/1000,side:'buy',mint:ev.mint,sol:ev.solAmount/1e9,raw:String(ev.tokenAmount),pump:true,decimals:6,fast:true};
          s.usd=s.sol*await k.getSolUsd(); recordLeaderBuy(s); remember(mintDecimals,s.mint,6); status.fastSignals=(status.fastSignals||0)+1;
          await engine.ingest(s);
        }
        if(sellAll && k.leaderPumpSells) for(const ev of k.leaderPumpSells(logs,k.config.leader)) {
          const s={sig,time:ev.timestamp||Date.now()/1000,side:'sell',mint:ev.mint,sol:ev.solAmount/1e9,soldRaw:'1',beforeRaw:'1',decimals:mintDecimals.get(ev.mint)??6,fast:true};
          study?.leaderSell(s.mint,s); await engine.ingest(s);
        }
      } catch(e) { engine.event('error',{leaderSignature:sig,message:'fast path: '+e.message}); }
    }
    if(completed.has(sig)||inFlight.has(sig)) return;
    inFlight.add(sig);
    try {
      const tx=await k.getTransaction(sig);
      if(!tx) throw new Error('transaction not available yet; will retry');
      // LaunchLab / bonk.fun / any non-pump.fun coin: ignored completely (no copy, no study, no alert).
      const venue=k.venueOf?k.venueOf(tx.meta?.logMessages||[]):'?', pumpVenue=['pump.fun','PumpSwap'].includes(venue);
      const all=normalize(tx,k.config.leader,k.detectBuy,k.detectSell), signals=all.filter(s=>!(c.pumpOnly && (s.side==='buy'?!s.pump:!pumpVenue && !engine.d.positions[s.mint])));
      if(signals.length<all.length) status.ignoredVenue=(status.ignoredVenue||0)+1;
      if(local && tx.meta?.logMessages && signals.some(s=>s.side==='buy')) { const ctx=buyContextFromLogs(tx.meta.logMessages,k.config.leader,k.b58encode); if(ctx && !buyCtx.has(ctx.mint)) remember(buyCtx,ctx.mint,ctx); }
      if(!all.length) {
        const u=classifyUnsupported(tx,k.config.leader);
        if(u) {status.unsupported++;engine.event('unsupported',{leaderSignature:sig,mint:u.mint,kind:u.kind,reason:u.kind==='token-swap'?'token-to-token swap':'paid or received PUMP tokens instead of SOL; bot trades with SOL only'});}
        else {
          // Most transactions touching his address are other people's (bots, spam): ~5 a second on
          // 2026-10-07. Count those instead of writing an event each (that filled the disk and log).
          const me=(tx.transaction?.message?.accountKeys||[]).find(x=>(typeof x==='string'?x:x.pubkey)===k.config.leader);
          if(me && typeof me==='object' && !me.signer) status.otherWallets++;
          else engine.event('ignored',{leaderSignature:sig,reason:'no supported SOL trade detected'});
        }
      }
      for(const s of signals) {
        if(Number.isInteger(s.decimals)) remember(mintDecimals,s.mint,s.decimals);
        if(s.side==='buy') { s.usd=s.sol*await k.getSolUsd(); recordLeaderBuy(s); }
        else { study?.leaderSell(s.mint,s); if(sellAll) { s.soldRaw='1'; s.beforeRaw='1'; } }
        await engine.ingest(s);
      }
      // A non-pump.fun trade (LaunchLab / bonk.fun / Raydium / Meteora...) never makes a gap alert.
      if(gapSigs.delete(sig)) { if(signals.length || !c.pumpOnly || (all.length===0 && ['pump.fun','PumpSwap','FLASHX router','other','?'].includes(venue))) reportGap(sig,tx,signals); else status.ignoredVenue=(status.ignoredVenue||0)+(signals.length<all.length?0:1); }
      completed.add(sig); status.lastSignal=new Date().toISOString();
      if(completed.size>10000) completed.delete(completed.values().next().value);
    } catch(e) {
      // Under rate limits this can fire several times a second: keep the count, write at most one event per 30 s.
      status.errors++; status.lastError=e.message.slice(0,200);
      if(Date.now()-lastErrorEventAt>30_000) {lastErrorEventAt=Date.now();engine.event('error',{leaderSignature:sig,message:e.message+(hiddenErrors?` (+${hiddenErrors} similar errors not listed)`:'')});hiddenErrors=0;}
      else hiddenErrors++;
    }
    finally {inFlight.delete(sig);}
  };
  const stopWatcher=demo?()=>{}:k.startWatcher(onSignature,{log:message=>engine.event('connection',{message}),status});
  const stopSolscan=demo||!k.startSolscanWatcher?()=>{}:k.startSolscanWatcher(onSignature,{log:message=>engine.event('connection',{message}),status});
  if(!demo) status.solscan ||= k.startSolscanWatcher ? {ok:null,note:'starting'} : {ok:false,note:'SOLSCAN_API_KEY not set: Helius only'};
  const timer=setInterval(()=>engine.recover().catch(e=>engine.event('error',{message:e.message})),5000);
  // WATCHDOG: alert when Helius (websocket) or Solscan stays down, and when it recovers;
  // plus a "healthy" check-in every HEALTH_ALERT_HOURS (12). Respects the alerts on/off switch.
  const startedAt=Date.now(); let wsDownSince=null, wsAlerted=false, scDownSince=null, scAlerted=false, lastHealth=Date.now();
  const say=a=>{ if(!demo && k.notify && !engine.d.alertsOff) Promise.resolve(k.notify(a)).catch(()=>{}); };
  const tag=c.mode==='live'?'':'[PAPER] ';
  const watchdog=demo?null:setInterval(()=>{
    const now=Date.now();
    if(status.websocket!=='subscribed') { wsDownSince??=now; if(!wsAlerted && now-wsDownSince>120_000) { wsAlerted=true; say({title:`${tag}Helius connection DOWN`,body:`Websocket "${status.websocket}" for ${Math.round((now-wsDownSince)/60000)} min. Solscan backup still watching. Check your Helius key and plan.`,priority:4,tags:['warning']}); } }
    else { if(wsAlerted) say({title:`${tag}Helius connection back`,body:'Websocket subscribed again.',priority:2,tags:['white_check_mark']}); wsDownSince=null; wsAlerted=false; }
    if(status.solscan?.ok===false) { scDownSince??=now; if(!scAlerted && now-scDownSince>300_000) { scAlerted=true; say({title:`${tag}Solscan backup DOWN`,body:`${status.solscan.error||'no answer'} for 5+ min. Helius still watching; no gap detection meanwhile.`,priority:3,tags:['warning']}); } }
    else if(status.solscan?.ok) { if(scAlerted) say({title:`${tag}Solscan backup back`,body:'Polling again.',priority:2,tags:['white_check_mark']}); scDownSince=null; scAlerted=false; }
    if(now-lastHealth>number('HEALTH_ALERT_HOURS',12)*3600_000) {
      lastHealth=now; const sm=study?.summary();
      say({title:`${tag}Bot healthy · up ${Math.round((now-startedAt)/3600_000)} h`,body:[`Helius: ${status.websocket} · fast signals ${status.fastSignals||0} · errors ${status.errors}`,`Solscan: ${status.solscan?.ok?'OK':status.solscan?.ok===false?'failing':'off'} · gaps caught ${status.gaps}`,sm?.trades?`Study: ${sm.trades} trades, FCAT ${sm.fcat.pnlSol>=0?'+':''}${sm.fcat.pnlSol.toFixed(4)} SOL (${sm.fcat.wins}/${sm.fcat.trades} wins)`:'Study: no trades yet'].join('\n'),priority:1,tags:['heartbeat']});
    }
  },30_000);
  watchdog?.unref?.();
  const pruneTimer=setInterval(()=>engine.lock(()=>{if(engine.prune())engine.save();}).catch(()=>{}),600_000);
  const balanceTimer=c.mode==='live'?setInterval(()=>k.getBalanceSol(k.kp.publicKey).then(b=>{status.balance=b;cachedBalance={sol:b,at:Date.now()};}).catch(e=>engine.event('error',{message:e.message})),10000):null;
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
      if(url.pathname==='/api/status' && req.method==='GET') {
        const snap={...engine.snapshot(),paper:c.mode==='paper'?paperSummary(engine.d.paperStats):undefined,balance:c.mode==='live'?(status.balance??null):engine.d.paperBalance,connection:status,
          wallet:{publicKey:c.wallet||null,signer:c.mode==='live'?'local-ed25519':'paper-simulated',autonomous:c.mode==='live'&&!!k.kp,phantomBrowserVerification:true}};
        res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(clean(snap)));
      }
      if(url.pathname==='/api/memory' && req.method==='GET') {const {memoryBank,memoryInsights}=await import('./study.mjs');res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(study?{bank:memoryBank(study.records),insights:memoryInsights(study.records)}:{bank:[]}));}
      if(url.pathname==='/api/brain' && req.method==='GET') {res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(study?study.learning():{journey:null}));}
      if(url.pathname==='/api/study' && req.method==='GET') {res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(study?{...study.summary(),text:summaryText(study.summary()),active:[...study.active.keys()]}:{trades:0,text:'Study is off.'}));}
      if(url.pathname==='/api/wallet' && req.method==='GET') {
        res.writeHead(200,{'Content-Type':'application/json'});
        return res.end(JSON.stringify(clean({publicKey:c.wallet||null,signer:c.mode==='live'?'local-ed25519':'paper-simulated',autonomous:c.mode==='live'&&!!k.kp,phantomBrowserVerification:true})));
      }
      if(req.method==='POST' && ['/api/pause','/api/resume'].includes(url.pathname)) {
        engine.pause(url.pathname==='/api/pause');res.writeHead(200);return res.end('OK');
      }
      if(req.method==='POST' && ['/api/alerts/on','/api/alerts/off'].includes(url.pathname)) {
        engine.mute(url.pathname==='/api/alerts/off');res.writeHead(200);return res.end('OK');
      }
      const style=url.pathname.match(/^\/api\/style\/(auto|manual|off)$/);
      if(req.method==='POST' && style) {engine.style(style[1]);res.writeHead(200);return res.end('OK');}
      if(req.method==='POST' && ['/api/autocopy/on','/api/autocopy/off'].includes(url.pathname)) {
        engine.autoCopy(url.pathname==='/api/autocopy/on');res.writeHead(200);return res.end('OK');
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
  return {engine,server,study,stop:()=>{monitors?.clear();stopWatcher();stopSolscan();clearInterval(pruneTimer);clearInterval(watchdog);clearInterval(globalTimer);local?.blockhash.stop();clearInterval(timer);clearInterval(balanceTimer);clearInterval(demonstration);server.close();}};
}
