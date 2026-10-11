// Analysis of gen-bram.mjs: where every memory bit of every block RAM is in the frame data.
//   node ana-bram.mjs dir > bram.json
// Output: { frames: [first content frame of each block-RAM column], rows: { Y: first bit }, bit: [[df,
// db] for memory bit i, relative to its block RAM's origin], inverted } when every block RAM has the
// same layout relative to its origin (reported otherwise).
import fs from 'node:fs';
import { readBit, diffFrames, getBit } from '../../core/fpga/bitstream.js';

const dir = process.argv[2];
const key = JSON.parse(fs.readFileSync(`${dir}/key.json`, 'utf8'));
const rd = n => readBit(fs.readFileSync(`${dir}/${n}.bit`)).frames;
const base = rd('BASE');
const code = new Map();   // "frame:bit" -> code
for (let k = 0; k < key.K; k++) for (const x of diffFrames(base, rd(`V${String(k).padStart(2, '0')}`))) code.set(`${x.frame}:${x.bit}`, (code.get(`${x.frame}:${x.bit}`) || 0) | (1 << k));
const ones = diffFrames(base, rd('ONES'));
const byIndex = new Map();
let bad = 0;
for (const x of ones) {
  const c = code.get(`${x.frame}:${x.bit}`) || 0;
  if (c < 1 || c > key.N) { bad++; continue; }
  (byIndex.get(c - 1) || byIndex.set(c - 1, []).get(c - 1)).push([x.frame, x.bit]);
}
const inverted = ones.length ? getBit(base, 73, ones[0].frame, ones[0].bit) === 1 : null;
// the block RAMs: the bits of memory index 0 (one per block RAM), sorted by frame then bit
const origins = (byIndex.get(0) || []).slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
console.error(`${ones.length} bits changed (${bad} without a code), ${byIndex.size} memory bits found, ${origins.length} block RAMs; stored ${inverted ? 'inverted' : 'as is'}`);
// the layout of each memory bit relative to its block RAM: the nearest origin before it
const rel = [], conflicts = [];
for (let i = 0; i < key.N; i++) {
  const ps = byIndex.get(i) || [];
  if (ps.length !== origins.length) { conflicts.push([i, ps.length]); continue; }
  const sorted = ps.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const deltas = sorted.map((p, j) => `${p[0] - origins[j][0]},${p[1] - origins[j][1]}`);
  if (new Set(deltas).size !== 1) { conflicts.push([i, deltas.join(' ')]); continue; }
  rel[i] = deltas[0].split(',').map(Number);
}
console.error(`${rel.filter(Boolean).length} memory bits with one layout for all block RAMs; ${conflicts.length} not: ${conflicts.slice(0, 5).map(c => c.join(':')).join(' | ')}`);
// the database file: the first content frame of each block-RAM column (X), the bit of memory bit 0 of
// each row (Y: the rows count up from the bottom, the bits of the frame from the top), and the place of
// every memory bit relative to them
const cols = [...new Set(origins.map(o => o[0]))].sort((a, b) => a - b);
const rows = [...new Set(origins.map(o => o[1]))].sort((a, b) => b - a);
console.log(JSON.stringify({
  device: 'xc3s250e-4-cp132',
  source: 'research/s3e-bitstream gen-bram.mjs + ana-bram.mjs (every memory bit of all 12 block RAMs located by binary codes in its INIT_xx / INITP_xx); ISE 14.7 xdl P.20131013 + bitgen; 2026-10-11',
  note: 'Memory bit i: bit i % 256 of INIT_<i / 256> (i < 16384) or of INITP_<(i - 16384) / 256>; it is at frame colFrame[X] + df[i], bit rowBit[Y] + db[i] of RAMB16_X<X>Y<Y>, stored as is',
  colFrame: Object.fromEntries(cols.map((f, x) => [x, f])),
  rowBit: Object.fromEntries(rows.map((b, y) => [y, b])),
  inverted,
  df: rel.map(r => r[0]), db: rel.map(r => r[1]),
}));
