// The global clock network: the 8 global buffers at the bottom and top (CLKB, CLKT) each drive one
// global line, from a slice output; every line reaches the flip-flop clock of slices above and below
// every horizontal clock row (GCLKH) of every column, so every switch of the clock tree is used.
// Variants remove the switches by codewords as in gen-pipdrop.mjs (key.json: ana-pipdrop.mjs).
//   node gen-clock.mjs dev-full.xdlrc outdir [--L 8] [--w 2]
import fs from 'node:fs';
import { loadGraph } from './xdlrc-graph.mjs';
import { makeRouter } from './router.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const L = +opt('--L', '8'), w = +opt('--w', '2');
const [xdlrc, out] = args;
const g = loadGraph(xdlrc);
const R = makeRouter(g, { radius: 4, maxDepth: 9 });
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
// the buffers
const bufs = [];
for (const [t, tile] of g.tiles.entries()) for (const s of tile.sites) if (s.type === 'BUFGMUX' && /^CLK[BT]$/.test(tile.type)) bufs.push({ site: s.name, tile: tile.name, t, pins: s.pins });
// clock pins of slices: node -> { site, tile, pin }
const clkPin = new Map();
for (const [t, tile] of g.tiles.entries()) for (const s of tile.sites) if (/^SLICE[LM]$/.test(s.type)) clkPin.set(g.node(t, s.pins.CLK.wire), { site: s.name, type: s.type, tile: tile.name, t });
const slices = new Map();   // site -> cfg
const nets = [];
// one buffer per line: drive it from a slice, then route its output to clock pins everywhere
const rows = [...new Set(g.tiles.filter(t => t.type === 'GCLKH').map(t => t.r))];
const clbAt = new Map(g.tiles.map((t, i) => [`${t.r},${t.c}`, i]));
for (const b of bufs) {
  const i0 = g.node(b.t, b.pins.I0.wire);
  const back = R.search(i0, R.srcPin, false, b.t, 6);
  if (!back) { console.error('no source for', b.site); continue; }
  R.take(back); R.used.add(i0);
  const src = R.srcPin.get(back.length ? R.ends(back[0])[0] : i0);
  slices.set(src.site, { ...src, out: src.pin });
  nets.push({ name: `in_${b.site}`, outpin: [src.site, src.pin], inpins: [[`b_${b.site}`, 'I0']], pips: back, test: false });
  // the tree from the buffer's output
  const o = g.node(b.t, b.pins.O.wire);
  const tree = new Set([o]);
  const pips = [], inpins = [];
  R.used.add(o);
  const targets = [];
  // above and below every clock row, in every column: the nearest CLB with a free clock pin
  for (const r of rows) for (const side of [-1, 1]) for (let c = 0; c < 40; c++) {
    const ts = [1, 2, 3].map(k => clbAt.get(`${r + side * k},${c}`)).filter(t => t !== undefined && g.tiles[t].type.startsWith('CENTER_SMALL'));
    if (ts.length) targets.push(ts);
  }
  for (const ts of targets) {
    // a free clock pin of a slice of these tiles
    let pinNode;
    for (const t of ts) { pinNode = g.tiles[t].sites.filter(s => /^SLICE/.test(s.type)).map(s => g.node(t, s.pins.CLK.wire)).find(n => !R.used.has(n)); if (pinNode !== undefined) break; }
    if (pinNode === undefined) continue;
    // breadth-first search from the tree to the pin, through free nodes
    const prev = new Map();
    let frontier = [...tree];
    for (const n of frontier) prev.set(n, null);
    let found = false;
    for (let d = 0; d < 14 && frontier.length && !found; d++) {
      const next = [];
      for (const n of frontier) for (const e of R.outE.get(n) || []) {
        const m = R.ends(e)[1];
        if (prev.has(m) || (R.used.has(m) && !tree.has(m))) continue;
        if (m !== pinNode && clkPin.has(m)) continue;
        // stay on the clock network
        const nm = g.names[m % g.W];
        if (m !== pinNode && !/GCLK|CLKC|CLKV|GCLKH|CLK[BT]_/.test(nm)) continue;
        prev.set(m, { n, e });
        if (m === pinNode) { found = true; break; }
        next.push(m);
      }
      frontier = next;
    }
    if (!found) continue;
    for (let x = pinNode; prev.get(x); x = prev.get(x).n) { pips.push(prev.get(x).e); tree.add(x); R.used.add(x); }
    const p = clkPin.get(pinNode);
    slices.set(p.site, { ...p, out: null, clk: true, ...(slices.get(p.site) || {}) });
    slices.get(p.site).clk = true;
    inpins.push([p.site, 'CLK']);
  }
  nets.push({ name: `clk_${b.site}`, outpin: [`b_${b.site}`, 'O'], inpins, pips, test: true });
}
// codewords for the PIPs under test, per tile
const words = [];
const rec = (start, acc) => { if (acc.length === w) { words.push(acc.slice()); return; } for (let j = start; j < L; j++) { acc.push(j); rec(j + 1, acc); acc.pop(); } };
rec(0, []);
const key = {}, code = new Map();
for (const n of nets.filter(n => n.test)) for (const e of n.pips) {
  const p = g.pip(e >= 0 ? e : -e - 1);
  const tile = g.tiles[p.t].name;
  (key[tile] ||= []).push({ from: p.from, dir: '->', to: p.to, e });
}
for (const ps of Object.values(key)) {
  const pool = words.map((x, i) => i);
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  if (ps.length > words.length) throw new Error('too many PIPs in a tile');
  ps.forEach((p, k) => { p.code = words[pool[k]]; code.set(p.e, p.code); });
}
const write = (file, v) => {
  const txt = [`design "clock" xc3s250ecp132-4 v3.2 ,\n  cfg "";`];
  for (const b of bufs) txt.push(`inst "b_${b.site}" "BUFGMUX",placed ${b.tile} ${b.site} ,\n  cfg " DISABLE_ATTR::LOW I0_USED::0 SINV::S_B GCLKMUX:b_${b.site}.GCLKMUX: GCLK_BUFFER:b_${b.site}: "\n  ;`);
  for (const [s, u] of slices) {
    const cfg = [];
    if (u.out) cfg.push(`F:${s}_f:#LUT:D=(A1*A2*A3*A4)`, `G:${s}_g:#LUT:D=(A1*A2*A3*A4)`, u.out === 'X' ? 'FXMUX::F XUSED::0' : 'GYMUX::G YUSED::0');
    if (u.clk) cfg.push(`FFX:${s}_x:#FF`, 'FFX_INIT_ATTR::INIT0', 'FFX_SR_ATTR::SRLOW', 'SYNC_ATTR::ASYNC', 'CLKINV::CLK', 'DXMUX::0', 'BXINV::BX');
    txt.push(`inst "${s}" "${u.type}",placed ${u.tile} ${s} ,\n  cfg " ${cfg.join(' ')} "\n  ;`);
  }
  for (const n of nets) {
    const pips = n.pips.filter(e => !(n.test && v !== null && code.get(e).includes(v)));
    txt.push(`net "${n.name}" ,\n  outpin "${n.outpin[0]}" ${n.outpin[1]} ,\n${n.inpins.map(([i, p]) => `  inpin "${i}" ${p} ,`).join('\n')}\n${pips.map(e => `  ${R.text(e)} ,`).join('\n')}\n  ;`);
  }
  fs.writeFileSync(file, txt.join('\n') + '\n');
};
fs.mkdirSync(out, { recursive: true });
write(`${out}/BASE.xdl`, null);
for (let v = 0; v < L; v++) write(`${out}/V${String(v).padStart(2, '0')}.xdl`, v);
fs.writeFileSync(`${out}/key.json`, JSON.stringify({ src: 'gen-clock', L, w, tiles: Object.fromEntries(Object.entries(key).map(([t, ps]) => [t, ps.map(({ from, dir, to, code }) => ({ from, dir, to, code }))])) }));
console.log(`${bufs.length} buffers, ${nets.filter(n => n.test).map(n => `${n.name}: ${n.inpins.length} clock pins`).join(', ')}; ${Object.keys(key).length} tiles with PIPs under test`);
