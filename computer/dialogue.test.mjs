import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createDialogue, validate, guestFor, DIR} from './dialogue.mjs';
import {createUltron, freeIntent} from './ultron.mjs';

const CATEGORIES = ['greetings', 'morning-evening', 'casual', 'starters', 'humor', 'sarcasm', 'roast', 'encouragement', 'motivation', 'philosophy', 'science',
  'future-ai', 'strategy', 'professional', 'task-complete', 'questions', 'clarify', 'unexpected', 'discovery', 'success', 'mistakes', 'acknowledge', 'frustration',
  'entertainment', 'gaming', 'cybersecurity', 'brainstorm', 'ack', 'long-form', 'signature', 'transition', 'goodbye', 'unusual', 'improv', 'spontaneous'];

test('the dialogue library: at least 4,000 unique, valid lines across all 35 categories', () => {
  const r = validate(DIR, {min: 4000, required: CATEGORIES});
  assert.deepEqual(r.problems, [], r.problems.slice(0, 10).join('\n'));
  assert.ok(r.total >= 4000, `${r.total} lines`);
  assert.equal(Object.keys(r.byCat).length, 35);
  for (const c of CATEGORIES) assert.ok(r.byCat[c] >= 45, `${c}: ${r.byCat[c]}`);
  assert.ok(r.byCat.signature >= 300, 'hundreds of signature lines');
});

test('the validator catches duplicates, near-duplicates, empty and unspeakable lines, broken JSON and bad triggers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-'));
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({id: 'a', triggers: ['(unclosed'], entries: ['Hello there, friend of mine.', 'hello there friend of mine', '', 'Use <b>tags</b>', 'Friend of mine, hello there.', {t: 'x', mood: 'grumpy'}]}));
  fs.writeFileSync(path.join(dir, 'b.json'), '{not json');
  const r = validate(dir, {min: 10, required: ['a', 'missing']});
  const all = r.problems.join('\n');
  for (const want of ['bad trigger', 'duplicate', 'empty line', 'symbols the voice would read aloud', 'unknown mood', 'not valid JSON', 'near-duplicate', 'missing category missing', 'only'])
    assert.match(all, new RegExp(want), want);
});

test('picking lines: loaded only when needed, never repeated within a call, mood-aware, optional follow-up question', () => {
  let i = 0; const seq = [0.1, 0.7, 0.3, 0.9, 0.5, 0.2, 0.8, 0.4, 0.6, 0.05];
  const lib = createDialogue({random: () => seq[i++ % seq.length]});
  assert.equal(lib.loadedCount(), 0, 'no category read until it is needed');
  assert.equal(lib.match('tell me a joke'), 'humor'); assert.equal(lib.match('roast me please'), 'roast');
  assert.equal(lib.match("what's the meaning of life"), 'philosophy'); assert.equal(lib.match('guess what happened'), 'discovery');
  assert.equal(lib.match('xyzzy'), null);
  const session = {};
  const said = Array.from({length: 40}, () => lib.line('humor', {session, followUp: false}));
  assert.equal(new Set(said).size, 40, 'no repeats within a call');
  assert.equal(lib.loadedCount(), 1, 'only the humor file was read');
  const warm = createDialogue({random: () => 0.1});
  const w = warm.line('frustration', {mood: 'warm', followUp: false});
  const frust = JSON.parse(fs.readFileSync(path.join(DIR, '23-frustration.json'), 'utf8')).entries.filter((e) => e.mood === 'warm').map((e) => e.t);
  assert.ok(frust.includes(w), 'an upset owner gets a warm line');
  const q = createDialogue({random: () => 0.01}).line('strategy', {session: {}});
  assert.match(q, /\?\s*$/, 'a follow-up question was added');
});

test('packs: a new JSON file in dialogue/packs adds lines or whole categories without code changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-')); fs.mkdirSync(path.join(dir, 'packs'));
  fs.writeFileSync(path.join(dir, 'core.json'), JSON.stringify({id: 'humor', triggers: ['\\bjoke\\b'], entries: ['Core joke one.']}));
  fs.writeFileSync(path.join(dir, 'packs', 'humor-pack.json'), JSON.stringify({id: 'humor', entries: ['Pack joke two.']}));
  fs.writeFileSync(path.join(dir, 'packs', 'tactical.json'), JSON.stringify({id: 'tactical', triggers: ['\\btactical\\b'], priority: 60, entries: ['Tactical line.']}));
  const lib = createDialogue({dir, random: () => 0});
  assert.equal(lib.match('give me something tactical'), 'tactical');
  const s = {}; assert.deepEqual(new Set([lib.line('humor', {session: s}), lib.line('humor', {session: s})]), new Set(['Core joke one.', 'Pack joke two.']));
});

const HAS_GUESTS = fs.existsSync(path.join(DIR, 'guests.json')); // private file: not in the public mirror
test('guest greetings come from a guests file; nothing matches without one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-'));
  assert.equal(guestFor('Alex is here', dir), null);
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-'));
  fs.writeFileSync(path.join(dir2, 'guests.json'), JSON.stringify([{id: 'alex', words: ['\\balex is here\\b'], line: 'Welcome, Alex.'}]));
  assert.equal(guestFor('Ultron, Alex is here', dir2).line, 'Welcome, Alex.');
});

// the owner's guests (private, so the phrases and the greeting are read from the file, not written here)
const GUESTS = HAS_GUESTS ? JSON.parse(fs.readFileSync(path.join(DIR, 'guests.json'), 'utf8')) : [];
const NAME = GUESTS[0]?.id || '';
test('guest: "I\'m with <name>" or "<name> is here" gets that guest\'s greeting; other words do not', {skip: !HAS_GUESTS && 'no private guests file'}, () => {
  const N = NAME[0].toUpperCase() + NAME.slice(1);
  for (const x of [`hey Ultron I'm with ${N}`, `${N} is here`, `${NAME}'s here`, `Ultron, I am here with ${N}`, `${N} just arrived`])
    assert.equal(guestFor(x)?.line, GUESTS[0].line, x);
  for (const x of [`${NAME}ry work`, N, 'how is the bot']) assert.equal(guestFor(x), null, x);
});

const BASE = 'https://bot.example.com', KEY = 'k'.repeat(32);
const spoken = (x) => [...x.matchAll(/<Say[^>]*>(.*?)<\/Say>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()).join(' ');
const call = (random = () => 0.9) => {
  const u = createUltron({random, apiKey: '', data: {}, actions: {}});
  const id = u.open({}); u.sessions.get(id).callSid = 'S';
  return {u, ask: async (speech) => spoken(await u.turn({base: BASE, key: KEY, id, callSid: 'S', speech, voice: 'Polly.Brian'}))};
};

test('a call: the guest greeting in free mode; library categories answer what used to be "I did not understand"', async () => {
  const {u, ask} = call();
  if (HAS_GUESTS) assert.equal(await ask(`Hey Ultron, I'm with ${NAME}`), GUESTS[0].line);
  const philo = await ask('what do you think about free will');
  assert.doesNotMatch(philo, /did not understand/); assert.ok(philo.length > 20, philo);
  assert.equal(freeIntent('roast me ultron', '', {match: (x) => (/roast/.test(x) ? 'roast' : null)}), 'lib:roast');
  assert.equal(freeIntent('xyzzy', '', {match: () => null}), 'unknown');
  const lines = new Set(); for (let i = 0; i < 6; i++) lines.add(await ask('impress me'));
  assert.equal(lines.size, 6, 'six different signature lines in one call');
  u.stop();
});

test('a call: an upset owner who says something unmatched gets a warm frustration line, not "I did not understand"', async () => {
  const {u, ask} = call(() => 0.2);
  const r = await ask('ugh this is awful and nothing is going right, help me');
  assert.doesNotMatch(r, /did not understand/);
  u.stop();
});

test('a call: feelings win over stray keywords ("I am so stressed today" is not a profit question)', async () => {
  const {u, ask} = call(() => 0.3);
  const r = await ask('I am so stressed today');
  assert.doesNotMatch(r, /closed trades|Profit today/); assert.ok(r.length > 15, r);
  u.stop();
});
