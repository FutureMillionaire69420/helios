// Dashboard charts: draws the bot's analytics (/api/analytics) as SVG in the page. No libraries and no
// outside requests (the dashboard's security policy allows neither). Every chart has a hover tooltip and a
// "Numbers" table. Blue = made money / the measure, red = lost money; the colors pass color-blind checks
// on this dark background.
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  let W = 640, H = 260; const M = { l: 52, r: 14, t: 14, b: 44 }; // W / H follow the screen width (set per chart)
  const el = (tag, attrs = {}, parent) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (parent) parent.append(n); return n; };
  const h = (tag, cls, text, parent) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; if (parent) parent.append(n); return n; };
  const fin = (x) => typeof x === 'number' && Number.isFinite(x);
  const fmt = (v, unit, signed = true) => (!fin(v) ? '—' : unit === '%' ? `${signed && v > 0 ? '+' : ''}${v}%` : unit === 'SOL' ? `${signed && v > 0 ? '+' : ''}${Math.abs(v) < 0.01 && v !== 0 ? v.toFixed(4) : v.toFixed(3)} SOL` : unit === 's' ? `${v} s` : `${v}${unit ? ' ' + unit : ''}`);
  // clean axis ticks: 1, 2 or 5 x 10^n steps
  function ticks(lo, hi, n = 5) {
    if (lo === hi) { lo -= 1; hi += 1; }
    const raw = (hi - lo) / n, mag = 10 ** Math.floor(Math.log10(raw)), step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    const out = []; for (let v = Math.floor(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.round(v / step) * step);
    return out;
  }
  const short = (v) => { const a = Math.abs(v); return a >= 1000 ? (v / 1000).toFixed(1) + 'K' : a < 0.01 && v !== 0 ? v.toFixed(3) : String(Math.round(v * 1000) / 1000); };

  function frame(svg, lo, hi, pad = 0) {
    const span = (Math.max(hi, 0) - Math.min(lo, 0)) || 1;
    const ts = ticks(Math.min(lo, 0) - (lo < 0 ? span * pad : 0), Math.max(hi, 0) + (hi > 0 ? span * pad : 0)), y0 = ts[0], y1 = ts[ts.length - 1];
    const y = (v) => M.t + (H - M.t - M.b) * (1 - (v - y0) / (y1 - y0 || 1));
    for (const t of ts) { el('line', { x1: M.l, x2: W - M.r, y1: y(t), y2: y(t), class: t === 0 ? 'cz' : 'cg' }, svg); el('text', { x: M.l - 6, y: y(t) + 4, 'text-anchor': 'end', class: 'ct' }, svg).textContent = short(t); }
    return y;
  }
  function xLabels(svg, labels, xc) {
    const fit = Math.max(2, Math.floor((W - M.l - M.r) / 64)), shown = Math.min(labels.length, fit), every = Math.max(1, Math.ceil(labels.length / shown)), room = Math.max(4, Math.floor(((W - M.l - M.r) / shown) / 6.8) - 1);
    labels.forEach((lab, i) => { if (i % every && i !== labels.length - 1) return; const t = el('text', { x: i === 0 ? Math.max(M.l, xc(i) - 10) : i === labels.length - 1 ? Math.min(W - M.r, xc(i) + 10) : xc(i), y: H - M.b + 16, 'text-anchor': i === 0 && labels.length > 2 ? 'start' : i === labels.length - 1 && labels.length > 2 ? 'end' : 'middle', class: 'ct' }, svg); t.textContent = String(lab).length > room ? String(lab).slice(0, room - 1) + '…' : lab; });
  }

  function draw(ch, box, tip) {
    W = Math.max(300, Math.round(box.clientWidth || 640)); H = Math.round(Math.min(280, Math.max(220, W * 0.42)));
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': `${ch.title}: ${ch.subtitle || ''}` }, box);
    const show = (evt, text) => { tip.textContent = text; tip.hidden = false; const r = box.getBoundingClientRect(); tip.style.left = Math.min(r.width - 170, Math.max(0, evt.clientX - r.left + 10)) + 'px'; tip.style.top = Math.max(0, evt.clientY - r.top - 40) + 'px'; };
    const hide = () => { tip.hidden = true; };
    svg.addEventListener('pointerleave', hide);
    if (ch.kind === 'scatter') {
      const xs = ch.points.map((p) => p.x), ys = ch.points.map((p) => p.y);
      const y = frame(svg, Math.min(...ys), Math.max(...ys));
      const xt = ticks(0, Math.max(...xs, 1)), xmax = xt[xt.length - 1], x = (v) => M.l + (W - M.l - M.r) * (v / (xmax || 1));
      for (const t of xt) el('text', { x: x(t), y: H - M.b + 16, 'text-anchor': 'middle', class: 'ct' }, svg).textContent = short(t) + (ch.xUnit || '');
      for (const p of ch.points) {
        const c = el('circle', { cx: x(p.x), cy: y(p.y), r: 5, class: p.y >= 0 ? 'cdot pos' : 'cdot neg' }, svg);
        c.addEventListener('pointermove', (e) => show(e, `${p.label}: held ${p.x} s, ${fmt(p.y, '%')}`));
      }
      return;
    }
    const v = ch.values, n = v.length, ok = v.filter(fin);
    let lo = Math.min(...ok), hi = Math.max(...ok);
    if (ch.band) { lo = Math.min(lo, ...ch.band.lo.filter(fin)); hi = Math.max(hi, ...ch.band.hi.filter(fin)); }
    const y = frame(svg, lo, hi, ch.kind === 'columns' && n <= 8 ? 0.12 : 0), slot = (W - M.l - M.r) / Math.max(n, 1), xc = (i) => M.l + slot * (i + 0.5);
    xLabels(svg, ch.x, xc);
    if (ch.kind === 'line') {
      if (ch.band) { const top = ch.band.hi.map((b, i) => `${xc(i)},${y(b)}`), bot = ch.band.lo.map((b, i) => `${xc(i)},${y(b)}`).reverse(); el('polygon', { points: [...top, ...bot].join(' '), class: 'cband' }, svg); }
      const pts = v.map((val, i) => (fin(val) ? `${xc(i)},${y(val)}` : null)).filter(Boolean);
      el('polyline', { points: pts.join(' '), class: ch.tone === 'negative' ? 'cline neg' : 'cline' }, svg);
      const last = v.length - 1; if (fin(v[last])) { el('circle', { cx: xc(last), cy: y(v[last]), r: 4, class: ch.tone === 'negative' ? 'cdot neg' : 'cdot pos' }, svg); el('text', { x: Math.min(xc(last), W - M.r - 4), y: y(v[last]) - 9, 'text-anchor': 'end', class: 'cv' }, svg).textContent = fmt(v[last], ch.unit); }
      const cross = el('line', { y1: M.t, y2: H - M.b, class: 'cx', visibility: 'hidden' }, svg);
      const hit = el('rect', { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, class: 'chit' }, svg);
      hit.addEventListener('pointermove', (e) => {
        const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * W, i = Math.max(0, Math.min(n - 1, Math.floor((px - M.l) / slot)));
        cross.setAttribute('x1', xc(i)); cross.setAttribute('x2', xc(i)); cross.setAttribute('visibility', 'visible');
        show(e, `${ch.x[i]}: ${fmt(v[i], ch.unit)}${ch.band ? ` (middle half ${fmt(ch.band.lo[i], ch.unit)} to ${fmt(ch.band.hi[i], ch.unit)})` : ''}`);
      });
      hit.addEventListener('pointerleave', () => cross.setAttribute('visibility', 'hidden'));
      return;
    }
    // columns: <= 24 px, 2 px gap, rounded 4 px at the data end, square at the zero line
    const bw = Math.min(24, Math.max(2, slot - 2)), zero = y(0);
    v.forEach((val, i) => {
      if (!fin(val)) return;
      const top = Math.min(y(val), zero), hgt = Math.max(1, Math.abs(y(val) - zero)), x0 = xc(i) - bw / 2, r = Math.min(4, hgt, bw / 2), up = val >= 0;
      const d = up ? `M${x0},${zero} V${top + r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + r} V${zero} Z`
        : `M${x0},${zero} V${top + hgt - r} Q${x0},${top + hgt} ${x0 + r},${top + hgt} H${x0 + bw - r} Q${x0 + bw},${top + hgt} ${x0 + bw},${top + hgt - r} V${zero} Z`;
      el('path', { d, class: ch.diverging && !up ? 'cbar neg' : 'cbar' }, svg);
      const hit = el('rect', { x: xc(i) - slot / 2, y: M.t, width: slot, height: H - M.t - M.b, class: 'chit' }, svg);
      hit.addEventListener('pointermove', (e) => show(e, `${ch.x[i]}: ${fmt(val, ch.unit, !!ch.diverging)}${ch.notes?.[i] ? ' · ' + ch.notes[i] : ''}`));
    });
    if (n <= 8) v.forEach((val, i) => { if (fin(val)) el('text', { x: xc(i), y: val >= 0 ? y(val) - 6 : y(val) + 14, 'text-anchor': 'middle', class: 'cv' }, svg).textContent = fmt(val, ch.unit, !!ch.diverging); });
  }

  function table(ch, parent) {
    const d = h('details', 'cnums', null, parent); h('summary', null, 'Numbers', d);
    const t = h('table', null, null, d), head = h('tr', null, null, t);
    const cols = ch.kind === 'scatter' ? ['trade', `held (${ch.xUnit})`, ch.unit] : ['', ch.unit, ...(ch.band ? ['middle half'] : []), ...(ch.notes ? [''] : [])];
    for (const c of cols) h('th', null, c, head);
    const rows = ch.kind === 'scatter' ? ch.points.map((p) => [p.label, p.x, fmt(p.y, '%')]) : ch.values.map((v, i) => [ch.x[i], fmt(v, ch.unit, ch.kind === 'line' || !!ch.diverging), ...(ch.band ? [`${fmt(ch.band.lo[i], ch.unit)} to ${fmt(ch.band.hi[i], ch.unit)}`] : []), ...(ch.notes ? [ch.notes[i] || ''] : [])]);
    for (const r of rows.slice(-200)) { const tr = h('tr', null, null, t); for (const c of r) h('td', null, String(c), tr); }
  }

  window.renderAnalytics = function (root, a) {
    root.replaceChildren();
    if (!a || !a.charts) { h('p', null, 'No analytics yet.', root); return; }
    h('p', 'cnote', `Bought trades only (${a.bought} studied, ${a.closed} closed). Skipped buys and missed-trade reports are left out. Basis: ${a.basis}. Built from the bot's own records: no data credits used.`, root);
    const tiles = h('div', 'ctiles', null, root);
    for (const t of a.tiles) { const box = h('article', 'ctile', null, tiles); h('label', null, t.label, box); h('strong', t.signed && fin(t.value) ? (t.value >= 0 ? 'up' : 'down') : '', t.value == null ? '—' : `${t.signed && t.value > 0 ? '+' : ''}${t.value}${t.unit === '%' ? '%' : t.unit ? ' ' + t.unit : ''}`, box); }
    for (const ch of a.charts) {
      const card = h('div', 'ccard', null, root); h('h3', null, ch.title, card); h('p', 'csub', ch.subtitle, card);
      const box = h('div', 'cbox', null, card), tip = h('div', 'ctip', null, box); tip.hidden = true;
      draw(ch, box, tip); table(ch, card);
    }
  };
})();
