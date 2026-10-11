// Analysis of gen-sitevar.mjs: the bits of each setting of the sites of one type, relative to each
// instance's tile (the bits that change near the instance; the pattern found in every instance).
//   node ana-sitevar.mjs dir [--far N] [--dx D] [--center df,db] > features.json
// --dx D: the bits are in the frames of the tile D columns away (block RAM: the interconnect column
// before the RAM's); --center: where an instance's bits are around its tile base, to tell instances
// apart (default 9,32: a tile of 19 frames and 64 bits)
// A variant that sets a value gives the bits of that value against the base's (bits set by the
// variant, "!" cleared); with the setting removed (RM_ATTR) the base value's own bits. Code variants
// (code: [attr, k]) give the place of every bit of a hexadecimal value: feature ATTR:<bit i>.
import fs from 'node:fs';
import { readBit, diffFrames } from '../../core/fpga/bitstream.js';
import { parseXdl } from '../../core/xdl.js';
import { tileOf, tileBase } from '../../core/fpga/bitgen.js';
import { loadDb } from './db.mjs';

const args = process.argv.slice(2);
const dir = args[0];
const opt = (k, d) => { const i = args.indexOf(k); return i > 0 ? args[i + 1] : d; };
const FAR = +opt('--far', '40'), DX = +opt('--dx', '0');
const [CF, CB] = opt('--center', '9,32').split(',').map(Number);
const at = DX && opt('--origin', 'tile') !== 'bram' ? `@${DX},0` : '';
const db = loadDb();
const key = JSON.parse(fs.readFileSync(`${dir}/key.json`, 'utf8'));
const rd = n => readBit(fs.readFileSync(`${dir}/${n}.bit`)).frames;
const bases = {};
const insts = Object.fromEntries(Object.keys(key.bases).map(b => [b, parseXdl(fs.readFileSync(`${dir}/${b}.xdl`, 'utf8')).insts.filter(i => i.type === key.type)]));
// --origin bram: a block RAM's bits relative to the frame of its interconnect column (--dx) and the
// bit of its memory bit 0 (db.bram.rowBit: the rows of tiles are not evenly spaced)
const ORIGIN = opt('--origin', 'tile');
const baseOf = i => {
  const t = tileOf(i.tile, db), b = t && tileBase({ ...t, x: t.x + DX }, db);
  if (!b || ORIGIN !== 'bram') return b;
  const m = /^RAMB16_X(\d+)Y(\d+)$/.exec(i.site);
  return { frame: b.frame, bit: db.bram.rowBit[m[2]] };
};
// the bits of a variant per instance: the changed bits nearest to the instance's tile base
const perInst = v => {
  bases[v.base] ||= rd(v.base);
  const d = diffFrames(bases[v.base], rd(v.name));
  const is = insts[v.base].filter(i => !v.site || i.site === v.site).map(i => ({ i, b: baseOf(i), bits: [] })).filter(x => x.b);
  let far = 0;
  for (const x of d) {
    let best = null, bd = Infinity;
    for (const c of is) { const k = Math.abs(x.frame - c.b.frame - CF) * 64 + Math.abs(x.bit - c.b.bit - CB); if (k < bd) { bd = k; best = c; } }
    if (bd > FAR * 64) { far++; continue; }
    best.bits.push(`${x.value ? '' : '!'}${x.frame - best.b.frame},${x.bit - best.b.bit}${at}`);
  }
  return { is, far };
};
const out = { types: {} };
const feats = {};   // type -> feature -> bits
const report = [];
const codes = {};   // attr -> bit pattern -> code
for (const v of key.variants) {
  if (!fs.existsSync(`${dir}/${v.name}.bit`)) { report.push(`${v.name}: missing`); continue; }
  const { is, far } = perInst(v);
  const pats = {};
  for (const c of is) { const p = c.bits.sort().join(' '); pats[p] = (pats[p] || 0) + 1; }
  const best = Object.entries(pats).sort((a, b) => b[1] - a[1]);
  report.push(`${v.name.padEnd(22)} ${Object.entries(pats).map(([p, n]) => `[${p}]x${n}`).join(' | ')}${far ? ` (+${far} far)` : ''}`);
  if (v.code) {
    // every instance the same: the code of each changed bit
    const [attr, k] = v.code;
    for (const s of (best[0]?.[0] || '').split(' ').filter(Boolean)) ((codes[attr] ||= {})[s.replace('!', '')] ||= 0, k >= 0 && (codes[attr][s.replace('!', '')] |= 1 << k));
  }
  (feats[is[0]?.i.tile.replace(/_X\d+Y\d+$/, '')] ||= {})[v.name] = best;
}
console.error(report.join('\n'));
console.log(JSON.stringify({ feats, codes }));
