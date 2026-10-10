// ana-pipdrop.mjs results -> PIP features per tile type (bits relative to the tile), checking that a
// PIP has the same bits in every tile of the type where it was measured.
//   node pips-to-db.mjs pips1.json [pips2.json …] > pip-features.json   (report on stderr)
import fs from 'node:fs';
import { tileOf, tileBase } from '../../core/fpga/bitgen.js';
import { loadDb } from './db.mjs';

const db = loadDb();
const seen = new Map();   // type \t feature -> Map(pattern -> [tiles])
const noBase = new Map();
for (const f of process.argv.slice(2)) {
  for (const p of JSON.parse(fs.readFileSync(f, 'utf8')).pips) {
    const t = tileOf(p.tile, db);
    const base = t && tileBase(t, db);
    if (!base) { if (p.bits.length) { if (!noBase.has(p.tile)) noBase.set(p.tile, []); noBase.get(p.tile).push(p); } continue; }
    const pat = p.bits.map(([fr, b, v]) => `${v ? '' : '!'}${fr - base.frame},${b - base.bit}`).sort().join(' ');
    const k = `${t.type}\t${p.feature || `${p.from}${p.dir}${p.to}`}`;
    if (!seen.has(k)) seen.set(k, new Map());
    const m = seen.get(k);
    if (!m.has(pat)) m.set(pat, []);
    m.get(pat).push(p.tile);
  }
}
const out = { types: {} };
let conflicts = 0, single = 0;
for (const [k, m] of seen) {
  const [type, feature] = k.split('\t');
  const pats = [...m].sort((a, b) => b[1].length - a[1].length);
  if (pats.length > 1) {
    conflicts++;
    console.error(`conflict ${type} ${feature}: ${pats.map(([p, ts]) => `[${p}] x${ts.length} (${ts.slice(0, 3).join(',')})`).join('  |  ')}`);
    // keep the most frequent pattern only when it is clearly the majority
    if (pats[0][1].length < 2 * pats[1][1].length) continue;
  }
  if (pats[0][1].length === 1) single++;
  ((out.types[type] ||= { features: {} }).features[feature] = pats[0][0] ? pats[0][0].split(' ') : []);
}
for (const [tile, ps] of noBase) console.error(`no layout for ${tile}: ${ps.map(p => `${p.from}->${p.to} ${p.bits.map(b => b.join('/')).join(' ')}`).join('; ')}`);
console.error(`${seen.size} PIP features, ${conflicts} with different bits in different tiles, ${single} seen in one tile only`);
console.log(JSON.stringify(out));
