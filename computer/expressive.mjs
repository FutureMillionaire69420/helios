// EXPRESSIVE SPEECH for the Jarvis-style butler voices: the voice follows what is being said and how the owner
// sounds. Ultron's robot voices stay flat on purpose.
//   1. The owner's mood, heard from his words on each turn (the phone gives the bot his words, not his tone):
//      upset (stressed, worried, a bad day), angry, excited, happy, or neutral.
//   2. The mood of the reply: stern for bad news (losses, failures, blocks, emergencies), upbeat for good news,
//      warm and gentle when the owner is upset, calm and steady when he is angry.
//   3. Each sentence shaped on its own: a question lifts at the end, an exclamation gets energy, bad news gets a
//      beat before it, numbers and key words are stressed, and the pace breathes between sentences.
// All of it is SSML that Amazon Polly reads (SignalWire and Twilio pass it through). Neural voices take rate and
// volume only (no pitch, emphasis or effects), so for them the shaping is done with speed, volume and pauses.

const has = (re, x) => re.test(String(x || '').toLowerCase());
const UPSET = /\b(stress(ed)?|worried|scared|nervous|anxious|bad day|rough day|tired|exhausted|sad|depress|down bad|lost (it|everything|money)|we lost|i('m| am) (broke|done)|ugh|terrible|awful|help me)\b/;
const ANGRY = /\b(angry|mad|pissed|furious|annoyed|what the (hell|heck|fuck)|wtf|damn|stupid|useless|why (did|didn'?t|is|isn'?t) (it|you)|shut up|you (idiot|failed))\b/;
const EXCITED = /\b(let'?s go|lets go|hell yes|yes+!|amazing|insane|huge|moon|pump(ed|ing)|we('re| are) rich|lfg|awesome|incredible|wow)\b|!{2,}/;
const HAPPY = /\b(good|great|nice|thanks|thank you|love (it|you)|perfect|excellent|well done|good job|happy|glad)\b/;

/** The owner's mood from his words this turn. */
export function hearMood(heard = '') {
  if (has(ANGRY, heard)) return 'angry';
  if (has(UPSET, heard)) return 'upset';
  if (has(EXCITED, heard)) return 'excited';
  if (has(HAPPY, heard)) return 'happy';
  return 'neutral';
}

const BAD = /\b(loss|lost|losing|down \d|failed|failure|error|blocked|cannot|can'?t|unable|emergency|stop(ped)?|warning|out of credits|not ready|problem|refused|danger|risk|sold at a loss|stop-loss|blind|offline|halt(ed)?|negative|minus)\b/;
const GOOD = /\b(profit|up \d|gain(ed)?|won|win|winning|record|excellent|splendid|great news|ready to trade|all systems|online|running smoothly|clear|green|landed|success(ful)?|plus \d|doubled|big win)\b/;

/** The mood to speak a reply in: what it says, and how the owner sounds. */
export function replyMood(text = '', owner = 'neutral') {
  const bad = has(BAD, text), good = has(GOOD, text);
  if (owner === 'upset') return 'warm';
  if (owner === 'angry') return 'calm';
  if (bad && !good) return 'stern';
  if (good && !bad) return owner === 'excited' || owner === 'happy' ? 'bright' : 'upbeat';
  if (owner === 'excited') return 'upbeat';
  if (owner === 'happy') return 'warm';
  return 'neutral';
}

// rate: change to the style's speed (points of %); pitch: % (standard voices only); volume: dB; gap: ms between sentences
export const MOODS = {
  neutral: {rate: 0, pitch: 0, volume: 0, gap: 230},
  upbeat: {rate: 5, pitch: 5, volume: 2, gap: 170},
  bright: {rate: 8, pitch: 8, volume: 3, gap: 150},
  warm: {rate: -8, pitch: -1, volume: -2, gap: 330, soft: true},
  calm: {rate: -10, pitch: -3, volume: -1, gap: 360},
  stern: {rate: -6, pitch: -6, volume: 2, gap: 300, beat: 250},
};

const xml = (s) => String(s).replace(/[<>&"']/g, (c) => ({'<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;'}[c]));
const signed = (n, unit) => `${n >= 0 ? '+' : ''}${n}${unit}`;
// numbers, money and percentages, and the words that carry the news
const KEY = /(\b\d[\d,]*(\.\d+)?\s*(%|percent|SOL|dollars?)?|\$\d[\d,]*(\.\d+)?|\b(profit|loss|lost|emergency|warning|blocked|ready|online|win|record|immediately|now)\b)/gi;

/**
 * SSML (the inside of <Say>) for one piece of text in a style and a mood. style: {rate, pitch, tract, voice}.
 * Sentences are shaped one by one; neural voices get rate and volume only.
 */
export function expressiveSsml(text, style, mood = 'neutral') {
  const m = MOODS[mood] || MOODS.neutral, neural = /-Neural$/.test(style.voice || ''), base = Number(style.rate) || 100;
  const sentences = String(text).split(/(?<=[.?!])\s+/).map((x) => x.trim()).filter(Boolean);
  const parts = sentences.map((raw, i) => {
    const q = /\?$/.test(raw), ex = /!$/.test(raw);
    const rate = Math.max(80, Math.min(130, Math.round(base + m.rate + (ex ? 4 : 0) - (q ? 2 : 0))));
    const pitch = (Number(style.pitch) || 0) + m.pitch + (ex ? 3 : 0);
    const volume = m.volume + (ex ? 2 : 0);
    // key words stressed (volume on neural, emphasis on standard), then a beat after each comma; a question
    // lifts on its last word (standard voices; neural voices lift questions by themselves)
    const shape = (x) => xml(x).replace(KEY, (k) => (neural ? `<prosody volume="+3dB">${k}</prosody>` : `<emphasis level="moderate">${k}</emphasis>`))
      .replace(/,\s+(?=\S)/g, `, <break time="${Math.round(m.gap / 3)}ms"/>`);
    const lift = q && !neural ? raw.match(/^(.*\s)?(\S+)\?$/) : null;
    const body = lift ? `${shape(lift[1] || '')}<prosody pitch="+6%">${shape(lift[2])}</prosody>?` : shape(raw);
    const attrs = `rate="${rate}%"${neural ? '' : ` pitch="${signed(pitch, '%')}"`}${volume ? ` volume="${signed(volume, 'dB')}"` : ''}`;
    const beat = m.beat && i === 0 ? `<break time="${m.beat}ms"/>` : '';
    return `${beat}<prosody ${attrs}>${body}</prosody>`;
  });
  let out = parts.join(` <break time="${m.gap}ms"/> `);
  if (neural) return out;
  if (m.soft) out = `<amazon:effect phonation="soft">${out}</amazon:effect>`;
  if (style.tract) out = `<amazon:effect vocal-tract-length="+${style.tract}%">${out}</amazon:effect>`;
  return `<amazon:effect name="drc">${out}</amazon:effect>`;
}
