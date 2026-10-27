// THE ROLEX METER: an original drawing of a GMT-style watch (two-tone steel and gold, grey/black 24-hour bezel,
// black dial, white lume). No brand logo or name is drawn. The gold ring inside the bezel fills with LIVE profit
// toward the goal, the silver ring with paper practice; the GMT hand points at the live progress; the date window
// shows the percent. The other hands keep the real time with an 8-beats-a-second sweep (still when motion is off).
const NS = 'http://www.w3.org/2000/svg';
const CX = 200, CY = 250;
let seq = 0;
const el = (tag, attrs = {}, parent) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (parent) parent.append(n); return n; };
const polar = (r, deg) => { const a = ((deg - 90) * Math.PI) / 180; return [CX + r * Math.cos(a), CY + r * Math.sin(a)]; };
const fmtPct = (p) => { const v = Math.max(0, p * 100); return v >= 100 ? '100%' : v >= 10 ? `${Math.floor(v)}%` : `${v.toFixed(1)}%`; };

export function createWatch(host, { label = 'Rolex goal meter', clock = true } = {}) {
  const id = `w${++seq}`;
  const svg = el('svg', { viewBox: '0 0 400 500', role: 'img', 'aria-label': label });
  const defs = el('defs', {}, svg);
  const grad = (name, stops, attrs = {}) => { const g = el(attrs.r ? 'radialGradient' : 'linearGradient', { id: `${id}-${name}`, ...attrs }, defs); for (const [off, cls, op] of stops) el('stop', { offset: off, class: cls, ...(op != null ? { 'stop-opacity': op } : {}) }, g); return `url(#${id}-${name})`; };
  const caseG = grad('case', [[0, 'st-case-hi'], [0.45, 'st-case'], [1, 'st-case-lo']], { x1: 0, y1: 0, x2: 1, y2: 1 });
  const caseV = grad('casev', [[0, 'st-case-lo'], [0.5, 'st-case-hi'], [1, 'st-case-lo']], { x1: 0, y1: 0, x2: 1, y2: 0 });
  const bezelG = grad('bezel', [[0, 'st-bezel-hi'], [0.35, 'st-bezel'], [0.7, 'st-bezel-lo'], [1, 'st-bezel-hi']], { x1: 0, y1: 0, x2: 1, y2: 1 });
  const linkG = grad('link', [[0, 'st-link-lo'], [0.5, 'st-link-hi'], [1, 'st-link-lo']], { x1: 0, y1: 0, x2: 1, y2: 0 });
  const dialG = el('radialGradient', { id: `${id}-dial`, cx: 0.45, cy: 0.38, r: 0.75 }, defs);
  el('stop', { offset: 0, 'stop-color': '#1d1d1c' }, dialG); el('stop', { offset: 0.65, 'stop-color': '#0a0a0a' }, dialG); el('stop', { offset: 1, 'stop-color': '#030303' }, dialG);
  const glassG = el('linearGradient', { id: `${id}-glass`, x1: 0, y1: 0, x2: 0.6, y2: 1 }, defs);
  el('stop', { offset: 0, 'stop-color': '#ffffff', 'stop-opacity': 0.13 }, glassG); el('stop', { offset: 0.5, 'stop-color': '#ffffff', 'stop-opacity': 0.02 }, glassG); el('stop', { offset: 1, 'stop-color': '#ffffff', 'stop-opacity': 0 }, glassG);
  const fade = el('linearGradient', { id: `${id}-fade`, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
  for (const [o, c] of [[0, 0], [0.16, 1], [0.84, 1], [1, 0]]) el('stop', { offset: o, 'stop-color': '#fff', 'stop-opacity': c }, fade);
  const mask = el('mask', { id: `${id}-mask` }, defs); el('rect', { x: 0, y: 0, width: 400, height: 500, fill: `url(#${id}-fade)` }, mask);

  // shadow, bracelet (Jubilee: steel outer links, three small centre links), lugs
  el('ellipse', { cx: CX, cy: CY + 150, rx: 120, ry: 18, class: 'w-shadow' }, svg);
  const band = el('g', { mask: `url(#${id}-mask)` }, svg);
  const row = (y) => {
    el('rect', { x: 141, y, width: 26, height: 12, rx: 4, fill: caseV }, band);
    el('rect', { x: 233, y, width: 26, height: 12, rx: 4, fill: caseV }, band);
    for (const x of [169.5, 190.5, 211.5]) el('rect', { x, y: y + 1, width: 19, height: 10, rx: 3.5, fill: linkG }, band);
  };
  for (let y = 84; y > -14; y -= 14) row(y);
  for (let y = 404; y < 514; y += 14) row(y);
  el('path', { d: 'M132 168 C130 132 134 108 142 96 L258 96 C266 108 270 132 268 168 Z', fill: caseG }, svg);
  el('path', { d: 'M132 332 C130 368 134 392 142 404 L258 404 C266 392 270 368 268 332 Z', fill: caseG }, svg);
  el('rect', { x: 140, y: 92, width: 120, height: 8, rx: 3, fill: caseV }, svg);
  el('rect', { x: 140, y: 400, width: 120, height: 8, rx: 3, fill: caseV }, svg);

  // crown and crown guards at 3 o'clock
  el('path', { d: `M${CX + 128} ${CY - 26} q14 2 16 26 q-2 24 -16 26 z`, fill: caseG }, svg);
  el('rect', { x: CX + 138, y: CY - 13, width: 18, height: 26, rx: 4, fill: bezelG }, svg);
  for (let i = 0; i < 5; i++) el('line', { x1: CX + 141 + i * 3.2, y1: CY - 12, x2: CX + 141 + i * 3.2, y2: CY + 12, stroke: 'rgba(0,0,0,.28)', 'stroke-width': 1 }, svg);

  // case, fluted bezel edge, two-tone 24-hour insert
  el('circle', { cx: CX, cy: CY, r: 136, fill: caseG }, svg);
  el('circle', { cx: CX, cy: CY, r: 132, fill: bezelG }, svg);
  const knurl = el('g', {}, svg);
  for (let d = 0; d < 360; d += 3) { const [x1, y1] = polar(126.5, d), [x2, y2] = polar(131.5, d); el('line', { x1, y1, x2, y2, stroke: 'rgba(0,0,0,.30)', 'stroke-width': 0.9 }, knurl); }
  el('path', { d: `M${CX - 124} ${CY} A124 124 0 0 1 ${CX + 124} ${CY} L${CX + 98} ${CY} A98 98 0 0 0 ${CX - 98} ${CY} Z`, class: 'w-day' }, svg); // 18h-24h-6h (top)
  el('path', { d: `M${CX + 124} ${CY} A124 124 0 0 1 ${CX - 124} ${CY} L${CX - 98} ${CY} A98 98 0 0 0 ${CX + 98} ${CY} Z`, class: 'w-night' }, svg); // 6h-12h-18h (bottom)
  const marks = el('g', {}, svg);
  for (let h = 1; h < 24; h++) {
    const deg = h * 15;
    if (h % 2) { const [x1, y1] = polar(104, deg), [x2, y2] = polar(116, deg); el('line', { x1, y1, x2, y2, class: 'w-tick', 'stroke-width': 3, 'stroke-linecap': 'round' }, marks); continue; }
    const [x, y] = polar(110, deg);
    const t = el('text', { x, y, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 12, class: 'w-num', transform: `rotate(${deg} ${x} ${y})` }, marks); t.textContent = String(h);
  }
  el('path', { d: `M${CX - 9} ${CY - 120} L${CX + 9} ${CY - 120} L${CX} ${CY - 103} Z`, class: 'w-surround' }, svg); // 24 h triangle
  el('path', { d: `M${CX - 5.5} ${CY - 118} L${CX + 5.5} ${CY - 118} L${CX} ${CY - 107.5} Z`, class: 'w-lume' }, svg);

  // THE METER: live (gold) on the outer part of the insert, practice (silver) on the inner part
  const ring = (r, w, cls) => { el('circle', { cx: CX, cy: CY, r, class: 'w-track', 'stroke-width': w }, svg); const c = el('circle', { cx: CX, cy: CY, r, class: cls, 'stroke-width': w, transform: `rotate(-90 ${CX} ${CY})` }, svg); const len = 2 * Math.PI * r; c.setAttribute('stroke-dasharray', `${len} ${len}`); c.style.strokeDashoffset = String(len); c.style.opacity = '0'; return { c, len }; };
  const live = ring(121, 4.2, 'w-live'), practice = ring(101.2, 2.4, 'w-practice');

  // rehaut, dial, minute track
  el('circle', { cx: CX, cy: CY, r: 98, class: 'w-rehaut' }, svg);
  el('circle', { cx: CX, cy: CY, r: 92, fill: `url(#${id}-dial)` }, svg);
  for (let i = 0; i < 60; i++) { const [x1, y1] = polar(92.5, i * 6), [x2, y2] = polar(i % 5 ? 96 : 97.5, i * 6); el('line', { x1, y1, x2, y2, class: 'w-minute', 'stroke-width': i % 5 ? 0.7 : 1.4 }, svg); }

  // hour markers: triangle at 12, batons at 6 and 9, date window at 3, dots elsewhere
  el('path', { d: `M${CX - 11} ${CY - 87} L${CX + 11} ${CY - 87} L${CX} ${CY - 66} Z`, class: 'w-surround' }, svg);
  el('path', { d: `M${CX - 7.5} ${CY - 85} L${CX + 7.5} ${CY - 85} L${CX} ${CY - 70.5} Z`, class: 'w-lume' }, svg);
  for (const deg of [180, 270]) { const g = el('g', { transform: `rotate(${deg} ${CX} ${CY})` }, svg); el('rect', { x: CX - 5.5, y: CY - 88, width: 11, height: 25, rx: 1.5, class: 'w-surround' }, g); el('rect', { x: CX - 3.5, y: CY - 86, width: 7, height: 21, rx: 1, class: 'w-lume' }, g); }
  for (const h of [1, 2, 4, 5, 7, 8, 10, 11]) { const [x, y] = polar(77, h * 30); el('circle', { cx: x, cy: y, r: 7.6, class: 'w-surround' }, svg); el('circle', { cx: x, cy: y, r: 5.8, class: 'w-lume' }, svg); }
  el('rect', { x: CX + 61, y: CY - 9.5, width: 27, height: 19, rx: 1.5, class: 'w-surround' }, svg);
  el('rect', { x: CX + 62.5, y: CY - 8, width: 24, height: 16, rx: 1, class: 'w-date' }, svg);
  const dateText = el('text', { x: CX + 74.5, y: CY + 0.5, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 8.5, class: 'w-datetext' }, svg); dateText.textContent = '0.0%';
  el('rect', { x: CX + 57.5, y: CY - 13.5, width: 34, height: 27, rx: 7, class: 'w-cyclops' }, svg);

  // dial print (no brand): the goal at 12, live profit at 6
  const text = (y, size, cls, s, spacing = null) => { const t = el('text', { x: CX, y, 'text-anchor': 'middle', 'font-size': size, class: cls, ...(spacing ? { 'letter-spacing': spacing } : {}) }, svg); t.textContent = s; return t; };
  text(CY - 48, 8.5, 'w-text', 'DECU');
  const goalText = text(CY - 37, 6.2, 'w-text gold', '$20,000 GOAL', 1.2);
  text(CY + 40, 5.6, 'w-text', 'LIVE PROFIT', 1.4);
  const liveText = text(CY + 51, 7.6, 'w-text gold', '$0', 0.6);

  // hands (all drawn pointing at 12, turned with rotate())
  const hand = (draw) => { const g = el('g', {}, svg); draw(g); return g; };
  const gmt = hand((g) => { el('line', { x1: CX, y1: CY + 14, x2: CX, y2: CY - 80, class: 'w-gmt-line' }, g); el('path', { d: `M${CX - 8} ${CY - 72} L${CX + 8} ${CY - 72} L${CX} ${CY - 92} Z`, class: 'w-gmt' }, g); el('path', { d: `M${CX - 3.6} ${CY - 75} L${CX + 3.6} ${CY - 75} L${CX} ${CY - 85} Z`, class: 'w-hand-lume' }, g); });
  const hourH = hand((g) => {
    el('rect', { x: CX - 3, y: CY - 31, width: 6, height: 37, rx: 1.5, class: 'w-hand' }, g);
    el('circle', { cx: CX, cy: CY - 40, r: 10, class: 'w-hand' }, g); el('circle', { cx: CX, cy: CY - 40, r: 7.6, class: 'w-hand-lume' }, g);
    for (const d of [0, 120, 240]) { const a = ((d - 90) * Math.PI) / 180; el('line', { x1: CX, y1: CY - 40, x2: CX + 8 * Math.cos(a), y2: CY - 40 + 8 * Math.sin(a), class: 'w-merc' }, g); }
    el('path', { d: `M${CX - 5} ${CY - 49} L${CX + 5} ${CY - 49} L${CX} ${CY - 61} Z`, class: 'w-hand' }, g);
  });
  const minH = hand((g) => { el('path', { d: `M${CX - 3.6} ${CY + 12} L${CX + 3.6} ${CY + 12} L${CX + 4} ${CY - 62} L${CX} ${CY - 84} L${CX - 4} ${CY - 62} Z`, class: 'w-hand' }, g); el('path', { d: `M${CX - 1.6} ${CY - 12} L${CX + 1.6} ${CY - 12} L${CX + 2} ${CY - 61} L${CX} ${CY - 76} L${CX - 2} ${CY - 61} Z`, class: 'w-hand-lume' }, g); });
  const secH = hand((g) => { el('rect', { x: CX - 0.7, y: CY - 86, width: 1.4, height: 108, class: 'w-second' }, g); el('circle', { cx: CX, cy: CY - 62, r: 4.4, class: 'w-second' }, g); el('circle', { cx: CX, cy: CY - 62, r: 3.2, class: 'w-hand-lume' }, g); el('circle', { cx: CX, cy: CY + 16, r: 3, class: 'w-second' }, g); });
  el('circle', { cx: CX, cy: CY, r: 5, class: 'w-cap' }, svg); el('circle', { cx: CX, cy: CY, r: 1.6, fill: '#111' }, svg);
  el('path', { d: `M${CX - 118} ${CY - 30} A120 120 0 0 1 ${CX + 60} ${CY - 104} A140 140 0 0 0 ${CX - 118} ${CY - 30} Z`, fill: `url(#${id}-glass)` }, svg); // crystal reflection
  el('circle', { cx: CX, cy: CY, r: 124, fill: `url(#${id}-glass)`, opacity: 0.35 }, svg);
  host.replaceChildren(svg);

  const turn = (g, deg) => g.setAttribute('transform', `rotate(${deg.toFixed(2)} ${CX} ${CY})`);
  const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  let timer = null, gmtDeg = 0;
  function tick() {
    const d = new Date(), s = d.getSeconds() + (still() ? 0 : Math.floor(d.getMilliseconds() / 125) / 8), m = d.getMinutes() + s / 60, h = (d.getHours() % 12) + m / 60;
    turn(secH, s * 6); turn(minH, m * 6); turn(hourH, h * 30); turn(gmt, gmtDeg);
  }
  function start() { if (timer || !clock) return; tick(); timer = setInterval(() => { if (!host.isConnected) return stop(); if (document.visibilityState === 'visible') tick(); }, still() ? 1000 : 125); }
  function stop() { clearInterval(timer); timer = null; }
  const setRing = (r, p) => { const f = Math.max(0, Math.min(1, p || 0)); r.c.style.opacity = f > 0 ? '1' : '0'; requestAnimationFrame(() => { r.c.style.strokeDashoffset = String(r.len * (1 - Math.max(f, f > 0 ? 0.004 : 0))); }); };
  /** live, practice: fractions of the goal (0-1+). */
  function set({ live: lp = 0, practice: pp = 0, liveText: lt = null, goalText: gt = null } = {}) {
    setRing(live, lp); setRing(practice, pp);
    gmtDeg = Math.max(0, Math.min(1, lp || 0)) * 360; turn(gmt, gmtDeg);
    dateText.textContent = fmtPct(lp || 0);
    if (lt != null) liveText.textContent = lt;
    if (gt != null) goalText.textContent = gt;
  }
  tick(); start();
  return { set, start, stop, svg };
}
