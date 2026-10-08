import fs from 'node:fs';

export function sizeBuy(c, signal, balance, reserved, spent) {
  const spendable = Math.max(0, balance - reserved - c.reserve - c.feeBudget);
  if (c.sizing === 'proportional' && !(signal.leaderBalanceSol > 0)) throw new Error('leader pre-trade SOL balance unavailable');
  const desired = c.sizing === 'proportional' ? spendable * Math.min(1, signal.sol / signal.leaderBalanceSol) * c.multiplier : c.buySol;
  const sol = Math.floor(Math.max(0, Math.min(desired, c.maxBuy, spendable / (1 + c.slippage / 100), c.dailyCap - spent)) * 1e9) / 1e9;
  if (sol < c.minBuy) throw new Error('trade too small or budget exhausted');
  return sol;
}

export function fractionRaw(held, sold, before) {
  held = BigInt(held); sold = BigInt(sold); before = BigInt(before);
  if (before <= 0n || sold <= 0n) throw new Error('leader pre-sell balance unavailable');
  return held * (sold > before ? before : sold) / before;
}

export class Engine {
  constructor({file, config, adapter, log = () => {}}) {
    this.file = file; this.c = config; this.a = adapter; this.log = log;
    this.tasks = new Map(); this.serial = Promise.resolve(); this.reconciling = false;
    this.d = {version: 2, mode: config.mode, wallet:config.wallet || null, paused: false, daily: {}, seen: {}, positions: {}, jobs: {}, queues: {}, events: [], paperBalance: config.paperBalance};
    if (fs.existsSync(file)) {
      this.d = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (this.d.version !== 2 || this.d.mode !== config.mode) throw new Error('state version/mode mismatch; use separate state files');
      if (config.mode==='live' && this.d.wallet!==config.wallet) throw new Error('state belongs to a different trading wallet');
    }
  }
  day() { return new Intl.DateTimeFormat('en-CA', {timeZone: this.c.timezone, year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date()); }
  save() { const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.d), {mode:0o600}); fs.renameSync(tmp, this.file); }
  event(type, fields = {}) {
    const e = {time:new Date().toISOString(), type, ...fields};
    this.d.events.push(e); this.d.events = this.d.events.slice(-250); this.save();
    try { this.log(e); } catch (error) { console.error('event log unavailable:', error.message); }
  }
  lock(fn) { const p = this.serial.then(fn); this.serial = p.catch(() => {}); return p; }
  reserved() { return Object.values(this.d.jobs).filter(j => j.side === 'buy').reduce((s,j) => s+j.reserveSol,0); }
  async ingest(s) {
    return this.lock(async () => {
      const key = `${s.sig}:${s.side}:${s.mint}`;
      if (this.d.seen[key]) return;
      this.event('detected', {side:s.side, mint:s.mint, leaderSignature:s.sig});
      let reason;
      if (s.side === 'buy') {
        if (this.d.paused) reason = 'new buys paused';
        else if (Date.now()/1000 - s.time > this.c.maxAge) reason = 'stale buy signal';
        else if (!s.pump && this.c.pumpOnly) reason = 'not a pump trade';
        else if (s.usd < this.c.minLeaderUsd) reason = 'leader buy below minimum';
        else if (this.c.oneBuy && (this.d.positions[s.mint] || this.d.jobs[s.mint] || this.d.queues[s.mint]?.some(x=>x.side==='buy'))) reason = 'already copied mint';
      } else if (!this.d.positions[s.mint] && !this.d.jobs[s.mint] && !this.d.queues[s.mint]?.length) reason = 'no bot position';
      else if (!this.c.autoSell) {
        // Manual-sell mode: never sell, but tell the user the moment he sells a coin the bot holds.
        this.d.seen[key] = Date.now();
        this.event('leader-sold', {mint:s.mint, leaderSignature:s.sig, soldRaw:s.soldRaw, beforeRaw:s.beforeRaw});
        return;
      }
      else if (this.c.maxSellAge > 0 && Date.now()/1000 - s.time > this.c.maxSellAge) reason = 'stale sell signal; inspect position';
      this.d.seen[key] = Date.now();
      if (reason) { this.event('skip', {mint:s.mint, side:s.side, reason}); return; }
      (this.d.queues[s.mint] ||= []).push({...s, key}); this.save();
      this.schedule(s.mint);
    });
  }
  schedule(mint) {
    if (this.tasks.has(mint) || this.d.jobs[mint]) return;
    // Start outside the global lock; confirmations never hold that lock.
    const p = Promise.resolve().then(() => this.drain(mint)).catch(e => this.event('error',{mint,message:e.message})).finally(() => this.tasks.delete(mint));
    this.tasks.set(mint,p);
  }
  async drain(mint) {
    while (this.d.queues[mint]?.length && !this.d.jobs[mint]) {
      let job;
      await this.lock(async () => {
        const s = this.d.queues[mint][0];
        try {
          job = {...s, id:s.key, day:this.day(), phase:'building'};
          if (s.side === 'buy') {
            if (this.d.paused) throw new Error('new buys paused');
            const balance = this.c.mode === 'live' ? await this.a.balance() : this.d.paperBalance;
            job.sol = sizeBuy(this.c,s,balance,this.reserved(),this.d.daily[job.day] || 0);
            job.reserveSol = job.sol * (1 + this.c.slippage/100) + this.c.feeBudget;
            this.d.daily[job.day] = (this.d.daily[job.day] || 0) + job.sol;
          } else {
            const p = this.d.positions[mint];
            if (!p || BigInt(p.raw) === 0n) throw new Error('no filled bot position');
            let available = BigInt(p.raw);
            if (this.c.mode === 'live') { const actual = BigInt(await this.a.tokens(mint)); if (actual < available) available = actual; }
            job.raw = fractionRaw(available,s.soldRaw,s.beforeRaw).toString();
            if (BigInt(job.raw) === 0n) throw new Error('sell rounds to zero tokens');
          }
          this.d.jobs[mint] = job; this.d.queues[mint].shift(); this.event('building',{mint,side:job.side,sol:job.sol,raw:job.raw});
        } catch (e) { this.d.queues[mint].shift(); job = null; this.event('skip',{mint,reason:e.message}); }
      });
      if (!job) continue;
      try {
        const built = await this.a.build(job);
        Object.assign(job,built,{phase:'submitted'});
        // Persist signed transaction BEFORE any broadcast. Recovery can resend identical bytes.
        this.save(); this.event('submitted',{mint,side:job.side,signature:job.signature});
        const result = await this.a.send(job);
        await this.finish(job,result);
      } catch (e) {
        if (job.phase === 'building') await this.finish(job,{status:'failed',error:e.message});
        else { job.phase = 'unresolved'; this.event('unresolved',{mint,signature:job.signature,message:e.message}); }
      }
    }
  }
  async finish(job,result) {
    if (result.status === 'unresolved') { job.phase='unresolved'; this.event('unresolved',{mint:job.mint,signature:job.signature,message:result.error}); return; }
    await this.lock(async () => {
      const p = this.d.positions[job.mint] ||= {raw:'0',costSol:0,realizedSol:0};
      if (result.status === 'confirmed') {
        const delta = BigInt(result.rawDelta);
        const nextRaw=BigInt(p.raw)+delta;
        if (nextRaw < 0n) throw new Error('negative position: reconciliation required');
        p.raw = nextRaw.toString();
        if (job.side === 'buy') p.costSol += -result.solDelta;
        else p.realizedSol += result.solDelta;
        if (this.c.mode !== 'live') this.d.paperBalance += result.solDelta;
        delete this.d.jobs[job.mint];
        this.event('confirmed',{mint:job.mint,side:job.side,signature:job.signature,rawDelta:result.rawDelta,solDelta:result.solDelta});
      } else {
        if (job.side === 'buy') this.d.daily[job.day] = Math.max(0,(this.d.daily[job.day] || 0)-job.sol);
        if (BigInt(p.raw) === 0n && !p.costSol) delete this.d.positions[job.mint];
        delete this.d.jobs[job.mint];
        this.event('failed',{mint:job.mint,side:job.side,signature:job.signature,message:result.error});
      }
      delete this.d.jobs[job.mint]; this.save();
    });
  }
  async recover() {
    if (this.reconciling) return; this.reconciling = true;
    try {
      for (const job of Object.values(this.d.jobs)) {
        if (this.tasks.has(job.mint)) continue;
        if (job.phase === 'building') { await this.finish(job,{status:'failed',error:'restart before signed transaction was persisted; no send occurred'}); continue; }
        try { await this.finish(job,await this.a.reconcile(job)); }
        catch(e) { this.event('error',{mint:job.mint,message:e.message}); }
      }
      for (const mint of Object.keys(this.d.queues)) this.schedule(mint);
    } finally { this.reconciling = false; }
  }
  pause(value) { this.d.paused=value; this.event(value ? 'paused' : 'resumed'); }
  // Phone alerts on/off. Saved in the state file, so it survives restarts.
  mute(value) { this.d.alertsOff=value; this.event(value ? 'alerts-off' : 'alerts-on'); }
  snapshot() {
    const jobs = Object.values(this.d.jobs).map(({mint,side,phase,signature,sol,raw}) => ({mint,side,phase,signature,sol,raw}));
    return {mode:this.c.mode,autoSell:this.c.autoSell,paused:this.d.paused,alertsOff:!!this.d.alertsOff,balance:this.c.mode === 'live' ? null : this.d.paperBalance,spent:this.d.daily[this.day()] || 0,cap:this.c.dailyCap,reserved:this.reserved(),positions:this.d.positions,jobs,events:this.d.events.slice(-100)};
  }
  async idle() { await this.serial; while(this.tasks.size) await Promise.all([...this.tasks.values()]); }
}
