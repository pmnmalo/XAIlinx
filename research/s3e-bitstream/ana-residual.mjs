// What the database does not explain yet: for designs implemented by ISE (routed XDL + ISE's .bit),
// the bits of ISE's bitstream that differ from the frame data built from the database. Every such
// bit is given to the tiles whose window holds it; for every feature not in the database, the bits
// that are left over in every tile that has the feature (intersection) are its candidate bits.
//
//   node ana-residual.mjs a.xdl a.bit [b.xdl b.bit …] [--learn out.json]
// With --learn, the candidates found in at least 2 tiles (or 1 with --min 1) are written as
// { types: { TYPE: { features: { feature: ["df,db", …] } } } } for merging into the database.
import fs from 'node:fs';
import { parseXdl } from '../../core/xdl.js';
import { readBit, diffFrames } from '../../core/fpga/bitstream.js';
import { frameData, designFeatures, tileOf, tileBase } from '../../core/fpga/bitgen.js';
import { loadDb } from './db.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const learn = opt('--learn', null), min = +opt('--min', '2'), verbose = opt('--verbose', '0') === '1';
const db = loadDb();
const samples = [];   // { tile, type, unknown: Set, bits: Set("df,db") }
let totalRes = 0, unplaced = 0;
const rows = (y, t) => (t.type.match(/^(T|B)/) && (y === 0 || y === 35) ? 80 : 64);
for (let i = 0; i < args.length; i += 2) {
  const design = parseXdl(fs.readFileSync(args[i], 'utf8'));
  const ise = readBit(fs.readFileSync(args[i + 1]));
  const { frames, unknown } = frameData(design, db);
  const res = diffFrames(frames, ise.frames);
  totalRes += res.length;
  // the tiles of the design: those with features
  const { feats } = designFeatures(design, db);
  const tiles = new Map();
  for (const f of feats) {
    if (f.tile[0] === '@') continue;
    if (!tiles.has(f.tile)) { const t = tileOf(f.tile, db); tiles.set(f.tile, { tile: f.tile, type: t?.type, t, base: t && tileBase(t, db), unknown: new Set(), bits: new Set() }); }
  }
  for (const u of unknown) if (u.tile[0] !== '@') tiles.get(u.tile)?.unknown.add(u.feature);
  const placed = [...tiles.values()].filter(t => t.base);
  for (const r of res) {
    let hit = false;
    for (const t of placed) {
      const df = r.frame - t.base.frame, dbit = r.bit - t.base.bit;
      const nf = db.layout.typeFrames?.[t.type] ?? (t.t.x === 0 || t.t.x === 27 ? 21 : 19), nb = db.layout.typeBits?.[t.type] ?? ((t.t.y === 0 || t.t.y === 35) ? 80 : 64);
      // I/O tiles also set bits in the column before theirs
      const f0 = /IOIS|IBUFS/.test(t.type) ? -19 : 0;
      if (df >= f0 && df < nf && dbit >= 0 && dbit < nb) { t.bits.add(`${r.value ? '' : '!'}${df},${dbit}`); hit = true; }
    }
    if (!hit) { unplaced++; if (verbose) console.log('no tile for', args[i], r); }
  }
  for (const t of tiles.values()) samples.push(t);
  console.log(`${args[i]}: ${res.length} bits differ, ${unknown.length} unknown features`);
}
console.log(`unplaced residual bits: ${unplaced}`);
// candidates per (type, feature)
const cand = new Map();
for (const s of samples) for (const f of s.unknown) {
  const k = `${s.type}\t${f}`;
  if (!cand.has(k)) cand.set(k, { type: s.type, feature: f, n: 0, bits: null });
  const c = cand.get(k);
  c.n++;
  c.bits = c.bits ? new Set([...c.bits].filter(b => s.bits.has(b))) : new Set(s.bits);
}
// A bit that several features claim (it is left over in every tile of each) is given to the fewest
// features that cover every tile where it is left over: the one present in most of those tiles first.
const owned = new Map();   // cand key -> Set(bits)
const byType = new Map();
for (const s of samples) { if (!byType.has(s.type)) byType.set(s.type, []); byType.get(s.type).push(s); }
for (const [type, ss] of byType) {
  const bitSamples = new Map();
  for (const s of ss) for (const b of s.bits) { if (!bitSamples.has(b)) bitSamples.set(b, []); bitSamples.get(b).push(s); }
  for (const [b, list] of bitSamples) {
    let left = new Set(list);
    const claim = [...cand.values()].filter(c => c.type === type && c.bits.has(b));
    while (left.size) {
      let best = null, bn = 0;
      for (const c of claim) { const n = [...left].filter(s => s.unknown.has(c.feature)).length; if (n > bn || (n === bn && best && c.n > best.n)) { bn = n; best = c; } }
      if (!best || !bn) break;
      const k = `${type}\t${best.feature}`;
      if (!owned.has(k)) owned.set(k, new Set());
      owned.get(k).add(b);
      left = new Set([...left].filter(s => !s.unknown.has(best.feature)));
    }
  }
}
const out = { types: {} };
for (const c of [...cand.values()].sort((a, b) => a.type.localeCompare(b.type) || a.feature.localeCompare(b.feature))) {
  const bits = [...(owned.get(`${c.type}\t${c.feature}`) || [])].sort();
  if (verbose || c.n >= min) console.log(`${c.type.padEnd(18)} ${c.feature.padEnd(40)} n=${c.n} ${bits.join(' ')}${bits.length < c.bits.size ? `   (also: ${[...c.bits].filter(b => !bits.includes(b)).join(' ')})` : ''}`);
  if (c.n >= min) ((out.types[c.type] ||= { features: {} }).features[c.feature] = bits);
}
if (learn) fs.writeFileSync(learn, JSON.stringify(out, null, 1));
console.log(`residual bits: ${totalRes}`);
