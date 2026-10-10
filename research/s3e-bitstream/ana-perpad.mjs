// Analysis of gen-iob.mjs --perpad: what every change of an I/O setting does on every pad, with
// absolute positions (frame, bit). Each variant changes the pads of one index in every third I/O tile
// of each side; a bit that changed belongs to the changed pad whose tile is nearest.
//   node ana-perpad.mjs dir > perpad.json
// Output (for merge-db.mjs): { padFeatures: { PAD: { 'O:LVCMOS18': [...], 'O:DRIVE:8': [...], … } },
// padDriveDefault }: the I/O standards as whole pad features (the LVCMOS33 pad feature with the
// change applied), DRIVE / SLEW / PULL as changes to apply ("f,b" set, "!f,b" cleared).
import fs from 'node:fs';
import { readBit, diffFrames } from '../../core/fpga/bitstream.js';
import { tileOf, tileBase } from '../../core/fpga/bitgen.js';
import { loadDb } from './db.mjs';

const dir = process.argv[2];
const db = loadDb();
const key = JSON.parse(fs.readFileSync(`${dir}/key.json`, 'utf8'));
const padOf = Object.fromEntries(key.pads.map(p => [p.site, p]));
const window = site => {
  const t = tileOf(padOf[site].tile, db), b = tileBase(t, db);
  return b && { frame: b.frame, frames: t.x === 0 || t.x === 27 ? 21 : 19, bit: b.bit, bits: t.y === 0 || t.y === 35 ? 80 : 64 };
};
const dist = (x, w) => {
  const df = x.frame < w.frame ? w.frame - x.frame : x.frame >= w.frame + w.frames ? x.frame - w.frame - w.frames + 1 : 0;
  const db2 = x.bit < w.bit ? w.bit - x.bit : x.bit >= w.bit + w.bits ? x.bit - w.bit - w.bits + 1 : 0;
  return df * 64 + db2;
};
// the name of a change as a feature: standards whole, the others as changes
const STD = { STD25: 'LVCMOS25', STD18: 'LVCMOS18', STD15: 'LVCMOS15', STD12: 'LVCMOS12', LVTTL: 'LVTTL' };
const OTHER = { D2: 'DRIVE:2', D4: 'DRIVE:4', D6: 'DRIVE:6', D8: 'DRIVE:8', D16: 'DRIVE:16', FAST: 'SLEW:FAST', PU: 'PULL:PULLUP', PD: 'PULL:PULLDOWN', KEEP: 'PULL:KEEPER' };
const bases = {};
const deltas = {};   // pad -> mode -> change -> [bits]
let far = 0;
for (const v of key.variants) {
  const f = `${dir}/${v.name}.bit`;
  if (!fs.existsSync(f)) { console.error('missing', f); continue; }
  bases[v.base] ||= readBit(fs.readFileSync(`${dir}/${v.base}.bit`)).frames;
  const d = diffFrames(bases[v.base], readBit(fs.readFileSync(f)).frames);
  const wins = v.pads.map(site => ({ site, w: window(site), bits: [] })).filter(x => x.w);
  for (const x of d) {
    let best = null, bd = Infinity;
    for (const c of wins) { const k = dist(x, c.w); if (k < bd) { bd = k; best = c; } }
    if (bd > 64 * 3) { far++; continue; }
    best.bits.push(`${x.value ? '' : '!'}${x.frame},${x.bit}`);
  }
  const mode = v.base[0];
  for (const c of wins) ((deltas[c.site] ||= {})[mode] ||= {})[v.change] = c.bits.sort();
}
const out = { padFeatures: {}, padDriveDefault: { LVCMOS15: '8', LVCMOS12: '6' } };
let n = 0;
for (const [pad, modes] of Object.entries(deltas)) for (const [mode, chs] of Object.entries(modes)) {
  const base = db.padFeats[pad]?.[`${mode}:LVCMOS33`];
  for (const [ch, bits] of Object.entries(chs)) {
    let feat, val;
    if (STD[ch]) {
      if (!base) continue;
      // the whole pad feature: the LVCMOS33 bits with the change applied
      const set = new Set(base);
      const extra = [];
      for (const b of bits) { if (b[0] === '!') { if (set.has(b.slice(1))) set.delete(b.slice(1)); else extra.push(b); } else set.add(b); }
      feat = `${mode}:${STD[ch]}`; val = [...set, ...extra].sort();
    } else { feat = `${mode}:${OTHER[ch]}`; val = bits; }
    (out.padFeatures[pad] ||= {})[feat] = val; n++;
  }
}
console.error(`${n} pad features of ${Object.keys(out.padFeatures).length} pads; ${far} changed bits far from every changed pad`);
console.log(JSON.stringify(out));
