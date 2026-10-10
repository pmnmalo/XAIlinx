// Analysis of gen-iob.mjs: for every variant, the bits that change in the tile of each changed pad
// (one changed pad per tile), relative to the tile: what each change of setting flips, per tile type
// and pad index. Bits outside the windows of the changed tiles are reported.
//   node ana-iob.mjs dir > iob-changes.json
import fs from 'node:fs';
import { readBit, diffFrames } from '../../core/fpga/bitstream.js';
import { tileOf, tileBase } from '../../core/fpga/bitgen.js';
import { loadDb } from './db.mjs';

const dir = process.argv[2];
const db = loadDb();
const key = JSON.parse(fs.readFileSync(`${dir}/key.json`, 'utf8'));
const padOf = Object.fromEntries(key.pads.map(p => [p.site, p]));
const res = {};   // type|idx|mode|change -> Map(pattern -> count)
const outside = [];
for (const v of key.variants) {
  const f = `${dir}/${v.name}.bit`;
  if (!fs.existsSync(f)) { console.error('missing', f); continue; }
  const d = diffFrames(readBit(fs.readFileSync(`${dir}/${v.base}.bit`)).frames, readBit(fs.readFileSync(f)).frames);
  const wins = Object.entries(v.changes).map(([site, change]) => {
    const p = padOf[site], t = tileOf(p.tile, db), base = tileBase(t, db);
    return { site, change, p, t, base, bits: [] };
  });
  for (const x of d) {
    const w = wins.find(w => w.base && x.frame - w.base.frame >= 0 && x.frame - w.base.frame < 19 && x.bit - w.base.bit >= 0 && x.bit - w.base.bit < (w.t.y === 0 || w.t.y === 35 ? 80 : 64));
    if (!w) { outside.push({ variant: v.name, ...x }); continue; }
    w.bits.push(`${x.value ? '' : '!'}${x.frame - w.base.frame},${x.bit - w.base.bit}`);
  }
  for (const w of wins) {
    if (!w.base) { console.error('no layout for', w.p.tile); continue; }
    const k = `${w.t.type}|IOB${w.p.idx}|${v.base[0]}|${w.change}`;
    const pat = w.bits.sort().join(' ');
    ((res[k] ||= {})[pat] = (res[k][pat] || 0) + 1);
  }
}
for (const [k, m] of Object.entries(res).sort()) console.error(k.padEnd(36), Object.entries(m).map(([p, n]) => `[${p}]x${n}`).join(' | '));
console.error('outside the changed tiles:', outside.length, outside.slice(0, 20).map(o => `${o.variant}:${o.frame}:${o.bit}`).join(' '));
console.log(JSON.stringify({ res, outside }));
