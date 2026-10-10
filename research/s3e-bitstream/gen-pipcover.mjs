// Routing switches (PIPs) of whole tile types, measured in batches in designs routed by Silinx:
// for every tile, up to K PIPs under test, each on its own net from a slice output (X / Y) through
// the PIP to a slice LUT input, the paths found by a breadth-first search over the device graph
// (xdlrc-graph.mjs) using only free wires. The variants remove the PIPs under test by codewords as in
// gen-pipdrop.mjs (key.json has the same format, so ana-pipdrop.mjs analyses both).
//
//   node gen-pipcover.mjs dev-full.xdlrc outdir [--types CENTER_SMALL,…] [--k 4] [--L 8] [--w 2]
//        [--skip measured.json] [--seed 1]
// measured.json: { "TYPE": ["from->to", …] } PIPs already measured (not chosen again unless all are).
import fs from 'node:fs';
import { loadGraph } from './xdlrc-graph.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const typesOpt = opt('--types', null), K = +opt('--k', '4'), L = +opt('--L', '8'), w = +opt('--w', '2');
const skipFile = opt('--skip', null), radius = +opt('--radius', '3');
// --pins: the slice pins the nets may use, a list of: lut (X, Y -> F1-4, G1-4, the default), ff (also
// the flip-flop outputs XQ, YQ as sources and BX, BY, CE, SR as sinks; 'all' = lut,ff), carry (the
// carry outputs XB, YB as sources), clk (CLK as a sink), vcc (the tiles' VCC sites as sources: nets of
// the constant 1)
const pinSets = new Set(opt('--pins', 'lut').replace('all', 'lut,ff').split(','));
const allPins = pinSets.has('ff');
// --long: the long lines (LH, LV) may be used wherever they go
const long = opt('--long', '0') === '1';
// --want file.json: { TYPE: ['from->to', …] } only these PIPs (e.g. those of designs to reproduce)
const wantFile = opt('--want', null);
const want = wantFile ? new Map(Object.entries(JSON.parse(fs.readFileSync(wantFile, 'utf8'))).map(([t, l]) => [t, new Set(l)])) : null;
let seed = +opt('--seed', '1');
const [xdlrc, out] = args;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x80000000; };
const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const g = loadGraph(xdlrc);
const measured = skipFile && fs.existsSync(skipFile) ? JSON.parse(fs.readFileSync(skipFile, 'utf8')) : {};
const done = new Map(Object.entries(measured).map(([t, l]) => [t, new Set(l)]));

// node adjacency through PIPs (no route-throughs)
const fromNode = new Float64Array(g.pipCount), toNode = new Float64Array(g.pipCount);
const outE = new Map(), inE = new Map();
for (let i = 0; i < g.pipCount; i++) {
  if (g.rt[i]) continue;
  const a = g.node(g.pipT[i], g.pipA[i]), b = g.node(g.pipT[i], g.pipB[i]);
  fromNode[i] = a; toNode[i] = b;
  (outE.get(a) || outE.set(a, []).get(a)).push(i);
  (inE.get(b) || inE.set(b, []).get(b)).push(i);
  if (g.pipBi[i]) { (outE.get(b) || outE.set(b, []).get(b)).push(-i - 1); (inE.get(a) || inE.set(a, []).get(a)).push(-i - 1); }
}
// a PIP used backwards (bidirectional): encoded as -i-1
const pipEnds = e => (e >= 0 ? [fromNode[e], toNode[e]] : [toNode[-e - 1], fromNode[-e - 1]]);
const pipText = e => { const i = e >= 0 ? e : -e - 1; const p = g.pip(i); return e >= 0 ? `pip ${g.tiles[p.t].name} ${p.from} -> ${p.to}` : `pip ${g.tiles[p.t].name} ${p.to} -> ${p.from}`; };

// slice pins: sources (X, Y outputs) and sinks (F1-4, G1-4)
const srcPin = new Map(), sinkPin = new Map();   // node -> { site, type, tile, pin }
for (const [t, tile] of g.tiles.entries()) for (const s of tile.sites) {
  if (s.type === 'VCC' && pinSets.has('vcc') && s.pins.VCCOUT) srcPin.set(g.node(t, s.pins.VCCOUT.wire), { site: s.name, type: 'VCC', tile: tile.name, t, pin: 'VCCOUT' });
  if (s.type !== 'SLICEL' && s.type !== 'SLICEM') continue;
  for (const [pin, { wire }] of Object.entries(s.pins)) {
    const n = g.node(t, wire);
    const info = { site: s.name, type: s.type, tile: tile.name, t, pin };
    if ((pinSets.has('lut') && (pin === 'X' || pin === 'Y')) || (allPins && (pin === 'XQ' || pin === 'YQ')) || (pinSets.has('carry') && (pin === 'XB' || pin === 'YB'))) srcPin.set(n, info);
    if (/^[FG][1-4]$/.test(pin) || (allPins && /^(BX|BY|CE|SR)$/.test(pin)) || (pinSets.has('clk') && pin === 'CLK')) sinkPin.set(n, info);
  }
}
// the nodes of the long lines
const longNode = new Set();
if (long) for (let i = 0; i < g.pipCount; i++) for (const w of [g.pipA[i], g.pipB[i]]) if (/^L[HV]\d+$/.test(g.names[w])) longNode.add(g.node(g.pipT[i], w));
const used = new Set();   // nodes taken by a net
const tileOfNode = n => Math.floor(n / g.W);
const near = (t0, n) => { const a = g.tiles[t0], b = g.tiles[tileOfNode(n)]; return Math.abs(a.r - b.r) <= radius + 1 && Math.abs(a.c - b.c) <= radius + 1; };
// breadth-first search from node n0 (forward to a sink or backward to a source); returns the PIPs
function search(n0, forward, t0) {
  const goal = forward ? sinkPin : srcPin;
  if (goal.has(n0)) return [];
  const prev = new Map([[n0, null]]);
  let frontier = [n0];
  for (let depth = 0; depth < 7 && frontier.length; depth++) {
    const next = [];
    for (const n of frontier) for (const e of (forward ? outE : inE).get(n) || []) {
      const [a, b] = pipEnds(e);
      const m = forward ? b : a;
      if (prev.has(m) || used.has(m) || !(near(t0, m) || longNode.has(m))) continue;
      prev.set(m, { n, e });
      if (goal.has(m)) {
        const path = [];
        for (let x = m; prev.get(x); x = prev.get(x).n) path.push(prev.get(x).e);
        return forward ? path.reverse() : path;
      }
      next.push(m);
    }
    frontier = next;
  }
  return null;
}
const nodesOf = (path, extra) => { const s = new Set(extra); for (const e of path) for (const n of pipEnds(e)) s.add(n); return s; };

const wantTypes = typesOpt ? new Set(typesOpt.split(',')) : null;
const nets = [], key = {};
const sliceUse = new Map();   // site -> { type, tile, out: Set(X|Y), in: Set }
const tiles = shuffle([...g.tiles.keys()].filter(t => !wantTypes || wantTypes.has(g.tiles[t].type)));
for (const t of tiles) {
  const type = g.tiles[t].type;
  const doneT = done.get(type) || new Set();
  const wanted = want && want.get(type);
  if (want && !wanted) continue;
  const cands = shuffle(g.pipsOf(t).filter(i => !g.rt[i] && (!wanted || wanted.has(`${g.names[g.pipA[i]]}->${g.names[g.pipB[i]]}`))));
  const fresh = cands.filter(i => !doneT.has(`${g.names[g.pipA[i]]}->${g.names[g.pipB[i]]}`));
  const list = wanted ? fresh : fresh.length ? fresh.concat(cands.filter(i => !fresh.includes(i))) : cands;
  let k = 0;
  for (const i of list) {
    if (k >= K) break;
    const a = fromNode[i], b = toNode[i];
    if (a === b || used.has(a) || used.has(b)) continue;
    if (srcPin.has(b) || sinkPin.has(a)) continue;
    used.add(a); used.add(b);
    const back = search(a, false, t);
    if (!back) { used.delete(a); used.delete(b); continue; }
    for (const n of nodesOf(back, [])) used.add(n);
    const fwd = search(b, true, t);
    if (!fwd) { for (const n of nodesOf(back, [])) used.delete(n); used.delete(a); used.delete(b); continue; }
    for (const n of nodesOf(fwd, [])) used.add(n);
    const srcNode = back.length ? pipEnds(back[0])[0] : a;
    const sinkNode = fwd.length ? pipEnds(fwd[fwd.length - 1])[1] : b;
    const src = srcPin.get(srcNode), sink = sinkPin.get(sinkNode);
    used.add(srcNode); used.add(sinkNode);
    for (const p of [src, sink]) if (!sliceUse.has(p.site)) sliceUse.set(p.site, { ...p, out: new Set(), in: new Set() });
    sliceUse.get(src.site).out.add(src.pin);
    sliceUse.get(sink.site).in.add(sink.pin);
    const p = g.pip(i);
    nets.push({ name: `n${nets.length}`, src, sink, pips: [...back, i, ...fwd], test: i });
    (key[g.tiles[t].name] ||= []).push({ from: p.from, dir: '->', to: p.to, line: nets.length - 1 });
    k++;
  }
}
// codewords per tile
const words = [];
const rec = (start, acc) => { if (acc.length === w) { words.push(acc.slice()); return; } for (let j = start; j < L; j++) { acc.push(j); rec(j + 1, acc); acc.pop(); } };
rec(0, []);
for (const ps of Object.values(key)) { const pool = shuffle(words.map((x, i) => i)); ps.forEach((p, k) => { p.code = words[pool[k]]; }); }
const testCode = new Map();
for (const ps of Object.values(key)) for (const p of ps) testCode.set(p.line, p.code);
// the design
const inst = s => {
  const u = sliceUse.get(s);
  if (u.type === 'VCC') return `inst "${s}" "VCC",placed ${u.tile} ${s} ,\n  cfg " _NO_USER_LOGIC:: _VCC_SOURCE::VCCOUT "\n  ;`;
  const cfg = ['F:' + s + '_f:#LUT:D=(A1*A2*A3*A4)', 'G:' + s + '_g:#LUT:D=(A1*A2*A3*A4)'];
  if (u.out.has('X')) cfg.push('FXMUX::F', 'XUSED::0');
  if (u.out.has('Y')) cfg.push('GYMUX::G', 'YUSED::0');
  // the carry chain: XB = CYMUXF, YB = CYMUXG (fed by CYMUXF)
  if (u.out.has('XB') || u.out.has('YB')) cfg.push(`CYMUXF:${s}_cf:`, 'CYSELF::F', 'CY0F::0', 'CYINIT::BX', `CYMUXG:${s}_cg:`, 'CYSELG::G', 'CY0G::0');
  // (a SLICEM has no XBUSED: its XB multiplexer chooses the carry (1) or SHIFTOUT)
  if (u.out.has('XB')) cfg.push(u.type === 'SLICEM' ? 'XBMUX::1' : 'XBUSED::0');
  if (u.out.has('YB')) cfg.push(...(u.type === 'SLICEM' ? ['YBMUX::1'] : []), 'YBUSED::0');
  // flip-flops when their output or a control input is used
  if ([...u.out, ...u.in].some(p => /^(XQ|YQ|BX|BY|CE|SR|CLK)$/.test(p))) {
    cfg.push(`FFX:${s}_x:#FF`, `FFY:${s}_y:#FF`, 'FFX_INIT_ATTR::INIT0', 'FFY_INIT_ATTR::INIT0', 'FFX_SR_ATTR::SRLOW', 'FFY_SR_ATTR::SRLOW', 'SYNC_ATTR::ASYNC', 'CLKINV::CLK');
    cfg.push(u.in.has('BX') ? 'DXMUX::0' : 'DXMUX::1', u.in.has('BY') ? 'DYMUX::0' : 'DYMUX::1');
    if (u.in.has('BX')) cfg.push('BXINV::BX');
    if (u.in.has('BY')) cfg.push('BYINV::BY');
    if (u.in.has('CE')) cfg.push('CEINV::CE');
    if (u.in.has('SR')) cfg.push('SRINV::SR', ...(u.type === 'SLICEM' ? ['SRFFMUX::0'] : []));
  }
  return `inst "${s}" "${u.type}",placed ${u.tile} ${s} ,\n  cfg " ${cfg.join(' ')} "\n  ;`;
};
const write = (file, v) => {
  const txt = [`design "cover" xc3s250ecp132-4 v3.2 ,\n  cfg "";`];
  for (const s of sliceUse.keys()) txt.push(inst(s));
  nets.forEach((n, j) => {
    const drop = v !== null && testCode.get(j).includes(v);
    const pips = n.pips.filter(e => !(drop && e === n.test)).map(e => `  ${pipText(e)} ,`);
    txt.push(`net "${n.name}"${n.src.type === 'VCC' ? ' vcc' : ''} ,\n  outpin "${n.src.site}" ${n.src.pin} ,\n  inpin "${n.sink.site}" ${n.sink.pin} ,\n${pips.join('\n')}\n  ;`);
  });
  fs.writeFileSync(file, txt.join('\n') + '\n');
};
fs.mkdirSync(out, { recursive: true });
write(`${out}/BASE.xdl`, null);
for (let v = 0; v < L; v++) write(`${out}/V${String(v).padStart(2, '0')}.xdl`, v);
fs.writeFileSync(`${out}/key.json`, JSON.stringify({ src: 'gen-pipcover', L, w, tiles: Object.fromEntries(Object.entries(key).map(([t, ps]) => [t, ps.map(({ from, dir, to, code }) => ({ from, dir, to, code }))])) }));
console.log(`${nets.length} nets (PIPs under test) in ${Object.keys(key).length} tiles, ${sliceUse.size} slices`);
