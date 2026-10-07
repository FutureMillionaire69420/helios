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
  latest=await api('/api/status');$('mode').textContent=latest.mode.toUpperCase();$('message').textContent=latest.mode==='demo'?'SYNTHETIC DEMO · generated trades, no blockchain connection.':latest.mode==='paper'?'PAPER · real leader signals, simulated trades. No SOL is spent.':latest.autoSell?'LIVE · real buys and automatic proportional sells.':'LIVE · real buys. You sell by hand from the SOLD alert.';
  $('balance').textContent=fmt(latest.balance);$('spent').textContent=fmt(latest.spent)+' / '+latest.cap;$('reserved').textContent=fmt(latest.reserved);
  const entries=Object.entries(latest.positions).filter(([,p])=>BigInt(p.raw)>0n);$('count').textContent=entries.length;
  $('buy-state').textContent=latest.paused?'Paused; selling and monitoring continue.':'Enabled';$('updated').textContent='Updated '+new Date().toLocaleTimeString();
  $('connection').textContent=latest.connection.websocket+' · Last poll: '+(latest.connection.lastPoll?new Date(latest.connection.lastPoll).toLocaleTimeString():'—')+' · Errors: '+latest.connection.errors;
  const k=latest.connection,sc=k.solscan,fs=k.firstSeen||{};
  $('providers').textContent='Helius: websocket first '+(fs.ws||0)+' · poll first '+(fs.poll||0)+' | Solscan: '+(!sc?'—':sc.ok===false?(sc.note||sc.error||'error'):sc.ok?'OK '+(sc.latencyMs??'?')+' ms':'starting')+' · gaps caught '+(k.gaps||0)+' | non-SOL trades skipped '+(k.unsupported||0);
  $('positions').replaceChildren();for(const [mint,p] of entries)item($('positions'),mint,p.raw+' raw tokens · cost '+fmt(p.costSol)+' SOL · realized proceeds '+fmt(p.realizedSol)+' SOL');if(!entries.length)$('positions').textContent='No open positions.';
  $('jobs').replaceChildren();for(const j of latest.jobs)item($('jobs'),j.side+' · '+j.phase,j.mint,j.phase==='unresolved',j.signature);if(!latest.jobs.length)$('jobs').textContent='No pending transactions.';
  $('pause').disabled=latest.paused;$('resume').disabled=!latest.paused;renderEvents();
}catch(e){$('message').textContent=e.message;$('mode').textContent='Disconnected';}}
$('connect').onclick=()=>{token=$('token').value;$('token').value='';refresh();};
$('pause').onclick=async()=>{try{await api('/api/pause','POST');refresh();}catch(e){$('message').textContent=e.message;}};
$('resume').onclick=async()=>{try{await api('/api/resume','POST');refresh();}catch(e){$('message').textContent=e.message;}};
$('errors').onchange=renderEvents;refresh();setInterval(refresh,2000);
