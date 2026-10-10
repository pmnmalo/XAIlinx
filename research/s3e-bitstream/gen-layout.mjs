// The layout of the XC3S250E's frame data (db/xc3s250e-layout.json): where every tile starts.
// Tiles are named TYPE_X<x>Y<y>; tiles with the same x share a column of frames, tiles with the same
// y a row of bits (special tile types have their own tables in typeCols / typeRows).
//   cols[x]: first frame of column x (the CLB columns from the chip map of stage A: the frame of the
//            LUTs of the column's even slices; others from the routing switches measured in them)
//   rows[y]: first bit of row y (CLB rows: 64 bits; the I/O rows at the top and bottom: 80 bits)
//   defaults: the bits set in the frame data of an empty design
//   node gen-layout.mjs empty.bit [extra.json] > db/xc3s250e-layout.json
import fs from 'node:fs';
import { readBit, diffFrames } from '../../core/fpga/bitstream.js';

const [emptyBit, extra] = process.argv.slice(2);
const lut = JSON.parse(fs.readFileSync(new URL('./db/xc3s250e-lut.json', import.meta.url), 'utf8')).lutF;
const cols = {}, rows = {};
for (let x = 1; x <= 26; x++) cols[x] = lut.colFrame[2 * (x - 1)];
for (let y = 1; y <= 34; y++) rows[y] = lut.rowBit[2 * (y - 1) + 1] - 16;
rows[0] = 2256; rows[35] = 0;
const empty = readBit(fs.readFileSync(emptyBit));
const defaults = diffFrames(new Uint32Array(empty.frames.length), empty.frames).map(d => [d.frame, d.bit]);
const more = extra ? JSON.parse(fs.readFileSync(extra, 'utf8')) : {};
const out = {
  device: 'xc3s250e-4-cp132',
  source: 'research/s3e-bitstream: gen-layout.mjs from the chip map (gen-map.mjs, decode-map.mjs) and the routing switches measured with gen-pipdrop.mjs / ana-pipdrop.mjs; ISE 14.7 xdl P.20131013 + bitgen; 2026-10-10',
  note: 'Tile TYPE_X<x>Y<y> starts at frame cols[x] (typeCols[TYPE][x] for special types) and bit rows[y]. CLB tiles (CLB_X<x>Y<y>) are of type CENTER_SMALL, CENTER_SMALL_BRK in rows brkRows. defaults: [frame, bit] set in the frame data of an empty design.',
  frameWords: 73, frames: 578,
  brkRows: [9, 25],
  cols, rows, typeCols: {}, typeRows: {},
  defaults,
  ...more,
};
console.log(JSON.stringify(out, null, 1).replace(/\[\n\s+(-?\d+),\n\s+(-?\d+)\n\s+\]/g, '[$1, $2]'));
