import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {Engine} from './engine.mjs';
import {PUMP_TOKEN,QUOTES} from './solscan.mjs';
import {createStudy,summaryText} from './study.mjs';
import {buyContextFromLogs,tokensOut,buildBuyTransaction,readGlobal,pickFeeRecipient,pickBuybackRecipient,startBlockhashCache,createSellDesk,TOKEN,TOKEN_2022} from './pumpbuild.mjs';

const val = (key, fallback) => process.env[key]?.trim() || fallback;
const number = (key, fallback) => Number(val(key,String(fallback)));
export function runtimeConfig(c, demo=false) {
  const out = {mode:demo?'demo':c.dryRun?'paper':'live', timezone:c.timezone,
    sizing:val('SIZING_MODE','fixed'), multiplier:number('COPY_MULTIPLIER',1),
    buySol:c.buySol, maxBuy:number('MAX_BUY_SOL',c.buySol), minBuy:number('MIN_BUY_SOL',0.005),
    reserve:c.minSolReserve, feeBudget:(val('FEE_MODE','max')==='max'?number('TIP_MAX_SOL',0.002)+number('PRIORITY_FEE_MAX_SOL',0.001):c.tipSol+c.priorityFeeSol)+0.005,
    slippage:c.slippagePct, dailyCap:c.dailyCapSol>0?c.dailyCapSol:0, minLeaderUsd:c.minLeaderBuyUsd,
    maxAge:c.maxSignalAgeSec, maxSellAge:number('MAX_SELL_SIGNAL_AGE_SEC',300), pumpOnly:c.pumpOnly,
    oneBuy:c.oneBuyPerMint, autoSell:val('AUTO_SELL',demo?'true':'false')==='true', autoCopy:val('AUTO_COPY','true') === 'true', paperBalance:number('PAPER_BALANCE_SOL',1.65), dailyLossLimit:number('DAILY_LOSS_LIMIT_SOL',0),
    maxPositions:number('MAX_OPEN_POSITIONS',2), dailyCapUsd:number('DAILY_CAP_USD',600)};
  for (const k of ['multiplier','buySol','maxBuy','minBuy','reserve','feeBudget','slippage','dailyCap','minLeaderUsd','maxAge','maxSellAge','paperBalance','maxPositions','dailyCapUsd'])
    if (!Number.isFinite(out[k]) || out[k]<0) throw new Error('invalid setting '+k);
  // PAPER: the pretend balance never stops a study (on 2026-10-11 a 1 SOL cap stopped it after 10
  // trades and 14 Decu buys were never studied). PAPER_UNLIMITED=false restores the paper limits.
  if (out.dailyCap===0) out.dailyCap=Infinity; // DAILY_CAP_SOL=0 (default): no daily spending cap
  if (!['fixed','proportional'].includes(out.sizing) || out.minBuy<=0 || out.minBuy>out.maxBuy || out.maxBuy>out.dailyCap || out.multiplier>1) throw new Error('invalid sizing bounds (multiplier must be 0–1)');
  out.paperUnlimited = out.mode==='paper' && val('PAPER_UNLIMITED','true')==='true';
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
  const RULE={stoploss:'stop-loss','gain-target':'+15% gate','hold-limit':'10 min limit','no-price':'no price','sell-all':'sell everything','retry-sell':'retry'};
  const pc=x=>x==null||!Number.isFinite(x)?'?':`${x>=0?'+':''}${(x*100).toFixed(1)}%`;
  if (e.type==='confirmed' && e.side==='sell') {
    const how=e.rule?` (${RULE[e.rule]||e.rule})`:'';
    const fill=e.closed&&e.trigger!=null&&e.pnl!=null?`\nTriggered at ${pc(e.trigger)} · closed at ${pc(e.pnl)} (${Math.abs((e.pnl-e.trigger)*100).toFixed(1)} points ${e.pnl<e.trigger?'worse':'better'} than the trigger)`:'';
    return {title:`${tag}${e.closed?'POSITION CLOSED':'Sold part of'} ${short(e.mint)}${e.closed&&e.pnl!=null?` ${pc(e.pnl)}`:''}${how}`, body:`Received ${Number(e.solDelta).toFixed(4)} SOL after fees${fill}\nToken: ${e.mint}`, priority:4, tags:['moneybag'], click:mode==='live'?tx(e.signature):pump(e.mint)};
  }
  if (e.type==='submitted' && e.side==='sell' && mode==='live') return {title:`${tag}SELL SENT ${short(e.mint)}${e.rule?` (${RULE[e.rule]||e.rule})`:''}`, body:`Sell transaction sent; waiting for it to land.\nTx: ${e.signature}`, priority:3, tags:['outbox_tray'], click:tx(e.signature)};
  if (e.type==='price-check-failing') return {title:`${tag}Price checks failing: ${short(e.mint)}`, body:`${e.fails} price checks in a row failed (last known ${pc(e.last)}). The stop-loss cannot see the price. ${'The bot sells anyway if it keeps failing.'}\nToken: ${e.mint}`, priority:4, tags:['warning'], click:pump(e.mint)};
  if (e.type==='unsellable') return {title:`${tag}CAN'T SELL ${short(e.mint)}`, body:`${e.attempts} sell attempts failed: ${String(e.message||'').slice(0,200)}\nThe bot keeps trying. Check the coin; you may need to sell by hand in Phantom.\nToken: ${e.mint}`, priority:5, tags:['rotating_light'], click:pump(e.mint)};
  if (e.type==='breaker') return {title:`${tag}New buys paused (circuit breaker)`, body:e.message, priority:4, tags:['no_entry']};
  if (e.type==='power-off') return {title:`${tag}Bot OFF: no Helius or Solscan use`, body:`Not watching ${leaderLabel} and not using any data credits${e.open?` (${e.open} position(s) still open: no stop-loss while off)`:''}.\nTurn it back ON from the dashboard.${e.by&&e.by!=='dashboard'?`\n(${e.by})`:''}`, priority:3, tags:['zzz']};
  if (e.type==='power-on') return {title:`${tag}Bot ON: watching ${leaderLabel} again`, body:'Helius and Solscan are in use again.', priority:3, tags:['white_check_mark']};
  if (e.type==='failed') return {title:`${tag}Trade FAILED (${e.side})`, body:`${e.message||'unknown error'}\nToken: ${e.mint}\nNo tokens changed hands.`, priority:4, tags:['x'], click:pump(e.mint)};
  if (e.type==='unresolved') return {title:`${tag}Trade outcome UNKNOWN`, body:`${e.message||''}\nThe bot keeps checking and will not double-trade.\nTx: ${e.signature||'?'}`, priority:5, tags:['warning'], click:e.signature?tx(e.signature):undefined};
  if (e.type==='unsupported' && e.kind==='paid-with-pump') return {title:`${tag}${leaderLabel} bought with PUMP tokens (not copied)`, body:`He paid with PUMP tokens he held, not SOL. This bot buys with SOL only, so it skipped this one.\nToken: ${e.mint}`, priority:2, tags:['eyes'], click:pump(e.mint)};
  if (e.type==='exit-rule') {
    const p=e.pnl==null?'':` (${e.pnl>=0?'+':''}${(e.pnl*100).toFixed(1)}% incl. fees)`;
    const t={stoploss:[`STOP TRIGGERED: selling ${short(e.mint)}${p}`,`The coin fell ${e.move!=null?(e.move*100).toFixed(0)+'%':'20%+'} from the bot's entry price: selling everything now.`,4,'stop_sign'],'gain-target':[`+15% reached: selling ${short(e.mint)}${p}`,`It reached +15% within 15 s of ${leaderLabel}'s buy: selling now.`,3,'moneybag'],'hold-until-his-sell':[`Holding ${short(e.mint)} until ${leaderLabel} sells${p}`,`Never reached +15% within 15 s of ${leaderLabel}'s buy, so the bot waits for his sell (stop-loss still on).`,2,'hourglass'],'hold-limit':[`Time limit: selling ${short(e.mint)}${p}`,'Held 10 minutes without his sell: selling everything.',3,'alarm_clock'],'sell-all':[`Selling ${short(e.mint)} (sell everything)`,'The sell-everything button was pressed on the dashboard.',4,'rotating_light'],'no-price':[`NO PRICE: selling ${short(e.mint)}`,'The price could not be checked several times in a row, so the bot is selling to be safe.',4,'warning']}[e.rule];
    if (t) return {title:`${tag}${t[0]}`, body:`${t[1]}\nToken: ${e.mint}`, priority:t[2], tags:[t[3]], click:pump(e.mint)};
  }
  if (e.type==='provider-gap' && false) return {title:`${tag}Helius missed a ${leaderLabel} trade`, body:`Solscan caught it and the bot processed it late.\nTx: ${e.leaderSignature}`, priority:3, tags:['satellite'], click:tx(e.leaderSignature)};
  if (e.type==='emergency-stop') return {title:`${tag}EMERGENCY STOP`, body:`${e.message}\nTurn a trading style back ON in the dashboard to resume.`, priority:5, tags:['rotating_light']};
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
  // ENTRY-PREMIUM FILTER: skip a buy priced more than MAX_PAY_ABOVE_DECU_PCT (default 30) above Decu's
  // own price. FAIL-CLOSED: with no Decu price or no current price the bot does not buy. PAPER uses the
  // same filter (PAPER_MAX_PAY_PCT, default = the live value) so paper behaves like live; every buy it
  // skips is still studied (SKIPPED alerts), so the research keeps all of Decu's trades.
  const filterPct = number('MAX_PAY_ABOVE_DECU_PCT',15);
  // Extra filters only REPORTED (alerts, reports): "10%" and "25%". Skipped buys within the widest one are alerted.
  const reportPcts = String(val('FILTER_REPORT_PCTS','10,25')).split(',').map(Number).filter(x=>x>0);
  // FEES: current priority fee + tip (FEE_MODE=max: top of the market, refreshed in the background).
  const fee = () => k.fees ? k.fees() : {priorityFeeSol:k.config.priorityFeeSol, tipSol:k.config.tipSol};
  const sideFee = () => { const f=fee(); return f.priorityFeeSol+f.tipSol+0.000005; };
  // PRICE vs PRICE: the price per token that went into the curve, fees excluded, the same basis as
  // Decu's own trade event (his sol_amount is net of the pool fee). Fees are reported separately.
  const poolFee = (k.config.pumpFeePct ?? 1.25)/100;
  const netPrice = (solIn, raw, feeFrac=poolFee) => raw>0 ? solIn*(1-feeFrac)/raw : null;
  const solUsd = () => k.solUsdNow ? k.solUsdNow() : null;
  const maxPayPct = demo ? 0 : c.mode==='live' ? filterPct : number('PAPER_MAX_PAY_PCT',filterPct);
  const sellSlippagePct=number('SELL_SLIPPAGE_PCT',35), fastSells=val('FAST_PATH_SELLS','false')==='true';
  // CIRCUIT BREAKERS (new buys only; sells always run): BUY_FAIL_BREAKER (3) failed buys in a row ->
  // no new buys for BUY_FAIL_COOLDOWN_MIN (10); Helius websocket down for STALE_DATA_SEC (30) -> no
  // new buys until it is back (late signals mean a high entry premium).
  const breakerFails=number('BUY_FAIL_BREAKER',3), cooldownMs=number('BUY_FAIL_COOLDOWN_MIN',10)*60_000, staleMs=number('STALE_DATA_SEC',30)*1000;
  let failedBuysInRow=0, buyCooldownUntil=0, gateWsDownSince=null, exits=null, onSellFailed=null, exitSeq=0, stopped=false;
  c.gate=()=>{
    if(Date.now()<buyCooldownUntil) return `circuit breaker: ${breakerFails} buys failed in a row, new buys resume in ${Math.ceil((buyCooldownUntil-Date.now())/60000)} min`;
    if(demo || staleMs<=0) return null;
    if(status.websocket!=="subscribed") { gateWsDownSince??=Date.now(); if(Date.now()-gateWsDownSince>staleMs) return "market data stale: Helius websocket down"; }
    else gateWsDownSince=null;
    return null;
  };
  // Keep the journal from filling the disk: over 50 MB it moves to trades.log.1 at startup.
  try { if (fs.statSync(k.config.logFile).size > 50e6) fs.renameSync(k.config.logFile, k.config.logFile+'.1'); } catch {}
  const token = val('DASHBOARD_TOKEN','');
  if (!demo && !k.config.dryRun && token.length<24) throw new Error('LIVE requires DASHBOARD_TOKEN of at least 24 characters');
  const secrets = [token,k.config.privateKey,k.config.heliusKey,k.config.solscanKey,k.config.jupiterApiKey].filter(Boolean);
  const clean = v => { let s=JSON.stringify(v); for(const secret of secrets) s=s.split(secret).join('[REDACTED]'); return JSON.parse(k.redact(s)); };
  const log = e => {
    // Sell outcomes: was the position closed, and how did the fill compare with the exit trigger?
    if (e.type==='confirmed' && e.side==='sell' && engine) { const p=engine.d.positions[e.mint], x=exits?.get(e.mint); if(p) { e.closed=BigInt(p.raw||'0')===0n; if(e.closed && p.costSol>0) e.pnl=(p.realizedSol-p.costSol)/p.costSol; } if(x) { e.rule=x.rule; e.trigger=x.trigger; } if(e.closed) exits?.delete(e.mint); }
    if (e.type==='submitted' && e.side==='sell' && exits?.has(e.mint)) e.rule=exits.get(e.mint).rule;
    if (e.type==='failed' && e.side==='sell' && engine) setTimeout(()=>{ if(!stopped) onSellFailed?.(e.mint,e.message); },0).unref?.();
    if (e.type==='confirmed' && e.side==='buy') {
      failedBuysInRow=0;
      // the sell is armed now (if the local buy did not already) and the coin's details are saved with the
      // position, so a restart re-arms it without a lookup
      const kit=armSell(e.mint), p=engine?.d.positions[e.mint];
      if(p && kit) { if(kit.tokenProgram) p.tokenProgram??=kit.tokenProgram; if(kit.creator) p.creator??=kit.creator; }
    }
    if (e.type==='confirmed' && e.side==='sell' && e.closed) desk?.disarm(e.mint);
    // a failed sell may have used a wrong pushed balance: the retry reads the chain. A failed buy leaves
    // nothing to sell: its armed sell (and its token-account watch) goes too.
    if (e.type==='failed' && e.side==='sell') desk?.forgetBalance(e.mint);
    if (e.type==='failed' && e.side==='buy' && desk && engine && !(BigInt(engine.d.positions[e.mint]?.raw||'0')>0n)) desk.disarm(e.mint);
    if (e.type==='failed' && e.side==='buy' && !/entry premium|Decu price|current price|not bought/.test(e.message||'')) {
      if(++failedBuysInRow>=breakerFails && breakerFails>0) { failedBuysInRow=0; buyCooldownUntil=Date.now()+cooldownMs; setTimeout(()=>!stopped&&engine?.event('breaker',{message:`${breakerFails} buys failed in a row (last: ${String(e.message||'').slice(0,120)}). No new buys for ${cooldownMs/60000} min; sells and exit rules keep running.`}),0); }
    }
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
    if (study && e.type==='confirmed' && e.side==='buy') { const fo=fillOf(e.mint); study.start({mint:e.mint,cost:-e.solDelta,raw:e.rawDelta,entryPrice:fo.entryPrice,fill:fo,his:{...(refFor(e.mint)||{}),first:leaderBuys.get(e.mint)||null,latency:latencyOf(e.mint)}}); }
    // RESEARCH: a Decu buy the bot did NOT take is still studied (no trade): what it would have done.
    if (study && !demo && ((e.type==='skip' && e.side!=='sell' && e.mint && !/below minimum|already|no bot position|not a pump/.test(e.reason||'')) || (e.type==='failed' && e.side==='buy'))) shadowStudy(e.mint, e.reason||e.message||'not bought');
  };
  // PAPER ONLY: value each paper position at several sell timings (never sends anything).
  const QUICK=String(val('PAPER_QUICK_SELL_SEC','4,5')).split(',').map(Number).filter(x=>x>0);
  const AFTER=String(val('PAPER_AFTER_HIS_SELL_SEC','0,10')).split(',').map(Number).filter(x=>x>=0);
  const valueAt=(mint,label,delayMs)=>setTimeout(async()=>{
    try{
      const st=engine.d.paperStats?.[mint]; if(!st) return;
      const sol=await k.quoteSell(mint,Number(st.raw));
      st.exits[label]= sol==null||!Number.isFinite(sol) ? null : sol*0.995-sideFee(); engine.save();
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
  // Decu's FIRST buy of each coin (for PCAT and the entry premium). Bounded.
  const leaderBuys=new Map();
  // EXECUTION LATENCY: one timestamp per stage of each copy (ms since epoch unless noted):
  //  hisTime (his on-chain clock, whole seconds) · hisSlot · seenAt (our websocket/poll got it) ·
  //  decodedAt · buildStart · builtAt · sentAt (live) · landedAt · landSlot · simulatedMs (paper wait)
  // Keyed by HIS transaction: when Decu buys a coin twice and the bot copies the later buy, timing
  // and entry premium are measured against the buy that was copied, not his first one.
  const pipe=new Map(), copiedSig=new Map(), lastSig=new Map(), hisBySig=new Map();
  const hisKey=(sig,mint)=>`${sig}:${mint}`;
  const stampSig=(sig,mint,key,v=Date.now())=>{ const id=hisKey(sig,mint); let p=pipe.get(id); if(!p){ p={}; pipe.set(id,p); if(pipe.size>1000) pipe.delete(pipe.keys().next().value); } if(p[key]==null) p[key]=v; return p; };
  const stamp=(mint,key,v=Date.now())=>stampSig(copiedSig.get(mint)||lastSig.get(mint)||'unknown',mint,key,v);
  // The Decu buy a bot buy refers to: the one it copied, else his latest seen buy, else his first copyable one.
  const refFor=mint=>{ const sig=copiedSig.get(mint)||lastSig.get(mint); return (sig&&hisBySig.get(hisKey(sig,mint)))||leaderBuys.get(mint)||null; };
  const fillOf=mint=>{ const p=pipe.get(hisKey(copiedSig.get(mint)||lastSig.get(mint)||'unknown',mint))||{}; return {entryPrice:p.entryPrice??null, premiumAtBuild:p.premiumAtBuild??null, premiumAtFill:p.premiumAtFill??null, buyFeeSol:p.buyFeeSol??null, actualFill:!!p.actualFill}; };
  const latencyOf=mint=>{
    const p=pipe.get(hisKey(copiedSig.get(mint)||lastSig.get(mint)||'unknown',mint)); if(!p) return null;
    const d=(a,b)=>p[a]!=null&&p[b]!=null?Math.round(p[b]-p[a]):null;
    return {route:p.route||null, source:p.source||null, simulatedMs:p.simulatedMs??null,
      detectMs:p.hisTime&&p.seenAt?Math.round(p.seenAt-p.hisTime*1000):null, // his clock is whole seconds: about ±500 ms
      decodeMs:d('seenAt','decodedAt'), decideMs:d('decodedAt','buildStart'), buildMs:d('buildStart','builtAt'),
      sendMs:d('builtAt','sentAt'), landMs:d(p.sentAt!=null?'sentAt':'builtAt','landedAt'), botMs:d('seenAt','landedAt'),
      blocksAfter:p.hisSlot&&p.landSlot?p.landSlot-p.hisSlot:null, blocksEstimated:!!p.slotEstimated,
      // detection in BLOCKS (exact; no clock rounding): the block the bot was on when it saw his trade
      detectBlocks:p.hisSlot&&p.seenSlot!=null?Math.max(0,p.seenSlot-p.hisSlot):null};
  };
  // HOLDER RULE (your strategy): a market cap needs enough money in the holders' hands to hold up.
  // HOLDER_RULES "mcapUsd:heldUsd": the coins held by every wallet except the dev (and the curve) must be
  // worth at least $1000 at a $10k market cap, $2500 at $20k, $4000 at $30k. Less = RISKY.
  const holderRuleCfg = String(val('HOLDER_RULES','10000:1000,20000:2500,30000:4000')).split(',').map(x=>x.split(':').map(Number)).filter(([a,b])=>a>0&&b>0).sort((a,b)=>a[0]-b[0]);
  // the dev comes from Decu's trade event (written by pump.fun itself); the curve account is the fallback
  const holderSample = mint => k.holderStats(mint,{creator:creators.get(mint)}).catch(()=>null);
  const study = demo || val('STUDY','true')==='false' || !k.quoteSell ? null : createStudy({
    file:val('STUDY_FILE',path.resolve(`study-${c.mode}.jsonl`)), quoteSell:k.quoteSell, mode:c.mode, buySol:c.buySol,
    feeSol:()=>sideFee(), reportPcts, holderRule:holderRuleCfg, sampleHolders:k.holderStats&&!demo?holderSample:null, windowSec:number('STUDY_WINDOW_SEC',15), bandPct:number('BAND_PCT',10)/100, notesOpts:{stopLossPct:number('STOP_LOSS_PCT',20),gainGatePct:number('GAIN_GATE_PCT',15),maxPayPct:filterPct}, learnOpts:{gateSec:number('MAX_HOLD_SEC',15),maxPayPct:filterPct,reportEvery:number('LEARN_REPORT_EVERY',10),digestHours:number('LEARN_DIGEST_HOURS',24)}, label:k.config.leaderLabel,
    skippedAlerts:val('SKIPPED_ALERTS','report'), meta:k.tokenMeta||null, notify:k.notify?(a=>engine?.d.alertsOff?null:k.notify(a)):null, log:m=>engine?.event('connection',{message:m})});
  // A Decu buy the bot did not take (filtered, paused, style off, too late, failed): still priced
  // every second for 15 s from a quote of the same size, so the research data has no survivor bias.
  // Read-only; one quote per skipped buy, never on the trading path.
  const shadowDone=new Set();
  const shadowStudy=async(mint,reason)=>{
    try {
      const his=refFor(mint);
      if(!study || !his || his.usd<c.minLeaderUsd || shadowDone.has(mint) || study.active.has(mint) || engine.d.positions[mint]) return;
      shadowDone.add(mint); if(shadowDone.size>2000) shadowDone.delete(shadowDone.values().next().value);
      const q=await k.quoteBuy(mint,c.buySol*0.995);
      if(!q?.raw) return;
      study.start({mint,cost:c.buySol+sideFee(),raw:String(q.raw),entryPrice:netPrice(c.buySol*0.995,q.raw),his:{...his,first:leaderBuys.get(mint)||null,latency:latencyOf(mint)},shadow:String(reason).slice(0,160)});
    } catch {}
  };
  const receipt = async job => {
    const tx = await k.getTransaction(job.signature,2);
    if (!tx) return {status:'unresolved',error:'confirmed receipt not available yet'};
    if(tx.meta.err) return {status:'failed',error:JSON.stringify(tx.meta.err)};
    const idx=tx.transaction.message.accountKeys.findIndex(x=>(typeof x==='string'?x:x.pubkey)===k.kp.publicKey);
    if(idx<0) return {status:'unresolved',error:'wallet absent from receipt'};
    const sum = rows => (rows||[]).filter(x=>x.owner===k.kp.publicKey && x.mint===job.mint).reduce((a,x)=>a+BigInt(x.uiTokenAmount.amount),0n);
    const rawDelta=sum(tx.meta.postTokenBalances)-sum(tx.meta.preTokenBalances);
    if ((job.side==='buy' && rawDelta<=0n) || (job.side==='sell' && (rawDelta>=0n || -rawDelta>BigInt(job.raw)))) return {status:'unresolved',error:'receipt token delta does not match intended trade'};
    if(job.side==='buy' && Number.isInteger(tx.slot)) stamp(job.mint,'landSlot',tx.slot);
    // ACTUAL fill (live): the bot spends exactly job.sol into the trade, so its real price vs price is
    // job.sol after the pool fee / tokens received. Wallet change minus that = fees actually paid.
    if(job.side==='buy' && rawDelta>0n) { const lp=pipe.get(hisKey(copiedSig.get(job.mint)||lastSig.get(job.mint)||'unknown',job.mint)); const p=stamp(job.mint,'entryPrice',netPrice(job.sol,Number(rawDelta),lp?.feeFrac??poolFee)); p.buyFeeSol??=Math.max(0,-(tx.meta.postBalances[idx]-tx.meta.preBalances[idx])/1e9-job.sol); p.actualFill=true; }
    return {status:'confirmed',rawDelta:rawDelta.toString(),solDelta:(tx.meta.postBalances[idx]-tx.meta.preBalances[idx])/1e9};
  };
  const paperFill = async job => {
    const waitMs=demo?20:k.config.paperLandMs;
    await new Promise(r=>setTimeout(r,waitMs));
    const fee=sideFee();
    if(job.side==='buy') {
      const liveSlot=k.stream?.slot?.();
      const slotP=!demo&&liveSlot==null&&k.rpc?k.rpc('getSlot',[{commitment:'processed'}]).catch(()=>null):Promise.resolve(liveSlot??null);
      const q=demo?{raw:Math.floor(job.sol*1e9)}:await k.quoteBuy(job.mint,job.sol*0.995);
      if(!q?.raw) return {status:'failed',error:'no paper buy quote'};
      const pp=stamp(job.mint,'landedAt'); pp.simulatedMs=waitMs; const sl=await slotP; if(Number.isInteger(sl)) { pp.landSlot??=sl; pp.slotEstimated=true; }
      const ref=refFor(job.mint), maxPay=maxPayPct/100;
      if(maxPay>0 && !(ref?.sol>0 && ref.raw>0)) return {status:'failed',error:"no Decu price to check the entry premium against: not bought (fail-closed)"};
      const entry=netPrice(job.sol*0.995,q.raw); pp.entryPrice=entry; pp.buyFeeSol=fee;
      if(maxPay>0) { const gap=entry/(ref.sol/ref.raw)-1; pp.premiumAtFill=gap; if(gap>maxPay) return {status:'failed',error:`entry premium ${Math.round(gap*100)}% above Decu's price (limit ${Math.round(maxPay*100)}%): not bought`}; }
      if(job.quoteRaw && q.raw<job.quoteRaw/(1+k.config.slippagePct/100)) return {status:'failed',error:'paper landing price exceeded slippage limit'};
      return {status:'confirmed',rawDelta:BigInt(Math.floor(q.raw)).toString(),solDelta:-job.sol-fee};
    }
    // PAPER: assemble the same local sell live would send (not signed, never sent): proves the sell desk
    // works on every paper exit before any real money depends on it.
    if(desk && !demo && desk.kit(job.mint)) { try { const f=fee(); desk.build({mint:job.mint,raw:job.raw,slippagePct:sellSlippagePct,blockhash:'11111111111111111111111111111111',priorityLamports:Math.round(f.priorityFeeSol*1e9),tipAccount:k.TIP_ACCOUNTS?.[0]||null,tipLamports:Math.round(f.tipSol*1e9),closeAccount:job.chainRaw!=null&&job.raw===job.chainRaw,global:null}); status.paperSellBuilds=(status.paperSellBuilds||0)+1; } catch(e) { desk.stats.lastError=String(e?.message||e).slice(0,160); } }
    const sol=demo?Number(job.raw)/1e9:await k.quoteSell(job.mint,Number(job.raw));
    if(sol===null || !Number.isFinite(sol)) return {status:'failed',error:'no paper sell quote'};
    return {status:'confirmed',rawDelta:(-BigInt(job.raw)).toString(),solDelta:sol*0.995-fee};
  };
  let cachedBalance=null;
  const buyCtx=new Map(), creators=new Map(); // creators: each coin's dev, from Decu's own trade event (for the holder rule)
  const helpers = k.findProgramAddress ? {findProgramAddress:k.findProgramAddress,ata:k.ata,b58decode:k.b58decode,b58encode:k.b58encode} : null;
  const local = c.mode==='live' && val('LOCAL_BUILD','true')!=='false' && helpers ? {
    helpers, blockhash:startBlockhashCache(k.rpc,{intervalMs:number('BLOCKHASH_REFRESH_MS',3000),log:m=>status.lastError=m}), global:null,
  } : null;
  // THE SELL DESK (pumpbuild.mjs): one for the whole run, shared with the local buy builder. A coin is armed
  // the moment it is bought (same trade context as the buy), kept current by pushed prices and (live) a
  // pushed token balance, and disarmed only when fully sold. LOCAL_SELL=false: PumpPortal builds every sell.
  const desk = !demo && helpers && val('LOCAL_SELL','true')!=='false' ? createSellDesk({helpers, watchAccount: c.mode==='live' ? (pk,cb)=>k.stream?.watchAccount?.(pk,cb) ?? null : null}) : null;
  // paper has no wallet key: its sells are only assembled (never signed or sent), with a placeholder address
  const sellUser = c.mode==='live' ? k.kp?.publicKey : (k.b58encode ? k.b58encode(Buffer.alloc(32,1)) : null);
  const kitFrom = mint => { const ctx=buyCtx.get(mint), p=engine?.d.positions[mint];
    return {tokenProgram:ctx?.tokenProgram ?? p?.tokenProgram, creator:ctx?.creator ?? p?.creator, mayhem:ctx?.mayhem, feeBps:ctx?.feeBps, creatorFeeBps:ctx?.creatorFeeBps, user:sellUser,
      ...(ctx ? {curve:{vSol:ctx.vSol,vTok:ctx.vTok,complete:false,creator:ctx.creator,mayhem:ctx.mayhem},curveAt:ctx.at} : {})}; };
  const armSell = mint => (desk && sellUser ? desk.arm(mint, kitFrom(mint)) : null);
  // a coin held from before (restart, or bought before this version): token program from its mint account,
  // creator / flags / price from its curve. One or two reads, once.
  const armFromChain = async mint => {
    const kit=armSell(mint); if(!kit) return null;
    if(!kit.tokenProgram) { const r=await k.rpc('getAccountInfo',[mint,{encoding:'base64',commitment:'confirmed'}],4000).catch(()=>null); const owner=r?.value?.owner; if(owner===TOKEN_2022||owner===TOKEN) desk.arm(mint,{tokenProgram:owner}); }
    const cv=k.readCurve ? await k.readCurve(mint).catch(()=>null) : null; if(cv) { desk.update(mint,cv); desk.arm(mint,{creator:cv.creator}); }
    return desk.kit(mint);
  };
  const refreshGlobal=()=>local && !engine?.d.dataOff && readGlobal(k.rpc,local.helpers).then(g=>{local.global=g;}).catch(e=>{status.lastError='pump.fun global: '+e.message;});
  refreshGlobal();
  const globalTimer=local?setInterval(refreshGlobal,600_000):null; globalTimer?.unref?.();
  const adapter = {
    // Wallet balance is refreshed every 10 s in the background; sizing uses it if under 15 s old.
    // The full simulation before every send still checks the real balance.
    balance:async()=>(cachedBalance && Date.now()-cachedBalance.at<15_000 ? cachedBalance.sol : (cachedBalance={sol:await k.getBalanceSol(k.kp.publicKey),at:Date.now()}).sol),
    tokens: async mint => {
      // the wallet's balance of the coin is pushed while it is held: no round trip before a sell
      const pushed=desk?.balance(mint); if(pushed!=null) { status.pushedBalances=(status.pushedBalances||0)+1; return pushed.toString(); }
      const r=await k.rpc('getTokenAccountsByOwner',[k.kp.publicKey,{mint},{encoding:'jsonParsed',commitment:'confirmed'}]);
      return r.value.reduce((a,x)=>a+BigInt(x.account.data.parsed.info.tokenAmount.amount),0n).toString();
    },
    build: async job => {
      if(c.mode!=='live') {
        let quoteRaw;
        // Like the live local builder: the expected tokens come from Decu's own trade event (his curve
        // state after his buy), no network. A buy seen without his trade event asks the chain instead.
        const ctx=job.side==='buy' && !demo ? buyCtx.get(job.mint) : null;
        if(ctx) { try { quoteRaw=Number(tokensOut(ctx,Math.floor(job.sol*0.995*1e9))); } catch { quoteRaw=undefined; } }
        if(job.side==='buy' && !demo && !(quoteRaw>0)) {const q=await k.quoteBuy(job.mint,job.sol*0.995);if(!q?.raw)throw new Error('no paper build quote');quoteRaw=q.raw;}
        return {signature:'paper-'+crypto.randomUUID(),quoteRaw};
      }
      // SOL balance from the 10 s cache for buys AND sells (a sell only checks it covers the fees; the
      // simulation before sending checks the real wallet)
      let balance=await adapter.balance();
      if(job.side==='buy' && balance-job.reserveSol<c.reserve) throw new Error('fresh balance insufficient for fees/reserve');
      // a sell needs SOL for its fees (both builders): a short cached balance is read again before refusing
      if(job.side==='sell') { const sf=fee(), need=c.reserve+sf.tipSol+sf.priorityFeeSol; if(balance<need) { cachedBalance=null; balance=await adapter.balance(); if(balance<need) throw new Error('insufficient SOL for sell fees'); } }
      // FASTEST: build the buy locally from his trade event (no PumpPortal round trip, no waiting
      // for a blockhash). Same safety check and full simulation as every other trade.
      if(job.side==='buy' && local) {
        const ctx=buyCtx.get(job.mint), blockhash=local.blockhash?.get();
        if(ctx && blockhash && local.global) {
          try {
            const t0=Date.now();
            const f=fee(), tip=f.tipSol>0 ? k.TIP_ACCOUNTS[Math.floor(Math.random()*k.TIP_ACCOUNTS.length)] : null;
            const ref=refFor(job.mint), maxPay=maxPayPct/100;
            // the chain enforces the max-pay guard: the buy fails (fee only) if the price ran past it
            if(maxPay>0 && !(ref?.sol>0 && ref.raw>0)) throw new Error('no Decu price to check the entry premium against: not bought (fail-closed)');
            // price vs price: the SOL that reaches the curve (after the pool + creator fee in HIS trade event)
            const feeFrac=Number((ctx.feeBps??0n)+(ctx.creatorFeeBps??0n))/10000 || poolFee;
            const minTokensFloor=maxPay>0 ? BigInt(Math.floor(job.sol*(1-feeFrac)/((ref.sol/ref.raw)*(1+maxPay)))) : 0n;
            stamp(job.mint,'feeFrac',feeFrac);
            const {bytes}=buildBuyTransaction({user:k.kp.publicKey,minTokensFloor,ctx:{...ctx,feeRecipient:pickFeeRecipient(local.global,ctx.mayhem),buybackRecipient:pickBuybackRecipient(local.global)},lamports:Math.floor(job.sol*1e9),slippagePct:k.config.slippagePct,blockhash,priorityLamports:Math.round(f.priorityFeeSol*1e9),tipAccount:tip,tipLamports:Math.round(f.tipSol*1e9)},local.helpers);
            const signed=k.signTransaction(bytes,k.kp);
            // its sell is armed (and its token balance watched) while the safety check below waits on the
            // network: ready before the buy lands, at no cost to the buy (not if the buy already failed)
            setImmediate(()=>{ try { if(engine.d.jobs[job.mint] || BigInt(engine.d.positions[job.mint]?.raw||'0')>0n) armSell(job.mint); } catch {} });
            await k.validateTrade(signed.bytes,job,balance,f.priorityFeeSol+f.tipSol);
            status.localBuilds=(status.localBuilds||0)+1; status.lastLocalBuildMs=Date.now()-t0;
            return {signature:signed.signature,bytes:signed.bytes.toString('base64'),blockhash,built:'local'};
          } catch(e) { engine.event('connection',{message:'local build failed, using PumpPortal: '+e.message}); }
        }
      }
      // LOCAL SELL: from the desk, no PumpPortal round trip. The freshest price: the pushed curve if under
      // 3 s old, else read now (one RPC). Sells the whole on-chain balance -> also closes the token account
      // (rent back); if that close is refused by the simulation, the same sell again without it; then PumpPortal.
      if(job.side==='sell' && local && desk) {
        try {
          const t0=performance.now();
          let kit=desk.kit(job.mint); if(!kit?.tokenProgram || !kit?.creator) kit=await armFromChain(job.mint);
          if(['no curve state','curve state too old'].includes(desk.blocker(job.mint))) { const cv=k.readCurve?await k.readCurve(job.mint).catch(()=>null):null; if(cv) desk.update(job.mint,cv); }
          const why=desk.blocker(job.mint); if(why) throw new Error(why);
          const blockhash=local.blockhash?.get(); if(!blockhash) throw new Error('no fresh blockhash');
          const f=fee(), tip=f.tipSol>0 ? k.TIP_ACCOUNTS[Math.floor(Math.random()*k.TIP_ACCOUNTS.length)] : null;
          const empties=job.chainRaw!=null && BigInt(job.raw)===BigInt(job.chainRaw) && val('CLOSE_TOKEN_ACCOUNT','true')!=='false';
          let lastErr=null;
          for(const closeAccount of empties?[true,false]:[false]) {
            try {
              const b=desk.build({mint:job.mint,raw:job.raw,slippagePct:sellSlippagePct,blockhash,priorityLamports:Math.round(f.priorityFeeSol*1e9),tipAccount:tip,tipLamports:Math.round(f.tipSol*1e9),closeAccount,global:local.global});
              const signed=k.signTransaction(b.bytes,k.kp);
              await k.validateTrade(signed.bytes,job,balance,f.priorityFeeSol+f.tipSol);
              status.localSells=(status.localSells||0)+1; status.lastLocalSellMs=Math.round(performance.now()-t0); if(closeAccount) desk.stats.closes++;
              return {signature:signed.signature,bytes:signed.bytes.toString('base64'),blockhash,built:'local',closeAccount,minSolOut:String(b.minSolOut)};
            } catch(e) { lastErr=e; if(!closeAccount) break; }
          }
          throw lastErr;
        } catch(e) { desk.stats.fallbacks++; desk.stats.lastError=String(e?.message||e).slice(0,160); engine.event('connection',{message:'local sell build failed, using PumpPortal: '+desk.stats.lastError}); }
      }
      const ppFee=fee();
      const decimals=job.decimals;
      if (job.side==='sell' && (!Number.isInteger(decimals) || decimals<0 || decimals>18)) throw new Error('unknown token decimals');
      // Exact token quantity in decimal text; never sell tokens outside the bot position.
      const raw=job.side==='sell'?job.raw.padStart(decimals+1,'0'):'';
      const amount=job.side==='buy'?job.sol:decimals?raw.slice(0,-decimals)+'.'+raw.slice(-decimals):raw;
      const ref=refFor(job.mint), checkPrem=job.side==='buy' && maxPayPct>0;
      if(checkPrem && !(ref?.sol>0 && ref.raw>0)) throw new Error('no Decu price to check the entry premium against: not bought (fail-closed)');
      const premQ=checkPrem ? k.quoteBuy(job.mint,job.sol*0.995).catch(()=>null) : null;
      let bytes=await k.http('https://pumpportal.fun/api/trade-local',{method:'POST',raw:true,body:{publicKey:k.kp.publicKey,action:job.side,mint:job.mint,amount,denominatedInSol:job.side==='buy'?'true':'false',slippage:job.side==='sell'?sellSlippagePct:k.config.slippagePct,priorityFee:ppFee.priorityFeeSol,pool:'auto'}});
      const pq=await premQ;
      if(checkPrem && !pq?.raw) throw new Error('no current price to check the entry premium: not bought (fail-closed)');
      if(checkPrem) { const prem=netPrice(job.sol*0.995,pq.raw)/(ref.sol/ref.raw)-1; stamp(job.mint,'premiumAtBuild',prem); if(prem>maxPayPct/100) throw new Error(`entry premium ${Math.round(prem*100)}% above Decu's price (MAX_PAY_ABOVE_DECU_PCT ${maxPayPct}%): not bought`); }
      if(ppFee.tipSol>0) bytes=k.addTransferInstruction(bytes,k.TIP_ACCOUNTS[Math.floor(Math.random()*k.TIP_ACCOUNTS.length)],Math.round(ppFee.tipSol*1e9));
      const signed=k.signTransaction(bytes,k.kp);
      await k.validateTrade(signed.bytes,job,balance,ppFee.priorityFeeSol+ppFee.tipSol);
      return {signature:signed.signature,bytes:signed.bytes.toString('base64'),blockhash:k.transactionBlockhash(bytes)};
    },
    send: async job => {
      if(c.mode!=='live') return paperFill(job);
      await k.sendRaw(Buffer.from(job.bytes,'base64'),fee().tipSol>0?[k.senderUrl()]:[]);
      if(job.side==='buy') stamp(job.mint,'sentAt');
      const r=await k.confirm(job.signature);
      if(job.side==='buy') stamp(job.mint,'landedAt');
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
  // Time the build stage of every buy (execution-latency breakdown).
  const buildTx=adapter.build;
  adapter.build=async job=>{
    if(job.side==='buy') {
      if(job.sig) copiedSig.set(job.mint,job.sig); if(copiedSig.size>2000) copiedSig.delete(copiedSig.keys().next().value);
      // a new attempt starts with clean timings (an earlier attempt's stamps once made a buy look 111 s slow)
      const pe=pipe.get(hisKey(copiedSig.get(job.mint)||lastSig.get(job.mint)||'unknown',job.mint));
      if(pe?.buildStart!=null) for(const key of ['buildStart','builtAt','sentAt','landedAt','landSlot','slotEstimated','route','simulatedMs','entryPrice','premiumAtFill','premiumAtBuild','buyFeeSol','actualFill','feeFrac']) delete pe[key];
      stamp(job.mint,'buildStart');
    }
    const out=await buildTx(job);
    if(job.side==='buy') { const p=stamp(job.mint,'builtAt'); p.route??=out.built||(c.mode==='live'?'pumpportal':'paper'); }
    return out;
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
  const monitors=new Map();
  // STOP-LOSS RELIABILITY:
  //  - priced every MONITOR_MS (500 ms), each price check gives up after QUOTE_TIMEOUT_MS (1500 ms)
  //  - PRICE_FAIL_ALERT (3) failed checks in a row -> alert; PRICE_FAIL_SELL (6) -> sell anyway
  //    (a coin the bot cannot price may be crashing), 0 = never sell blind
  //  - sells use SELL_SLIPPAGE_PCT (35) so a falling coin still fills; a failed sell is retried
  //    SELL_RETRIES (3) times at once, then "CAN'T SELL" is alerted and the bot keeps trying
  //  - alerts: STOP TRIGGERED -> SELL SENT (live) -> POSITION CLOSED with trigger vs fill
  const monitorMs=number('MONITOR_MS',500), quoteTimeoutMs=number('QUOTE_TIMEOUT_MS',1500);
  const priceFailAlert=number('PRICE_FAIL_ALERT',3), priceFailSell=number('PRICE_FAIL_SELL',6), sellRetries=number('SELL_RETRIES',3);
  exits=new Map();
  const exitNow=(mint,p,rule,pnl,move,attempt=0)=>{
    if(stopped) return Promise.resolve();
    monitors.delete(mint);
    let x=exits.get(mint);
    if(!attempt || !x) { x={rule,trigger:pnl,move,at:Date.now(),attempts:0,unsellableAt:x?.unsellableAt||0}; exits.set(mint,x); engine.event('exit-rule',{mint,rule,pnl,move}); }
    x.attempts=attempt;
    return engine.ingest({sig:`${rule}-${mint}-${p.boughtAt||0}-${++exitSeq}`,side:'sell',mint,soldRaw:'1',beforeRaw:'1',time:Date.now()/1000,decimals:mintDecimals.get(mint)??6,force:true})
      .catch(err=>engine.event('error',{mint,message:`${rule} sell: ${err.message}`}));
  };
  onSellFailed=(mint,message)=>{
    const p=engine.d.positions[mint];
    if(!p || BigInt(p.raw||'0')<=0n || (!engine.d.autoCopy && !stopLossManual)) return;
    const x=exits.get(mint)||{rule:'retry-sell',attempts:0,at:Date.now(),unsellableAt:0}; exits.set(mint,x);
    if(x.attempts<sellRetries) { setTimeout(()=>exitNow(mint,p,x.rule,null,null,x.attempts+1),300).unref?.(); return; }
    if(Date.now()-x.unsellableAt>300_000) { x.unsellableAt=Date.now(); engine.event('unsellable',{mint,attempts:x.attempts+1,message}); }
    x.attempts=0; setTimeout(()=>{ if(!stopped) scheduleMaxHold(mint); },10_000).unref?.(); // keep watching; the stop re-triggers the sell
  };
  // PRICE WATCH per held coin. PUSH first: every change of its bonding curve arrives over the websocket
  // and is evaluated at once (no waiting for the next check). The curve only changes when someone trades,
  // so a pushed state stays current while its subscription is live. POLL as the backup every MONITOR_MS
  // (and for coins that left the curve for PumpSwap, priced by Jupiter).
  status.priceChecks={push:0,poll:0,pollMsLast:null};
  scheduleMaxHold=(mint)=>{
    if(monitors.has(mint) || !k.quoteSell || engine.d.dataOff) return; // power off: no price checks (on: restarted)
    const m={peak:-Infinity,decided:false,fails:0,pushed:null,unwatch:null,busy:false,again:false}; monitors.set(mint,m);
    const alive=()=>monitors.get(mint)===m && !stopped;
    const unwatch=()=>{ try{ m.unwatch?.(); }catch{} m.unwatch=null; };
    if(desk && !desk.kit(mint)) armSell(mint); // e.g. after a restart: re-armed from the saved position
    if(k.watchCurve) { try { m.unwatch=k.watchCurve(mint,(curve,at)=>{ if(!alive()) return unwatch(); m.pushed={curve,at}; desk?.update(mint,curve,at); if(!curve.complete) evaluate('push'); }); } catch { m.unwatch=null; } }
    const valueNow=async(p)=>{
      // a push from before a websocket reconnect may have missed trades made while it was down: poll until the next one
      const since=m.unwatch?.readyAt?.();
      if(m.pushed && !m.pushed.curve.complete && m.unwatch?.ready?.() && !(since!=null && m.pushed.at<since) && k.curveSell) { status.priceChecks.push++; return k.curveSell(m.pushed.curve,Number(p.raw)); }
      const t0=Date.now();
      const v=await Promise.race([k.quoteSell(mint,Number(p.raw)),new Promise(r=>setTimeout(()=>r(null),quoteTimeoutMs).unref?.())]).catch(()=>null);
      status.priceChecks.poll++; status.priceChecks.pollMsLast=Date.now()-t0;
      return v;
    };
    const evaluate=async(trigger)=>{
      if(!alive()) return unwatch();
      if(m.busy) { m.again=true; return; }
      m.busy=true;
      try {
        const p=engine.d.positions[mint];
        if(!p || BigInt(p.raw)<=0n) { monitors.delete(mint); if(!engine.d.jobs[mint] && !engine.d.queues[mint]?.length) desk?.disarm(mint); return unwatch(); }
        const auto=engine.d.autoCopy, age=Date.now()-(p.boughtAt||Date.now());
        // The 15 s gate counts from DECU'S buy (his on-chain time), not the bot's; bot time if unknown.
        const his=refFor(mint), bought=p.boughtAt||Date.now(), hisMs=his?.time>0 && bought-his.time*1000<=60e3 ? his.time*1000 : bought, sinceHis=Date.now()-hisMs; // >60 s apart: not his matching buy
        let pnl=null;
        const v=await valueNow(p);
        if(Number.isFinite(v) && p.costSol>0) pnl=(v*0.995-sideFee()-p.costSol)/p.costSol;
        if(!alive()) return unwatch();
        if(pnl!=null) { m.peak=Math.max(m.peak,pnl); m.last=pnl; m.base??=pnl; m.fails=0; status.lastPriceOkAt=Date.now(); }
        else if(trigger==='tick') {
          m.fails++;
          if(m.fails===priceFailAlert) engine.event('price-check-failing',{mint,fails:m.fails,last:m.last??null});
          if(priceFailSell>0 && m.fails>=priceFailSell && (auto||stopLossManual)) { unwatch(); return exitNow(mint,p,'no-price',m.last??null,null); }
        }
        const move=pnl==null?null:stopFromEntry?(1+pnl)/(1+m.base)-1:pnl;
        // The stop-loss ALWAYS sells, in both trading styles.
        if(move!=null && stopLoss>0 && move<=-stopLoss && (auto||stopLossManual)) { unwatch(); return exitNow(mint,p,'stoploss',pnl,move); }
        if(auto && maxHoldMs>0 && sinceHis>=maxHoldMs && !m.decided) {
          m.decided=true;
          if(m.peak>=gainGate) { unwatch(); return exitNow(mint,p,'gain-target',pnl); }
          engine.event('exit-rule',{mint,rule:'hold-until-his-sell',pnl,peak:Number.isFinite(m.peak)?m.peak:null});
        }
        if(auto && holdLimitMs>0 && age>=holdLimitMs) { unwatch(); return exitNow(mint,p,'hold-limit',pnl); }
      } finally { m.busy=false; }
      if(m.again && alive()) { m.again=false; return evaluate('push'); }
    };
    const tick=async()=>{ if(!alive()) return unwatch(); await evaluate('tick'); if(alive()) setTimeout(tick,monitorMs).unref?.(); else unwatch(); };
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
      // GAP_ALERTS (default off): missed-trade reports stay in the log and the dashboard, no phone alert.
      if(demo || !k.notify || engine.d.alertsOff || !list.length || val('GAP_ALERTS','false')!=='true') return;
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
  const recordLeaderBuy=s=>{ remember(hisBySig,hisKey(s.sig,s.mint),{sol:s.sol,raw:Number(s.raw)||0,usd:s.usd,time:s.time,sig:s.sig}); remember(lastSig,s.mint,s.sig); const old=leaderBuys.get(s.mint); if(!old || (old.usd<c.minLeaderUsd && s.usd>=c.minLeaderUsd)) remember(leaderBuys,s.mint,{sol:s.sol,raw:Number(s.raw)||0,usd:s.usd,time:s.time}); };
  let lastErrorEventAt=0, hiddenErrors=0;
  const fullPathDelayMs=number('FULL_PATH_DELAY_MS',500);
  const onSignature=async(sig,source='poll',logs,slot)=>{
    const seenAt=Date.now(), seenSlot=k.stream?.slot?.() ?? null;
    let fastBuyOnly=false;
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
        // his full trade context (local builder) and the coin's dev (holder rule); never blocks the buy
        try { const ctx=k.b58encode?buyContextFromLogs(logs,k.config.leader,k.b58encode):null; if(ctx) { remember(buyCtx,ctx.mint,ctx); if(ctx.creator) remember(creators,ctx.mint,ctx.creator); } } catch {}
        const buys=k.leaderPumpBuys(logs,k.config.leader);
        // a buy the fast path already handled: its full transaction is only needed later (records, gaps)
        fastBuyOnly=buys.length>0 && !(k.leaderPumpSells?.(logs,k.config.leader)?.length);
        for(const ev of buys) {
          const s={sig,time:ev.timestamp||Date.now()/1000,side:'buy',mint:ev.mint,sol:ev.solAmount/1e9,raw:String(ev.tokenAmount),pump:true,decimals:6,fast:true};
          const tp=stampSig(sig,ev.mint,'seenAt',seenAt); if(seenSlot!=null) stampSig(sig,ev.mint,'seenSlot',seenSlot); stampSig(sig,ev.mint,'hisTime',ev.timestamp); if(Number.isInteger(slot)) stampSig(sig,ev.mint,'hisSlot',slot); stampSig(sig,ev.mint,'decodedAt'); tp.source??='websocket (fast path)';
          s.usd=s.sol*(solUsd() ?? await k.getSolUsd()); recordLeaderBuy(s); remember(mintDecimals,s.mint,6); status.fastSignals=(status.fastSignals||0)+1;
          await engine.ingest(s);
        }
        // His SELL is only acted on once it is confirmed on-chain (full path below, ~0.4 s later), so an
        // unconfirmed or failed sell of his can never make the bot sell. FAST_PATH_SELLS=true restores the old way.
        if(sellAll && fastSells && k.leaderPumpSells) for(const ev of k.leaderPumpSells(logs,k.config.leader)) {
          const s={sig,time:ev.timestamp||Date.now()/1000,side:'sell',mint:ev.mint,sol:ev.solAmount/1e9,soldRaw:'1',beforeRaw:'1',decimals:mintDecimals.get(ev.mint)??6,fast:true};
          study?.leaderSell(s.mint,s); await engine.ingest(s);
        }
      } catch(e) { engine.event('error',{leaderSignature:sig,message:'fast path: '+e.message}); }
    }
    if(completed.has(sig)||inFlight.has(sig)) return;
    inFlight.add(sig);
    try {
      // Decu's buy was already acted on from the websocket: fetch the full transaction once it can exist
      // (confirmed, ~0.5 s later) instead of retrying for it while the bot's own buy uses the connection.
      if(fastBuyOnly && fullPathDelayMs>0) await new Promise(r=>setTimeout(r,fullPathDelayMs));
      const tx=await k.getTransaction(sig);
      if(!tx) throw new Error('transaction not available yet; will retry');
      // LaunchLab / bonk.fun / any non-pump.fun coin: ignored completely (no copy, no study, no alert).
      const venue=k.venueOf?k.venueOf(tx.meta?.logMessages||[]):'?', pumpVenue=['pump.fun','PumpSwap'].includes(venue);
      const all=normalize(tx,k.config.leader,k.detectBuy,k.detectSell), signals=all.filter(s=>!(c.pumpOnly && (s.side==='buy'?!s.pump:!pumpVenue && !engine.d.positions[s.mint])));
      if(signals.length<all.length) status.ignoredVenue=(status.ignoredVenue||0)+1;
      if(k.b58encode && tx.meta?.logMessages && signals.some(s=>s.side==='buy')) try { const ctx=buyContextFromLogs(tx.meta.logMessages,k.config.leader,k.b58encode); if(ctx) { if(!buyCtx.has(ctx.mint)) remember(buyCtx,ctx.mint,ctx); if(ctx.creator && !creators.has(ctx.mint)) remember(creators,ctx.mint,ctx.creator); } } catch {}
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
        if(s.side==='buy') { s.usd=s.sol*(solUsd() ?? await k.getSolUsd()); recordLeaderBuy(s); const tp=stampSig(sig,s.mint,'seenAt',seenAt); if(seenSlot!=null) stampSig(sig,s.mint,'seenSlot',seenSlot); stampSig(sig,s.mint,'hisTime',tx.blockTime); if(Number.isInteger(tx.slot)) stampSig(sig,s.mint,'hisSlot',tx.slot); stampSig(sig,s.mint,'decodedAt'); tp.source??=source==='ws'?'websocket':source; }
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
  // POWER (dashboard ON / OFF): OFF stops everything that uses Helius or Solscan credits: Decu's
  // websocket + backup poll, the Solscan watcher, the push stream, SOL price / fee / balance refreshes and
  // price checks of held coins. The dashboard stays up. Saved, so it survives restarts. BOT_POWER on the
  // server (on / off) wins once when it is changed; after that the button decides.
  let stopWatcher=()=>{}, stopSolscan=()=>{}, dataRunning=false;
  const powerOff=()=>!!engine.d.dataOff;
  const startData=()=>{
    if(demo || dataRunning) return; dataRunning=true;
    k.power?.on();
    stopWatcher=k.startWatcher(onSignature,{log:message=>engine.event('connection',{message}),status});
    stopSolscan=!k.startSolscanWatcher?()=>{}:k.startSolscanWatcher(onSignature,{log:message=>engine.event('connection',{message}),status,schedule:solscanSchedule});
    status.solscan = k.startSolscanWatcher ? {ok:null,note:'starting'} : {ok:false,note:'SOLSCAN_API_KEY not set: Helius only'};
    if(local && !local.blockhash) local.blockhash=startBlockhashCache(k.rpc,{log:m=>status.lastError=m});
    for(const [mint,p] of Object.entries(engine.d.positions)) if(BigInt(p.raw||'0')>0n) scheduleMaxHold(mint); // price checks again
  };
  const stopData=()=>{
    if(demo) return; dataRunning=false;
    stopWatcher(); stopSolscan(); stopWatcher=stopSolscan=()=>{};
    k.power?.off();
    local?.blockhash?.stop(); if(local) local.blockhash=null;
    for(const m of monitors.values()) { try{ m.unwatch?.(); }catch{} } monitors.clear(); // no price checks while off
    status.websocket='off (power off)'; status.solscan={ok:null,note:'off (power off)'};
  };
  const openNow=()=>Object.values(engine.d.positions).filter(p=>BigInt(p.raw||'0')>0n).length+Object.keys(engine.d.jobs).length;
  // SOLSCAN SCHEDULE (100 CU per request; the plan has 20M CU a month). Solscan only adds something when
  // Helius misses a trade, and a buy it finds is already 5-30 s old (too expensive to copy). What matters
  // is a missed SELL of a coin the bot holds. So: every SOLSCAN_IDLE_SEC (600) while Helius is healthy and
  // nothing is held, SOLSCAN_HOLDING_SEC (30) while coins are held or trades are in flight,
  // SOLSCAN_DOWN_SEC (15) while the Helius websocket is down; nothing when off or the daily budget is used.
  const solscanSchedule=()=>{
    if(powerOff()) return {ms:Infinity,mode:'off (power off)'};
    const u=k.solscanUsage?.(); if(u && u.left<=0) return {ms:Infinity,mode:`daily budget used (${u.requests}/${u.budget}): paused until 00:00 UTC`};
    if(status.websocket!=='subscribed') return {ms:number('SOLSCAN_DOWN_SEC',15)*1000,mode:'Helius websocket down: Solscan watching'};
    if(openNow()>0) return {ms:number('SOLSCAN_HOLDING_SEC',30)*1000,mode:'coins held: watching for a missed sell'};
    return {ms:number('SOLSCAN_IDLE_SEC',600)*1000,mode:'standby (Helius healthy, nothing held)'};
  };
  /** on: true / false. Refused in LIVE while coins are held or trades are in flight (their stop-loss and
   *  confirmation need data) unless force. Returns the problem, or null when done. */
  const setPower=(on,{force=false,by='dashboard'}={})=>{
    if(!on && c.mode==='live' && openNow()>0 && !force) return `${openNow()} open position(s) or trade(s) in flight: turning off would stop their stop-loss. Sell them first, or turn off anyway.`;
    engine.d.dataOff=!on;
    if(on) startData(); else stopData();
    engine.event(on?'power-on':'power-off',{by,open:openNow()});
    return null;
  };
  if(!demo) {
    const envPower=val('BOT_POWER','').toLowerCase();
    if(['on','off'].includes(envPower) && engine.d.powerEnv!==envPower) { engine.d.powerEnv=envPower; engine.d.dataOff=envPower==='off'; engine.save(); }
    if(powerOff()) { stopData(); engine.event('power-off',{by:'saved setting at startup',open:openNow()}); } else startData();
  }
  const timer=setInterval(()=>engine.recover().catch(e=>engine.event('error',{message:e.message})),5000);
  // WATCHDOG: alert when Helius (websocket) or Solscan stays down, and when it recovers;
  // plus a "healthy" check-in every HEALTH_ALERT_HOURS (12). Respects the alerts on/off switch.
  const startedAt=Date.now(); let wsDownSince=null, wsAlerted=false, scDownSince=null, scAlerted=false, lastHealth=Date.now();
  const say=a=>{ if(!demo && k.notify && !engine.d.alertsOff) Promise.resolve(k.notify(a)).catch(()=>{}); };
  const tag=c.mode==='live'?'':'[PAPER] ';
  const watchdog=demo?null:setInterval(()=>{
    const now=Date.now();
    if(powerOff()) { wsDownSince=scDownSince=null; return; } // switched off on purpose: nothing to report
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
  const balanceTimer=c.mode==='live'?setInterval(()=>powerOff()?null:k.getBalanceSol(k.kp.publicKey).then(b=>{status.balance=b;cachedBalance={sol:b,at:Date.now()};}).catch(e=>engine.event('error',{message:e.message})),10000):null;
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
        const snap={...engine.snapshot(),power:engine.d.dataOff?'off':'on',solscanUsage:k.solscanUsage?.()||null,paper:c.mode==='paper'?paperSummary(engine.d.paperStats):undefined,balance:c.mode==='live'?(status.balance??null):engine.d.paperBalance,connection:status,
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
      // POWER: OFF = no Helius / Solscan use at all (dashboard stays up). ?force=1 turns off with coins held (LIVE).
      if(req.method==='POST' && ['/api/power/on','/api/power/off'].includes(url.pathname)) {
        const problem=setPower(url.pathname.endsWith('/on'),{force:url.searchParams.get('force')==='1'});
        if(problem) { res.writeHead(409,{'Content-Type':'text/plain'}); return res.end(problem); }
        res.writeHead(200); return res.end('OK');
      }
      if(req.method==='POST' && ['/api/pause','/api/resume'].includes(url.pathname)) {
        engine.pause(url.pathname==='/api/pause');res.writeHead(200);return res.end('OK');
      }
      if(req.method==='POST' && ['/api/alerts/on','/api/alerts/off'].includes(url.pathname)) {
        engine.mute(url.pathname==='/api/alerts/off');res.writeHead(200);return res.end('OK');
      }
      const style=url.pathname.match(/^\/api\/style\/(auto|manual|off)$/);
      if(req.method==='POST' && style) {engine.style(style[1]);res.writeHead(200);return res.end('OK');}
      // EMERGENCY STOP: no new buys (both styles off). SELL ALL: sell every open position now (LIVE = real).
      if(req.method==='POST' && url.pathname==='/api/emergency') { engine.style('off'); engine.event('emergency-stop',{message:'emergency stop from the dashboard: no new buys'}); engine.save(); res.writeHead(200); return res.end('OK'); }
      if(req.method==='POST' && url.pathname==='/api/sell-all') {
        engine.style('off'); const held=Object.entries(engine.d.positions).filter(([,p])=>BigInt(p.raw||'0')>0n);
        for(const [mint,p] of held) exitNow(mint,p,'sell-all',null);
        engine.event('emergency-stop',{message:`sell everything from the dashboard: ${held.length} position(s)`}); res.writeHead(200); return res.end(String(held.length));
      }
      if(url.pathname==='/api/export.csv' && req.method==='GET') {const {toCsv}=await import('./study.mjs');res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="decu-trades-${c.mode}-${new Date().toISOString().slice(0,10)}.csv"`});return res.end(toCsv(study?study.records:[]));}
      if(url.pathname==='/api/research' && req.method==='GET') {res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({...(study?study.research():{trades:0}),live:{fees:fee(),feeMode:val('FEE_MODE','max'),push:!!k.stream?.connected?.(),priceChecks:status.priceChecks,sellDesk:desk?{...desk.snapshot(),liveSells:status.localSells||0,lastLiveSellMs:status.lastLocalSellMs??null,paperSellBuilds:status.paperSellBuilds||0,pushedBalances:status.pushedBalances||0}:null,solscan:k.solscanUsage?.()||null}}));}
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
  return {engine,server,study,latency:latencyOf,setPower,desk,stop:()=>{stopped=true;desk?.stop();if(engine.saveTimer){try{engine.save();}catch{}}for(const m of monitors?.values?.()??[]){try{m.unwatch?.();}catch{}}monitors?.clear();stopWatcher();stopSolscan();clearInterval(pruneTimer);clearInterval(watchdog);clearInterval(globalTimer);local?.blockhash?.stop();clearInterval(timer);clearInterval(balanceTimer);clearInterval(demonstration);server.close();}};
}
