// Analysis of gen-attrdrop.mjs: the bits each removed slice setting held, per slice position,
// relative to the CLB tile (the pattern found in most tiles; the others are reported).
//   node ana-attrdrop.mjs dir > features.json
import fs from 'node:fs';
import { readBit, diffFrames } from '../../core/fpga/bitstream.js';
import { parseXdl } from '../../core/xdl.js';
import { tileOf, tileBase } from '../../core/fpga/bitgen.js';
import { loadDb } from './db.mjs';

const dir = process.argv[2];
const db = loadDb();
const key = JSON.parse(fs.readFileSync(`${dir}/key.json`, 'utf8'));
const base = readBit(fs.readFileSync(`${dir}/BASE.bit`));
const design = parseXdl(fs.readFileSync(`${dir}/BASE.xdl`, 'utf8'));
const out = { types: { CENTER_SMALL: { features: {} } } };
for (const v of key.variants) {
  const f = `${dir}/${v.name}.bit`;
  if (!fs.existsSync(f)) { console.error('missing', f); continue; }
  const d = diffFrames(base.frames, readBit(fs.readFileSync(f)).frames);
  // the tiles of the slices that had the setting
  const tiles = new Map();
  for (const i of design.insts) {
    const m = /^SLICE_X(\d+)Y(\d+)$/.exec(i.site || '');
    if (!m || (+m[1] & 1) * 2 + (+m[2] & 1) !== v.slice) continue;
    if (!i.cfg.some(c => c.attr === v.attr && c.value !== '#OFF')) continue;
    const t = tileOf(i.tile, db);
    tiles.set(i.tile, { base: tileBase(t, db), bits: [] });
  }
  let outside = 0;
  for (const x of d) {
    let hit = false;
    for (const t of tiles.values()) {
      const df = x.frame - t.base.frame, dbit = x.bit - t.base.bit;
      if (df >= 0 && df < 19 && dbit >= 0 && dbit < 64) { t.bits.push(`${x.value ? '!' : ''}${df},${dbit}`); hit = true; }
    }
    if (!hit) outside++;
  }
  const pats = {};
  for (const t of tiles.values()) { const p = t.bits.sort().join(' '); pats[p] = (pats[p] || 0) + 1; }
  const best = Object.entries(pats).sort((a, b) => b[1] - a[1]);
  console.error(`${v.name.padEnd(14)} ${tiles.size} tiles, ${outside} bits elsewhere: ${best.slice(0, 3).map(([p, n]) => `[${p}]x${n}`).join(' | ')}`);
  // the setting's bits: those that were set in the base (removing it cleared them)
  if (best.length && best[0][1] >= 2 * (best[1]?.[1] || 0)) out.types.CENTER_SMALL.features[`SLICE${v.slice}:${v.attr}:${v.attr.endsWith('USED') ? '0' : ''}`] = best[0][0] ? best[0][0].split(' ') : [];
}
console.log(JSON.stringify(out));
