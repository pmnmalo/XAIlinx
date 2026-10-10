// I/O settings: every bonded pad of the package used at once, as an output (driven by a slice) or as
// an input (to a slice), routed by router.mjs. Each design changes one setting on the pads with one
// index in their tile (0, 1 or 2), so the bits of each change are found per tile type and index by
// comparing with the base design of the same mode (ana-iob.mjs).
//   node gen-iob.mjs dev-full.xdlrc outdir
import fs from 'node:fs';
import { loadGraph } from './xdlrc-graph.mjs';
import { makeRouter } from './router.mjs';

const [xdlrc, out] = process.argv.slice(2);
const g = loadGraph(xdlrc);
const R = makeRouter(g, { radius: 4, maxDepth: 9 });
fs.mkdirSync(out, { recursive: true });
// the pads: site, tile, index, input only?
const pads = [];
for (const [t, tile] of g.tiles.entries()) {
  let i = 0;
  for (const s of tile.sites) {
    if (!/^(IOB|IBUF|DIFF[MS]I?)$/.test(s.type)) continue;
    if (s.bonded === 'bonded') pads.push({ site: s.name, tile: tile.name, t, idx: i, inOnly: /^(IBUF|DIFF[MS]I)$/.test(s.type), pins: s.pins });
    i++;
  }
}
// route every pad once (outputs where possible, inputs for input-only pads; a second set with all inputs)
const route = mode => {
  R.used.clear();
  const nets = [], slices = new Map();
  for (const p of pads) {
    const asOut = mode === 'out' && !p.inOnly;
    if (asOut) {
      const n0 = g.node(p.t, p.pins.O1.wire);
      const path = R.search(n0, R.srcPin, false, p.t);
      if (!path) { console.error('no route to', p.site); continue; }
      R.take(path); R.used.add(n0);
      const src = R.srcPin.get(path.length ? R.ends(path[0])[0] : n0);
      R.used.add(g.node(src.t, src.pin === 'X' ? 'X' : 'Y'));
      for (const [k, v] of R.srcPin) if (v === src) R.used.add(k);
      (slices.get(src.site) || slices.set(src.site, { ...src, out: new Set() }).get(src.site)).out.add(src.pin);
      nets.push({ pad: p, out: true, text: `net "n_${p.site}" ,\n  outpin "${src.site}" ${src.pin} ,\n  inpin "p_${p.site}" O1 ,\n${path.map(e => `  ${R.text(e)} ,`).join('\n')}\n  ;` });
    } else {
      const n0 = g.node(p.t, p.pins.I.wire);
      const path = R.search(n0, R.sinkPin, true, p.t);
      if (!path) { console.error('no route from', p.site); continue; }
      R.take(path); R.used.add(n0);
      const sinkNode = path.length ? R.ends(path[path.length - 1])[1] : n0;
      const sink = R.sinkPin.get(sinkNode);
      R.used.add(sinkNode);
      if (!slices.has(sink.site)) slices.set(sink.site, { ...sink, out: new Set() });
      nets.push({ pad: p, out: false, text: `net "n_${p.site}" ,\n  outpin "p_${p.site}" I ,\n  inpin "${sink.site}" ${sink.pin} ,\n${path.map(e => `  ${R.text(e)} ,`).join('\n')}\n  ;` });
    }
  }
  return { nets, slices };
};
const OUT = { DRIVEATTRBOX: '12', IOATTRBOX: 'LVCMOS33', O1INV: 'O1', OMUX: 'O1', SLEW: 'SLOW' };
const IN = { IDELMUX: '1', IMUX: '1', IOATTRBOX: 'LVCMOS33' };
const write = (name, r, changes) => {
  const txt = [`design "iob" xc3s250ecp132-4 v3.2 ,\n  cfg "";`];
  for (const [s, u] of r.slices) {
    const cfg = [`F:${s}_f:#LUT:D=(A1*A2*A3*A4)`, `G:${s}_g:#LUT:D=(A1*A2*A3*A4)`];
    if (u.out.has('X')) cfg.push('FXMUX::F', 'XUSED::0');
    if (u.out.has('Y')) cfg.push('GYMUX::G', 'YUSED::0');
    txt.push(`inst "${s}" "${u.type}",placed ${u.tile} ${s} ,\n  cfg " ${cfg.join(' ')} "\n  ;`);
  }
  for (const n of r.nets) {
    const p = n.pad;
    const set = { ...(n.out ? OUT : IN) };
    const ch = changes.get(p.site) || {};
    for (const [k, v] of Object.entries(ch)) if (v === null) delete set[k]; else set[k] = v;
    const cfg = Object.entries(set).map(([k, v]) => `${k}::${v}`).concat(n.out ? [`OUTBUF:p_${p.site}_ob:`, `PAD:p_${p.site}:`] : [`INBUF:p_${p.site}_ib:`, `PAD:p_${p.site}:`]);
    txt.push(`inst "p_${p.site}" "${p.inOnly ? 'IBUF' : 'IOB'}",placed ${p.tile} ${p.site} ,\n  cfg " ${cfg.join(' ')} "\n  ;`);
    txt.push(n.text);
  }
  fs.writeFileSync(`${out}/${name}.xdl`, txt.join('\n') + '\n');
};
const ro = route('out'), ri = route('in');
write('O_BASE', ro, new Map());
write('I_BASE', ri, new Map());
const VO = {
  STD25: { IOATTRBOX: 'LVCMOS25' }, STD18: { IOATTRBOX: 'LVCMOS18' }, STD15: { IOATTRBOX: 'LVCMOS15', DRIVEATTRBOX: '8' }, STD12: { IOATTRBOX: 'LVCMOS12', DRIVEATTRBOX: '6' }, LVTTL: { IOATTRBOX: 'LVTTL' },
  D2: { DRIVEATTRBOX: '2' }, D4: { DRIVEATTRBOX: '4' }, D6: { DRIVEATTRBOX: '6' }, D8: { DRIVEATTRBOX: '8' }, D16: { DRIVEATTRBOX: '16' },
  FAST: { SLEW: 'FAST' }, PU: { PULL: 'PULLUP' }, PD: { PULL: 'PULLDOWN' }, KEEP: { PULL: 'KEEPER' },
};
const VI = { STD25: { IOATTRBOX: 'LVCMOS25' }, STD18: { IOATTRBOX: 'LVCMOS18' }, STD15: { IOATTRBOX: 'LVCMOS15' }, STD12: { IOATTRBOX: 'LVCMOS12' }, LVTTL: { IOATTRBOX: 'LVTTL' }, PU: { PULL: 'PULLUP' }, PD: { PULL: 'PULLDOWN' }, KEEP: { PULL: 'KEEPER' } };
// each variant changes one pad per tile, different pads and changes in different tiles, so that
// every (tile type, pad index, change) is covered in a few designs
const variants = [];
const nV = { O: 12, I: 8 };
for (const [mode, r] of [['O', ro], ['I', ri]]) {
  const byTile = new Map();
  for (const n of r.nets) { if (!byTile.has(n.pad.tile)) byTile.set(n.pad.tile, []); byTile.get(n.pad.tile).push(n); }
  for (let v = 0; v < nV[mode]; v++) {
    const changes = new Map(), list = {};
    [...byTile.values()].forEach((ns, j) => {
      const n = ns[v % ns.length];
      const C = Object.entries(n.out ? VO : VI);
      const [cn, ch] = C[(Math.floor(v / ns.length) * 5 + j) % C.length];
      changes.set(n.pad.site, ch);
      list[n.pad.site] = cn;
    });
    const name = `${mode}_V${String(v).padStart(2, '0')}`;
    write(name, r, changes);
    variants.push({ name, base: `${mode}_BASE`, changes: list });
  }
}
fs.writeFileSync(`${out}/key.json`, JSON.stringify({ pads: pads.map(({ site, tile, idx, inOnly }) => ({ site, tile, idx, inOnly })), out: ro.nets.filter(n => n.out).map(n => n.pad.site), in: ri.nets.map(n => n.pad.site), base: { O: OUT, I: IN }, VO, VI, variants }));
console.log(`${pads.length} pads; out design: ${ro.nets.length} nets, in design: ${ri.nets.length} nets; ${variants.length} variants`);
