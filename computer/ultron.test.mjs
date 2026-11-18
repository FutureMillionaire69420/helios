import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {STYLES, styleOf, styleFromWords, VOICEMAIL, addressedTo, greeting, parseOrder, passwordMatch, ORDERS_MENU, createUltron, TOOLS, runTool, cleanSettings, bigWinDue, hookKey, phoneDigits, results, freeIntent, freeAnswer, FREE_MENU, DEFAULT_SETTINGS} from './ultron.mjs';
import {voiceConfig, createVoiceCaller} from './voicecall.mjs';

const BASE = 'https://bot.example.com', KEY = 'k'.repeat(32);
const spoken = (x) => [...x.matchAll(/<Say[^>]*>(.*?)<\/Say>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).join(' ');
const textReply = (t) => ({ok: true, status: 200, json: async () => ({stop_reason: 'end_turn', content: [{type: 'text', text: t}]})});
const toolReply = (name, input = {}) => ({ok: true, status: 200, json: async () => ({stop_reason: 'tool_use', content: [{type: 'tool_use', id: 'tu1', name, input}]})});

test('ultron: the AI\'s tools only read, plus one that only PROPOSES an order; Ultron never touches the engine himself', () => {
  const names = TOOLS.map((t) => t.name);
  assert.deepEqual(names, ['bot_overview', 'open_positions', 'recent_trades', 'results', 'brain', 'sol_price', 'decu_activity', 'rolex_goal', 'helius_credits', 'daily_briefing', 'request_action', 'recent_events']);
  for (const t of TOOLS.filter((x) => x.name !== 'request_action')) assert.doesNotMatch(t.name, /set|sell|buy|change|toggle|power|send|transfer|withdraw|sign/i);
  assert.match(TOOLS.find((t) => t.name === 'request_action').description, /does NOT run it/);
  // orders run only through the functions the server hands him: no imports of the trading code, no engine calls
  const src = fs.readFileSync(new URL('./ultron.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /import .* from '\.\/(engine|copybot|runtime|pumpportal|pumpbuild|wallet)/);
  assert.doesNotMatch(src, /exitNow|setPower|engine\.(style|pause|mute|d)\b/);
});

test('ultron: tools read the data they are given and never throw', async () => {
  const closed = [{pnlSol: 0.2, costSol: 0.1, closedAt: 1000}, {pnlSol: -0.05, costSol: 0.1, closedAt: 2000}, {pnlSol: 0.01, costSol: 0.1, closedAt: 3000}];
  const data = {closed: () => closed, overview: () => ({mode: 'paper'}), events: () => { throw new Error('boom'); }, now: () => 3000};
  assert.match(await runTool('bot_overview', {}, data), /paper/);
  const recent = JSON.parse(await runTool('recent_trades', {count: 2}, data));
  assert.equal(recent.length, 2); assert.equal(recent[0].closedAt, 3000, 'newest first');
  assert.match(await runTool('recent_events', {}, data), /Could not read that: boom/);
  assert.match(await runTool('sell_everything', {}, data), /Unknown tool/);
  const r = results(closed, 1, 100, 3000);
  assert.equal(r.trades, 3); assert.equal(r.wins, 2); assert.equal(r.losses, 1); assert.equal(r.pnlSol, 0.16); assert.equal(r.pnlUsd, 16); assert.equal(r.best.pnlSol, 0.2);
});

test('ultron: settings keep only valid values (voice list, sane big-win limits)', () => {
  assert.deepEqual(cleanSettings({}, {}), DEFAULT_SETTINGS);
  const s = cleanSettings({}, {voice: 'Polly.Brian', bigWinOn: '0', bigWinPct: '250', bigWinPerDay: '2'});
  assert.equal(s.voice, 'Polly.Brian'); assert.equal(s.bigWinOn, false); assert.equal(s.bigWinPct, 250); assert.equal(s.bigWinPerDay, 2);
  const bad = cleanSettings(s, {voice: '<Hangup/>', bigWinPct: '1', bigWinPerDay: '99'});
  assert.equal(bad.voice, 'Polly.Brian'); assert.equal(bad.bigWinPct, 250); assert.equal(bad.bigWinPerDay, 2);
});

test('ultron: big-win calls only at the threshold, at most N a day, never when off', () => {
  const st = {}, day = Date.UTC(2026, 10, 14, 12);
  const win = {pnlSol: 0.15, costSol: 0.1, pnlPct: 1.5}; // +150%
  assert.equal(bigWinDue({pnlSol: 0.05, costSol: 0.1}, {}, st, day), false, '+50% is under 100%');
  assert.equal(bigWinDue({pnlSol: -0.05, costSol: 0.1}, {}, st, day), false);
  assert.equal(bigWinDue(win, {bigWinOn: false}, st, day), false);
  assert.equal(bigWinDue(win, {bigWinPerDay: 2}, st, day), true);
  assert.equal(bigWinDue(win, {bigWinPerDay: 2}, st, day), true);
  assert.equal(bigWinDue(win, {bigWinPerDay: 2}, st, day), false, 'daily limit');
  assert.equal(bigWinDue(win, {bigWinPerDay: 2}, st, day + 86400_000), true, 'next day');
});

test('ultron: only the owner\'s phone is answered; secret key is stable and private', async () => {
  const u = createUltron({random: () => 0, apiKey: 'x', fetchImpl: async () => textReply('Ultron online.'), data: {}});
  const no = await u.inbound({base: BASE, key: KEY, from: '+15550000000', owner: '+18635551234', callSid: 'C1', voice: 'man'});
  assert.match(no, /<Reject/); assert.equal(u.sessions.size, 0);
  const yes = await u.inbound({base: BASE, key: KEY, from: '+1 (863) 555-1234', owner: '+18635551234', callSid: 'C2', voice: 'man'});
  assert.match(yes, /<Gather input="speech"/); assert.match(yes, /Ultron online\./);
  assert.equal(phoneDigits('+18635551234'), phoneDigits('863-555-1234'));
  assert.equal(hookKey('a'), hookKey('a')); assert.notEqual(hookKey('a'), hookKey('b')); assert.equal(hookKey('a').length, 32);
  // no API key: free mode still answers the owner (scripted), and still rejects everyone else
  const free = createUltron({random: () => 0, apiKey: '', data: {}, fetchImpl: async () => { throw new Error('free mode must not call any AI'); }});
  assert.match(spoken(await free.inbound({base: BASE, key: KEY, from: '+18635551234', owner: '+18635551234', voice: 'man'})), /Good (morning|afternoon|evening), sir\. Ultron here\..*How may I help, sir\?/);
  assert.match(await free.inbound({base: BASE, key: KEY, from: '+15550000000', owner: '+18635551234', voice: 'man'}), /<Reject/);
  u.stop(); free.stop();
});

test('ultron: a conversation uses read-only tools, remembers history, speaks plain text, hangs up on goodbye', async () => {
  const sent = []; let n = 0;
  const fetchImpl = async (url, init) => { const b = JSON.parse(init.body); sent.push({url, b, h: init.headers}); n++;
    if (n === 1) return toolReply('bot_overview');
    if (n === 2) return textReply('**You** are up two SOL today.');
    return textReply('Nothing else to report.'); };
  const u = createUltron({random: () => 0, apiKey: 'sk-test', fetchImpl, data: {overview: () => ({mode: 'paper', pnlTodaySol: 2})}});
  const id = u.open({reason: 'you asked'});
  const first = await u.start({base: BASE, key: KEY, id, callSid: 'CA9', voice: 'Polly.Matthew'});
  assert.match(first, /<Say voice="Polly.Matthew"><prosody rate="96%" pitch="-8%"><amazon:effect name="drc"><amazon:effect vocal-tract-length="\+8%">You are up two SOL today\.<\/amazon:effect><\/amazon:effect><\/prosody><\/Say>/, 'markdown stripped; a little faster, clearer, lower');
  assert.match(first, new RegExp(`action="${BASE}/voice/agent/turn\\?k=${KEY}&amp;s=${id}"`));
  assert.equal(sent[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent[0].b.model, 'claude-sonnet-5-5'); assert.equal(sent[0].h['x-api-key'], 'sk-test');
  assert.deepEqual(sent[0].b.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.equal(sent[1].b.messages.at(-1).content[0].type, 'tool_result'); assert.match(sent[1].b.messages.at(-1).content[0].content, /pnlTodaySol/);
  // a different call cannot hijack this conversation
  assert.match(await u.turn({base: BASE, key: KEY, id, callSid: 'OTHER', speech: 'hi', voice: 'man'}), /expired/);
  const second = await u.turn({base: BASE, key: KEY, id, callSid: 'CA9', speech: 'anything else?', voice: 'man'});
  assert.match(second, /Nothing else to report/);
  assert.equal(sent.at(-1).b.messages.length, 5, 'whole history sent: kickoff, tool use, tool result, answer, question');
  const bye = await u.turn({base: BASE, key: KEY, id, callSid: 'CA9', speech: 'ok goodbye', voice: 'man'});
  assert.match(bye, /<Hangup\/>/); assert.equal(u.sessions.has(id), false);
});

test('ultron: a slow answer holds the line and is picked up; silence twice hangs up; failures are spoken', async () => {
  let release; const slow = new Promise((r) => { release = r; });
  const u = createUltron({random: () => 0, apiKey: 'k', turnWaitMs: 20, fetchImpl: async () => { await slow; return textReply('Done thinking.'); }, data: {}});
  const id = u.open({});
  const held = await u.start({base: BASE, key: KEY, id, callSid: 'C', voice: 'man'});
  assert.match(held, /One moment, sir\./); assert.match(held, /\/voice\/agent\/wait\?k=/);
  release(); const got = await u.wait({base: BASE, key: KEY, id, callSid: 'C', voice: 'man'});
  assert.match(got, /Done thinking\./);
  assert.match(await u.turn({base: BASE, key: KEY, id, callSid: 'C', speech: '', silence: true, voice: 'man'}), /Are you still there, sir\?/);
  assert.match(await u.turn({base: BASE, key: KEY, id, callSid: 'C', speech: '', silence: true, voice: 'man'}), /<Hangup\/>/);
  const broken = createUltron({random: () => 0, apiKey: 'k', fetchImpl: async () => ({ok: false, status: 500, json: async () => ({error: {message: 'overloaded'}})}), data: {}});
  const id2 = broken.open({});
  assert.match(await broken.start({base: BASE, key: KEY, id: id2, callSid: 'D', voice: 'man'}), /connection to my mind failed/);
});

test('voice caller: a conversation call points the provider at this server\'s agent script only', async () => {
  const env = {SIGNALWIRE_SPACE: 'myspace', SIGNALWIRE_PROJECT_ID: '12345678-90ab-cdef-1234-567890abcdef', SIGNALWIRE_API_TOKEN: 't', SIGNALWIRE_FROM_NUMBER: '+15550002222', OWNER_PHONE: '+15559998888', RENDER_EXTERNAL_URL: BASE};
  const seen = []; const caller = createVoiceCaller({cfg: voiceConfig(env), fetchImpl: async (u, i) => { seen.push(new URLSearchParams(String(i.body))); return {ok: true, status: 201, json: async () => ({sid: 'S'})}; }});
  await caller.call({url: `${BASE}/voice/agent/start?k=${KEY}&s=abc`});
  assert.equal(seen[0].get('Url'), `${BASE}/voice/agent/start?k=${KEY}&s=abc`); assert.equal(seen[0].get('Method'), 'POST'); assert.equal(seen[0].get('To'), '+15559998888');
  await assert.rejects(createVoiceCaller({cfg: voiceConfig(env)}).call({url: 'https://evil.example.com/x'}), /bad audio/);
});

test('free mode: no AI and no cost; reads the bot aloud and answers profit, coins, trades, brain, health by voice or keypad', async () => {
  const now = Date.UTC(2026, 10, 14, 12), steps = [];
  const data = {
    overview: () => ({mode: 'paper', power: 'on', style: 'auto buy + auto sell', pnlTodaySol: 0.42, coinsHeld: 1, readyToTrade: true, blocking: []}),
    positions: () => [{coin: 'PEPE', profitPct: 34.4, valueSol: 0.134}],
    closed: () => [{coin: 'DOGE', pnlSol: 0.2, costSol: 0.1, profitPct: 200, closedAt: now - 3600_000}, {coin: 'CAT', pnlSol: -0.05, costSol: 0.1, profitPct: -50, closedAt: now - 20 * 60_000}],
    brainLine: () => 'Rookie (1/6) · bankroll 1.2 SOL', events: () => [{type: 'ready', message: 'ready to trade again'}], solUsd: () => 150,
  };
  const u = createUltron({random: () => 0, apiKey: '', data, now: () => now, trace: (e) => steps.push(e), fetchImpl: async () => { throw new Error('free mode must not call any AI'); }});
  assert.equal(u.mode, 'free'); assert.equal(u.ai, false); assert.equal(u.ready, true);
  const id = u.open({reason: 'big win', announce: 'Big win in paper trading: DOGE just closed up 200 percent, 0.2 SOL.'});
  const first = await u.start({base: BASE, key: KEY, id, callSid: 'F1', voice: 'man'});
  assert.equal(spoken(first), 'Good afternoon, sir. Ultron here. Big win in paper trading: DOGE just closed up 200 percent, 0.2 SOL. All systems are online, in paper mode. Profit today is plus 0.42 SOL, and we are holding 1 coin. We are ready to trade. How may I help, sir?');
  assert.match(first, /<Say voice="man">Good afternoon, sir\.<\/Say><Pause length="1"\/><Say voice="man">Ultron here\.<\/Say>/, 'the robot voice pauses between sentences');
  assert.match(first, /<Gather input="dtmf speech" numDigits="1"/);
  const ask = async (speech, digits) => spoken(await u.turn({base: BASE, key: KEY, id, callSid: 'F1', speech, digits, voice: 'man'}));
  assert.equal(await ask('how much profit did we make today'), 'Over the last 24 hours in paper trading, sir, we made 2 trades: 1 win and 1 loss, for a total of plus 0.15 SOL, about 23 dollars. Our best was DOGE, at plus 0.2 SOL. A respectable showing, sir. Anything else, sir?');
  assert.equal(await ask('', '2'), 'We are holding 1 coin, sir. PEPE, up 34 percent, worth 0.134 SOL. Anything else, sir?');
  assert.equal(await ask('what were the last trades'), 'Here are the last trades, sir. CAT: minus 0.05 SOL, down 50 percent, 20 minutes ago. DOGE: plus 0.2 SOL, up 200 percent, 1 hour ago. Anything else, sir?');
  assert.equal(await ask('', '4'), 'From the brain, sir: Rookie (1/6). bankroll 1.2 SOL. Anything else, sir?');
  assert.equal(await ask('is the bot healthy'), 'Power is on, sir. We are in paper mode. Every check passes, and we are ready to trade. The buy style is auto buy + auto sell. The latest event: ready to trade again. Anything else, sir?');
  assert.match(await ask('purple elephant banana'), /^My apologies, sir, I did not understand\. Say help, sir, for the list\.$/);
  assert.match(await u.turn({base: BASE, key: KEY, id, callSid: 'F1', digits: '9', voice: 'man'}), /Until next time, sir\.<\/Say><Hangup\/>/);
  const sum = steps.find((e) => e.step === 'call-summary');
  assert.equal(sum.mode, 'free'); assert.equal(sum.model, 'free mode (no AI)'); assert.equal(sum.costUsd, 0); assert.equal(sum.claudeRequests, 0); assert.equal(sum.why, 'the owner pressed 9 (goodbye)');
  assert.deepEqual(steps.filter((e) => e.step === 'answer').map((e) => e.intent), ['overview', 'profit', 'coins', 'trades', 'brain', 'health', 'unknown']);
  assert.equal(steps.find((e) => e.step === 'heard' && e.digits === '2').text, '');
  u.stop();
});

test('free mode: words and keys map to the right answer; empty data is said plainly', async () => {
  for (const [text, want] of [['how are we doing', 'profit'], ['profit this week', 'profit-week'], ['results for the month', 'profit-month'], ['what coins are we holding', 'coins'], ['show recent trades', 'trades'], ['what did the brain learn', 'brain'], ['status', 'health'], ['help', 'help'], ['bye', 'bye'], ['blah', 'unknown']]) assert.equal(freeIntent(text), want, text);
  for (const [d, want] of [['1', 'profit'], ['3', 'trades'], ['5', 'health'], ['7', 'price'], ['9', 'bye'], ['0', 'help']]) assert.equal(freeIntent('', d), want, d);
  assert.equal(await freeAnswer('coins', {positions: () => []}), 'We are not holding any coins right now, sir.');
  assert.equal(await freeAnswer('trades', {closed: () => []}), 'There are no closed trades yet, sir.');
  assert.match(await freeAnswer('profit', {closed: () => [], overview: () => ({pnlTodaySol: 0})}), /^There were no closed trades in the last 24 hours, sir\. Profit today is 0 SOL\.$/);
  assert.equal(await freeAnswer('brain', {}), 'The brain has nothing to report yet, sir.');
  assert.equal(await freeAnswer('overview', {overview: () => { throw new Error('x'); }}), 'My apologies, sir. I could not read the bot just now.');
});

test('voicemail: a voicemail greeting gets a short message and a hang-up, not the menu or the AI', async () => {
  const steps = []; let asked = 0;
  for (const g of ['forwarded to voicemail the person you are trying to reach is not available at the tone please record your message when you have finished recording you may hang up', 'please leave a message after the beep']) assert.ok(VOICEMAIL.test(g), g);
  for (const o of ['how much profit today', 'what coins are we holding', 'bye']) assert.ok(!VOICEMAIL.test(o), o);
  for (const apiKey of ['', 'k']) {
    const u = createUltron({random: () => 0, apiKey, trace: (e) => steps.push(e), fetchImpl: async () => { asked++; throw new Error('no'); }});
    const id = u.open({}); u.sessions.get(id).callSid = 'V';
    const out = await u.turn({base: BASE, key: KEY, id, callSid: 'V', speech: 'forwarded to voicemail the person you are trying to reach is not available at the tone please record your message', voice: 'man'});
    assert.match(out, /Sir, this is Ultron\..*Please call me back.*<Hangup\/>/); assert.equal(u.sessions.size, 0);
    assert.equal(steps.at(-1).why, 'voicemail answered: left a short message'); u.stop();
  }
  assert.equal(asked, 0, 'no AI request for a voicemail'); assert.ok(steps.some((e) => e.step === 'voicemail'));
});

test('greeting: good morning, afternoon or evening, sir, by the owner\'s own time zone', () => {
  const at = (h) => Date.UTC(2026, 10, 15, h); // America/New_York is UTC-5 in November
  assert.equal(greeting(at(14), 'America/New_York'), 'Good morning, sir.');
  assert.equal(greeting(at(19), 'America/New_York'), 'Good afternoon, sir.');
  assert.equal(greeting(at(1), 'America/New_York'), 'Good evening, sir.');
  assert.equal(greeting(at(9), 'not/a-zone'), 'Good morning, sir.', 'a bad zone falls back to UTC');
});

test('Ultron\'s lines vary from call to call, always polite, always "sir"', async () => {
  const {LINES} = await import('./ultron.mjs');
  for (const [k, list] of Object.entries(LINES)) for (const line of list) assert.match(line, /sir|Ultron/i, k + ': ' + line);
  const seen = new Set();
  for (let i = 0; i < 4; i++) {
    const u = createUltron({random: () => i / 4, apiKey: '', data: {}});
    const id = u.open({}); u.sessions.get(id).callSid = 'R';
    const out = await u.turn({base: BASE, key: KEY, id, callSid: 'R', speech: 'goodbye', voice: 'man'});
    seen.add(spoken(out)); u.stop();
  }
  assert.equal(seen.size, 4, 'four different farewells');
});

test('tasks: one entry each (menu name, unique key, words, answer); the menu and keypad are built from the list', async () => {
  const {TASKS, FREE_MENU} = await import('./ultron.mjs');
  const menu = TASKS.filter((t) => t.menu);
  assert.deepEqual(menu.map((t) => t.key).sort(), ['1', '2', '3', '4', '5', '6', '7', '8']);
  assert.equal(new Set(menu.map((t) => t.key)).size, menu.length, 'keys are unique'); assert.ok(!menu.some((t) => t.key === '9'), '9 stays goodbye');
  for (const t of menu) { assert.ok(t.words instanceof RegExp, t.id); assert.equal(typeof t.say, 'function', t.id); assert.match(FREE_MENU, new RegExp(t.menu)); assert.equal(freeIntent('', t.key), t.id); }
  assert.equal(freeIntent('repeat the list'), 'help'); assert.equal(freeIntent('say that again'), 'unknown');
  for (const t of TASKS) assert.match(await freeAnswer(t.id, {}), /\S/, t.id + ' answers even with no data');
});

test('new tasks: briefing, SOL price, Decu, Rolex goal, credits, best and worst with the streak', async () => {
  const now = Date.UTC(2026, 10, 15, 15), min = 60_000;
  const data = {
    overview: () => ({mode: 'paper', pnlTodaySol: 0.3}),
    briefing: () => ({trades: [{fcat: 0.2}, {fcat: -0.1}, {fcat: 0.5}], ready: {ready: false, blocking: ['New buys allowed']}, helius: {credits: 812_000, limit: 1_000_000}, solUsd: 142.37, rankLine: 'Rookie (1/6) · bankroll 1.2 SOL'}),
    price: () => ({solUsd: 142.37, yesterday: 135}),
    decu: () => ({buys: [{coin: 'PEPE', at: now - 5 * min, sol: 2.5, taken: false, skip: 'entry premium 80% over the limit'}], sells: [{coin: 'DOGE', at: now - 2 * 60 * min}]}),
    goal: () => ({name: 'Rolex GMT-Master II', goalUsd: 20000, mode: 'paper', paperUsd: 1234.5}),
    credits: () => ({credits: 1_000_000, limit: 1_000_000, out: {since: 'x'}, resetsInDays: 12}),
    closed: () => [{coin: 'A', pnlSol: -0.02, closedAt: now - 30 * 60 * min}, {coin: 'B', pnlSol: 0.1, closedAt: now - 3 * 60 * min}, {coin: 'C', pnlSol: -0.04, closedAt: now - 2 * 60 * min}, {coin: 'D', pnlSol: 0.3, closedAt: now - 60 * min}, {coin: 'E', pnlSol: 0.05, closedAt: now - 10 * min}],
  };
  const say = (intent) => freeAnswer(intent, data, now);
  assert.equal(await say('briefing'), 'Here is your briefing, sir. In the last 24 hours we copied 3 trades, and 2 of them won. Profit today is plus 0.3 SOL. We are not ready to trade: New buys allowed. Helius credits: 812 thousand of 1 million used this month. SOL is at 142.37 dollars. The brain: Rookie (1/6).');
  assert.equal(await say('price'), 'SOL is at 142.37 dollars, sir. That is up 5 percent since yesterday\'s briefing.');
  assert.equal(await say('decu'), 'Decu\'s last buy was PEPE, about 2.5 SOL, 5 minutes ago. We skipped it: entry premium 80% over the limit. His last sale was DOGE, 2 hours ago.');
  assert.equal(await say('goal'), 'The goal is the Rolex GMT-Master II, at 20,000 dollars, sir. Paper profit so far is 1,235 dollars, 6 percent of the way.');
  assert.equal(await say('credits'), 'Helius is out of credits, sir. The bot cannot see Decu\'s trades until the plan resets, in 12 days, or is upgraded.');
  assert.equal(await freeAnswer('credits', {credits: () => ({credits: 400_000, limit: 1_000_000, pace: 1_300_000, resetsInDays: 9})}, now), 'We have used 400 thousand of 1 million Helius credits this month, sir. At this pace we will use 1.3 million, which is over the plan. The plan resets in 9 days.');
  assert.equal(await say('best'), 'In the last 24 hours, sir, our best was D, at plus 0.3 SOL. The worst was C, at minus 0.04 SOL. We are on a 2 trade winning streak.');
  for (const [text, want] of [['give me the briefing', 'briefing'], ['what is the price of sol', 'price'], ['what did decu do', 'decu'], ['how close is the rolex', 'goal'], ['how are our helius credits', 'credits'], ['what was the best trade', 'best'], ['are we on a losing streak', 'best']]) assert.equal(freeIntent(text), want, text);
  for (const [d, want] of [['6', 'briefing'], ['7', 'price'], ['8', 'decu']]) assert.equal(freeIntent('', d), want);
  assert.match(FREE_MENU, /the SOL price, Decu, the Rolex goal, our credits, or the best and worst trades, sir\./); assert.doesNotMatch(FREE_MENU, /press/, 'no keypad talk');
});

// ---------- orders ----------
const ordersBot = (policy = {}, extra = {}) => {
  const done = [], steps = [];
  const actions = Object.fromEntries(['pause-buys', 'resume-buys', 'manual-sells', 'emergency', 'sell-all', 'sell-coin', 'power-off', 'power-on', 'alerts-off', 'alerts-on', 'big-wins-off', 'big-wins-on', 'voice', 'send-briefing', 'call-back']
    .map((id) => [id, (args) => { done.push({id, args}); return `Done: ${id}.`; }]));
  const u = createUltron({random: () => 0, apiKey: '', actions, trace: (e) => steps.push(e), policy: () => ({mode: 'paper', ...policy}),
    data: {positions: () => [{mint: 'M1', coin: 'PEPE', profitPct: 10}, {mint: 'M2', coin: 'DOGE', profitPct: -5}]}, ...extra});
  const id = u.open({}); u.sessions.get(id).callSid = 'O';
  const talk = async (speech, digits) => spoken(await u.turn({base: BASE, key: KEY, id, callSid: 'O', speech, digits, voice: 'man'}));
  return {u, id, talk, done, steps};
};

test('orders: words become orders; questions never do; the spoken password matches close mishearings only', () => {
  for (const [t, id] of [['pause buying', 'pause-buys'], ['please stop buying', 'pause-buys'], ['resume trading', 'resume-buys'], ['sell everything', 'sell-all'], ['sell pepe', 'sell-coin'], ['emergency stop', 'emergency'], ['power off', 'power-off'], ['mute alerts', 'alerts-off'], ['stop calling me about big wins', 'big-wins-off'], ['send me the briefing', 'send-briefing'], ['call me back in 10 minutes', 'call-back'], ['change your voice to brian', 'voice']]) assert.equal(parseOrder(t)?.id, id, t);
  for (const q of ['what did we sell', 'how are we doing', 'did decu sell', 'is the bot powered on']) assert.equal(parseOrder(q), null, q);
  assert.deepEqual(parseOrder('sell the second coin').args, {position: 2}); assert.deepEqual(parseOrder('call me back in an hour').args, {minutes: 60});
  for (const h of ['open sesame', 'open sesam', 'open sesame please']) assert.ok(passwordMatch(h, 'open sesame'), h);
  for (const h of ['open the coins', 'profit', '']) assert.ok(!passwordMatch(h, 'open sesame'), h);
  assert.ok(!passwordMatch('anything', ''), 'no password set: nothing matches');
  assert.match(ORDERS_MENU, /^I can sell everything, sell a coin, emergency stop, pause buying/);
});

test('orders: a trading order waits for the password, then asks to confirm; yes runs it, no does not', async () => {
  const {talk, done, steps, u} = ordersBot({passphrase: 'open sesame'});
  assert.match(await talk('pause buying'), /^Orders are locked, sir\. Say the password to unlock me\./);
  assert.equal(done.length, 0);
  assert.match(await talk('open sesam'), /^Zombie GMT Master Two\. Welcome back, sir\. Full access granted\. Every system is yours\. To confirm, sir: I will pause new buys\. .*Shall I proceed, sir\?$/);
  assert.match(await talk('yes'), /^Done: pause-buys\./); assert.deepEqual(done.map((x) => x.id), ['pause-buys']);
  assert.match(await talk('sell everything'), /To confirm, sir: I will sell every coin we hold/);
  assert.match(await talk('', '2'), /^Very good, sir\. I will leave things as they are\./); assert.equal(done.length, 1, 'no means no');
  assert.match(await talk('sell the second coin'), /I will sell all of DOGE\./); assert.match(await talk('', '1'), /Done: sell-coin/);
  assert.deepEqual(done.at(-1).args, {position: 2, mint: 'M2', coin: 'DOGE'});
  assert.match(await talk('sell'), /^Which coin, sir\? We hold first, PEPE; second, DOGE\./);
  assert.match(await talk('emergency stop'), /Shall I proceed/); assert.match(await talk('banana'), /I need a yes or a no, sir/); assert.match(await talk('banana'), /I will take that as a no, sir/);
  // the password is never written to the log
  assert.ok(steps.some((e) => e.step === 'heard' && e.text === '[password spoken]')); assert.doesNotMatch(JSON.stringify(steps), /open says me|open sesame/);
  u.stop();
});

test('orders: three wrong passwords lock orders for the call; reading tasks never need the password', async () => {
  const {talk, done, u} = ordersBot({passphrase: 'open sesame'});
  for (let i = 0; i < 3; i++) { await talk('pause buying'); var r = await talk('wrong words'); }
  assert.match(r, /Orders stay locked for this call/); assert.equal(done.length, 0);
  assert.match(await talk('how are we doing'), /sir/); u.stop();
});

test('orders: live mode refuses trading orders; calls to Ultron need the password; harmless orders need neither', async () => {
  let b = ordersBot({mode: 'live', passphrase: ''});
  assert.match(await b.talk('pause buying'), /I only take trading orders in paper mode, sir/); assert.equal(b.done.length, 0); b.u.stop();
  b = ordersBot({passphrase: ''}); b.u.sessions.get(b.id).direction = 'inbound';
  assert.match(await b.talk('sell everything'), /only take trading orders on calls I place to you/); b.u.stop();
  b = ordersBot({passphrase: ''}); // Ultron placed the call, no password set: confirm only
  assert.match(await b.talk('power off'), /Shall I proceed/); assert.match(await b.talk('yes'), /Done: power-off/); b.u.stop();
  b = ordersBot({passphrase: 'open sesame'});
  assert.match(await b.talk('send me the briefing'), /^Done: send-briefing/, 'no confirmation, no password');
  assert.match(await b.talk('call me back in 15 minutes'), /^Done: call-back/); assert.deepEqual(b.done.at(-1).args, {minutes: 15});
  assert.match(await b.talk('call me back later'), /In how many minutes, sir\?/);
  assert.match(await b.talk('mute alerts'), /Shall I proceed/); assert.match(await b.talk('yes please'), /Done: alerts-off/);
  assert.match(await b.talk('orders'), /^I can sell everything/); b.u.stop();
});

test('orders: the AI can only propose an order; it runs after the owner says yes', async () => {
  const done = []; let n = 0;
  const fetchImpl = async (url, init) => { n++; const b = JSON.parse(init.body);
    if (n === 1) return {ok: true, status: 200, json: async () => ({stop_reason: 'tool_use', content: [{type: 'tool_use', id: 't1', name: 'request_action', input: {action: 'pause-buys'}}]})};
    const last = b.messages.at(-1).content[0].content; return {ok: true, status: 200, json: async () => ({stop_reason: 'end_turn', content: [{type: 'text', text: last}]})}; };
  const u = createUltron({random: () => 0, apiKey: 'k', fetchImpl, actions: {'pause-buys': () => { done.push(1); return 'Done, sir. New buys are paused.'; }}, policy: () => ({mode: 'paper', passphrase: ''}), data: {}});
  const id = u.open({}); u.sessions.get(id).callSid = 'A';
  const asked = spoken(await u.turn({base: BASE, key: KEY, id, callSid: 'A', speech: 'pause the bot', voice: 'man'}));
  assert.match(asked, /Shall I proceed/); assert.equal(done.length, 0, 'proposing runs nothing');
  assert.match(spoken(await u.turn({base: BASE, key: KEY, id, callSid: 'A', speech: 'yes', voice: 'man'})), /Done, sir\. New buys are paused\./); assert.equal(done.length, 1);
  u.stop();
});

test('unlock: the phrase, a 2-second pause, then the welcome; "Ultron, ..." in front of a request is just his name', async () => {
  const u = createUltron({random: () => 0, apiKey: '', policy: () => ({mode: 'paper', passphrase: 'open sesame'}), actions: {}, data: {}});
  const id = u.open({}); u.sessions.get(id).callSid = 'Z';
  const out = await u.turn({base: BASE, key: KEY, id, callSid: 'Z', speech: 'open sesame', voice: 'Polly.Brian'});
  assert.match(out, /Zombie GMT Master Two\.<\/amazon:effect><\/amazon:effect><\/prosody><\/Say><Pause length="2"\/><Say voice="Polly.Brian">/, 'the phrase, then a 2-second pause');
  assert.equal(spoken(out), 'Zombie GMT Master Two. Welcome back, sir. Full access granted. Every system is yours. How may I help, sir?');
  assert.match(out, /Welcome back, <break time="150ms"\/>sir\. <break time="350ms"\/>Full access granted\./, 'a beat after each comma and sentence');
  assert.doesNotMatch(out, /\[pause\]/, 'the marker is never spoken');
  const custom = createUltron({random: () => 0, apiKey: '', unlockPhrase: '', policy: () => ({mode: 'paper', passphrase: 'open sesame'}), data: {}});
  const id2 = custom.open({}); custom.sessions.get(id2).callSid = 'Y';
  assert.equal(spoken(await custom.turn({base: BASE, key: KEY, id: id2, callSid: 'Y', speech: 'open sesame', voice: 'man'})), 'Welcome back, sir. Full access granted. Every system is yours. How may I help, sir?', 'no phrase set: just the welcome');
  for (const [said, meant] of [['Ultron, pause buying', 'pause buying'], ['hey Ultron what did we sell', 'what did we sell'], ['okay ultron. profit', 'profit'], ['profit', 'profit']]) assert.equal(addressedTo(said), meant);
  assert.equal(parseOrder(addressedTo('Ultron what did we sell')), null, 'a question with his name in front is still a question');
  u.stop(); custom.stop();
});

test('small talk: hello, who, a lone yes, thanks and "hold on" get a proper answer; "hold on" is not a coins question', async () => {
  for (const [said, want] of [['hello', 'hello'], ['hey', 'hello'], ['good evening', 'hello'], ['who', 'who'], ['who is this', 'who'], ['yes', 'ack'], ['okay', 'ack'], ['thanks', 'thanks'], ['sorry hold on just a second', 'wait'], ['give me a minute', 'wait'], ['what coins are we holding', 'coins'], ['hey what is the profit', 'profit'], ['why did you want to know', 'unknown']]) assert.equal(freeIntent(said), want, said);
  assert.equal(await freeAnswer('hello', {}), 'Hello, sir. How may I help?');
  assert.equal(await freeAnswer('wait', {}), 'Take your time, sir. I am here.');
  assert.match(await freeAnswer('who', {}), /^Ultron, sir\./);
  // after "hold on" he waits through several silences instead of hanging up after two
  const u = createUltron({random: () => 0, apiKey: '', data: {}}); const id = u.open({}); u.sessions.get(id).callSid = 'W';
  const talk = (speech, silence) => u.turn({base: BASE, key: KEY, id, callSid: 'W', speech, silence, voice: 'man'});
  assert.match(spoken(await talk('hold on a second')), /Take your time, sir/);
  for (let i = 0; i < 4; i++) assert.doesNotMatch(await talk('', true), /<Hangup/, 'still waiting ' + i);
  assert.match(await talk('', true), /<Hangup/); u.stop();
  // "Ultron" on its own is a hello
  const v = createUltron({random: () => 0, apiKey: '', data: {}}); const id2 = v.open({}); v.sessions.get(id2).callSid = 'V';
  assert.equal(spoken(await v.turn({base: BASE, key: KEY, id: id2, callSid: 'V', speech: 'Ultron', voice: 'man'})), 'Hello, sir. How may I help?'); v.stop();
});

test('conversation: how he is, jokes, the time, good night, advice, praise; questions starting "should I" are not orders', async () => {
  const {CHAT, plainProblem} = await import('./ultron.mjs');
  for (const [said, want] of [['how are you', 'howareyou'], ['tell me a joke', 'joke'], ['what time is it', 'time'], ['what day is it', 'date'], ['good night ultron', 'goodnight'], ['should i sell everything', 'advice'], ['good job', 'praise'], ['are you there', 'there'], ['who made you', 'creator'], ['motivate me', 'motivate'], ["i'm back", 'back'], ['never mind', 'sorry'], ["i'm bored", 'bored']]) assert.equal(freeIntent(said), want, said);
  assert.equal(parseOrder('should i sell everything'), null);
  for (const c of CHAT) for (const l of c.lines) { const t = typeof l === 'function' ? l({now: Date.UTC(2026, 10, 15, 2), timezone: 'America/New_York'}) : l; assert.match(t, /sir|Ultron/i, c.id + ': ' + t); }
  assert.equal(await freeAnswer('time', {}, Date.UTC(2026, 10, 15, 2, 5), undefined, {timezone: 'America/New_York'}), 'It is 9:05 PM, sir.');
  const u = createUltron({random: () => 0, apiKey: '', data: {}}); const id = u.open({}); u.sessions.get(id).callSid = 'N';
  assert.equal(spoken(await u.turn({base: BASE, key: KEY, id, callSid: 'N', speech: 'tell me a joke', voice: 'man'})), 'I asked the blockchain for advice, sir. It said it would get back to me in a few blocks. How may I help, sir?');
  const night = await u.turn({base: BASE, key: KEY, id, callSid: 'N', speech: 'good night', voice: 'man'});
  assert.equal(spoken(night), 'Good night, sir. I will keep watch.'); assert.match(night, /<Hangup\/>/); assert.equal(u.sessions.size, 0); u.stop();
  assert.equal(plainProblem('poll error: RPC getSignaturesForAddress: Helius out of credits, calls paused until 04:15 UTC'), "Helius is out of credits, so we cannot see Decu's trades");
  assert.equal(plainProblem('New buys allowed'), 'new buys are blocked');
  assert.equal(await freeAnswer('coins', {positions: () => [{mint: 'M', coin: null, profitPct: 3}]}), 'We are holding 1 coin, sir. an unnamed coin, up 3 percent.');
});

test('conversation: 140+ lines, all addressed to sir; small talk never steals a real question', async () => {
  const {CHAT} = await import('./ultron.mjs');
  assert.ok(CHAT.reduce((n, c) => n + c.lines.length, 0) >= 140);
  assert.equal(new Set(CHAT.map((c) => c.id)).size, CHAT.length, 'unique topics');
  for (const [q, want] of [['how much have we lost', 'profit'], ['what is up with decu', 'decu'], ['tell me something about the trades', 'trades'], ['profit this week', 'profit-week'], ['what coins are we holding', 'coins'], ['whats the sol price', 'price']]) assert.equal(freeIntent(q), want, q);
  for (const [q, want] of [['we lost again', 'lostmoney'], ['lets go', 'happy'], ['are you alive', 'alive'], ['do you sleep', 'sleep'], ["i'm stressed", 'stressed'], ['give me a fun fact', 'funfact'], ['what are you doing', 'thinking'], ['tell me a secret', 'secret']]) assert.equal(freeIntent(q), want, q);
});

test('voice samples: Ultron first, then six Jarvis-style butler voices; "two" picks the default butler; the reply already uses it', async () => {
  const picked = [];
  const u = createUltron({random: () => 0, apiKey: '', actions: {voice: ({style}) => { picked.push(style); return 'ok'; }}, data: {}});
  const id = u.open({samples: true}); u.sessions.get(id).callSid = 'S';
  const first = await u.start({base: BASE, key: KEY, id, callSid: 'S', voice: styleOf({})});
  assert.deepEqual(STYLES.map((x) => x.id), ['deep2', 'butler2', 'jarvis-pure', 'jarvis-calm', 'jarvis-crisp', 'jarvis-natural', 'jarvis-arthur']);
  assert.match(spoken(first), /^Sample one\. Good evening, sir\. Ultron online\..*Sample two\. Good evening, sir\. At your service\..*Sample seven\..*Which do you prefer, sir\? Say a number from one to seven\./);
  assert.match(first, /<Say voice="Polly.Matthew"><prosody rate="118%" pitch="-10%"><amazon:effect name="drc"><amazon:effect vocal-tract-length="\+10%">Good evening/, '1: the Ultron voice (old sample 6)');
  assert.match(first, /<Say voice="Polly.Brian"><prosody rate="112%"><amazon:effect name="drc">Good evening/, '3: pure, no pitch drop, no big-voice effect');
  for (const v of ['Polly.Brian-Neural', 'Polly.Arthur-Neural']) assert.match(first, new RegExp(`<Say voice="${v}"><prosody rate="10\\d%">Good evening`), `${v}: speed only, no effects`);
  const pick = await u.turn({base: BASE, key: KEY, id, callSid: 'S', speech: 'number two', voice: styleOf({})});
  assert.deepEqual(picked, ['butler2']); assert.match(spoken(pick), /^Sample two it is, sir\./);
  assert.match(pick, /rate="118%" pitch="-5%">.*vocal-tract-length="\+5%"/, 'said in the new style');
  // samples can be asked for in any call; "again" replays them; a voice order picks by name
  assert.match(spoken(await u.turn({base: BASE, key: KEY, id, callSid: 'S', speech: 'play the voice samples', voice: styleOf({})})), /Sample five\./);
  assert.match(spoken(await u.turn({base: BASE, key: KEY, id, callSid: 'S', speech: 'again', voice: styleOf({})})), /Sample one\./);
  await u.turn({base: BASE, key: KEY, id, callSid: 'S', speech: 'the deep one', voice: styleOf({})}); assert.equal(picked.at(-1), 'deep2');
  assert.deepEqual(parseOrder('switch to voice three').args, {style: 'jarvis-pure', voice: null});
  assert.equal(styleFromWords('use the jarvis voice'), 'butler2'); assert.equal(styleFromWords('arthur'), 'jarvis-arthur');
  assert.equal(styleFromWords('banana'), null); assert.equal(styleOf({style: 'nope'}).id, 'butler2', 'an old or unknown voice: the default');
  u.stop();
});

test('voice list: everyone starts on the default butler voice once; later picks are kept', () => {
  assert.equal(cleanSettings({style: 'dark'}).style, 'butler2', 'an old saved voice moves to the new default');
  assert.equal(cleanSettings({style: 'deep2'}).style, 'butler2', 'even one still on the list, once');
  const picked = cleanSettings({style: 'dark'}, {style: 'jarvis-calm'});
  assert.equal(picked.style, 'jarvis-calm'); assert.equal(picked.voiceList, 2);
  assert.equal(cleanSettings(picked).style, 'jarvis-calm', 'after that, his choice stays');
});
