// Analysis of gen-iob.mjs --perpad: what every change of an I/O setting does on every pad, with
// absolute positions (frame, bit). Each variant changes the pads of one index in every third I/O tile
// of each side; a bit that changed belongs to the changed pad whose own bits (its LVCMOS33 pad
// features, measured before) are nearest: a pad's bits are not always in its own tile's frames.
//   node ana-perpad.mjs dir > perpad.json
// Output (for merge-db.mjs): { padFeatures: { PAD: { 'O:LVCMOS18': [...], 'O:DRIVE:8': [...], … } },
// padDriveDefault }: the I/O standards as whole pad features (the LVCMOS33 pad feature with the
// change applied), DRIVE / SLEW / PULL as changes to apply ("f,b" set, "!f,b" cleared).
import fs from 'node:fs';
import { readBit, diffFrames } from '../../core/fpga/bitstream.js';
import { loadDb } from './db.mjs';

const dir = process.argv[2];
const db = loadDb();
const key = JSON.parse(fs.readFileSync(`${dir}/key.json`, 'utf8'));
const padOf = Object.fromEntries(key.pads.map(p => [p.site, p]));
// a pad's anchor: the positions of its own LVCMOS33 bits (output and input)
const window = site => {
  const pos = ['O:LVCMOS33', 'I:LVCMOS33'].flatMap(f => db.padFeats[site]?.[f] || []).map(s => s.replace('!', '').split(',').map(Number));
  return pos.length ? pos : null;
};
const dist = (x, w) => Math.min(...w.map(([f, b]) => Math.abs(x.frame - f) * 64 + Math.abs(x.bit - b)));
// the name of a change as a feature: standards whole, the others as changes
const STD = { STD25: 'LVCMOS25', STD18: 'LVCMOS18', STD15: 'LVCMOS15', STD12: 'LVCMOS12', LVTTL: 'LVTTL' };
const OTHER = { D2: 'DRIVE:2', D4: 'DRIVE:4', D6: 'DRIVE:6', D8: 'DRIVE:8', D16: 'DRIVE:16', FAST: 'SLEW:FAST', PU: 'PULL:PULLUP', PD: 'PULL:PULLDOWN', KEEP: 'PULL:KEEPER' };
const bases = {};
const deltas = {};   // pad -> mode -> change -> [bits]
let far = 0, skipped = 0;
for (const v of key.variants) {
  const f = `${dir}/${v.name}.bit`;
  if (!fs.existsSync(f)) { console.error('missing', f); continue; }
  // an illegal setting (a drive the standard does not have, in the bank's VCCO: xdl's DRC reports it)
  // is not a measurement: bitgen still writes a bitstream, with other bits
  const illegal = n => fs.existsSync(`${dir}/${n}.xlog`) && /illegal condition/.test(fs.readFileSync(`${dir}/${n}.xlog`, 'utf8'));
  if (illegal(v.name) || illegal(v.base)) { skipped++; continue; }
  bases[v.base] ||= readBit(fs.readFileSync(`${dir}/${v.base}.bit`)).frames;
  const d = diffFrames(bases[v.base], readBit(fs.readFileSync(f)).frames);
  const wins = v.pads.map(site => ({ site, w: window(site), bits: [] })).filter(x => x.w);
  for (const x of d) {
    let best = null, bd = Infinity;
    for (const c of wins) { const k = dist(x, c.w); if (k < bd) { bd = k; best = c; } }
    if (bd > 64 * 12) { far++; if (process.env.DEBUG) console.error(v.name, x.frame, x.bit, bd, best && best.site); continue; }
    best.bits.push(`${x.value ? '' : '!'}${x.frame},${x.bit}`);
  }
  // (gen-iob.mjs --perstd: the changes of the outputs of another standard than LVCMOS33)
  const mode = v.std ? `O:${v.std}` : v.base[0];
  for (const c of wins) ((deltas[c.site] ||= {})[mode] ||= {})[v.change] = c.bits.sort();
}
const out = { padFeatures: {}, padDriveDefault: { LVCMOS15: '8', LVCMOS12: '6' } };
let n = 0;
for (const [pad, modes] of Object.entries(deltas)) for (const [mode, chs] of Object.entries(modes)) {
  const base = db.padFeats[pad]?.[`${mode[0]}:LVCMOS33`];
  for (const [ch, bits] of Object.entries(chs)) {
    let feat, val;
    if (STD[ch] && mode.length === 1) {
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
console.error(`${n} pad features of ${Object.keys(out.padFeatures).length} pads; ${far} changed bits far from every changed pad; ${skipped} variants with illegal settings left out`);
console.log(JSON.stringify(out));
