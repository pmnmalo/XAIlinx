// Features measured in designs implemented by ISE: in a tile where exactly one feature of the design
// is not in the database, the bits that differ in that tile's window are that feature's bits (when
// every design that has it in such a tile agrees).
//   node learn-single.mjs a.xdl a.bit [b.xdl b.bit …] > fix.json
import fs from 'node:fs';
import { parseXdl } from '../../core/xdl.js';
import { readBit, diffFrames } from '../../core/fpga/bitstream.js';
import { frameData, designFeatures, tileOf, tileBase } from '../../core/fpga/bitgen.js';
import { loadDb } from './db.mjs';

const db = loadDb();
const args = process.argv.slice(2);
const seen = new Map();   // type \t feature -> Map(pattern -> count)
for (let i = 0; i < args.length; i += 2) {
  const design = parseXdl(fs.readFileSync(args[i], 'utf8'));
  const { frames, unknown } = frameData(design, db);
  const d = diffFrames(frames, readBit(fs.readFileSync(args[i + 1])).frames);
  const byTile = new Map();
  for (const u of unknown) { if (u.tile[0] === '@') continue; if (!byTile.has(u.tile)) byTile.set(u.tile, []); byTile.get(u.tile).push(u.feature); }
  // windows of all the design's tiles, to make sure a bit is in one tile only
  const tiles = [...new Set(designFeatures(design, db).feats.map(f => f.tile))].filter(n => n[0] !== '@').map(n => { const t = tileOf(n, db); return { n, t, b: t && tileBase(t, db) }; }).filter(x => x.b);
  const inWin = (x, w) => { const df = x.frame - w.b.frame, db2 = x.bit - w.b.bit; return df >= 0 && df < (db.layout.typeFrames?.[w.t.type] ?? (w.t.x === 0 || w.t.x === 27 ? 21 : 19)) && db2 >= 0 && db2 < (db.layout.typeBits?.[w.t.type] ?? (w.t.y === 0 || w.t.y === 35 ? 80 : 64)); };
  for (const [tile, fs1] of byTile) {
    if (fs1.length !== 1) continue;
    const w = tiles.find(x => x.n === tile);
    if (!w) continue;
    const mine = d.filter(x => inWin(x, w));
    // a bit also in another tile with unknown features is not certain
    if (mine.some(x => tiles.some(o => o !== w && byTile.has(o.n) && inWin(x, o)))) continue;
    const pat = mine.map(x => `${x.value ? '' : '!'}${x.frame - w.b.frame},${x.bit - w.b.bit}`).sort().join(' ');
    const k = `${w.t.type}\t${fs1[0]}`;
    if (!seen.has(k)) seen.set(k, new Map());
    seen.get(k).set(pat, (seen.get(k).get(pat) || 0) + 1);
  }
}
const out = { types: {} };
for (const [k, m] of seen) {
  const [type, feature] = k.split('\t');
  if (m.size !== 1) { console.error(`different in different tiles: ${type} ${feature}: ${[...m].map(([p, n]) => `[${p}]x${n}`).join(' | ')}`); continue; }
  const [pat] = [...m.keys()];
  ((out.types[type] ||= { features: {} }).features[feature] = pat ? pat.split(' ') : []);
  console.error(`${type} ${feature}: [${pat}] x${[...m.values()][0]}`);
}
console.log(JSON.stringify(out));
