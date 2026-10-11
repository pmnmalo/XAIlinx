// Block-RAM settings as database features, from gen-sitevar.mjs runs on a design implemented by ISE:
//   sv3 (every setting changed on one instance: inverters, write modes) and sv5 (per port width: the
//   port removed, and binary codes in INIT_A / SRVAL_A / INIT_B / SRVAL_B)
//   node bram-features.mjs sv3.json sv5.json > fix.json      (ana-sitevar.mjs outputs)
// Features of the BRAMSITE2 tiles (bits in the interconnect column before: @-1,0):
//   RAMB16:USED                 every bit of the output latches' initial and reset values (stored
//                               inverted: a value 0 sets them)
//   RAMB16:PORTA_ATTR:<w>…      the port's own bits (not the inverters of its pins)
//   RAMB16:INIT_A@<w>:<i>…      bit i of the value: clears its bit
//   RAMB16:<pin>INV:<pin>, WRITEMODEA:…
import fs from 'node:fs';

const [sv3f, sv5f] = process.argv.slice(2);
const one = (feats, name) => { const p = Object.values(feats)[0][name]; return p && p.length >= 1 ? (p[0][0] ? p[0][0].split(' ') : []) : null; };
const sv3 = JSON.parse(fs.readFileSync(sv3f, 'utf8')).feats, sv5 = JSON.parse(fs.readFileSync(sv5f, 'utf8')).feats;
// sv3: the variants of instance X0Y3 (its base: CLKA, CLKB not inverted, WRITE_FIRST on both ports)
const s3 = name => one(sv3, `${name}_X0Y3`);
const F = {};
for (const p of ['CLKA', 'CLKB', 'ENA', 'ENB', 'WEA', 'WEB', 'SSRA', 'SSRB']) {
  const inv = s3(`INV_${p}_B`), non = s3(`INV_${p}`);
  // the bit of a pin: set for the pin as it is (its _B variant clears it) or for the inverted pin
  const neg = inv.filter(s => s[0] === '!').map(s => s.slice(1)), pos = inv.filter(s => s[0] !== '!');
  F[`RAMB16:${p}INV:${p}`] = neg; F[`RAMB16:${p}INV:${p}_B`] = pos;
  if (non.length) console.error(`${p}: not inverted changes [${non}]`);
}
// the write modes: each value's bits that are set (the instance's base value is the one whose
// variant changes nothing: port A WRITE_FIRST, port B READ_FIRST)
for (const [port, attr] of [['A', 'WRITEMODEA'], ['B', 'WRITEMODEB']]) {
  const ms = ['WRITE_FIRST', 'READ_FIRST', 'NO_CHANGE'];
  const d = Object.fromEntries(ms.map(m => [m, new Map(s3(`W${port}_${m}`).map(x => [x.replace('!', ''), x[0] === '!' ? 0 : 1]))]));
  const touched = new Set(ms.flatMap(m => [...d[m].keys()]));
  const base = new Map([...touched].map(p => [p, 1 - ms.map(m => d[m].get(p)).find(v => v !== undefined)]));
  for (const m of ms) F[`RAMB16:${attr}:${m}`] = [...touched].filter(p => (d[m].has(p) ? d[m].get(p) : base.get(p)) === 1);
}
// sv5
const s5 = name => one(sv5, name);
const W = { 36: '512X36', 18: '1024X18', 9: '2048X9', 4: '4096X4', 2: '8192X2', 1: '16384X1' };
const used = new Set();
const report = [];
for (const [n, w] of Object.entries(W)) {
  // the port: its bits in the base (removing the port clears them), without the inverters (frame 5)
  // and the write mode (the base's port B is READ_FIRST)
  const modeBits = new Set(Object.entries(F).filter(([k]) => /WRITEMODE/.test(k)).flatMap(([, b]) => b));
  for (const port of ['A', 'B']) F[`RAMB16:PORT${port}_ATTR:${w}`] = s5(`RM${port}_${n}`).filter(s => s[0] === '!' && !/^!5,/.test(s)).map(s => s.slice(1)).filter(s => !modeBits.has(s));
  for (const attr of ['INIT_A', 'SRVAL_A', 'INIT_B', 'SRVAL_B']) {
    const ones = s5(`${attr}_${n}_ONES`) || [];
    const code = new Map(ones.map(s => [s.slice(1), 0]));
    for (let k = 0; (1 << k) <= +n; k++) for (const s of s5(`${attr}_${n}_C${k}`) || []) if (code.has(s.slice(1))) code.set(s.slice(1), code.get(s.slice(1)) | (1 << k));
    for (const [pos, c] of code) {
      if (+n === 36) used.add(pos);
      if (c < 1 || c > +n) { report.push(`${attr}@${w}: ${pos} code ${c}`); continue; }
      (F[`RAMB16:${attr}@${w}:${c - 1}`] ||= []).push(`!${pos}`);
    }
  }
}
// and one bit in each of the 2nd and 3rd interconnect tiles of the block RAM, set for every used
// block RAM (the residual of the designs implemented by ISE, explain-diff.mjs: 1,15 and 1,48 of those
// tiles in all 9 block RAMs)
F['RAMB16:USED'] = [...used, '1,15@-1,1', '1,48@-1,2'].sort();
for (const k of ['RAMB16:RAMB16:', 'RAMB16:RAMB16A:', 'RAMB16:RAMB16B:']) F[k] = [];
console.error(report.join('\n') || 'every value bit decoded');
console.error(`${Object.keys(F).length} features`);
console.log(JSON.stringify({ source: 'stage D: block RAMs of a design implemented by ISE (ise-impl.sh), one setting changed on one instance at a time and binary codes in the output latch values per port width (gen-sitevar.mjs, ana-sitevar.mjs --dx -1, bram-features.mjs)', types: { BRAMSITE2: { features: F } } }));
