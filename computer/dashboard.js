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
  $('spent').textContent=fmt(latest.spent)+' / '+latest.cap;$('reserved').textContent=fmt(latest.reserved);
  const entries=Object.entries(latest.positions).filter(([,p])=>BigInt(p.raw)>0n);$('count').textContent=entries.length;
  const autoOn=!latest.paused&&latest.autoCopy, manualOn=!latest.paused&&!latest.autoCopy;
  $('style-auto-state').textContent=autoOn?'ON · buys when Decu buys, sells the same share when he sells':'OFF';
  $('style-manual-state').textContent=manualOn?'ON · buys when Decu buys; you sell in Phantom after the SOLD alert':'OFF';
  $('style-auto-on').disabled=autoOn;$('style-auto-off').disabled=!autoOn;$('style-manual-on').disabled=manualOn;$('style-manual-off').disabled=!manualOn;
  $('buy-state').textContent=latest.paused?'Paused: both trading toggles are OFF, no new buys.':'Enabled';$('updated').textContent='Updated '+new Date().toLocaleTimeString();
  $('connection').textContent=latest.connection.websocket+' · Last poll: '+(latest.connection.lastPoll?new Date(latest.connection.lastPoll).toLocaleTimeString():'—')+' · Errors: '+latest.connection.errors;
  const k=latest.connection,sc=k.solscan,fs=k.firstSeen||{};
  $('providers').textContent='Helius: websocket first '+(fs.ws||0)+' · poll first '+(fs.poll||0)+' | Solscan: '+(!sc?'—':sc.ok===false?(sc.note||sc.error||'error'):sc.ok?'OK '+(sc.latencyMs??'?')+' ms':'starting')+' · gaps caught '+(k.gaps||0)+' | non-SOL trades skipped '+(k.unsupported||0)+' | other wallets filtered '+((k.otherWallets||0)+(k.filteredWs||0))+(k.pollMode?' | Helius poll: '+k.pollMode:'')+(k.lastError?' | last error: '+k.lastError:'');
  $('positions').replaceChildren();for(const [mint,p] of entries)item($('positions'),mint,p.raw+' raw tokens · cost '+fmt(p.costSol)+' SOL · realized proceeds '+fmt(p.realizedSol)+' SOL');if(!entries.length)$('positions').textContent='No open positions.';
  $('jobs').replaceChildren();for(const j of latest.jobs)item($('jobs'),j.side+' · '+j.phase,j.mint,j.phase==='unresolved',j.signature);if(!latest.jobs.length)$('jobs').textContent='No pending transactions.';
  $('pause').disabled=latest.paused;$('resume').disabled=!latest.paused;renderEvents();
}catch(e){$('message').textContent=e.message;$('mode').textContent='Disconnected';}}
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
