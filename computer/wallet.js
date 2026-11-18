// WALLETS IN THE BROWSER: Solflare, Phantom, Backpack and every wallet that follows the Wallet Standard (they
// announce themselves to the page), plus the older injected providers (window.solflare, window.phantom.solana).
// The dashboard only asks a wallet for its PUBLIC address, to show it and check it against the bot's signer.
// It never asks a wallet to sign or send anything and never sees a key.
const found = new Map();
let listener = () => {};
const changed = () => listener(list());
export const list = () => [...found.values()].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
const rank = (n) => (/solflare/i.test(n) ? 0 : /phantom/i.test(n) ? 1 : 2);
const safeIcon = (icon) => (typeof icon === 'string' && /^data:image\/(svg\+xml|png|webp|jpeg|gif)[;,]/.test(icon) ? icon : null);

function addStandard(w) {
  if (!w?.name || !w.features?.['standard:connect'] || !(w.chains || []).some((c) => String(c).startsWith('solana:'))) return;
  found.set(w.name, {
    name: w.name, icon: safeIcon(w.icon), source: 'standard',
    async connect() {
      const out = await w.features['standard:connect'].connect();
      const acct = (out?.accounts?.length ? out.accounts : w.accounts || [])[0];
      if (!acct?.address) throw new Error(`${w.name} did not share an address.`);
      return acct.address;
    },
    async disconnect() { try { await w.features['standard:disconnect']?.disconnect(); } catch { /* already disconnected */ } },
  });
  changed();
}
function addInjected(name, provider) {
  if (!provider || [...found.keys()].some((k) => k.toLowerCase().includes(name.toLowerCase()))) return;
  found.set(name, {
    name, icon: null, source: 'injected',
    async connect() {
      const out = await provider.connect();
      const pk = out?.publicKey || provider.publicKey;
      const address = typeof pk === 'string' ? pk : pk?.toBase58?.() || pk?.toString?.() || '';
      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) throw new Error(`${name} did not share an address.`);
      return address;
    },
    async disconnect() { try { await provider.disconnect?.(); } catch { /* already disconnected */ } },
  });
  changed();
}
function legacy() {
  addInjected('Solflare', window.solflare?.isSolflare ? window.solflare : null);
  addInjected('Phantom', window.phantom?.solana?.isPhantom ? window.phantom.solana : null);
  addInjected('Backpack', window.backpack?.solana || window.backpack || null);
  const s = window.solana;
  if (s && !s.isPhantom && !s.isSolflare) addInjected('Solana wallet', s);
}
let started = false;
/** Start listening; cb(list) runs whenever a wallet appears. */
export function watchWallets(cb) {
  listener = cb;
  if (!started) {
    started = true;
    const api = Object.freeze({ register: (...ws) => { ws.forEach(addStandard); return () => {}; } });
    try { window.addEventListener('wallet-standard:register-wallet', (e) => { try { e.detail?.(api); } catch { /* a broken wallet */ } }); } catch { /* old browser */ }
    try { window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api })); } catch { /* old browser */ }
    setTimeout(legacy, 400); // standard wallets first; older providers fill the gaps
    setTimeout(legacy, 1500);
  }
  cb(list());
}
export const isPhone = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
/** A link that opens this dashboard inside the wallet app's own browser (where the wallet can connect). */
export function openInApp(app) {
  const url = encodeURIComponent(location.href.split('#')[0]), ref = encodeURIComponent(location.origin);
  return app === 'solflare' ? `https://solflare.com/ul/v1/browse/${url}?ref=${ref}` : `https://phantom.app/ul/browse/${url}?ref=${ref}`;
}
