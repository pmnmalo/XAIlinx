// For a design implemented by ISE: every bit where the writer's frame data differs from ISE's, with
// the tile it is in (relative position) and the features the design has in that tile.
//   node explain-diff.mjs a.xdl a.bit [--tile CLB_X…]
import fs from 'node:fs';
import { parseXdl } from '../../core/xdl.js';
import { readBit, diffFrames } from '../../core/fpga/bitstream.js';
import { frameData, designFeatures, tileOf, tileBase } from '../../core/fpga/bitgen.js';
import { loadDb } from './db.mjs';

const [xdl, bit] = process.argv.slice(2);
const db = loadDb();
const design = parseXdl(fs.readFileSync(xdl, 'utf8'));
const d = diffFrames(frameData(design, db).frames, readBit(fs.readFileSync(bit)).frames);
const { feats } = designFeatures(design, db);
const byTile = new Map();
for (const f of feats) { if (!byTile.has(f.tile)) byTile.set(f.tile, []); byTile.get(f.tile).push(f.feature); }
const groups = new Map();
for (const x of d) {
  let hit = null;
  for (const name of byTile.keys()) {
    if (name[0] === '@') continue;
    const t = tileOf(name, db), b = t && tileBase(t, db);
    if (!b) continue;
    const df = x.frame - b.frame, dbit = x.bit - b.bit;
    if (df >= 0 && df < 19 && dbit >= 0 && dbit < (t.y === 0 || t.y === 35 ? 80 : 64)) { hit = { name, df, dbit }; break; }
  }
  const k = hit ? hit.name : `frame ${x.frame}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(hit ? `${x.value ? '+' : '-'}${hit.df},${hit.dbit}` : `${x.value ? '+' : '-'}${x.frame},${x.bit}`);
}
for (const [k, bits] of groups) {
  console.log(`${k}: ISE ${bits.join(' ')}`);
  if (byTile.has(k)) console.log(`   ${byTile.get(k).filter(f => !/PINWIRE/.test(f)).join(' ')}`);
}
