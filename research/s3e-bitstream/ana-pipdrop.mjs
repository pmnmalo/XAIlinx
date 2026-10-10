// Analysis of a gen-pipdrop.mjs run: the bits of every removed PIP. A bit that changes in exactly the
// variants of a PIP's codeword belongs to that PIP; when several PIPs have that codeword, the one in
// the tile nearest to the bit is taken (tile grid position estimated from the frame and bit).
//
//   node ana-pipdrop.mjs dir device.xdlrc > dir/pips.json
// Output: { pips: [{ tile, type, from, dir, to, bits: [[frame, bit, value]] }], unexplained: [...] }
import fs from 'node:fs';
import { readBit, diffFrames } from '../../core/fpga/bitstream.js';
import { loadGraph } from './xdlrc-graph.mjs';
import { tileWindow, setGrid } from './layout.mjs';
import { parseXdl } from '../../core/xdl.js';
import { pipFeatures, tileOf, tileBase } from '../../core/fpga/bitgen.js';
import { loadDb } from './db.mjs';

const [dir, xdlrc] = process.argv.slice(2);
const key = JSON.parse(fs.readFileSync(`${dir}/key.json`, 'utf8'));
const g = loadGraph(xdlrc);
setGrid(g.tiles);
const db = loadDb();
// the window of a tile: from the database's layout when it knows the tile
const windowOf = t => {
  const tt = tileOf(t.name, db), b = tt && tileBase(tt, db);
  if (!b) return tileWindow(t);
  const L = db.layout;
  return { frame: b.frame, frames: L.typeFrames?.[tt.type] ?? (tt.x === 0 || tt.x === 27 ? 21 : 19), bit: b.bit, bits: L.typeBits?.[tt.type] ?? (tt.y === 0 || tt.y === 35 ? 80 : 64) };
};
// the feature name of every PIP of the base design (bidirectional PIPs get their direction)
const featName = new Map();
for (const net of parseXdl(fs.readFileSync(`${dir}/BASE.xdl`, 'utf8')).nets) { const f = pipFeatures(net); net.pips.forEach((p, i) => featName.set(`${p.tile} ${p.from} ${p.dir} ${p.to}`, f[i])); }
const fname = (tile, p) => featName.get(`${tile} ${p.from} ${p.dir} ${p.to}`) || `${p.from}${p.dir}${p.to}`;
const base = readBit(fs.readFileSync(`${dir}/BASE.bit`));
// signature of every changed bit: the variants it changes in
const sig = new Map();   // "frame:bit" -> { frame, bit, value (in BASE), vs: [] }
for (let v = 0; v < key.L; v++) {
  const f = `${dir}/V${String(v).padStart(2, '0')}.bit`;
  if (!fs.existsSync(f)) { console.error('missing', f); continue; }
  const d = diffFrames(base.frames, readBit(fs.readFileSync(f)).frames);
  for (const x of d) {
    const k = `${x.frame}:${x.bit}`;
    if (!sig.has(k)) sig.set(k, { frame: x.frame, bit: x.bit, value: 1 - x.value, vs: [] });
    sig.get(k).vs.push(v);
  }
}
// codeword -> the PIPs that have it
const byCode = new Map();
for (const [tile, ps] of Object.entries(key.tiles)) for (const p of ps) {
  const c = p.code.join(',');
  if (!byCode.has(c)) byCode.set(c, []);
  byCode.get(c).push({ tile, ...p });
}
const result = new Map();
const unexplained = [];
for (const s of sig.values()) {
  const cands = byCode.get(s.vs.join(',')) || [];
  if (!cands.length) { unexplained.push(s); continue; }
  // the nearest candidate tile: distance from the bit to the tile's frame / bit window
  let best = null, bd = Infinity;
  for (const c of cands) {
    const t = g.tiles[g.tileByName.get(c.tile)];
    const w = windowOf(t);
    const df = w.frame == null ? 50 : s.frame < w.frame ? w.frame - s.frame : s.frame >= w.frame + w.frames ? s.frame - w.frame - w.frames + 1 : 0;
    const db = w.bit == null ? 200 : s.bit < w.bit ? w.bit - s.bit : s.bit >= w.bit + w.bits ? s.bit - w.bit - w.bits + 1 : 0;
    const d = df * 64 + db;
    if (d < bd) { bd = d; best = c; }
  }
  const k = `${best.tile} ${best.from} ${best.dir} ${best.to}`;
  if (!result.has(k)) result.set(k, { tile: best.tile, type: g.tiles[g.tileByName.get(best.tile)].type, from: best.from, dir: best.dir, to: best.to, feature: fname(best.tile, best), bits: [], dist: 0 });
  const r = result.get(k);
  r.bits.push([s.frame, s.bit, s.value]);
  r.dist = Math.max(r.dist, bd);
}
// every PIP of the design, with or without bits
const pips = [];
for (const [tile, ps] of Object.entries(key.tiles)) for (const p of ps) {
  const k = `${tile} ${p.from} ${p.dir} ${p.to}`;
  pips.push(result.get(k) || { tile, type: g.tiles[g.tileByName.get(tile)].type, from: p.from, dir: p.dir, to: p.to, feature: fname(tile, p), bits: [], dist: 0 });
}
console.log(JSON.stringify({ dir, pips, unexplained }));
console.error(`${pips.length} PIPs, ${pips.filter(p => p.bits.length).length} with bits, ${sig.size} bits changed, ${unexplained.length} unexplained, far: ${pips.filter(p => p.dist > 0).length}`);
