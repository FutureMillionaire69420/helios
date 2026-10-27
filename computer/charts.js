// DASHBOARD CHARTS (SVG, no libraries, no outside requests: the page's security policy allows neither).
// Blue = made money / the measure, red = lost money, grey = context; validated for colour blindness on the card
// surface. Every chart has a hover/tap tooltip and a "Numbers" table so no value depends on colour or hover.
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (parent) parent.append(n); return n; };
const h = (tag, cls, text, parent) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; if (parent) parent.append(n); return n; };
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const fmtA = (v, unit, signed = true) => (!fin(v) ? '—' : unit === '%' ? `${signed && v > 0 ? '+' : ''}${v}%` : unit === 'SOL' ? `${signed && v > 0 ? '+' : ''}${Math.abs(v) < 0.01 && v !== 0 ? v.toFixed(4) : v.toFixed(3)} SOL` : unit === 's' ? `${v} s` : `${v}${unit ? ' ' + unit : ''}`);
// clean axis ticks: 1, 2 or 5 x 10^n steps
function ticks(lo, hi, n = 5) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const out = []; for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}
const short = (v) => { const a = Math.abs(v), s = a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1000 ? (a / 1000).toFixed(a >= 1e4 || a % 1000 === 0 ? 0 : 1) + 'K' : a < 0.01 && v !== 0 ? a.toFixed(3) : String(Math.round(a * 1000) / 1000); return v < 0 ? '−' + s : s; };

/** A chart frame sized to its box: svg + plot margins + y scale with a recessive grid. */
function frame(box, { height = null, lo, hi, pad = 0, yFmt = short, m = { l: 52, r: 16, t: 14, b: 30 } }) {
  const W = Math.max(280, Math.round(box.clientWidth || 640)), H = height || Math.round(Math.min(280, Math.max(200, W * 0.4)));
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart' });
  const span = (Math.max(hi, 0) - Math.min(lo, 0)) || 1;
  const ts = ticks(Math.min(lo, 0) - (lo < 0 ? span * pad : 0), Math.max(hi, 0) + (hi > 0 ? span * pad : 0)), y0 = ts[0], y1 = ts[ts.length - 1];
  const y = (v) => m.t + (H - m.t - m.b) * (1 - (v - y0) / (y1 - y0 || 1));
  for (const t of ts) { el('line', { x1: m.l, x2: W - m.r, y1: y(t), y2: y(t), class: t === 0 ? 'cz' : 'cg' }, svg); el('text', { x: m.l - 7, y: y(t) + 4, 'text-anchor': 'end', class: 'ct' }, svg).textContent = yFmt(t); }
  return { svg, W, H, M: m, y };
}
// x labels: as many as fit without touching (the last one always shows); long ones are cut with "…"
function xLabels(svg, labels, xc, { W, H, M }) {
  const n = labels.length; if (!n) return;
  const cw = 6.4, gap = 14, room = Math.max(5, Math.floor((W - M.l - M.r) / Math.min(n, 3) / cw) - 2);
  const text = (i) => { const s = String(labels[i]); return s.length > room ? s.slice(0, room - 1) + '…' : s; };
  const box = (i) => { const w = text(i).length * cw, x = xc(i); const anchor = n > 1 && i === 0 && x - w / 2 < M.l ? 'start' : n > 1 && i === n - 1 && x + w / 2 > W - M.r ? 'end' : 'middle'; const px = anchor === 'start' ? Math.max(M.l - 4, x - 6) : anchor === 'end' ? Math.min(W - M.r + 4, x + 6) : x; const lo = anchor === 'start' ? px : anchor === 'end' ? px - w : px - w / 2; return { i, px, anchor, lo, hi: lo + w }; };
  const placed = [];
  for (let i = 0; i < n; i++) { if (placed.length && text(i) === text(placed.at(-1).i)) continue; const b = box(i); if (!placed.length || b.lo >= placed.at(-1).hi + gap) placed.push(b); }
  const last = box(n - 1);
  if (placed.at(-1).i !== n - 1 && text(placed.at(-1).i) !== text(n - 1)) { while (placed.length && placed.at(-1).hi + gap > last.lo) placed.pop(); placed.push(last); }
  for (const b of placed) el('text', { x: b.px, y: H - M.b + 18, 'text-anchor': b.anchor, class: 'ct' }, svg).textContent = text(b.i);
}
function tooltip(box) {
  const tip = h('div', 'ctip', null, box); tip.hidden = true;
  const show = (evt, build) => { tip.replaceChildren(); build(tip); tip.hidden = false; const r = box.getBoundingClientRect(), w = tip.offsetWidth || 180; tip.style.left = Math.min(r.width - w - 4, Math.max(0, evt.clientX - r.left + 12)) + 'px'; tip.style.top = Math.max(0, evt.clientY - r.top - tip.offsetHeight - 10) + 'px'; };
  return { show, hide: () => { tip.hidden = true; } };
}
/** The table twin of a chart (accessibility, exact values). rows: arrays of cells. */
export function numbersTable(parent, cols, rows, { label = 'Numbers', max = 400 } = {}) {
  const d = h('details', 'cnums', null, parent); h('summary', null, label, d);
  const t = h('table', null, null, d), head = h('tr', null, null, t);
  for (const c of cols) h('th', null, c, head);
  for (const r of rows.slice(-max)) { const tr = h('tr', null, null, t); for (const c of r) h('td', null, String(c ?? '—'), tr); }
  return d;
}
const thin = (n, max) => { if (n <= max) return [...Array(n).keys()]; const k = n / max, out = []; for (let i = 0; i < max; i++) out.push(Math.floor(i * k)); if (out.at(-1) !== n - 1) out.push(n - 1); return out; };

/**
 * Lines over a shared x. series: [{name, values, tone: 'pos'|'neg'|'muted'}]. One series: no legend (the card
 * title names it), a soft area to zero. Two or more: legend + end labels. marks: [{i, label}] vertical markers.
 */
export function lineChart(box, { x, xShort = null, series, fmt = (v) => short(v), yFmt = short, height = null, area = null, marks = [], table = true, tableCols = null }) {
  box.replaceChildren();
  const all = series.flatMap((s) => s.values.filter(fin));
  if (!all.length) { h('p', 'fine', 'Nothing to chart yet.', box); return; }
  if (series.length > 1) { const lg = h('div', 'clegend', null, box); for (const s of series) h('span', s.tone === 'muted' ? 'muted' : '', s.name, lg); }
  const holder = h('div', 'cbox', null, box);
  const n = x.length, idx = thin(n, 360);
  const f = frame(holder, { height, lo: Math.min(...all), hi: Math.max(...all), yFmt });
  const { svg, W, H, M, y } = f;
  const xc = (i) => (n <= 1 ? (M.l + W - M.r) / 2 : M.l + ((W - M.l - M.r) * i) / (n - 1));
  xLabels(svg, xShort || x, xc, f);
  for (const mk of marks) { if (!fin(mk.i)) continue; el('line', { x1: xc(mk.i), x2: xc(mk.i), y1: M.t, y2: H - M.b, class: 'cmark' }, svg); el('text', { x: Math.min(W - M.r - 2, xc(mk.i) + 4), y: M.t + 10, class: 'cmarkt' }, svg).textContent = mk.label; }
  const single = series.length === 1, ends = [];
  for (const s of series) {
    const pts = idx.filter((i) => fin(s.values[i])).map((i) => [xc(i), y(s.values[i])]);
    if (!pts.length) continue;
    if ((area ?? single) && pts.length > 1) el('path', { d: `M${pts[0][0]},${y(0)} L${pts.map((p) => p.join(',')).join(' L')} L${pts.at(-1)[0]},${y(0)} Z`, class: 'carea' }, svg);
    el('polyline', { points: pts.map((p) => p.join(',')).join(' '), class: 'cline' + (s.tone === 'muted' ? ' muted' : s.tone === 'neg' ? ' neg' : '') }, svg);
    const li = [...Array(n).keys()].reverse().find((i) => fin(s.values[i]));
    if (li != null) { el('circle', { cx: xc(li), cy: y(s.values[li]), r: 4, class: 'cdot ' + (s.tone === 'muted' ? 'muted' : s.values[li] < 0 && single ? 'neg' : 'pos') }, svg); ends.push({ y: y(s.values[li]), x: xc(li), text: fmt(s.values[li]), muted: s.tone === 'muted' }); }
  }
  // end labels: selective; when two collide the context (grey) one gives way to the legend and tooltip
  ends.sort((a, b) => a.muted - b.muted);
  const placed = [];
  for (const e of ends) { const ly = e.y - 9 < M.t + 10 ? e.y + 18 : e.y - 9; if (placed.some((p) => Math.abs(p - ly) < 15)) continue; placed.push(ly); el('text', { x: Math.min(e.x, W - M.r) - 6, y: ly, 'text-anchor': 'end', class: 'cv' }, svg).textContent = e.text; }
  const { show, hide } = tooltip(holder);
  const cross = el('line', { y1: M.t, y2: H - M.b, class: 'cx', visibility: 'hidden' }, svg);
  const hit = el('rect', { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, class: 'chit' }, svg);
  const at = (e) => { const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W; return Math.max(0, Math.min(n - 1, Math.round(((px - M.l) / (W - M.l - M.r || 1)) * (n - 1)))); };
  const move = (e) => {
    const i = at(e); cross.setAttribute('x1', xc(i)); cross.setAttribute('x2', xc(i)); cross.setAttribute('visibility', 'visible');
    show(e, (tip) => { h('div', 'fine', String(x[i]), tip); for (const s of series) { const row = h('div', null, null, tip); const k = h('span', 'lk', null, row); k.style.background = s.tone === 'muted' ? '#8f8d86' : s.tone === 'neg' ? 'var(--neg)' : 'var(--pos)'; h('b', null, fmt(s.values[i]), row).style.display = 'inline'; if (!single) row.append(' ' + s.name); } });
  };
  hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hide(); });
  holder.prepend(svg);
  if (table) numbersTable(box, tableCols || ['', ...series.map((s) => s.name)], x.map((lab, i) => [lab, ...series.map((s) => fmt(s.values[i]))]));
}

/** Columns from one baseline (≤24 px, 2 px gap, rounded data end). diverging: below zero is red. */
export function barChart(box, { x, values, fmt = (v) => short(v), yFmt = short, height = null, diverging = true, notes = null, table = true, valueLabels = null }) {
  box.replaceChildren();
  const ok = values.filter(fin);
  if (!ok.length) { h('p', 'fine', 'Nothing to chart yet.', box); return; }
  const holder = h('div', 'cbox', null, box), n = values.length;
  const f = frame(holder, { height, lo: Math.min(...ok), hi: Math.max(...ok), pad: n <= 8 ? 0.14 : 0.04, yFmt });
  const { svg, W, H, M, y } = f, slot = (W - M.l - M.r) / Math.max(n, 1), xc = (i) => M.l + slot * (i + 0.5);
  xLabels(svg, x, xc, f);
  const { show, hide } = tooltip(holder);
  const bw = Math.min(24, Math.max(2, slot - 2)), zero = y(0);
  values.forEach((val, i) => {
    if (!fin(val)) return;
    const top = Math.min(y(val), zero), hgt = Math.max(1, Math.abs(y(val) - zero)), x0 = xc(i) - bw / 2, r = Math.min(4, hgt, bw / 2), up = val >= 0;
    const d = up ? `M${x0},${zero} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${zero} Z`
      : `M${x0},${zero} V${top + hgt - r} Q${x0},${top + hgt} ${x0 + r},${top + hgt} H${x0 + bw - r} Q${x0 + bw},${top + hgt} ${x0 + bw},${top + hgt - r} V${zero} Z`;
    el('path', { d, class: diverging && !up ? 'cbar neg' : 'cbar' }, svg);
    const hit = el('rect', { x: xc(i) - slot / 2, y: M.t, width: slot, height: H - M.t - M.b, class: 'chit', tabindex: 0 }, svg);
    const tell = (e) => show(e, (tip) => { h('b', null, fmt(val), tip); h('div', 'fine', String(x[i]) + (notes?.[i] ? ' · ' + notes[i] : ''), tip); });
    hit.addEventListener('pointermove', tell); hit.addEventListener('pointerdown', tell);
  });
  svg.addEventListener('pointerleave', hide);
  if (valueLabels ?? n <= 8) values.forEach((val, i) => { if (fin(val)) el('text', { x: xc(i), y: val >= 0 ? y(val) - 6 : y(val) + 14, 'text-anchor': 'middle', class: 'cv' }, svg).textContent = fmt(val); });
  holder.prepend(svg);
  if (table) numbersTable(box, ['', 'value', ...(notes ? [''] : [])], x.map((lab, i) => [lab, fmt(values[i]), ...(notes ? [notes[i] || ''] : [])]));
}

// ===== ANALYTICS (/api/analytics): the bot's own chart set, same as the phone digest =====
function drawAnalytic(ch, box) {
  if (ch.kind === 'scatter') {
    const holder = h('div', 'cbox', null, box), { show, hide } = tooltip(holder);
    const xs = ch.points.map((p) => p.x), ys = ch.points.map((p) => p.y);
    const f = frame(holder, { lo: Math.min(...ys), hi: Math.max(...ys) }), { svg, W, H, M, y } = f;
    const xt = ticks(0, Math.max(...xs, 1)), xmax = xt[xt.length - 1], x = (v) => M.l + (W - M.l - M.r) * (v / (xmax || 1));
    for (const t of xt) el('text', { x: x(t), y: H - M.b + 18, 'text-anchor': 'middle', class: 'ct' }, svg).textContent = short(t) + (ch.xUnit || '');
    for (const p of ch.points) {
      el('circle', { cx: x(p.x), cy: y(p.y), r: 5, class: p.y >= 0 ? 'cdot pos' : 'cdot neg' }, svg);
      const hit = el('circle', { cx: x(p.x), cy: y(p.y), r: 12, class: 'chit' }, svg);
      hit.addEventListener('pointermove', (e) => show(e, (tip) => { h('b', null, fmtA(p.y, '%'), tip); h('div', 'fine', `${p.label}: held ${p.x} s`, tip); }));
    }
    svg.addEventListener('pointerleave', hide); holder.prepend(svg);
    numbersTable(box, ['trade', `held (${ch.xUnit})`, ch.unit], ch.points.map((p) => [p.label, p.x, fmtA(p.y, '%')]));
    return;
  }
  if (ch.kind === 'line' && !ch.band) return lineChart(box, { x: ch.x, series: [{ name: ch.title, values: ch.values, tone: ch.tone === 'negative' ? 'neg' : 'pos' }], fmt: (v) => fmtA(v, ch.unit), area: false });
  if (ch.kind === 'line') {
    // a line with its middle-half band (price path after the buy)
    const holder = h('div', 'cbox', null, box), { show, hide } = tooltip(holder), v = ch.values, n = v.length;
    const lo = Math.min(...v.filter(fin), ...ch.band.lo.filter(fin)), hi = Math.max(...v.filter(fin), ...ch.band.hi.filter(fin));
    const f = frame(holder, { lo, hi }), { svg, W, H, M, y } = f, slot = (W - M.l - M.r) / Math.max(n, 1), xc = (i) => M.l + slot * (i + 0.5);
    xLabels(svg, ch.x, xc, f);
    const top = ch.band.hi.map((b, i) => `${xc(i)},${y(b)}`), bot = ch.band.lo.map((b, i) => `${xc(i)},${y(b)}`).reverse();
    el('polygon', { points: [...top, ...bot].join(' '), class: 'cband' }, svg);
    el('polyline', { points: v.map((val, i) => (fin(val) ? `${xc(i)},${y(val)}` : null)).filter(Boolean).join(' '), class: 'cline' }, svg);
    const hit = el('rect', { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, class: 'chit' }, svg), cross = el('line', { y1: M.t, y2: H - M.b, class: 'cx', visibility: 'hidden' }, svg);
    hit.addEventListener('pointermove', (e) => { const r = svg.getBoundingClientRect(), i = Math.max(0, Math.min(n - 1, Math.floor((((e.clientX - r.left) / r.width) * W - M.l) / slot))); cross.setAttribute('x1', xc(i)); cross.setAttribute('x2', xc(i)); cross.setAttribute('visibility', 'visible'); show(e, (tip) => { h('b', null, fmtA(v[i], ch.unit), tip); h('div', 'fine', `${ch.x[i]} · middle half ${fmtA(ch.band.lo[i], ch.unit)} to ${fmtA(ch.band.hi[i], ch.unit)}`, tip); }); });
    hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hide(); });
    holder.prepend(svg);
    numbersTable(box, ['', ch.unit, 'middle half'], v.map((val, i) => [ch.x[i], fmtA(val, ch.unit), `${fmtA(ch.band.lo[i], ch.unit)} to ${fmtA(ch.band.hi[i], ch.unit)}`]));
    return;
  }
  barChart(box, { x: ch.x, values: ch.values, fmt: (v) => fmtA(v, ch.unit, !!ch.diverging), diverging: !!ch.diverging, notes: ch.notes || null });
}
export function renderAnalytics(root, a) {
  root.replaceChildren();
  if (!a || !a.charts) { h('p', 'fine', 'No analytics yet.', root); return; }
  h('p', 'cnote', `Bought trades only (${a.bought} studied, ${a.closed} closed). Basis: ${a.basis}. Built from the bot's own records: no data credits used.`, root);
  const tiles = h('div', 'ctiles', null, root);
  for (const t of a.tiles) { const box = h('article', 'ctile', null, tiles); h('label', null, t.label, box); h('strong', t.signed && fin(t.value) ? (t.value >= 0 ? 'up' : 'down') : '', t.value == null ? '—' : `${t.signed && t.value > 0 ? '+' : ''}${t.value}${t.unit === '%' ? '%' : t.unit ? ' ' + t.unit : ''}`, box); }
  for (const ch of a.charts) {
    const card = h('div', 'ccard', null, root); h('h3', null, ch.title, card); h('p', 'csub', ch.subtitle, card);
    drawAnalytic(ch, h('div', null, null, card));
  }
}
