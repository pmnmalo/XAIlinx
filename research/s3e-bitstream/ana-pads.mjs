// The settings of every pad, from two I/O experiments (gen-iob.mjs):
//   --third   every third I/O tile along each side with all its pads: every bit in the I/O ring near a
//             used tile (same tile or the next one) belongs to that tile's pads
//   --sparse  the pads of one index in every other tile: a bit belongs to the pad whose tile owns it
//             (from the first experiment)
// Result: { pads: { M5: { 'O:LVCMOS33': ['frame,bit', '!frame,bit', …] } } } (absolute positions:
// the pads do not repeat one pattern per tile type).
//   node ana-pads.mjs third-dir sparse-dir > pads-features.json
import fs from 'node:fs';
import { parseXdl } from '../../core/xdl.js';
import { readBit, diffFrames } from '../../core/fpga/bitstream.js';
import { frameData, tileOf } from '../../core/fpga/bitgen.js';
import { loadDb } from './db.mjs';

const [third, sparse] = process.argv.slice(2);
const db = loadDb();
const L = db.layout;
const colOf = f => { for (const [x, b] of Object.entries(L.cols)) { const n = +x === 0 || +x === 27 ? 21 : 19; if (f >= b && f < b + n) return +x; } return null; };
const rowOf = b => { for (const [y, s] of Object.entries(L.rows)) { const n = +y === 0 || +y === 35 ? 80 : 64; if (b >= s && b < s + n) return +y; } return null; };
function where(f, b) {
  const x = colOf(f), y = rowOf(b);
  if (x === null || y === null) return null;
  if (x === 0) return { side: 'L', x, y };
  if (x === 27) return { side: 'R', x, y };
  if (y === 35) return { side: 'T', x, y };
  if (y === 0) return { side: 'B', x, y };
  return null;
}
const sideOf = t => (t.x === 0 ? 'L' : t.x === 27 ? 'R' : t.y === 35 ? 'T' : 'B');
const near = (t, w) => t.side === w.side && (w.side === 'L' || w.side === 'R' ? Math.abs(t.y - w.y) <= 1 : Math.abs(t.x - w.x) <= 1);
const spec = x => `${x.value ? '' : '!'}${x.frame},${x.bit}`;
const residual = (dir, f) => {
  const design = parseXdl(fs.readFileSync(`${dir}/${f.replace('.bit', '.xdl')}`, 'utf8'));
  return { design, res: diffFrames(frameData(design, db).frames, readBit(fs.readFileSync(`${dir}/${f}`)).frames) };
};
const ioInsts = d => d.insts.filter(i => /^(IOB|IBUF)$/.test(i.type));
// 1. the bits of each tile (all its pads used), per direction and standard
const tileBits = new Map();   // `${tile} ${mode}:${std}` -> Set(spec)
let other = 0, multi = 0;
for (const f of fs.readdirSync(third).filter(f => /^[OI]_T\d_\w+\.bit$/.test(f))) {
  const [, mode, std] = /^([OI])_T\d_(\w+)\.bit$/.exec(f);
  const { design, res } = residual(third, f);
  const tiles = [...new Set(ioInsts(design).map(i => i.tile))].map(n => { const t = tileOf(n, db); return { name: n, x: t.x, y: t.y, side: sideOf(t) }; });
  for (const x of res) {
    const w = where(x.frame, x.bit);
    const c = w ? tiles.filter(t => near(t, w)) : [];
    if (c.length !== 1) { if (c.length) multi++; else other++; continue; }
    const k = `${c[0].name} ${mode}:${std}`;
    if (!tileBits.has(k)) tileBits.set(k, new Set());
    tileBits.get(k).add(spec(x));
  }
}
console.error(`tiles: ${tileBits.size} (tile, setting) sets; ${multi} bits near two tiles, ${other} elsewhere`);
// 2. each bit of the sparse designs to the pad whose tile owns it
const pads = {};
let amb = 0, none = 0;
for (const f of fs.readdirSync(sparse).filter(f => /^[OI]_P\d_K\d_\w+\.bit$/.test(f))) {
  const [, mode, std] = /^([OI])_P\d_K\d_(\w+)\.bit$/.exec(f);
  const { design, res } = residual(sparse, f);
  const used = ioInsts(design).map(i => ({ pad: i.site, tile: i.tile, mode: i.type === 'IBUF' ? 'I' : mode }));
  for (const u of used) ((pads[u.pad] ||= {})[`${u.mode}:${std}`] ||= []);
  for (const x of res) {
    if (!where(x.frame, x.bit)) continue;
    const s = spec(x);
    const c = used.filter(u => tileBits.get(`${u.tile} ${mode}:${std}`)?.has(s));
    if (c.length === 1) pads[c[0].pad][`${c[0].mode}:${std}`].push(s);
    else if (c.length > 1) amb++;
    else none++;
  }
}
console.error(`pads: ${Object.keys(pads).length}; bits owned by two used pads' tiles: ${amb}, by none: ${none}`);
// 3. check: in each tile, the union of its pads' bits is the tile's set
let bad = 0;
for (const [k, set] of tileBits) {
  const [tile, ms] = k.split(' ');
  const [mode, std] = ms.split(':');
  const ps = Object.keys(pads).filter(p => db.pads[p]?.[0] === tile);
  const u = new Set();
  for (const p of ps) for (const s of pads[p][`${db.pads[p] && /IBUFS/.test(tile) ? 'I' : mode}:${std}`] || pads[p][`I:${std}`] || []) u.add(s);
  const missing = [...set].filter(s => !u.has(s)), extra = [...u].filter(s => !set.has(s));
  if (missing.length || extra.length) { bad++; console.error(`  ${k}: tile bits not given to a pad: ${missing.join(' ')}; pad bits not in the tile set: ${extra.join(' ')}`); }
}
console.error(`${bad} (tile, setting) sets not explained by their pads`);
console.log(JSON.stringify({ padFeatures: pads }));
