// SIGNALS (measured only, paper): extra facts recorded on every Decu buy, so the bot's own outcomes can say
// whether each one predicts anything. None of them filters or changes a trade. The checks come from common
// memecoin advice (KNOWLEDGE.md section 3): a big single holder, the coin's link type, a paid DexScreener
// profile, how busy pump.fun is, the hour, and the size of Decu's own buy.
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** The coin's X/Twitter link in its metadata (pump.fun JSON: twitter, website) -> 'community' (an X
 *  community), 'tweet' (a single post), 'profile' (an account), 'other' (only a non-X link), 'none', or null
 *  when the metadata itself is unknown. */
export function linkKind(meta) {
  if (!meta || typeof meta !== 'object') return null;
  const m = meta.metadata && typeof meta.metadata === 'object' ? meta.metadata : meta;
  const links = [m.twitter, m.x, meta.twitter, m.website, meta.website].filter((u) => typeof u === 'string' && u.trim());
  const tw = links.find((u) => /(^|[/.])(twitter|x)\.com\//i.test(u));
  if (!tw) return links.length ? 'other' : 'none';
  if (/\/i\/communities\//i.test(tw)) return 'community';
  if (/\/status(es)?\/\d/i.test(tw)) return 'tweet';
  return 'profile';
}

/** DexScreener orders for a token ([{type, status, paymentTimestamp}], or {orders: [...]}) -> {paid, at}: has
 *  its DexScreener profile been paid for (approved or still processing). null when the answer is unreadable. */
export function dexPaidFrom(r) {
  const list = Array.isArray(r) ? r : Array.isArray(r?.orders) ? r.orders : null;
  if (!list) return null;
  const paid = list.filter((o) => o && String(o.type) === 'tokenProfile' && ['approved', 'processing', 'on-hold'].includes(String(o.status)));
  const at = paid.map((o) => Number(o.paymentTimestamp)).filter((t) => t > 0);
  return { paid: paid.length > 0, at: at.length ? Math.min(...at) : null };
}

/** Rolling count of pump.fun launches (one timestamp per new coin), kept for windowMs. */
export function createLaunchCounter({ windowMs = 600_000, now = () => Date.now() } = {}) {
  const at = [];
  let since = null;
  const trim = () => { const cut = now() - windowMs; while (at.length && at[0] < cut) at.shift(); };
  return {
    add(t = now()) { if (since == null) since = t; at.push(t); if (at.length > 50_000) at.shift(); },
    /** launches in the last windowMs, or null until the counter has seen a full window */
    count() { trim(); return since != null && now() - since >= windowMs ? at.length : null; },
  };
}

/** Group label helpers for the notes. */
export const hourBlock = (sec) => { if (!fin(sec)) return null; const h = new Date(sec * 1000).getUTCHours(); const b = Math.floor(h / 4) * 4; return `${String(b).padStart(2, '0')}–${String(b + 4).padStart(2, '0')} UTC`; };
