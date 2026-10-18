const $=id=>document.getElementById(id);let token='',latest;
const fmt=x=>Number.isFinite(x)?x.toFixed(5):'—';
async function api(route,method='GET'){
  const r=await fetch(route,{method,headers:token?{Authorization:'Bearer '+token}:{},cache:'no-store'});
  if(!r.ok)throw new Error(r.status===401?'Enter the dashboard token to connect.':'Request failed: '+r.status);
  return method==='GET'?r.json():null;
}
function item(parent,title,detail,error=false,signature){
  const box=document.createElement('div');box.className='item'+(error?' error':'');
  const b=document.createElement('b');b.textContent=title;box.append(b);
  const text=document.createElement('div');text.className='mint';text.textContent=detail;box.append(text);
  if(signature&&!signature.startsWith('paper-')){const a=document.createElement('a');a.href='https://solscan.io/tx/'+encodeURIComponent(signature);a.textContent='View transaction';a.target='_blank';a.rel='noopener noreferrer';box.append(a);}
  parent.append(box);
}
function renderEvents(){const out=$('events');out.replaceChildren();for(const e of [...(latest?.events||[])].reverse()){
  const bad=['failed','error','unresolved'].includes(e.type);if($('errors').checked&&!bad)continue;
  item(out,new Date(e.time).toLocaleTimeString()+' · '+e.type+(e.side?' '+e.side:''),[e.mint,e.reason||e.message,e.sol!==undefined?'SOL '+fmt(e.sol):''].filter(Boolean).join(' · '),bad,e.signature||e.leaderSignature);
}if(!out.childNodes.length)out.textContent='No matching events.';}
async function refresh(){try{
  latest=await api('/api/status');$('mode').textContent=latest.mode.toUpperCase();$('message').textContent=latest.mode==='demo'?'SYNTHETIC DEMO · generated trades, no blockchain connection.':latest.mode==='paper'?'PAPER · real leader signals, simulated trades. No SOL is spent.':latest.autoCopy?'LIVE · auto buy + auto sell.':'LIVE · auto buy + you sell in Phantom (SOLD alert).';
  $('balance').textContent=fmt(latest.balance);
  const w=latest.wallet||{};
  $('wallet-state').textContent=w.publicKey?`${w.publicKey} · ${w.autonomous?'autonomous signer ready':'simulated'}`:'No signer configured';
  $('spent').textContent=fmt(latest.spent)+' SOL'+(latest.capUsd?' / $'+latest.capUsd+' cap':latest.cap?' / '+latest.cap:' (no cap)')+(latest.pnlToday?' · P&L '+(latest.pnlToday>=0?'+':'')+latest.pnlToday.toFixed(4):'');$('reserved').textContent=fmt(latest.reserved);
  const entries=Object.entries(latest.positions).filter(([,p])=>BigInt(p.raw)>0n);$('count').textContent=entries.length+(latest.maxPositions?' / '+latest.maxPositions+' max':'');
  const autoOn=!latest.paused&&latest.autoCopy, manualOn=!latest.paused&&!latest.autoCopy;
  $('style-auto-state').textContent=autoOn?'ON · buys when Decu buys, sells the same share when he sells':'OFF';
  $('style-manual-state').textContent=manualOn?'ON · buys when Decu buys; you sell in Phantom after the SOLD alert':'OFF';
  $('style-auto-on').disabled=autoOn;$('style-auto-off').disabled=!autoOn;$('style-manual-on').disabled=manualOn;$('style-manual-off').disabled=!manualOn;
  $('buy-state').textContent=latest.paused?'Paused: both trading toggles are OFF, no new buys.':latest.gate?'Blocked: '+latest.gate:'Enabled';$('updated').textContent='Updated '+new Date().toLocaleTimeString();
  $('connection').textContent=latest.connection.websocket+' · Last poll: '+(latest.connection.lastPoll?new Date(latest.connection.lastPoll).toLocaleTimeString():'—')+' · Errors: '+latest.connection.errors;
  const k=latest.connection,sc=k.solscan,fs=k.firstSeen||{};
  $('providers').textContent='Helius: websocket first '+(fs.ws||0)+' · poll first '+(fs.poll||0)+' | Solscan: '+(!sc?'—':sc.ok===false?(sc.note||sc.error||'error'):sc.ok?'OK '+(sc.latencyMs??'?')+' ms':'starting')+' · gaps caught '+(k.gaps||0)+' | non-SOL trades skipped '+(k.unsupported||0)+' | other wallets filtered '+((k.otherWallets||0)+(k.filteredWs||0))+(k.pollMode?' | Helius poll: '+k.pollMode:'')+(k.lastError?' | last error: '+k.lastError:'');
  $('positions').replaceChildren();for(const [mint,p] of entries)item($('positions'),mint,p.raw+' raw tokens · cost '+fmt(p.costSol)+' SOL · realized proceeds '+fmt(p.realizedSol)+' SOL');if(!entries.length)$('positions').textContent='No open positions.';
  $('jobs').replaceChildren();for(const j of latest.jobs)item($('jobs'),j.side+' · '+j.phase,j.mint,j.phase==='unresolved',j.signature);if(!latest.jobs.length)$('jobs').textContent='No pending transactions.';
  $('pause').disabled=latest.paused;$('resume').disabled=!latest.paused;renderEvents();
  renderResearch(await api('/api/research').catch(()=>null));
}catch(e){$('message').textContent=e.message;$('mode').textContent='Disconnected';}}
const pc=x=>Number.isFinite(x)?(x>=0?'+':'')+(x*100).toFixed(1)+'%':'—', sl=x=>Number.isFinite(x)?(x>=0?'+':'')+x.toFixed(4)+' SOL':'—', sec=x=>Number.isFinite(x)?x.toFixed(2)+' s':'—', msf=x=>Number.isFinite(x)?Math.round(x)+' ms':'—';
function renderResearch(r){
  const out=$('research'),rec=$('recent');out.replaceChildren();rec.replaceChildren();
  const lv=r&&r.live;
  if(lv&&lv.fees)item(out,'Speed settings now',`fees per side ${Number(lv.fees.priorityFeeSol+lv.fees.tipSol).toFixed(4)} SOL (priority ${Number(lv.fees.priorityFeeSol).toFixed(4)} + tip ${Number(lv.fees.tipSol).toFixed(4)}, ${lv.feeMode==='max'?'live maximum':'fixed'}) · push stream ${lv.push?'ON':'off'}${lv.priceChecks?` · price checks ${lv.priceChecks.push} pushed / ${lv.priceChecks.poll} polled`:''}`);
  if(!r||!r.trades){if(!out.childNodes.length)out.textContent='No studied trades yet.';rec.textContent='—';return;}
  const L=r.latency||{};
  item(out,'Results (paper/live as shown above)',`FCAT ${sl(r.fcatSol)} · win rate ${pc(r.winRate)} · profit factor ${Number.isFinite(r.profitFactor)?r.profitFactor.toFixed(2):'—'} · max drawdown ${sl(r.maxDrawdownSol)} · bought ${r.taken} / skipped ${r.skipped}`);
  if(r.filters&&r.filters.length)item(out,'Entry-premium filters side by side (same trades)',r.filters.map(f=>`${f.pct}%${f.trading?' (trading)':''}: ${f.trades} trades, ${f.wins} won, ${sl(f.fcatSol)}`).join(' · '));
  else item(out,`With the ${r.filter.pct}% entry-premium filter`,`${r.filter.trades} trades · FCAT ${sl(r.filter.fcatSol)}`);
  if(r.holders&&(r.holders.safe.trades||r.holders.risky.trades))item(out,'Holder money rule at buy (dev excluded)',`SAFE ${r.holders.safe.trades} trades, ${r.holders.safe.wins} won, ${sl(r.holders.safe.fcatSol)} · RISKY ${r.holders.risky.trades} trades, ${r.holders.risky.wins} won, ${sl(r.holders.risky.fcatSol)}${r.holders.unknown?` · ${r.holders.unknown} without counts`:''}`);
  for(const x of r.exitTests||[])if(x.trades)item(out,`Paper test: ${x.name}`,`${sl(x.pnlSol)} vs your rules ${sl(x.yoursSol)} on the same ${x.trades} trades${x.incomplete?` · ${x.incomplete} trades without data left out`:''}`);
  item(out,'Entry premium',`median ${pc(r.medianEntryPremium)} · average ${pc(r.avgEntryPremium)} over Decu's price`);
  item(out,'Execution latency',`median ${sec(L.medianSec)} · p95 ${sec(L.p95Sec)} from his block · bot part median ${msf(L.botMedianMs)} (p95 ${msf(L.botP95Ms)}) · build ${msf(L.buildMedianMs)} · land ${msf(L.landMedianMs)}${L.simulatedMs?' (incl. '+msf(L.simulatedMs)+' simulated)':''} · blocks after Decu ${L.blocksMedian??'—'}${L.detectBlocksMedian!=null?` · seen ${L.detectBlocksMedian} blocks after him (p95 ${L.detectBlocksP95??'—'})`:''}`);
  const rs=Object.entries(r.skipReasons||{});if(rs.length)item(out,'Why buys were skipped',rs.map(([k,v])=>`${v}× ${k}`).join(' · '));
  if(r.brain)item(out,`Brain: L${r.brain.level} ${r.brain.name}`,`${r.brain.trades} trades · go-live ${r.brain.readiness.passed}/${r.brain.readiness.of}${r.brain.accuracy?' · predictions '+Math.round(r.brain.accuracy.rate*100)+'% right':''}`);
  for(const t of r.recent)item(rec,`${new Date(t.time).toLocaleTimeString()} · ${t.coin} · ${t.taken?'BOUGHT':'SKIPPED'}`,`premium ${pc(t.premium)} · latency ${sec(t.latencySec)}${t.blocks!=null?' · '+t.blocks+' blocks':''} · FCAT ${pc(t.fcat)}${t.reason?' · '+t.reason:''}`,!t.taken);
  $('research-updated').textContent='Updated '+new Date().toLocaleTimeString();
}
$('export').onclick=async()=>{try{const r=await fetch('/api/export.csv',{headers:token?{Authorization:'Bearer '+token}:{},cache:'no-store'});if(!r.ok)throw new Error('Download failed: '+r.status);const b=await r.blob();const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=(r.headers.get('content-disposition')||'').match(/filename="([^"]+)"/)?.[1]||'decu-trades.csv';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),5000);}catch(e){$('message').textContent=e.message;}};
$('emergency').onclick=async()=>{if(!confirm('EMERGENCY STOP: no new buys until you turn a style back on. Continue?'))return;try{await api('/api/emergency','POST');refresh();}catch(e){$('message').textContent=e.message;}};
$('sellall').onclick=async()=>{if(!confirm('Sell EVERY open position now? In LIVE this sends real sells.'))return;if(!confirm('Are you sure? This cannot be undone.'))return;try{await api('/api/sell-all','POST');refresh();}catch(e){$('message').textContent=e.message;}};
$('connect').onclick=()=>{token=$('token').value;$('token').value='';refresh();};
$('pause').onclick=async()=>{try{await api('/api/pause','POST');refresh();}catch(e){$('message').textContent=e.message;}};
$('resume').onclick=async()=>{try{await api('/api/resume','POST');refresh();}catch(e){$('message').textContent=e.message;}};
const setStyle=v=>async()=>{try{await api('/api/style/'+v,'POST');refresh();}catch(e){$('message').textContent=e.message;}};
$('style-auto-on').onclick=setStyle('auto');$('style-auto-off').onclick=setStyle('off');$('style-manual-on').onclick=setStyle('manual');$('style-manual-off').onclick=setStyle('off');
$('errors').onchange=renderEvents;refresh();setInterval(refresh,2000);

$('phantom-connect').onclick=async()=>{
  try{
    const provider=window.phantom?.solana;
    if(!provider) throw new Error('Phantom extension was not detected. Open this dashboard in a browser with Phantom installed.');
    const res=await provider.connect();
    const address=res?.publicKey?.toString?.()||String(res?.publicKey||'');
    const expected=latest?.wallet?.publicKey||'';
    if(!expected) throw new Error('The bot has no configured burner signer. Configure PHANTOM_PRIVATE_KEY/PRIVATE_KEY first.');
    $('wallet-state').textContent=address===expected?`Verified ✓ ${address}`:`Mismatch ✕ Phantom ${address} · bot ${expected}`;
  }catch(e){$('wallet-state').textContent=e.message;}
};
